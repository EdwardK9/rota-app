// Minimal service worker — exists to make the app installable as a PWA.
// Deliberately does NO caching: rota data must always be live, and the app is
// online-only anyway (everything comes from the server API). All requests pass
// straight through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
