/* ─── 🥊 Head to Head (V3.0) ───────────────────────────────────────────────
   GET /api/v3/head-to-head?colleague=<id>[&year=YYYY|all]

   You against one colleague, across the metrics both sides can actually be
   measured on. Shifts, hours, weekends, early starts, late finishes, days
   worked — plus how much of it you spent on the same shop floor.

   Pay is deliberately excluded. The app knows colleague pay profiles, but
   turning that into a "who earns more" scoreboard is a different and much
   less comfortable thing than comparing rotas.

   Colleague hours are rostered spans (no break data), yours are paid hours, so
   the response reports both a like-for-like rostered comparison and your paid
   figure, rather than quietly mixing the two.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, toMins, spanMins, overlapMins, isWeekend, round1,
} = require('./helpers');

const router = express.Router();

/** Normalises either source into one shape, with hours as the rostered span so
 *  both sides are measured the same way. */
function profileOf(entries) {
  const dates = new Set(entries.map(e => e.date));
  const spans = entries.map(e => spanMins(e.start_time, e.end_time));
  const starts = entries.map(e => toMins(e.start_time));
  const finishes = entries.map((e, i) => starts[i] + spans[i]);
  const totalMins = spans.reduce((a, b) => a + b, 0);

  const byDow = [0, 0, 0, 0, 0, 0, 0];
  for (const e of entries) byDow[new Date(e.date + 'T12:00:00').getDay()] += 1;

  return {
    shifts: entries.length,
    days_worked: dates.size,
    rostered_hours: round1(totalMins / 60),
    avg_shift_hours: entries.length ? round1(totalMins / 60 / entries.length) : 0,
    weekend_shifts: entries.filter(e => isWeekend(e.date)).length,
    early_starts: starts.filter(m => m <= 7 * 60).length,
    late_finishes: finishes.filter(m => m >= 20 * 60).length,
    earliest_start: starts.length ? Math.min(...starts) : null,
    latest_finish: finishes.length ? Math.max(...finishes) : null,
    longest_shift: spans.length ? round1(Math.max(...spans) / 60) : 0,
    by_dow: byDow,
    dates,
  };
}

const fmtTime = mins => (mins == null ? '—'
  : `${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);

router.get('/head-to-head', (req, res) => {
  const today = localDateStr();
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const from = year ? `${year}-01-01` : '0000-01-01';
  const to = year ? (`${year}-12-31` > today ? today : `${year}-12-31`) : today;

  const colleagueId = req.query.colleague;
  if (!colleagueId) return res.status(400).json({ error: 'colleague id is required' });
  const colleague = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(colleagueId);
  if (!colleague) return res.status(404).json({ error: 'Colleague not found' });

  const mine = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC').all(from, to);
  const theirs = db.prepare(`
    SELECT * FROM colleague_shifts
    WHERE colleague_id = ? AND date >= ? AND date <= ?
      AND shift_type = 'shift' AND (store IS NULL OR store = '')
    ORDER BY date ASC
  `).all(colleagueId, from, to);

  const me = profileOf(mine);
  const them = profileOf(theirs);

  // Time actually spent together
  const theirsByDate = {};
  for (const t of theirs) (theirsByDate[t.date] ||= []).push(t);
  let togetherMins = 0, sharedShifts = 0;
  const sharedDates = [];
  for (const s of mine) {
    let dayMins = 0;
    for (const t of theirsByDate[s.date] || []) {
      dayMins += overlapMins(s.start_time, s.end_time, t.start_time, t.end_time);
    }
    if (dayMins > 0) { togetherMins += dayMins; sharedShifts++; sharedDates.push(s.date); }
  }

  /* Each row is one comparable measure. `better` says which way is "more", not
     which is good — working more weekends isn't a win, it's just more. */
  const rows = [
    { key: 'shifts',        label: 'Shifts worked',      icon: '📋', mine: me.shifts,          theirs: them.shifts },
    { key: 'days',          label: 'Days worked',        icon: '📅', mine: me.days_worked,     theirs: them.days_worked },
    { key: 'hours',         label: 'Rostered hours',     icon: '⏱️', mine: me.rostered_hours,  theirs: them.rostered_hours, unit: 'h' },
    { key: 'avg',           label: 'Average shift',      icon: '📏', mine: me.avg_shift_hours, theirs: them.avg_shift_hours, unit: 'h' },
    { key: 'longest',       label: 'Longest shift',      icon: '🥵', mine: me.longest_shift,   theirs: them.longest_shift, unit: 'h' },
    { key: 'weekends',      label: 'Weekend shifts',     icon: '⚔️', mine: me.weekend_shifts,  theirs: them.weekend_shifts },
    { key: 'early',         label: 'Early starts (≤07:00)', icon: '🌅', mine: me.early_starts, theirs: them.early_starts },
    { key: 'late',          label: 'Late finishes (≥20:00)', icon: '🌙', mine: me.late_finishes, theirs: them.late_finishes },
  ].map(r => ({
    ...r,
    leader: Math.abs(r.mine - r.theirs) < 0.05 ? 'tie' : (r.mine > r.theirs ? 'me' : 'them'),
    diff: round1(Math.abs(r.mine - r.theirs)),
  }));

  const timeRows = [
    { key: 'earliest', label: 'Earliest start', icon: '🌄',
      mine: fmtTime(me.earliest_start), theirs: fmtTime(them.earliest_start),
      leader: me.earliest_start == null || them.earliest_start == null ? 'tie'
        : me.earliest_start === them.earliest_start ? 'tie'
        : (me.earliest_start < them.earliest_start ? 'me' : 'them') },
    { key: 'latest', label: 'Latest finish', icon: '🌒',
      mine: fmtTime(me.latest_finish), theirs: fmtTime(them.latest_finish),
      leader: me.latest_finish == null || them.latest_finish == null ? 'tie'
        : me.latest_finish === them.latest_finish ? 'tie'
        : (me.latest_finish > them.latest_finish ? 'me' : 'them') },
  ];

  const wins = rows.filter(r => r.leader === 'me').length;
  const losses = rows.filter(r => r.leader === 'them').length;

  res.json({
    year: year || 'all',
    range: { from, to },
    colleague: { id: colleague.id, name: colleague.name, job_tier: colleague.job_tier },
    rows,
    time_rows: timeRows,
    tally: { mine: wins, theirs: losses, ties: rows.length - wins - losses },
    together: {
      shifts: sharedShifts,
      hours: round1(togetherMins / 60),
      pct_of_my_shifts: me.shifts ? round1((sharedShifts / me.shifts) * 100) : 0,
      pct_of_their_shifts: them.shifts ? round1((sharedShifts / them.shifts) * 100) : 0,
      last_together: sharedDates.length ? sharedDates[sharedDates.length - 1] : null,
    },
    by_dow: DAYS.map((day, i) => ({ day, short: day.slice(0, 3), mine: me.by_dow[i], theirs: them.by_dow[i] })),
    note: 'Hours are rostered spans on both sides so the comparison is like-for-like — ' +
          'colleague shifts carry no break data. Pay is deliberately not compared.',
    my_paid_hours: round1(mine.reduce((t, s) => t + (s.hours_paid != null ? s.hours_paid : 0), 0)),
    today,
  });
});

module.exports = router;
