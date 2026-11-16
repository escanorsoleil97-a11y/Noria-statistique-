// v2 - nouvelle icône. Service worker minimal : aucune mise en cache, aucune interception.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
