/* ─── V5.0 Features — Usage Analytics ──────────────────────────────────────
   Every V5 endpoint lives under /api/v5/ and is mounted from this one router,
   so server.js needs a single line to add (or remove) the whole feature set.

   What V5 is: the app watching itself. V1–V3 are lenses on the rota; V5 is a
   lens on *how you use the app to manage the rota* — when you open it, how long
   you stay, which screens you actually use, how far ahead you check your
   shifts, and (if you turn it on) where you are when you clock in.

   Design rules, same as V3's:
     • everything V5 owns is prefixed v5_ (see schema.js) — no existing table is
       touched, including clock_entries: GPS lives in v5_clock-owned rows keyed
       by date, so deleting V5's data never touches a clock record
     • the privacy switches are enforced server-side in ingest.js, not in the
       browser, so turning location off takes effect on the next request
     • no module reaches into server.js; shared logic lives in helpers.js
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');

require('./schema');   // create V5-owned tables before any route can hit them

const router = express.Router();

const FEATURES = [
  { view: 'v5-usage',     icon: '📈', name: 'App Usage',       module: './usage',
    blurb: 'Opens, session lengths, the hours you reach for it and the days you skip.' },
  { view: 'v5-screens',   icon: '🧭', name: 'Screen Time',     module: './screens',
    blurb: 'Which screens you actually use, how long you linger, and the paths between them.' },
  { view: 'v5-habits',    icon: '🔁', name: 'Check Habits',    module: './habits',
    blurb: 'How far ahead you check your shifts, and whether you look on the morning.' },
  { view: 'v5-locations', icon: '📍', name: 'Clock Map',       module: './locations',
    blurb: 'Where you were when you clocked in and out — off by default.' },
  { view: 'v5-privacy',   icon: '🔒', name: 'Data & Privacy',  module: './privacy',
    blurb: 'Exactly what is stored, the switches to stop it, and a button to delete it.' },
];

// The write endpoint isn't a feature — it has no page — so it's mounted apart
// from the FEATURES list that drives the hub.
router.use('/', require('./ingest'));

for (const feature of FEATURES) {
  router.use('/', require(feature.module));
}

/** GET /api/v5/features — what V5 ships, for the client's landing card. Keeps
 *  the feature list defined in exactly one place. */
router.get('/features', (req, res) => {
  res.json({
    version: 'V5.0',
    features: FEATURES.map(({ view, icon, name, blurb }) => ({ view, icon, name, blurb })),
  });
});

module.exports = router;
module.exports.FEATURES = FEATURES;
