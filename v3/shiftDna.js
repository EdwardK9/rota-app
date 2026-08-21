/* ─── 🧬 Shift DNA (V3.0) ──────────────────────────────────────────────────
   GET /api/v3/shift-dna[?year=YYYY|all]

   Reads your rota like a personality test. Six traits are scored 0–100 from the
   shape of your shifts (when they start, how long they run, how much they vary,
   who you work with), and the dominant pair picks an archetype — "The Opener",
   "The Closer", "The Weekend Warrior" and so on.

   Every trait is a plain percentage of your own shifts, so the profile is
   descriptive rather than a judgement: high "Variety" just means your start
   times move around a lot, not that anything is wrong.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, toMins, spanMins, overlapMins, paidHours, isWeekend, round1, clamp,
} = require('./helpers');

const router = express.Router();

/* Each archetype claims a trait pair. The first match on the two strongest
   traits wins; ARCHETYPE_FALLBACK covers a flat, no-strong-trait profile. */
const ARCHETYPES = [
  { traits: ['earlyBird', 'consistency'], icon: '🌅', name: 'The Opener',
    blurb: 'Lights on, shutters up. You are there before the store is awake, and you like your routine.' },
  { traits: ['nightOwl', 'endurance'],    icon: '🌙', name: 'The Closer',
    blurb: 'Long evenings and last one out. Cashing up is basically your signature move.' },
  { traits: ['weekendLoad', 'social'],    icon: '⚔️', name: 'The Weekend Warrior',
    blurb: 'Saturdays and Sundays are your natural habitat, usually with a full crew around you.' },
  { traits: ['endurance', 'consistency'], icon: '🐂', name: 'The Workhorse',
    blurb: 'Long shifts, same shape every week. Utterly relentless and completely dependable.' },
  { traits: ['variety', 'social'],        icon: '🦋', name: 'The Floater',
    blurb: 'Never the same two weeks running, and you have worked with just about everyone.' },
  { traits: ['earlyBird', 'nightOwl'],    icon: '🔄', name: 'The Bookend',
    blurb: 'Opens one day, closes the next. Your body clock deserves hazard pay.' },
  { traits: ['consistency', 'social'],    icon: '🧲', name: 'The Anchor',
    blurb: 'Same slot, same faces. You are the fixed point everyone else rotates around.' },
  { traits: ['variety', 'endurance'],     icon: '🎲', name: 'The Wildcard',
    blurb: 'Long ones, short ones, early, late — whatever the rota throws, you take it.' },
  { traits: ['earlyBird', 'social'],      icon: '☀️', name: 'The Morning Person',
    blurb: 'Early doors with company. Somehow cheerful about it, too.' },
  { traits: ['nightOwl', 'variety'],      icon: '🦉', name: 'The Night Shift',
    blurb: 'Late finishes in every shape and size. The evening rota is yours.' },
];
const ARCHETYPE_FALLBACK = { icon: '⚖️', name: 'The All-Rounder',
  blurb: 'No single trait dominates — you get handed a bit of everything and handle all of it.' };

const TRAIT_META = {
  earlyBird:   { icon: '🌅', label: 'Early Bird',  desc: 'Share of shifts starting at or before 08:00.' },
  nightOwl:    { icon: '🌙', label: 'Night Owl',   desc: 'Share of shifts finishing at or after 19:00.' },
  weekendLoad: { icon: '📅', label: 'Weekend Load',desc: 'Share of shifts falling on a Saturday or Sunday.' },
  endurance:   { icon: '💪', label: 'Endurance',   desc: 'Average shift length, scaled against a 10-hour day.' },
  consistency: { icon: '🎯', label: 'Consistency', desc: 'How tightly your start times cluster together.' },
  variety:     { icon: '🎲', label: 'Variety',     desc: 'How many different start times you actually work.' },
  social:      { icon: '👥', label: 'Sociability', desc: 'Average number of colleagues overlapping your shifts.' },
};

/** Population standard deviation, in minutes. */
function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / values.length);
}

router.get('/shift-dna', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const shifts = year
    ? db.prepare('SELECT * FROM shifts WHERE completed = 1 AND date >= ? AND date <= ? ORDER BY date ASC')
        .all(`${year}-01-01`, `${year}-12-31`)
    : db.prepare('SELECT * FROM shifts WHERE completed = 1 ORDER BY date ASC').all();

  if (!shifts.length) {
    return res.json({ year: year || 'all', shift_count: 0, traits: [], archetype: null, patterns: null });
  }

  const n = shifts.length;
  const starts   = shifts.map(s => toMins(s.start_time));
  const finishes = shifts.map(s => toMins(s.start_time) + spanMins(s.start_time, s.end_time));
  const lengths  = shifts.map(s => paidHours(s));

  // ── Sociability: average distinct colleagues overlapping each shift ───────
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all();
  const colByDate = {};
  for (const cs of colShifts) (colByDate[cs.date] ||= []).push(cs);
  let crewTotal = 0, busiestShift = null, busiestCrew = 0;
  for (const s of shifts) {
    const crew = new Set();
    for (const cs of colByDate[s.date] || []) {
      if (overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0) crew.add(cs.colleague_id);
    }
    crewTotal += crew.size;
    if (crew.size > busiestCrew) { busiestCrew = crew.size; busiestShift = s; }
  }
  const avgCrew = crewTotal / n;

  // ── Trait scores ─────────────────────────────────────────────────────────
  const avgLength = lengths.reduce((a, b) => a + b, 0) / n;
  const startSpread = stdDev(starts);          // minutes
  const distinctStarts = new Set(shifts.map(s => s.start_time)).size;

  const scores = {
    earlyBird:   round1((starts.filter(m => m <= 8 * 60).length / n) * 100),
    nightOwl:    round1((finishes.filter(m => m >= 19 * 60).length / n) * 100),
    weekendLoad: round1((shifts.filter(s => isWeekend(s.date)).length / n) * 100),
    // A 10-hour shift is the practical ceiling for retail, so that's full marks.
    endurance:   round1(clamp((avgLength / 10) * 100, 0, 100)),
    // Two hours of start-time spread is treated as maximally scattered.
    consistency: round1(clamp(100 - (startSpread / 120) * 100, 0, 100)),
    // Eight or more different start times reads as a fully varied pattern.
    variety:     round1(clamp((distinctStarts / 8) * 100, 0, 100)),
    // Five overlapping colleagues is a busy shop floor.
    social:      round1(clamp((avgCrew / 5) * 100, 0, 100)),
  };

  const traits = Object.entries(scores)
    .map(([key, score]) => ({ key, score, ...TRAIT_META[key] }))
    .sort((a, b) => b.score - a.score);

  // ── Archetype: first definition whose pair sits in your top three ─────────
  const topKeys = traits.slice(0, 3).map(t => t.key);
  const strong = traits.filter(t => t.score >= 40).map(t => t.key);
  const archetypeDef = ARCHETYPES.find(a =>
    a.traits.every(t => topKeys.includes(t) && strong.includes(t))
  ) || ARCHETYPES.find(a => a.traits.every(t => topKeys.includes(t)));

  const archetype = archetypeDef
    ? { icon: archetypeDef.icon, name: archetypeDef.name, blurb: archetypeDef.blurb,
        based_on: archetypeDef.traits.map(t => TRAIT_META[t].label) }
    : { ...ARCHETYPE_FALLBACK, based_on: [] };

  // ── Supporting patterns ──────────────────────────────────────────────────
  const dowCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const s of shifts) dowCounts[new Date(s.date + 'T12:00:00').getDay()] += 1;

  const startBuckets = {};
  for (const s of shifts) startBuckets[s.start_time] = (startBuckets[s.start_time] || 0) + 1;

  const hourHistogram = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    // Hours you are typically on the clock, across all shifts
    count: shifts.filter(s => {
      const st = toMins(s.start_time), en = st + spanMins(s.start_time, s.end_time);
      return st < (h + 1) * 60 && en > h * 60;
    }).length,
  }));

  res.json({
    year: year || 'all',
    shift_count: n,
    traits,
    archetype,
    patterns: {
      avg_start: `${String(Math.floor(starts.reduce((a, b) => a + b, 0) / n / 60)).padStart(2, '0')}:${String(Math.round((starts.reduce((a, b) => a + b, 0) / n) % 60)).padStart(2, '0')}`,
      avg_length_hours: round1(avgLength),
      start_spread_mins: Math.round(startSpread),
      distinct_start_times: distinctStarts,
      avg_colleagues: round1(avgCrew),
      busiest_shift: busiestShift ? { date: busiestShift.date, crew: busiestCrew } : null,
      by_dow: dowCounts.map((count, i) => ({ day: DAYS[i], short: DAYS[i].slice(0, 3), count })),
      top_start_times: Object.entries(startBuckets)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([time, count]) => ({ time, count, pct: round1((count / n) * 100) })),
      hour_histogram: hourHistogram,
    },
  });
});

module.exports = router;
