/* ─── 🏆 Trophy Cabinet (V3.0) ─────────────────────────────────────────────
   GET /api/v3/trophies

   Achievements unlocked purely from data the app already holds — nothing to
   opt into, nothing to tick off by hand.

   Every trophy is a *family* with four tiers (bronze → platinum) rather than a
   one-shot award, so a single line here is worth four unlocks and there is
   always a next target rather than a wall of finished cards.

   Thresholds are calibrated against a real retail rota — a "long shift" is 8
   paid hours, not 12 — because a target nobody can physically reach isn't an
   achievement, it's a bug.

   `monthly` families measure the current calendar month rather than a
   lifetime total, so their headline value can go back down on the 1st — but
   any medal already won stays won (see the unlock table below).

   Once all four medals in a family are won, `capped` decides what happens
   next: capped families (a hard physical ceiling — a shift can only be so
   long) just sit at platinum; everything else keeps issuing further
   "Platinum ×N" targets forever, so a card never goes stale.

   Unlock dates are persisted per tier (v3_trophy_unlocks), so a trophy stays
   won even if the underlying stat later dips.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, round1 } = require('./helpers');
const { careerStats } = require('./stats');
const { bankHolidayDates } = require('./bankHolidays');
require('./schema');

const router = express.Router();

const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

/* stat    — key into the computed stat bag
   need    — [bronze, silver, gold, platinum] thresholds
   unit    — how the value reads ('count' | 'hours' | 'money' | 'miles' | 'mins' | 'days')
   monthly — the underlying stat is a "this calendar month" value rather than a
             lifetime total, so it can go back down — medals already earned still
             stay earned (see the unlock table), but the headline value resets.
   capped  — the stat has a real physical ceiling (a shift can only be so long,
             a crew can only be so big), so there's no "platinum ×2" rollover.  */
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
    blurb: 'Shifts finishing at or after 19:00.',
    stat: 'lateFinishes', need: [5, 25, 75, 150] },
  { code: 'bank_holidays', icon: '🎆', name: 'Someone Has to Do It', unit: 'count',
    blurb: 'Bank holidays worked — matched against the real calendar, not just the double-pay flag.',
    stat: 'bankHolidayShifts', need: [1, 3, 6, 12] },
  { code: 'long_shift', icon: '🥵', name: 'The Long Haul', unit: 'hours', monthly: true, capped: true,
    blurb: 'Your longest single shift this month, in paid hours. Resets on the 1st — every month is a fresh shot at it.',
    stat: 'longestShiftHoursThisMonth', need: [5, 6, 7, 8] },
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
  { code: 'stays_late', icon: '🚪', name: 'Sees It Through', unit: 'count',
    blurb: 'Clock-outs at or after your shift end time, with five minutes grace.',
    stat: 'punctualOutCount', need: [10, 50, 150, 300] },
  { code: 'keen_bean', icon: '🐦', name: 'Keen Bean', unit: 'count',
    blurb: 'Clock-ins a full 10 minutes or more before your shift started.',
    stat: 'earlyBy10Count', need: [5, 20, 50, 100] },
  { code: 'banked_early', icon: '⏳', name: 'Time Donated', unit: 'mins',
    blurb: 'Every minute you have ever clocked in early, added up.',
    stat: 'totalEarlyMins', need: [60, 300, 900, 1800] },

  // ── People ─────────────────────────────────────────────────────────────
  { code: 'crew_month', icon: '👥', name: 'Most Colleagues on a Shift', unit: 'count', monthly: true, capped: true,
    blurb: 'Most colleagues sharing a single shift with you this month. Resets on the 1st — a small team means this is always close.',
    stat: 'biggestCrewThisMonth', need: [3, 5, 7, 10] },

  // ── Discipline & admin ─────────────────────────────────────────────────
  { code: 'breaks', icon: '☕', name: 'Break Taker', unit: 'count',
    blurb: 'Shifts where you took your full break.',
    stat: 'breaksFull', need: [25, 75, 150, 300] },
  { code: 'no_break', icon: '⚡', name: 'No Time to Stop', unit: 'count',
    blurb: 'Shifts where you skipped your break entirely.',
    stat: 'breaksSkipped', need: [10, 30, 75, 150] },
  { code: 'payslips', icon: '🧾', name: 'Paper Trail', unit: 'count',
    blurb: 'Payslips logged.',
    stat: 'payslipCount', need: [3, 12, 24, 36] },
  { code: 'taxman', icon: '🎩', name: 'Funding the Nation', unit: 'money',
    blurb: 'Income tax and National Insurance paid.',
    stat: 'lifetimeTax', need: [100, 300, 600, 1000] },
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
    longestShiftHoursThisMonth: s.longestShiftHoursThisMonth,
    longestStreakDays: s.longestStreakDays,
    clockIns: s.clockIns,
    punctualCount: s.punctualCount,
    punctualOutCount: s.punctualOutCount,
    earlyBy10Count: s.earlyBy10Count,
    totalEarlyMins: s.totalEarlyMins,
    biggestCrewThisMonth: s.biggestCrewThisMonth,
    breaksFull: s.breaksFull,
    breaksSkipped: s.breaksSkipped,
    payslipCount: s.payslipCount,
    lifetimeTax: s.lifetimeTax,
    leaveDays: s.leaveDays,
  };
}

// Rounds *down* to one decimal place. Displayed values must never round up
// past a medal's threshold — 4.97h showing as "5h" made Time Donated look
// like silver (5h) was already earned when it wasn't.
const floor1 = v => Math.floor(v * 10) / 10;

function formatValue(unit, v) {
  switch (unit) {
    case 'money': return '£' + Math.floor(v).toLocaleString('en-GB');
    case 'hours': return floor1(v) + 'h';
    case 'miles': return floor1(v) + ' mi';
    case 'days':  return floor1(v) + (Math.abs(v) === 1 ? ' day' : ' days');
    case 'mins':  return v >= 120 ? floor1(v / 60) + 'h' : Math.floor(v) + ' min';
    default:      return String(Math.floor(v));
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
    let next = tiers.find(t => !t.earned) || null;
    // Progress is measured within the current tier band, so a bar near the end
    // means "nearly at the next medal", not "nearly at platinum".
    let bandFrom = next ? (TIERS.indexOf(next.tier) === 0 ? 0 : f.need[TIERS.indexOf(next.tier) - 1]) : 0;

    // All four medals are already in the cabinet. For anything without a hard
    // physical ceiling, that's not the end — keep issuing further platinum
    // targets (each one another step of the gold→platinum gap) so there's
    // always something to chase, rather than the card going stale forever.
    let platinumLevel = 0;
    if (!next && !f.capped) {
      const increment = Math.max(1, f.need[3] - f.need[2]);
      let lvl = 0;
      while (true) {
        lvl++;
        const code = `${f.code}_platinum_${lvl}`;
        const need = f.need[3] + lvl * increment;
        const hit = value >= need;
        if (hit && !unlocks[code]) { remember.run(code); unlocks[code] = new Date().toISOString(); }
        if (hit || unlocks[code]) { platinumLevel = lvl; continue; }
        next = {
          tier: 'platinum', label: `Platinum ×${lvl + 1}`, code, need,
          need_label: formatValue(f.unit, need), earned: false, unlocked_at: null,
        };
        bandFrom = f.need[3] + (lvl - 1) * increment;
        break;
      }
    }

    const bandPct = next
      ? Math.max(0, Math.min(100, ((value - bandFrom) / (next.need - bandFrom)) * 100))
      : 100;

    return {
      code: f.code, icon: f.icon, name: f.name, blurb: f.blurb, unit: f.unit,
      dynamic: !!f.dynamic, monthly: !!f.monthly,
      value: round1(value),
      value_label: formatValue(f.unit, value),
      tiers,
      earned_count: tiers.filter(t => t.earned).length,
      highest_tier: highest ? highest.tier : null,
      platinum_level: platinumLevel,
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
    stats: values,
  });
});

module.exports = router;
