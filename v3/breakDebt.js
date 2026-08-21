/* ─── ☕ Break Debt (V3.0) ─────────────────────────────────────────────────
   GET /api/v3/break-debt[?year=YYYY|all]

   Pay is always calculated with the *scheduled* break deducted. So on any shift
   where you took less break than scheduled, you were on the floor for time you
   were not paid for. This adds it all up: minutes given away, what they were
   worth, and how many full shifts that adds up to.

   The point isn't guilt — it's having the number to hand. It also tracks the
   trend, so you can see whether it's a bad month or a standing habit.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, parseDate, mondayOf, paidHours, rateForDate, round1, round2, pct,
} = require('./helpers');

const router = express.Router();

/** Minutes of scheduled break that weren't actually taken on a shift. */
function unpaidMinutes(shift) {
  const scheduled = shift.break_scheduled_minutes || 0;
  if (scheduled <= 0) return 0;
  if (shift.break_taken === 'none') return scheduled;
  if (shift.break_taken === 'partial') {
    const taken = shift.break_taken_minutes != null ? shift.break_taken_minutes : scheduled;
    return Math.max(0, scheduled - taken);
  }
  return 0;   // 'full' — nothing owed
}

router.get('/break-debt', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const shifts = year
    ? db.prepare('SELECT * FROM shifts WHERE completed = 1 AND date >= ? AND date <= ? ORDER BY date ASC')
        .all(`${year}-01-01`, `${year}-12-31`)
    : db.prepare('SELECT * FROM shifts WHERE completed = 1 ORDER BY date ASC').all();

  let totalMins = 0, totalValue = 0;
  let skipped = 0, partial = 0, full = 0;
  const byMonth = {}, byDow = Array.from({ length: 7 }, () => ({ mins: 0, shifts: 0 }));
  const offenders = [];

  for (const s of shifts) {
    if (s.break_taken === 'none') skipped++;
    else if (s.break_taken === 'partial') partial++;
    else full++;

    const mins = unpaidMinutes(s);
    byDow[parseDate(s.date).getDay()].shifts += 1;
    if (!mins) continue;

    const rate = s.hourly_rate != null ? s.hourly_rate : (rateForDate(s.date) || 0);
    const value = (mins / 60) * rate * (s.is_bank_holiday ? 2 : 1);

    totalMins += mins;
    totalValue += value;

    const m = s.date.slice(0, 7);
    (byMonth[m] ||= { mins: 0, value: 0, shifts: 0 });
    byMonth[m].mins += mins;
    byMonth[m].value += value;
    byMonth[m].shifts += 1;

    byDow[parseDate(s.date).getDay()].mins += mins;

    offenders.push({
      id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time,
      scheduled: s.break_scheduled_minutes, taken: s.break_taken_minutes,
      break_taken: s.break_taken, mins, value: round2(value),
    });
  }

  const avgHours = shifts.length
    ? shifts.reduce((t, s) => t + paidHours(s), 0) / shifts.length : 0;
  const hours = round1(totalMins / 60);

  // Weekly trend over the last year of data, for the sparkline
  const byWeek = {};
  for (const s of shifts.slice(-260)) {
    const wk = mondayOf(s.date);
    (byWeek[wk] ||= { mins: 0 });
    byWeek[wk].mins += unpaidMinutes(s);
  }

  // Is this getting better or worse? Compare the most recent quarter of shifts
  // against the one before it.
  let trend = null;
  if (shifts.length >= 20) {
    const q = Math.floor(shifts.length / 4);
    const recent = shifts.slice(-q), previous = shifts.slice(-2 * q, -q);
    const avg = arr => arr.reduce((t, s) => t + unpaidMinutes(s), 0) / (arr.length || 1);
    const recentAvg = avg(recent), prevAvg = avg(previous);
    trend = {
      recent_avg_mins: round1(recentAvg),
      previous_avg_mins: round1(prevAvg),
      direction: recentAvg < prevAvg - 0.5 ? 'improving' : recentAvg > prevAvg + 0.5 ? 'worsening' : 'steady',
    };
  }

  res.json({
    year: year || 'all',
    shift_count: shifts.length,
    breaks: { full, partial, skipped, full_pct: pct(full, shifts.length) },
    debt: {
      minutes: totalMins,
      hours,
      value: round2(totalValue),
      days_equivalent: avgHours > 0 ? round1(hours / avgHours) : 0,
      avg_mins_per_shift: shifts.length ? round1(totalMins / shifts.length) : 0,
      // Sanity-check framing: your unpaid time as a share of all paid time
      pct_of_paid_hours: pct(hours, round1(shifts.reduce((t, s) => t + paidHours(s), 0))),
    },
    trend,
    by_month: Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, mins: v.mins, hours: round1(v.mins / 60),
                              value: round2(v.value), shifts: v.shifts })),
    by_week: Object.entries(byWeek).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, v]) => ({ week, mins: v.mins })),
    by_dow: byDow.map((v, i) => ({ day: DAYS[i], short: DAYS[i].slice(0, 3), mins: v.mins, shifts: v.shifts,
                                   avg: v.shifts ? round1(v.mins / v.shifts) : 0 })),
    worst_offenders: offenders.sort((a, b) => b.mins - a.mins || b.date.localeCompare(a.date)).slice(0, 15),
    recent: offenders.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15),
    today: localDateStr(),
  });
});

module.exports = router;
