/* ─── 🏖️ Leave Optimiser (V3.0) ───────────────────────────────────────────
   GET /api/v3/leave-planner[?from=YYYY-MM-DD&to=YYYY-MM-DD&max_span=N]

   Which annual-leave days buy the most time off. A leave day spent on a day you
   were rostered anyway is worth far more than one spent next to a rest day, and
   a day that bridges two rest days (or a bank holiday) can turn one booked day
   into four away from the store. This finds those, ranks them by days-off per
   day-booked, and shows the working out.

   The honest bit: the rota is only published a couple of weeks ahead, so past
   the last rostered shift there is nothing to optimise against. Rather than
   stopping there — which would make the view useless for planning Christmas in
   August — days beyond that horizon are classed from your own pattern (how
   often you actually work each weekday) and clearly labelled as a prediction.
   Every candidate carries the split, so a plan built on guesses can't pass
   itself off as one built on the published rota.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, getNumSetting, localDateStr, addDays, daysBetween, dowIndex,
  paidHours, shiftPay, round1, round2, pct,
} = require('./helpers');
const { bankHolidayList } = require('./bankHolidays');
const { leaveSummary } = require('./leaveYear');

const router = express.Router();

/* How far past the requested window to keep classifying days. A break that runs
   over the end of the window still has to be measured to its real end, or the
   last candidate in the list looks worse than it is. */
const TAIL_DAYS = 21;
/* Weeks of history the weekday pattern is built from. A year is enough to cover
   seasonal shape without half of it being a contract you no longer work. */
const PATTERN_WEEKS = 52;

/** Every date covered by a leave entry in the window, whatever the leave type —
 *  for this purpose sick and unpaid are just as "already not at work" as annual,
 *  they simply don't cost anything more to book. */
function bookedLeaveDates(from, to) {
  const rows = db.prepare(
    'SELECT start_date, end_date, leave_type FROM leave_entries WHERE end_date >= ? AND start_date <= ?'
  ).all(from, to);
  const dates = new Map();
  for (const r of rows) {
    for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) dates.set(d, r.leave_type);
  }
  return dates;
}

/** How often each weekday is actually worked, over the last PATTERN_WEEKS.
 *  Used to guess whether an unrostered future day would have been a shift. */
function weekdayPattern(today) {
  const since = addDays(today, -PATTERN_WEEKS * 7);
  const shifts = db.prepare('SELECT date FROM shifts WHERE date >= ? AND date < ?').all(since, today);
  const worked = Array(7).fill(0);
  for (const s of shifts) worked[dowIndex(s.date)] += 1;

  // Occurrences of each weekday in the same span, so the rate is a real share
  // rather than a raw count that favours whichever weekday came round most.
  const total = Array(7).fill(0);
  for (let d = since; d < today; d = addDays(d, 1)) total[dowIndex(d)] += 1;

  return worked.map((w, i) => ({
    dow: i,
    day: DAYS[i],
    short: DAYS[i].slice(0, 3),
    worked: w,
    occurrences: total[i],
    pct: pct(w, total[i]),
    likely: total[i] > 0 && w / total[i] >= 0.5,
  }));
}

router.get('/leave-planner', async (req, res) => {
  const today = localDateStr();
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

  const from = isDate(req.query.from) && req.query.from > today ? req.query.from : today;
  const to = isDate(req.query.to) && req.query.to > from ? req.query.to : addDays(from, 270);
  const maxSpan = Math.min(21, Math.max(2, parseInt(req.query.max_span, 10) || 16));

  const summary = leaveSummary(today);
  const hoursPerDay = getNumSetting('hours_per_day', 7.4);
  const bhList = await bankHolidayList();
  const bhTitles = new Map(bhList.map(b => [b.date, b.title]));

  const tailEnd = addDays(to, TAIL_DAYS);
  const shifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC')
    .all(from, tailEnd);
  const shiftByDate = new Map(shifts.map(s => [s.date, s]));
  const leaveDates = bookedLeaveDates(from, tailEnd);

  // The rota horizon: the last date anything is actually rostered for. Past it,
  // "no shift in the table" means "not published yet", not "day off".
  const horizonRow = db.prepare('SELECT MAX(date) AS d FROM shifts').get();
  const horizon = horizonRow && horizonRow.d ? horizonRow.d : today;

  const pattern = weekdayPattern(today);

  /* ── Classify every day in the window (plus the tail) ──────────────────── */
  const days = [];
  for (let d = from; d <= tailEnd; d = addDays(d, 1)) {
    const dow = dowIndex(d);
    const shift = shiftByDate.get(d);
    let kind;
    if (leaveDates.has(d)) kind = 'booked_leave';
    else if (shift) kind = 'working';
    else if (d <= horizon) kind = 'off';
    else kind = pattern[dow].likely ? 'likely_working' : 'likely_off';

    days.push({
      date: d,
      dow,
      day: DAYS[dow],
      kind,
      predicted: kind === 'likely_working' || kind === 'likely_off',
      is_bank_holiday: bhTitles.has(d),
      bank_holiday: bhTitles.get(d) || null,
      shift: shift ? { start_time: shift.start_time, end_time: shift.end_time,
                       hours: round1(paidHours(shift)) } : null,
      in_window: d <= to,
    });
  }

  const costs = days.map(d => (d.kind === 'working' || d.kind === 'likely_working') ? 1 : 0);
  const workIdx = days.map((d, i) => (costs[i] && d.in_window ? i : -1)).filter(i => i >= 0);

  /* ── Build every candidate break ──────────────────────────────────────────
     A candidate is anchored on two working days: book leave for those and
     everything rostered between them, then let the break grow outwards over
     whatever days you were already off. Anchoring on working days at both ends
     is what keeps this from generating the same break a dozen times over with
     different amounts of padding. */
  const seen = new Set();
  const candidates = [];

  for (let a = 0; a < workIdx.length; a++) {
    const i = workIdx[a];
    for (let b = a; b < workIdx.length; b++) {
      const j = workIdx[b];
      if (daysBetween(days[i].date, days[j].date) >= maxSpan) break;

      // Grow outwards over days that are already free. Index 0 is `from`, which
      // is the floor — there's no sense counting days off that already happened.
      let lo = i, hi = j;
      while (lo - 1 >= 0 && !costs[lo - 1]) lo--;
      while (hi + 1 < days.length && !costs[hi + 1]) hi++;

      const key = `${days[lo].date}|${days[hi].date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const span = days.slice(lo, hi + 1);
      const booked = span.map((_, k) => costs[lo + k] === 1);
      const leaveDays = span.filter((_, k) => booked[k]);
      if (!leaveDays.length) continue;

      const confirmed = leaveDays.filter(d => d.kind === 'working').length;
      const predicted = leaveDays.length - confirmed;

      // A bank holiday you're rostered on pays double, so spending a leave day
      // there gives up the premium as well as the day. Worth knowing before you
      // book it, not after.
      let doublePayLost = 0;
      for (const d of leaveDays) {
        if (!d.is_bank_holiday) continue;
        const s = shiftByDate.get(d.date);
        if (s) doublePayLost += (shiftPay(s) || 0) / 2;
      }

      candidates.push({
        id: key,
        break_start: days[lo].date,
        break_end: days[hi].date,
        break_days: span.length,
        leave_days: leaveDays.length,
        leave_dates: leaveDays.map(d => d.date),
        confirmed_leave_days: confirmed,
        predicted_leave_days: predicted,
        efficiency: round2(span.length / leaveDays.length),
        confidence: predicted === 0 ? 'confirmed'
          : confirmed === 0 ? 'predicted' : 'partly-predicted',
        bank_holidays: span.filter(d => d.is_bank_holiday)
          .map(d => ({ date: d.date, title: d.bank_holiday })),
        double_pay_lost: doublePayLost > 0 ? round2(doublePayLost) : null,
        hours_booked: round1(leaveDays.length * hoursPerDay),
        // Booking across the leave-year boundary spends two different pots
        spans_leave_year_end: leaveDays.some(d => d.date >= summary.end),
        starts_in_days: daysBetween(today, days[lo].date),
        days: span.map((d, k) => ({
          date: d.date, kind: d.kind, dow: d.dow, booked: booked[k],
          is_bank_holiday: d.is_bank_holiday,
        })),
      });
    }
  }

  // Best value first, then the longest break, then the cheapest, then soonest.
  candidates.sort((x, y) =>
    y.efficiency - x.efficiency ||
    y.break_days - x.break_days ||
    x.leave_days - y.leave_days ||
    x.break_start.localeCompare(y.break_start));

  // The single best option at each price point — usually more useful than the
  // top of the overall list, which is dominated by one-day bridges.
  const bestByCost = {};
  for (const c of candidates) {
    if (c.leave_days <= 6 && !bestByCost[c.leave_days]) bestByCost[c.leave_days] = c;
  }

  /* Shifting a break by one day usually scores almost identically, so the raw
     ranking comes out as a dozen near-copies of the same fortnight and buries
     everything else. Keep the best of each cluster: a plan is dropped if it
     shares more than half its days with one already on the list. */
  const overlapDays = (a, b) => Math.max(0,
    daysBetween(a.break_start > b.break_start ? a.break_start : b.break_start,
                a.break_end < b.break_end ? a.break_end : b.break_end) + 1);
  const diverse = [];
  for (const c of candidates) {
    if (diverse.length >= 25) break;
    const duplicate = diverse.some(x =>
      overlapDays(x, c) > 0.5 * Math.min(x.break_days, c.break_days));
    if (!duplicate) diverse.push(c);
  }

  const inWindow = days.filter(d => d.in_window);
  const counts = inWindow.reduce((acc, d) => { acc[d.kind] = (acc[d.kind] || 0) + 1; return acc; }, {});

  res.json({
    today,
    window: { from, to, days: inWindow.length, max_span: maxSpan },
    rota_horizon: horizon,
    rota_horizon_days: daysBetween(today, horizon),
    leave: { ...summary, hours_per_day: hoursPerDay },
    pattern,
    day_counts: {
      working: counts.working || 0,
      off: counts.off || 0,
      booked_leave: counts.booked_leave || 0,
      likely_working: counts.likely_working || 0,
      likely_off: counts.likely_off || 0,
    },
    bank_holidays: inWindow.filter(d => d.is_bank_holiday).map(d => ({
      date: d.date, title: d.bank_holiday, kind: d.kind, day: d.day,
      rostered: d.kind === 'working',
    })),
    candidates: diverse,
    best_by_cost: bestByCost,
    totals: {
      candidate_count: candidates.length,
      distinct_count: diverse.length,
      best_efficiency: candidates.length ? candidates[0].efficiency : null,
    },
  });
});

module.exports = router;
