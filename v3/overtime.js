/* ─── ⏰ Overtime Tracker (V3.0) ───────────────────────────────────────────
   GET /api/v3/overtime[?year=YYYY|all]

   How far above (or below) your contract you actually work, and what those
   extra hours are worth. Screwfix pays additional hours at the normal rate
   rather than time-and-a-half, so this is deliberately "hours beyond contract"
   rather than a premium calculation — the interesting number is how much of
   your pay depends on shifts you were never contracted to do.

   Measured per ISO week against the contracted hours in force that week, so a
   contract change partway through a year is handled correctly.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, mondayOf, addDays, paidHours, shiftPay,
  contractHoursForDate, rateForDate, round1, round2, pct,
} = require('./helpers');

const router = express.Router();

router.get('/overtime', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const today = localDateStr();
  const from = year ? `${year}-01-01` : '0000-01-01';
  const to = year ? (`${year}-12-31` > today ? today : `${year}-12-31`) : today;

  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC'
  ).all(from, to);

  if (!shifts.length) {
    return res.json({ year: year || 'all', weeks: [], totals: null, by_month: [] });
  }

  // Group into ISO weeks
  const byWeek = {};
  for (const s of shifts) {
    const wk = mondayOf(s.date);
    (byWeek[wk] ||= { hours: 0, pay: 0, shifts: 0 });
    byWeek[wk].hours += paidHours(s);
    byWeek[wk].pay += shiftPay(s) || 0;
    byWeek[wk].shifts += 1;
  }

  const weeks = Object.entries(byWeek).sort((a, b) => a[0].localeCompare(b[0])).map(([week, v]) => {
    const contracted = contractHoursForDate(week) || 0;
    const extra = round1(v.hours - contracted);
    const rate = rateForDate(week) || 0;
    return {
      week,
      week_end: addDays(week, 6),
      hours: round1(v.hours),
      contracted,
      extra,
      // Only weeks fully in the past are judged — a part-worked current week
      // always looks short and would drag every average down.
      partial: addDays(week, 6) > today,
      shifts: v.shifts,
      pay: round2(v.pay),
      extra_value: round2(Math.max(0, extra) * rate),
    };
  });

  const complete = weeks.filter(w => !w.partial && w.contracted > 0);
  const over  = complete.filter(w => w.extra > 0.05);
  const under = complete.filter(w => w.extra < -0.05);
  const exact = complete.filter(w => Math.abs(w.extra) <= 0.05);

  const totalExtra = round1(over.reduce((t, w) => t + w.extra, 0));
  const totalShort = round1(Math.abs(under.reduce((t, w) => t + w.extra, 0)));
  const extraValue = round2(over.reduce((t, w) => t + w.extra_value, 0));
  const totalHours = round1(complete.reduce((t, w) => t + w.hours, 0));
  const totalPay   = round2(complete.reduce((t, w) => t + w.pay, 0));

  const biggest = over.slice().sort((a, b) => b.extra - a.extra)[0] || null;

  // Monthly rollup for the chart
  const byMonth = {};
  for (const w of complete) {
    const m = w.week.slice(0, 7);
    (byMonth[m] ||= { extra: 0, hours: 0, contracted: 0 });
    byMonth[m].extra += w.extra;
    byMonth[m].hours += w.hours;
    byMonth[m].contracted += w.contracted;
  }

  res.json({
    year: year || 'all',
    range: { from, to },
    weeks: weeks.slice(-104),          // the chart never needs more than two years
    totals: {
      weeks_counted: complete.length,
      weeks_over: over.length,
      weeks_under: under.length,
      weeks_exact: exact.length,
      over_pct: pct(over.length, complete.length),
      extra_hours: totalExtra,
      short_hours: totalShort,
      net_hours: round1(totalExtra - totalShort),
      extra_value: extraValue,
      total_hours: totalHours,
      total_pay: totalPay,
      // The headline: how much of your pay came from beyond-contract hours
      extra_share_pct: pct(extraValue, totalPay),
      avg_week: complete.length ? round1(totalHours / complete.length) : 0,
      avg_contracted: complete.length
        ? round1(complete.reduce((t, w) => t + w.contracted, 0) / complete.length) : 0,
      extra_as_shifts: complete.length && totalHours > 0
        ? round1(totalExtra / (totalHours / complete.reduce((t, w) => t + w.shifts, 0))) : 0,
    },
    biggest_week: biggest,
    by_month: Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({
        month,
        extra: round1(v.extra),
        hours: round1(v.hours),
        contracted: round1(v.contracted),
      })),
    today,
  });
});

module.exports = router;
