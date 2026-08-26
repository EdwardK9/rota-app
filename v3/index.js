/* ─── V3.0 Features ────────────────────────────────────────────────────────
   Every V3 endpoint lives under /api/v3/ and is mounted from this one router,
   so server.js needs a single line to add (or remove) the whole feature set.

   Design rules for anything added here:
     • read-only against existing tables wherever possible — V3 is a new lens on
       data the app already has, not a new thing to keep up to date
     • anything V3 does own is prefixed v3_ (see schema.js) so it can't collide
     • no module reaches into server.js; shared logic lives in helpers.js/stats.js
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');

require('./schema');   // create V3-owned tables before any route can hit them

const router = express.Router();

const FEATURES = [
  { view: 'money-clock',  icon: '💸', name: 'Money Clock',      module: './moneyClock',
    blurb: 'Watch your pay tick up live, and count down to payday.' },
  { view: 'trophies',     icon: '🏆', name: 'Trophy Cabinet',   module: './trophies',
    blurb: 'Achievements unlocked automatically from your shift history.' },
  { view: 'records',      icon: '📖', name: 'Record Book',      module: './records',
    blurb: 'Your personal bests — longest shift, biggest week, earliest start.' },
  { view: 'goals',        icon: '🎯', name: 'Goal Tracker',     module: './goals',
    blurb: 'Set a money or hours target and see if the rota gets you there.' },
  { view: 'forecast',     icon: '🔮', name: 'Pay Forecast',     module: './forecast',
    blurb: 'Projects the tax year: gross, tax, NI and what actually lands.' },
  { view: 'shift-dna',    icon: '🧬', name: 'Shift DNA',        module: './shiftDna',
    blurb: 'Six traits scored from your rota, and the archetype they add up to.' },
  { view: 'balance',      icon: '⚖️', name: 'Work-Life Balance',module: './balance',
    blurb: 'One score for how sustainable the last few months actually were.' },
  { view: 'commute-cost', icon: '⛽', name: 'Commute Cost',     module: './commuteCost',
    blurb: 'What the drive to work costs, and how much of your pay it eats.' },
  { view: 'on-this-day',  icon: '📼', name: 'On This Day',      module: './onThisDay',
    blurb: 'What you were doing on this date in previous years.' },
  { view: 'break-debt',   icon: '☕', name: 'Break Debt',       module: './breakDebt',
    blurb: 'Every minute of break you skipped, and what it was worth.' },
  { view: 'bingo',        icon: '🎲', name: 'Rota Bingo',       module: './bingo',
    blurb: 'A 5×5 card for the week that ticks itself off from real shifts.' },
  { view: 'countdowns',   icon: '⏳', name: 'Countdown Board',  module: './countdowns',
    blurb: 'Next shift, payday, leave, bank holiday and birthdays in one place.' },
  { view: 'briefing',     icon: '🎒', name: 'Shift Briefing',   module: './briefing',
    blurb: 'Your next shift on one card: crew, pay, turnaround and what the slot is usually like.' },
  { view: 'overtime',     icon: '⏰', name: 'Overtime Tracker', module: './overtime',
    blurb: 'How far above your contract you actually work, and what it is worth.' },
  { view: 'pay-rises',    icon: '📈', name: 'Pay Rise History', module: './payRises',
    blurb: 'Every rate change, what each was worth, and how you sit against minimum wage.' },
  { view: 'head-to-head', icon: '🥊', name: 'Head to Head',     module: './headToHead',
    blurb: 'Your rota against a colleague, measured like for like.' },
  { view: 'year-numbers', icon: '📊', name: 'Year in Numbers',  module: './yearInNumbers',
    blurb: 'Every year side by side, with the change on the year before.' },
  { view: 'did-you-know', icon: '🎲', name: 'Did You Know',     module: './didYouKnow',
    blurb: 'Oddball facts dug out of your own data.' },
  { view: 'leave-planner',icon: '🏖️', name: 'Leave Optimiser',  module: './leavePlanner',
    blurb: 'Which leave days buy the most time off, worked out against your real rota.' },
  { view: 'cover-finder', icon: '🔁', name: 'Cover Finder',     module: './coverFinder',
    blurb: 'Who could realistically cover a shift, and what you could swap them for.' },
  { view: 'crystal-ball', icon: '🔮', name: 'Rota Crystal Ball',module: './crystalBall',
    blurb: 'Projects a week the rota has not reached yet, and grades its own accuracy.' },
  { view: 'pay-audit',    icon: '🧾', name: 'Pay Audit',        module: './payAudit',
    blurb: 'Hours worked against hours paid, totalled so arrears timing cannot hide a gap.' },
  { view: 'tax-check',    icon: '💷', name: 'Tax Check',        module: './taxCheck',
    blurb: 'Checks the tax and NI actually deducted against what PAYE should have taken.' },
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
