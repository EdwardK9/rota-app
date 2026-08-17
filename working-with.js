/* ─── Working-With Routes ──────────────────────────────────────────────────
   Endpoints:
     GET  /api/colleagues                  — list all colleagues
     POST /api/colleagues                  — add a colleague by name
     DEL  /api/colleagues/:id             — remove a colleague
     POST /api/colleagues/import-screenshot — OCR a rota screenshot
     GET  /api/working-with/leaderboard   — shift-count & hours leaderboard
     GET  /api/working-with/people        — per-shift overlap table
     GET  /api/working-with/next/:colleagueId — next N shared shifts
     GET  /api/working-with/team-calendar — colleague schedule + weekly hrs
   ───────────────────────────────────────────────────────────────────────── */

const express  = require('express');
const multer   = require('multer');
const Jimp     = require('jimp');
const { createWorker } = require('tesseract.js');
const { db, effectiveHourlyRate } = require('./db');
const router   = express.Router();

// multer — store upload in memory (screenshots are typically <5 MB)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/** Today (or an arbitrary Date), formatted as YYYY-MM-DD in LOCAL time.
 *  Do not use `d.toISOString().slice(0,10)` for calendar dates — that converts
 *  to UTC first, which silently shifts the date by a day whenever local time
 *  is within one hour of midnight (this app runs on Europe/London, so this
 *  bites year-round but especially during BST). */
function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Levenshtein distance between two strings */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/** Fuzzy-match a raw OCR name against the known colleagues list.
 *  Returns the best-matching colleague row, or null if nothing is close enough. */
function fuzzyMatch(raw, colleagues) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const normRaw = norm(raw);
  if (!normRaw) return null;

  // Tier 1: Exact or first-name/full-name match (e.g. "Nikki Houghton" matches "Nikki" but not "Ed" matching "Edward")
  for (const c of colleagues) {
    const normName = norm(c.name);
    if (normRaw === normName) return c;
    // "Nikki Houghton" starts with "Nikki " — safe prefix match
    if (normRaw.startsWith(normName + ' ') || normName.startsWith(normRaw + ' ')) return c;
  }

  // Tier 2: Levenshtein distance fallback for genuine typos
  let best = null, bestDist = Infinity;
  for (const c of colleagues) {
    const normName = norm(c.name);
    const d = levenshtein(normRaw, normName);
    // Slightly relaxed threshold (40%) to handle minor OCR noise
    const maxAllowedDist = Math.max(3, Math.floor(Math.max(normRaw.length, normName.length) * 0.4));
    if (d < bestDist && d <= maxAllowedDist) {
      best = c; bestDist = d;
    }
  }
  return best;
}

/** Parse the OCR text from a Rotageek Team-view screenshot.
 *
 * Real OCR format observed:
 *   "Sun Nikki Houghton"   ← day-name + first person on same line
 *   "21"                   ← day number (next line)
 *   "~ 08:45-1615"         ← time with noise prefix, may lack colon in end time
 *   "BA day" / "BAI day"   ← OCR garble of "All day"
 *   "Annual Leave"         ← leave type keyword
 *
 * Week-range headers ("15 - Dec 21, 2025") give year/month context.
 */
function parseRotageekOCR(text, colleagues) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const DAY_NAMES = new Set(['mon','tue','wed','thu','fri','sat','sun',
                              'monday','tuesday','wednesday','thursday','friday','saturday','sunday']);

  // Flexible time: handles "08:45-1615", "0845-1615", "08:45 - 16:15"
  // \d{3,4} covers "1615" or "845"
  const TIME_RE = /(\d{1,2}:?\d{2})\s*[-–=]+\s*(\d{2,4}:?\d{0,2})/;

  // Leave words
  const LEAVE_RE = /\b(annual\s*leave|absence|holiday)\b/i;

  // "All day" or OCR garble: "BA day", "BAI day", "BAA day", "BAl day" etc.
  // Also matches when the whole line is just this (with possible leading noise)
  const ALL_DAY_RE = /\b(all\s*day|ba[a-z]{0,3}\s*day)\b/i;

  const WEEK_HEADER_RE = /\b(\w{3,9})\s+(\d{1,2}),?\s*(\d{4})\b/i;

  const results = [];
  let currentYear  = new Date().getFullYear();
  let currentMonth = new Date().getMonth();
  let currentDate  = null;
  let currentPerson = null;

  const pad = n => String(n).padStart(2, '0');

  // Normalise a raw time token like "1615", "08:45", "845" → "HH:MM" or null
  const normaliseTime = t => {
    const d = t.replace(/[^0-9]/g, '');
    if (d.length === 3) return `0${d[0]}:${d.slice(1)}`;
    if (d.length === 4) return `${d.slice(0,2)}:${d.slice(2)}`;
    if (t.includes(':')) { const p = t.match(/\d{1,2}:\d{2}/); return p ? p[0].padStart(5,'0') : null; }
    return null;
  };

  const setDate = dayNum => {
    if (currentDate) {
      const last = parseInt(currentDate.slice(8), 10);
      if (dayNum < last) {
        currentMonth = (currentMonth + 1) % 12;
        if (currentMonth === 0) currentYear++;
      }
    }
    currentDate   = `${currentYear}-${pad(currentMonth+1)}-${pad(dayNum)}`;
    currentPerson = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Week-range header: grab month/year context ───────────────────────────
    const wh = line.match(WEEK_HEADER_RE);
    if (wh) {
      const mon = MONTHS[wh[1].toLowerCase().slice(0,3)];
      if (mon !== undefined) { currentMonth = mon; currentYear = parseInt(wh[3], 10); }
    }

    // ── Day-of-week detection ────────────────────────────────────────────────
    // Day name may be alone ("Mon"), have an inline number ("Mon 12"),
    // or be followed by a person name ("Sun Nikki Houghton")
    const dayLineMatch = line.match(/^([a-zA-Z]+)\s*(\d{1,2})?(.*)$/i);
    const firstWord = (dayLineMatch && dayLineMatch[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    if (DAY_NAMES.has(firstWord)) {
      let dayNum = dayLineMatch[2] ? parseInt(dayLineMatch[2], 10) : null;
      // Remainder of the line after day name + optional inline number
      let afterDay = (dayLineMatch[3] || '').trim();

      if (!dayNum) {
        // No inline number — check next line
        const next = (lines[i+1] || '').trim();
        const pureNum = parseInt(next, 10);
        if (next === String(pureNum) && pureNum > 0 && pureNum <= 31) {
          dayNum = pureNum;
          i++; // consume the next line
        } else {
          // Day number may be garbled/combined: "2; 06:45-12:00" → try leading digits
          const numFromNext = next.match(/^(\d{1,2})[\s;:,.]/);
          if (numFromNext) {
            const dn = parseInt(numFromNext[1], 10);
            if (dn > 0 && dn <= 31) { dayNum = dn; i++; }
          }
        }
      }

      if (dayNum && dayNum > 0 && dayNum <= 31) setDate(dayNum);

      // Fall back to old afterDay logic if regex didn't capture a remainder
      if (!afterDay) afterDay = line.slice(line.indexOf(' ')).trim();
      if (afterDay.length >= 3) currentPerson = fuzzyMatch(afterDay, colleagues) || null;
      continue;
    }

    // ── "All day" / OCR garble ("BA day") ───────────────────────────────────
    // "All day" in Rotageek means an all-day WORK shift, NOT leave.
    // Record it immediately for the current person and move on — do NOT
    // consume the next line (which is the next person's name).
    if (ALL_DAY_RE.test(line)) {
      if (currentDate && currentPerson) {
        results.push({ date: currentDate, colleague_id: currentPerson.id, name: currentPerson.name,
                       start_time: '00:00', end_time: '00:00', shift_type: 'all_day' });
      }
      currentPerson = null;
      continue;
    }

    // ── Time line ────────────────────────────────────────────────────────────
    const tm = line.match(TIME_RE);
    if (tm && currentDate) {
      const startTime = normaliseTime(tm[1]);
      const endTime   = normaliseTime(tm[2]);
      if (startTime && endTime) {
        // Inline name (letters before the time)
        const beforeNoise = line.slice(0, line.search(TIME_RE)).replace(/[^a-zA-Z '\-]/g, ' ').trim();
        let matched = beforeNoise.length >= 3 ? fuzzyMatch(beforeNoise, colleagues) : null;
        if (!matched) matched = currentPerson;
        if (matched) {
          results.push({ date: currentDate, colleague_id: matched.id, name: matched.name,
                         start_time: startTime, end_time: endTime, shift_type: 'shift' });
        }
      }
      currentPerson = null;
      continue;
    }

    // ── Leave keyword ────────────────────────────────────────────────────────
    if (currentDate && LEAVE_RE.test(line)) {
      const stripped = line.replace(LEAVE_RE, '').replace(/[^a-zA-Z '\-]/g, ' ').trim();
      let matched = stripped.length >= 3 ? fuzzyMatch(stripped, colleagues) : null;
      if (!matched) matched = currentPerson;
      if (matched) {
        results.push({ date: currentDate, colleague_id: matched.id, name: matched.name,
                       start_time: '00:00', end_time: '00:00', shift_type: 'leave' });
      }
      currentPerson = null;
      continue;
    }

    // ── Anything else: try to match as a colleague name ──────────────────────
    if (currentDate && line.length >= 3) {
      // Strip leading noise characters (icons, symbols) then try to match
      const clean = line.replace(/^[^a-zA-Z]+/, '').trim();
      if (clean.length >= 3) {
        const matched = fuzzyMatch(clean, colleagues);
        if (matched) { currentPerson = matched; }
        // Don't clear currentPerson if no match — "BA day" lines etc. shouldn't wipe it
      }
    }
  }

  return results;
}

/** Calculate overlap minutes between two [start,end] time strings (HH:MM) */
function overlapMinutes(s1, e1, s2, e2) {
  const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
  const start = Math.max(toMins(s1), toMins(s2));
  const end   = Math.min(toMins(e1), toMins(e2));
  return Math.max(0, end - start);
}

// ─────────────────────────────────────────
// Colleagues CRUD
// ─────────────────────────────────────────

/** Decorate a raw colleague row with derived/parsed pay-profile & synergy fields. */
function decorateColleague(c) {
  if (!c) return c;
  let tags = [];
  try { tags = c.tags ? JSON.parse(c.tags) : []; } catch (_) { tags = []; }
  return {
    ...c,
    tags,
    synergy_rating: c.synergy_rating ?? 0,
    effective_hourly_rate: effectiveHourlyRate(c),
  };
}

router.get('/colleagues', (req, res) => {
  const includeLeft = req.query.include_left === '1';
  const sql = includeLeft
    ? 'SELECT * FROM colleagues ORDER BY sort_order ASC, name ASC'
    : "SELECT * FROM colleagues WHERE (left_date IS NULL OR left_date = '') ORDER BY sort_order ASC, name ASC";
  res.json(db.prepare(sql).all().map(decorateColleague));
});

router.post('/colleagues', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM colleagues').get().m;
    const r = db.prepare('INSERT INTO colleagues (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
    res.status(201).json(decorateColleague(db.prepare('SELECT * FROM colleagues WHERE id = ?').get(r.lastInsertRowid)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Colleague already exists' });
    throw e;
  }
});

router.put('/colleagues/:id', (req, res) => {
  const {
    name, birthday, contract_hours, sort_order, left_date, start_date,
    pay_type, hourly_rate, annual_salary, nominal_weekly_hours,
    tags, synergy_rating, notes, job_tier,
  } = req.body;
  const existing = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Basic validation: pay_type must be one of the two supported values
  const resolvedPayType = pay_type !== undefined ? pay_type : existing.pay_type;
  if (resolvedPayType && !['hourly', 'salaried'].includes(resolvedPayType)) {
    return res.status(400).json({ error: "pay_type must be 'hourly' or 'salaried'" });
  }
  const resolvedSynergy = synergy_rating !== undefined ? parseInt(synergy_rating, 10) : existing.synergy_rating;
  if (resolvedSynergy !== null && resolvedSynergy !== undefined && (resolvedSynergy < -2 || resolvedSynergy > 2)) {
    return res.status(400).json({ error: 'synergy_rating must be between -2 and 2' });
  }
  const resolvedJobTier = job_tier !== undefined ? job_tier : (existing.job_tier || 'floor_staff');
  if (resolvedJobTier && !['management', 'supervisor', 'floor_staff'].includes(resolvedJobTier)) {
    return res.status(400).json({ error: "job_tier must be 'management', 'supervisor' or 'floor_staff'" });
  }

  db.prepare(`
    UPDATE colleagues SET
      name = ?, birthday = ?, contract_hours = ?, sort_order = ?, left_date = ?, start_date = ?,
      pay_type = ?, hourly_rate = ?, annual_salary = ?, nominal_weekly_hours = ?,
      tags = ?, synergy_rating = ?, notes = ?, job_tier = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    birthday ?? existing.birthday,
    contract_hours ?? existing.contract_hours,
    sort_order ?? existing.sort_order,
    left_date !== undefined ? (left_date || null) : existing.left_date,
    start_date !== undefined ? (start_date || null) : existing.start_date,
    resolvedPayType,
    hourly_rate !== undefined ? hourly_rate : existing.hourly_rate,
    annual_salary !== undefined ? annual_salary : existing.annual_salary,
    nominal_weekly_hours !== undefined ? nominal_weekly_hours : existing.nominal_weekly_hours,
    tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : []) : existing.tags,
    resolvedSynergy,
    notes !== undefined ? notes : existing.notes,
    resolvedJobTier,
    req.params.id
  );
  res.json(decorateColleague(db.prepare('SELECT * FROM colleagues WHERE id = ?').get(req.params.id)));
});

router.patch('/colleagues/reorder', (req, res) => {
  // body: [{ id, sort_order }, ...]
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'array required' });
  const update = db.prepare('UPDATE colleagues SET sort_order = ? WHERE id = ?');
  const doUpdate = db.transaction(() => { for (const item of items) update.run(item.sort_order, item.id); });
  doUpdate();
  res.json({ ok: true });
});

router.get('/colleagues/birthdays', (req, res) => {
  const rows = db.prepare("SELECT id, name, birthday FROM colleagues WHERE birthday IS NOT NULL AND birthday != ''").all();
  res.json(rows);
});

router.delete('/colleagues/:id', (req, res) => {
  db.prepare('DELETE FROM colleagues WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// Screenshot OCR import
// ─────────────────────────────────────────


/** Split a list of parsed shift rows into toInsert / conflicts / duplicates.
 *  A conflict = same colleague + date exists but with different times.
 *  A duplicate = exact match already in DB (silently skip). */
function detectConflicts(parsedShifts) {
  const toInsert = [], conflicts = [], duplicates = [];
  for (const s of parsedShifts) {
    const existing = db.prepare(
      'SELECT * FROM colleague_shifts WHERE colleague_id = ? AND date = ?'
    ).all(s.colleague_id, s.date);
    if (!existing.length) { toInsert.push(s); continue; }
    const exactMatch = existing.find(e =>
      e.start_time === s.start_time && e.end_time === s.end_time && e.shift_type === (s.shift_type || 'shift')
    );
    if (exactMatch) { duplicates.push(s); continue; }
    const incomingIsVague = s.shift_type === 'all_day' || s.shift_type === 'leave';
    const existingHasRealShift = existing.some(e => e.shift_type === 'shift' && e.start_time !== '00:00');
    // If incoming is all_day/leave but existing is a real timed shift — skip (date mis-attribution)
    if (incomingIsVague && existingHasRealShift) { duplicates.push(s); continue; }
    // If both incoming and existing are all_day/leave — not a real conflict, auto-skip
    const existingIsAllVague = existing.every(e => e.shift_type === 'all_day' || e.shift_type === 'leave');
    if (incomingIsVague && existingIsAllVague) { duplicates.push(s); continue; }
    conflicts.push({ incoming: s, existing });
  }
  return { toInsert, conflicts, duplicates };
}

// ─────────────────────────────────────────
// Shared Ollama prompt
// ─────────────────────────────────────────

const OLLAMA_PROMPT = `You are reading a Rotageek team schedule from a mobile app screenshot. The image shows shifts listed vertically, grouped under day headings.

IMAGE STRUCTURE:
1. Week header near the top — e.g. "Feb 23, 2026 – Mar 1, 2026"
2. A vertical list of shift entries. Each entry shows a person's name and their time range.
3. The day changes are indicated by a day label that appears on the LEFT SIDE of the FIRST entry for each new day — e.g. "Wed" above "04" to the left of the first person listed on Wednesday. Subsequent entries for the same day have no day label — they just show the person's name and time, separated from the previous entry by a faint grey line.

HOW TO IDENTIFY WHICH DAY EACH ENTRY BELONGS TO:
- When you see a day label on the left (e.g. "Wed" + "04"), that marks the start of a new day. The person shown to the right of that label is the FIRST entry for that day.
- Every entry that follows, until the next day label appears on the left, belongs to the same day.
- The day label only appears once per day, next to the first person for that day. Do NOT expect a separate standalone header row — the label is always beside a shift entry.

YOUR TASK:
Work through the image top to bottom. Track which day you are in by watching for day labels on the left. Assign each entry to the current day until a new day label appears.

OUTPUT — return ONLY valid JSON, no markdown, no explanation:
{
  "date_range": "<week header as shown, e.g. 23 - Mar 01, 2026>",
  "schedule": [
    {
      "date": "<day heading as shown, e.g. Mon 23>",
      "shifts": [
        { "name": "Full Name As Written", "time": "HH:MM - HH:MM", "type": "label as shown", "store": "location text if shown, else omit" }
      ]
    }
  ]
}

RULES — follow exactly:
1. Copy the week header verbatim into "date_range"
2. Copy each day heading verbatim into "date" — e.g. "Mon 23", "Sun 01"
3. A shift belongs to a day ONLY if the employee name appears directly under that day's heading — not under any other day heading
4. Each day section ends the moment the next day heading starts — do NOT carry shifts across that boundary
5. Copy all names and times exactly as written — never rephrase or correct
6. If a person appears under multiple different day headings, include them separately under each one
7. If you cannot clearly read a name or time, OMIT that entry — never guess or fill in from memory
8. "Annual Leave" / "Absence": use type "leave", omit the time field
9. "All day" entries: use type "all_day", omit the time field
10. The "schedule" array must contain EXACTLY the 7 days (Monday through Sunday) named in "date_range" — never more, never fewer. If the image shows an extra day belonging to the following week (e.g. a second/next Monday appearing after Sunday), do NOT include it in "schedule"
11. Some entries show a small line below the time, often next to a pin/map-marker icon, naming a different store or branch (e.g. "Southampton - Bitterne") — this means that shift is at a DIFFERENT location than the rest of the schedule. If you see this, copy it verbatim into a "store" field on that shift. If there is no such line, OMIT the "store" field entirely for that shift — do NOT invent one
12. Return ONLY the JSON — no surrounding text`;

// ─────────────────────────────────────────
// Ollama image slicing helper
// Tall screenshots (e.g. 700×12000) cause GGML tensor assertion failures.
// This splits them into chunks, each prepended with the header strip so
// the model can always see the date columns, then merges all results.
// ─────────────────────────────────────────

const SLICE_MAX_HEIGHT = 2000; // px — max height per Ollama request
const SLICE_HEADER_HEIGHT = 180; // px — top strip (date headers) included in every slice
const SLICE_OVERLAP = 400; // px — overlap between slices so day headings carry across

async function sliceAndCallOllama(imageBlob, baseUrl, model, prompt = OLLAMA_PROMPT) {
  const img = await Jimp.read(imageBlob);
  const { width, height } = img.bitmap;

  // Single call path — image is small enough
  if (height <= SLICE_MAX_HEIGHT) {
    const { parsed } = await _ollamaRequest(imageBlob.toString('base64'), baseUrl, model, prompt);
    return parsed;
  }

  // Extract header strip once
  const headerImg = img.clone().crop(0, 0, width, Math.min(SLICE_HEADER_HEIGHT, height));
  const contentHeight = SLICE_MAX_HEIGHT - SLICE_HEADER_HEIGHT;
  const allShifts = [];

  for (let y = SLICE_HEADER_HEIGHT; y < height; y += (contentHeight - SLICE_OVERLAP)) {
    const sliceH = Math.min(contentHeight, height - y);
    const contentSlice = img.clone().crop(0, y, width, sliceH);

    // Composite: header on top, content below
    const combined = new Jimp(width, SLICE_HEADER_HEIGHT + sliceH, 0xffffffff);
    combined.blit(headerImg, 0, 0);
    combined.blit(contentSlice, 0, SLICE_HEADER_HEIGHT);

    const buf = await combined.getBufferAsync(Jimp.MIME_PNG);
    const { parsed } = await _ollamaRequest(buf.toString('base64'), baseUrl, model, prompt);
    allShifts.push(...(parsed.shifts || []));
  }

  return { shifts: allShifts };
}

function _parseVisionJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Model returned an empty response — it may still be loading or the image was too large');
  }
  // Strip markdown fences if present
  let jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Extract JSON object or array from anywhere in the text
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
    const match = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) jsonStr = match[0];
  }
  if (!jsonStr) throw new Error('Model returned blank output after stripping markdown fences');

  // If the JSON is truncated, try to salvage what's there by closing open structures
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (_) {
    // Attempt to close truncated JSON by trimming to last complete object
    const lastComma = jsonStr.lastIndexOf('},');
    const lastClose = jsonStr.lastIndexOf('}');
    const cutAt = lastComma > 0 ? lastComma + 1 : lastClose > 0 ? lastClose + 1 : -1;
    if (cutAt > 0) {
      try {
        let trimmed = jsonStr.slice(0, cutAt).trimEnd().replace(/,\s*$/, '');
        // Close any open array/object
        if (trimmed.startsWith('[') && !trimmed.endsWith(']')) trimmed += ']';
        else if (trimmed.startsWith('{') && !trimmed.endsWith('}')) trimmed += '}';
        parsed = JSON.parse(trimmed);
      } catch (_2) {
        throw new Error(`Could not parse model output as JSON: ${rawText.slice(0, 200)}`);
      }
    } else {
      throw new Error(`Could not parse model output as JSON: ${rawText.slice(0, 200)}`);
    }
  }

  // Normalise: model may return an array directly instead of {"shifts": [...]}
  if (Array.isArray(parsed)) parsed = { shifts: parsed };

  return { parsed, rawText };
}

const AI_FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — vision models can be slow

async function _ollamaRequest(imageB64, baseUrl, model, prompt = OLLAMA_PROMPT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [imageB64] }],
        stream: false,
        options: { temperature: 0, seed: 42, num_ctx: 16384, num_predict: 20000 }
      })
    });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const rawText = (await res.json())?.message?.content || '';
  return _parseVisionJson(rawText);
}

function _lmstudioApiBase(baseUrl) {
  const u = baseUrl.replace(/\/+$/, '');
  return u.endsWith('/v1') ? u : `${u}/v1`;
}

async function _lmstudioRequest(imageB64, baseUrl, model, prompt = OLLAMA_PROMPT) {
  const apiBase = _lmstudioApiBase(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } }
          ]
        }],
        temperature: 0,
        seed: 42,
        max_tokens: 8192
      })
    });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LM Studio error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const rawText = (await res.json())?.choices?.[0]?.message?.content || '';
  return _parseVisionJson(rawText);
}

async function sliceAndCallLmStudio(imageBlob, baseUrl, model, prompt = OLLAMA_PROMPT) {
  const img = await Jimp.read(imageBlob);
  const { width, height } = img.bitmap;

  if (height <= SLICE_MAX_HEIGHT) {
    const { parsed } = await _lmstudioRequest(imageBlob.toString('base64'), baseUrl, model);
    return parsed;
  }

  const headerImg = img.clone().crop(0, 0, width, Math.min(SLICE_HEADER_HEIGHT, height));
  const contentHeight = SLICE_MAX_HEIGHT - SLICE_HEADER_HEIGHT;
  const allShifts = [];

  for (let y = SLICE_HEADER_HEIGHT; y < height; y += (contentHeight - SLICE_OVERLAP)) {
    const sliceH = Math.min(contentHeight, height - y);
    const contentSlice = img.clone().crop(0, y, width, sliceH);
    const combined = new Jimp(width, SLICE_HEADER_HEIGHT + sliceH, 0xffffffff);
    combined.blit(headerImg, 0, 0);
    combined.blit(contentSlice, 0, SLICE_HEADER_HEIGHT);
    const buf = await combined.getBufferAsync(Jimp.MIME_PNG);
    const { parsed } = await _lmstudioRequest(buf.toString('base64'), baseUrl, model);
    allShifts.push(...(parsed.shifts || []));
  }

  return { shifts: allShifts };
}

// ─────────────────────────────────────────
// Background OCR job worker
// ─────────────────────────────────────────

let _jobWorkerRunning = false;
// Tracks the last date seen per job so consecutive screenshots share context
const _jobLastDate = new Map();

async function runJobWorker() {
  if (_jobWorkerRunning) return;
  _jobWorkerRunning = true;
  try {
    while (true) {
      // Grab next queued file across all jobs
      const file = db.prepare(`
        SELECT f.id, f.job_id, f.filename, f.mime_type, f.image_blob, j.source, j.date_override
        FROM ocr_job_files f
        JOIN ocr_jobs j ON j.id = f.job_id
        WHERE f.status = 'queued'
        ORDER BY f.id ASC LIMIT 1
      `).get();
      if (!file) break;

      // Check if job was cancelled before we grabbed this file
      const jobCheck = db.prepare('SELECT status FROM ocr_jobs WHERE id = ?').get(file.job_id);
      if (jobCheck && jobCheck.status === 'cancelled') {
        db.prepare(`UPDATE ocr_job_files SET status = 'cancelled' WHERE id = ? AND status = 'queued'`).run(file.id);
        continue;
      }
      db.prepare(`UPDATE ocr_job_files SET status = 'processing' WHERE id = ?`).run(file.id);
      db.prepare(`UPDATE ocr_jobs SET status = 'processing' WHERE id = ?`).run(file.job_id);

      // Helper: format a caught error into a human-readable string
      const fmtErr = (err) => {
        const cause = err.cause;
        if (cause) {
          const code = cause.code ? ` (${cause.code})` : '';
          return `${err.message}: ${cause.message}${code}`;
        }
        return err.message;
      };

      // Connection-level errors that are worth retrying
      const isRetryable = (err) => {
        const cause = err.cause;
        if (!cause) return false;
        const retryableCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
          'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'];
        return retryableCodes.includes(cause.code) || err.message === 'fetch failed' || err.name === 'AbortError';
      };

      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 5000;
      let lastErr = null;

      // Build context hint from previous screenshot in the same job
      const prevDate = _jobLastDate.get(file.job_id);
      const contextHint = prevDate
        ? `\n\nCONTEXT: The previous screenshot in this batch ended with entries dated ${prevDate}. If there are entries at the very top of this screenshot with no visible day heading above them, they are a continuation from ${prevDate} or the next day — assign them that date.`
        : '';
      const promptToUse = OLLAMA_PROMPT + contextHint;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (!file.image_blob) throw new Error('Image data missing from database');

          let parsed, rawJson = '';
          if (file.source === 'lmstudio') {
            const urlRow   = db.prepare('SELECT value FROM settings WHERE key = ?').get('lmstudio_url');
            const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('lmstudio_model');
            const baseUrl  = urlRow?.value?.trim() || '';
            const model    = modelRow?.value?.trim() || '';
            if (!baseUrl) throw new Error('No LM Studio URL configured');
            if (!model) throw new Error('No LM Studio model configured');
            parsed = await sliceAndCallLmStudio(file.image_blob, baseUrl, model, promptToUse);
            rawJson = JSON.stringify(parsed).slice(0, 3000);
          } else {
            const urlKey   = file.source === 'remote' ? 'ollama_remote_url'   : 'ollama_server_url';
            const modelKey = file.source === 'remote' ? 'ollama_remote_model' : 'ollama_server_model';
            const urlRow   = db.prepare('SELECT value FROM settings WHERE key = ?').get(urlKey);
            const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(modelKey);
            const baseUrl  = urlRow?.value?.trim() || (file.source === 'remote' ? '' : 'http://localhost:11434');
            const model    = modelRow?.value?.trim() || (file.source === 'remote' ? 'qwen2.5vl:7b' : 'qwen2.5vl:3b');
            if (!baseUrl) throw new Error('No Ollama URL configured');
            parsed = await sliceAndCallOllama(file.image_blob, baseUrl, model, promptToUse);
            rawJson = JSON.stringify(parsed).slice(0, 3000);
          }

          // Include ALL colleagues in match pool — left_date is checked per-shift below
          // so re-importing historical rotas still works for departed colleagues
          const today = localDateStr();
          const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY name ASC').all()
            .filter(c => !c.start_date || c.start_date <= today);

          // Normalise grouped { date_range, schedule } → flat { shifts: [...] } with YYYY-MM-DD dates
          const normParsed = normaliseAIOutput(parsed);

          // If the job was submitted with a fixed date (e.g. from complete-shift upload),
          // use it for every row — the screenshot won't show a date in that case.
          const fixedDate = file.date_override || null;

          const parsedRows = [];
          for (const s of (normParsed.shifts || [])) {
            const matched = fuzzyMatch(s.name || '', colleagues);
            if (!matched) continue;
            const shiftType = s.type || 'shift';
            const rowDate = fixedDate || s.date;
            if (!rowDate) continue; // skip rows with no date at all
            // Skip if colleague had left before this shift date
            if (matched.left_date && matched.left_date < rowDate) continue;
            parsedRows.push({
              colleague_id: matched.id, name: matched.name, date: rowDate,
              start_time: shiftType === 'shift' ? (s.start_time || '00:00') : '00:00',
              end_time:   shiftType === 'shift' ? (s.end_time   || '00:00') : '00:00',
              shift_type: shiftType,
              import_source: file.source,
              store: s.store || null
            });
          }

          // Blank screenshot warning — AI returned no shifts at all
          const blankWarning = (normParsed.shifts || []).length === 0
            ? 'No shifts found — screenshot may be blank or unreadable. Check the image and re-upload if needed.'
            : null;

          const { toInsert, conflicts, duplicates } = detectConflicts(parsedRows);
          const insertStmt = db.prepare(
            `INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, import_source, store) VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          let inserted = 0;
          db.transaction(() => {
            for (const s of toInsert) { insertStmt.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type, s.import_source || null, s.store || null); inserted++; }
          })();

          // Store normalised flat output so the job card UI can display shifts consistently
          rawJson = JSON.stringify(normParsed).slice(0, 3000);

          db.prepare(`UPDATE ocr_job_files SET status='done', inserted=?, skipped=?, conflicts_json=?, raw_json=?, warning=? WHERE id=?`)
            .run(inserted, duplicates.length, JSON.stringify(conflicts), rawJson, blankWarning, file.id);

          // Update context: store the latest date seen so the next screenshot in this job can use it
          const datesFound = (normParsed.shifts || []).map(s => s.date).filter(Boolean).sort();
          if (datesFound.length) _jobLastDate.set(file.job_id, datesFound[datesFound.length - 1]);

          lastErr = null;
          break; // success — exit retry loop

        } catch (err) {
          lastErr = err;
          const detail = fmtErr(err);
          console.error(`OCR job file ${file.id} attempt ${attempt}/${MAX_RETRIES} failed:`, detail);

          if (isRetryable(err) && attempt < MAX_RETRIES) {
            console.log(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          } else {
            break; // non-retryable or out of retries
          }
        }
      }

      if (lastErr) {
        const detail = fmtErr(lastErr);
        db.prepare(`UPDATE ocr_job_files SET status='failed', error=? WHERE id=?`).run(detail, file.id);
      }

      // Update job progress count
      const stats = db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('done','failed') THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status IN ('queued','processing')  THEN 1 ELSE 0 END) as remaining
        FROM ocr_job_files WHERE job_id = ?
      `).get(file.job_id);

      if (stats.remaining === 0) {
        db.prepare(`UPDATE ocr_jobs SET status='done', done=?, completed_at=datetime('now') WHERE id=?`)
          .run(stats.done, file.job_id);
        _jobLastDate.delete(file.job_id); // clean up context when job is fully done
      } else {
        db.prepare(`UPDATE ocr_jobs SET done=? WHERE id=?`).run(stats.done, file.job_id);
      }
    }
  } finally {
    _jobWorkerRunning = false;
  }
}

// ─────────────────────────────────────────
// OCR job queue routes
// ─────────────────────────────────────────

// Submit a batch — files stored server-side, processed in background
router.post('/ocr-jobs', (req, res, next) => {
  upload.array('screenshots', 2000)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, (req, res) => {
  const files        = req.files || [];
  const source       = (req.body && req.body.source) || 'server';
  const dateOverride = (req.body && req.body.date_override) || null; // YYYY-MM-DD or null
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

  const jobId = db.prepare(
    `INSERT INTO ocr_jobs (source, status, total, date_override) VALUES (?, 'queued', ?, ?)`
  ).run(source, files.length, dateOverride).lastInsertRowid;

  const insertFile = db.prepare(
    `INSERT INTO ocr_job_files (job_id, filename, mime_type, image_blob) VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const f of files) insertFile.run(jobId, f.originalname, f.mimetype, f.buffer);
  })();

  setImmediate(runJobWorker); // kick off without blocking the response
  res.json({ jobId });
});

// Poll job status
router.get('/ocr-jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM ocr_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const files = db.prepare(
    `SELECT id, filename, status, inserted, skipped, conflicts_json, raw_json, error, warning
     FROM ocr_job_files WHERE job_id = ? ORDER BY id`
  ).all(job.id);
  res.json({ ...job, files });
});

// List recent jobs with per-job file summaries (no blobs)
router.get('/ocr-jobs', (req, res) => {
  const jobs = db.prepare(
    'SELECT id, source, status, total, done, created_at, completed_at FROM ocr_jobs ORDER BY id DESC LIMIT 30'
  ).all();
  for (const job of jobs) {
    job.files = db.prepare(
      `SELECT id, filename, status, inserted, skipped, conflicts_json, error, warning
       FROM ocr_job_files WHERE job_id = ? ORDER BY id`
    ).all(job.id);
  }
  res.json({ jobs });
});

// Discard a completed job
router.delete('/ocr-jobs/:id', (req, res) => {
  db.prepare('DELETE FROM ocr_jobs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Cancel a queued/processing job — marks all pending files as cancelled
router.patch('/ocr-jobs/:id/cancel', (req, res) => {
  const job = db.prepare('SELECT * FROM ocr_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return res.status(400).json({ error: 'Job is already finished' });
  }
  db.prepare(`UPDATE ocr_job_files SET status = 'cancelled' WHERE job_id = ? AND status IN ('queued')`).run(req.params.id);
  db.prepare(`UPDATE ocr_jobs SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Clear conflicts_json for all files in a job (called after user resolves them)
router.patch('/ocr-jobs/:id/clear-conflicts', (req, res) => {
  db.prepare(`UPDATE ocr_job_files SET conflicts_json = NULL WHERE job_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Resume any jobs queued before the server restarted
setImmediate(runJobWorker);

// ─────────────────────────────────────────

router.post('/colleagues/import-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Include ALL colleagues in match pool — left_date is checked per-shift below
  const today = localDateStr();
  const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY name ASC').all()
    .filter(c => !c.start_date || c.start_date <= today);
  if (colleagues.length === 0) return res.status(400).json({ error: 'Add colleagues first before importing' });
  const colById = Object.fromEntries(colleagues.map(c => [c.id, c]));

  try {
    // Preprocess image: greyscale + contrast boost + 2× upscale
    // This dramatically improves Tesseract accuracy on small mobile screenshots
    let ocrBuffer = req.file.buffer;
    try {
      const img = await Jimp.read(ocrBuffer);
      img.greyscale().contrast(0.4).scale(2);
      ocrBuffer = await img.getBufferAsync(Jimp.MIME_PNG);
    } catch (prepErr) {
      console.warn('Image preprocessing skipped:', prepErr.message);
    }

    // Run Tesseract OCR
    const worker = await createWorker('eng');
    const { data: { text } } = await worker.recognize(ocrBuffer);
    await worker.terminate();

    // Parse the OCR output, then filter out shifts where the colleague had left by that date
    const parsedRaw = parseRotageekOCR(text, colleagues);
    const parsed = parsedRaw.filter(s => {
      const col = colById[s.colleague_id];
      return !(col?.left_date && col.left_date < s.date);
    });

    if (parsed.length === 0) {
      return res.json({ inserted: 0, skipped: 0, message: 'No recognisable shifts found — check the screenshot is the Team view', rawText: text.slice(0, 3000) });
    }

    // Detect conflicts vs new inserts
    const { toInsert, conflicts, duplicates } = detectConflicts(parsed);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type)
      VALUES (?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const doInsert = db.transaction(() => {
      for (const s of toInsert) {
        insert.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type || 'shift');
        inserted++;
      }
    });
    doInsert();

    res.json({ inserted, skipped: duplicates.length, conflicts, total: parsed.length, shifts: toInsert, rawText: text.slice(0, 3000) });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'OCR failed: ' + err.message });
  }
});

// ─────────────────────────────────────────
// Gemini AI Screenshot import
// ─────────────────────────────────────────

// Shared by any route that needs an image read by Gemini (team-schedule screenshots
// here, and the payslip-photo import in server.js). Throws (with .status) for a
// missing key or a hard API error; returns parsed:null (with rawText) if Gemini's
// response wasn't valid JSON, so callers can decide how to surface that softly.
async function callGeminiVision(imageBuffer, mimeType, prompt = OLLAMA_PROMPT) {
  const keyRow   = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_model'").get();
  const apiKey   = keyRow   && keyRow.value   && keyRow.value.trim();
  const model    = (modelRow && modelRow.value && modelRow.value.trim()) || 'gemini-2.0-flash';
  if (!apiKey) {
    const err = new Error('No Gemini API key configured. Add one in Settings → AI Screenshot Import.');
    err.status = 400;
    throw err;
  }

  const imageB64 = imageBuffer.toString('base64');
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageB64 } }] }],
        generationConfig: { temperature: 0 }
      })
    }
  );

  if (!geminiRes.ok) {
    const errBody = await geminiRes.json().catch(() => ({}));
    const err = new Error(errBody?.error?.message || `Gemini API error ${geminiRes.status}`);
    err.status = 502;
    throw err;
  }

  const geminiData = await geminiRes.json();
  const rawText    = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Strip markdown code fences if Gemini wrapped the JSON
  const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonStr); } catch (_) { /* leave parsed null — caller handles */ }
  return { parsed, rawText };
}

// Read a screenshot with Gemini and return the raw { date_range, schedule } JSON —
// no DB writes. Lets the Team Upload UI run an AI-read screenshot through the exact
// same preview/conflict-resolution flow as a manually pasted JSON.
router.post('/colleagues/gemini-extract', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { parsed, rawText } = await callGeminiVision(req.file.buffer, req.file.mimetype || 'image/png');
    if (!parsed) {
      return res.status(502).json({ error: 'Gemini returned unexpected output — could not parse JSON', rawText: rawText.slice(0, 3000) });
    }
    res.json({ data: parsed });
  } catch (err) {
    console.error('Gemini extract error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/colleagues/import-screenshot-gemini', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Include ALL colleagues in match pool — left_date is checked per-shift below
  const today = localDateStr();
  const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY name ASC').all()
    .filter(c => !c.start_date || c.start_date <= today);
  if (colleagues.length === 0) return res.status(400).json({ error: 'Add colleagues first before importing' });

  try {
    const { parsed, rawText } = await callGeminiVision(req.file.buffer, req.file.mimetype || 'image/png');
    if (!parsed) {
      return res.json({ inserted: 0, skipped: 0,
        message: 'Gemini returned unexpected output — could not parse JSON',
        rawJson: rawText.slice(0, 3000) });
    }

    // Normalise grouped { date_range, schedule } → flat { shifts } with YYYY-MM-DD dates
    const normParsed = normaliseAIOutput(parsed);
    const shifts = normParsed.shifts || [];
    if (!shifts.length) {
      return res.json({ inserted: 0, skipped: 0,
        message: 'No shifts found in Gemini response', rawJson: JSON.stringify(normParsed).slice(0, 3000) });
    }

    // Fuzzy-match names against colleagues, build normalised rows
    const parsedRows = [];
    for (const s of shifts) {
      const matched   = fuzzyMatch(s.name || '', colleagues);
      if (!matched) continue;
      // Skip if colleague had left before this shift date
      if (matched.left_date && matched.left_date < s.date) continue;
      const shiftType = s.type || 'shift';
      const startTime = shiftType === 'shift' ? (s.start_time || '00:00') : '00:00';
      const endTime   = shiftType === 'shift' ? (s.end_time   || '00:00') : '00:00';
      parsedRows.push({ colleague_id: matched.id, name: matched.name, date: s.date, start_time: startTime, end_time: endTime, shift_type: shiftType, store: s.store || null });
    }

    // Detect conflicts vs new inserts
    const { toInsert, conflicts, duplicates } = detectConflicts(parsedRows);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, store)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const doInsert = db.transaction(() => {
      for (const s of toInsert) {
        insert.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type, s.store || null);
        inserted++;
      }
    });
    doInsert();

    res.json({ inserted, skipped: duplicates.length, conflicts, total: shifts.length, shifts: toInsert, rawJson: JSON.stringify(normParsed).slice(0, 3000) });
  } catch(err) {
    console.error('Gemini import error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Gemini import failed: ' + err.message) });
  }
});

// ─────────────────────────────────────────
// Ollama — list installed models
// ─────────────────────────────────────────

router.get('/colleagues/ollama-models', async (req, res) => {
  const source = req.query.source || 'server';
  const urlKey = source === 'remote' ? 'ollama_remote_url' : 'ollama_server_url';
  const urlRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(urlKey);
  const baseUrl = (urlRow?.value?.trim()) || (source === 'remote' ? '' : 'http://localhost:11434');
  if (!baseUrl) return res.status(400).json({ error: 'No Ollama URL configured for this source' });
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
    if (!r.ok) return res.status(502).json({ error: `Ollama returned ${r.status}` });
    const data = await r.json();
    res.json({ models: (data.models || []).map(m => m.name).sort() });
  } catch (err) {
    const isConnRefused = err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED';
    if (isConnRefused) return res.status(502).json({ error: `Cannot connect to Ollama at ${baseUrl}` });
    res.status(500).json({ error: err.message });
  }
});

router.get('/colleagues/lmstudio-models', async (req, res) => {
  const urlRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('lmstudio_url');
  const baseUrl = urlRow?.value?.trim() || '';
  if (!baseUrl) return res.status(400).json({ error: 'No LM Studio URL configured' });
  try {
    const r = await fetch(`${_lmstudioApiBase(baseUrl)}/models`);
    if (!r.ok) return res.status(502).json({ error: `LM Studio returned ${r.status}` });
    const data = await r.json();
    res.json({ models: (data.data || []).map(m => m.id).filter(Boolean).sort() });
  } catch (err) {
    const isConnRefused = err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED';
    if (isConnRefused) return res.status(502).json({ error: `Cannot connect to LM Studio at ${baseUrl}` });
    res.status(500).json({ error: err.message });
  }
});

// Live model list from Google, rather than a hardcoded dropdown that inevitably goes
// stale whenever Google retires/renames a model (as gemini-2.5-flash was). Filtered to
// models that support generateContent and can take image input, since that's what the
// screenshot-import prompt needs.
router.get('/colleagues/gemini-models', async (req, res) => {
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const apiKey = keyRow && keyRow.value && keyRow.value.trim();
  if (!apiKey) return res.status(400).json({ error: 'No Gemini API key configured yet' });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({}));
      return res.status(502).json({ error: errBody?.error?.message || `Gemini API returned ${r.status}` });
    }
    const data = await r.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      // Vision screenshot import needs an image-capable model — embedding/text-only
      // models support generateContent too but aren't useful here, so drop obvious
      // non-multimodal names.
      .filter(name => !/embedding|aqa/i.test(name))
      .sort();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Ollama model pull (streams progress back as SSE)
// ─────────────────────────────────────────

router.post('/ollama-pull', async (req, res) => {
  const { source, model } = req.body || {};
  if (!model || !model.trim()) return res.status(400).json({ error: 'Model name required' });

  const urlKey  = source === 'remote' ? 'ollama_remote_url' : 'ollama_server_url';
  const urlRow  = db.prepare('SELECT value FROM settings WHERE key = ?').get(urlKey);
  const baseUrl = urlRow?.value?.trim() || (source === 'remote' ? '' : 'http://localhost:11434');
  if (!baseUrl) return res.status(400).json({ error: 'No Ollama URL configured for this source' });

  // Stream SSE back to the browser
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.trim(), stream: true })
    });

    if (!r.ok) {
      send({ error: `Ollama returned ${r.status}` });
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          send(obj);
          if (obj.status === 'success') { res.end(); return; }
        } catch (_) {}
      }
    }
    send({ status: 'success' });
    res.end();
  } catch (err) {
    send({ error: err.message });
    res.end();
  }
});

// ─────────────────────────────────────────
// Ollama (Local / Remote) Screenshot import
// ─────────────────────────────────────────

router.post('/colleagues/import-screenshot-ollama', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const source = (req.body && req.body.source) || 'server'; // 'server' | 'remote'

  // Include ALL colleagues in match pool — left_date is checked per-shift below
  const today = localDateStr();
  const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY name ASC').all()
    .filter(c => !c.start_date || c.start_date <= today);
  if (colleagues.length === 0) return res.status(400).json({ error: 'Add colleagues first before importing' });

  const urlKey   = source === 'remote' ? 'ollama_remote_url'   : 'ollama_server_url';
  const modelKey = source === 'remote' ? 'ollama_remote_model' : 'ollama_server_model';

  const urlRow   = db.prepare('SELECT value FROM settings WHERE key = ?').get(urlKey);
  const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(modelKey);

  const baseUrl = (urlRow?.value?.trim()) || (source === 'remote' ? '' : 'http://localhost:11434');
  const model   = (modelRow?.value?.trim()) || (source === 'remote' ? 'qwen2.5vl:7b' : 'qwen2.5vl:3b');

  if (!baseUrl) return res.status(400).json({ error: `No Ollama URL configured. Set it in Settings → Integrations.` });

  try {
    const imageB64 = req.file.buffer.toString('base64');

    const ollamaRes = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: OLLAMA_PROMPT, images: [imageB64] }],
        stream: false,
        options: { temperature: 0, seed: 42, num_ctx: 16384, num_predict: 20000 }
      })
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => '');
      return res.status(502).json({ error: `Ollama error ${ollamaRes.status}: ${errText.slice(0, 300)}` });
    }

    const ollamaData = await ollamaRes.json();
    const rawText    = ollamaData?.message?.content || '';

    // Strip markdown code fences if the model wrapped the JSON
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch (_) {
      return res.json({ inserted: 0, skipped: 0,
        message: 'Ollama returned unexpected output — could not parse JSON',
        rawJson: rawText.slice(0, 3000) });
    }

    const shifts = parsed.shifts || [];
    if (!shifts.length) {
      return res.json({ inserted: 0, skipped: 0,
        message: 'No shifts found in Ollama response', rawJson: rawText.slice(0, 3000) });
    }

    const parsedRows = [];
    for (const s of shifts) {
      const matched   = fuzzyMatch(s.name || '', colleagues);
      if (!matched) continue;
      // Skip if colleague had left before this shift date
      if (matched.left_date && matched.left_date < s.date) continue;
      const shiftType = s.type || 'shift';
      const startTime = shiftType === 'shift' ? (s.start_time || '00:00') : '00:00';
      const endTime   = shiftType === 'shift' ? (s.end_time   || '00:00') : '00:00';
      parsedRows.push({ colleague_id: matched.id, name: matched.name, date: s.date,
        start_time: startTime, end_time: endTime, shift_type: shiftType });
    }

    const { toInsert, conflicts, duplicates } = detectConflicts(parsedRows);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, import_source) VALUES (?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    const ollamaSource = source === 'remote' ? 'ollama-remote' : 'ollama-server';
    const doInsert = db.transaction(() => {
      for (const s of toInsert) {
        insert.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type, ollamaSource);
        inserted++;
      }
    });
    doInsert();

    res.json({ inserted, skipped: duplicates.length, conflicts, total: shifts.length,
      shifts: toInsert, rawJson: jsonStr.slice(0, 3000) });
  } catch (err) {
    console.error('Ollama import error:', err);
    const isConnRefused = err.code === 'ECONNREFUSED' ||
      err.cause?.code === 'ECONNREFUSED' || (err.message || '').includes('ECONNREFUSED');
    if (isConnRefused) {
      return res.status(502).json({ error: `Cannot connect to Ollama at ${baseUrl}. Is Ollama running?` });
    }
    res.status(500).json({ error: 'Ollama import failed: ' + err.message });
  }
});

// ─────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────

router.get('/working-with/leaderboard', (req, res) => {
  const today = localDateStr();
  const myShifts = db.prepare('SELECT date, start_time, end_time FROM shifts WHERE completed = 1 OR date <= ? ORDER BY date').all(today);

  const colleagues = db.prepare('SELECT * FROM colleagues').all();
  // Shifts at a different store don't belong to this store's stats — they'd inflate
  // "shifts together" for a day the colleague was never actually here.
  const colShifts  = db.prepare("SELECT * FROM colleague_shifts WHERE store IS NULL OR store = ''").all();

  // Build per-colleague stats — both "worked with me" (overlap with my shifts) and
  // store-wide totals (every rostered shift of theirs, regardless of whether I was on
  // with them). shiftsTogether/minutesTogether power the "Worked With Me" tabs;
  // totalShifts/totalMinutes power the store-wide tabs.
  const stats = {};
  for (const c of colleagues) {
    stats[c.id] = {
      id: c.id, name: c.name, left_date: c.left_date || null,
      shiftsTogether: 0, minutesTogether: 0,
      totalShifts: 0, totalMinutes: 0,
    };
  }

  for (const cs of colShifts) {
    if (cs.shift_type !== 'shift') continue; // exclude leave/all_day from totals
    const s = stats[cs.colleague_id];
    if (!s) continue;
    const [sh, sm] = (cs.start_time || '0:0').split(':').map(Number);
    const [eh, em] = (cs.end_time   || '0:0').split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    s.totalShifts++;
    s.totalMinutes += Math.max(0, mins);
  }

  for (const my of myShifts) {
    const same = colShifts.filter(cs => cs.date === my.date);
    for (const cs of same) {
      const mins = overlapMinutes(my.start_time, my.end_time, cs.start_time, cs.end_time);
      if (mins > 0) {
        stats[cs.colleague_id].shiftsTogether++;
        stats[cs.colleague_id].minutesTogether += mins;
      }
    }
  }

  const arr = Object.values(stats);
  const byShifts      = [...arr].sort((a,b) => b.shiftsTogether - a.shiftsTogether);
  const byHours       = [...arr].sort((a,b) => b.minutesTogether - a.minutesTogether);
  const byTotalShifts = [...arr].sort((a,b) => b.totalShifts  - a.totalShifts);
  const byTotalHours  = [...arr].sort((a,b) => b.totalMinutes - a.totalMinutes);

  res.json({ byShifts, byHours, byTotalShifts, byTotalHours });
});

// ─────────────────────────────────────────
// People — upcoming shared shifts table
// ─────────────────────────────────────────

router.get('/working-with/people', (req, res) => {
  const today = localDateStr();

  // All my upcoming shifts (include today)
  const myShifts = db.prepare(
    "SELECT id, date, start_time, end_time FROM shifts WHERE date >= ? ORDER BY date ASC"
  ).all(today);

  // Only match against active colleagues (exclude those who have left)
  const allColleagues = db.prepare('SELECT * FROM colleagues ORDER BY name ASC').all();
  // Use today's date as the reference — screenshot imports are assumed to be recent
  const importDate = localDateStr();
  const colleagues = allColleagues.filter(c => (!c.left_date || c.left_date >= importDate) && (!c.start_date || c.start_date <= importDate));
  const colShifts  = db.prepare(
    "SELECT * FROM colleague_shifts WHERE date >= ? AND (store IS NULL OR store = '') ORDER BY date ASC"
  ).all(today);

  // For each of my shifts, find who's on with me and the overlap
  const rows = myShifts.map(my => {
    const overlap = {};
    const same = colShifts.filter(cs => cs.date === my.date);
    for (const cs of same) {
      const mins = overlapMinutes(my.start_time, my.end_time, cs.start_time, cs.end_time);
      if (mins > 0) {
        if (!overlap[cs.colleague_id] || mins > overlap[cs.colleague_id].mins) {
          overlap[cs.colleague_id] = { mins, start_time: cs.start_time, end_time: cs.end_time };
        }
      }
    }
    return { shift: my, overlap };
  });

  res.json({ colleagues, rows });
});

// ─────────────────────────────────────────
// Next shared shifts with one colleague
// ─────────────────────────────────────────

router.get('/working-with/next/:colleagueId', (req, res) => {
  const today = localDateStr();
  const limit = parseInt(req.query.limit || '5', 10);

  const colleague = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(req.params.colleagueId);
  if (!colleague) return res.status(404).json({ error: 'Not found' });

  const myShifts  = db.prepare("SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC").all(today);
  const colShifts = db.prepare("SELECT * FROM colleague_shifts WHERE colleague_id = ? AND date >= ? AND (store IS NULL OR store = '') ORDER BY date ASC")
    .all(req.params.colleagueId, today);

  const shared = [];
  for (const my of myShifts) {
    // A colleague can have more than one shift on the same date (e.g. a split shift).
    // Check every shift that date and take the one that actually overlaps with mine —
    // using only the first match here previously meant a genuinely overlapping second
    // shift could be skipped entirely, silently dropping that day from the list.
    const csForDay = colShifts.filter(s => s.date === my.date);
    if (!csForDay.length) continue;
    let best = null;
    for (const cs of csForDay) {
      const mins = overlapMinutes(my.start_time, my.end_time, cs.start_time, cs.end_time);
      if (mins > 0 && (!best || mins > best.overlapMins)) {
        best = { date: my.date, myStart: my.start_time, myEnd: my.end_time,
                 theirStart: cs.start_time, theirEnd: cs.end_time, overlapMins: mins };
      }
    }
    if (best) {
      shared.push(best);
      if (shared.length >= limit) break;
    }
  }

  res.json({ colleague, shifts: shared });
});

// ─────────────────────────────────────────
// V2.0 Phase 2.2 — Shift Quality & Synergy Score
// ─────────────────────────────────────────

/** Bucket a 0-100 synergy score into a human label, matching the spec's
 *  "88% (Dream Team)" style summary. */
function synergyLabel(score) {
  if (score == null) return null;
  if (score >= 85) return 'Dream Team';
  if (score >= 65) return 'Great Crew';
  if (score >= 45) return 'Balanced';
  if (score >= 25) return 'Tough Shift';
  return 'Rough Shift';
}

router.get('/working-with/synergy-score/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  // Your own shift that day (first one, if there happen to be more than one — e.g. a split shift)
  const myShift = db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').get(date);

  // Full colleague roster for the day (working shifts only — annual leave doesn't count
  // towards coverage or synergy). Joined with pay-profile/synergy fields from Phase 1.
  const dayShifts = db.prepare(`
    SELECT cs.*, c.name, c.tags, c.synergy_rating, c.notes
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date = ? AND cs.shift_type != 'leave' AND (cs.store IS NULL OR cs.store = '')
    ORDER BY cs.start_time ASC
  `).all(date);

  // Colleagues rostered elsewhere today — not part of this store's roster/coverage,
  // but worth surfacing so it's clear why they're missing from the team above.
  const elsewhereToday = db.prepare(`
    SELECT c.name, cs.store, cs.start_time, cs.end_time
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date = ? AND cs.shift_type != 'leave' AND cs.store IS NOT NULL AND cs.store != ''
    ORDER BY c.sort_order ASC, c.name ASC
  `).all(date);

  const decorated = dayShifts.map(s => {
    let tags = [];
    try { tags = s.tags ? JSON.parse(s.tags) : []; } catch (_) { tags = []; }
    return { ...s, tags };
  });

  let team = [];
  let synergyScore = null;

  if (myShift) {
    const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    let myDurationMins = toMins(myShift.end_time) - toMins(myShift.start_time);
    if (myDurationMins <= 0) myDurationMins += 24 * 60; // overnight shift

    team = decorated.map(s => {
      // "all_day" entries (whole-day work, not a specific window) count as fully overlapping
      const overlapMins = s.shift_type === 'all_day'
        ? myDurationMins
        : overlapMinutes(myShift.start_time, myShift.end_time, s.start_time, s.end_time);
      const overlapPct = myDurationMins > 0 ? Math.round((overlapMins / myDurationMins) * 100) : 0;
      return {
        colleague_id: s.colleague_id, name: s.name, tags: s.tags,
        synergy_rating: s.synergy_rating ?? 0, notes: s.notes,
        start_time: s.start_time, end_time: s.end_time,
        overlap_minutes: overlapMins, overlap_pct: overlapPct,
        counted: overlapPct >= 50,
      };
    });

    const counted = team.filter(t => t.counted);
    if (counted.length > 0) {
      const sum = counted.reduce((t, c) => t + (c.synergy_rating || 0), 0);
      synergyScore = Math.round(50 + (sum / (counted.length * 2)) * 50);
      synergyScore = Math.max(0, Math.min(100, synergyScore));
    }
  }

  // Team highlights — simple heuristics over the full day's roster (not just the
  // >=50%-overlap group, since store-wide coverage gaps matter regardless of overlap).
  const highlights = [];
  const efficientCount = decorated.filter(s => s.tags.some(t => /fast|efficient|quick/i.test(t))).length;
  if (efficientCount >= 2) {
    highlights.push({ type: 'positive', text: `High-Efficiency Crew: ${efficientCount} fast/efficient colleagues scheduled today.` });
  }
  const hasKeyholder = decorated.some(s => s.tags.some(t => /keyholder/i.test(t)));
  if (decorated.length > 0 && !hasKeyholder) {
    highlights.push({ type: 'warning', text: 'No keyholder tagged among today\'s scheduled team — check store cover.' });
  }
  if (decorated.length === 0) {
    highlights.push({ type: 'warning', text: 'No colleague shifts recorded for this day yet — import the rota to see the roster.' });
  }
  for (const e of elsewhereToday) {
    highlights.push({ type: 'info', text: `${e.name} is working at ${e.store} today — not counted for this store.` });
  }

  res.json({
    date,
    your_shift: myShift ? { start_time: myShift.start_time, end_time: myShift.end_time } : null,
    synergy_score: synergyScore,
    rating_label: synergyLabel(synergyScore),
    team,
    highlights,
  });
});

// ─────────────────────────────────────────
// Team Week View — everyone's shifts for a Mon–Sun week
// ─────────────────────────────────────────

router.get('/working-with/team-week', (req, res) => {
  // Derive Mon–Sun bounds from ?week=YYYY-MM-DD (any date in the week works)
  const weekParam = req.query.week || localDateStr();
  const anchor = new Date(weekParam + 'T00:00:00');
  const dow = (anchor.getDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(anchor); monday.setDate(anchor.getDate() - dow);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);

  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const from = fmt(monday);
  const to   = fmt(sunday);

  const allColleagues = db.prepare('SELECT * FROM colleagues ORDER BY sort_order ASC, name ASC').all();
  const sourceFilter = req.query.importSource && req.query.importSource !== 'all' ? req.query.importSource : null;
  const colShifts   = sourceFilter
    ? db.prepare('SELECT * FROM colleague_shifts WHERE date >= ? AND date <= ? AND import_source = ? ORDER BY date, start_time').all(from, to, sourceFilter)
    : db.prepare('SELECT * FROM colleague_shifts WHERE date >= ? AND date <= ? ORDER BY date, start_time').all(from, to);
  const myShiftsRaw = db.prepare(
    'SELECT date, start_time, end_time FROM shifts WHERE date >= ? AND date <= ? ORDER BY date, start_time'
  ).all(from, to);

  // Expand own leave_entries that overlap this week into individual day entries
  const myLeaveEntries = db.prepare(
    'SELECT * FROM leave_entries WHERE start_date <= ? AND end_date >= ?'
  ).all(to, from);
  const myLeave = [];
  for (const le of myLeaveEntries) {
    const cur = new Date(le.start_date + 'T00:00:00');
    const end = new Date(le.end_date   + 'T00:00:00');
    while (cur <= end) {
      const d = fmt(cur);
      if (d >= from && d <= to)
        myLeave.push({ date: d, shift_type: 'leave', start_time: '00:00', end_time: '00:00' });
      cur.setDate(cur.getDate() + 1);
    }
  }
  const myShifts = [...myShiftsRaw, ...myLeave];

  // Only show colleagues who were employed during this week, or who have a shift this week
  const colleagues = allColleagues.filter(c => {
    const startedByWeekEnd  = !c.start_date || c.start_date <= to;
    const notLeftByWeekStart = !c.left_date  || c.left_date  >= from;
    const employedThisWeek  = startedByWeekEnd && notLeftByWeekStart;
    const hasShiftThisWeek  = colShifts.some(s => s.colleague_id === c.id);
    return employedThisWeek || hasShiftThisWeek;
  });

  const myName = db.prepare("SELECT value FROM settings WHERE key='employee_name'").get()?.value || 'Me';

  // Current contracted hours per week (latest pay rate effective by the week end)
  const payRates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date DESC').all();
  const applicableRate = payRates.find(r => r.effective_date <= to);
  const myContractHours = applicableRate?.contracted_hours_per_week || 0;

  res.json({ from, to, myName, myShifts, colleagues, colShifts, myContractHours });
});

// ─────────────────────────────────────────
// Team Calendar — one colleague's schedule
// ─────────────────────────────────────────

router.get('/working-with/team-calendar', (req, res) => {
  const { colleagueId, from, to } = req.query;
  // Include all colleagues (past and present) so historical shifts remain browsable
  const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY sort_order ASC, name ASC').all();
  let shifts = [], weeklyHours = [];

  if (colleagueId) {
    let q = 'SELECT * FROM colleague_shifts WHERE colleague_id = ?';
    const params = [colleagueId];
    if (from) { q += ' AND date >= ?'; params.push(from); }
    if (to)   { q += ' AND date <= ?'; params.push(to); }
    const { importSource } = req.query;
    if (importSource && importSource !== 'all') {
      q += ' AND import_source = ?'; params.push(importSource);
    }
    q += ' ORDER BY date ASC';
    shifts = db.prepare(q).all(...params);

    const weekMap = {};
    for (const s of shifts) {
      if (s.shift_type === 'leave' || s.shift_type === 'all_day') continue;
      const d = new Date(s.date + 'T00:00:00');
      const dow = (d.getDay() + 6) % 7;
      const weekStart = new Date(d); weekStart.setDate(d.getDate() - dow);
      const wk = localDateStr(weekStart);
      if (!weekMap[wk]) weekMap[wk] = 0;
      const [sh,sm] = s.start_time.split(':').map(Number);
      const [eh,em] = s.end_time.split(':').map(Number);
      const gross = (eh*60+em) - (sh*60+sm);
      if (gross > 0) {
        const brk = gross < 270 ? 0 : gross <= 360 ? 15 : 30;
        weekMap[wk] += gross - brk;
      }
    }
    weeklyHours = Object.entries(weekMap)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([week, mins]) => ({ week, hours: Math.round(mins/60*100)/100 }));
  }

  res.json({ colleagues, shifts, weeklyHours });
});


// ── Manual colleague-shifts: add & delete ──────────────────────────────────



router.post('/colleague-shifts/resolve-conflicts', (req, res) => {
  // toDelete: existing shift IDs to remove
  // toInsert: new shift objects to insert
  const { toDelete = [], toInsert = [] } = req.body;
  try {
    const del = db.prepare('DELETE FROM colleague_shifts WHERE id = ?');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type) VALUES (?,?,?,?,?)'
    );
    db.transaction(() => {
      for (const id of toDelete) del.run(id);
      for (const s of toInsert) ins.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type || 'shift');
    })();
    res.json({ ok: true, deleted: toDelete.length, inserted: toInsert.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/colleague-shifts/bulk-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  try {
    const placeholders = ids.map(() => '?').join(',');
    const info = db.prepare(`DELETE FROM colleague_shifts WHERE id IN (${placeholders})`).run(...ids);
    res.json({ deleted: info.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/colleague-shifts', (req, res) => {
  const { colleague_id, date, shift_type, start_time, end_time, store } = req.body;
  if (!colleague_id || !date) return res.status(400).json({ error: 'colleague_id and date are required' });
  const validTypes = ['shift', 'leave', 'all_day'];
  const type = validTypes.includes(shift_type) ? shift_type : 'shift';
  // For leave/all_day, use '00:00' placeholder (schema has NOT NULL)
  const sTime = type === 'shift' ? (start_time || '09:00') : '00:00';
  const eTime = type === 'shift' ? (end_time   || '17:00') : '00:00';
  const storeVal = (store || '').trim() || null;
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO colleague_shifts (colleague_id, date, shift_type, start_time, end_time, store)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(colleague_id, date, type, sTime, eTime, storeVal);
    res.json({ id: info.lastInsertRowid, colleague_id, date, shift_type: type, start_time: sTime, end_time: eTime, store: storeVal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});






router.put('/colleague-shifts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { shift_type, start_time, end_time, store } = req.body;
  const validTypes = ['shift', 'leave', 'all_day'];
  const type = validTypes.includes(shift_type) ? shift_type : 'shift';
  const sTime = type === 'shift' ? (start_time || '09:00') : '00:00';
  const eTime = type === 'shift' ? (end_time   || '17:00') : '00:00';
  const storeVal = (store || '').trim() || null;
  try {
    const info = db.prepare(
      'UPDATE colleague_shifts SET shift_type=?, start_time=?, end_time=?, store=? WHERE id=?'
    ).run(type, sTime, eTime, storeVal, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id, shift_type: type, start_time: sTime, end_time: eTime, store: storeVal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/colleague-shifts/by-month/:month', (req, res) => {
  const month = req.params.month; // YYYY-MM
  if (!month) return res.status(400).json({ error: 'month required' });
  try {
    const info = db.prepare(
      "DELETE FROM colleague_shifts WHERE strftime('%Y-%m', date) = ?"
    ).run(month);
    res.json({ deleted: info.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/colleague-shifts/all', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM colleague_shifts').run();
    res.json({ deleted: info.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/colleague-shifts/by-colleague/:colleagueId/month/:month', (req, res) => {
  const colleagueId = parseInt(req.params.colleagueId, 10);
  const month = req.params.month; // YYYY-MM
  if (!colleagueId || !month) return res.status(400).json({ error: 'Invalid params' });
  try {
    const info = db.prepare(
      "DELETE FROM colleague_shifts WHERE colleague_id = ? AND strftime('%Y-%m', date) = ?"
    ).run(colleagueId, month);
    res.json({ deleted: info.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/colleague-shifts/by-colleague/:colleagueId', (req, res) => {
  const colleagueId = parseInt(req.params.colleagueId, 10);
  if (!colleagueId) return res.status(400).json({ error: 'Invalid colleagueId' });
  try {
    const info = db.prepare('DELETE FROM colleague_shifts WHERE colleague_id = ?').run(colleagueId);
    res.json({ deleted: info.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/colleague-shifts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const info = db.prepare('DELETE FROM colleague_shifts WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// JSON schedule import  (Team Upload → JSON Import tab)
// Body: { schedule_data: { date_range, schedule: [{date, shifts:[{name,time,type}]}] } }
//
// Date resolution:
//   date_range "23 - Mar 01, 2026" → week ending 2026-03-01
//   day entry  "Mon 23" / "Sun 01" → matched by day-of-month against those 7 dates
//
// Rules:
//   • Skips shifts matching the "your_name" setting (your own shifts)
//   • If a person appears more than once on the same day → warn + skip both
//   • If a day can't be resolved to a date within the range → warn + skip all its shifts
// ─────────────────────────────────────────

/** Parse date_range string → array of 7 ISO date strings (Mon … Sun).
 *  Handles both formats:
 *   "01 - Dec 7, 2025"           → end date = Dec 7
 *   "Apr 27, 2026 – May 3, 2026" → end date = May 3
 *  The $ anchor ensures we always pick the LAST date (the week end), not the start. */
function resolveWeekDates(dateRange) {
  if (!dateRange) return null;
  const SHORT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // Match the LAST "Month Day[,] Year" in the string
  const m = dateRange.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})\s*$/);
  if (!m) return null;
  const monIdx = SHORT_MONTHS.indexOf(m[1].toLowerCase().substring(0, 3));
  if (monIdx === -1) return null;
  const endDate = new Date(parseInt(m[3]), monIdx, parseInt(m[2]));
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(endDate.getDate() - i);
    dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  return dates;  // [Monday … Sunday]
}

/** Resolve a day string like "Mon 23" or "Sun 01" to an ISO date within weekDates */
function resolveDayDate(dayStr, weekDates) {
  if (!weekDates || !dayStr) return null;
  const m = dayStr.match(/(\d{1,2})\s*$/);
  if (!m) return null;
  const dayNum = parseInt(m[1], 10);
  return weekDates.find(d => parseInt(d.slice(8), 10) === dayNum) || null;
}

/**
 * Normalise AI output to flat { shifts: [...] } with YYYY-MM-DD dates.
 * Accepts both:
 *   New grouped: { date_range, schedule: [{ date:"Mon 23", shifts:[{name,time,type}] }] }
 *   Old flat:    { shifts: [{ name, date:"YYYY-MM-DD", start_time, end_time, type }] }
 */
function normaliseAIOutput(parsed) {
  // Already flat — pass through unchanged
  if (Array.isArray(parsed?.shifts) && !parsed.schedule) return parsed;

  if (!Array.isArray(parsed?.schedule)) return { shifts: [] };

  const weekDates = resolveWeekDates(parsed.date_range);
  const shifts = [];

  for (const day of parsed.schedule) {
    const isoDate = resolveDayDate(day.date, weekDates);
    if (!isoDate) continue;

    for (const s of (day.shifts || [])) {
      if (!s.name) continue;
      const typeLower = (s.type || '').toLowerCase();

      const store = (s.store || '').trim() || null;

      if (typeLower === 'leave') {
        shifts.push({ name: s.name, date: isoDate, type: 'leave', store });
        continue;
      }
      if (typeLower === 'all_day') {
        shifts.push({ name: s.name, date: isoDate, type: 'all_day', store });
        continue;
      }

      const tm = (s.time || '').match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
      if (!tm) continue;

      shifts.push({
        name:       s.name,
        date:       isoDate,
        start_time: tm[1].padStart(5, '0'),
        end_time:   tm[2].padStart(5, '0'),
        store,
      });
    }
  }

  return { shifts };
}

router.post('/colleagues/import-json', (req, res) => {
  const { schedule_data, overrides = [] } = req.body;
  if (!schedule_data || !Array.isArray(schedule_data.schedule))
    return res.status(400).json({ error: 'Expected { schedule_data: { date_range, schedule: [...] } }' });

  // Parse week dates — supports both "01 - Dec 7, 2025" and "Apr 27, 2026 – May 3, 2026"
  const weekDates = resolveWeekDates(schedule_data.date_range);
  if (!weekDates)
    return res.status(400).json({ error: 'Cannot parse date_range: ' + (schedule_data.date_range || '(missing)') });

  const yourName = (
    db.prepare("SELECT value FROM settings WHERE key='your_name'").get()?.value || ''
  ).trim().toLowerCase();

  // Load all colleagues for fuzzy matching
  const colleagues = db.prepare(
    'SELECT id, name, left_date FROM colleagues ORDER BY sort_order ASC, name ASC'
  ).all();

  // Keywords that map to the 'leave' shift_type
  const isLeaveType = t => {
    const tl = (t || '').toLowerCase().trim();
    return tl === 'leave' || tl === 'annual leave' || tl === 'al'
      || tl.includes('leave') || tl.includes('absent') || tl.includes('absence')
      || tl === 'holiday';
  };

  // Overrides: set of "colleague_id|date|start_time" keys that should be force-updated
  const overrideSet = new Set(
    (overrides || []).map(o => `${o.colleague_id}|${o.date}|${o.start_time}`)
  );

  const insertShift = db.prepare(`
    INSERT OR IGNORE INTO colleague_shifts
      (colleague_id, date, start_time, end_time, shift_type, import_source, store)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateShift = db.prepare(`
    UPDATE colleague_shifts
    SET end_time=?, shift_type=?, import_source=?, store=?
    WHERE colleague_id=? AND date=? AND start_time=?
  `);
  const checkExisting = db.prepare(
    'SELECT end_time, shift_type FROM colleague_shifts WHERE colleague_id=? AND date=? AND start_time=?'
  );

  let inserted = 0, updated = 0, skipped = 0;
  const unknownNames = new Set();
  const warnings = [];
  const conflicts = []; // shifts that exist in DB with different data

  db.transaction(() => {
    for (const day of schedule_data.schedule) {
      const dayDate = resolveDayDate(day.date, weekDates);

      if (!dayDate) {
        const count = (day.shifts || []).length;
        if (count > 0)
          warnings.push(`Could not resolve date for "${day.date}" — ${count} shift${count !== 1 ? 's' : ''} skipped`);
        skipped += count;
        continue;
      }

      for (const shift of (day.shifts || [])) {
        const rawName = (shift.name || '').trim();
        if (!rawName) { skipped++; continue; }

        // Skip own shifts
        if (yourName && rawName.toLowerCase() === yourName) { skipped++; continue; }

        // Classify shift type — any unrecognised type is treated as a regular shift
        const typeStr  = (shift.type || '').trim();
        const typeLower = typeStr.toLowerCase();
        let shift_type, start_time, end_time;

        if (isLeaveType(typeLower)) {
          shift_type = 'leave';
          start_time = '00:00';
          end_time   = '00:00';
        } else if (typeLower === 'all_day' || typeLower === 'all day') {
          shift_type = 'all_day';
          start_time = '00:00';
          end_time   = '00:00';
        } else {
          // Regular shift — any type label (CHANGEOVER, Late, etc.) is accepted; must have times
          const tm = (shift.time || '').match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
          if (!tm) { skipped++; continue; }
          shift_type = 'shift';
          start_time = tm[1].padStart(5, '0');
          end_time   = tm[2].padStart(5, '0');
        }

        // A different-store shift is signalled by a "store" field on the incoming
        // shift (populated by the AI when it spots a location line under the time).
        const store = (shift.store || '').trim() || null;

        // Fuzzy-match against known colleagues
        const col = fuzzyMatch(rawName, colleagues);
        if (!col) { unknownNames.add(rawName); skipped++; continue; }
        if (col.left_date && col.left_date < dayDate) { skipped++; continue; }

        const key = `${col.id}|${dayDate}|${start_time}`;

        if (overrideSet.has(key)) {
          // User chose to overwrite this conflict
          const r = updateShift.run(end_time, shift_type, 'json', store, col.id, dayDate, start_time);
          if (r.changes > 0) updated++; else skipped++;
        } else {
          const r = insertShift.run(col.id, dayDate, start_time, end_time, shift_type, 'json', store);
          if (r.changes > 0) {
            inserted++;
          } else {
            // Row already exists — check whether data actually differs
            const existing = checkExisting.get(col.id, dayDate, start_time);
            if (existing && (existing.end_time !== end_time || existing.shift_type !== shift_type)) {
              // Real conflict: same key, different times/type — let user decide
              conflicts.push({
                colleague_id: col.id,
                name:         col.name,
                date:         dayDate,
                start_time,
                existing: { end_time: existing.end_time, shift_type: existing.shift_type },
                incoming: { end_time,                    shift_type }
              });
            } else {
              skipped++; // true duplicate — identical data, nothing to do
            }
          }
        }
      }
    }
  })();

  res.json({ inserted, updated, skipped, conflicts, warnings, unknownNames: [...unknownNames] });
});

// ─────────────────────────────────────────
// Bulk team shift import by name (CSV / JSON / bookmarklet methods)
// Body: { shifts: [{name, date, start_time, end_time, break_minutes, shift_type}] }
// Auto-creates colleagues that don't exist yet.
// ─────────────────────────────────────────

router.post('/team-shifts/import', (req, res) => {
  const { shifts, overwrite } = req.body;
  if (!Array.isArray(shifts) || !shifts.length)
    return res.status(400).json({ error: 'shifts array required' });

  // Lookup by name only — never auto-create. Colleagues with a left_date before
  // the shift date are treated as not found (they've left).
  const getCol = db.prepare(
    'SELECT id, left_date FROM colleagues WHERE name = ? COLLATE NOCASE'
  );
  const insertShift = db.prepare(
    'INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type) VALUES (?,?,?,?,?)'
  );
  const replaceShift = db.prepare(
    'INSERT OR REPLACE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type) VALUES (?,?,?,?,?)'
  );

  let imported = 0, skipped = 0;
  const errors      = [];
  const unknownNames = [];

  db.transaction(() => {
    for (const s of shifts) {
      const name      = (s.name || s.colleague_name || '').trim();
      const date      = (s.date || '').trim();
      const startTime = (s.start_time || '').trim() || '09:00';
      const endTime   = (s.end_time   || '').trim() || '17:00';
      const shiftType = ['shift','leave','all_day'].includes(s.shift_type) ? s.shift_type : 'shift';

      if (!name || !date) { skipped++; continue; }

      const col = getCol.get(name);
      if (!col) {
        if (!unknownNames.includes(name)) unknownNames.push(name);
        skipped++; continue;
      }

      if (col.left_date && col.left_date < date) { skipped++; continue; }

      const stmt = overwrite ? replaceShift : insertShift;
      const info = stmt.run(col.id, date, startTime, endTime, shiftType);
      if (info.changes > 0) imported++;
      else skipped++;
    }
  })();

  res.json({ imported, skipped, errors, unknownNames });
});

// ─────────────────────────────────────────
// Compare sources — show what each source imported for a date range
// ─────────────────────────────────────────


router.get('/colleague-shifts/all', (req, res) => {
  try {
    const shifts = db.prepare(
      'SELECT * FROM colleague_shifts ORDER BY date ASC, start_time ASC'
    ).all();
    const colleagues = db.prepare('SELECT id, name FROM colleagues ORDER BY name ASC').all();
    res.json({ shifts, colleagues });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


router.get('/whos-in', (req, res) => {
  const now = new Date();
  // Use Europe/London so BST (UTC+1 summer) is handled correctly regardless of Docker timezone
  const fmt = (d) => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const p  = fmt(now);
  const realToday   = `${p.year}-${p.month}-${p.day}`;
  const currentTime = `${p.hour}:${p.minute}`;
  // 60 mins from now
  const soonMs = now.getTime() + 60 * 60 * 1000;
  const sp = fmt(new Date(soonMs));
  const soonTime = `${sp.hour}:${sp.minute}`;

  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Roll the DEFAULT view over to tomorrow once it's past cutoff: 19:30 weekdays,
  // 18:30 Saturday, 16:30 Sunday. An optional `store_closing_time` setting overrides this.
  // Only used to pick a default date — explicit ?date= navigation ignores it entirely.
  const getRolloverCutoff = (dateStr) => {
    const override = db.prepare("SELECT value FROM settings WHERE key='store_closing_time'").get()?.value;
    if (override && /^\d{2}:\d{2}$/.test(override)) return override;
    const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun … 6=Sat
    if (dow === 6) return '18:30';                         // Saturday
    if (dow === 0) return '16:30';                         // Sunday
    return '19:30';                                        // weekday
  };

  // Which date are we showing?
  const requested = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : null;
  let target, isDefaultRollover = false;
  if (requested) {
    target = requested;
  } else {
    const isAfterClosing = currentTime >= getRolloverCutoff(realToday);
    target = isAfterClosing ? addDays(realToday, 1) : realToday;
    isDefaultRollover = isAfterClosing;
  }
  const isToday = target === realToday;
  const prevDate = addDays(target, -1);
  const nextDate = addDays(target, 1);

  // Helper: get all named colleague shifts for a date
  const getTeamShifts = (date) =>
    db.prepare(
      `SELECT cs.start_time, cs.end_time, c.name
       FROM colleague_shifts cs
       JOIN colleagues c ON c.id = cs.colleague_id
       WHERE cs.date = ? AND cs.shift_type = 'shift'
       ORDER BY cs.start_time ASC`
    ).all(date).map(s => ({ name: s.name, start: s.start_time, end: s.end_time }));

  const teamShifts = getTeamShifts(target);

  // Live "currently in / arriving soon" only make sense when actually viewing real today
  let inNow = [], inSoon = [], leavingInHour = [];
  if (isToday) {
    inNow = teamShifts.filter(s => s.start <= currentTime && s.end > currentTime);
    inSoon = teamShifts.filter(s => s.start > currentTime && s.start <= soonTime);
    leavingInHour = teamShifts.filter(s => s.start <= currentTime && s.end > currentTime && s.end <= soonTime)
                               .map(s => ({ name: s.name, end: s.end }));
  }

  // My own shift for the target date
  const myName = db.prepare("SELECT value FROM settings WHERE key='employee_name'").get()?.value || 'Me';
  const myShiftRow = db.prepare(
    'SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC LIMIT 1'
  ).get(target);
  const myShift = myShiftRow ? { start: myShiftRow.start_time, end: myShiftRow.end_time } : null;

  let myStatus = null;
  if (isToday && myShift) {
    if (myShift.start <= currentTime && myShift.end > currentTime) {
      myStatus = { status: 'in', start: myShift.start, end: myShift.end };
    } else if (myShift.start > currentTime && myShift.start <= soonTime) {
      myStatus = { status: 'soon', start: myShift.start, end: myShift.end };
    }
  }

  res.json({
    date: target, today: realToday, prevDate, nextDate,
    isToday, isDefaultRollover,
    currentTime, myName, myStatus,
    inNow, inSoon, leavingInHour,
    teamShifts, myShift,
  });
});

router.get('/working-with/compare-sources', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const colleagues = db.prepare('SELECT id, name FROM colleagues ORDER BY sort_order ASC, name ASC').all();

  const shifts = db.prepare(
    'SELECT cs.*, c.name as colleague_name FROM colleague_shifts cs JOIN colleagues c ON c.id = cs.colleague_id WHERE cs.date >= ? AND cs.date <= ? ORDER BY cs.date, c.name'
  ).all(from, to);

  const sources = [...new Set(shifts.map(s => s.import_source || 'manual'))].sort();

  const map = {};
  for (const s of shifts) {
    const key = `${s.colleague_id}__${s.date}`;
    if (!map[key]) map[key] = { colleague_id: s.colleague_id, name: s.colleague_name, date: s.date, bySource: {} };
    const src = s.import_source || 'manual';
    if (!map[key].bySource[src]) map[key].bySource[src] = [];
    map[key].bySource[src].push({ start_time: s.start_time, end_time: s.end_time, shift_type: s.shift_type, id: s.id });
  }

  const rows = Object.values(map).map(row => {
    const entries = Object.values(row.bySource);
    const allSame = entries.every(arr =>
      arr[0].start_time === entries[0][0].start_time &&
      arr[0].end_time   === entries[0][0].end_time &&
      arr[0].shift_type === entries[0][0].shift_type
    );
    return { ...row, disagrees: !allSame && entries.length > 1 };
  });

  res.json({ sources, rows, from, to });
});

// ─────────────────────────────────────────
// Photo Library - filesystem storage
// Photos saved under DATA_DIR/photo-library/<folder-id>/<filename> — uses the
// same DATA_DIR convention as db.js rather than a hardcoded /app/data path, so
// this still works if DATA_DIR is ever pointed elsewhere.

const fs          = require('fs');
const fsPath      = require('path');
const PHOTO_DATA_DIR = process.env.DATA_DIR || fsPath.join(__dirname, 'data');
const PHOTO_BASE  = fsPath.join(PHOTO_DATA_DIR, 'photo-library');

// Ensure base directory exists
if (!fs.existsSync(PHOTO_BASE)) fs.mkdirSync(PHOTO_BASE, { recursive: true });

// Multer: memory storage for photos (we write to disk manually)
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// GET /photo-library/folders — includes file_count per folder
router.get('/photo-library/folders', (req, res) => {
  try {
    const folders = db.prepare(`
      SELECT f.id, f.name, f.created_at,
             COUNT(pf.id) AS file_count
      FROM photo_folders f
      LEFT JOIN photo_files pf ON pf.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.name ASC
    `).all();
    res.json({ folders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /photo-library/folders
router.post('/photo-library/folders', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO photo_folders (name) VALUES (?)').run(name.trim());
    const id = info.lastInsertRowid;
    const dir = fsPath.join(PHOTO_BASE, String(id));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    res.json({ id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /photo-library/folders/:id — rename
router.patch('/photo-library/folders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    db.prepare('UPDATE photo_folders SET name=? WHERE id=?').run(name.trim(), id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /photo-library/folders/:id
router.delete('/photo-library/folders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    db.prepare('DELETE FROM photo_folders WHERE id=?').run(id);
    const dir = fsPath.join(PHOTO_BASE, String(id));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /photo-library/folders/:id/files
router.get('/photo-library/folders/:id/files', (req, res) => {
  const folderId = parseInt(req.params.id, 10);
  try {
    const files = db.prepare(
      'SELECT id, filename, mime_type, uploaded_at FROM photo_files WHERE folder_id=? ORDER BY uploaded_at DESC'
    ).all(folderId);
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /photo-library/folders/:id/files — multi-file upload (field: "photos")
router.post('/photo-library/folders/:id/files', photoUpload.array('photos', 50), (req, res) => {
  const folderId = parseInt(req.params.id, 10);
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
  try {
    const dir = fsPath.join(PHOTO_BASE, String(folderId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const insert = db.prepare(
      'INSERT INTO photo_files (folder_id, filename, mime_type, file_path) VALUES (?,?,?,?)'
    );
    db.transaction(() => {
      for (const f of files) {
        const safeName = Date.now() + '_' + f.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const filePath = fsPath.join(dir, safeName);
        fs.writeFileSync(filePath, f.buffer);
        insert.run(folderId, f.originalname, f.mimetype, filePath);
      }
    })();
    res.json({ inserted: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /photo-library/files/:id/image — serve the image file
router.get('/photo-library/files/:id/image', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const f = db.prepare('SELECT * FROM photo_files WHERE id=?').get(id);
    if (!f || !f.file_path || !fs.existsSync(f.file_path))
      return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', f.mime_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
    fs.createReadStream(f.file_path).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /photo-library/files/:id
router.delete('/photo-library/files/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const f = db.prepare('SELECT file_path FROM photo_files WHERE id=?').get(id);
    if (f && f.file_path && fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
    db.prepare('DELETE FROM photo_files WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /photo-library/queue-job -- queue selected photos for OCR processing
router.post('/photo-library/queue-job', (req, res) => {
  const { fileIds, source } = req.body;
  if (!Array.isArray(fileIds) || !fileIds.length) return res.status(400).json({ error: 'fileIds required' });
  try {
    // One batched query instead of one prepare+get per file id, then restore the
    // caller's original ordering (IN (...) doesn't guarantee row order).
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM photo_files WHERE id IN (${placeholders})`).all(...fileIds);
    const byId = new Map(rows.map(r => [r.id, r]));
    const photoFiles = fileIds.map(id => byId.get(id)).filter(Boolean);
    if (!photoFiles.length) return res.status(404).json({ error: 'No matching files' });
    const jobId = db.prepare(
      "INSERT INTO ocr_jobs (source, status, total, date_override) VALUES (?, 'queued', ?, NULL)"
    ).run(source || 'server', photoFiles.length).lastInsertRowid;
    const insertFile = db.prepare(
      'INSERT INTO ocr_job_files (job_id, filename, mime_type, image_blob) VALUES (?,?,?,?)'
    );
    db.transaction(() => {
      for (const pf of photoFiles) {
        let blob = null;
        try { blob = fs.readFileSync(pf.file_path); } catch(_) {}
        if (blob) insertFile.run(jobId, pf.filename, pf.mime_type, blob);
      }
    })();
    setImmediate(runJobWorker);
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.callGeminiVision = callGeminiVision;
