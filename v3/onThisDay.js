/* ─── 📼 On This Day (V3.0) ────────────────────────────────────────────────
   GET /api/v3/on-this-day[?date=YYYY-MM-DD]

   A flashback to the same calendar date in every previous year you have data
   for: the shift you worked, who you worked with, what you earned, and any note
   you left on it. Plus the milestones landing today — work anniversaries,
   colleague birthdays, and round-number totals you have just crossed.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, MONTHS, getSetting, localDateStr, parseDate, addDays, daysBetween,
  overlapMins, paidHours, shiftPay, round1, round2, toMins,
} = require('./helpers');

// How close a start/end time has to be to count as "the same shift" for the
// echo feature below — close enough to catch a slot that's drifted a little
// (06:45 vs 07:00) without matching every early shift you've ever worked.
const ECHO_WINDOW_MINS = 30;

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
  // Two ways to pick "the same day" in a past year: the literal calendar date
  // (what an anniversary or birthday means), or the nearest date with the same
  // day of the week (what a weekly rota pattern means — a retail Saturday last
  // year is a more useful comparison than whatever weekday 12 months back the
  // exact date happened to fall on). Both are offered; exact date stays the
  // default since milestones below are calendar-date events either way.
  const matchMode = req.query.match === 'weekday' ? 'weekday' : 'date';
  let matches;
  if (matchMode === 'weekday') {
    const todayDow = parseDate(date).getDay();
    const years = db.prepare('SELECT DISTINCT substr(date, 1, 4) AS y FROM shifts WHERE date < ?')
      .all(date).map(r => parseInt(r.y, 10));
    const candidateDates = [...new Set(years.map(y => {
      const anchor = `${y}-${mmdd}`;
      const anchorDow = parseDate(anchor).getDay();
      // Nudge to the same weekday within the anniversary week (±3 days) rather
      // than jump a full week away.
      let diff = (todayDow - anchorDow + 7) % 7;
      if (diff > 3) diff -= 7;
      return addDays(anchor, diff);
    }))].filter(d => d < date);
    const ph = candidateDates.map(() => '?').join(',') || "''";
    matches = candidateDates.length
      ? db.prepare(`SELECT * FROM shifts WHERE date IN (${ph}) ORDER BY date DESC`).all(...candidateDates)
      : [];
  } else {
    matches = db.prepare(
      "SELECT * FROM shifts WHERE substr(date, 6) = ? AND date < ? ORDER BY date DESC"
    ).all(mmdd, date);
  }

  const colleagues = {};
  for (const c of db.prepare('SELECT id, name FROM colleagues').all()) colleagues[c.id] = c.name;

  // Fetch the crew, notes and clock rows for every matching date in one query
  // each, rather than three per flashback. Same result, and it stops re-preparing
  // identical SQL inside the loop.
  const dates = matches.map(s => s.date);
  const placeholders = dates.map(() => '?').join(',') || "''";

  const crewByDate = {};
  if (dates.length) {
    for (const cs of db.prepare(
      `SELECT * FROM colleague_shifts
       WHERE date IN (${placeholders}) AND shift_type = 'shift' AND (store IS NULL OR store = '')`
    ).all(...dates)) {
      (crewByDate[cs.date] ||= []).push(cs);
    }
  }

  const noteByDate = {};
  const clockByDate = {};
  if (dates.length) {
    for (const n of db.prepare(`SELECT date, note FROM calendar_notes WHERE date IN (${placeholders})`).all(...dates)) {
      noteByDate[n.date] = n.note;
    }
    for (const c of db.prepare(`SELECT * FROM clock_entries WHERE date IN (${placeholders})`).all(...dates)) {
      clockByDate[c.date] = c;
    }
  }

  const flashbacks = matches.map(s => {
    const crew = (crewByDate[s.date] || [])
      .filter(cs => overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0)
      .map(cs => colleagues[cs.colleague_id])
      .filter(Boolean);

    const note = noteByDate[s.date] != null ? { note: noteByDate[s.date] } : null;
    const clock = clockByDate[s.date] || null;

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
  // Only pull leave that's already fully over (the JS filter below does the
  // actual "same calendar day" matching by comparing MM-DD, regardless of
  // year) — binding one param three times previously made "end_date >= date
  // AND end_date < date" mutually exclusive, so this never returned a row.
  const pastLeave = db.prepare(
    'SELECT * FROM leave_entries WHERE end_date < ?'
  ).all(date).map(l => ({
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
  const todayCrew = todayShifts.length
    ? db.prepare(
        `SELECT * FROM colleague_shifts WHERE date = ? AND shift_type = 'shift' AND (store IS NULL OR store = '')`
      ).all(date)
    : [];

  // ── Shift echoes ─────────────────────────────────────────────────────────
  // Not "same calendar date" like the flashbacks above, but "same shift" —
  // any past shift, on any date, in a different year, whose start and end
  // time both land within ECHO_WINDOW_MINS of today's. Two people asked for
  // this independently in the same breath: a way to spot "I've worked this
  // exact slot before" even when the calendar date doesn't line up, and it
  // doubles as a light data-quality net — a shift that's an exact-minute
  // echo of several others but sits 15 minutes off them all is worth a look.
  const shiftEchoes = todayShifts.map(shift => {
    const startMin = toMins(shift.start_time), endMin = toMins(shift.end_time);
    const candidates = db.prepare(
      "SELECT * FROM shifts WHERE date != ? AND substr(date,1,4) != ? ORDER BY date DESC"
    ).all(shift.date, shift.date.slice(0, 4));

    const echoes = candidates
      .map(c => ({
        c,
        startDiff: Math.abs(toMins(c.start_time) - startMin),
        endDiff: Math.abs(toMins(c.end_time) - endMin),
      }))
      .filter(({ startDiff, endDiff }) => startDiff <= ECHO_WINDOW_MINS && endDiff <= ECHO_WINDOW_MINS)
      .sort((a, b) => (a.startDiff + a.endDiff) - (b.startDiff + b.endDiff) || b.c.date.localeCompare(a.c.date))
      .map(({ c, startDiff, endDiff }) => ({
        date: c.date,
        year: parseInt(c.date.slice(0, 4), 10),
        years_ago: year - parseInt(c.date.slice(0, 4), 10),
        day_name: DAYS[parseDate(c.date).getDay()],
        start_time: c.start_time,
        end_time: c.end_time,
        exact: startDiff === 0 && endDiff === 0,
        start_diff_mins: startDiff,
        end_diff_mins: endDiff,
        hours: round1(paidHours(c)),
        pay: round2(shiftPay(c) || 0),
      }));

    return {
      shift: { start_time: shift.start_time, end_time: shift.end_time },
      exact_count: echoes.filter(e => e.exact).length,
      near_count: echoes.filter(e => !e.exact).length,
      echoes: echoes.slice(0, 20),
    };
  }).filter(e => e.echoes.length > 0);

  res.json({
    date,
    day_name: DAYS[parseDate(date).getDay()],
    pretty: `${day} ${MONTHS[month - 1]}`,
    match_mode: matchMode,
    today_shifts: todayShifts.map(s => ({
      start_time: s.start_time, end_time: s.end_time,
      hours: round1(paidHours(s)), pay: round2(shiftPay(s) || 0), completed: !!s.completed,
      crew: todayCrew
        .filter(cs => overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0)
        .map(cs => colleagues[cs.colleague_id])
        .filter(Boolean),
    })),
    flashbacks,
    past_leave: pastLeave,
    shift_echoes: shiftEchoes,
    milestones,
    summary: {
      years_with_data: flashbacks.length,
      total_hours: totalPastHours,
      total_pay: totalPastPay,
    },
  });
});

module.exports = router;
