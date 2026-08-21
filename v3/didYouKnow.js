/* ─── 🎲 Did You Know (V3.0) ───────────────────────────────────────────────
   GET /api/v3/did-you-know[?seed=N]

   A deck of oddball facts pulled out of your own data — the stuff no view is
   ever going to show you on purpose. How many times you've worked with someone
   without ever sharing a Monday, the day of the week you've never once started
   before 9am, how far you've driven in units of the M25.

   Every fact declares whether it can be generated from the data available, so
   a thin history returns fewer facts rather than made-up ones. The deck is
   shuffled from a seed, so "another one" is a client-side page rather than a
   round trip that might repeat itself.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, MONTHS, localDateStr, daysBetween, toMins, spanMins, overlapMins,
  paidHours, shiftPay, round1, round2,
} = require('./helpers');

const router = express.Router();

const money = v => '£' + round2(v).toFixed(2);

router.get('/did-you-know', (req, res) => {
  const today = localDateStr();
  const shifts = db.prepare('SELECT * FROM shifts WHERE date <= ? ORDER BY date ASC').all(today);
  const facts = [];
  const add = (icon, text, detail) => facts.push({ icon, text, detail: detail || null });

  if (!shifts.length) return res.json({ facts: [], count: 0, today });

  const totalHours = shifts.reduce((t, s) => t + paidHours(s), 0);
  const totalPay = shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0);
  const totalMiles = shifts.reduce((t, s) => t + (s.distance_miles || 0) * 2, 0);
  const dates = [...new Set(shifts.map(s => s.date))];

  // ── Scale conversions ────────────────────────────────────────────────────
  add('🌍', `You have driven ${round1(totalMiles)} miles to work.`,
    `That's ${round1(totalMiles / 117)} laps of the M25, or ${round1(totalMiles / 874)} trips from Land's End to John o' Groats.`);
  add('⏳', `You have spent ${round1(totalHours)} hours on the clock.`,
    `${round1(totalHours / 24)} days solid, or about ${round1(totalHours / 8760 * 100)}% of a whole year of your life.`);
  add('🎬', `Your logged hours would let you watch ${Math.round(totalHours / 2.5)} feature films back to back.`,
    'Assuming a fairly generous 2.5 hours each.');
  add('☕', `At a rough £3.50 a cup, your total pay is ${Math.round(totalPay / 3.5).toLocaleString('en-GB')} coffees.`,
    `That's ${money(totalPay)} of gross shift pay.`);

  // ── Day-of-week oddities ─────────────────────────────────────────────────
  const byDow = [0, 0, 0, 0, 0, 0, 0];
  const earliestByDow = [null, null, null, null, null, null, null];
  for (const s of shifts) {
    const d = new Date(s.date + 'T12:00:00').getDay();
    byDow[d] += 1;
    const m = toMins(s.start_time);
    if (earliestByDow[d] == null || m < earliestByDow[d]) earliestByDow[d] = m;
  }
  const neverWorked = DAYS.filter((_, i) => byDow[i] === 0);
  if (neverWorked.length) {
    add('🚫', `You have never worked a ${neverWorked.join(' or a ')}.`, 'Not once, in your whole history.');
  }
  const rarest = DAYS.map((day, i) => ({ day, n: byDow[i] })).filter(d => d.n > 0)
    .sort((a, b) => a.n - b.n)[0];
  if (rarest) add('🕊️', `${rarest.day} is your rarest working day.`, `Only ${rarest.n} shift${rarest.n === 1 ? '' : 's'} ever.`);

  const lateStarters = DAYS.filter((_, i) => byDow[i] > 0 && earliestByDow[i] >= 9 * 60);
  if (lateStarters.length) {
    add('😴', `You have never started before 9am on a ${lateStarters.join(' or ')}.`, 'Not a single time.');
  }

  // ── Streaks and gaps ─────────────────────────────────────────────────────
  const sorted = dates.slice().sort();
  let longestGap = 0, gapFrom = null, gapTo = null;
  for (let i = 1; i < sorted.length; i++) {
    const g = daysBetween(sorted[i - 1], sorted[i]);
    if (g > longestGap) { longestGap = g; gapFrom = sorted[i - 1]; gapTo = sorted[i]; }
  }
  if (longestGap > 1) {
    add('🏝️', `Your longest gap between shifts was ${longestGap - 1} days off in a row.`,
      `Between ${gapFrom} and ${gapTo}.`);
  }

  // ── Colleague oddities ───────────────────────────────────────────────────
  const colShifts = db.prepare(
    "SELECT cs.*, c.name FROM colleague_shifts cs JOIN colleagues c ON c.id = cs.colleague_id " +
    "WHERE cs.shift_type = 'shift' AND (cs.store IS NULL OR cs.store = '')"
  ).all();
  const colByDate = {};
  for (const cs of colShifts) (colByDate[cs.date] ||= []).push(cs);

  const together = {};   // name -> { count, dows:Set, mins }
  for (const s of shifts) {
    const dow = new Date(s.date + 'T12:00:00').getDay();
    for (const cs of colByDate[s.date] || []) {
      const mins = overlapMins(s.start_time, s.end_time, cs.start_time, cs.end_time);
      if (mins <= 0) continue;
      (together[cs.name] ||= { count: 0, dows: new Set(), mins: 0 });
      together[cs.name].count += 1;
      together[cs.name].dows.add(dow);
      together[cs.name].mins += mins;
    }
  }
  const ranked = Object.entries(together).sort((a, b) => b[1].mins - a[1].mins);
  if (ranked.length) {
    const [name, v] = ranked[0];
    add('👥', `You have spent ${round1(v.mins / 60)} hours on shift with ${name}.`,
      `Across ${v.count} shifts — more than anyone else.`);
    // Someone you've worked with a lot but only ever on a couple of weekdays
    const narrow = ranked.find(([, x]) => x.count >= 5 && x.dows.size <= 2);
    if (narrow) {
      const days = [...narrow[1].dows].map(d => DAYS[d]).join(' and ');
      add('🔁', `You have worked with ${narrow[0]} ${narrow[1].count} times — and only ever on a ${days}.`,
        'Same slot, every time.');
    }
    const fleeting = ranked.filter(([, x]) => x.count === 1).length;
    if (fleeting) {
      add('👋', `${fleeting} colleague${fleeting === 1 ? ' has' : 's have'} shared exactly one shift with you.`,
        'Ships in the night.');
    }
  }

  // ── Money oddities ───────────────────────────────────────────────────────
  const best = shifts.slice().sort((a, b) => (shiftPay(b) || 0) - (shiftPay(a) || 0))[0];
  if (best) {
    const share = totalPay > 0 ? round1(((shiftPay(best) || 0) / totalPay) * 100) : 0;
    add('💷', `Your best-paid single shift was ${money(shiftPay(best) || 0)}.`,
      `On ${best.date} — ${share}% of everything you have ever earned, in one day.`);
  }
  const perDay = dates.length ? totalPay / dates.length : 0;
  add('📅', `You average ${money(perDay)} for every day you turn up.`,
    `Across ${dates.length} working days.`);

  // ── Calendar oddities ────────────────────────────────────────────────────
  const monthCounts = {};
  for (const s of shifts) {
    const m = parseInt(s.date.slice(5, 7), 10);
    monthCounts[m] = (monthCounts[m] || 0) + 1;
  }
  const busiestMonth = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0];
  if (busiestMonth) {
    add('📆', `${MONTHS[busiestMonth[0] - 1]} is your busiest month of the year.`,
      `${busiestMonth[1]} shifts across every ${MONTHS[busiestMonth[0] - 1]} on record.`);
  }
  const startTimes = new Set(shifts.map(s => s.start_time));
  add('🕐', `You have started a shift at ${startTimes.size} different times.`,
    `Most common: ${mode(shifts.map(s => s.start_time))}.`);

  const longest = shifts.slice().sort((a, b) =>
    spanMins(b.start_time, b.end_time) - spanMins(a.start_time, a.end_time))[0];
  if (longest) {
    add('🥵', `Your longest single stint was ${round1(spanMins(longest.start_time, longest.end_time) / 60)} hours door to door.`,
      `${longest.start_time}–${longest.end_time} on ${longest.date}.`);
  }

  // Deterministic shuffle so the client can page without repeats
  const seed = parseInt(req.query.seed, 10) || Math.floor(Date.now() / 86400000);
  shuffle(facts, seed);

  res.json({ facts, count: facts.length, seed, today });
});

function mode(arr) {
  const t = {};
  for (const v of arr) t[v] = (t[v] || 0) + 1;
  return Object.entries(t).sort((a, b) => b[1] - a[1])[0][0];
}

function shuffle(arr, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

module.exports = router;
