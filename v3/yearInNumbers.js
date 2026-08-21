/* ─── 📊 Year in Numbers (V3.0) ────────────────────────────────────────────
   GET /api/v3/year-in-numbers

   Every year you have data for, side by side, with the change on the year
   before. Rota Wrapped (V2) tells the story of one year; this is the table you
   want when the question is "is this year actually better than last?".

   Part-years are flagged rather than hidden — the current year will always look
   short in December terms, and a comparison that pretends otherwise is worse
   than useless. A pro-rata projection is given alongside for the current year.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, daysBetween, isWeekend, toMins, spanMins,
  paidHours, shiftPay, round1, round2,
} = require('./helpers');

const router = express.Router();

router.get('/year-in-numbers', (req, res) => {
  const today = localDateStr();
  const thisYear = today.slice(0, 4);

  const shifts = db.prepare('SELECT * FROM shifts WHERE date <= ? ORDER BY date ASC').all(today);
  if (!shifts.length) return res.json({ years: [], today });

  const byYear = {};
  for (const s of shifts) {
    const y = s.date.slice(0, 4);
    (byYear[y] ||= { shifts: [], dates: new Set() });
    byYear[y].shifts.push(s);
    byYear[y].dates.add(s.date);
  }

  // Colleague overlap per year, for "people worked with"
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all();
  const colByDate = {};
  for (const cs of colShifts) (colByDate[cs.date] ||= []).push(cs);

  const payslips = db.prepare('SELECT * FROM payslips').all();
  const leave = db.prepare('SELECT * FROM leave_entries').all();

  const years = Object.keys(byYear).sort().map(y => {
    const rows = byYear[y].shifts;
    const isCurrent = y === thisYear;
    // How much of the year is actually covered by data
    const elapsedDays = isCurrent ? daysBetween(`${y}-01-01`, today) + 1 : daysInYear(y);
    const fraction = elapsedDays / daysInYear(y);

    const people = new Set();
    for (const s of rows) {
      for (const cs of colByDate[s.date] || []) {
        if (overlapOk(s, cs)) people.add(cs.colleague_id);
      }
    }

    const slips = payslips.filter(p => p.month.startsWith(y));
    const leaveDays = round1(leave.filter(l => l.start_date.startsWith(y))
      .reduce((t, l) => t + (l.days_taken || 0), 0));

    const hours = round1(rows.reduce((t, s) => t + paidHours(s), 0));
    const pay = round2(rows.reduce((t, s) => t + (shiftPay(s) || 0), 0));

    return {
      year: y,
      partial: isCurrent,
      elapsed_pct: round1(fraction * 100),
      shifts: rows.length,
      days_worked: byYear[y].dates.size,
      hours,
      pay,
      miles: round1(rows.reduce((t, s) => t + (s.distance_miles || 0), 0)),
      weekend_shifts: rows.filter(s => isWeekend(s.date)).length,
      bank_holidays: rows.filter(s => s.is_bank_holiday).length,
      early_starts: rows.filter(s => toMins(s.start_time) <= 7 * 60).length,
      late_finishes: rows.filter(s => toMins(s.start_time) + spanMins(s.start_time, s.end_time) >= 20 * 60).length,
      breaks_skipped: rows.filter(s => s.break_taken === 'none').length,
      avg_shift: rows.length ? round1(hours / rows.length) : 0,
      colleagues: people.size,
      payslips: slips.length,
      gross: round2(slips.reduce((t, p) => t + (p.total_gross || 0), 0)),
      net: round2(slips.reduce((t, p) => t + (p.net_payment || 0), 0)),
      tax_ni: round2(slips.reduce((t, p) => t + (p.tax_paid || 0) + (p.ni_employee || 0), 0)),
      leave_days: leaveDays,
      // Straight-line projection for the year in progress
      projected: isCurrent && fraction > 0.05
        ? { shifts: Math.round(rows.length / fraction), hours: round1(hours / fraction), pay: round2(pay / fraction) }
        : null,
    };
  });

  // Year-on-year change, comparing like with like where one side is partial
  const COMPARE = ['shifts', 'hours', 'pay', 'miles', 'weekend_shifts', 'days_worked', 'colleagues'];
  years.forEach((y, i) => {
    const prev = years[i - 1];
    if (!prev) { y.change = null; return; }
    y.change = {};
    for (const k of COMPARE) {
      // A part-year is compared on its projection, so December isn't judged
      // against a year that has only run to August.
      const mineVal = y.partial && y.projected && y.projected[k] != null ? y.projected[k] : y[k];
      const diff = mineVal - prev[k];
      y.change[k] = {
        diff: round1(diff),
        pct: prev[k] > 0 ? round1((diff / prev[k]) * 100) : null,
        projected_basis: !!(y.partial && y.projected && y.projected[k] != null),
      };
    }
  });

  const best = {};
  for (const k of COMPARE) {
    const ranked = years.filter(y => !y.partial).sort((a, b) => b[k] - a[k]);
    best[k] = ranked.length ? ranked[0].year : null;
  }

  res.json({ years: years.reverse(), best, compare_keys: COMPARE, today });
});

function daysInYear(y) {
  const year = parseInt(y, 10);
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

function overlapOk(shift, cs) {
  const s1 = toMins(shift.start_time), e1 = s1 + spanMins(shift.start_time, shift.end_time);
  const s2 = toMins(cs.start_time), e2 = s2 + spanMins(cs.start_time, cs.end_time);
  return Math.min(e1, e2) - Math.max(s1, s2) > 0;
}

module.exports = router;
