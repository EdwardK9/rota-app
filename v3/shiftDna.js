/* ─── 🧬 Shift DNA (V3.0) ──────────────────────────────────────────────────
   GET /api/v3/shift-dna[?year=YYYY|all][&person=me|<colleagueId>]
   GET /api/v3/shift-dna/people   — who can be profiled

   Reads a rota like a personality test. Six traits are scored 0–100 from the
   shape of the shifts (when they start, how long they run, how much they vary,
   who they overlap), and the dominant pair picks an archetype.

   Works for colleagues as well as you. The two data sources differ in one way
   that matters: colleague_shifts carries no break information, so colleague
   hours are raw shift length while yours are paid hours. The response flags
   this so the client can say so rather than quietly comparing unlike numbers.

   Every trait is a plain percentage of that person's own shifts, so the profile
   is descriptive rather than a judgement.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, localDateStr, toMins, spanMins, overlapMins, paidHours, isWeekend, round1, clamp,
} = require('./helpers');

const router = express.Router();

/* The first archetype whose trait pair sits in the top three wins. */
const ARCHETYPES = [
  { traits: ['earlyBird', 'consistency'], icon: '🌅', name: 'The Opener',
    blurb: 'Lights on, shutters up. There before the store is awake, and fond of a routine.' },
  { traits: ['nightOwl', 'endurance'],    icon: '🌙', name: 'The Closer',
    blurb: 'Long evenings and last one out. Cashing up is basically the signature move.' },
  { traits: ['weekendLoad', 'social'],    icon: '⚔️', name: 'The Weekend Warrior',
    blurb: 'Saturdays and Sundays are the natural habitat, usually with a full crew around.' },
  { traits: ['endurance', 'consistency'], icon: '🐂', name: 'The Workhorse',
    blurb: 'Long shifts, same shape every week. Utterly relentless and completely dependable.' },
  // Renamed from "The Floater", which sounded like an insult rather than a
  // description of working every kind of shift with everyone.
  { traits: ['variety', 'social'],        icon: '🦎', name: 'The Chameleon',
    blurb: 'Fits into any shift with anyone. Never the same two weeks running, and knows the whole team.' },
  { traits: ['earlyBird', 'nightOwl'],    icon: '🔄', name: 'The Bookend',
    blurb: 'Opens one day, closes the next. That body clock deserves hazard pay.' },
  { traits: ['consistency', 'social'],    icon: '🧲', name: 'The Anchor',
    blurb: 'Same slot, same faces. The fixed point everyone else rotates around.' },
  { traits: ['variety', 'endurance'],     icon: '🎲', name: 'The Wildcard',
    blurb: 'Long ones, short ones, early, late — whatever the rota throws, it gets taken.' },
  { traits: ['earlyBird', 'social'],      icon: '☀️', name: 'The Morning Person',
    blurb: 'Early doors with company. Somehow cheerful about it, too.' },
  { traits: ['nightOwl', 'variety'],      icon: '🦉', name: 'The Night Shift',
    blurb: 'Late finishes in every shape and size. The evening rota belongs to them.' },
  { traits: ['weekendLoad', 'endurance'], icon: '🏔️', name: 'The Marathon',
    blurb: 'Long shifts when everyone else is off. The weekend is not a rest here.' },
  { traits: ['consistency', 'endurance'], icon: '⚙️', name: 'The Machine',
    blurb: 'Same long shift, week in week out. You could set a calendar by it.' },
];
const ARCHETYPE_FALLBACK = { icon: '⚖️', name: 'The All-Rounder',
  blurb: 'No single trait dominates — a bit of everything, all of it handled.' };

const TRAIT_META = {
  earlyBird:   { icon: '🌅', label: 'Early Bird',   desc: 'Share of shifts starting at or before 08:00.' },
  nightOwl:    { icon: '🌙', label: 'Night Owl',    desc: 'Share of shifts finishing at or after 19:00.' },
  weekendLoad: { icon: '📅', label: 'Weekend Load', desc: 'Share of shifts falling on a Saturday or Sunday.' },
  endurance:   { icon: '💪', label: 'Endurance',    desc: 'Average shift length, scaled against a 10-hour day.' },
  consistency: { icon: '🎯', label: 'Consistency',  desc: 'How tightly start times cluster together.' },
  variety:     { icon: '🎲', label: 'Variety',      desc: 'How many different start times are actually worked.' },
  social:      { icon: '👥', label: 'Sociability',  desc: 'Average number of people on shift at the same time.' },
};

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((t, v) => t + (v - mean) ** 2, 0) / values.length);
}

/** Who can be profiled: you, plus every colleague with enough shifts to say
 *  anything meaningful about. */
router.get('/shift-dna/people', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.left_date, COUNT(cs.id) AS shift_count
    FROM colleagues c
    JOIN colleague_shifts cs ON cs.colleague_id = c.id
      AND cs.shift_type = 'shift' AND (cs.store IS NULL OR cs.store = '')
    GROUP BY c.id
    HAVING shift_count >= 5
    ORDER BY c.name COLLATE NOCASE ASC
  `).all();

  res.json({
    people: [
      { id: 'me', name: 'You', shift_count: db.prepare('SELECT COUNT(*) AS c FROM shifts').get().c },
      ...rows.map(r => ({
        id: String(r.id), name: r.name, shift_count: r.shift_count,
        left: !!(r.left_date && r.left_date !== ''),
      })),
    ],
  });
});

router.get('/shift-dna', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const person = req.query.person && req.query.person !== 'me' ? String(req.query.person) : 'me';
  const today = localDateStr();
  const from = year ? `${year}-01-01` : '0000-01-01';
  const to   = year ? `${year}-12-31` : today;

  let entries, personName, hoursBasis;

  if (person === 'me') {
    // Every logged shift up to today, ticked complete or not — same rule the
    // rest of V3 uses, so the profile doesn't hinge on admin tidiness.
    entries = db.prepare(
      'SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC'
    ).all(from, to > today ? today : to)
      .map(s => ({ date: s.date, start_time: s.start_time, end_time: s.end_time, hours: paidHours(s) }));
    personName = 'You';
    hoursBasis = 'paid';
  } else {
    const colleague = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(person);
    if (!colleague) return res.status(404).json({ error: 'Colleague not found' });
    // No break data on colleague shifts, so hours are the raw rostered span.
    entries = db.prepare(`
      SELECT * FROM colleague_shifts
      WHERE colleague_id = ? AND date >= ? AND date <= ?
        AND shift_type = 'shift' AND (store IS NULL OR store = '')
      ORDER BY date ASC
    `).all(person, from, to > today ? today : to)
      .map(s => ({ date: s.date, start_time: s.start_time, end_time: s.end_time,
                   hours: spanMins(s.start_time, s.end_time) / 60 }));
    personName = colleague.name;
    hoursBasis = 'rostered';
  }

  const base = {
    year: year || 'all', person, person_name: personName, hours_basis: hoursBasis,
  };

  if (!entries.length) {
    return res.json({ ...base, shift_count: 0, traits: [], archetype: null, patterns: null });
  }

  const n = entries.length;
  const starts   = entries.map(s => toMins(s.start_time));
  const finishes = entries.map(s => toMins(s.start_time) + spanMins(s.start_time, s.end_time));
  const lengths  = entries.map(s => s.hours);

  // ── Sociability ──────────────────────────────────────────────────────────
  // Everyone else rostered at the same time: other colleagues, plus you when
  // profiling a colleague (you're part of their shop floor too).
  const colShifts = db.prepare(`
    SELECT * FROM colleague_shifts
    WHERE shift_type = 'shift' AND (store IS NULL OR store = '') AND date >= ? AND date <= ?
  `).all(from, to);
  const myShifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?').all(from, to);
  const byDate = {};
  for (const cs of colShifts) (byDate[cs.date] ||= []).push(cs);
  const myByDate = {};
  for (const s of myShifts) (myByDate[s.date] ||= []).push(s);

  let crewTotal = 0, busiestShift = null, busiestCrew = 0;
  for (const s of entries) {
    const crew = new Set();
    for (const cs of byDate[s.date] || []) {
      if (person !== 'me' && String(cs.colleague_id) === person) continue;   // not your own company
      if (overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time) > 0) crew.add('c' + cs.colleague_id);
    }
    if (person !== 'me') {
      for (const mine of myByDate[s.date] || []) {
        if (overlapMins(s.start_time, s.end_time, mine.start_time, mine.end_time) > 0) crew.add('me');
      }
    }
    crewTotal += crew.size;
    if (crew.size > busiestCrew) { busiestCrew = crew.size; busiestShift = s; }
  }
  const avgCrew = crewTotal / n;

  // ── Trait scores ─────────────────────────────────────────────────────────
  const avgLength = lengths.reduce((a, b) => a + b, 0) / n;
  const startSpread = stdDev(starts);
  const distinctStarts = new Set(entries.map(s => s.start_time)).size;

  const scores = {
    earlyBird:   round1((starts.filter(m => m <= 8 * 60).length / n) * 100),
    nightOwl:    round1((finishes.filter(m => m >= 19 * 60).length / n) * 100),
    weekendLoad: round1((entries.filter(s => isWeekend(s.date)).length / n) * 100),
    endurance:   round1(clamp((avgLength / 10) * 100, 0, 100)),
    consistency: round1(clamp(100 - (startSpread / 120) * 100, 0, 100)),
    variety:     round1(clamp((distinctStarts / 8) * 100, 0, 100)),
    social:      round1(clamp((avgCrew / 5) * 100, 0, 100)),
  };

  const traits = Object.entries(scores)
    .map(([key, score]) => ({ key, score, ...TRAIT_META[key] }))
    .sort((a, b) => b.score - a.score);

  const topKeys = traits.slice(0, 3).map(t => t.key);
  const strong = traits.filter(t => t.score >= 40).map(t => t.key);
  const def = ARCHETYPES.find(a => a.traits.every(t => topKeys.includes(t) && strong.includes(t)))
           || ARCHETYPES.find(a => a.traits.every(t => topKeys.includes(t)));

  const archetype = def
    ? { icon: def.icon, name: def.name, blurb: def.blurb, based_on: def.traits.map(t => TRAIT_META[t].label) }
    : { ...ARCHETYPE_FALLBACK, based_on: [] };

  const dowCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const s of entries) dowCounts[new Date(s.date + 'T12:00:00').getDay()] += 1;

  const startBuckets = {};
  for (const s of entries) startBuckets[s.start_time] = (startBuckets[s.start_time] || 0) + 1;

  const hourHistogram = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: entries.filter(s => {
      const st = toMins(s.start_time), en = st + spanMins(s.start_time, s.end_time);
      return st < (h + 1) * 60 && en > h * 60;
    }).length,
  }));

  const avgStartMins = starts.reduce((a, b) => a + b, 0) / n;

  res.json({
    ...base,
    shift_count: n,
    traits,
    archetype,
    patterns: {
      avg_start: `${String(Math.floor(avgStartMins / 60)).padStart(2, '0')}:${String(Math.round(avgStartMins % 60)).padStart(2, '0')}`,
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
