/* ─── ⚖️ Work-Life Balance (V3.0) ──────────────────────────────────────────
   GET /api/v3/balance[?weeks=12]

   A single 0–100 score for how sustainable the last few months of rota actually
   were, broken into five components you can see individually — because "you
   scored 68" is useless without knowing which part dragged it down.

   Deliberately distinct from the Fatigue Audit: that one flags individual
   dangerous patterns (clopenings, short turnarounds) in a specific week. This
   is the slow-moving trend line across a whole quarter.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, addDays, daysBetween, mondayOf, isWeekend,
  toMins, spanMins, paidHours, contractHoursForDate, round1, clamp,
} = require('./helpers');
const { longestConsecutiveRun } = require('./stats');

const router = express.Router();

/* Each component contributes its weight to the final score. `ideal` and `worst`
   frame the linear scale: at or better than `ideal` scores full marks, at or
   beyond `worst` scores zero. */
const COMPONENTS = [
  { key: 'rest_days',    icon: '🛌', label: 'Rest days',
    desc: 'Average days off per week.',                      weight: 25, ideal: 3,   worst: 0.5, higherIsBetter: true },
  { key: 'weekends_off', icon: '🎉', label: 'Weekends off',
    desc: 'Share of weekend days you were not working.',     weight: 20, ideal: 60,  worst: 0,   higherIsBetter: true },
  { key: 'turnaround',   icon: '🔁', label: 'Turnaround',
    desc: 'Average hours between finishing and starting again.', weight: 20, ideal: 16, worst: 9, higherIsBetter: true },
  { key: 'breaks',       icon: '☕', label: 'Breaks taken',
    desc: 'Share of shifts where you took your full break.', weight: 20, ideal: 95,  worst: 40,  higherIsBetter: true },
  { key: 'streaks',      icon: '🧱', label: 'Longest run',
    desc: 'Longest stretch of consecutive days worked.',     weight: 15, ideal: 4,   worst: 9,   higherIsBetter: false },
];

function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function scoreComponent(def, value) {
  if (value == null) return null;
  const span = def.ideal - def.worst;
  if (span === 0) return 100;
  const raw = ((value - def.worst) / span) * 100;
  return round1(clamp(raw, 0, 100));
}

const VERDICTS = [
  { min: 85, icon: '🌴', label: 'Very healthy',  note: 'Plenty of recovery time between shifts — keep it here.' },
  { min: 70, icon: '🙂', label: 'Comfortable',   note: 'A sustainable pattern with a bit of room to spare.' },
  { min: 55, icon: '😐', label: 'Busy',          note: 'Manageable, but the rest days are doing a lot of work.' },
  { min: 40, icon: '😮‍💨', label: 'Stretched',    note: 'The pattern is starting to eat into your recovery time.' },
  { min: 0,  icon: '🚨', label: 'Running hot',   note: 'Little genuine downtime — worth a conversation about the rota.' },
];

router.get('/balance', (req, res) => {
  // Up to five years, so the trend can cover a whole career rather than
  // stopping at one year. `all` spans back to the first shift on record.
  const today = localDateStr();
  let weeks;
  if (req.query.weeks === 'all') {
    const first = db.prepare('SELECT MIN(date) AS d FROM shifts').get().d;
    weeks = first ? Math.max(2, Math.ceil((daysBetween(first, today) + 1) / 7)) : 12;
  } else {
    weeks = clamp(parseInt(req.query.weeks, 10) || 12, 2, 260);
  }
  const from = mondayOf(addDays(today, -(weeks * 7 - 1)));
  const to = today;

  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC'
  ).all(from, to);

  if (!shifts.length) {
    return res.json({ range: { from, to, weeks }, shift_count: 0, score: null, components: [], verdict: null });
  }

  const totalDays = daysBetween(from, to) + 1;
  const workedDates = [...new Set(shifts.map(s => s.date))].sort();
  const workedSet = new Set(workedDates);

  // ── Rest days per week ───────────────────────────────────────────────────
  const restDaysPerWeek = round1(((totalDays - workedDates.length) / totalDays) * 7);

  // ── Weekends off ─────────────────────────────────────────────────────────
  let weekendDays = 0, weekendWorked = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(from, i);
    if (!isWeekend(d)) continue;
    weekendDays++;
    if (workedSet.has(d)) weekendWorked++;
  }
  const weekendsOffPct = weekendDays ? round1(((weekendDays - weekendWorked) / weekendDays) * 100) : 100;

  // ── Turnaround: gap between one shift finishing and the next starting ────
  const gaps = [];
  let shortest = null;
  for (let i = 1; i < shifts.length; i++) {
    const prev = shifts[i - 1], cur = shifts[i];
    const dayGap = daysBetween(prev.date, cur.date);
    if (dayGap > 2) continue;                       // a proper break, not a turnaround
    const prevEnd = toMins(prev.start_time) + spanMins(prev.start_time, prev.end_time);
    const gapHours = ((dayGap * 1440) + toMins(cur.start_time) - prevEnd) / 60;
    if (gapHours <= 0) continue;                    // same-day split shift
    gaps.push(gapHours);
    if (!shortest || gapHours < shortest.hours) {
      shortest = { hours: round1(gapHours), from_date: prev.date, to_date: cur.date,
                   finished: prev.end_time, started: cur.start_time };
    }
  }
  const avgTurnaround = gaps.length ? round1(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  // ── Breaks ───────────────────────────────────────────────────────────────
  const completed = shifts.filter(s => s.completed);
  const fullBreaks = completed.filter(s => s.break_taken === 'full').length;
  const breakPct = completed.length ? round1((fullBreaks / completed.length) * 100) : null;

  // ── Longest consecutive run ──────────────────────────────────────────────
  const longestRun = longestConsecutiveRun(workedDates).length;

  const values = {
    rest_days: restDaysPerWeek,
    weekends_off: weekendsOffPct,
    turnaround: avgTurnaround,
    breaks: breakPct,
    streaks: longestRun,
  };

  const components = COMPONENTS.map(def => ({
    ...def,
    value: values[def.key],
    score: scoreComponent(def, values[def.key]),
  }));

  // Components with no data (no turnarounds, no completed shifts) drop out and
  // their weight is redistributed, rather than scoring zero for absent evidence.
  const scored = components.filter(c => c.score != null);
  const weightSum = scored.reduce((t, c) => t + c.weight, 0) || 1;
  const score = Math.round(scored.reduce((t, c) => t + c.score * c.weight, 0) / weightSum);

  const verdict = VERDICTS.find(v => score >= v.min);
  const weakest = scored.slice().sort((a, b) => a.score - b.score)[0] || null;

  // Trend chart. Past about six months a bar per week is an unreadable comb, so
  // long ranges group by month and compare against the monthly contract instead.
  const grouping = weeks > 26 ? 'month' : 'week';
  const buckets = {};
  for (const s of shifts) {
    const key = grouping === 'month' ? s.date.slice(0, 7) : mondayOf(s.date);
    (buckets[key] ||= { hours: 0, shifts: 0, days: new Set() });
    buckets[key].hours += paidHours(s);
    buckets[key].shifts += 1;
    buckets[key].days.add(s.date);
  }
  const trend = Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => {
    const anchor = grouping === 'month' ? key + '-01' : key;
    const weekly = contractHoursForDate(anchor);
    // A month is ~4.35 contracted weeks; scale so the comparison stays fair.
    const contracted = weekly == null ? null
      : round1(grouping === 'month' ? weekly * (daysInMonth(key) / 7) : weekly);
    return {
      key, period: key, grouping,
      hours: round1(v.hours),
      shifts: v.shifts,
      days_worked: v.days.size,
      contracted,
    };
  });

  res.json({
    range: { from, to, weeks, grouping },
    shift_count: shifts.length,
    days_worked: workedDates.length,
    total_days: totalDays,
    score,
    verdict,
    weakest_link: weakest ? { key: weakest.key, label: weakest.label, score: weakest.score } : null,
    components,
    shortest_turnaround: shortest,
    trend,
    // Everything the client needs to explain the score without hard-coding it
    scale: VERDICTS.map(v => ({ min: v.min, icon: v.icon, label: v.label })),
    how_it_works: {
      summary: 'Five measures of recovery time, each scored 0–100 against a best case and a worst case, ' +
               'then combined using the weights below.',
      note: 'A measure with no data (no turnarounds in the window, say) drops out and its weight is ' +
            'shared among the others, rather than scoring zero for missing evidence.',
    },
  });
});

module.exports = router;
