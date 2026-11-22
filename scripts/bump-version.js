#!/usr/bin/env node
// Noria — estampille un numéro de version unique (AAAA.MM.JJ.HHmm, UTC) dans :
//   version.json · index.html (APP_VERSION) · sw.js (commentaire, force la mise à jour du service worker)
// Usage :  node scripts/bump-version.js            → nouvelle version, mise à jour proposée aux utilisateurs
//          node scripts/bump-version.js --force    → mise à jour OBLIGATOIRE (écran bloquant pour les anciennes versions)
// Ne fait jamais échouer un déploiement : en cas de problème il affiche un avertissement et sort avec le code 0.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
try {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const version = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  const force = process.argv.includes('--force');

  const vjPath = path.join(root, 'version.json');
  let vj = {};
  try { vj = JSON.parse(fs.readFileSync(vjPath, 'utf8')); } catch (_) {}
  vj.version = version;
  vj.minVersion = force ? version : (vj.minVersion || '');
  vj.builtAt = d.toISOString();
  fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2) + '\n');

  const idxPath = path.join(root, 'index.html');
  let idx = fs.readFileSync(idxPath, 'utf8');
  const re = /(APP_VERSION\s*=\s*")[^"]*(")/;
  if (!re.test(idx)) throw new Error('APP_VERSION introuvable dans index.html');
  idx = idx.replace(re, `$1${version}$2`);
  fs.writeFileSync(idxPath, idx);

  const swPath = path.join(root, 'sw.js');
  let sw = fs.readFileSync(swPath, 'utf8');
  sw = /\/\/ build: .*/.test(sw) ? sw.replace(/\/\/ build: .*/, `// build: ${version}`) : `// build: ${version}\n` + sw;
  fs.writeFileSync(swPath, sw);

  console.log(`[bump-version] ${version}${force ? ' (mise à jour obligatoire)' : ''}`);
} catch (e) {
  console.warn('[bump-version] ignoré :', e.message);
}
