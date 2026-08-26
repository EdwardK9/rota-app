/* ─── 🔮 Rota Crystal Ball (V3.0) ──────────────────────────────────────────
   GET /api/v3/crystal-ball[?week=YYYY-MM-DD]

   The rota lands about a fortnight ahead, which is not long enough to answer
   "am I likely to be working the weekend of the 14th?" — the question you get
   asked six weeks out. Two years of your own shifts is a better answer than a
   shrug, so this projects an unpublished week: which days you'll probably be
   on, the times most likely to come up, and how many hours it adds up to.

   The model was chosen by measuring, not by taste. Backtested over 26 weeks of
   real rota, predicting each week from only what was known before it:

     always saying "working"        58%   ← the number to beat
     weekday rate, all history      65%
     weekday rate, last 16 weeks    71%
     same as the last known week    69%
     the two blended, 35/65         70%

   The last three are the same to within noise, and the honest summary is that
   which days you work is a recent habit with some week-to-week stickiness on
   top. The blend is used because it was the flattest when the same test was run
   one, two, three and four weeks ahead — persistence alone decays as the target
   moves further out, and the blend doesn't — not because it wins outright.
   Start times come from a much longer window: what time you start moves far
   more slowly than which days you're on.

   Every figure is reported next to the backtested hit rate and next to that 58%
   baseline, because a projection presented with the same confidence as the
   published rota would be worse than not having one.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, addDays, daysBetween, dowIndex, mondayOf,
  toMins, paidHours, shiftPay, rateForDate, contractHoursForDate, round1, round2,
} = require('./helpers');
const { bankHolidayDates } = require('./bankHolidays');

const router = express.Router();

/* Which days you work: a short window, with the most recent half counting
   double. Longer windows measurably did worse — an old pattern is a different
   pattern, not more evidence for the current one. */
const PROB_DAYS = 112;          // 16 weeks
const PROB_RECENT_DAYS = 56;    // the half that counts double

/* What time you start: a much longer window, on the same recency buckets the
   rest of V3 uses. Start times barely move even when the days do. */
const TIME_BUCKETS = [
  { days: 84,  weight: 3 },
  { days: 182, weight: 2 },
  { days: 364, weight: 1 },
];
const MAX_AGE = TIME_BUCKETS[TIME_BUCKETS.length - 1].days;

/* How much the last published week pulls the prediction towards itself. 0.35
   was the best of the values tested, and the flattest across horizons. */
const PERSISTENCE_WEIGHT = 0.35;

/** Published weeks to backtest against. This started at ten and was too few: a
 *  quiet or unusually chopped-about couple of months swings the figure by twenty
 *  points, and ten weeks of August scored 52% against a 70% half-year. Half a
 *  year is stable without reaching back into a materially different rota. */
const BACKTEST_WEEKS = 26;

function timeWeight(ageDays) {
  for (const b of TIME_BUCKETS) if (ageDays <= b.days) return b.weight;
  return 0;
}

/** Build the weekday model from shifts strictly before `cutoff`, so a backtest
 *  can never see the week it is being graded on. */
function buildModel(byDate, cutoff) {
  const dows = Array.from({ length: 7 }, () => ({
    worked_weight: 0, total_weight: 0, worked: 0, occurrences: 0,
    hours_weight: 0, hours_sum: 0, morning_weight: 0,
    starts: new Map(), patterns: new Map(),
  }));

  for (let d = addDays(cutoff, -MAX_AGE); d < cutoff; d = addDays(d, 1)) {
    const age = daysBetween(d, cutoff);
    const bucket = dows[dowIndex(d)];

    // Probability window — short, recent half doubled
    if (age <= PROB_DAYS) {
      const pw = age <= PROB_RECENT_DAYS ? 2 : 1;
      bucket.total_weight += pw;
      bucket.occurrences += 1;
      if (byDate.has(d)) { bucket.worked_weight += pw; bucket.worked += 1; }
    }

    const shift = byDate.get(d);
    if (!shift) continue;

    // Time window — long, standard recency buckets
    const tw = timeWeight(age);
    if (!tw) continue;
    bucket.hours_weight += tw;
    bucket.hours_sum += paidHours(shift) * tw;
    if (toMins(shift.start_time) < 12 * 60) bucket.morning_weight += tw;

    // Start times are grouped on their own rather than as exact start–end pairs.
    // The pair is too specific to predict: a 14:15–19:15 and a 14:15–18:00 are
    // the same shift as far as "when am I in?" goes, but split the vote between
    // them and neither wins.
    const s = bucket.starts.get(shift.start_time)
      || { start_time: shift.start_time, weight: 0, count: 0, ends: new Map() };
    s.weight += tw;
    s.count += 1;
    s.ends.set(shift.end_time, (s.ends.get(shift.end_time) || 0) + tw);
    bucket.starts.set(shift.start_time, s);

    const key = `${shift.start_time}|${shift.end_time}`;
    const pat = bucket.patterns.get(key)
      || { start_time: shift.start_time, end_time: shift.end_time, weight: 0, count: 0, last: null };
    pat.weight += tw;
    pat.count += 1;
    if (!pat.last || shift.date > pat.last) pat.last = shift.date;
    bucket.patterns.set(key, pat);
  }

  return dows.map((b, dow) => {
    const starts = [...b.starts.values()].sort((x, y) => y.weight - x.weight);
    const patterns = [...b.patterns.values()]
      .sort((x, y) => y.weight - x.weight || y.last.localeCompare(x.last));

    const morningPct = b.hours_weight > 0 ? b.morning_weight / b.hours_weight : null;
    const half = morningPct == null ? null
      : morningPct >= 0.7 ? 'morning'
      : morningPct <= 0.3 ? 'afternoon' : 'mixed';

    // The headline time has to come from the same half the day is being called
    // as, or the card contradicts itself — "an afternoon, usually 06:45" happens
    // when mornings all start at one time and afternoons are spread over four.
    const pool = half === 'morning' ? starts.filter(s => toMins(s.start_time) < 720)
      : half === 'afternoon' ? starts.filter(s => toMins(s.start_time) >= 720)
      : starts;
    const pick = pool[0] || starts[0];
    const top = pick
      ? { start_time: pick.start_time,
          end_time: [...pick.ends.entries()].sort((a, c) => c[1] - a[1])[0][0] }
      : null;

    return {
      dow,
      day: DAYS[dow],
      base_probability: b.total_weight > 0 ? b.worked_weight / b.total_weight : 0,
      sample: b.occurrences,
      worked: b.worked,
      hours_weight: b.hours_weight,
      avg_hours: b.hours_weight > 0 ? b.hours_sum / b.hours_weight : null,
      morning_pct: morningPct,
      half,
      top,
      patterns,
    };
  });
}

/** The last week entirely before `cutoff` that has any shifts in it — the
 *  "same as last week" half of the prediction. Returns null when there is a gap
 *  in the data rather than reaching back to something long stale. */
function lastKnownWeek(byDate, cutoff) {
  let ws = addDays(mondayOf(cutoff), -7);
  for (let i = 0; i < 4; i++, ws = addDays(ws, -7)) {
    const pattern = Array.from({ length: 7 }, (_, k) => byDate.has(addDays(ws, k)));
    if (pattern.some(Boolean)) return { start: ws, pattern, weeks_back: i + 1 };
  }
  return null;
}

/** The full prediction for one week. Shared by the live route and the backtest
 *  so the two can never drift apart. */
function predictWeek(byDate, cutoff) {
  const model = buildModel(byDate, cutoff);
  const last = lastKnownWeek(byDate, cutoff);
  const wp = last ? PERSISTENCE_WEIGHT : 0;

  const days = model.map(m => {
    // Monday is index 0 of a week pattern; DAYS is Sunday-first.
    const persisted = last ? (last.pattern[(m.dow + 6) % 7] ? 1 : 0) : 0;
    const probability = wp * persisted + (1 - wp) * m.base_probability;
    return { ...m, persisted: last ? !!persisted : null, probability };
  });

  return { model: days, last_week: last, persistence_weight: wp };
}

/** Grade the model on weeks that have already happened, using only the history
 *  that existed before each one. */
function backtest(byDate, today) {
  let days = 0, hits = 0, worked = 0, bothWorking = 0, timeHits = 0, halfHits = 0, predicted = 0;

  let weekStart = addDays(mondayOf(today), -7);
  for (let w = 0; w < BACKTEST_WEEKS; w++, weekStart = addDays(weekStart, -7)) {
    const week = [];
    for (let k = 0; k < 7; k++) week.push(addDays(weekStart, k));
    // An empty week is missing data as often as it is a week off, and either way
    // there is nothing to grade — skip it rather than let it flatter the score.
    if (!week.some(d => byDate.has(d))) continue;

    const { model } = predictWeek(byDate, weekStart);
    for (const date of week) {
      const m = model[dowIndex(date)];
      if (!m.sample) continue;
      const saidWorking = m.probability >= 0.5;
      const actual = byDate.get(date);

      days += 1;
      if (saidWorking) predicted += 1;
      if (actual) worked += 1;
      if (saidWorking === !!actual) hits += 1;

      if (saidWorking && actual && m.top) {
        bothWorking += 1;
        const actualStart = toMins(actual.start_time);
        if (Math.abs(toMins(m.top.start_time) - actualStart) <= 60) timeHits += 1;
        if ((toMins(m.top.start_time) < 720) === (actualStart < 720)) halfHits += 1;
      }
    }
  }

  if (!days) return null;
  // What you'd score by ignoring the model and always saying whichever answer is
  // more common. Anything at or below this is a model not worth having.
  const baseline = Math.max(worked, days - worked) / days;

  return {
    days_tested: days,
    day_accuracy_pct: Math.round((hits / days) * 100),
    baseline_pct: Math.round(baseline * 100),
    beats_baseline: hits / days > baseline,
    start_time_accuracy_pct: bothWorking ? Math.round((timeHits / bothWorking) * 100) : null,
    morning_afternoon_pct: bothWorking ? Math.round((halfHits / bothWorking) * 100) : null,
    start_time_sample: bothWorking,
    predicted_days: predicted,
    actual_days: worked,
    bias: predicted === worked ? 'balanced'
      : predicted > worked ? 'over-predicts' : 'under-predicts',
  };
}

router.get('/crystal-ball', async (req, res) => {
  const today = localDateStr();
  const shifts = db.prepare('SELECT * FROM shifts ORDER BY date ASC').all();

  if (shifts.length < 20) {
    return res.json({ today, week: null, enough_history: false, shift_count: shifts.length });
  }

  // One shift per date — the model is about whether a day is a working day.
  const byDate = new Map(shifts.map(s => [s.date, s]));
  const horizon = shifts[shifts.length - 1].date;

  // Default to the first week that isn't published yet — the one you can't
  // simply go and look at.
  const firstUnpublished = mondayOf(addDays(horizon, 7)) > mondayOf(today)
    ? mondayOf(addDays(horizon, 7))
    : addDays(mondayOf(today), 7);

  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '')
    ? mondayOf(req.query.week)
    : firstUnpublished;
  const weekEnd = addDays(weekStart, 6);
  const published = weekStart <= horizon;

  // For a week that already exists, predict from what was known before it — a
  // model handed its own answer would score 100% and mean nothing.
  const asOf = published ? weekStart : today;
  const historyForWeek = published
    ? new Map([...byDate].filter(([d]) => d < weekStart))
    : byDate;
  const { model, last_week, persistence_weight } = predictWeek(historyForWeek, asOf);

  const bhDates = await bankHolidayDates();

  const days = [];
  for (let k = 0; k < 7; k++) {
    const date = addDays(weekStart, k);
    const m = model[dowIndex(date)];
    const actual = byDate.get(date);
    const on = m.probability >= 0.5;

    days.push({
      date,
      dow: m.dow,
      day: m.day,
      short: m.day.slice(0, 3),
      is_today: date === today,
      is_past: date < today,
      is_bank_holiday: bhDates.has(date),
      predicted_working: on,
      probability: Math.round(m.probability * 100),
      base_probability: Math.round(m.base_probability * 100),
      worked_last_week: m.persisted,
      // How lopsided the call is — a day at 50% is a coin toss whichever way it
      // lands, and shouldn't be shown with the same weight as one at 95%.
      confidence: Math.round(Math.abs(m.probability - 0.5) * 200),
      sample: m.sample,
      worked: m.worked,
      likely_start: m.top ? m.top.start_time : null,
      likely_end: m.top ? m.top.end_time : null,
      likely_hours: m.avg_hours != null ? round1(m.avg_hours) : null,
      // "A morning, probably" is a claim worth making even when the exact start
      // isn't; the backtest scores the two separately for the same reason.
      half: m.half,
      // Genuinely different shapes only — the headline time is picked from the
      // start-time groups and the alternatives from exact pairs, so without this
      // the top one usually turns up again as its own alternative.
      alternatives: m.patterns
        .filter(p => !m.top || p.start_time !== m.top.start_time || p.end_time !== m.top.end_time)
        .slice(0, 2)
        .map(p => ({ start_time: p.start_time, end_time: p.end_time, count: p.count, last: p.last })),
      actual: actual ? {
        start_time: actual.start_time,
        end_time: actual.end_time,
        hours: round1(paidHours(actual)),
        pay: round2(shiftPay(actual) || 0),
      } : null,
      hit: published ? on === !!actual : null,
    });
  }

  const expectedHours = days.reduce((t, d) => t + (d.predicted_working ? (d.likely_hours || 0) : 0), 0);
  const rate = rateForDate(weekStart);
  const contracted = contractHoursForDate(weekStart);
  const actualDays = days.filter(d => d.actual);

  res.json({
    today,
    enough_history: true,
    published,
    rota_horizon: horizon,
    next_unpublished_week: firstUnpublished,
    week: {
      start: weekStart,
      end: weekEnd,
      weeks_away: Math.round(daysBetween(mondayOf(today), weekStart) / 7),
    },
    days,
    week_summary: {
      expected_days: days.filter(d => d.predicted_working).length,
      expected_hours: round1(expectedHours),
      expected_pay: rate ? round2(expectedHours * rate) : null,
      contracted_hours: contracted,
      vs_contract: contracted ? round1(expectedHours - contracted) : null,
      actual_days: published ? actualDays.length : null,
      actual_hours: published ? round1(actualDays.reduce((t, d) => t + d.actual.hours, 0)) : null,
      hits: published ? days.filter(d => d.hit).length : null,
    },
    model: {
      as_of: asOf,
      persistence_weight,
      last_week: last_week ? last_week.start : null,
      prob_window_weeks: PROB_DAYS / 7,
      weeks_of_history: Math.round(daysBetween(shifts[0].date, today) / 7),
      shifts_used: shifts.filter(s => s.date < asOf && daysBetween(s.date, asOf) <= MAX_AGE).length,
      weekday: model.map(m => ({
        dow: m.dow, day: m.day, short: m.day.slice(0, 3),
        probability: Math.round(m.probability * 100),
        base_probability: Math.round(m.base_probability * 100),
        worked: m.worked, sample: m.sample,
        likely_start: m.top ? m.top.start_time : null,
        avg_hours: m.avg_hours != null ? round1(m.avg_hours) : null,
      })),
    },
    accuracy: backtest(byDate, today),
  });
});

module.exports = router;
