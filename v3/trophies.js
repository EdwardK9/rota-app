/* ─── 🏆 Trophy Cabinet (V3.0) ─────────────────────────────────────────────
   GET /api/v3/trophies

   Achievements unlocked purely from data the app already holds — nothing to
   opt into, nothing to tick off by hand.

   Every trophy is a *family* with four tiers (bronze → platinum) rather than a
   one-shot award, so a single line here is worth four unlocks and there is
   always a next target rather than a wall of finished cards.

   Thresholds are calibrated against a real retail rota — a "long shift" is 8
   paid hours, not 12 — because a target nobody can physically reach isn't an
   achievement, it's a bug. `dynamic` families compute their thresholds from
   your own data instead (see The Whole Store).

   Unlock dates are persisted per tier (v3_trophy_unlocks), so a trophy stays
   won even if the underlying stat later dips.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, paidHours, round1 } = require('./helpers');
const { careerStats } = require('./stats');
const { bankHolidayDates } = require('./bankHolidays');
require('./schema');

const router = express.Router();

const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

/* stat  — key into the computed stat bag
   need  — [bronze, silver, gold, platinum] thresholds
   unit  — how the value reads ('count' | 'hours' | 'money' | 'miles' | 'mins' | 'days' | 'pct')
   dynamic — thresholds derived from your data at request time                */
const FAMILIES = [
  // ── The basics ─────────────────────────────────────────────────────────
  { code: 'shifts', icon: '📋', name: 'Shifts Worked', unit: 'count',
    blurb: 'Every shift you have logged.',
    stat: 'totalShifts', need: [25, 100, 250, 500] },
  { code: 'hours', icon: '⏱️', name: 'Hours on the Clock', unit: 'hours',
    blurb: 'Total paid hours across your whole history.',
    stat: 'totalHours', need: [100, 500, 1000, 2000] },
  { code: 'earned', icon: '💷', name: 'Total Earned', unit: 'money',
    blurb: 'Gross pay from every shift you have logged.',
    stat: 'totalPay', need: [1000, 5000, 15000, 30000] },
  { code: 'service', icon: '🎂', name: 'Time Served', unit: 'days',
    blurb: 'Days since your start date.',
    stat: 'daysEmployed', need: [180, 365, 730, 1825] },

  // ── Antisocial hours ───────────────────────────────────────────────────
  { code: 'weekends', icon: '⚔️', name: 'Weekend Warrior', unit: 'count',
    blurb: 'Shifts worked on a Saturday or Sunday.',
    stat: 'weekendShifts', need: [10, 40, 100, 200] },
  { code: 'early_starts', icon: '🌅', name: 'Early Bird', unit: 'count',
    blurb: 'Shifts starting at or before 07:00.',
    stat: 'earlyStarts', need: [5, 25, 75, 150] },
  { code: 'late_finishes', icon: '🦉', name: 'Night Owl', unit: 'count',
    blurb: 'Shifts finishing at or after 20:00.',
    stat: 'lateFinishes', need: [5, 25, 75, 150] },
  { code: 'bank_holidays', icon: '🎆', name: 'Someone Has to Do It', unit: 'count',
    blurb: 'Bank holidays worked — matched against the real calendar, not just the double-pay flag.',
    stat: 'bankHolidayShifts', need: [1, 3, 6, 12] },
  { code: 'long_shift', icon: '🥵', name: 'The Long Haul', unit: 'hours',
    blurb: 'Your longest single shift, in paid hours.',
    stat: 'longestShiftHours', need: [6, 7, 8, 9] },
  { code: 'streak', icon: '🔁', name: 'On the Trot', unit: 'days',
    blurb: 'Longest run of consecutive days worked.',
    stat: 'longestStreakDays', need: [4, 6, 8, 10] },

  // ── Clocking ───────────────────────────────────────────────────────────
  { code: 'clock_ins', icon: '🎯', name: 'Creature of Habit', unit: 'count',
    blurb: 'Clock-ins recorded.',
    stat: 'clockIns', need: [25, 100, 250, 500] },
  { code: 'punctual', icon: '⏰', name: 'Never Late', unit: 'count',
    blurb: 'Clock-ins at or before your start time, with five minutes grace.',
    stat: 'punctualCount', need: [10, 50, 150, 300] },
  { code: 'keen_bean', icon: '🐦', name: 'Keen Bean', unit: 'count',
    blurb: 'Clock-ins a full 10 minutes or more before your shift started.',
    stat: 'earlyBy10Count', need: [5, 20, 50, 100] },
  { code: 'banked_early', icon: '⏳', name: 'Time Donated', unit: 'mins',
    blurb: 'Every minute you have ever clocked in early, added up.',
    stat: 'totalEarlyMins', need: [60, 300, 900, 1800] },

  // ── People ─────────────────────────────────────────────────────────────
  { code: 'colleagues', icon: '👥', name: 'Knows Everyone', unit: 'count',
    blurb: 'Different colleagues you have shared a shift with.',
    stat: 'distinctColleagues', need: [5, 15, 30, 50] },
  // Dynamic: the target is the store itself, so a new starter puts it back out
  // of reach until you have worked with them too.
  { code: 'whole_store', icon: '🏪', name: 'The Whole Store', unit: 'pct', dynamic: true,
    blurb: 'Share of the current team you have worked alongside. A new starter moves the goalposts.',
    stat: 'storeCoveragePct', need: [50, 75, 90, 100] },
  { code: 'full_crew', icon: '🚒', name: 'Full Crew', unit: 'count',
    blurb: 'Most colleagues overlapping a single one of your shifts.',
    stat: 'biggestCrewCount', need: [3, 5, 7, 10] },

  // ── Discipline & admin ─────────────────────────────────────────────────
  { code: 'breaks', icon: '☕', name: 'Break Taker', unit: 'count',
    blurb: 'Shifts where you took your full break.',
    stat: 'breaksFull', need: [25, 75, 150, 300] },
  { code: 'payslips', icon: '🧾', name: 'Paper Trail', unit: 'count',
    blurb: 'Payslips logged.',
    stat: 'payslipCount', need: [3, 12, 24, 36] },
  { code: 'taxman', icon: '🎩', name: 'Funding the Nation', unit: 'money',
    blurb: 'Income tax and National Insurance paid.',
    stat: 'lifetimeTax', need: [500, 2000, 5000, 10000] },
  { code: 'miles', icon: '🚗', name: 'Road Warrior', unit: 'miles',
    blurb: 'Miles driven to work.',
    stat: 'totalMiles', need: [100, 500, 1500, 3000] },
  { code: 'holidays', icon: '🏖️', name: 'Holiday Maker', unit: 'days',
    blurb: 'Days of leave taken.',
    stat: 'leaveDays', need: [5, 10, 20, 40] },
];

/** Flattens careerStats() into the scalar bag the thresholds compare against. */
function trophyValues(s) {
  return {
    totalShifts: s.totalShifts,
    totalHours: s.totalHours,
    totalPay: s.totalPay,
    totalMiles: s.totalMiles,
    daysEmployed: s.daysEmployed || 0,
    weekendShifts: s.weekendShifts,
    earlyStarts: s.earlyStarts,
    lateFinishes: s.lateFinishes,
    bankHolidayShifts: s.bankHolidayShifts,
    longestShiftHours: s.longestShift ? round1(paidHours(s.longestShift)) : 0,
    longestStreakDays: s.longestStreakDays,
    clockIns: s.clockIns,
    punctualCount: s.punctualCount,
    earlyBy10Count: s.earlyBy10Count,
    totalEarlyMins: s.totalEarlyMins,
    distinctColleagues: s.distinctColleagues,
    storeCoveragePct: s.storeCoveragePct,
    biggestCrewCount: s.biggestCrewDay.count,
    breaksFull: s.breaksFull,
    payslipCount: s.payslipCount,
    lifetimeTax: s.lifetimeTax,
    leaveDays: s.leaveDays,
  };
}

function formatValue(unit, v) {
  switch (unit) {
    case 'money': return '£' + Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 });
    case 'hours': return round1(v) + 'h';
    case 'miles': return round1(v) + ' mi';
    case 'days':  return round1(v) + (Math.abs(v) === 1 ? ' day' : ' days');
    case 'pct':   return round1(v) + '%';
    case 'mins':  return v >= 120 ? round1(v / 60) + 'h' : Math.round(v) + ' min';
    default:      return String(Math.round(v));
  }
}

router.get('/trophies', async (req, res) => {
  const bhDates = await bankHolidayDates();
  const stats = careerStats({ bankHolidayDates: bhDates });
  const values = trophyValues(stats);

  const unlocks = {};
  for (const row of db.prepare('SELECT * FROM v3_trophy_unlocks').all()) unlocks[row.code] = row.unlocked_at;
  const remember = db.prepare('INSERT OR IGNORE INTO v3_trophy_unlocks (code) VALUES (?)');

  let earnedTiers = 0, totalTiers = 0;
  const byTier = { bronze: 0, silver: 0, gold: 0, platinum: 0 };

  const families = FAMILIES.map(f => {
    const value = values[f.stat] || 0;

    const tiers = f.need.map((need, i) => {
      const tier = TIERS[i];
      const code = `${f.code}_${tier}`;
      const hit = value >= need;
      if (hit && !unlocks[code]) { remember.run(code); unlocks[code] = new Date().toISOString(); }
      const earned = hit || !!unlocks[code];
      totalTiers++;
      if (earned) { earnedTiers++; byTier[tier]++; }
      return {
        tier, label: TIER_LABEL[tier], code, need,
        need_label: formatValue(f.unit, need),
        earned,
        unlocked_at: unlocks[code] || null,
      };
    });

    const highest = [...tiers].reverse().find(t => t.earned) || null;
    const next = tiers.find(t => !t.earned) || null;
    // Progress is measured within the current tier band, so a bar near the end
    // means "nearly at the next medal", not "nearly at platinum".
    const bandFrom = next ? (TIERS.indexOf(next.tier) === 0 ? 0 : f.need[TIERS.indexOf(next.tier) - 1]) : 0;
    const bandPct = next
      ? Math.max(0, Math.min(100, ((value - bandFrom) / (next.need - bandFrom)) * 100))
      : 100;

    return {
      code: f.code, icon: f.icon, name: f.name, blurb: f.blurb, unit: f.unit,
      dynamic: !!f.dynamic,
      value: round1(value),
      value_label: formatValue(f.unit, value),
      tiers,
      earned_count: tiers.filter(t => t.earned).length,
      highest_tier: highest ? highest.tier : null,
      next_tier: next
        ? { tier: next.tier, label: next.label, need: next.need, need_label: next.need_label,
            remaining: round1(Math.max(0, next.need - value)),
            remaining_label: formatValue(f.unit, Math.max(0, next.need - value)) }
        : null,
      progress_pct: Math.round(bandPct * 10) / 10,
      complete: !next,
    };
  });

  // Complete families sink; the rest sort by how close the next medal is.
  const sorted = [...families].sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? 1 : -1;
    if (b.earned_count !== a.earned_count) return b.earned_count - a.earned_count;
    return b.progress_pct - a.progress_pct;
  });

  res.json({
    families: sorted,
    earned_tiers: earnedTiers,
    total_tiers: totalTiers,
    completion_pct: totalTiers ? Math.round((earnedTiers / totalTiers) * 1000) / 10 : 0,
    families_complete: families.filter(f => f.complete).length,
    family_count: families.length,
    by_tier: TIERS.map(tier => ({
      tier, label: TIER_LABEL[tier], earned: byTier[tier], total: FAMILIES.length,
    })),
    store: { active_colleagues: stats.activeColleagues, worked_with: stats.distinctColleagues },
    stats: values,
  });
});

module.exports = router;
