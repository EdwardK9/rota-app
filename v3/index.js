/* ─── V3.0 Features ────────────────────────────────────────────────────────
   Every V3 endpoint lives under /api/v3/ and is mounted from this one router,
   so server.js needs a single line to add (or remove) the whole feature set.

   Design rules for anything added here:
     • read-only against existing tables wherever possible — V3 is a new lens on
       data the app already has, not a new thing to keep up to date
     • anything V3 does own is prefixed v3_ (see schema.js) so it can't collide
     • no module reaches into server.js; shared logic lives in helpers.js
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');

require('./schema');   // create V3-owned tables before any route can hit them

const router = express.Router();

const FEATURES = [
  { view: 'money-clock',  icon: '💸', name: 'Money Clock',      module: './moneyClock',
    blurb: 'Watch your pay tick up live, and count down to payday.' },
  { view: 'goals',        icon: '🎯', name: 'Goal Tracker',     module: './goals',
    blurb: 'Set a money or hours target and see if the rota gets you there.' },
  { view: 'forecast',     icon: '🔮', name: 'Pay Forecast',     module: './forecast',
    blurb: 'Projects the tax year: gross, tax, NI and what actually lands.' },
  { view: 'annoying-shifts', icon: '😤', name: 'Annoying Shifts', module: './annoyingShifts',
    blurb: 'Counts the awkward ones: under 3 hours, mid-day, short evenings, split days and quick turnarounds.' },
  { view: 'commute-cost', icon: '⛽', name: 'Commute Cost',     module: './commuteCost',
    blurb: 'What the drive to work costs, and how much of your pay it eats.' },
  { view: 'break-debt',   icon: '☕', name: 'Break Debt',       module: './breakDebt',
    blurb: 'Every minute of break you skipped, and what it was worth.' },
  { view: 'overtime',     icon: '⏰', name: 'Overtime Tracker', module: './overtime',
    blurb: 'How far above your contract you actually work, and what it is worth.' },
  { view: 'pay-rises',    icon: '📈', name: 'Pay Rise History', module: './payRises',
    blurb: 'Every rate change, what each was worth, and how you sit against minimum wage.' },
  { view: 'year-numbers', icon: '📊', name: 'Year in Numbers',  module: './yearInNumbers',
    blurb: 'Every year side by side, with the change on the year before.' },
  { view: 'leave-planner',icon: '🏖️', name: 'Leave Optimiser',  module: './leavePlanner',
    blurb: 'Which leave days buy the most time off, worked out against your real rota.' },
  { view: 'cover-finder', icon: '🔁', name: 'Cover Finder',     module: './coverFinder',
    blurb: 'Who could realistically cover a shift, and what you could swap them for.' },
  { view: 'pay-audit',    icon: '🧾', name: 'Pay Audit',        module: './payAudit',
    blurb: 'Hours worked against hours paid, totalled so arrears timing cannot hide a gap.' },
  { view: 'tax-check',    icon: '💷', name: 'Tax Check',        module: './taxCheck',
    blurb: 'Checks the tax and NI actually deducted against what PAYE should have taken.' },
  { view: 'savings',      icon: '🐖', name: 'Savings & Share Plans', module: './savings',
    blurb: 'Track a Sharesave or any pot you pay into monthly: progress, payout date and what the shares are worth.' },
  { view: 'health-check', icon: '🩺', name: 'Data Doctor',      module: './healthCheck',
    blurb: 'Finds duplicate shifts, missed bank holidays, failed imports and stale figures.' },
];

for (const feature of FEATURES) {
  router.use('/', require(feature.module));
}

/** GET /api/v3/features — what V3 ships, for the client's landing card. Keeps
 *  the feature list defined in exactly one place. */
router.get('/features', (req, res) => {
  res.json({
    version: 'V3.0',
    features: FEATURES.map(({ view, icon, name, blurb }) => ({ view, icon, name, blurb })),
  });
});

module.exports = router;
module.exports.FEATURES = FEATURES;
