/* ─── 😤 Annoying Shifts (V3.0) ────────────────────────────────────────────
   GET /api/v3/annoying-shifts[?year=YYYY|all]

   Counts the shifts that cost more than they pay: short ones, ones stranded in
   the middle of the day, short evenings, split days and quick turnarounds.

   A shift can fall into several categories (a 2h midday shift is both "under 3h"
   and "midday"), so category counts overlap by design; `annoying_total` counts
   each shift once. All thresholds live in RULES so they're easy to retune.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, parseDate, toMins, spanMins, paidHours, round1, pct,
} = require('./helpers');

const router = express.Router();

const RULES = {
  shortUnderHours: 3,        // anything under this is annoying on length alone
  shortMaxHours: 4.5,        // "short" for the time-of-day categories below
  middayStartAfter: '09:00', // a midday shift neither opens nor closes
  middayEndBefore: '16:00',
  eveningEndAfter: '19:00',  // short shift ending at/after this is a short evening
  earlyStartBefore: '09:00', // short shift starting before this is a short early
  quickTurnaroundHours: 11,  // less than this between shifts is a quick turnaround
};

const CATEGORIES = [
  { key: 'under3',     icon: '⏱️', label: 'Under 3 hours',
    desc: `Paid length under ${RULES.shortUnderHours}h — barely worth getting changed for.` },
  { key: 'midday',     icon: '🕛', label: 'Middle of the day',
    desc: `Up to ${RULES.shortMaxHours}h, starting ${RULES.middayStartAfter} or later and finishing by ${RULES.middayEndBefore}. Neither opens nor closes, and splits the day in two.` },
  { key: 'evening',    icon: '🌆', label: 'Short evening',
    desc: `Up to ${RULES.shortMaxHours}h finishing at ${RULES.eveningEndAfter} or later.` },
  { key: 'early',      icon: '🌅', label: 'Short early',
    desc: `Up to ${RULES.shortMaxHours}h starting before ${RULES.earlyStartBefore}.` },
  { key: 'split',      icon: '✂️', label: 'Split day',
    desc: 'More than one shift on the same day, with a gap in between.' },
  { key: 'turnaround', icon: '🔁', label: 'Quick turnaround',
    desc: `Starts less than ${RULES.quickTurnaroundHours}h after the previous shift finished.` },
];

router.get('/annoying-shifts', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const today = localDateStr();
  const from = year ? `${year}-01-01` : '0000-01-01';
  const to = year && `${year}-12-31` < today ? `${year}-12-31` : today;

  // Fetch from the day before `from` so the first shift's turnaround can be judged.
  const all = db.prepare('SELECT * FROM shifts WHERE date <= ? ORDER BY date ASC, start_time ASC').all(to);

  const perDay = {};
  for (const s of all) (perDay[s.date] ||= []).push(s);

  const counts = Object.fromEntries(CATEGORIES.map(c => [c.key, 0]));
  const byMonth = {}, byDow = Array.from({ length: 7 }, () => ({ annoying: 0, shifts: 0 }));
  const annoyingList = [];
  let shiftCount = 0;

  let prev = null;   // previous shift in date order, for turnaround
  for (const s of all) {
    const before = prev;
    prev = s;
    if (s.date < from) continue;

    shiftCount++;
    const hours = paidHours(s);
    const start = toMins(s.start_time), end = toMins(s.end_time);
    const tags = [];

    if (hours < RULES.shortUnderHours) tags.push('under3');
    if (hours <= RULES.shortMaxHours) {
      if (start >= toMins(RULES.middayStartAfter) && end <= toMins(RULES.middayEndBefore)) tags.push('midday');
      if (end >= toMins(RULES.eveningEndAfter) && end > start) tags.push('evening');
      if (start < toMins(RULES.earlyStartBefore)) tags.push('early');
    }
    if (perDay[s.date].length > 1) tags.push('split');

    if (before) {
      const gapMins = (parseDate(s.date) - parseDate(before.date)) / 60000
        + start - (toMins(before.start_time) + spanMins(before.start_time, before.end_time));
      if (gapMins >= 0 && gapMins < RULES.quickTurnaroundHours * 60) tags.push('turnaround');
    }

    const dow = parseDate(s.date).getDay();
    byDow[dow].shifts++;
    if (!tags.length) continue;

    tags.forEach(t => counts[t]++);
    byDow[dow].annoying++;
    const m = s.date.slice(0, 7);
    (byMonth[m] ||= { month: m, annoying: 0, shifts: 0 }).annoying++;
    annoyingList.push({
      date: s.date, start_time: s.start_time, end_time: s.end_time, hours: round1(hours), tags,
    });
  }
  // Month totals need every shift, not just annoying ones.
  for (const s of all) {
    if (s.date < from) continue;
    const m = s.date.slice(0, 7);
    if (byMonth[m]) byMonth[m].shifts++;
  }

  res.json({
    year: year || 'all',
    rules: RULES,
    shift_count: shiftCount,
    annoying_total: annoyingList.length,
    annoying_pct: pct(annoyingList.length, shiftCount),
    categories: CATEGORIES.map(c => ({
      ...c, count: counts[c.key], pct: pct(counts[c.key], shiftCount),
    })),
    by_month: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
    by_dow: byDow.map((x, i) => ({ day: DAYS[i], short: DAYS[i].slice(0, 3), ...x })),
    recent: annoyingList.slice(-40).reverse(),
  });
});

module.exports = router;
