// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Suggestion de variable dépendante par IA (server-side)
// Construit le prompt côté serveur (invisible dans le code client), appelle la
// cascade de fournisseurs, valide et parse le JSON retourné, avec une tentative
// de retry si le nom de variable renvoyé ne correspond à aucune variable réelle.
// Gratuit comme avant : aucune déduction de chimis (comportement inchangé).
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const _secRL = require('./_security');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // ── AUTH ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié — token manquant' }) };
  }
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1])).uid;
  } catch (e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalide ou expiré' }) };
  }
  if (!(await _secRL.rateLimitDurable('ai:' + uid, { limit: 40, windowMs: 60000 }))) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de requêtes, réessayez dans une minute.' }) };
  }

  // Cette fonctionnalité est gratuite et ne débite pas de chimis : elle ne doit
  // pas être bloquée lorsque le solde de l'utilisateur est nul.

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { theme, context: _ctx, varsExactes, variableNames, needType: _need } = body;
  // Contextes et exigences de type reconnus (uniformes pour tous les tests)
  const context = ['biv', 'reg', 'adv'].includes(_ctx) ? _ctx : 'biv';
  const needType = ['num', 'cat', 'bin', 'any'].includes(_need) ? _need : (context === 'reg' ? 'any' : 'cat');
  if (!theme || typeof theme !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'theme manquant' }) };
  }
  if (!varsExactes || typeof varsExactes !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'varsExactes manquant' }) };
  }
  if (!Array.isArray(variableNames) || !variableNames.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'variableNames manquant' }) };
  }

  const cleanTheme = String(theme).slice(0, 600);
  const prompt = buildPrompt({ theme: cleanTheme, context, varsExactes, needType });
  const nomsValides = new Set(variableNames);
  const parsedVars = parseVars(String(varsExactes));
  const eligible = (nom) => isEligibleVD(parsedVars[nom], needType);

  async function runCascadeOnce() {
    const cascade = [callDeepSeek, callCerebras, callGroq, callGemini, callMistral, callClaude];
    let lastErr = null;
    for (const call of cascade) {
      try {
        const text = await call(prompt);
        const clean = text.replace(/```json|```/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('Pas de JSON trouvé dans la réponse');
        return JSON.parse(match[0]);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Aucun fournisseur IA disponible.');
  }

  try {
    let result = await runCascadeOnce();

    // Retry unique si le nom de variable renvoyé n'est pas exact (même logique
    // que l'ancien code client : un seul passage de cascade supplémentaire).
    if (result && (!nomsValides.has(result.variable_dependante) || !eligible(result.variable_dependante))) {
      try { result = await runCascadeOnce(); } catch (e) { /* on garde le résultat précédent */ }
    }

    // Garde-fou final : nom exact ET variable utilisable comme VD pour ce test
    // (type attendu, pas d'identifiant, pas trop de valeurs manquantes).
    if (!result || !nomsValides.has(result.variable_dependante) || !eligible(result.variable_dependante)) {
      const fb = fallbackVD(parsedVars, variableNames, cleanTheme, needType);
      if (!fb) {
        return { statusCode: 502, headers, body: JSON.stringify({ error: "Aucune variable ne convient comme variable dépendante pour ce test (type attendu : " + needType + "). Vérifiez vos données ou choisissez manuellement." }) };
      }
      result = {
        variable_dependante: fb,
        justification: "Choix de repli (règles méthodologiques) : variable compatible avec le test, peu de valeurs manquantes et liée au thème de l'étude. Vérifiez qu'elle correspond bien à votre objectif principal.",
        variables_independantes_suggerees: variableNames.filter(n => n !== fb && parsedVars[n] && !parsedVars[n].identifiant && parsedVars[n].manquants <= 40).slice(0, 5),
      };
    }

    // Nettoyage : VI = noms exacts, distincts de la VD, sans doublon
    const vis = Array.isArray(result.variables_independantes_suggerees) ? result.variables_independantes_suggerees : [];
    result.variables_independantes_suggerees = [...new Set(vis.filter(v => nomsValides.has(v) && v !== result.variable_dependante))].slice(0, 8);
    result.justification = String(result.justification || '').slice(0, 1500);
    result.needType = needType;

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || 'Erreur IA.' }) };
  }
};

// ── ANALYSE DES VARIABLES (règles uniformes pour tous les tests) ─────────────
// Ligne type : 3. "Nom" [quantitative] — min=1.0, max=9.0, 2.5% manquants
function parseVars(txt) {
  const out = {};
  String(txt).split('\n').forEach(line => {
    const m = line.match(/^\s*\d+\.\s*"(.+)"\s*\[([^\]]+)\]\s*—\s*(.*)$/);
    if (!m) return;
    const nom = m[1], typeLabel = m[2].toLowerCase(), rest = m[3];
    const quant = /quanti|num/.test(typeLabel);
    const mod = rest.match(/(\d+)\s*modalit/);
    const manq = rest.match(/([\d.]+)%\s*manquants/);
    const nMod = mod ? parseInt(mod[1], 10) : null;
    out[nom] = {
      nom, quant, nMod,
      manquants: manq ? parseFloat(manq[1]) : 0,
      // identifiant probable : nom évocateur ou catégorielle à très forte cardinalité
      identifiant: /^(id|n°|num(éro)?|matricule|code|ref|référence|index|horodateur|timestamp|date)\b|\b(identifiant|id)$/i.test(nom) || (!quant && nMod !== null && nMod > 30),
    };
  });
  return out;
}
function isEligibleVD(v, needType) {
  if (!v) return false;
  if (v.identifiant) return false;
  if (v.manquants > 40) return false;
  if (needType === 'num') return v.quant;
  if (needType === 'bin') return !v.quant && v.nMod === 2;
  if (needType === 'cat') return !v.quant && v.nMod !== null && v.nMod >= 2 && v.nMod <= 12;
  // any : quantitative ou catégorielle exploitable
  return v.quant || (v.nMod !== null && v.nMod >= 2 && v.nMod <= 12);
}
// Repli déterministe : proximité lexicale avec le thème, puis variable binaire, puis première éligible
function fallbackVD(parsed, names, theme, needType) {
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = new Set(norm(theme).split(/[^a-z0-9]+/).filter(t => t.length >= 4));
  const cands = names.filter(n => isEligibleVD(parsed[n], needType));
  if (!cands.length) return null;
  const score = n => {
    let s = 0;
    norm(n).split(/[^a-z0-9]+/).forEach(t => { if (t.length >= 4 && tokens.has(t)) s += 3; });
    const v = parsed[n];
    if (!v.quant && v.nMod === 2) s += 1;
    s -= v.manquants / 50;
    return s;
  };
  return cands.slice().sort((x, y) => score(y) - score(x))[0];
}

// ── CONSTRUCTION DU PROMPT ───────────────────────────────────────────────────
function buildPrompt({ theme, context, varsExactes, needType }) {
  const contextLabel = context === 'reg'
    ? 'régression (modélisation statistique)'
    : context === 'adv'
      ? 'test statistique avancé'
      : 'analyse bivariée (tableaux croisés, tests statistiques)';
  const typeRule = {
    num: 'La VD DOIT être quantitative (test sur une moyenne / ANCOVA / non paramétrique).',
    bin: 'La VD DOIT être qualitative à exactement 2 modalités (régression logistique / ROC).',
    cat: 'La VD DOIT être qualitative avec 2 à 12 modalités (Chi² / V de Cramér).',
    any: 'La VD peut être quantitative (régression linéaire) ou qualitative binaire (régression logistique).',
  }[needType];

  return `Biostatisticien expert. Étude : "${theme}". Analyse : ${contextLabel}.

VARIABLES DISPONIBLES (utilise UNIQUEMENT ces noms exacts, avec leur résumé statistique réel) :
${varsExactes}

RÈGLES ABSOLUES :
1. "variable_dependante" = nom COPIÉ mot pour mot depuis la liste ci-dessus (respecte la casse et les accents exactement)
2. "variables_independantes_suggerees" = noms COPIÉS mot pour mot depuis la liste, différents de la VD
3. La VD est l'outcome principal de l'objectif de l'étude (ce que l'on cherche à expliquer ou à estimer). Elle se choisit sur le THÈME et les OBJECTIFS, JAMAIS d'après une p-value, une association observée ou un résultat attendu (ce serait du p-hacking).
4. ${typeRule}
5. Exclus les identifiants, dates/horodatages, variables à forte cardinalité et celles à plus de 40 % de valeurs manquantes.
6. "justification" : 3 à 4 phrases exploitables dans la Discussion/Conclusion — pourquoi cette variable est l'outcome central (en t'appuyant sur le thème et son résumé statistique), puis pourquoi les VI choisies sont des facteurs plausibles (justification théorique, pas statistique).

JSON STRICT, aucun texte autour :
{"variable_dependante":"NomExactIci","justification":"3 à 4 phrases.","variables_independantes_suggerees":["Var1","Var2","Var3"]}`;
}

// ── APPELS PROVIDERS (identiques à generateAcademicText.js) ──────────────────
// Essaie chaque clé DANS L'ORDRE (1, 2, 3...) et passe à la suivante
// uniquement en cas d'échec (clé invalide, quota épuisé, rate limit).
async function tryKeysInOrder(keys, callFn) {
  if (!keys.length) throw new Error('NO_KEY');
  let lastErr;
  for (const key of keys) {
    try { return await callFn(key); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Scanne dynamiquement TOUTES les variables d'env correspondant à un préfixe
// donné (ex. "GROQ_KEY") — nombre de clés illimité (GROQ_KEY_1 ... GROQ_KEY_N).
function collectKeys(...prefixes) {
  const found = [];
  for (const prefix of prefixes) {
    const numbered = [];
    for (const [envName, value] of Object.entries(process.env)) {
      if (!value) continue;
      const m = envName.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (m) numbered.push([parseInt(m[1], 10), value]);
    }
    numbered.sort((a, b) => a[0] - b[0]);
    for (const [, value] of numbered) found.push(value);
    if (process.env[prefix]) found.push(...String(process.env[prefix]).split(',').map(s => s.trim()).filter(Boolean));
  }
  return found;
}

async function callGroq(prompt) {
  const keys = collectKeys('GROQ_KEY');
  if (!keys.length) throw new Error('Aucune GROQ_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Groq');
    return json.choices[0].message.content;
  });
}

async function callDeepSeek(prompt) {
  const keys = collectKeys('DEEPSEEK_KEY', 'DEEPSEEK_API_KEY');
  if (!keys.length) throw new Error('Aucune DEEPSEEK_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, thinking: { type: 'disabled' } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur DeepSeek');
    return json.choices[0].message.content;
  });
}

async function callGemini(prompt) {
  // Accepte GEMINI_KEY_* (nom historique) ET GEMINI_API_KEY_* (nom
  // actuellement configuré sur Netlify), nombre de clés illimité.
  const keys = collectKeys('GEMINI_KEY', 'GEMINI_API_KEY');
  if (!keys.length) throw new Error('Aucune GEMINI_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024 } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Gemini');
    return json.candidates[0].content.parts[0].text;
  });
}

async function callCerebras(prompt) {
  const keys = collectKeys('CEREBRAS_KEY');
  if (!keys.length) throw new Error('Aucune CEREBRAS_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Cerebras');
    return json.choices[0].message.content;
  });
}

async function callMistral(prompt) {
  const keys = collectKeys('MISTRAL_KEY');
  if (!keys.length) throw new Error('Aucune MISTRAL_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Mistral');
    return json.choices[0].message.content;
  });
}

async function callClaude(prompt) {
  const key = process.env.CLAUDE_KEY;
  if (!key) throw new Error('Aucune CLAUDE_KEY configurée');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Erreur Claude');
  return json.content[0].text;
}
