// Service worker — makes the app installable as a PWA, and keeps the app's own
// code (JS/CSS/icons) on the phone so a cold open doesn't re-download it.
//
// Rota data is NEVER cached: /api/*, the HTML page and anything else pass
// straight through to the network, so what you see is always live. Only
// requests carrying a ?v=<version> token are cached — index.html stamps the
// running app version into every asset URL, so a deploy changes every URL and
// old copies can never be served against a newer page. Entries from older
// versions are swept as soon as a newer version's assets are fetched.
const CACHE = 'rota-assets';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.searchParams.has('v') || !/^\/(js|css|icons)\//.test(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) {
      // A new version is being fetched — clear the older ones out as we go.
      const v = url.searchParams.get('v');
      cache.keys().then(keys => keys.forEach(k => {
        if (new URL(k.url).searchParams.get('v') !== v) cache.delete(k);
      }));
      cache.put(req, res.clone());
    }
    return res;
  })());
});
