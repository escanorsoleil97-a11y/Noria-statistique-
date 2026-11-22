// build: 2026.11.22.0927
// Service worker minimal : aucune mise en cache, aucune interception de requêtes.
// À chaque changement d'une ligne de ce fichier (voir « build » ci-dessus, estampillé par
// scripts/bump-version.js), le navigateur installe la nouvelle version, qui prend la main aussitôt.
// À l'activation, tout cache résiduel d'une ancienne version est supprimé.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  (async () => {
    try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (_) {}
    await self.clients.claim();
  })()
));
self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
