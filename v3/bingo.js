/* ─── 🎲 Rota Bingo (V3.0) ─────────────────────────────────────────────────
   GET /api/v3/bingo[?week=YYYY-MM-DD]

   A 5×5 bingo card for the working week, where every square ticks itself from
   real data — worked a Sunday, opened and closed the same week, skipped a
   break, shared a shift with five different people, and so on.

   The card is deterministic per week: the same week always deals the same 24
   squares (seeded shuffle), so it can't be re-rolled until a card is favourable,
   and a card you looked at on Monday still looks the same on Friday.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, addDays, mondayOf, parseDate,
  toMins, spanMins, overlapMins, paidHours, shiftPay, contractHoursForDate, round1, round2,
} = require('./helpers');

const router = express.Router();

/* Every square is a predicate over the week's facts. Keep the pool comfortably
   larger than 24 so different weeks genuinely deal different cards. */
const SQUARES = [
  { code: 'sunday',      icon: '⛪', text: 'Worked a Sunday',            test: f => f.dows.includes(0) },
  { code: 'saturday',    icon: '🛒', text: 'Worked a Saturday',          test: f => f.dows.includes(6) },
  { code: 'both_weekend',icon: '😤', text: 'Worked the whole weekend',   test: f => f.dows.includes(0) && f.dows.includes(6) },
  { code: 'opener',      icon: '🌅', text: 'Opened the store',           test: f => f.earliestStart != null && f.earliestStart <= 7 * 60 },
  { code: 'closer',      icon: '🌙', text: 'Closed the store',           test: f => f.latestFinish != null && f.latestFinish >= 20 * 60 },
  { code: 'clopen',      icon: '🔄', text: 'Closed then opened the next day', test: f => f.clopening },
  { code: 'long_shift',  icon: '🥵', text: 'An 8-hour-plus shift',       test: f => f.longestShift >= 8 },
  { code: 'short_shift', icon: '🐁', text: 'A shift under 4 hours',      test: f => f.shortestShift != null && f.shortestShift < 4 },
  { code: 'four_days',   icon: '4️⃣', text: 'Worked 4 days or more',      test: f => f.daysWorked >= 4 },
  { code: 'five_days',   icon: '5️⃣', text: 'Worked 5 days or more',      test: f => f.daysWorked >= 5 },
  { code: 'three_row',   icon: '🔁', text: '3 days in a row',            test: f => f.longestRun >= 3 },
  { code: 'over_contract',icon: '📈',text: 'Beat your contracted hours', test: f => f.contracted > 0 && f.hours > f.contracted },
  { code: 'ton_up',      icon: '💯', text: 'Earned £100 in a single shift', test: f => f.bestShiftPay >= 100 },
  { code: 'full_breaks', icon: '☕', text: 'Took every break in full',   test: f => f.completed > 0 && f.fullBreaks === f.completed },
  { code: 'skipped',     icon: '🚫', text: 'Skipped a break',            test: f => f.skippedBreaks > 0 },
  { code: 'busy_crew',   icon: '👥', text: 'Worked with 5+ colleagues',  test: f => f.distinctCrew >= 5 },
  { code: 'solo',        icon: '🧍', text: 'A shift with nobody else on',test: f => f.soloShift },
  { code: 'punctual',    icon: '⏰', text: 'Clocked in early every day', test: f => f.clockIns > 0 && f.lateClockIns === 0 },
  { code: 'bank_hol',    icon: '🎆', text: 'Worked a bank holiday',      test: f => f.bankHoliday },
  { code: 'twenty_miles',icon: '🚗', text: '20+ miles of commuting',     test: f => f.miles >= 20 },
  { code: 'monday_blues',icon: '😑', text: 'Started the week on a Monday', test: f => f.dows.includes(1) },
  { code: 'midweek_off', icon: '🛌', text: 'Had a midweek day off',      test: f => f.midweekOff },
  { code: 'double_digit',icon: '🔟', text: '10+ hours in two days',      test: f => f.bestTwoDay >= 10 },
  { code: 'note_left',   icon: '📝', text: 'Left a note on a day',       test: f => f.notes > 0 },
  { code: 'leave_day',   icon: '🏖️', text: 'Took leave this week',       test: f => f.leaveDays > 0 },
  { code: 'no_weekend',  icon: '🎉', text: 'Whole weekend off',          test: f => !f.dows.includes(0) && !f.dows.includes(6) },
  { code: 'early_finish',icon: '🏃', text: 'Finished before 3pm once',   test: f => f.earliestFinish != null && f.earliestFinish <= 15 * 60 },
  { code: 'big_week',    icon: '💰', text: 'Earned £200 across the week',test: f => f.pay >= 200 },
];

/** Deterministic 32-bit hash of a string — seeds the per-week shuffle. */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, and stable across Node versions (unlike sorting
 *  by Math.random(), which would re-deal the card on every refresh). */
function seededShuffle(items, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything the square predicates need, computed once for the week. */
function weekFacts(monday) {
  const sunday = addDays(monday, 6);
  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC'
  ).all(monday, sunday);

  const dates = [...new Set(shifts.map(s => s.date))].sort();
  const dows = [...new Set(shifts.map(s => parseDate(s.date).getDay()))];

  const starts   = shifts.map(s => toMins(s.start_time));
  const finishes = shifts.map(s => toMins(s.start_time) + spanMins(s.start_time, s.end_time));
  const lengths  = shifts.map(s => paidHours(s));

  // Longest consecutive run inside the week
  let longestRun = 0, run = 0, prev = null;
  for (const d of dates) {
    run = prev && Math.round((parseDate(d) - parseDate(prev)) / 86400000) === 1 ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
    prev = d;
  }

  // Close-then-open on consecutive days
  let clopening = false;
  for (let i = 1; i < shifts.length; i++) {
    const a = shifts[i - 1], b = shifts[i];
    if (Math.round((parseDate(b.date) - parseDate(a.date)) / 86400000) !== 1) continue;
    const aEnd = toMins(a.start_time) + spanMins(a.start_time, a.end_time);
    if (aEnd >= 20 * 60 && toMins(b.start_time) <= 8 * 60) clopening = true;
  }

  // Crew overlap
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE date >= ? AND date <= ? AND shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all(monday, sunday);
  const crew = new Set();
  let soloShift = false;
  for (const s of shifts) {
    let count = 0;
    for (const cs of colShifts) {
      if (cs.date !== s.date) continue;
      if (overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0) { crew.add(cs.colleague_id); count++; }
    }
    if (count === 0) soloShift = true;
  }

  // Clock-ins
  const clocks = db.prepare(
    'SELECT * FROM clock_entries WHERE date >= ? AND date <= ? AND clocked_in IS NOT NULL'
  ).all(monday, sunday);
  let lateClockIns = 0;
  for (const c of clocks) {
    const s = shifts.find(x => x.date === c.date);
    if (s && toMins(c.clocked_in) > toMins(s.start_time) + 5) lateClockIns++;
  }

  // Best rolling two-day hours total
  let bestTwoDay = 0;
  for (let i = 0; i < 6; i++) {
    const d1 = addDays(monday, i), d2 = addDays(monday, i + 1);
    const total = shifts.filter(s => s.date === d1 || s.date === d2).reduce((t, s) => t + paidHours(s), 0);
    bestTwoDay = Math.max(bestTwoDay, total);
  }

  // Midweek (Mon–Fri) day with no shift
  let midweekOff = false;
  for (let i = 0; i < 5; i++) if (!dates.includes(addDays(monday, i))) midweekOff = true;

  const notes = db.prepare(
    'SELECT COUNT(*) AS c FROM calendar_notes WHERE date >= ? AND date <= ?'
  ).get(monday, sunday).c;

  const leaveDays = db.prepare(
    'SELECT COUNT(*) AS c FROM leave_entries WHERE start_date <= ? AND end_date >= ?'
  ).get(sunday, monday).c;

  const completed = shifts.filter(s => s.completed);

  return {
    monday, sunday, shifts,
    daysWorked: dates.length,
    dows,
    hours: round1(shifts.reduce((t, s) => t + paidHours(s), 0)),
    pay: round2(shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0)),
    miles: round1(shifts.reduce((t, s) => t + (s.distance_miles || 0) * 2, 0)),
    contracted: contractHoursForDate(monday) || 0,
    earliestStart: starts.length ? Math.min(...starts) : null,
    latestFinish: finishes.length ? Math.max(...finishes) : null,
    earliestFinish: finishes.length ? Math.min(...finishes) : null,
    longestShift: lengths.length ? Math.max(...lengths) : 0,
    shortestShift: lengths.length ? Math.min(...lengths) : null,
    bestShiftPay: shifts.length ? Math.max(...shifts.map(s => shiftPay(s) || 0)) : 0,
    bestTwoDay: round1(bestTwoDay),
    longestRun, clopening, midweekOff, soloShift,
    distinctCrew: crew.size,
    completed: completed.length,
    fullBreaks: completed.filter(s => s.break_taken === 'full').length,
    skippedBreaks: completed.filter(s => s.break_taken === 'none' || s.break_taken === 'partial').length,
    clockIns: clocks.length,
    lateClockIns,
    bankHoliday: shifts.some(s => s.is_bank_holiday),
    notes,
    leaveDays,
  };
}

/** Rows, columns and both diagonals of a 5×5 card, as index arrays. */
function winningLines() {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
}

router.get('/bingo', (req, res) => {
  const week = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : localDateStr();
  const monday = mondayOf(week);
  const facts = weekFacts(monday);

  // 24 dealt squares plus a free centre — the classic layout.
  const dealt = seededShuffle(SQUARES, hashSeed(monday)).slice(0, 24);
  const cells = [];
  for (let i = 0; i < 25; i++) {
    if (i === 12) {
      cells.push({ code: 'free', icon: '⭐', text: 'Free square', ticked: true, free: true });
      continue;
    }
    const sq = dealt[i < 12 ? i : i - 1];
    let ticked = false;
    try { ticked = !!sq.test(facts); } catch (_) { ticked = false; }
    cells.push({ code: sq.code, icon: sq.icon, text: sq.text, ticked, free: false });
  }

  const lines = winningLines();
  const completedLines = lines.filter(line => line.every(i => cells[i].ticked));
  const winningCells = new Set(completedLines.flat());
  cells.forEach((c, i) => { c.winning = winningCells.has(i); });

  const tickedCount = cells.filter(c => c.ticked).length;

  res.json({
    week: { monday, sunday: facts.sunday },
    cells,
    lines_complete: completedLines.length,
    full_house: tickedCount === 25,
    ticked: tickedCount,
    total: 25,
    summary: {
      days_worked: facts.daysWorked,
      hours: facts.hours,
      pay: facts.pay,
      contracted: facts.contracted,
      colleagues: facts.distinctCrew,
      days: DAYS,
    },
  });
});

module.exports = router;
module.exports.weekFacts = weekFacts;
