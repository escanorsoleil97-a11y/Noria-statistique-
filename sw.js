// Service worker minimal : aucune mise en cache, aucune interception (le site se comporte exactement comme avant).
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
