/* ─── V3.0 career stats ────────────────────────────────────────────────────
   One pass over the shift/clock/payslip history producing every number the
   Trophy Cabinet, Record Book and Shift DNA views want. Computed together
   because they'd otherwise each re-scan the same rows three times.

   Two rules worth knowing:

   • "Worked" means a logged shift in the past, not a shift ticked complete.
     Streaks and totals used to filter on completed = 1, which quietly undercounts
     for anyone who doesn't tick every shift off — a run of eight days would show
     as six because two in the middle were never marked.

   • Bank holidays are matched against the real gov.uk calendar as well as the
     is_bank_holiday flag, since the flag is only filled in on some paths.
   ───────────────────────────────────────────────────────────────────────── */

const {
  db, getSetting, localDateStr, daysBetween, isWeekend, mondayOf, dowIndex,
  toMins, spanMins, overlapMins, paidHours, shiftPay, round1, round2,
} = require('./helpers');

/** Longest run of consecutive calendar dates in a sorted, de-duplicated list.
 *  Also returns the run itself, so the Record Book can show which dates. */
function longestConsecutiveRun(dates) {
  let best = 0, run = 0, prev = null, bestEnd = null, end = null;
  for (const d of dates) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    end = d;
    if (run > best) { best = run; bestEnd = end; }
    prev = d;
  }
  return { length: best, end: bestEnd };
}

/** Every run of N or more consecutive days, longest first. */
function allRuns(dates) {
  const runs = [];
  let start = null, prev = null;
  for (const d of dates) {
    if (prev && daysBetween(prev, d) === 1) { prev = d; continue; }
    if (start) runs.push({ start, end: prev, length: daysBetween(start, prev) + 1 });
    start = d; prev = d;
  }
  if (start) runs.push({ start, end: prev, length: daysBetween(start, prev) + 1 });
  return runs.sort((a, b) => b.length - a.length || b.start.localeCompare(a.start));
}

function careerStats({ bankHolidayDates = new Set() } = {}) {
  const today = localDateStr();
  const all = db.prepare('SELECT * FROM shifts ORDER BY date ASC, start_time ASC').all();
  // Past + today only: a shift booked for next week hasn't been worked yet.
  const shifts = all.filter(s => s.date <= today);

  const totalHours  = round1(shifts.reduce((t, s) => t + paidHours(s), 0));
  const totalPay    = round2(shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0));
  const totalMiles  = round1(shifts.reduce((t, s) => t + (s.distance_miles || 0), 0));

  const isBH = s => !!s.is_bank_holiday || bankHolidayDates.has(s.date);

  // Per-shift extremes. Overnight finishes are stored as a smaller end_time than
  // start_time, so "latest finish" ranks them by span rather than clock value.
  const finishMinsOf = s => toMins(s.start_time) + spanMins(s.start_time, s.end_time);
  let longestShift = null, shortestShift = null, earliestStart = null, latestFinish = null, bestPaidShift = null;
  const shiftHoursByMonth = {};
  for (const s of shifts) {
    const hrs = paidHours(s);
    if (!longestShift  || hrs > paidHours(longestShift))  longestShift  = s;
    if (!shortestShift || hrs < paidHours(shortestShift)) shortestShift = s;
    if (!earliestStart || toMins(s.start_time) < toMins(earliestStart.start_time)) earliestStart = s;
    if (!latestFinish || finishMinsOf(s) > finishMinsOf(latestFinish)) latestFinish = s;
    if (!bestPaidShift || (shiftPay(s) || 0) > (shiftPay(bestPaidShift) || 0)) bestPaidShift = s;
    const shMo = s.date.slice(0, 7);
    if (!shiftHoursByMonth[shMo] || hrs > shiftHoursByMonth[shMo]) shiftHoursByMonth[shMo] = hrs;
  }
  const longestShiftHoursThisMonth = round1(shiftHoursByMonth[today.slice(0, 7)] || 0);

  // Weekly / monthly aggregates
  const byWeek = {}, byMonth = {}, byDow = [0, 0, 0, 0, 0, 0, 0], byStartHour = {};
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
    byStartHour[Math.floor(toMins(s.start_time) / 60)] = (byStartHour[Math.floor(toMins(s.start_time) / 60)] || 0) + 1;
  }
  const topBy = (obj, key) => Object.entries(obj)
    .map(([k, v]) => ({ key: k, ...v, hours: round1(v.hours), pay: round2(v.pay), miles: round1(v.miles) }))
    .sort((a, b) => b[key] - a[key])[0] || null;

  const workedDates = [...new Set(shifts.map(s => s.date))].sort();
  const streak = longestConsecutiveRun(workedDates);
  const runs = allRuns(workedDates);

  // Colleagues actually shared a shift with (home store only, real shifts only)
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all();
  const colByDate = {};
  for (const cs of colShifts) (colByDate[cs.date] ||= []).push(cs);
  const colleagueIds = new Set();
  let biggestCrewDay = { date: null, count: 0 };
  const crewByMonth = {};
  for (const s of shifts) {
    const crew = new Set();
    for (const cs of colByDate[s.date] || []) {
      if (overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0) {
        colleagueIds.add(cs.colleague_id);
        crew.add(cs.colleague_id);
      }
    }
    if (crew.size > biggestCrewDay.count) biggestCrewDay = { date: s.date, count: crew.size };
    const crMo = s.date.slice(0, 7);
    if (!crewByMonth[crMo] || crew.size > crewByMonth[crMo]) crewByMonth[crMo] = crew.size;
  }
  const biggestCrewThisMonth = crewByMonth[today.slice(0, 7)] || 0;

  // Store size, for the "worked with everyone" trophy. Counts colleagues who
  // haven't left, so a new starter genuinely moves the goalposts.
  const activeColleagues = db.prepare(
    "SELECT COUNT(*) AS c FROM colleagues WHERE left_date IS NULL OR left_date = ''"
  ).get().c;
  const storeCoveragePct = activeColleagues > 0
    ? round1((Math.min(colleagueIds.size, activeColleagues) / activeColleagues) * 100) : 0;

  // Breaks
  const breaksSkipped = shifts.filter(s => s.break_taken === 'none').length;
  const breaksPartial = shifts.filter(s => s.break_taken === 'partial').length;
  const breaksFull    = shifts.filter(s => s.break_taken === 'full').length;

  // ── Clock-ins ────────────────────────────────────────────────────────────
  // Joined to the shift so "early" means early against the shift you were on.
  const clockRows = db.prepare(`
    SELECT ce.date, ce.clocked_in, ce.clocked_out,
           MIN(s.start_time) AS start_time, MAX(s.end_time) AS end_time
    FROM clock_entries ce JOIN shifts s ON s.date = ce.date
    WHERE ce.clocked_in IS NOT NULL
    GROUP BY ce.date
  `).all();

  let punctualCount = 0, earlyBy10Count = 0, totalEarlyMins = 0, totalLateMins = 0;
  let punctualOutCount = 0, lateOutBy10Count = 0;
  let earliestClockIn = null, biggestEarly = null, biggestLate = null, longestOnSite = null;
  const clockDetail = [];
  for (const r of clockRows) {
    const diff = toMins(r.start_time) - toMins(r.clocked_in);   // +ve = early
    if (diff >= -5) punctualCount++;
    if (diff >= 10) earlyBy10Count++;
    if (diff > 0) totalEarlyMins += diff; else totalLateMins += -diff;

    if (!earliestClockIn || toMins(r.clocked_in) < toMins(earliestClockIn.clocked_in)) earliestClockIn = r;
    if (!biggestEarly || diff > biggestEarly.diff) biggestEarly = { ...r, diff };
    if (!biggestLate  || diff < biggestLate.diff)  biggestLate  = { ...r, diff };

    // Actual time on site, which can beat the scheduled shift length
    if (r.clocked_out) {
      let mins = toMins(r.clocked_out) - toMins(r.clocked_in);
      if (mins < 0) mins += 1440;
      if (!longestOnSite || mins > longestOnSite.mins) longestOnSite = { ...r, mins };
      clockDetail.push({ date: r.date, mins, diff });

      // Mirrors the arrival grace: leaving at or after your end time (or up to
      // 5 minutes before it) counts as seeing the shift through.
      const diffOut = toMins(r.clocked_out) - toMins(r.end_time);
      if (diffOut >= -5) punctualOutCount++;
      // Mirrors Keen Bean's early-by-10 bar, but for staying past the end time.
      if (diffOut >= 10) lateOutBy10Count++;
    }
  }

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
    shifts,                                  // the working set, for tie lookups
    totalShifts: shifts.length,
    scheduledShifts: all.length,
    totalHours, totalPay, totalMiles,
    weekendShifts: shifts.filter(s => isWeekend(s.date)).length,
    bankHolidayShifts: shifts.filter(isBH).length,
    bankHolidayList: shifts.filter(isBH).map(s => s.date),
    earlyStarts: shifts.filter(s => toMins(s.start_time) <= 7 * 60).length,
    // 19:00, not 20:00 — the store now closes at 19:15, so nothing finishes as
    // late as the old 8pm bar any more.
    lateFinishes: shifts.filter(s => finishMinsOf(s) >= 19 * 60).length,
    longestShift, shortestShift, earliestStart, latestFinish, bestPaidShift,
    longestShiftHoursThisMonth,
    bestWeekByHours:  topBy(byWeek, 'hours'),
    bestWeekByPay:    topBy(byWeek, 'pay'),
    bestWeekByShifts: topBy(byWeek, 'shifts'),
    bestMonthByHours: topBy(byMonth, 'hours'),
    bestMonthByPay:   topBy(byMonth, 'pay'),
    bestMonthByMiles: topBy(byMonth, 'miles'),
    longestStreakDays: streak.length,
    longestStreakEnd: streak.end,
    runs,
    distinctColleagues: colleagueIds.size,
    activeColleagues, storeCoveragePct,
    biggestCrewDay, biggestCrewThisMonth,
    breaksFull, breaksPartial, breaksSkipped,
    clockIns: clockRows.length,
    clockRows,
    punctualCount, punctualOutCount, earlyBy10Count, lateOutBy10Count,
    totalEarlyMins: Math.round(totalEarlyMins),
    totalLateMins: Math.round(totalLateMins),
    earliestClockIn, biggestEarly, biggestLate, longestOnSite,
    payslipCount: payslips.length,
    lifetimeGross, lifetimeNet, lifetimeTax, bestPayslip,
    leaveDays, leaveEntries: leaveRows.length,
    byDow, byStartHour, byWeek, byMonth,
    firstShift: shifts[0] || null,
    lastShift: shifts[shifts.length - 1] || null,
  };
}

module.exports = { careerStats, longestConsecutiveRun };
