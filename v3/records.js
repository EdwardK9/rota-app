/* ─── 📖 Record Book (V3.0) ────────────────────────────────────────────────
   GET /api/v3/records

   Your personal hall of fame. Two things matter beyond the headline number:

   • Ties. Plenty of records are shared by dozens of shifts — a 7.5h shift is
     hardly rare. Each record therefore carries every entry that equals it, so
     the client can expand "×14" into the actual list instead of implying the
     one date it happened to pick is special.

   • Clock records. Scheduled times are what you were asked to do; clock-ins are
     what actually happened. Time on site, earliest clock-in and the biggest
     early/late swings all come from clock_entries, not the rota.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, MONTHS, paidHours, shiftPay, toMins, fromMins, spanMins, round1, round2,
} = require('./helpers');
const { careerStats } = require('./stats');
const { bankHolidayDates } = require('./bankHolidays');

const router = express.Router();

const shiftLabel = s => (s ? `${s.start_time}–${s.end_time}` : null);
const hhmm = mins => `${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`;

/** Everything in `items` whose score ties the best one, most recent first.
 *  `score` must return a number; ties are compared to 2dp to dodge float noise. */
function tiedWith(items, score, best) {
  if (best == null) return [];
  const key = n => Math.round(n * 100);
  return items.filter(i => key(score(i)) === key(best)).sort((a, b) => b.date.localeCompare(a.date));
}

router.get('/records', async (req, res) => {
  const bhDates = await bankHolidayDates();
  const s = careerStats({ bankHolidayDates: bhDates });
  const shifts = s.shifts;

  const records = [];
  /** matches: every entry sharing this record, for the expandable list. */
  const rec = (icon, title, value, sub, date, matches = [], group = 'shifts') => {
    // With ties, show the most recent one — it's the more interesting of a
    // hundred identical shifts, and it matches the order the expanded list uses.
    const headline = matches.length > 1 ? matches[0].date : (date || null);
    records.push({
      icon, title, value, sub: sub || null, date: headline, group,
      matches: matches.slice(0, 100).map(m => ({
        date: m.date,
        detail: m.detail,
        day: DAYS[new Date(m.date + 'T12:00:00').getDay()].slice(0, 3),
      })),
      count: matches.length,
    });
  };

  // ── Shift records ────────────────────────────────────────────────────────
  if (s.longestShift) {
    const best = paidHours(s.longestShift);
    rec('🥵', 'Longest shift', `${round1(best)}h`, shiftLabel(s.longestShift), s.longestShift.date,
      tiedWith(shifts, paidHours, best).map(x => ({ date: x.date, detail: `${shiftLabel(x)} · ${fmtMoney(shiftPay(x))}` })));
  }
  if (s.shortestShift) {
    const best = paidHours(s.shortestShift);
    rec('🐁', 'Shortest shift', `${round1(best)}h`, shiftLabel(s.shortestShift), s.shortestShift.date,
      tiedWith(shifts, paidHours, best).map(x => ({ date: x.date, detail: shiftLabel(x) })));
  }
  if (s.earliestStart) {
    const best = toMins(s.earliestStart.start_time);
    rec('🌅', 'Earliest start', s.earliestStart.start_time, shiftLabel(s.earliestStart), s.earliestStart.date,
      tiedWith(shifts, x => toMins(x.start_time), best).map(x => ({ date: x.date, detail: shiftLabel(x) })));
  }
  if (s.latestFinish) {
    const finishOf = x => toMins(x.start_time) + spanMins(x.start_time, x.end_time);
    const best = finishOf(s.latestFinish);
    rec('🌙', 'Latest finish', fromMins(best), shiftLabel(s.latestFinish), s.latestFinish.date,
      tiedWith(shifts, finishOf, best).map(x => ({ date: x.date, detail: shiftLabel(x) })));
  }
  if (s.bestPaidShift) {
    const best = shiftPay(s.bestPaidShift) || 0;
    rec('💷', 'Biggest single shift', fmtMoney(best),
      `${round1(paidHours(s.bestPaidShift))}h${s.bestPaidShift.is_bank_holiday ? ' · bank holiday (2×)' : ''}`,
      s.bestPaidShift.date,
      tiedWith(shifts, x => shiftPay(x) || 0, best).map(x => ({ date: x.date, detail: `${shiftLabel(x)} · ${round1(paidHours(x))}h` })));
  }

  // ── Clock records — what actually happened, not what was scheduled ───────
  if (s.longestOnSite) {
    const rows = s.clockRows.filter(r => r.clocked_out);
    const onSite = r => { let m = toMins(r.clocked_out) - toMins(r.clocked_in); if (m < 0) m += 1440; return m; };
    rec('⏱️', 'Longest time on site', hhmm(s.longestOnSite.mins),
      `Clocked ${s.longestOnSite.clocked_in} → ${s.longestOnSite.clocked_out}`, s.longestOnSite.date,
      tiedWith(rows, onSite, s.longestOnSite.mins).map(r => ({ date: r.date, detail: `${r.clocked_in} → ${r.clocked_out}` })),
      'clock');
  }
  if (s.earliestClockIn) {
    const best = toMins(s.earliestClockIn.clocked_in);
    rec('🌄', 'Earliest clock-in', s.earliestClockIn.clocked_in,
      `Shift started ${s.earliestClockIn.start_time}`, s.earliestClockIn.date,
      tiedWith(s.clockRows, r => toMins(r.clocked_in), best).map(r => ({ date: r.date, detail: `in ${r.clocked_in}, shift ${r.start_time}` })),
      'clock');
  }
  if (s.biggestEarly && s.biggestEarly.diff > 0) {
    const diffOf = r => toMins(r.start_time) - toMins(r.clocked_in);
    rec('🐦', 'Keenest clock-in', `${s.biggestEarly.diff} min early`,
      `In at ${s.biggestEarly.clocked_in} for a ${s.biggestEarly.start_time} start`, s.biggestEarly.date,
      tiedWith(s.clockRows, diffOf, s.biggestEarly.diff).map(r => ({ date: r.date, detail: `in ${r.clocked_in}, shift ${r.start_time}` })),
      'clock');
  }
  if (s.biggestLate && s.biggestLate.diff < 0) {
    const diffOf = r => toMins(r.start_time) - toMins(r.clocked_in);
    rec('😬', 'Latest clock-in', `${Math.abs(s.biggestLate.diff)} min late`,
      `In at ${s.biggestLate.clocked_in} for a ${s.biggestLate.start_time} start`, s.biggestLate.date,
      tiedWith(s.clockRows, diffOf, s.biggestLate.diff).map(r => ({ date: r.date, detail: `in ${r.clocked_in}, shift ${r.start_time}` })),
      'clock');
  }
  if (s.totalEarlyMins > 0) {
    rec('⏳', 'Total time clocked in early', hhmm(s.totalEarlyMins),
      `Across ${s.clockIns} clock-ins`, null, [], 'clock');
  }
  if (s.totalLateMins > 0) {
    rec('⏰', 'Total time clocked in late', hhmm(s.totalLateMins),
      `Across ${s.clockIns} clock-ins`, null, [], 'clock');
  }

  // ── Streaks & spans ──────────────────────────────────────────────────────
  if (s.longestStreakDays > 0) {
    const best = s.runs.filter(r => r.length === s.longestStreakDays);
    rec('🔁', 'Longest run of days worked', `${s.longestStreakDays} days`,
      'Consecutive dates with at least one shift', best[0] ? best[0].end : null,
      best.map(r => ({ date: r.end, detail: `${r.start} → ${r.end}` })), 'spans');
  }
  if (s.bestWeekByHours) {
    rec('📅', 'Biggest week by hours', `${s.bestWeekByHours.hours}h`,
      `${s.bestWeekByHours.shifts} shifts`, s.bestWeekByHours.key, [], 'spans');
  }
  if (s.bestWeekByPay) {
    rec('🤑', 'Biggest week by pay', fmtMoney(s.bestWeekByPay.pay),
      `${s.bestWeekByPay.hours}h across ${s.bestWeekByPay.shifts} shifts`, s.bestWeekByPay.key, [], 'spans');
  }
  if (s.bestWeekByShifts) {
    rec('🏃', 'Most shifts in a week', `${s.bestWeekByShifts.shifts}`,
      `${s.bestWeekByShifts.hours}h total`, s.bestWeekByShifts.key, [], 'spans');
  }
  if (s.bestMonthByHours) {
    const [y, m] = s.bestMonthByHours.key.split('-').map(Number);
    rec('📆', 'Biggest month by hours', `${s.bestMonthByHours.hours}h`,
      `${MONTHS[m - 1]} ${y} · ${s.bestMonthByHours.shifts} shifts`, s.bestMonthByHours.key + '-01', [], 'spans');
  }
  if (s.bestMonthByMiles) {
    const [y, m] = s.bestMonthByMiles.key.split('-').map(Number);
    rec('🛣️', 'Most miles in a month', `${s.bestMonthByMiles.miles} mi`, `${MONTHS[m - 1]} ${y}`,
      s.bestMonthByMiles.key + '-01', [], 'spans');
  }

  // ── People & firsts ──────────────────────────────────────────────────────
  if (s.biggestCrewDay.date) {
    rec('🚒', 'Biggest crew in one day', `${s.biggestCrewDay.count} colleagues`,
      'Overlapping your shift', s.biggestCrewDay.date, [], 'people');
  }
  if (s.bestPayslip) {
    rec('🧾', 'Biggest payslip', `${fmtMoney(s.bestPayslip.net_payment || 0)} net`,
      `${fmtMoney(s.bestPayslip.total_gross || 0)} gross`, s.bestPayslip.month + '-01', [], 'people');
  }
  if (s.firstShift) {
    rec('🌱', 'First ever shift', s.firstShift.date, shiftLabel(s.firstShift), s.firstShift.date, [], 'people');
  }

  const dowRanked = s.byDow.map((count, i) => ({ day: DAYS[i], count })).filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count);
  if (dowRanked.length) {
    rec('⭐', 'Most-worked day', dowRanked[0].day, `${dowRanked[0].count} shifts`, null, [], 'people');
    if (dowRanked.length > 1) {
      const last = dowRanked[dowRanked.length - 1];
      rec('🕊️', 'Least-worked day', last.day, `${last.count} shift${last.count === 1 ? '' : 's'}`, null, [], 'people');
    }
  }

  const startTally = {};
  for (const x of shifts) startTally[x.start_time] = (startTally[x.start_time] || 0) + 1;
  const topStart = Object.entries(startTally).sort((a, b) => b[1] - a[1])[0];
  if (topStart) {
    rec('🔂', 'Signature start time', topStart[0], `Used on ${topStart[1]} shifts`, null, [], 'people');
  }

  res.json({
    records,
    groups: [
      { key: 'shifts', label: '🥇 Shift records' },
      { key: 'clock',  label: '🕐 Clock in & out' },
      { key: 'spans',  label: '📆 Weeks, months & streaks' },
      { key: 'people', label: '👥 People & firsts' },
    ],
    lifetime: {
      shifts: s.totalShifts,
      hours: s.totalHours,
      pay: s.totalPay,
      miles: s.totalMiles,
      gross: s.lifetimeGross,
      net: s.lifetimeNet,
      tax_and_ni: s.lifetimeTax,
      days_employed: s.daysEmployed,
      leave_days: s.leaveDays,
      colleagues: s.distinctColleagues,
      bank_holidays: s.bankHolidayShifts,
      days_solid: s.totalHours > 0 ? round1(s.totalHours / 24) : 0,
      marathons: s.totalMiles > 0 ? round1(s.totalMiles / 26.2) : 0,
      full_weeks: s.totalHours > 0 ? round1(s.totalHours / 37.5) : 0,
    },
  });
});

function fmtMoney(v) { return '£' + round2(v || 0).toFixed(2); }

module.exports = router;
