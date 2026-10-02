// Pure parsing helpers for the team-rota import (screenshot → Gemini → JSON →
// colleague shifts). Kept free of the database and Express so they can be unit
// tested directly (test/team-import-parse.test.js) — every one of these has
// been the cause of a "the import didn't pick that up" at some point.

const SHORT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const WEEKDAYS = ['mon','tue','wed','thu','fri','sat','sun'];   // Rotageek weeks run Mon–Sun

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The Mon…Sun week (7 ISO dates) containing a given date. Aligning to the
 *  week rather than counting back 6 days from "the last date in the header"
 *  means a header that only shows the start date ("w/c 28 Sep") lands on the
 *  right week too, instead of the week before. */
function weekContaining(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    dates.push(iso(x));
  }
  return dates;
}

/** Strict form: "Mon DD, YYYY" as the LAST thing in the string — what the
 *  Rotageek header looks like ("Feb 23, 2026 – Mar 1, 2026", "01 - Dec 7, 2025"). */
function resolveWeekDatesStrict(dateRange) {
  if (!dateRange) return null;
  const s = String(dateRange).trim().replace(/[^\w]+$/, '');   // trailing ")", "▾", "." etc.
  const m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})$/);
  if (!m) return null;
  const monIdx = SHORT_MONTHS.indexOf(m[1].toLowerCase().substring(0, 3));
  if (monIdx === -1) return null;
  const end = new Date(parseInt(m[3], 10), monIdx, parseInt(m[2], 10));
  return isNaN(end) ? null : weekContaining(end);
}

// The wider net: find the last date anywhere in the string, filling in
// month/year from earlier in it when the end date doesn't carry its own.
// Handles "25/08/2026 - 31/08/2026", "Aug 25 – 31, 2026", "28 Sep – 4 Oct",
// and headers with no year at all (normal on a phone screenshot).
function resolveWeekDatesLoose(dateRange, now = new Date()) {
  if (!dateRange) return null;
  const s = String(dateRange).trim();
  const monIdx = name => SHORT_MONTHS.indexOf(String(name).toLowerCase().slice(0, 3));

  const found = [];   // { d, m, y, at } — m/y possibly null; `at` = position in the string
  const push = (d, m, y, at) => found.push({ d, m, y, at });

  for (const m of s.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) push(+m[3], +m[2] - 1, +m[1], m.index);
  for (const m of s.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4})/g)) push(+m[1], +m[2] - 1, +m[3], m.index);
  for (const m of s.matchAll(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s*(\d{4})?/g)) {
    const mi = monIdx(m[1]);
    if (mi >= 0) push(+m[2], mi, m[3] ? +m[3] : null, m.index);
  }
  for (const m of s.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s*(\d{4})?/g)) {
    const mi = monIdx(m[2]);
    if (mi >= 0) push(+m[1], mi, m[3] ? +m[3] : null, m.index);
  }
  if (!found.length) return null;
  found.sort((a, b) => a.at - b.at);
  // A bare trailing day with no month of its own — "Aug 25 – 31, 2026"
  const bare = s.match(/(?:-|–|—|\bto)\s*(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?\s*$/i);
  if (bare && bare.index >= found[found.length - 1].at) push(+bare[1], null, bare[2] ? +bare[2] : null, s.length);

  const anyMonth = found.find(f => f.m !== null)?.m ?? null;
  const anyYear  = found.find(f => f.y !== null)?.y ?? null;
  const end = found[found.length - 1];
  const day = end.d;
  const month = end.m ?? anyMonth;
  if (month === null || !Number.isFinite(day) || day < 1 || day > 31) return null;
  // No year shown: the screenshot is a rota, so the week is near today — pick
  // the candidate year closest to now (no 6-months-out mistake each New Year).
  let year = end.y ?? anyYear;
  if (year == null) {
    year = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
      .reduce((best, y) => Math.abs(new Date(y, month, day) - now) < Math.abs(new Date(best, month, day) - now) ? y : best);
  }
  const endDate = new Date(year, month, day);
  return isNaN(endDate) ? null : weekContaining(endDate);
}

/** date_range → [Mon … Sun] ISO dates, or null. */
function resolveWeekDates(dateRange, now) {
  return resolveWeekDatesStrict(dateRange) || resolveWeekDatesLoose(dateRange, now);
}

/** Like resolveWeekDates, but checked against the day labels the screenshot
 *  actually shows ("Mon 28", "Tue 29", …). A misread header date — "Oct 5"
 *  for "Oct 4" — would otherwise shift the whole import by a week or a day,
 *  silently. The candidate week that the most labels agree with (number AND
 *  weekday) wins; the header's own reading wins ties. */
function resolveWeekForSchedule(dateRange, dayLabels, now) {
  const base = resolveWeekDates(dateRange, now);
  if (!base) return null;
  const labels = (dayLabels || []).map(l => String(l || '').toLowerCase());
  const shift = (week, days) => {
    const d = new Date(week[0] + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return weekContaining(d);
  };
  const candidates = [base, shift(base, -7), shift(base, 7)];
  const score = week => labels.reduce((n, l) => {
    const num = l.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    const wd = l.match(/\b(mon|tue|wed|thu|fri|sat|sun)/);
    if (!num) return n;
    const idx = week.findIndex(d => parseInt(d.slice(8), 10) === +num[1]);
    if (idx === -1) return n;
    return n + (!wd || WEEKDAYS[idx] === wd[1] ? 1 : 0);
  }, 0);
  let best = candidates[0], bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const sc = score(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  return best;
}

/** A day label from the screenshot ("Mon 23", "Sun 01", "Monday", "28 Sep",
 *  "Tue 29th", "2026-09-29") → the ISO date within weekDates, or null.
 *  The day number wins when it's in this week; the weekday name is the
 *  fallback (no number shown, or a misread one). */
function resolveDayDate(dayStr, weekDates) {
  if (!weekDates || !dayStr) return null;
  const s = String(dayStr).trim();
  const isoHit = s.match(/\d{4}-\d{2}-\d{2}/);
  if (isoHit && weekDates.includes(isoHit[0])) return isoHit[0];

  const nums = [...s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g)].map(m => parseInt(m[1], 10));
  for (const n of nums) {
    const hit = weekDates.find(d => parseInt(d.slice(8), 10) === n);
    if (hit) return hit;
  }
  // A number that isn't in this week means something's off — better to skip
  // (with a warning) than to guess from the weekday and file it a week out.
  if (nums.length) return null;
  const wd = s.toLowerCase().match(/\b(mon|tue|wed|thu|fri|sat|sun)/);
  if (wd) return weekDates[WEEKDAYS.indexOf(wd[1])] || null;
  return null;
}

/** "09:00 - 17:30", "9.00–17.30", "9am - 5:30pm", "0900-1730", "9:00 to 17:00"
 *  → { start: "09:00", end: "17:30" }, or null if it isn't clearly a time range. */
function parseTimeRange(str) {
  if (!str) return null;
  const s = String(str).replace(/\s+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  const ok = (h, m) => h >= 0 && h <= 23 && m >= 0 && m <= 59;

  // 24h without separators: 0900-1730
  let m = s.match(/\b(\d{2})(\d{2})\s*(?:-|–|—|to)\s*(\d{2})(\d{2})\b/i);
  if (m) {
    const [sh, sm, eh, em] = m.slice(1).map(Number);
    return ok(sh, sm) && ok(eh, em) ? { start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh)}:${pad(em)}` } : null;
  }

  m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let [, sh, sm, sap, eh, em, eap] = m;
  // "9 - 5" alone is too ambiguous to trust — need minutes or am/pm somewhere.
  if (sm === undefined && em === undefined && !sap && !eap) return null;
  sh = +sh; sm = +(sm || 0); eh = +eh; em = +(em || 0);
  sap = sap && sap.toLowerCase(); eap = eap && eap.toLowerCase();
  const to24 = (h, ap) => ap === 'pm' ? (h % 12) + 12 : ap === 'am' ? h % 12 : h;
  eh = to24(eh, eap);
  if (sap) sh = to24(sh, sap);
  else if (eap) {
    // "1-5pm" → 13:00, but "9-5pm" → 09:00 (start can't be after the end)
    const asPm = to24(sh, eap);
    sh = asPm * 60 + sm <= eh * 60 + em ? asPm : to24(sh, 'am');
  }
  return ok(sh, sm) && ok(eh, em) ? { start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh)}:${pad(em)}` } : null;
}

/** Edit distance between two strings, counting a swapped pair of adjacent
 *  letters ("Wrad" / "Ward") as one edit — the commonest OCR slip. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1])
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
    }
  return dp[m][n];
}

const normName = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Confident, typo-free name match: exact, first-name-only vs full name
 *  ("Nikki" ~ "Nikki Houghton"), or an initial ("Wayne A" ~ "Wayne Aitken"). */
function nameMatchesStrict(raw, name) {
  const a = normName(raw), b = normName(name);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b + ' ') || b.startsWith(a + ' ')) return true;
  const ta = a.split(' '), tb = b.split(' ');
  if (ta.length >= 2 && tb.length >= 2 && ta[0] === tb[0]) {
    const la = ta[ta.length - 1], lb = tb[tb.length - 1];
    if ((la.length === 1 && lb.startsWith(la)) || (lb.length === 1 && la.startsWith(lb))) return true;
  }
  return false;
}

/** Fuzzy-match a name read off a screenshot against the known colleagues.
 *  Returns the colleague row, or null if nothing is a clear single match —
 *  an "unknown name" the user can add is far better than a shift quietly
 *  filed under the wrong person. */
function fuzzyMatch(raw, colleagues) {
  const a = normName(raw);
  if (!a) return null;

  // Tier 1: exact
  const exact = colleagues.filter(c => normName(c.name) === a);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact[0];   // same name twice in the list — nothing better to go on

  // Tier 2: first-name / initial match, only if it's unambiguous (two Sams → unknown)
  const strict = colleagues.filter(c => nameMatchesStrict(a, c.name));
  if (strict.length === 1) return strict[0];
  if (strict.length > 1) return null;

  // Tier 3: OCR typos. Compared word by word (first and last name each close),
  // so "Sam Jones" never lands on "Tom Jones" just because the strings are
  // mostly the same letters.
  const tokAllowed = len => len <= 3 ? 0 : len <= 5 ? 1 : 2;
  const ta = a.split(' ');
  const scored = [];
  for (const c of colleagues) {
    const b = normName(c.name);
    if (!b) continue;
    const tb = b.split(' ');
    let dist;
    if (ta.length >= 2 && tb.length >= 2) {
      const df = levenshtein(ta[0], tb[0]);
      const dl = levenshtein(ta[ta.length - 1], tb[tb.length - 1]);
      if (df > tokAllowed(Math.max(ta[0].length, tb[0].length))) continue;
      if (dl > tokAllowed(Math.max(ta[ta.length - 1].length, tb[tb.length - 1].length))) continue;
      dist = df + dl;
    } else {
      // One side is a single word (or OCR ran the words together) — whole string, tighter.
      const as = a.replace(/ /g, ''), bs = b.replace(/ /g, '');
      dist = levenshtein(as, bs);
      if (dist > Math.max(1, Math.floor(Math.max(as.length, bs.length) * 0.2))) continue;
    }
    scored.push({ c, dist });
  }
  if (!scored.length) return null;
  scored.sort((x, y) => x.dist - y.dist);
  if (scored.length > 1 && scored[1].dist === scored[0].dist) return null;   // a tie is a guess
  return scored[0].c;
}

/** Pull the JSON object out of a model reply: tolerates ```json fences and any
 *  "Here's the schedule:" chatter before or after it. */
function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { return null; }
}

/** Bring a model reply into the { date_range, schedule: [{ date, shifts }] }
 *  shape the import expects. In JSON mode Gemini sometimes wraps the object
 *  in an array, names the list "days"/"week", or returns a flat list of
 *  shifts each carrying its own date — all the same information, and all
 *  previously rejected as "missing a schedule array". Returns null if there's
 *  genuinely no schedule in it. */
function coerceSchedule(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    const withSchedule = parsed.find(x => x && Array.isArray(x.schedule));
    if (withSchedule) return coerceSchedule(withSchedule);
    if (parsed.length && parsed.every(x => x && typeof x === 'object' && Array.isArray(x.shifts))) {
      return { date_range: '', schedule: parsed };
    }
    if (parsed.length && parsed.every(x => x && typeof x === 'object' && x.name && x.date)) {
      return coerceSchedule({ shifts: parsed });
    }
    return null;
  }
  if (typeof parsed !== 'object') return null;
  const date_range = parsed.date_range || parsed.dateRange || parsed.week || parsed.header || '';
  for (const key of ['schedule', 'days', 'week_schedule', 'weekSchedule', 'rota']) {
    if (Array.isArray(parsed[key])) {
      return { ...parsed, date_range: typeof date_range === 'string' ? date_range : '', schedule: parsed[key] };
    }
  }
  // Flat list of shifts, each with its own day label → group by that label.
  if (Array.isArray(parsed.shifts) && parsed.shifts.some(x => x && x.date)) {
    const byDay = new Map();
    for (const sh of parsed.shifts) {
      if (!sh || !sh.date) continue;
      if (!byDay.has(sh.date)) byDay.set(sh.date, []);
      const time = sh.time || (sh.start_time && sh.end_time ? `${sh.start_time} - ${sh.end_time}` : undefined);
      byDay.get(sh.date).push({ ...sh, time });
    }
    return { date_range: typeof date_range === 'string' ? date_range : '', schedule: [...byDay].map(([date, shifts]) => ({ date, shifts })) };
  }
  return null;
}

module.exports = {
  coerceSchedule,
  SHORT_MONTHS, weekContaining, resolveWeekDates, resolveWeekDatesStrict, resolveWeekDatesLoose, resolveWeekForSchedule,
  resolveDayDate, parseTimeRange, levenshtein, normName, nameMatchesStrict, fuzzyMatch, extractJson,
};
