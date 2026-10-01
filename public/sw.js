// Service worker — makes the app installable, lets it open with no signal, and
// makes sure a clock in/out (or NFC tag tap) is never lost to bad signal.
//
//  • App code (JS/CSS/icons with a ?v= token): cache-first. index.html stamps a
//    content hash into every asset URL, so a changed file is a new URL and an
//    old copy can never be served against a newer page.
//  • The page itself and GET /api/* data: network first, always. Only when the
//    network fails (or takes too long) is the last saved copy used instead, and
//    it's marked with an X-Offline-Cache header so the app can say "showing
//    saved info from 07:52". With signal, what you see is always live.
//  • /clock-tap (the NFC tag URL): if it can't reach the server, the tap is
//    queued (ClockQueue, in IndexedDB) with the time it happened and replayed
//    when there's signal — background sync where the browser supports it,
//    otherwise the next time the app is opened.
importScripts('/js/clockQueue.js');

const ASSETS = 'rota-assets';
const DATA = 'rota-data';
const API_TIMEOUT_MS = 8000;      // weak signal: fall back to the saved copy after this
const PAGE_TIMEOUT_MS = 6000;
const TAP_TIMEOUT_MS = 8000;
const DATA_MAX_ENTRIES = 300;
const DATA_MAX_AGE_MS = 14 * 86400000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  await self.clients.claim();
  await pruneData();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'GET' && url.pathname === '/clock-tap') {
    e.respondWith(clockTap(req, url));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.searchParams.has('v') && /^\/(js|css|icons)\//.test(url.pathname)) {
    e.respondWith(assetCacheFirst(req, url));
  } else if (url.pathname.startsWith('/api/') && !isUncacheableApi(url)) {
    e.respondWith(networkFirst(req, API_TIMEOUT_MS, req));
  } else if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // One saved copy of the shell, whatever the hash/query.
    e.respondWith(networkFirst(req, PAGE_TIMEOUT_MS, new Request('/')));
  }
});

// Binary downloads, exports and anything streaming aren't worth (or safe) saving.
// Settings and anything credential-shaped stay off the phone's disk too: the
// settings response carries API keys and tokens.
function isUncacheableApi(url) {
  return /\/(files?|download|export|photos?|backup|db-backups|ics|image|thumb|settings|rotageek|gcal|google|token|key)/i.test(url.pathname);
}

async function assetCacheFirst(req, url) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    // A newer version is being fetched — clear older copies of the same file.
    cache.keys().then(keys => keys.forEach(k => {
      const ku = new URL(k.url);
      if (ku.pathname === url.pathname && ku.search !== url.search) cache.delete(k);
    }));
    cache.put(req, res.clone());
  }
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req, timeoutMs, cacheKey) {
  const cache = await caches.open(DATA);
  const network = fetch(req).then(async res => {
    const type = res.headers.get('content-type') || '';
    if (res.ok && (type.includes('application/json') || type.includes('text/html'))) {
      // Stamp when it was saved, so an offline answer can say how old it is.
      const headers = new Headers(res.headers);
      headers.set('X-Saved-At', new Date().toISOString());
      const body = await res.clone().blob();
      cache.put(cacheKey, new Response(body, { status: res.status, statusText: res.statusText, headers }));
    }
    return res;
  });

  const saved = await cache.match(cacheKey);
  if (!saved) return network;   // nothing to fall back to — just wait for the network

  try {
    return await withTimeout(network, timeoutMs);
  } catch (_) {
    network.catch(() => {});    // a late answer still refreshes the saved copy
    const headers = new Headers(saved.headers);
    headers.set('X-Offline-Cache', saved.headers.get('X-Saved-At') || '1');
    return new Response(await saved.blob(), { status: saved.status, statusText: saved.statusText, headers });
  }
}

async function pruneData() {
  const cache = await caches.open(DATA);
  const keys = await cache.keys();
  const dated = await Promise.all(keys.map(async k => {
    const r = await cache.match(k);
    return { k, at: Date.parse(r && r.headers.get('X-Saved-At')) || 0 };
  }));
  dated.sort((a, b) => b.at - a.at);
  const now = Date.now();
  await Promise.all(dated
    .filter((d, i) => i >= DATA_MAX_ENTRIES || now - d.at > DATA_MAX_AGE_MS)
    .map(d => cache.delete(d.k)));
}

// ── NFC tag tap ────────────────────────────────────────────────────────────
let _lastQueuedTap = 0;

async function clockTap(req, url) {
  // Anything already queued must reach the server before this tap does, or the
  // toggle would apply in the wrong order.
  const waiting = await ClockQueue.all();
  if (!waiting.length) {
    try {
      const res = await withTimeout(fetch(req), TAP_TIMEOUT_MS);
      if ((res.headers.get('content-type') || '').includes('text/html') && res.status < 500) return res;
    } catch (_) { /* no signal — fall through and queue it */ }
  } else {
    await flushAndNotify().catch(() => {});
    if (!(await ClockQueue.all()).length) {
      try { return await withTimeout(fetch(req), TAP_TIMEOUT_MS); } catch (_) { /* queue below */ }
    }
  }

  if (!url.searchParams.get('token')) return tapPage('Not authorised', 'This tag link has no token.', '#e5573c');

  // A tag read twice in one tap (or a link prefetch) must not toggle twice.
  let item;
  if (Date.now() - _lastQueuedTap > 6000) {
    item = await ClockQueue.add('tap');
    _lastQueuedTap = Date.now();
    if (self.registration.sync) self.registration.sync.register('clock-queue').catch(() => {});
  }
  const time = item ? item.time : '';
  return tapPage(
    '📶 Saved — no signal',
    `Your tap${time ? ` at <strong>${time}</strong>` : ''} is saved on this phone and will be sent automatically as soon as there's signal (or next time you open the app). It'll count as the time you tapped, not when it's sent.`,
    '#e5a13c');
}

function tapPage(title, body, color) {
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1420;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  .card{max-width:340px} h1{font-size:22px;margin:0 0 10px;color:${color}}
  p{color:#9aa4b8;font-size:14px;line-height:1.5} strong{color:#e8ecf4} a{color:#5b9dff}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p><p><a href="/">Open Rota App</a></p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ── Sending the queue from the worker ─────────────────────────────────────
async function flushAndNotify() {
  const result = await ClockQueue.flush();
  if (result.sent.length) {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'clock-queue-sent', sent: result.sent }));
  }
  if (result.left) throw new Error('still offline');   // tells background sync to retry later
  return result;
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'clock-queue') e.waitUntil(flushAndNotify());
});
