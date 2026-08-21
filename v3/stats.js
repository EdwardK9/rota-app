/* ─── V3.0 career stats ────────────────────────────────────────────────────
   One pass over the shift/clock/payslip history producing every number the
   Trophy Cabinet, Record Book and Shift DNA views want. Computed together
   because they'd otherwise each re-scan the same rows three times.
   ───────────────────────────────────────────────────────────────────────── */

const {
  db, getSetting, localDateStr, daysBetween, isWeekend, mondayOf, dowIndex,
  toMins, spanMins, overlapMins, paidHours, shiftPay, round1, round2,
} = require('./helpers');

/** Longest run of consecutive calendar dates in a sorted, de-duplicated list. */
function longestConsecutiveRun(dates) {
  let best = 0, run = 0, prev = null;
  for (const d of dates) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

function careerStats({ completedOnly = true } = {}) {
  const today = localDateStr();
  const all = db.prepare('SELECT * FROM shifts ORDER BY date ASC, start_time ASC').all();
  const shifts = completedOnly ? all.filter(s => s.completed) : all;

  const totalHours  = round1(shifts.reduce((t, s) => t + paidHours(s), 0));
  const totalPay    = round2(shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0));
  const totalMiles  = round1(shifts.reduce((t, s) => t + (s.distance_miles || 0), 0));

  // Per-shift extremes. Overnight finishes are stored as a smaller end_time than
  // start_time, so "latest finish" ranks them by span rather than clock value.
  let longestShift = null, shortestShift = null, earliestStart = null, latestFinish = null, bestPaidShift = null;
  for (const s of shifts) {
    const hrs = paidHours(s);
    if (!longestShift  || hrs > paidHours(longestShift))  longestShift  = s;
    if (!shortestShift || hrs < paidHours(shortestShift)) shortestShift = s;
    if (!earliestStart || toMins(s.start_time) < toMins(earliestStart.start_time)) earliestStart = s;
    const finishMins = toMins(s.start_time) + spanMins(s.start_time, s.end_time);
    if (!latestFinish || finishMins > toMins(latestFinish.start_time) + spanMins(latestFinish.start_time, latestFinish.end_time)) {
      latestFinish = s;
    }
    if (!bestPaidShift || (shiftPay(s) || 0) > (shiftPay(bestPaidShift) || 0)) bestPaidShift = s;
  }

  // Weekly / monthly aggregates
  const byWeek = {}, byMonth = {}, byDow = [0,0,0,0,0,0,0], byStartHour = {};
  for (const s of shifts) {
    const wk = mondayOf(s.date), mo = s.date.slice(0, 7);
    (byWeek[wk]  ||= { shifts: 0, hours: 0, pay: 0, miles: 0 });
    (byMonth[mo] ||= { shifts: 0, hours: 0, pay: 0, miles: 0 });
    for (const bucket of [byWeek[wk], byMonth[mo]]) {
      bucket.shifts += 1;
      bucket.hours  += paidHours(s);
      bucket.pay    += shiftPay(s) || 0;
      bucket.miles  += s.distance_miles || 0;
    }
    byDow[dowIndex(s.date)] += 1;
    const h = Math.floor(toMins(s.start_time) / 60);
    byStartHour[h] = (byStartHour[h] || 0) + 1;
  }
  const topBy = (obj, key) => Object.entries(obj)
    .map(([k, v]) => ({ key: k, ...v, hours: round1(v.hours), pay: round2(v.pay), miles: round1(v.miles) }))
    .sort((a, b) => b[key] - a[key])[0] || null;

  const workedDates = [...new Set(shifts.map(s => s.date))].sort();
  const longestStreakDays = longestConsecutiveRun(workedDates);

  // Colleagues actually shared a shift with (home store only, real shifts only)
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all();
  const colByDate = {};
  for (const cs of colShifts) (colByDate[cs.date] ||= []).push(cs);
  const colleagueIds = new Set();
  let biggestCrewDay = { date: null, count: 0 };
  for (const s of shifts) {
    const sameDay = colByDate[s.date] || [];
    const crew = new Set();
    for (const cs of sameDay) {
      if (overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0) {
        colleagueIds.add(cs.colleague_id);
        crew.add(cs.colleague_id);
      }
    }
    if (crew.size > biggestCrewDay.count) biggestCrewDay = { date: s.date, count: crew.size };
  }

  // Breaks
  const breaksSkipped = shifts.filter(s => s.break_taken === 'none').length;
  const breaksPartial = shifts.filter(s => s.break_taken === 'partial').length;
  const breaksFull    = shifts.filter(s => s.break_taken === 'full').length;

  // Clock-ins
  const clockRows = db.prepare(`
    SELECT ce.date, ce.clocked_in, ce.clocked_out, MIN(s.start_time) AS start_time
    FROM clock_entries ce JOIN shifts s ON s.date = ce.date
    WHERE ce.clocked_in IS NOT NULL GROUP BY ce.date
  `).all();
  const punctualCount = clockRows.filter(r => toMins(r.clocked_in) <= toMins(r.start_time) + 5).length;

  // Payslips & leave
  const payslips = db.prepare('SELECT * FROM payslips').all();
  const lifetimeGross = round2(payslips.reduce((t, p) => t + (p.total_gross || 0), 0));
  const lifetimeNet   = round2(payslips.reduce((t, p) => t + (p.net_payment || 0), 0));
  const lifetimeTax   = round2(payslips.reduce((t, p) => t + (p.tax_paid || 0) + (p.ni_employee || 0), 0));
  const bestPayslip   = payslips.slice().sort((a, b) => (b.net_payment || 0) - (a.net_payment || 0))[0] || null;

  const leaveRows = db.prepare('SELECT * FROM leave_entries').all();
  const leaveDays = round1(leaveRows.reduce((t, l) => t + (l.days_taken || 0), 0));

  const jobStart = getSetting('job_start_date', null);
  const daysEmployed = jobStart ? Math.max(0, daysBetween(jobStart, today)) : null;

  return {
    today, jobStart, daysEmployed,
    totalShifts: shifts.length,
    scheduledShifts: all.length,
    totalHours, totalPay, totalMiles,
    weekendShifts: shifts.filter(s => isWeekend(s.date)).length,
    bankHolidayShifts: shifts.filter(s => s.is_bank_holiday).length,
    earlyStarts: shifts.filter(s => toMins(s.start_time) <= 7 * 60).length,
    lateFinishes: shifts.filter(s => toMins(s.start_time) + spanMins(s.start_time, s.end_time) >= 20 * 60).length,
    longestShift, shortestShift, earliestStart, latestFinish, bestPaidShift,
    bestWeekByHours: topBy(byWeek, 'hours'),
    bestWeekByPay:   topBy(byWeek, 'pay'),
    bestWeekByShifts:topBy(byWeek, 'shifts'),
    bestMonthByHours:topBy(byMonth, 'hours'),
    bestMonthByPay:  topBy(byMonth, 'pay'),
    bestMonthByMiles:topBy(byMonth, 'miles'),
    longestStreakDays,
    distinctColleagues: colleagueIds.size,
    biggestCrewDay,
    breaksFull, breaksPartial, breaksSkipped,
    clockIns: clockRows.length,
    punctualCount,
    payslipCount: payslips.length,
    lifetimeGross, lifetimeNet, lifetimeTax, bestPayslip,
    leaveDays, leaveEntries: leaveRows.length,
    byDow, byStartHour, byWeek, byMonth,
    firstShift: shifts[0] || null,
    lastShift: shifts[shifts.length - 1] || null,
  };
}

module.exports = { careerStats, longestConsecutiveRun };
