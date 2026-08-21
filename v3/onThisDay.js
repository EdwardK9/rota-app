/* ─── 📼 On This Day (V3.0) ────────────────────────────────────────────────
   GET /api/v3/on-this-day[?date=YYYY-MM-DD]

   A flashback to the same calendar date in every previous year you have data
   for: the shift you worked, who you worked with, what you earned, and any note
   you left on it. Plus the milestones landing today — work anniversaries,
   colleague birthdays, and round-number totals you have just crossed.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, MONTHS, getSetting, localDateStr, parseDate, daysBetween,
  overlapMins, paidHours, shiftPay, round1, round2,
} = require('./helpers');

const router = express.Router();

const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

router.get('/on-this-day', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : localDateStr();
  const [year, month, day] = date.split('-').map(Number);
  const mmdd = date.slice(5);

  // ── Same date, previous years ────────────────────────────────────────────
  const matches = db.prepare(
    "SELECT * FROM shifts WHERE substr(date, 6) = ? AND date < ? ORDER BY date DESC"
  ).all(mmdd, date);

  const colleagues = {};
  for (const c of db.prepare('SELECT id, name FROM colleagues').all()) colleagues[c.id] = c.name;

  const flashbacks = matches.map(s => {
    const crew = db.prepare(
      "SELECT * FROM colleague_shifts WHERE date = ? AND shift_type = 'shift' AND (store IS NULL OR store = '')"
    ).all(s.date)
      .filter(cs => overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0)
      .map(cs => colleagues[cs.colleague_id])
      .filter(Boolean);

    const note = db.prepare('SELECT note FROM calendar_notes WHERE date = ?').get(s.date);
    const clock = db.prepare('SELECT * FROM clock_entries WHERE date = ?').get(s.date);

    return {
      date: s.date,
      year: parseInt(s.date.slice(0, 4), 10),
      years_ago: year - parseInt(s.date.slice(0, 4), 10),
      day_name: DAYS[parseDate(s.date).getDay()],
      start_time: s.start_time,
      end_time: s.end_time,
      hours: round1(paidHours(s)),
      pay: round2(shiftPay(s) || 0),
      rate: s.hourly_rate,
      is_bank_holiday: !!s.is_bank_holiday,
      completed: !!s.completed,
      break_taken: s.break_taken,
      miles: s.distance_miles,
      crew,
      note: note ? note.note : (s.notes || null),
      clocked: clock ? { in: clock.clocked_in, out: clock.clocked_out } : null,
    };
  });

  // Leave taken on this date in past years is worth showing too — a fortnight in
  // Spain is at least as memorable as a Tuesday on the trade counter.
  const pastLeave = db.prepare(
    'SELECT * FROM leave_entries WHERE start_date <= ? AND end_date >= ? AND end_date < ?'
  ).all(date, date, date).map(l => ({
    ...l,
    year: parseInt(l.start_date.slice(0, 4), 10),
    years_ago: year - parseInt(l.start_date.slice(0, 4), 10),
  })).filter(l => {
    // Only the same calendar date, not any old overlapping range
    const from = l.start_date.slice(5), to = l.end_date.slice(5);
    return from <= mmdd && mmdd <= to;
  });

  // ── Milestones landing today ─────────────────────────────────────────────
  const milestones = [];

  const jobStart = getSetting('job_start_date', null);
  if (jobStart && jobStart.slice(5) === mmdd && jobStart < date) {
    const years = year - parseInt(jobStart.slice(0, 4), 10);
    milestones.push({ icon: '🎊', title: 'Work anniversary',
      detail: `${ordinal(years)} anniversary of starting at ${getSetting('employer', 'work')}.` });
  }

  const dob = getSetting('user_dob', null);
  if (dob && dob.slice(5) === mmdd) {
    milestones.push({ icon: '🎂', title: 'Your birthday',
      detail: `Happy birthday${getSetting('employee_name', '') ? ', ' + getSetting('employee_name', '') : ''}.` });
  }

  // Colleague birthdays are stored as a full date or an MM-DD fragment.
  for (const c of db.prepare("SELECT name, birthday FROM colleagues WHERE birthday IS NOT NULL AND birthday != ''").all()) {
    const b = String(c.birthday);
    const bMmdd = b.length >= 10 ? b.slice(5) : b.replace(/^-+/, '');
    if (bMmdd === mmdd) {
      milestones.push({ icon: '🎈', title: `${c.name}'s birthday`, detail: 'One of your colleagues is a year older today.' });
    }
  }

  if (jobStart) {
    const served = daysBetween(jobStart, date);
    // Round-number day counts are a small, silly delight
    if (served > 0 && served % 100 === 0) {
      milestones.push({ icon: '📌', title: `${served} days served`, detail: `Day ${served} since you started.` });
    }
  }

  // ── Summary line across all the years ────────────────────────────────────
  const totalPastHours = round1(flashbacks.reduce((t, f) => t + f.hours, 0));
  const totalPastPay   = round2(flashbacks.reduce((t, f) => t + f.pay, 0));

  const todayShifts = db.prepare('SELECT * FROM shifts WHERE date = ?').all(date);

  res.json({
    date,
    day_name: DAYS[parseDate(date).getDay()],
    pretty: `${day} ${MONTHS[month - 1]}`,
    today_shifts: todayShifts.map(s => ({
      start_time: s.start_time, end_time: s.end_time,
      hours: round1(paidHours(s)), pay: round2(shiftPay(s) || 0), completed: !!s.completed,
    })),
    flashbacks,
    past_leave: pastLeave,
    milestones,
    summary: {
      years_with_data: flashbacks.length,
      total_hours: totalPastHours,
      total_pay: totalPastPay,
    },
  });
});

module.exports = router;
