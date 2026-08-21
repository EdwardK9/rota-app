/* ─── 🏆 Trophy Cabinet (V3.0) ─────────────────────────────────────────────
   GET /api/v3/trophies

   Achievements unlocked purely from data the app already holds — nothing to
   opt into, nothing to tick off by hand. Each trophy declares the stat it
   watches and the threshold it needs, so progress bars come for free and
   adding a new one is a single row in TROPHIES.

   Unlock dates are persisted the first time a trophy is earned (v3_trophy_
   unlocks), so a trophy stays won even if the underlying stat later dips —
   deleting an old shift shouldn't confiscate a medal.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, paidHours, round1 } = require('./helpers');
const { careerStats } = require('./stats');
require('./schema');

const router = express.Router();

/* stat: key into the computed stat bag. need: threshold to unlock.
   tier drives the colour/rarity styling on the client. */
const TROPHIES = [
  // ── Getting started ────────────────────────────────────────────────────
  { code: 'first_shift',     icon: '🌱', name: 'First Day on the Floor', tier: 'bronze',
    desc: 'Log your very first completed shift.',            stat: 'totalShifts', need: 1 },
  { code: 'shifts_10',       icon: '📋', name: 'Getting the Hang of It', tier: 'bronze',
    desc: 'Complete 10 shifts.',                             stat: 'totalShifts', need: 10 },
  { code: 'shifts_50',       icon: '🔧', name: 'Part of the Furniture',  tier: 'silver',
    desc: 'Complete 50 shifts.',                             stat: 'totalShifts', need: 50 },
  { code: 'shifts_100',      icon: '💯', name: 'Century',                tier: 'gold',
    desc: 'Complete 100 shifts.',                            stat: 'totalShifts', need: 100 },
  { code: 'shifts_250',      icon: '🗿', name: 'Living Legend',          tier: 'platinum',
    desc: 'Complete 250 shifts.',                            stat: 'totalShifts', need: 250 },

  // ── Hours ──────────────────────────────────────────────────────────────
  { code: 'hours_100',       icon: '⏱️', name: 'Hundred Hour Club',      tier: 'bronze',
    desc: 'Clock up 100 paid hours.',                        stat: 'totalHours', need: 100 },
  { code: 'hours_500',       icon: '⏳', name: 'Time Served',            tier: 'silver',
    desc: 'Clock up 500 paid hours.',                        stat: 'totalHours', need: 500 },
  { code: 'hours_1000',      icon: '🕰️', name: 'Four Figures',           tier: 'gold',
    desc: 'Clock up 1,000 paid hours.',                      stat: 'totalHours', need: 1000 },
  { code: 'long_shift',      icon: '🥵', name: 'The Long Haul',          tier: 'silver',
    desc: 'Work a single shift of 9 paid hours or more.',    stat: 'longestShiftHours', need: 9 },

  // ── Money ──────────────────────────────────────────────────────────────
  { code: 'earned_1k',       icon: '💷', name: 'First Grand',            tier: 'bronze',
    desc: 'Earn £1,000 across your logged shifts.',          stat: 'totalPay', need: 1000 },
  { code: 'earned_10k',      icon: '💰', name: 'Five Figures',           tier: 'gold',
    desc: 'Earn £10,000 across your logged shifts.',         stat: 'totalPay', need: 10000 },
  { code: 'earned_25k',      icon: '🏦', name: 'Vault Keeper',           tier: 'platinum',
    desc: 'Earn £25,000 across your logged shifts.',         stat: 'totalPay', need: 25000 },
  { code: 'payslips_12',     icon: '🧾', name: 'A Full Year of Payslips',tier: 'silver',
    desc: 'Log 12 payslips.',                                stat: 'payslipCount', need: 12 },
  { code: 'taxman',          icon: '🎩', name: 'Funding the Nation',     tier: 'silver',
    desc: 'Pay £1,000 in tax and National Insurance.',       stat: 'lifetimeTax', need: 1000 },

  // ── Antisocial hours ───────────────────────────────────────────────────
  { code: 'early_bird',      icon: '🐦', name: 'Early Bird',             tier: 'bronze',
    desc: 'Start 10 shifts at or before 07:00.',             stat: 'earlyStarts', need: 10 },
  { code: 'night_owl',       icon: '🦉', name: 'Night Owl',              tier: 'bronze',
    desc: 'Finish 10 shifts at or after 20:00.',             stat: 'lateFinishes', need: 10 },
  { code: 'weekend_warrior', icon: '⚔️', name: 'Weekend Warrior',        tier: 'silver',
    desc: 'Work 25 weekend shifts.',                         stat: 'weekendShifts', need: 25 },
  { code: 'bank_holiday',    icon: '🎆', name: 'Someone Has to Do It',   tier: 'gold',
    desc: 'Work 3 bank holidays.',                           stat: 'bankHolidayShifts', need: 3 },
  { code: 'streak_7',        icon: '🔁', name: 'Seven Straight',         tier: 'silver',
    desc: 'Work 7 days in a row.',                           stat: 'longestStreakDays', need: 7 },
  { code: 'streak_10',       icon: '🧱', name: 'Unbreakable',            tier: 'gold',
    desc: 'Work 10 days in a row.',                          stat: 'longestStreakDays', need: 10 },

  // ── People ─────────────────────────────────────────────────────────────
  { code: 'social_10',       icon: '👥', name: 'Knows Everyone',         tier: 'bronze',
    desc: 'Share a shift with 10 different colleagues.',     stat: 'distinctColleagues', need: 10 },
  { code: 'social_25',       icon: '🎪', name: 'The Whole Store',        tier: 'gold',
    desc: 'Share a shift with 25 different colleagues.',     stat: 'distinctColleagues', need: 25 },
  { code: 'full_crew',       icon: '🚒', name: 'Full Crew',              tier: 'silver',
    desc: 'Work alongside 6 or more colleagues in one day.', stat: 'biggestCrewCount', need: 6 },

  // ── Discipline ─────────────────────────────────────────────────────────
  { code: 'breaks_50',       icon: '☕', name: 'Break Taker',            tier: 'bronze',
    desc: 'Take your full break on 50 shifts.',              stat: 'breaksFull', need: 50 },
  { code: 'punctual_25',     icon: '⏰', name: 'Never Late',             tier: 'silver',
    desc: 'Clock in on time 25 times, with 5 minutes grace.',stat: 'punctualCount', need: 25 },
  { code: 'clock_100',       icon: '🎯', name: 'Creature of Habit',      tier: 'gold',
    desc: 'Record 100 clock-ins.',                           stat: 'clockIns', need: 100 },

  // ── Road ───────────────────────────────────────────────────────────────
  { code: 'miles_100',       icon: '🚗', name: 'Commuter',               tier: 'bronze',
    desc: 'Drive 100 miles to work.',                        stat: 'totalMiles', need: 100 },
  { code: 'miles_1000',      icon: '🛣️', name: 'Round Britain',          tier: 'gold',
    desc: 'Drive 1,000 miles to work.',                      stat: 'totalMiles', need: 1000 },

  // ── Service ────────────────────────────────────────────────────────────
  { code: 'year_one',        icon: '🎂', name: 'One Year Down',          tier: 'silver',
    desc: 'Reach one year since your start date.',           stat: 'daysEmployed', need: 365 },
  { code: 'year_two',        icon: '🏅', name: 'Two Years Deep',         tier: 'gold',
    desc: 'Reach two years since your start date.',          stat: 'daysEmployed', need: 730 },
  { code: 'holiday_maker',   icon: '🏖️', name: 'Holiday Maker',          tier: 'bronze',
    desc: 'Take 10 days of leave.',                          stat: 'leaveDays', need: 10 },
];

const TIER_ORDER = { bronze: 0, silver: 1, gold: 2, platinum: 3 };

/** Flattens careerStats() into the scalar bag the thresholds compare against. */
function trophyValues() {
  const s = careerStats();
  return {
    totalShifts: s.totalShifts,
    totalHours: s.totalHours,
    totalPay: s.totalPay,
    totalMiles: s.totalMiles,
    longestShiftHours: s.longestShift ? round1(paidHours(s.longestShift)) : 0,
    payslipCount: s.payslipCount,
    lifetimeTax: s.lifetimeTax,
    earlyStarts: s.earlyStarts,
    lateFinishes: s.lateFinishes,
    weekendShifts: s.weekendShifts,
    bankHolidayShifts: s.bankHolidayShifts,
    longestStreakDays: s.longestStreakDays,
    distinctColleagues: s.distinctColleagues,
    biggestCrewCount: s.biggestCrewDay.count,
    breaksFull: s.breaksFull,
    punctualCount: s.punctualCount,
    clockIns: s.clockIns,
    daysEmployed: s.daysEmployed || 0,
    leaveDays: s.leaveDays,
  };
}

router.get('/trophies', (req, res) => {
  const values = trophyValues();

  const knownUnlocks = {};
  for (const row of db.prepare('SELECT * FROM v3_trophy_unlocks').all()) {
    knownUnlocks[row.code] = row.unlocked_at;
  }
  const remember = db.prepare('INSERT OR IGNORE INTO v3_trophy_unlocks (code) VALUES (?)');

  const results = TROPHIES.map(t => {
    const value = values[t.stat] || 0;
    // Once won, always won — a persisted unlock outranks a stat that has since fallen.
    const nowEarned = value >= t.need;
    if (nowEarned && !knownUnlocks[t.code]) {
      remember.run(t.code);
      knownUnlocks[t.code] = new Date().toISOString();
    }
    return {
      ...t,
      value: round1(value),
      earned: nowEarned || !!knownUnlocks[t.code],
      progress_pct: Math.min(100, Math.round((value / t.need) * 1000) / 10),
      unlocked_at: knownUnlocks[t.code] || null,
    };
  });

  const earned = results.filter(t => t.earned);
  // Earned first (rarest at the top), then locked ones sorted by how close they are.
  results.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    if (a.earned) return TIER_ORDER[b.tier] - TIER_ORDER[a.tier];
    return b.progress_pct - a.progress_pct;
  });

  res.json({
    trophies: results,
    earned_count: earned.length,
    total_count: TROPHIES.length,
    completion_pct: Math.round((earned.length / TROPHIES.length) * 1000) / 10,
    by_tier: ['bronze', 'silver', 'gold', 'platinum'].map(tier => ({
      tier,
      earned: earned.filter(t => t.tier === tier).length,
      total: TROPHIES.filter(t => t.tier === tier).length,
    })),
    stats: values,
  });
});

module.exports = router;
module.exports.TROPHIES = TROPHIES;
