/* ─── 📖 Record Book (V3.0) ────────────────────────────────────────────────
   GET /api/v3/records

   Your personal hall of fame — every "most/longest/earliest" the shift history
   can answer, each one carrying the date it happened so you can go and look at
   the shift itself. Purely a different lens on existing rows; no new inputs.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, MONTHS, paidHours, shiftPay, toMins, fromMins, spanMins, round1, round2,
} = require('./helpers');
const { careerStats } = require('./stats');

const router = express.Router();

const shiftLabel = s => s ? `${s.start_time}–${s.end_time}` : null;

router.get('/records', (req, res) => {
  const s = careerStats();

  const rec = (icon, title, value, sub, date) => ({ icon, title, value, sub: sub || null, date: date || null });

  const records = [];

  if (s.longestShift) {
    records.push(rec('🥵', 'Longest shift', `${round1(paidHours(s.longestShift))}h`,
      shiftLabel(s.longestShift), s.longestShift.date));
  }
  if (s.shortestShift) {
    records.push(rec('🐁', 'Shortest shift', `${round1(paidHours(s.shortestShift))}h`,
      shiftLabel(s.shortestShift), s.shortestShift.date));
  }
  if (s.earliestStart) {
    records.push(rec('🌅', 'Earliest start', s.earliestStart.start_time,
      shiftLabel(s.earliestStart), s.earliestStart.date));
  }
  if (s.latestFinish) {
    const finish = toMins(s.latestFinish.start_time) + spanMins(s.latestFinish.start_time, s.latestFinish.end_time);
    records.push(rec('🌙', 'Latest finish', fromMins(finish),
      shiftLabel(s.latestFinish), s.latestFinish.date));
  }
  if (s.bestPaidShift) {
    records.push(rec('💷', 'Biggest single shift', `£${round2(shiftPay(s.bestPaidShift)).toFixed(2)}`,
      `${round1(paidHours(s.bestPaidShift))}h${s.bestPaidShift.is_bank_holiday ? ' · bank holiday (2×)' : ''}`,
      s.bestPaidShift.date));
  }
  if (s.bestWeekByHours) {
    records.push(rec('📅', 'Biggest week by hours', `${s.bestWeekByHours.hours}h`,
      `${s.bestWeekByHours.shifts} shifts`, s.bestWeekByHours.key));
  }
  if (s.bestWeekByPay) {
    records.push(rec('🤑', 'Biggest week by pay', `£${s.bestWeekByPay.pay.toFixed(2)}`,
      `${s.bestWeekByPay.hours}h across ${s.bestWeekByPay.shifts} shifts`, s.bestWeekByPay.key));
  }
  if (s.bestWeekByShifts) {
    records.push(rec('🏃', 'Most shifts in a week', `${s.bestWeekByShifts.shifts}`,
      `${s.bestWeekByShifts.hours}h total`, s.bestWeekByShifts.key));
  }
  if (s.bestMonthByHours) {
    const [y, m] = s.bestMonthByHours.key.split('-').map(Number);
    records.push(rec('📆', 'Biggest month by hours', `${s.bestMonthByHours.hours}h`,
      `${MONTHS[m - 1]} ${y} · ${s.bestMonthByHours.shifts} shifts`, s.bestMonthByHours.key + '-01'));
  }
  if (s.bestMonthByMiles) {
    const [y, m] = s.bestMonthByMiles.key.split('-').map(Number);
    records.push(rec('🛣️', 'Most miles in a month', `${s.bestMonthByMiles.miles} mi`,
      `${MONTHS[m - 1]} ${y}`, s.bestMonthByMiles.key + '-01'));
  }
  if (s.longestStreakDays > 0) {
    records.push(rec('🔁', 'Longest run of days worked', `${s.longestStreakDays} days`,
      'Consecutive dates with at least one shift'));
  }
  if (s.biggestCrewDay.date) {
    records.push(rec('🚒', 'Biggest crew in one day', `${s.biggestCrewDay.count} colleagues`,
      'Overlapping your shift', s.biggestCrewDay.date));
  }
  if (s.bestPayslip) {
    records.push(rec('🧾', 'Biggest payslip', `£${round2(s.bestPayslip.net_payment || 0).toFixed(2)} net`,
      `£${round2(s.bestPayslip.total_gross || 0).toFixed(2)} gross`, s.bestPayslip.month + '-01'));
  }
  if (s.firstShift) {
    records.push(rec('🌱', 'First ever shift', s.firstShift.date, shiftLabel(s.firstShift), s.firstShift.date));
  }

  // Favourite / least favourite day of the week
  const dowRanked = s.byDow
    .map((count, i) => ({ day: DAYS[i], count }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count);
  if (dowRanked.length) {
    records.push(rec('⭐', 'Most-worked day', dowRanked[0].day, `${dowRanked[0].count} shifts`));
    if (dowRanked.length > 1) {
      const last = dowRanked[dowRanked.length - 1];
      records.push(rec('🕊️', 'Least-worked day', last.day, `${last.count} shift${last.count === 1 ? '' : 's'}`));
    }
  }

  // Most common start time — the shift pattern you actually live on
  const startTally = {};
  for (const row of db.prepare('SELECT start_time FROM shifts WHERE completed = 1').all()) {
    startTally[row.start_time] = (startTally[row.start_time] || 0) + 1;
  }
  const topStart = Object.entries(startTally).sort((a, b) => b[1] - a[1])[0];
  if (topStart) {
    records.push(rec('🔂', 'Signature start time', topStart[0], `Used on ${topStart[1]} shifts`));
  }

  res.json({
    records,
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
      // Fun conversions — a mile of driving and an hour of standing up mean more
      // with something to compare them against.
      days_solid: s.totalHours > 0 ? round1(s.totalHours / 24) : 0,
      marathons: s.totalMiles > 0 ? round1(s.totalMiles / 26.2) : 0,
      full_weeks: s.totalHours > 0 ? round1(s.totalHours / 37.5) : 0,
    },
  });
});

module.exports = router;
