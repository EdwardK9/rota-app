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

// Merge one colleague into another: every colleague_shifts row belonging to src is
// re-pointed at dst (dropping any that would collide with a shift dst already has on
// the same date+start_time, since that's the table's unique key), then src itself is
// deleted. Used by Manage People's "Merge" action for accidental duplicate colleagues.
router.post('/colleagues/:srcId/merge-into/:dstId', (req, res) => {
  const srcId = parseInt(req.params.srcId, 10);
  const dstId = parseInt(req.params.dstId, 10);
  if (!srcId || !dstId || srcId === dstId) return res.status(400).json({ error: 'Invalid colleague ids' });

  const src = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(srcId);
  const dst = db.prepare('SELECT * FROM colleagues WHERE id = ?').get(dstId);
  if (!src || !dst) return res.status(404).json({ error: 'Colleague not found' });

  try {
    let moved = 0, dropped = 0;
    const doMerge = db.transaction(() => {
      const srcShifts = db.prepare('SELECT * FROM colleague_shifts WHERE colleague_id = ?').all(srcId);
      const checkCollision = db.prepare(
        'SELECT id FROM colleague_shifts WHERE colleague_id = ? AND date = ? AND start_time = ?'
      );
      const moveShift = db.prepare('UPDATE colleague_shifts SET colleague_id = ? WHERE id = ?');
      const dropShift = db.prepare('DELETE FROM colleague_shifts WHERE id = ?');

      for (const s of srcShifts) {
        const collision = checkCollision.get(dstId, s.date, s.start_time);
        if (collision) { dropShift.run(s.id); dropped++; }
        else { moveShift.run(dstId, s.id); moved++; }
      }
      db.prepare('DELETE FROM colleagues WHERE id = ?').run(srcId);
    });
    doMerge();
    res.json({ moved, dropped, from: src.name, into: dst.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// Import-batch tracking & conflict detection
// ─────────────────────────────────────────

// Import-batch tracking — every colleague-shift import call opens a batch, tags each
// row it inserts with the batch id, then records the final inserted count. Lets the
// whole import be undone as one action (deletes only rows still in that batch — if a
// row was later hand-edited or duplicated by another import, it won't have this id
// any more so undo only ever removes what that specific run actually added).
function createImportBatch(source, note) {
  const info = db.prepare('INSERT INTO import_batches (source, note) VALUES (?, ?)').run(source, note || null);
  return info.lastInsertRowid;
}
function finalizeImportBatch(batchId, insertedCount) {
  db.prepare('UPDATE import_batches SET inserted_count = ? WHERE id = ?').run(insertedCount, batchId);
}

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
// Gemini AI Screenshot import
// ─────────────────────────────────────────

// "Overloaded" is Google's own wording for a model at capacity — worth retrying with
// a different model, unlike a bad request or auth error which would just fail again.
function isGeminiOverloadError(status, message) {
  return status === 503 || /overloaded|high demand|unavailable|try again later/i.test(message || '');
}

// Same live-model fetch as GET /colleagues/gemini-models, reused here so the fallback
// list never goes stale the way a hardcoded one would (see the gemini-2.5-flash
// retirement this was already bitten by once).
async function fetchAvailableGeminiModels(apiKey) {
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) { return []; }
  if (!r.ok) return [];
  const data = await r.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .filter(name => !/embedding|aqa/i.test(name));
}

// Rough capability ranking so fallback tries the next-BEST available model rather
// than whatever happens to sort first alphabetically — newer/higher-tier models tend
// to read cluttered screenshots more reliably than "lite"/8b-class ones.
function rankGeminiModel(name) {
  let score = 0;
  const ver = name.match(/(\d+)\.(\d+)/);
  if (ver) score += parseFloat(`${ver[1]}.${ver[2]}`) * 100;
  if (/\bpro\b/i.test(name)) score += 50;
  if (/\bflash\b/i.test(name)) score += 20;
  if (/flash-lite|flash-8b/i.test(name)) score -= 60;
  if (/preview|exp/i.test(name)) score -= 10;
  return score;
}

async function callGeminiOnce(imageB64, mimeType, prompt, apiKey, model) {
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
    const message  = errBody?.error?.message || `Gemini API error ${geminiRes.status}`;
    const err = new Error(message);
    err.status = geminiRes.status;
    err.overloaded = isGeminiOverloadError(geminiRes.status, message);
    throw err;
  }

  const geminiData = await geminiRes.json();
  const rawText    = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Strip markdown code fences if Gemini wrapped the JSON
  const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed = null;
  try { parsed = JSON.parse(jsonStr); } catch (_) { /* leave parsed null — caller handles */ }
  return { parsed, rawText, modelUsed: model };
}

// Shared by any route that needs an image read by Gemini (team-schedule screenshots
// here, and the payslip-photo import in server.js). Tries the configured model first;
// if that specific model is overloaded, automatically retries with the best-ranked
// other available vision models (up to 3) before giving up. Throws (with .status) for
// a missing key or a hard non-overload error; returns parsed:null (with rawText) if
// Gemini's response wasn't valid JSON, so callers can decide how to surface that softly.
async function callGeminiVision(imageBuffer, mimeType, prompt = OLLAMA_PROMPT) {
  const keyRow   = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_model'").get();
  const apiKey   = keyRow   && keyRow.value   && keyRow.value.trim();
  const primaryModel = (modelRow && modelRow.value && modelRow.value.trim()) || 'gemini-2.0-flash';
  if (!apiKey) {
    const err = new Error('No Gemini API key configured. Add one in Settings → AI Screenshot Import.');
    err.status = 400;
    throw err;
  }

  const imageB64 = imageBuffer.toString('base64');

  let lastErr;
  try {
    return await callGeminiOnce(imageB64, mimeType, prompt, apiKey, primaryModel);
  } catch (err) {
    if (!err.overloaded) throw err;
    lastErr = err;
  }

  let fallbacks = [];
  try {
    const available = await fetchAvailableGeminiModels(apiKey);
    fallbacks = available
      .filter(m => m !== primaryModel)
      .sort((a, b) => rankGeminiModel(b) - rankGeminiModel(a))
      .slice(0, 3);
  } catch (_) { /* no model list available — fall through with nothing to try */ }

  for (const model of fallbacks) {
    try {
      return await callGeminiOnce(imageB64, mimeType, prompt, apiKey, model);
    } catch (err) {
      lastErr = err;
      if (!err.overloaded) throw err;
    }
  }

  lastErr.message = fallbacks.length
    ? `${primaryModel} and ${fallbacks.length} fallback model(s) are all overloaded right now — try again shortly. (${lastErr.message})`
    : lastErr.message;
  throw lastErr;
}

// A stuck/slow model is functionally the same problem as an overloaded one
// from the caller's point of view — either way, waiting on it isn't worth it
// when there are other models to try. 15s is generous even allowing for a
// "thinking" model's reasoning tokens ahead of the visible reply; a healthy
// model answers well within that, so this only ever bites when something's
// genuinely wrong with that specific model right now.
const GEMINI_TEXT_TIMEOUT_MS = 15000;

async function callGeminiOnceText(prompt, apiKey, model) {
  // 2.5-series models think by default, spending part of the same maxOutputTokens
  // budget on an internal reasoning pass before writing anything visible — with a
  // tight budget that reasoning can run out of room and get cut off mid-thought,
  // which is what leaked into the fact text once ("Let's use `total_commute_miles`
  // ... or `total_"). Explicitly turning thinking off routes the whole budget to
  // the actual answer instead. Non-thinking models (2.0 and earlier) ignore the
  // field harmlessly.
  const isThinkingModel = /(\d+)\.(\d+)/.test(model) && parseFloat(model.match(/(\d+)\.(\d+)/).slice(1).join('.')) >= 2.5;
  const generationConfig = { temperature: 0.9, maxOutputTokens: 800 };
  if (isThinkingModel) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // maxOutputTokens has to cover more than just the visible reply: several
          // current Gemini models spend "thinking" tokens out of the same budget
          // before writing anything visible, so a tight budget here doesn't shorten
          // the fact — it just eats the whole allowance on reasoning and cuts the
          // response off after a few words (seen in practice: "You've spent" and
          // nothing else). 150 was sized for the reply alone; this leaves headroom
          // for thinking too. The prompt's own "under 220 characters" instruction
          // is still what actually keeps the fact short.
          generationConfig,
        }),
        signal: AbortSignal.timeout(GEMINI_TEXT_TIMEOUT_MS),
      }
    );
  } catch (fetchErr) {
    const err = new Error(
      fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError'
        ? `${model} didn't respond within ${GEMINI_TEXT_TIMEOUT_MS / 1000}s`
        : fetchErr.message
    );
    err.status = 504;
    err.overloaded = true; // treat "unresponsive" the same as "busy" — try the next model
    throw err;
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.json().catch(() => ({}));
    const message  = errBody?.error?.message || `Gemini API error ${geminiRes.status}`;
    const err = new Error(message);
    err.status = geminiRes.status;
    err.overloaded = isGeminiOverloadError(geminiRes.status, message);
    throw err;
  }

  const geminiData = await geminiRes.json();
  const text = (geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  if (!text) {
    const err = new Error('Gemini returned an empty response.');
    err.status = 502;
    throw err;
  }
  // A truncated reasoning trace ("Let's use `total_commute_miles` ... or `total_")
  // rather than a finished fact — happens when the model runs out of budget
  // mid-thought. Treat it the same as an overloaded model so the caller retries
  // with a fallback rather than showing the raw reasoning fragment to the user.
  if (geminiData?.candidates?.[0]?.finishReason === 'MAX_TOKENS' && /[`*]|^\s*Let'?s\b/i.test(text)) {
    const err = new Error(`${model} cut off mid-thought before writing the fact.`);
    err.status = 502;
    err.overloaded = true;
    throw err;
  }
  return { text, modelUsed: model };
}

// Text-only counterpart to callGeminiVision, same overload/fallback-model
// retry chain (see the comment on that function) minus the image part — used
// by the Did You Know AI fact button. Was previously a single-attempt call
// with no retry at all, which meant any transient "model overloaded" response
// (common on the free-tier flash models at busy times) surfaced straight to
// the user instead of quietly trying the next-best model like screenshot
// import already does.
async function callGeminiText(prompt) {
  const keyRow   = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_model'").get();
  const apiKey   = keyRow   && keyRow.value   && keyRow.value.trim();
  const primaryModel = (modelRow && modelRow.value && modelRow.value.trim()) || 'gemini-2.0-flash';
  if (!apiKey) {
    const err = new Error('No Gemini API key configured. Add one in Settings → AI Screenshot Import.');
    err.status = 400;
    throw err;
  }

  let lastErr;
  try {
    const { text } = await callGeminiOnceText(prompt, apiKey, primaryModel);
    return text;
  } catch (err) {
    if (!err.overloaded) throw err;
    lastErr = err;
  }

  let fallbacks = [];
  try {
    const available = await fetchAvailableGeminiModels(apiKey);
    fallbacks = available
      .filter(m => m !== primaryModel)
      .sort((a, b) => rankGeminiModel(b) - rankGeminiModel(a))
      .slice(0, 3);
  } catch (_) { /* no model list available — fall through with nothing to try */ }

  for (const model of fallbacks) {
    try {
      const { text } = await callGeminiOnceText(prompt, apiKey, model);
      return text;
    } catch (err) {
      lastErr = err;
      if (!err.overloaded) throw err;
    }
  }

  lastErr.message = fallbacks.length
    ? `${primaryModel} and ${fallbacks.length} fallback model(s) are all overloaded right now — try again shortly. (${lastErr.message})`
    : lastErr.message;
  throw lastErr;
}

// Read a screenshot with Gemini and return the raw { date_range, schedule } JSON —
// no DB writes. Lets the Team Upload UI run an AI-read screenshot through the exact
// same preview/conflict-resolution flow as a manually pasted JSON.
router.post('/colleagues/gemini-extract', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { parsed, rawText, modelUsed } = await callGeminiVision(req.file.buffer, req.file.mimetype || 'image/png');
    if (!parsed) {
      return res.status(502).json({ error: 'Gemini returned unexpected output — could not parse JSON', rawText: rawText.slice(0, 3000) });
    }

    // Best-effort: keep a copy of the screenshot in the Photo Library, named with the
    // week it covers so past rotas stay browsable/downloadable. Never let a save
    // failure break the actual import.
    let savedAs = null;
    try {
      const folderId = getOrCreatePhotoFolder('Team Rota Screenshots');
      const range = weekRangeForFilename(parsed.date_range);
      const baseName = range ? range.label : req.file.originalname.replace(/\.[^.]+$/, '');
      savePhotoToFolder(folderId, req.file.buffer, req.file.mimetype || 'image/jpeg', baseName, range?.weekStart);
      savedAs = range ? range.label : baseName;
    } catch (saveErr) {
      console.error('Photo Library auto-save failed (non-fatal):', saveErr.message);
    }

    res.json({ data: parsed, model_used: modelUsed, saved_as: savedAs });
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
    const { parsed, rawText, modelUsed } = await callGeminiVision(req.file.buffer, req.file.mimetype || 'image/png');
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
    const batchId = createImportBatch('gemini', `Gemini screenshot — ${toInsert.length} shift(s)`);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, store, import_batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const doInsert = db.transaction(() => {
      for (const s of toInsert) {
        insert.run(s.colleague_id, s.date, s.start_time, s.end_time, s.shift_type, s.store || null, batchId);
        inserted++;
      }
    });
    doInsert();
    finalizeImportBatch(batchId, inserted);

    res.json({ inserted, skipped: duplicates.length, conflicts, total: shifts.length, shifts: toInsert, rawJson: JSON.stringify(normParsed).slice(0, 3000), batchId, model_used: modelUsed });
  } catch(err) {
    console.error('Gemini import error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Gemini import failed: ' + err.message) });
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
      // Best-ranked first (same ranking used for automatic overload fallback) so the
      // most capable option is the obvious default rather than whatever sorts first
      // alphabetically.
      .sort((a, b) => rankGeminiModel(b) - rankGeminiModel(a));
    res.json({ models, recommended: models[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Bulk-correct a start and/or end time across many shifts at once — e.g. a
// screenshot that consistently misread "06:45" as "05:45" for a whole batch
// of people. Only touches shift_type='shift' rows among the given ids (leave
// and all_day have no meaningful time to correct); anything else is silently
// left alone rather than erroring, since a mixed selection is easy to make
// from a search results list.
router.post('/colleague-shifts/bulk-set-time', (req, res) => {
  const { ids, start_time, end_time } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (start_time !== undefined && start_time !== null && start_time !== '' && !timePattern.test(start_time)) {
    return res.status(400).json({ error: 'start_time must be HH:MM' });
  }
  if (end_time !== undefined && end_time !== null && end_time !== '' && !timePattern.test(end_time)) {
    return res.status(400).json({ error: 'end_time must be HH:MM' });
  }
  const newStart = start_time || null;
  const newEnd = end_time || null;
  if (!newStart && !newEnd) return res.status(400).json({ error: 'start_time and/or end_time required' });

  // One UPDATE covering every id would abort entirely the moment any single
  // row collides with the (colleague_id, date, start_time) unique index —
  // e.g. that colleague already has another shift the same day at the new
  // time — which is exactly the kind of pre-existing data mess this bulk
  // action tends to get used to clean up. Applying row by row inside a
  // transaction means one collision only skips that row; everything else
  // still goes through, and the skipped ones are reported back by name.
  const sets = [];
  if (newStart) sets.push('start_time = ?');
  if (newEnd)   sets.push('end_time = ?');
  const updateStmt = db.prepare(
    `UPDATE colleague_shifts SET ${sets.join(', ')} WHERE id = ? AND shift_type = 'shift'`
  );
  const lookupStmt = db.prepare(
    `SELECT cs.date, c.name FROM colleague_shifts cs JOIN colleagues c ON c.id = cs.colleague_id WHERE cs.id = ?`
  );

  let updated = 0;
  const conflicts = [];
  db.transaction(() => {
    for (const id of ids) {
      const params = [];
      if (newStart) params.push(newStart);
      if (newEnd)   params.push(newEnd);
      params.push(id);
      try {
        const info = updateStmt.run(...params);
        if (info.changes > 0) updated++;
      } catch (e) {
        const row = lookupStmt.get(id);
        conflicts.push(row ? `${row.name} on ${row.date}` : `shift ${id}`);
      }
    }
  })();

  res.json({ updated, conflicts });
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

// ─────────────────────────────────────────
// Import batches — list recent team-shift imports and undo one as a unit
// ─────────────────────────────────────────

router.get('/colleagues/import-batches', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const batches = db.prepare(`
    SELECT id, source, note, inserted_count, undone_at, created_at,
      (SELECT COUNT(*) FROM colleague_shifts WHERE import_batch_id = import_batches.id) AS remaining_count
    FROM import_batches
    WHERE inserted_count > 0
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  res.json({ batches });
});

router.delete('/colleagues/import-batches/:id', (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!batchId) return res.status(400).json({ error: 'Invalid batch id' });
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });
  if (batch.undone_at) return res.status(409).json({ error: 'This import was already undone' });

  const undo = db.transaction(() => {
    const info = db.prepare('DELETE FROM colleague_shifts WHERE import_batch_id = ?').run(batchId);
    db.prepare("UPDATE import_batches SET undone_at = datetime('now') WHERE id = ?").run(batchId);
    return info.changes;
  });
  const deleted = undo();
  res.json({ deleted, batchId });
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

  // Overrides: decisions made on a previous conflict-resolution pass, keyed by the
  // INCOMING shift's colleague+date+start_time. action='replace' deletes one specific
  // existing row (replace_id) before inserting the incoming shift; action='add' just
  // inserts the incoming shift alongside whatever's already there (e.g. a genuine
  // split shift) without touching existing rows.
  const overrideMap = new Map(
    (overrides || []).map(o => [`${o.colleague_id}|${o.date}|${o.start_time}`, o])
  );

  const insertShift = db.prepare(`
    INSERT OR IGNORE INTO colleague_shifts
      (colleague_id, date, start_time, end_time, shift_type, import_source, store, import_batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteShiftById = db.prepare('DELETE FROM colleague_shifts WHERE id = ?');
  const existingForDayStmt = db.prepare(
    'SELECT id, start_time, end_time, shift_type, store FROM colleague_shifts WHERE colleague_id=? AND date=?'
  );

  const batchId = createImportBatch('json', schedule_data.date_range || 'Team schedule JSON import');
  let inserted = 0, updated = 0, skipped = 0, reconciled = 0;
  const unknownNames = new Set();
  const warnings = [];
  const conflicts = []; // shifts that exist in DB with different data

  // The screenshot is treated as the authoritative picture for the home-store
  // days it actually covers: a colleague who was in a *previous* import for one
  // of those days but is completely absent from this one is stale data, not a
  // day off that just needs recording — see the reconciliation pass below.
  const incomingHomePresence = new Set(); // `${colleague_id}|${date}`
  const resolvedDates = new Set();

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
      resolvedDates.add(dayDate);

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

        // Mentioned in the screenshot at the home store, regardless of what
        // happens with the actual insert below (matched, conflicting, whatever)
        // — that's enough to protect this colleague/date from reconciliation.
        if (!store) incomingHomePresence.add(`${col.id}|${dayDate}`);

        const overrideKey = `${col.id}|${dayDate}|${start_time}`;
        const override    = overrideMap.get(overrideKey);

        // Only compare against existing rows in the *same* store context — a
        // home-store shift and a different-store shift on the same day for the
        // same colleague are legitimately both real (that's what "store" is
        // for), not a duplicate or a conflict to resolve.
        const existingForDay = existingForDayStmt.all(col.id, dayDate)
          .filter(e => (e.store || null) === store);
        const exactMatch = existingForDay.find(e =>
          e.start_time === start_time && e.end_time === end_time && e.shift_type === shift_type
        );

        if (exactMatch) {
          skipped++; // true duplicate — identical data, nothing to do
        } else if (!existingForDay.length || (override && override.action === 'add')) {
          // No existing shift that day at all, or the user explicitly chose to keep
          // both (e.g. a genuine split shift) — just insert.
          const r = insertShift.run(col.id, dayDate, start_time, end_time, shift_type, 'json', store, batchId);
          if (r.changes > 0) inserted++; else skipped++;
        } else if (override && override.action === 'replace') {
          // User chose to overwrite one specific existing shift with the incoming one
          if (override.replace_id) deleteShiftById.run(override.replace_id);
          const r = insertShift.run(col.id, dayDate, start_time, end_time, shift_type, 'json', store, batchId);
          if (r.changes > 0) { inserted++; updated++; } else skipped++;
        } else {
          // Colleague already has at least one different shift that day and no
          // decision has been made yet — mirror detectConflicts()'s vague-vs-real
          // handling, then flag a real conflict for the user to resolve.
          const incomingIsVague     = shift_type === 'all_day' || shift_type === 'leave';
          const existingHasRealShift = existingForDay.some(e => e.shift_type === 'shift' && e.start_time !== '00:00');
          const existingIsAllVague   = existingForDay.every(e => e.shift_type === 'all_day' || e.shift_type === 'leave');
          if (incomingIsVague && (existingHasRealShift || existingIsAllVague)) {
            skipped++; // date mis-attribution, or already covered by leave/all_day — not worth a prompt
          } else {
            conflicts.push({
              colleague_id: col.id,
              name:         col.name,
              date:         dayDate,
              incoming: { start_time, end_time, shift_type },
              existing: existingForDay.map(e => ({ id: e.id, start_time: e.start_time, end_time: e.end_time, shift_type: e.shift_type })),
            });
            skipped++;
          }
        }
      }
    }

    // Reconciliation: for every home-store day this screenshot actually covers,
    // any *previously imported* home-store row for a colleague who doesn't
    // appear in this screenshot at all on that day is stale — delete it. Scoped
    // to import_batch_id IS NOT NULL so hand-entered/manually-corrected shifts
    // (added via the Team Calendar "Add Shift" modal) are never touched, and to
    // home-store rows only, since this screenshot has no authority over what a
    // colleague is doing at a different store.
    const staleHomeRowsStmt = db.prepare(
      `SELECT id, colleague_id FROM colleague_shifts
       WHERE date = ? AND (store IS NULL OR store = '') AND import_batch_id IS NOT NULL`
    );
    for (const d of weekDates) {
      if (!resolvedDates.has(d)) continue;
      for (const row of staleHomeRowsStmt.all(d)) {
        if (!incomingHomePresence.has(`${row.colleague_id}|${d}`)) {
          deleteShiftById.run(row.id);
          reconciled++;
        }
      }
    }
  })();

  finalizeImportBatch(batchId, inserted);
  res.json({ inserted, updated, skipped, reconciled, conflicts, warnings, unknownNames: [...unknownNames], batchId });
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
    'INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, import_batch_id) VALUES (?,?,?,?,?,?)'
  );
  // Note: with overwrite=true this REPLACEs any existing row at the same key, so an
  // undo of this batch would remove the replacement rather than restore what was
  // there before — acceptable here since this route isn't used by any current UI.
  const replaceShift = db.prepare(
    'INSERT OR REPLACE INTO colleague_shifts (colleague_id, date, start_time, end_time, shift_type, import_batch_id) VALUES (?,?,?,?,?,?)'
  );

  const batchId = createImportBatch('bulk-api', `Bulk API import — ${shifts.length} row(s)`);
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
      const info = stmt.run(col.id, date, startTime, endTime, shiftType, batchId);
      if (info.changes > 0) imported++;
      else skipped++;
    }
  })();

  finalizeImportBatch(batchId, imported);
  res.json({ imported, skipped, errors, unknownNames, batchId });
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
       WHERE cs.date = ? AND cs.shift_type = 'shift' AND (cs.store IS NULL OR cs.store = '')
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

// GET /photo-library/folders/:id/files — weeks with a detected date sort chronologically
// (newest week first) since a DD.MM.YYYY filename doesn't sort correctly as text;
// anything without a detected week falls to the bottom, sorted by upload time.
router.get('/photo-library/folders/:id/files', (req, res) => {
  const folderId = parseInt(req.params.id, 10);
  try {
    const files = db.prepare(`
      SELECT id, filename, mime_type, uploaded_at, week_start_date FROM photo_files
      WHERE folder_id=?
      ORDER BY (week_start_date IS NULL) ASC, week_start_date DESC, uploaded_at DESC
    `).all(folderId);
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Turn a Gemini date_range string ("Aug 17 - Aug 23, 2026") into a Monday date + a
// DD.MM.YYYY - DD.MM.YYYY display name, or null if it can't be parsed.
function weekRangeForFilename(dateRange) {
  const weekDates = resolveWeekDates(dateRange);
  if (!weekDates) return null;
  const toDDMMYYYY = iso => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  return { weekStart: weekDates[0], label: `${toDDMMYYYY(weekDates[0])} - ${toDDMMYYYY(weekDates[6])}` };
}

function getOrCreatePhotoFolder(name) {
  const existing = db.prepare('SELECT id FROM photo_folders WHERE name = ?').get(name);
  if (existing) return existing.id;
  const id = db.prepare('INSERT INTO photo_folders (name) VALUES (?)').run(name).lastInsertRowid;
  const dir = fsPath.join(PHOTO_BASE, String(id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return id;
}

// Saves a buffer into a folder with the given base name (no extension), disambiguating
// with " (2)", " (3)"... if that name is already taken in the folder. Returns the file id.
function savePhotoToFolder(folderId, buffer, mimeType, baseName, weekStart) {
  const dir = fsPath.join(PHOTO_BASE, String(folderId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const existingNames = new Set(
    db.prepare('SELECT filename FROM photo_files WHERE folder_id = ?').all(folderId).map(r => r.filename)
  );
  let filename = baseName + ext;
  let n = 2;
  while (existingNames.has(filename)) { filename = `${baseName} (${n})${ext}`; n++; }
  const diskName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
  const filePath = fsPath.join(dir, diskName);
  fs.writeFileSync(filePath, buffer);
  const info = db.prepare(
    'INSERT INTO photo_files (folder_id, filename, mime_type, file_path, week_start_date) VALUES (?,?,?,?,?)'
  ).run(folderId, filename, mimeType, filePath, weekStart || null);
  return info.lastInsertRowid;
}

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
    const fileIds = [];
    db.transaction(() => {
      for (const f of files) {
        const safeName = Date.now() + '_' + f.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const filePath = fsPath.join(dir, safeName);
        fs.writeFileSync(filePath, f.buffer);
        const info = insert.run(folderId, f.originalname, f.mimetype, filePath);
        fileIds.push(info.lastInsertRowid);
      }
    })();
    res.json({ inserted: files.length, fileIds });
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

// POST /photo-library/files/:id/ai-rename — read the week range off an already-
// uploaded screenshot with Gemini and rename it accordingly. Only touches the
// display filename + week_start_date (sort key) — the file on disk is untouched.
router.post('/photo-library/files/:id/ai-rename', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const f = db.prepare('SELECT * FROM photo_files WHERE id=?').get(id);
    if (!f || !f.file_path || !fs.existsSync(f.file_path)) return res.status(404).json({ error: 'Not found' });

    const buffer = fs.readFileSync(f.file_path);
    const { parsed } = await callGeminiVision(buffer, f.mime_type || 'image/jpeg');
    const range = parsed ? weekRangeForFilename(parsed.date_range) : null;
    if (!range) return res.status(422).json({ error: 'Could not read a week range from this image' });

    const ext = fsPath.extname(f.filename) || '.jpg';
    const existingNames = new Set(
      db.prepare('SELECT filename FROM photo_files WHERE folder_id = ? AND id != ?').all(f.folder_id, id).map(r => r.filename)
    );
    let filename = range.label + ext;
    let n = 2;
    while (existingNames.has(filename)) { filename = `${range.label} (${n})${ext}`; n++; }

    db.prepare('UPDATE photo_files SET filename=?, week_start_date=? WHERE id=?').run(filename, range.weekStart, id);
    res.json({ id, filename, week_start_date: range.weekStart });
  } catch (err) {
    console.error('Photo AI-rename error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
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

module.exports = router;
// callGeminiText is shared with v3/didYouKnow.js. The vision counterpart isn't
// exported: its only outside caller was the payslip photo import, removed in
// v4.12.0, and everything that still reads an image with it lives in this file.
module.exports.callGeminiText = callGeminiText;
