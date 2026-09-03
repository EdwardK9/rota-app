/* ─── 🔁 Check Habits (V5.0) ───────────────────────────────────────────────
   GET /api/v5/habits[?days=90|all]

   Not "how much do you use the app" (that's /usage) but *when, relative to your
   shifts*, and what that says about the habit. It joins the recorded view
   history against the real rota to answer things like:

     • how far ahead do you actually look — the day before, or a week out?
     • do you check on the morning of a shift, and does it change your clock-in?
     • do you look at the rota on days off, and how often?
     • is there a ritual — a check the night before, a check on the way in?

   A "rota check" means opening one of the views that exist to answer "when am I
   working" (see screens.js's ROTA_VIEWS), not any use of the app at all —
   spending twenty minutes in Payslips is not checking your shifts.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, DAYS_SHORT, windowFromQuery, localDateStr, addDays, daysBetween,
  toMins, round1, pct, median, humanMs,
} = require('./helpers');
const { ROTA_VIEWS } = require('./screens');

const router = express.Router();

const LOOKAHEAD_DAYS = 28;   // how far forward a check is credited to a shift

router.get('/habits', (req, res) => {
  const { days, since } = windowFromQuery(req.query, 90);
  const today = localDateStr();

  const placeholders = ROTA_VIEWS.map(() => '?').join(',');
  const checks = db.prepare(
    `SELECT local_date, local_time, hour, dow, view, duration_ms, session_id FROM v5_events
     WHERE type = 'view' AND view IN (${placeholders}) AND local_date >= ? ORDER BY local_date ASC, local_time ASC`
  ).all(...ROTA_VIEWS, since);

  // The rota either side of the window: shifts slightly before it so a check on
  // day one still has a shift behind it, and everything ahead of today so
  // "looking a fortnight out" can be measured.
  const shifts = db.prepare(
    'SELECT id, date, start_time, end_time, completed FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC'
  ).all(addDays(since, -7));

  const shiftsByDate = {};
  for (const s of shifts) (shiftsByDate[s.date] ||= []).push(s);
  const shiftDates = Object.keys(shiftsByDate).sort();

  const clockByDate = {};
  for (const c of db.prepare('SELECT date, clocked_in, clocked_out FROM clock_entries WHERE date >= ?').all(addDays(since, -7))) {
    clockByDate[c.date] = c;
  }

  /* ── How far ahead each check was looking ───────────────────────────── */
  // A check is credited to the next shift on or after the day it happened; the
  // gap is how far ahead you were looking. Checks with no shift ahead of them
  // (the rota simply doesn't go that far) are excluded rather than counted as
  // "looking infinitely far ahead".
  const leadBuckets = [
    { label: 'Same day',   min: 0,  max: 0 },
    { label: 'Day before', min: 1,  max: 1 },
    { label: '2–3 days',   min: 2,  max: 3 },
    { label: '4–7 days',   min: 4,  max: 7 },
    { label: '1–2 weeks',  min: 8,  max: 14 },
    { label: 'Over 2 weeks', min: 15, max: LOOKAHEAD_DAYS },
  ].map(b => ({ ...b, count: 0 }));

  const leadGaps = [];
  const nextShiftOnOrAfter = (date) => {
    for (const d of shiftDates) if (d >= date) return d;
    return null;
  };

  for (const c of checks) {
    const nextDate = nextShiftOnOrAfter(c.local_date);
    if (!nextDate) continue;
    const gap = daysBetween(c.local_date, nextDate);
    if (gap > LOOKAHEAD_DAYS) continue;
    leadGaps.push(gap);
    const bucket = leadBuckets.find(b => gap >= b.min && gap <= b.max);
    if (bucket) bucket.count++;
  }

  /* ── Per-shift coverage ─────────────────────────────────────────────── */
  // For every shift inside the window: was it looked at the day before? on the
  // morning? how many separate check-days led up to it?
  const checkDates = new Set(checks.map(c => c.local_date));
  const checksByDate = {};
  for (const c of checks) (checksByDate[c.local_date] ||= []).push(c);

  const windowShifts = shifts.filter(s => s.date >= since && s.date <= today);
  let checkedDayBefore = 0, checkedMorningOf = 0, checkedAfter = 0, unchecked = 0;
  const runUpCounts = [];
  const perShift = [];

  for (const s of windowShifts) {
    const dayBefore = addDays(s.date, -1);
    const startMins = toMins(s.start_time);

    const sameDay = checksByDate[s.date] || [];
    const morning = sameDay.filter(c => toMins(c.local_time) < startMins);
    const after   = sameDay.filter(c => toMins(c.local_time) >= startMins);

    let runUp = 0;
    for (let i = 1; i <= 7; i++) if (checkDates.has(addDays(s.date, -i))) runUp++;
    runUpCounts.push(runUp);

    const before = checkDates.has(dayBefore);
    if (before) checkedDayBefore++;
    if (morning.length) checkedMorningOf++;
    if (after.length) checkedAfter++;
    if (!before && !morning.length && !runUp) unchecked++;

    perShift.push({
      id: s.id, date: s.date, dow: DAYS_SHORT[new Date(`${s.date}T12:00:00`).getDay()],
      start_time: s.start_time, end_time: s.end_time,
      checked_day_before: before,
      checked_morning_of: morning.length,
      first_morning_check: morning.length ? morning[0].local_time : null,
      lead_mins: morning.length ? startMins - toMins(morning[0].local_time) : null,
      checks_in_run_up: runUp,
      clocked_in: clockByDate[s.date]?.clocked_in || null,
    });
  }

  /* ── Does checking change anything? ─────────────────────────────────── */
  // Clock-in punctuality on mornings you checked the app against mornings you
  // didn't. Correlation, not cause — but it is the question the data can
  // actually be asked.
  const punctuality = (list) => {
    const diffs = list
      .filter(p => p.clocked_in)
      .map(p => toMins(p.clocked_in) - toMins(windowShifts.find(s => s.id === p.id).start_time));
    return diffs.length
      ? { shifts: diffs.length, median_mins: Math.round(median(diffs)), early_pct: pct(diffs.filter(d => d <= 0).length, diffs.length) }
      : null;
  };
  const checkedGroup = perShift.filter(p => p.checked_morning_of > 0);
  const notCheckedGroup = perShift.filter(p => !p.checked_morning_of);

  /* ── Days off ───────────────────────────────────────────────────────── */
  const windowDates = [];
  const spanStart = days === 'all' ? (checks.length ? checks[0].local_date : today) : since;
  for (let d = spanStart; d <= today; d = addDays(d, 1)) windowDates.push(d);

  const workDates = new Set(windowShifts.map(s => s.date));
  const offDates = windowDates.filter(d => !workDates.has(d));
  const checkedOffDays = offDates.filter(d => checkDates.has(d)).length;
  const checkedWorkDays = [...workDates].filter(d => checkDates.has(d)).length;

  /* ── When in the day the checking happens ───────────────────────────── */
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, checks: 0, on_shift_day: 0 }));
  const byDow = Array.from({ length: 7 }, (_, i) => ({ dow: i, day: DAYS[i], short: DAYS_SHORT[i], checks: 0 }));
  const byView = {};
  for (const c of checks) {
    byHour[c.hour].checks++;
    if (workDates.has(c.local_date)) byHour[c.hour].on_shift_day++;
    byDow[c.dow].checks++;
    byView[c.view] = (byView[c.view] || 0) + 1;
  }

  /* ── The one-line habit summary ─────────────────────────────────────── */
  const medianLead = leadGaps.length ? median(leadGaps) : null;
  const checksPerDay = windowDates.length ? checks.length / windowDates.length : 0;
  let habitLabel = 'Not enough data yet';
  if (checks.length >= 20 && medianLead != null) {
    const planner = medianLead >= 3;
    const heavy = checksPerDay >= 2;
    habitLabel = planner
      ? (heavy ? 'Forward planner — checks often and looks well ahead' : 'Forward planner — checks rarely but looks well ahead')
      : (heavy ? 'Last-minute checker — checks constantly, mostly about today' : 'Just-in-time — a quick look when it matters');
  }

  res.json({
    window: { days, since: spanStart, today },
    totals: {
      checks: checks.length,
      check_days: checkDates.size,
      days_in_window: windowDates.length,
      checks_per_day: round1(checksPerDay),
      check_day_pct: pct(checkDates.size, windowDates.length),
      total_ms: checks.reduce((t, c) => t + (c.duration_ms || 0), 0),
      total_label: humanMs(checks.reduce((t, c) => t + (c.duration_ms || 0), 0)),
      shifts_in_window: windowShifts.length,
    },
    habit: {
      label: habitLabel,
      median_lead_days: medianLead != null ? round1(medianLead) : null,
      avg_checks_in_run_up: runUpCounts.length ? round1(runUpCounts.reduce((a, b) => a + b, 0) / runUpCounts.length) : 0,
    },
    lead_time: { buckets: leadBuckets.map(({ label, count }) => ({ label, count, pct: pct(count, leadGaps.length) })), sampled: leadGaps.length },
    coverage: {
      shifts: windowShifts.length,
      checked_day_before: checkedDayBefore,
      checked_day_before_pct: pct(checkedDayBefore, windowShifts.length),
      checked_morning_of: checkedMorningOf,
      checked_morning_of_pct: pct(checkedMorningOf, windowShifts.length),
      checked_after_start: checkedAfter,
      unchecked,
      unchecked_pct: pct(unchecked, windowShifts.length),
    },
    punctuality: {
      after_checking: punctuality(checkedGroup),
      without_checking: punctuality(notCheckedGroup),
    },
    days_off: {
      off_days: offDates.length,
      checked_off_days: checkedOffDays,
      off_day_check_pct: pct(checkedOffDays, offDates.length),
      work_days: workDates.size,
      checked_work_days: checkedWorkDays,
      work_day_check_pct: pct(checkedWorkDays, workDates.size),
    },
    by_hour: byHour,
    by_dow: byDow,
    by_view: Object.entries(byView).map(([view, count]) => ({ view, count, pct: pct(count, checks.length) }))
      .sort((a, b) => b.count - a.count),
    recent_shifts: perShift.slice(-25).reverse(),
  });
});

module.exports = router;
