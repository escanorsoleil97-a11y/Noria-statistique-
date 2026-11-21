// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — adminAction.js
// Actions d'administration sécurisées (côté serveur uniquement)
// UID admin autorisé hardcodé + vérification role Firestore (double verrou)
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const crypto = require('crypto');
const _sec = require('./_security');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ── Grille de prix (miroir exact de PLAN_CONFIG dans confirmPayment.js) ──────
const UPGRADE_PLAN_CONFIG = {
  standard:      { credits: 100,  prixFCFA: 10000 },
  avance:        { credits: 250,  prixFCFA: 18000 },
  professionnel: { credits: 500,  prixFCFA: 25000 },
  premium:       { credits: 2000, prixFCFA: 35000 },
};

// ── UID admin autorisé (double sécurité avec role Firestore) ─────────────────
// UIDs admins autorisés
const ADMIN_UIDS = new Set(((process.env.ADMIN_UIDS||'SBATLA0GmVbeYWWpWrPoRTTveb32,0f9FMESHK6gq5Gl77tquCETbFow1')).split(',').map(s=>s.trim()).filter(Boolean));

// ── Plans valides ────────────────────────────────────────────────────────────
const VALID_PLANS = ['gratuit', 'standard', 'avance', 'professionnel', 'premium', 'institution', 'ecole', 'hopital_district', 'centre_sante', 'pharmacie'];

// ── Crédits par défaut par plan ──────────────────────────────────────────────
const PLAN_CREDITS = {
  gratuit:       10,
  standard:      200,
  avance:        250,
  professionnel: 500,
  premium:       2000,
  institution:   2000,
  centre_sante:  500,
  ecole:          500,
  hopital_district: 2000,
  pharmacie:      500,
};


// ══ Suppression DÉFINITIVE : helpers (idempotents, relançables en cas d'échec) ══
const QID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Supprime tous les documents d'une collection dont `field == value`, par lots.
async function deleteWhere(colName, field, value) {
  let total = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const snap = await db.collection(colName).where(field, '==', value).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 400) break;
  }
  return total;
}

// Supprime un questionnaire et TOUT ce qui s'y rattache (réponses, tentatives,
// compteurs anti-abus, token admin). Aucune copie ne subsiste.
async function purgeQuestionnaire(qid) {
  // Fermer d'abord : plus aucune nouvelle réponse pendant la suppression
  try { await db.collection('questionnaires').doc(qid).update({ 'settings.isVisible': false }); } catch (_e) {}
  const out = { responses: 0, attempts: 0 };
  out.responses += await deleteWhere('responses', 'questionnaire_id', qid);
  out.attempts  += await deleteWhere('attempts', 'qid', qid);
  // Compteurs de tentatives : ids de la forme `${qid}_${ipHash}`
  for (let guard = 0; guard < 500; guard++) {
    const snap = await db.collection('questionnaire_attempt_counters')
      .where(admin.firestore.FieldPath.documentId(), '>=', qid + '_')
      .where(admin.firestore.FieldPath.documentId(), '<', qid + '_\uf8ff').limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 400) break;
  }
  await db.collection('questionnaires').doc(qid).delete();
  await db.collection('questionnaire_admin').doc(qid).delete();
  // Balayage final (une réponse en cours d'envoi pendant la suppression)
  out.responses += await deleteWhere('responses', 'questionnaire_id', qid);
  return out;
}

// Supprime toutes les données personnelles d'un utilisateur (hors pièces
// comptables : transactions de paiement et commissions ambassadeur, conservées
// pour la comptabilité).
async function purgeUserData(uid) {
  const out = { questionnaires: 0, responses: 0 };
  // 1) Ses questionnaires (+ réponses, tentatives, tokens)
  for (let guard = 0; guard < 500; guard++) {
    const qs = await db.collection('questionnaires').where('owner_uid', '==', uid).limit(50).get();
    if (qs.empty) break;
    for (const q of qs.docs) {
      const r = await purgeQuestionnaire(q.id);
      out.questionnaires++; out.responses += r.responses;
    }
  }
  const tokens = await db.collection('questionnaire_admin').where('owner_uid', '==', uid).limit(500).get();
  for (const t of tokens.docs) { const r = await purgeQuestionnaire(t.id); out.questionnaires++; out.responses += r.responses; }
  out.responses += await deleteWhere('responses', 'owner_uid', uid);
  await deleteWhere('attempts', 'ownerUid', uid);

  // 2) Fichiers Cloudinary des demandes d'aide (best-effort) puis les demandes
  try {
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      const cloudinary = require('cloudinary').v2;
      cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
      const help = await db.collection('studentHelpRequests').where('uid', '==', uid).limit(200).get();
      for (const h of help.docs) {
        const d = h.data();
        if (d.publicId) { try { await cloudinary.uploader.destroy(String(d.publicId), { resource_type: d.resourceType || 'image', invalidate: true }); } catch (_e) {} }
      }
    }
  } catch (_e) {}

  // 3) Collections rattachées à l'utilisateur par un champ uid
  for (const col of ['savedDatabases', 'history', 'etudiantResultats', 'doc_analysis_logs', 'mediaTransactions',
                     'aiCharges', 'studentHelpRequests', 'rewardRequests', 'chimiGrants', 'alerts']) {
    await deleteWhere(col, 'uid', uid);
  }
  await deleteWhere('rewardRequests', 'userId', uid);

  // 4) Espaces Gestion commerciale / Pharmacie / comptes institution (récursif, sous-collections incluses)
  await db.recursiveDelete(db.collection('commercial').doc(uid));
  await db.recursiveDelete(db.collection('pharmacy').doc(uid));
  for (const [col] of [['institution_members'], ['institution_requests'], ['sessions']]) {
    try { await db.collection(col).doc(uid).delete(); } catch (_e) {}
  }
  return out;
}

exports.handler = async (event) => {
const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL,
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app','https://noria-education.pages.dev','https://noria-statistique.pages.dev','https://noria-statistique.netlify.app']
    .filter(Boolean).join(',').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const _originNorm = _origin.replace(/\/$/, '');
  const _allow = (_originNorm && _allowed.includes(_originNorm)) ? _originNorm : (_allowed[0] || 'https://pstat-pro-all.netlify.app');
  // Même origine (pas de header Origin) ou origine autorisée
  if (_originNorm && !_allowed.includes(_originNorm)) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _allow }, body: JSON.stringify({ error: 'Origine non autorisée. Ajoutez votre domaine dans SITE_ORIGIN (Netlify env).' }) };
  }


  const headers = {
    'Access-Control-Allow-Origin': _allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    // ── 1. Vérifier token Firebase ───────────────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1], true); }
    catch (_e) { return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session invalide ou révoquée' }) }; }
    const callerUid = decoded.uid;

    // ── 2. Vérifier que c'est l'admin (double verrou : UID + role Firestore) ─
    if (!ADMIN_UIDS.has(callerUid)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès refusé' }) };
    }
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerRole = callerSnap.data()?.role || '';
    if (!callerSnap.exists || (callerRole !== 'admin' && callerRole !== 'adnim')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Rôle admin requis' }) };
    }

    // Anti-abus : plafond d'actions admin par minute (échec ouvert si Firestore indisponible)
    if (!(await _sec.rateLimitDurable('adm:' + callerUid, { limit: 120, windowMs: 60000 }))) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de requêtes, réessayez dans une minute.' }) };
    }

    // ── 3. Parser l'action (taille plafonnée, pollution de prototype rejetée) ─
    const { action, targetUid, payload } = _sec.body(event, 200000);
    if (!action || typeof action !== 'string') return { statusCode: 400, headers, body: JSON.stringify({ error: 'action requise' }) };
    if (targetUid != null && (typeof targetUid !== 'string' || !UID_RE.test(targetUid))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid invalide' }) };
    }

    // ── 4. Exécuter l'action ─────────────────────────────────────────────────
    switch (action) {

      // Lister tous les utilisateurs (50 max par appel)
      case 'listUsers': {
        const snap = await db.collection('users').limit(200).get();
        const users = snap.docs.map(d => ({
          uid:        d.id,
          email:      d.data().email || '',
          plan:       d.data().plan || 'gratuit',
          credits:    d.data().credits ?? 0,
          createdAt:  d.data().createdAt || '',
          planExpiry: d.data().planExpiry || '',
          suspended:  d.data().suspended || false,
          kickCount:  d.data().kickCount || 0,
          role:       d.data().role || '',
          referralCount: d.data().referralCount || 0,
          profil: d.data().profil || '',
          accessProfile: d.data().accessProfile || '',
          accessCampaignId: d.data().accessCampaignId || '',
          institutionNom: d.data().institutionNom || '',
          institutionNbComptes: d.data().institutionNbComptes ?? '',
          institutionPrixTotal: d.data().institutionPrixTotal ?? '',
          institutionCreditsAn: d.data().institutionCreditsAn ?? '',
          spaces: d.data().spaces || {},
        }));
        // Tri : plus récents en premier
        users.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, users }) };
      }

      // Modifier les informations de profil affichées dans l’application.
      // L’e-mail d’authentification, l’UID et le rôle restent non modifiables ici.
      case 'updateUserInfo': {
        if (!targetUid || !payload || typeof payload !== 'object') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et informations requises' }) };
        }
        if (ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Les informations du compte admin sont protégées' }) };
        }
        const allowed = ['displayName', 'phone', 'matricule', 'accessProfile', 'accessCampaignId', 'planExpiry'];
        const updates = {};
        for (const key of allowed) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) {
            const value = payload[key] == null ? '' : String(payload[key]).trim();
            if (value.length > 200) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Champ trop long : ' + key }) };
            updates[key] = value;
          }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'planExpiry') && updates.planExpiry) {
          const d = new Date(updates.planExpiry);
          if (Number.isNaN(d.getTime())) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Date d’expiration invalide' }) };
          updates.planExpiry = d.toISOString();
        }
        if (!Object.keys(updates).length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucune information modifiable fournie' }) };
        updates.updatedAt = new Date().toISOString();
        updates.updatedBy = 'admin';
        await db.collection('users').doc(targetUid).update(updates);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Informations utilisateur mises à jour', updates }) };
      }

      // Changer le plan d'un utilisateur
      case 'setPlan': {
        if (!targetUid || !payload?.plan) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et plan requis' }) };
        }
        if (!VALID_PLANS.includes(payload.plan)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan invalide' }) };
        }
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);
        const updates = {
          plan:       payload.plan,
          planExpiry: payload.plan === 'gratuit' ? null : expiry.toISOString(),
          updatedAt:  new Date().toISOString(),
          updatedBy:  'admin',
        };
        // Lorsqu'un admin transforme un compte en établissement, appliquer
        // aussi le stock initial du profil afin que le changement de plan soit
        // cohérent immédiatement (et non uniquement visuel).
        if (Object.prototype.hasOwnProperty.call(PLAN_CREDITS, payload.plan)) {
          updates.credits = PLAN_CREDITS[payload.plan];
        }
        await db.collection('users').doc(targetUid).update(updates);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `Plan mis à jour : ${payload.plan}` }) };
      }

      // Activer / bloquer les modes complémentaires d'un compte
      case 'setSpaces': {
        const KEYS = ['business', 'sante', 'institution'];
        if (!targetUid || !payload || typeof payload.spaces !== 'object' || payload.spaces === null) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et spaces requis' }) };
        }
        const spaces = {};
        for (const k of KEYS) spaces[k] = payload.spaces[k] === true;
        await db.collection('users').doc(targetUid).update({
          spaces,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, spaces, msg: 'Modes mis à jour' }) };
      }

      // Ajouter des crédits
      case 'addCredits': {
        if (!targetUid || typeof payload?.amount !== 'number') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et amount requis' }) };
        }
        if (!Number.isInteger(payload.amount) || payload.amount < 0 || payload.amount > 10000) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Montant invalide (0–10 000)' }) };
        }
        await db.collection('users').doc(targetUid).update({
          credits:   admin.firestore.FieldValue.increment(payload.amount),
          updatedAt: new Date().toISOString(),
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `+${payload.amount} crédits ajoutés` }) };
      }

      // Suspendre / réactiver un compte
      case 'setSuspend': {
        if (!targetUid || typeof payload?.suspended !== 'boolean') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et suspended requis' }) };
        }
        if (ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de suspendre le compte admin' }) };
        }
        await db.collection('users').doc(targetUid).update({
          suspended:  payload.suspended,
          kickCount:  0,
          updatedAt:  new Date().toISOString(),
          updatedBy:  'admin',
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: payload.suspended ? 'Compte suspendu' : 'Compte réactivé' }) };
      }

      // Réinitialiser le compteur de kicks
      case 'resetKicks': {
        if (!targetUid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        await db.collection('users').doc(targetUid).update({ kickCount: 0, suspended: false, updatedAt: new Date().toISOString() });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Compteur réinitialisé' }) };
      }

      // Supprimer DÉFINITIVEMENT un utilisateur : toutes ses données, puis son compte de connexion
      case 'deleteUser': {
        if (!targetUid || typeof targetUid !== 'string' || targetUid.length > 128) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        }
        if (!payload || payload.confirm !== 'SUPPRIMER') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Confirmation manquante (tapez SUPPRIMER)' }) };
        }
        if (targetUid === callerUid || ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de supprimer un compte admin' }) };
        }
        const tRef = db.collection('users').doc(targetUid);
        const tSnap = await tRef.get();
        const tData = tSnap.exists ? tSnap.data() : {};
        const tRole = String((tData && tData.role) || '').trim().toLowerCase();
        if (['admin', 'adnim', 'superadmin', 'super_admin'].includes(tRole)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de supprimer un compte à rôle administrateur' }) };
        }
        // 1) Couper les sessions immédiatement (le jeton ne sera plus accepté : checkRevoked)
        try { await admin.auth().revokeRefreshTokens(targetUid); } catch (_e) {}
        // 2) Supprimer TOUTES les données de la personne (idempotent : en cas d'échec on peut relancer)
        let purged;
        try { purged = await purgeUserData(targetUid); }
        catch (e) {
          console.error('deleteUser purge:', e && e.message);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Suppression des données incomplète, réessayez (le compte n\'a pas été supprimé).' }) };
        }
        // 3) Supprimer le compte de connexion (sinon la personne se reconnecterait)
        try {
          await admin.auth().deleteUser(targetUid);
        } catch (e) {
          if (!e || e.code !== 'auth/user-not-found') {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Suppression du compte de connexion impossible : ' + (e && e.code || 'erreur') }) };
          }
        }
        // 4) Supprimer la fiche (en dernier : elle permet de relancer si une étape a échoué)
        await tRef.delete();
        // 5) Trace d'audit minimale (collection inaccessible aux clients : règle par défaut = refus)
        try {
          await db.collection('adminAudit').add({
            action: 'deleteUser', by: callerUid, target: targetUid,
            targetEmail: tData.email || null, purged, at: new Date().toISOString(),
          });
        } catch (_e) {}
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Compte et données supprimés définitivement' }) };
      }

      // ── Questionnaires : liste complète (tous propriétaires) ──────────────
      case 'listQuestionnaires': {
        const snap = await db.collection('questionnaires').limit(500).get();
        const owners = {};
        const items = await Promise.all(snap.docs.map(async (d) => {
          const q = d.data();
          let n = null;
          try {
            const rq = db.collection('responses').where('questionnaire_id', '==', d.id);
            if (typeof rq.count === 'function') { n = (await rq.count().get()).data().count; }
            else { n = (await rq.select().limit(5000).get()).size; }
          } catch (_e) { n = null; }
          if (q.owner_uid && !(q.owner_uid in owners)) {
            try { owners[q.owner_uid] = (await db.collection('users').doc(q.owner_uid).get()).data()?.email || ''; }
            catch (_e) { owners[q.owner_uid] = ''; }
          }
          let nVars = 0;
          try { const a = JSON.parse(q.variables || '[]'); nVars = Array.isArray(a) ? a.length : 0; } catch (_e) {}
          return {
            qid: d.id, title: String(q.title || 'Questionnaire').slice(0, 200),
            ownerUid: q.owner_uid || '', ownerEmail: owners[q.owner_uid] || '',
            createdAt: q.created_at || '', nVars, responses: n,
            visible: !(q.settings && q.settings.isVisible === false),
          };
        }));
        items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, items }) };
      }

      // ── Questionnaires : ouvrir / fermer les réponses ─────────────────────
      case 'setQuestionnaireVisible': {
        if (!payload || typeof payload.qid !== 'string' || !QID_RE.test(payload.qid) || typeof payload.visible !== 'boolean') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'qid et visible requis' }) };
        }
        const qRef = db.collection('questionnaires').doc(payload.qid);
        if (!(await qRef.get()).exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Questionnaire introuvable' }) };
        await qRef.update({ 'settings.isVisible': payload.visible, updatedAt: new Date().toISOString() });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: payload.visible ? 'Réponses ouvertes' : 'Réponses fermées' }) };
      }

      // ── Questionnaires : suppression DÉFINITIVE (questionnaire + réponses + tentatives + token) ──
      case 'deleteQuestionnaire': {
        if (!payload || typeof payload.qid !== 'string' || !QID_RE.test(payload.qid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'qid invalide' }) };
        }
        if (payload.confirm !== 'SUPPRIMER') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Confirmation manquante (tapez SUPPRIMER)' }) };
        }
        const qSnap = await db.collection('questionnaires').doc(payload.qid).get();
        const qd = qSnap.exists ? qSnap.data() : {};
        const res = await purgeQuestionnaire(payload.qid);
        try {
          await db.collection('adminAudit').add({
            action: 'deleteQuestionnaire', by: callerUid, target: payload.qid,
            title: String(qd.title || '').slice(0, 200), ownerUid: qd.owner_uid || null,
            deletedResponses: res.responses, at: new Date().toISOString(),
          });
        } catch (_e) {}
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Questionnaire supprimé définitivement (' + res.responses + ' réponse(s) effacée(s))', deletedResponses: res.responses }) };
      }

      // Stats globales
      case 'getStats': {
        const snap = await db.collection('users').get();
        const stats = { total: 0, byPlan: {}, suspended: 0, creditsTotal: 0, newThisMonth: 0 };
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
        snap.docs.forEach(d => {
          const data = d.data();
          stats.total++;
          const plan = data.plan || 'gratuit';
          stats.byPlan[plan] = (stats.byPlan[plan] || 0) + 1;
          if (data.suspended) stats.suspended++;
          stats.creditsTotal += data.credits ?? 0;
          if (data.createdAt && new Date(data.createdAt) >= monthStart) stats.newThisMonth++;
        });
        // Revenus estimés (prix en FCFA)
        const PRIX = { standard: 10000, professionnel: 25000, premium: 35000 };
        stats.revenusEstimes = Object.entries(PRIX).reduce((sum, [plan, prix]) => {
          return sum + (stats.byPlan[plan] || 0) * prix;
        }, 0);

        // ── PAIEMENTS (à activer quand l'API sera disponible) ────────────────
        // Décommenter quand NOTCHPAY_PUBLIC_KEY ou MONETBIL_SERVICE_KEY
        // sera configuré sur Netlify :
        //
        // const txSnap = await db.collection('transactions').orderBy('processedAt','desc').limit(50).get();
        // stats.transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        //
        // Pour l'instant on retourne un tableau vide avec un message clair :
        stats.transactions = [];
        stats.paymentNote = 'Paiements disponibles après configuration API (NotchPay ou Monetbil)';

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, stats }) };
      }

      // ── Créer un membre Institution ──────────────────────────────────────
      // Reçoit : targetUid, payload.nbIndividus, payload.institutionName
      // Calcule : prix, crédits → met à jour le compte + journalise
      case 'createInstitutionMember': {
        if (!targetUid || !payload?.nbIndividus) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et nbIndividus requis' }) };
        }
        const nb = parseInt(payload.nbIndividus, 10);
        if (!nb || nb < 5) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Minimum 5 individus pour le plan Institution' }) };
        }
        // Calcul prix dégressif (identique à confirmPayment.js)
        const INST_PRICING = [
          { minComptes: 50, prixParCompte: 10000 },
          { minComptes: 20, prixParCompte: 14000 },
          { minComptes: 5,  prixParCompte: 18000 },
        ];
        const tier = INST_PRICING.find(t => nb >= t.minComptes);
        if (!tier) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun palier tarifaire trouvé' }) };
        }
        const prixParCompte = tier.prixParCompte;
        const prixTotal = prixParCompte * nb;
        const creditsTotal = nb * 2000;
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);

        await db.collection('users').doc(targetUid).update({
          plan:                    'institution',
          planExpiry:              expiry.toISOString(),
          credits:                 admin.firestore.FieldValue.increment(creditsTotal),
          institutionNbComptes:    nb,
          institutionNom:          payload.institutionName || '',
          institutionPrixTotal:    prixTotal,
          institutionPrixParCompte: prixParCompte,
          updatedAt:               new Date().toISOString(),
          updatedBy:               'admin',
        });

        // Journaliser dans la collection institutions
        await db.collection('institutions').doc(targetUid).set({
          uid:             targetUid,
          nom:             payload.institutionName || '',
          nbComptes:       nb,
          creditsAlloues:  creditsTotal,
          prixTotal:       prixTotal,
          prixParCompte:   prixParCompte,
          activatedAt:     new Date().toISOString(),
          activatedBy:     callerUid,
          planExpiry:      expiry.toISOString(),
        }, { merge: true });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            msg: `Institution activée : ${nb} comptes, ${creditsTotal} crédits, ${prixTotal.toLocaleString('fr-FR')} FCFA`,
            details: { nb, creditsTotal, prixTotal, prixParCompte },
          }),
        };
      }

      // ── Lister les institutions ──────────────────────────────────────────
      case 'listInstitutions': {
        const snap = await db.collection('institutions').get();
        const institutions = [];
        for (const d of snap.docs) {
          const data = d.data();
          // Récupérer l'email depuis users
          let email = '';
          try {
            const uSnap = await db.collection('users').doc(d.id).get();
            email = uSnap.data()?.email || '';
          } catch(_) {}
          institutions.push({ uid: d.id, email, ...data });
        }
        institutions.sort((a, b) => (b.activatedAt > a.activatedAt ? 1 : -1));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, institutions }) };
      }

      // ── Lister les alertes anti-partage (usage_burst / device_multi) ──────
      case 'listAlerts': {
        const snap = await db.collection('alerts').limit(200).get();
        const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        alerts.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alerts }) };
      }

      // ── Marquer une alerte comme traitée (suppression du doc) ─────────────
      case 'resolveAlert': {
        if (!payload?.alertId) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'alertId requis' }) };
        }
        await db.collection('alerts').doc(payload.alertId).delete();
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Alerte traitée' }) };
      }

      // ── Générer un lien donnant N chimis expirants (usage unique par défaut) ─
      case 'generateChimiLink': {
        const nbChimis = parseInt(payload?.nbChimis, 10);
        const dureeChimisJours = parseInt(payload?.dureeChimisJours, 10);
        const dureeLienHeures = parseInt(payload?.dureeLienHeures, 10) || 48;
        const maxClaims = Math.min(100000, Math.max(1, parseInt(payload?.maxClaims, 10) || 1));
        const dailyMaxClaims = Math.min(maxClaims, Math.max(0, parseInt(payload?.dailyMaxClaims, 10) || 0));
        if (!nbChimis || nbChimis <= 0) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'nbChimis requis (> 0)' }) };
        }
        if (!dureeChimisJours || dureeChimisJours < 1 || dureeChimisJours > 7) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'dureeChimisJours requis (1 à 7)' }) };
        }
        const token = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + dureeLienHeures * 60 * 60 * 1000).toISOString();
        await db.collection('chimiLinks').doc(token).set({
          nbChimis,
          dureeChimisJours,
          maxClaims,
          dailyMaxClaims,
          claims: [],
          claimsByDay: {},
          createdAt: new Date().toISOString(),
          expiresAt,
          createdBy: callerUid,
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token, expiresAt, maxClaims, dailyMaxClaims }) };
      }

      // ── Générer un lien d'upgrade à usage unique (48h) pour un utilisateur ──
      case 'generateUpgradeLink': {
        if (!targetUid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.collection('upgradeLinks').doc(token).set({
          uid: targetUid,
          createdAt: new Date().toISOString(),
          expiresAt,
          used: false,
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token, expiresAt }) };
      }

      // ── Appliquer un upgrade de palier (après paiement confirmé manuellement) ─
      // Règle : date d'expiration INCHANGÉE, stock du nouveau palier accordé
      // en PLEIN (pas d'incrément), prix plein différentiel (pas de prorata).
      case 'applyUpgrade': {
        if (!targetUid || !payload?.targetPlan) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et targetPlan requis' }) };
        }
        if (!UPGRADE_PLAN_CONFIG[payload.targetPlan]) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Palier cible invalide' }) };
        }
        const userRef = db.collection('users').doc(targetUid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Utilisateur introuvable' }) };
        const userData = userSnap.data();
        const ancienPlan = userData.plan || 'gratuit';
        const nouveauConfig = UPGRADE_PLAN_CONFIG[payload.targetPlan];
        const ancienPrix = UPGRADE_PLAN_CONFIG[ancienPlan]?.prixFCFA || 0;
        const montant = Math.max(0, nouveauConfig.prixFCFA - ancienPrix);

        await userRef.update({
          plan: payload.targetPlan,
          credits: nouveauConfig.credits, // stock plein, pas d'incrément — planExpiry non touché
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin_upgrade',
        });

        await db.collection('upgrades').add({
          uid: targetUid,
          email: userData.email || '',
          ancienPlan,
          nouveauPlan: payload.targetPlan,
          montant,
          appliedAt: new Date().toISOString(),
        });

        if (payload.token) {
          try { await db.collection('upgradeLinks').doc(payload.token).update({ used: true, usedAt: new Date().toISOString() }); } catch (_) {}
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `Upgrade appliqué : ${ancienPlan} → ${payload.targetPlan} (${montant} FCFA, expiration inchangée)` }) };
      }

      // ═══════════════ MODULE AMBASSADEURS ═══════════════

      // Lister les demandes/ambassadeurs (pending + actifs + suspendus)
      case 'ambassadorList': {
        const snap = await db.collection('ambassadors').orderBy('createdAt', 'desc').limit(300).get();
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ambassadors: list }) };
      }

      // Valider une demande pending → génère le code, passe en active/eclaireur
      case 'ambassadorApprove': {
        const ambRef = db.collection('ambassadors').doc(targetUid);
        const ambSnap = await ambRef.get();
        if (!ambSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Demande introuvable' }) };
        const ambData = ambSnap.data();
        if (ambData.status === 'active') {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code: ambData.code, msg: 'Déjà actif.' }) };
        }
        const userSnap = await db.collection('users').doc(targetUid).get();
        const userData = userSnap.data() || {}; const rawPrenom = userData.prenom || userData.firstName || userData.displayName || (userData.email || 'AMB').split('@')[0]; const prenom = String(rawPrenom).replace(/[^a-zA-ZÀ-ÿ]/g, '').toUpperCase().substring(0, 6) || 'AMB';
        const suffix = Math.floor(10 + Math.random() * 90);
        const code = `AMB-${prenom}${suffix}`;
        await ambRef.set({
          code, status: 'active', level: 'eclaireur',
          activatedAt: new Date().toISOString(),
        }, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code }) };
      }

      // Suspendre / réactiver un ambassadeur (motif obligatoire à la suspension)
      case 'ambassadorSuspend': {
        const newStatus = payload?.status === 'active' ? 'active' : 'suspended';
        if (newStatus === 'suspended' && !payload?.reason) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Motif de suspension requis' }) };
        }
        const update = { status: newStatus };
        if (newStatus === 'suspended') {
          update.suspended_at = new Date().toISOString();
          update.suspend_reason = payload.reason;
        }
        await db.collection('ambassadors').doc(targetUid).set(update, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // Confirmer un paiement reçu manuellement (Mobile Money hors ligne) :
      // remplace le webhook auto absent — c'est le geste manuel de l'admin qui
      // déclenche l'event "paid" + crée la ligne de commission due.
      // targetUid = uid de l'ÉTUDIANT qui vient de payer.
      case 'ambassadorConfirmPayment': {
        const { plan, amountPaid } = payload || {};
        if (!plan || !amountPaid) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'plan et amountPaid requis' }) };
        }
        const studentSnap = await db.collection('users').doc(targetUid).get();
        if (!studentSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Étudiant introuvable' }) };
        const studentData = studentSnap.data();
        const refCode = studentData.ambassadorRef;

        if (!refCode) {
          // Règle d'or F4 : pas de code au moment du paiement = pas de commission.
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Aucun code ambassadeur associé — pas de commission.' }) };
        }

        // Anti-auto-parrainage : le code appartient-il à l'étudiant lui-même ?
        const ambQuery = await db.collection('ambassadors').where('code', '==', refCode).limit(1).get();
        if (ambQuery.empty) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Code ambassadeur introuvable.' }) };
        }
        const ambDoc = ambQuery.docs[0];
        const ambassadorUid = ambDoc.id;
        const ambData = ambDoc.data();

        const ambassadorUserSnap = await db.collection('users').doc(ambassadorUid).get(); const ambassadorUser = ambassadorUserSnap.exists ? (ambassadorUserSnap.data() || {}) : {}; const normEmail = v => String(v || '').trim().toLowerCase(); const normPhone = v => String(v || '').replace(/[^0-9]/g, ''); const sameIdentity = ambassadorUid === targetUid || (normEmail(ambassadorUser.email) && normEmail(ambassadorUser.email) === normEmail(studentData.email)) || (normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) && normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) === normPhone(studentData.phone || studentData.telephone || studentData.tel));
        if (sameIdentity) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: '⚠️ Auto-parrainage détecté — commission bloquée.' }) };
        }
        if (ambData.status !== 'active') {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Code ambassadeur suspendu — pas de commission.' }) };
        }

        const rate = (() => {
          const activatedAt = ambData.activatedAt ? new Date(ambData.activatedAt) : null;
          if (activatedAt && (Date.now() - activatedAt.getTime()) <= 30 * 24 * 3600 * 1000) return 0.20;
          return 0.15;
        })();
        const commissionAmount = Math.round(amountPaid * rate);

        // Flag anti-abus : plusieurs filleuls payants différents le même jour
        // pour ce même ambassadeur → signalé pour vérification manuelle,
        // sans bloquer la commission (évite les faux positifs).
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todaySnap = await db.collection('ambassador_commissions')
          .where('ambassador_id', '==', ambassadorUid)
          .where('created_at', '>=', todayStart.toISOString())
          .get();
        const distinctReferredToday = new Set(todaySnap.docs.map(d => d.data().referred_user_id));
        const flagged = distinctReferredToday.size >= 3;

        const commissionRef = await db.collection('ambassador_commissions').add({
          ambassador_id: ambassadorUid,
          referred_user_id: targetUid,
          plan, gross_amount: amountPaid, net_amount: amountPaid, rate,
          commission_amount: commissionAmount,
          status: 'due',
          flagged_for_review: flagged,
          created_at: new Date().toISOString(),
        });

        await db.collection('ambassador_events').add({
          code: refCode, type: 'paid', referred_user_id: targetUid,
          plan, amount: amountPaid, net_amount: amountPaid, created_at: new Date().toISOString(),
        });

        // Éclaireur → Ambassadeur au 1er paid
        if (ambData.level === 'eclaireur') {
          await db.collection('ambassadors').doc(ambassadorUid).set({ level: 'ambassadeur' }, { merge: true });
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: { id: commissionRef.id, amount: commissionAmount, ambassadorUid } }) };
      }

      // Marquer une commission comme payée (Mobile Money) après versement.
      // Applique automatiquement le solde de clawback éventuel (remboursements
      // survenus après un versement précédent) en le déduisant du montant net versé.
      case 'ambassadorMarkCommissionPaid': {
        const { commissionId } = payload || {};
        if (!commissionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'commissionId requis' }) };
        const commRef = db.collection('ambassador_commissions').doc(commissionId);
        const result = await db.runTransaction(async (tx) => {
          const commSnap = await tx.get(commRef);
          if (!commSnap.exists) throw new Error('Commission introuvable');
          const comm = commSnap.data();
          if (comm.status !== 'due') throw new Error(`Commission déjà au statut "${comm.status}"`);
          const ambRef = db.collection('ambassadors').doc(comm.ambassador_id);
          const ambSnap = await tx.get(ambRef);
          const clawbackBalance = ambSnap.exists ? (ambSnap.data().clawback_balance || 0) : 0;
          const gross = comm.commission_amount;
          const offset = Math.min(clawbackBalance, gross);
          const netPaid = gross - offset;
          tx.update(commRef, {
            status: 'paid', paid_at: new Date().toISOString(),
            net_paid_amount: netPaid, clawback_offset: offset,
          });
          if (offset > 0) {
            tx.update(ambRef, { clawback_balance: admin.firestore.FieldValue.increment(-offset) });
          }
          return { gross, offset, netPaid, ambassadorId: comm.ambassador_id };
        });
        await db.collection('ambassador_notifications').add({
          ambassador_id: result.ambassadorId,
          message: result.offset > 0
            ? `💰 Versement de ${result.netPaid.toLocaleString('fr-FR')} FCFA effectué (${result.offset.toLocaleString('fr-FR')} FCFA déduits pour un clawback en cours).`
            : `💰 Versement de ${result.netPaid.toLocaleString('fr-FR')} FCFA effectué.`,
          read: false,
          created_at: new Date().toISOString(),
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
      }

      // Clawback : remboursement d'un forfait constaté APRÈS que la commission
      // correspondante ait déjà été versée. On ne retire pas d'argent déjà
      // envoyé : on crédite un solde négatif sur l'ambassadeur, déduit
      // automatiquement de son ou ses prochains versements (voir ci-dessus).
      case 'ambassadorClawback': {
        const { commissionId, reason } = payload || {};
        if (!commissionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'commissionId requis' }) };
        const commRef = db.collection('ambassador_commissions').doc(commissionId);
        const result = await db.runTransaction(async (tx) => {
          const commSnap = await tx.get(commRef);
          if (!commSnap.exists) throw new Error('Commission introuvable');
          const comm = commSnap.data();
          if (comm.status !== 'paid') throw new Error('Seule une commission déjà versée ("paid") peut faire l’objet d’un clawback.');
          const ambRef = db.collection('ambassadors').doc(comm.ambassador_id);
          const clawbackAmount = comm.net_paid_amount ?? comm.commission_amount;
          tx.update(commRef, {
            status: 'clawback', clawback_at: new Date().toISOString(),
            clawback_reason: reason || '', clawback_amount: clawbackAmount,
          });
          tx.update(ambRef, { clawback_balance: admin.firestore.FieldValue.increment(clawbackAmount) });
          return { clawbackAmount, ambassadorUid: comm.ambassador_id };
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
      }

      // Lister toutes les commissions (avec email/code ambassadeur joints),
      // optionnellement filtrées par statut (due / paid / clawback).
      case 'ambassadorListCommissions': {
        const statusFilter = payload?.status;
        let q = db.collection('ambassador_commissions').orderBy('created_at', 'desc').limit(300);
        const snap = await q.get();
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (statusFilter) list = list.filter(c => c.status === statusFilter);
        const ambIds = [...new Set(list.map(c => c.ambassador_id))];
        const ambMap = {};
        await Promise.all(ambIds.map(async (id) => {
          const s = await db.collection('ambassadors').doc(id).get();
          if (s.exists) ambMap[id] = { email: s.data().email || '', code: s.data().code || '' };
        }));
        list = list.map(c => ({ ...c, ambassador: ambMap[c.ambassador_id] || null }));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commissions: list }) };
      }

      // Ouvrir/fermer les candidatures ambassadeur (recrutement par vagues)
      case 'ambassadorSetRecruitment': {
        const { open: isOpen, nextWave } = payload || {};
        await db.collection('config').doc('ambassadorRecruitment').set({
          open: !!isOpen,
          nextWave: nextWave || null,
          updated_at: new Date().toISOString(),
        }, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Action inconnue : ${action}` }) };
    }

  } catch (e) {
    console.error('adminAction error:', e);
    // Ne jamais renvoyer le détail technique au navigateur (fuite d'information)
    const st = e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    return { statusCode: st, headers, body: JSON.stringify({ error: st === 500 ? 'Erreur serveur' : (e.message || 'Requête invalide') }) };
  }
};
