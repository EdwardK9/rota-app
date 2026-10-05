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
const { careerStats } = require('./stats');
const { callGeminiText } = require('../working-with');

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
    add('🏝️', `Your longest gap between shifts was ${longestGap - 1} day${longestGap - 1 === 1 ? '' : 's'} off in a row.`,
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

  // ── More angles on the same history ──────────────────────────────────────
  // The deck used to lean on miles and hours; these draw on weekends, bank
  // holidays, early starts, streaks, breaks, tax and leave, so a page of four
  // isn't four ways of saying the same number.
  const cs = careerStats();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fmtDay = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (cs.weekendShifts > 0 && cs.totalShifts > 0) {
    const pct = round1((cs.weekendShifts / cs.totalShifts) * 100);
    add('🛍️', `${cs.weekendShifts} of your ${cs.totalShifts} shifts were at a weekend.`,
      `That's ${pct}% — about ${Math.max(1, Math.round(pct / 10))} in every 10.`);
  }
  if (cs.bankHolidayShifts > 0) {
    add('🎌', `You have worked ${plural(cs.bankHolidayShifts, 'bank holiday', 'bank holidays')}.`,
      `Most recently ${fmtDay(cs.bankHolidayList[cs.bankHolidayList.length - 1])}.`);
  }
  if (cs.earliestStart) {
    add('🌅', `Your earliest ever start was ${cs.earliestStart.start_time}.`,
      `${fmtDay(cs.earliestStart.date)}${cs.earlyStarts > 1 ? ` — and you have started at 7am or earlier ${cs.earlyStarts} times in all.` : '.'}`);
  }
  if (cs.latestFinish) {
    add('🌙', `Your latest ever finish was ${cs.latestFinish.end_time}.`,
      `${fmtDay(cs.latestFinish.date)}${cs.lateFinishes > 1 ? ` — you have finished at 7pm or later ${cs.lateFinishes} times.` : '.'}`);
  }
  if (cs.longestStreakDays >= 3) {
    add('🔥', `Your longest run without a day off was ${cs.longestStreakDays} days in a row.`,
      cs.longestStreakEnd ? `It ended on ${fmtDay(cs.longestStreakEnd)}.` : null);
  }
  if (cs.breaksSkipped > 0) {
    add('🥪', `You have skipped your break ${plural(cs.breaksSkipped, 'time', 'times')}.`,
      `Against ${cs.breaksFull} full break${cs.breaksFull === 1 ? '' : 's'} taken.`);
  }
  if (cs.lifetimeGross > 0 && cs.lifetimeTax > 0) {
    add('🏛️', `You have paid ${money(cs.lifetimeTax)} in tax and National Insurance.`,
      `${round1((cs.lifetimeTax / cs.lifetimeGross) * 100)}% of ${money(cs.lifetimeGross)} gross, across ${plural(cs.payslipCount, 'payslip', 'payslips')}.`);
  }
  if (cs.leaveDays > 0) {
    add('🏖️', `You have taken ${cs.leaveDays} day${cs.leaveDays === 1 ? '' : 's'} of leave.`,
      `Across ${plural(cs.leaveEntries, 'booking', 'bookings')}.`);
  }
  if (totalHours > 0 && totalPay > 0) {
    add('⚡', `Every hour on the clock has earned you ${money(totalPay / totalHours)} on average.`,
      `${money(totalPay)} over ${round1(totalHours)} hours.`);
  }
  if (cs.distinctColleagues > 0) {
    add('🧑‍🤝‍🧑', `You have shared a shift with ${cs.distinctColleagues} different colleague${cs.distinctColleagues === 1 ? '' : 's'}.`,
      cs.biggestCrewDay && cs.biggestCrewDay.count ? `Your busiest day had ${cs.biggestCrewDay.count} of them in with you (${fmtDay(cs.biggestCrewDay.date)}).` : null);
  }
  if (cs.bestWeekByHours && cs.bestWeekByHours.hours > 0) {
    add('💪', `Your biggest week was ${cs.bestWeekByHours.hours} hours.`,
      `${cs.bestWeekByHours.shifts} shifts, ${money(cs.bestWeekByHours.pay)} — week of ${fmtDay(cs.bestWeekByHours.key)}.`);
  }
  if (cs.firstShift) {
    const since = daysBetween(cs.firstShift.date, today);
    if (since > 0) {
      add('🗓️', `Your first logged shift was ${since.toLocaleString('en-GB')} days ago.`,
        since >= 365 ? `${fmtDay(cs.firstShift.date)} — about ${round1(since / 365.25)} years.` : `${fmtDay(cs.firstShift.date)}.`);
    }
  }
  if (cs.clockIns >= 5 && cs.earliestClockIn) {
    add('⏰', `Your earliest ever clock-in was ${cs.earliestClockIn.clocked_in}.`,
      `On ${fmtDay(cs.earliestClockIn.date)}.`);
  }

  // Deterministic shuffle so the client can page without repeats
  const seed = parseInt(req.query.seed, 10) || Math.floor(Date.now() / 86400000);
  shuffle(facts, seed);

  res.json({ facts, count: facts.length, seed, today });
});

/* GET /api/v3/did-you-know/ai
   The facts above are all hand-written formulas. This one instead hands a
   compact, names-free summary of the same kind of numbers to Gemini and asks
   for a single fresh comparison — same spirit, different phrasing every time,
   without needing a new hand-written rule for every possible angle.

   Uses the same overload/fallback-model retry chain as screenshot import
   (callGeminiText in working-with.js) — the free-tier flash models this app
   defaults to genuinely do return "high demand" 503s at busy times, and the
   first version of this route had no retry at all, so that surfaced straight
   to the user instead of quietly trying the next-best model. */
router.get('/did-you-know/ai', async (req, res) => {
  const s = careerStats();
  if (!s.totalShifts) return res.status(400).json({ error: 'Not enough shift history yet to generate a fact.' });

  // Aggregate numbers only — no colleague names, no dates, nothing that reads
  // as a diary entry once it leaves the server.
  //
  // Every request used to send the same bag of numbers and ask for "a surprising
  // comparison", and the model reached for the biggest, most dramatic one each
  // time — commute miles. So each request now gets ONE topic and only that
  // topic's numbers; the client says which topic it just showed (?not=) so
  // "Get another" never repeats the same angle back to back.
  const THEMES = {
    time: { ask: 'how much time they have spent at work', data: { total_hours: round1(s.totalHours), total_shifts: s.totalShifts, days_employed: s.daysEmployed || 0 } },
    money: { ask: 'what they have earned', data: { total_pay_gbp: round2(s.totalPay), total_hours: round1(s.totalHours), total_shifts: s.totalShifts } },
    tax: { ask: 'tax and National Insurance paid', data: { lifetime_tax_and_ni_paid_gbp: round2(s.lifetimeTax), lifetime_gross_pay_gbp: round2(s.lifetimeGross) }, need: s.lifetimeTax > 0 },
    weekends: { ask: 'weekend and bank holiday working', data: { weekend_shifts: s.weekendShifts, bank_holiday_shifts: s.bankHolidayShifts, total_shifts: s.totalShifts }, need: s.weekendShifts + s.bankHolidayShifts > 0 },
    endurance: { ask: 'their longest efforts', data: { longest_single_shift_hours: s.longestShift ? round1(paidHours(s.longestShift)) : 0, longest_streak_of_days_worked: s.longestStreakDays }, need: !!s.longestShift },
    early_late: { ask: 'early starts and late finishes', data: { starts_at_or_before_7am: s.earlyStarts, finishes_at_or_after_7pm: s.lateFinishes, total_shifts: s.totalShifts }, need: s.earlyStarts + s.lateFinishes > 0 },
    people: { ask: 'how many colleagues they have worked alongside', data: { distinct_colleagues_worked_with: s.distinctColleagues, biggest_crew_on_one_day: s.biggestCrewDay ? s.biggestCrewDay.count : 0 }, need: s.distinctColleagues > 0 },
    breaks: { ask: 'their breaks', data: { full_breaks_taken: s.breaksFull, breaks_skipped: s.breaksSkipped, total_shifts: s.totalShifts } },
    leave: { ask: 'time off they have taken', data: { leave_days_taken: s.leaveDays, days_employed: s.daysEmployed || 0 }, need: s.leaveDays > 0 },
    commute: { ask: 'their commute (there and back)', data: { total_commute_miles_round_trip: round1(s.totalMiles), total_shifts: s.totalShifts }, need: s.totalMiles > 0 },
  };
  const available = Object.keys(THEMES).filter(k => THEMES[k].need !== false);
  const not = String(req.query.not || '');
  const pool = available.filter(k => k !== not);
  const forced = available.includes(String(req.query.theme || '')) ? String(req.query.theme) : null;   // for tests / debugging
  const themeKey = forced || (pool.length ? pool : available)[Math.floor(Math.random() * (pool.length ? pool.length : available.length))];
  const theme = THEMES[themeKey];

  const prompt = `You write a single "did you know" fact for a UK retail shift-worker's personal work-stats app, based on the real JSON data below.

This time the topic is: ${theme.ask}. Use ONLY the numbers given — do not bring in any other topic.

Rules:
- Output ONLY the fact itself as plain text. No preamble, no markdown, no quote marks, no label.
- One or two sentences, under 220 characters total.
- Turn one of the numbers into a surprising real-world comparison or conversion (e.g. equivalent in films watched, marathons, football pitches, flights, cups of tea, steps, phone charges — vary it, don't just restate the number).
- Be playful but honest — every number you use must be derivable from the data given, don't invent statistics.
- Do not give financial or tax advice, just observations.

Data:
${JSON.stringify(theme.data)}`;

  try {
    const fact = await callGeminiText(prompt);
    res.json({ fact, theme: themeKey });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Gemini request failed.' });
  }
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
