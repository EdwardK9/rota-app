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
const {
  resolveWeekDates, resolveWeekForSchedule, resolveWeekDatesLoose, resolveDayDate, parseTimeRange,
  fuzzyMatch, nameMatchesStrict, extractJson, coerceSchedule,
} = require('./teamImportParse');
const { db, effectiveHourlyRate, rolePayForDate, contractHoursForColleagueOnDate, autoBreakMinutes, ROLES, ROLE_LABELS, ROLE_DEFAULT_PAY_TYPE } = require('./db');
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

// Name matching, week/day/time parsing and model-reply parsing live in
// teamImportParse.js (pure, unit-tested).

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
    role: c.job_tier || 'assistant',
    role_label: ROLE_LABELS[c.job_tier] || ROLE_LABELS.assistant,
    pay_override: !!c.pay_override,
    // Where the rate came from, so the UI can say "£13.48 · from Store
    // Assistant" rather than leaving you to guess why editing this person's
    // own figure changed nothing.
    pay_source: c.pay_override ? 'personal' : 'role',
    effective_hourly_rate: effectiveHourlyRate(c),
  };
}

// ─────────────────────────────────────────
// Role pay — the rate for a role, dated, so past shifts keep costing what they
// actually cost. Same shape as your own pay_rates: rows are effective FROM a
// date, and the newest one on or before a shift's date wins.
// ─────────────────────────────────────────

router.get('/role-pay', (req, res) => {
  const rows = db.prepare('SELECT * FROM role_pay ORDER BY role ASC, effective_date DESC').all();
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    roles: ROLES.map(r => ({
      role: r,
      label: ROLE_LABELS[r],
      default_pay_type: ROLE_DEFAULT_PAY_TYPE[r],
      current: rolePayForDate(r, today),
      people: db.prepare(
        "SELECT COUNT(*) AS c FROM colleagues WHERE job_tier = ? AND (left_date IS NULL OR left_date = '')"
      ).get(r).c,
    })),
    rates: rows,
  });
});

function validateRolePay(body) {
  const { role, effective_date, pay_type } = body;
  if (!ROLES.includes(role)) return 'role must be one of: ' + ROLES.join(', ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_date || '')) return 'effective_date must be YYYY-MM-DD';
  if (!['hourly', 'salaried'].includes(pay_type)) return "pay_type must be 'hourly' or 'salaried'";
  if (pay_type === 'hourly') {
    if (!(parseFloat(body.hourly_rate) > 0)) return 'hourly_rate must be greater than zero';
  } else {
    if (!(parseFloat(body.annual_salary) > 0)) return 'annual_salary must be greater than zero';
    if (!(parseFloat(body.nominal_weekly_hours) > 0)) return 'nominal_weekly_hours must be greater than zero';
  }
  return null;
}

router.post('/role-pay', (req, res) => {
  const err = validateRolePay(req.body);
  if (err) return res.status(400).json({ error: err });
  const { role, effective_date, pay_type, hourly_rate, annual_salary, nominal_weekly_hours, notes } = req.body;
  try {
    // Re-saving the same role and date replaces that row rather than failing on
    // the unique constraint — correcting a typo shouldn't need a delete first.
    const info = db.prepare(`
      INSERT INTO role_pay (role, effective_date, pay_type, hourly_rate, annual_salary, nominal_weekly_hours, notes)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(role, effective_date) DO UPDATE SET
        pay_type = excluded.pay_type,
        hourly_rate = excluded.hourly_rate,
        annual_salary = excluded.annual_salary,
        nominal_weekly_hours = excluded.nominal_weekly_hours,
        notes = excluded.notes
    `).run(
      role, effective_date, pay_type,
      pay_type === 'hourly'   ? parseFloat(hourly_rate)   : null,
      pay_type === 'salaried' ? parseFloat(annual_salary) : null,
      pay_type === 'salaried' ? parseFloat(nominal_weekly_hours) : null,
      notes || null
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/role-pay/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM role_pay WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Deleting the only rate a role has would silently drop everyone in it to no
  // pay at all, which reads as a bug rather than as a choice.
  const left = db.prepare('SELECT COUNT(*) AS c FROM role_pay WHERE role = ?').get(row.role).c;
  if (left <= 1) {
    return res.status(400).json({ error: `${ROLE_LABELS[row.role]} needs at least one rate — edit this one instead of deleting it` });
  }
  db.prepare('DELETE FROM role_pay WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// Colleague contract hours — dated the same way role pay is, so bumping
// someone's hours for the future doesn't quietly re-price past weeks'
// overtime/leave maths. colleagues.contract_hours is kept as a denormalized
// "today" cache, refreshed after every write here.
// ─────────────────────────────────────────

router.get('/colleagues/:id/contract-hours', (req, res) => {
  const colleague = db.prepare('SELECT id FROM colleagues WHERE id = ?').get(req.params.id);
  if (!colleague) return res.status(404).json({ error: 'Not found' });
  const history = db.prepare(
    'SELECT * FROM colleague_contract_hours WHERE colleague_id = ? ORDER BY effective_date DESC'
  ).all(req.params.id);
  res.json({ history, current: contractHoursForColleagueOnDate(req.params.id, localDateStr()) });
});

function validateContractHoursEntry(body) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effective_date || '')) return 'effective_date must be YYYY-MM-DD';
  if (!(parseFloat(body.contract_hours) >= 0)) return 'contract_hours must be zero or greater';
  return null;
}

router.post('/colleagues/:id/contract-hours', (req, res) => {
  const colleague = db.prepare('SELECT id FROM colleagues WHERE id = ?').get(req.params.id);
  if (!colleague) return res.status(404).json({ error: 'Not found' });
  const err = validateContractHoursEntry(req.body);
  if (err) return res.status(400).json({ error: err });
  const { effective_date, contract_hours, notes } = req.body;
  try {
    // Re-saving the same date replaces that row rather than failing on the
    // unique constraint — correcting a typo shouldn't need a delete first.
    db.prepare(`
      INSERT INTO colleague_contract_hours (colleague_id, effective_date, contract_hours, notes)
      VALUES (?,?,?,?)
      ON CONFLICT(colleague_id, effective_date) DO UPDATE SET
        contract_hours = excluded.contract_hours,
        notes = excluded.notes
    `).run(req.params.id, effective_date, parseFloat(contract_hours), notes || null);

    db.prepare('UPDATE colleagues SET contract_hours = ? WHERE id = ?')
      .run(contractHoursForColleagueOnDate(req.params.id, localDateStr()), req.params.id);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/colleagues/:id/contract-hours/:historyId', (req, res) => {
  const row = db.prepare('SELECT * FROM colleague_contract_hours WHERE id = ? AND colleague_id = ?')
    .get(req.params.historyId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Deleting the only entry a colleague has would silently drop them to 0
  // contracted hours, which reads as a bug rather than as a choice.
  const left = db.prepare('SELECT COUNT(*) AS c FROM colleague_contract_hours WHERE colleague_id = ?')
    .get(req.params.id).c;
  if (left <= 1) {
    return res.status(400).json({ error: 'This person needs at least one contract-hours entry — edit this one instead of deleting it' });
  }
  db.prepare('DELETE FROM colleague_contract_hours WHERE id = ?').run(req.params.historyId);
  db.prepare('UPDATE colleagues SET contract_hours = ? WHERE id = ?')
    .run(contractHoursForColleagueOnDate(req.params.id, localDateStr()), req.params.id);
  res.json({ ok: true });
});

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
    tags, synergy_rating, notes, job_tier, pay_override,
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
  // job_tier holds the role: bm | am | duty | assistant (see db.js ROLES).
  const resolvedJobTier = job_tier !== undefined ? job_tier : (existing.job_tier || 'assistant');
  if (resolvedJobTier && !ROLES.includes(resolvedJobTier)) {
    return res.status(400).json({ error: 'job_tier must be one of: ' + ROLES.join(', ') });
  }

  db.prepare(`
    UPDATE colleagues SET
      name = ?, birthday = ?, contract_hours = ?, sort_order = ?, left_date = ?, start_date = ?,
      pay_type = ?, hourly_rate = ?, annual_salary = ?, nominal_weekly_hours = ?,
      tags = ?, synergy_rating = ?, notes = ?, job_tier = ?, pay_override = ?
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
    pay_override !== undefined ? (pay_override ? 1 : 0) : (existing.pay_override ? 1 : 0),
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
// A retired/renamed model (404 "no longer available to new users", "not found for
// API version") is the same story: this model can't help, another one can — without
// this the whole import failed outright the day Google retired the configured model.
function isGeminiOverloadError(status, message) {
  return status === 503 || status === 404 ||
    /overloaded|high demand|unavailable|try again later|no longer available|is not found|deprecated/i.test(message || '');
}

// Gemini says this (400) when the chosen model is text-only — e.g. a Gemma or
// audio/TTS model picked from the list. It's a "wrong model", not a bad image,
// so the right response is to move on to a model that can see.
function isNoVisionError(message) {
  return /image input modality is not enabled|modality is not enabled|does not support image/i.test(message || '');
}

// Names that are never going to read a screenshot, so they're kept out of the
// model dropdown and the fallback list. Not exhaustive — the API doesn't say
// which models take images — which is what isNoVisionError above is for.
const NON_VISION_MODEL = /embedding|aqa|tts|native-audio|-live|imagen|veo|robotics|learnlm/i;

// Models that answered "I can't see images" this run — skipped straight away
// next time, rather than costing a failed call on every one of 300 photos.
const noVisionModels = new Set();

// Same live-model fetch as GET /colleagues/gemini-models, reused here so the fallback
// list never goes stale the way a hardcoded one would (see the gemini-2.5-flash
// retirement this was already bitten by once).
// Overridable only so the tests can stand in a fake Gemini (test/api.test.js).
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';

async function fetchAvailableGeminiModels(apiKey) {
  let r;
  try {
    r = await fetch(`${GEMINI_API_BASE}/v1beta/models?key=${apiKey}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (_) { return []; }
  if (!r.ok) return [];
  const data = await r.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .filter(name => !NON_VISION_MODEL.test(name) && !noVisionModels.has(name));
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

// Vision requests are naturally slower than the text-only path (image
// tokens), so this is more generous than GEMINI_TEXT_TIMEOUT_MS — but a call
// still needs SOME bound. Without one, a stuck request used to hang the
// caller indefinitely: fine-ish for an interactive upload where the user can
// just give up and retry, but the background screenshot queue awaits these
// sequentially, so one hung call could stall every screenshot behind it.
const GEMINI_VISION_TIMEOUT_MS = 45000;

async function callGeminiOnce(imageB64, mimeType, prompt, apiKey, model, jsonMode = true, timeoutMs = GEMINI_VISION_TIMEOUT_MS) {
  // JSON mode makes the model return bare JSON rather than prose around it —
  // the most common reason a screenshot came back "could not parse JSON". A
  // model that doesn't support it says so with a 400, and gets asked again
  // without it (below).
  const generationConfig = { temperature: 0 };
  if (jsonMode) generationConfig.responseMimeType = 'application/json';
  let geminiRes;
  try {
    geminiRes = await fetch(
      `${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageB64 } }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch (fetchErr) {
    const err = new Error(
      fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError'
        ? `${model} didn't respond within ${timeoutMs / 1000}s`
        : fetchErr.message
    );
    err.status = 504;
    err.overloaded = true; // treat "unresponsive" the same as "busy" — try the next model
    throw err;
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.json().catch(() => ({}));
    const message  = errBody?.error?.message || `Gemini API error ${geminiRes.status}`;
    if (jsonMode && geminiRes.status === 400 && /json|mime/i.test(message)) {
      return callGeminiOnce(imageB64, mimeType, prompt, apiKey, model, false, timeoutMs);
    }
    const err = new Error(message);
    err.status = geminiRes.status;
    err.overloaded = isGeminiOverloadError(geminiRes.status, message);
    err.noVision = isNoVisionError(message);
    throw err;
  }

  const geminiData = await geminiRes.json();
  // The reply can come back split over several parts (and thinking models can
  // include their reasoning as parts flagged `thought`) — join the real text.
  const parts   = geminiData?.candidates?.[0]?.content?.parts || [];
  const rawText = parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text).join('');

  // Tolerates ```json fences and any chatter around the JSON object.
  const parsed = extractJson(rawText);
  return { parsed, rawText, modelUsed: model };
}

// Shared by any route that needs an image read by Gemini (team-schedule screenshots
// here, and the payslip-photo import in server.js). Tries the configured model first;
// if that specific model is overloaded, automatically retries with the best-ranked
// other available vision models (up to 3) before giving up. Throws (with .status) for
// a missing key or a hard non-overload error; returns parsed:null (with rawText) if
// Gemini's response wasn't valid JSON, so callers can decide how to surface that softly.
// A model's own quota running out (429 / RESOURCE_EXHAUSTED) is worth trying
// another model for, same as "overloaded": on the free tier every model has a
// separate allowance, so flash-lite or 2.0-flash can still answer when the
// configured model is used up for the minute (or the day).
function isGeminiQuotaError(err) {
  return err?.status === 429 || /quota|resource[_ ]exhausted|rate.?limit|too many requests/i.test(err?.message || '');
}

async function callGeminiVision(imageBuffer, mimeType, prompt = OLLAMA_PROMPT, { timeoutMs = GEMINI_VISION_TIMEOUT_MS } = {}) {
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
  if (noVisionModels.has(primaryModel)) {
    lastErr = new Error(`${primaryModel} can't read images`);
    lastErr.status = 400;
    lastErr.noVision = true;
  } else {
    try {
      return await callGeminiOnce(imageB64, mimeType, prompt, apiKey, primaryModel, true, timeoutMs);
    } catch (err) {
      if (err.noVision) noVisionModels.add(primaryModel);
      if (!err.overloaded && !isGeminiQuotaError(err) && !err.noVision) throw err;
      lastErr = err;
    }
  }

  let fallbacks = [];
  try {
    const available = await fetchAvailableGeminiModels(apiKey);
    fallbacks = available
      .filter(m => m !== primaryModel && !noVisionModels.has(m))
      .sort((a, b) => rankGeminiModel(b) - rankGeminiModel(a))
      .slice(0, 3);
  } catch (_) { /* no model list available — fall through with nothing to try */ }

  for (const model of fallbacks) {
    try {
      return await callGeminiOnce(imageB64, mimeType, prompt, apiKey, model, true, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (err.noVision) noVisionModels.add(model);
      if (!err.overloaded && !isGeminiQuotaError(err) && !err.noVision) throw err;
    }
  }

  if (noVisionModels.has(primaryModel)) {
    // Nothing else could read the image either (or there was nothing to try).
    // Say what's actually wrong and where to fix it, not "all busy".
    const e = new Error(`${primaryModel} can't read images, and no other vision model was available. Pick a different model in Settings → AI Screenshot Import.`);
    e.status = 400;
    throw e;
  }
  lastErr.message = fallbacks.length
    ? `${primaryModel} and ${fallbacks.length} fallback model(s) are all busy or out of quota right now — try again shortly. (${lastErr.message})`
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
      `${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
// Text-path models that just said "out of quota", with when to try them again.
// The free tier gives every model its own daily allowance, so one being used up
// says nothing about the others — but it's also pointless to ask it again on the
// next fun fact when the reply said to come back in 15 hours.
const textQuotaUntil = new Map();   // model -> epoch ms

// "Please retry in 15h9m38.009s" / "retry in 38.5s" -> seconds (null if absent)
function retrySecsFromMessage(msg) {
  const m = String(msg || '').match(/retry in ((?:\d+(?:\.\d+)?\s*[hms]\s*)+)/i);
  if (!m) return null;
  let secs = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)) {
    secs += parseFloat(n) * { h: 3600, m: 60, s: 1 }[unit.toLowerCase()];
  }
  return secs || null;
}

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

  // "Try another model" applies to a model that's busy and to one that's out of
  // quota — either way a different model can usually still answer.
  const worthNextModel = err => err.overloaded || isGeminiQuotaError(err);
  const noteQuota = (model, err) => {
    if (!isGeminiQuotaError(err)) return;
    const secs = retrySecsFromMessage(err.message);
    // Cap at an hour so a model that comes back sooner than promised isn't
    // shut out for the rest of a day.
    textQuotaUntil.set(model, Date.now() + Math.min(secs ?? 60, 3600) * 1000);
  };
  const quotaBlocked = model => (textQuotaUntil.get(model) || 0) > Date.now();

  let lastErr;
  if (quotaBlocked(primaryModel)) {
    lastErr = new Error(`${primaryModel} is out of free quota for now`);
    lastErr.status = 429;
  } else {
    try {
      const { text } = await callGeminiOnceText(prompt, apiKey, primaryModel);
      return text;
    } catch (err) {
      noteQuota(primaryModel, err);
      if (!worthNextModel(err)) throw err;
      lastErr = err;
    }
  }

  let fallbacks = [];
  try {
    const available = await fetchAvailableGeminiModels(apiKey);
    fallbacks = available
      .filter(m => m !== primaryModel && !quotaBlocked(m))
      .sort((a, b) => rankGeminiModel(b) - rankGeminiModel(a))
      .slice(0, 3);
  } catch (_) { /* no model list available — fall through with nothing to try */ }

  for (const model of fallbacks) {
    try {
      const { text } = await callGeminiOnceText(prompt, apiKey, model);
      return text;
    } catch (err) {
      lastErr = err;
      noteQuota(model, err);
      if (!worthNextModel(err)) throw err;
    }
  }

  // Say it in plain words — Google's own quota message is three sentences and
  // two links, and the useful part (every model is spent for now) isn't in it.
  const allQuota = isGeminiQuotaError(lastErr);
  const e = new Error(allQuota
    ? `Gemini's free quota is used up on ${primaryModel}${fallbacks.length ? ` and ${fallbacks.length} other model${fallbacks.length === 1 ? '' : 's'}` : ''} for now — try again later.`
    : fallbacks.length
      ? `${primaryModel} and ${fallbacks.length} fallback model(s) are all busy right now — try again shortly. (${lastErr.message})`
      : lastErr.message);
  e.status = lastErr.status;
  throw e;
}

// Live model list from Google, rather than a hardcoded dropdown that inevitably goes
// stale whenever Google retires/renames a model (as gemini-2.5-flash was). Filtered to
// models that support generateContent and can take image input, since that's what the
// screenshot-import prompt needs.
router.get('/colleagues/gemini-models', async (req, res) => {
  const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const apiKey = keyRow && keyRow.value && keyRow.value.trim();
  if (!apiKey) return res.status(400).json({ error: 'No Gemini API key configured yet' });

  try {
    const r = await fetch(`${GEMINI_API_BASE}/v1beta/models?key=${apiKey}`);
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
      .filter(name => !NON_VISION_MODEL.test(name))
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
  // Contract hours as of this week (the week's end), not whatever they're on
  // today — so browsing an earlier week shows what applied at the time.
  }).map(c => ({ ...c, contract_hours: contractHoursForColleagueOnDate(c.id, to) }));

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
        const brk = autoBreakMinutes(s.start_time, s.end_time);
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
    SELECT id, source, note, inserted_count, undone_at, created_at, pending_conflicts, summary,
      schedule_data IS NOT NULL AS can_rerun,
      (SELECT id FROM photo_files WHERE import_batch_id = import_batches.id ORDER BY id DESC LIMIT 1) AS photo_id,
      (SELECT COUNT(*) FROM colleague_shifts WHERE import_batch_id = import_batches.id) AS remaining_count
    FROM import_batches
    WHERE inserted_count > 0 OR pending_conflicts IS NOT NULL
       OR json_array_length(json_extract(summary, '$.unknownNames')) > 0
       OR json_array_length(json_extract(summary, '$.warnings')) > 0
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(b => {
    // A batch entirely made of conflicts (nothing auto-inserted) still needs to
    // surface here — that's exactly the "phone uploaded, PC needs to review"
    // case. pending_conflicts itself is left out of the list payload (the detail
    // endpoint returns the full list); only the count is useful here. Same for
    // a background import that matched nobody: it used to vanish from this list
    // entirely, so the unknown names it found were never shown anywhere.
    const pendingCount = b.pending_conflicts ? JSON.parse(b.pending_conflicts).length : 0;
    let summary = null;
    try { summary = b.summary ? JSON.parse(b.summary) : null; } catch (_) {}
    const { pending_conflicts, summary: _s, ...rest } = b;
    return {
      ...rest,
      can_rerun: !!b.can_rerun,
      pending_conflict_count: pendingCount,
      unknown_names: summary?.unknownNames || [],
      warnings: summary?.warnings || [],
      week: summary?.week || null,
    };
  });
  res.json({ batches });
});

// POST /colleagues/import-batches/:id/rerun — run a past import again from the
// schedule it read, against the SAME batch (so Undo still covers everything it
// added). For after adding the people it didn't recognise: their shifts go in,
// everything already imported is an exact duplicate and skipped.
router.post('/colleagues/import-batches/:id/rerun', (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });
  if (batch.undone_at) return res.status(409).json({ error: 'This import was undone — upload it again instead' });
  if (!batch.schedule_data) return res.status(409).json({ error: "This import is too old to re-run (the schedule it read wasn't kept)" });
  let schedule;
  try { schedule = JSON.parse(batch.schedule_data); } catch (_) { return res.status(500).json({ error: 'Stored schedule is unreadable' }); }
  const result = runJsonScheduleImport(schedule, [], batchId);
  if (result.error) return res.status(400).json({ error: result.error });
  savePendingConflicts(batchId, schedule, result.conflicts);
  res.json(result);
});

router.delete('/colleagues/import-batches/:id', (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  if (!batchId) return res.status(400).json({ error: 'Invalid batch id' });
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });
  if (batch.undone_at) return res.status(409).json({ error: 'This import was already undone' });

  const undo = db.transaction(() => {
    const info = db.prepare('DELETE FROM colleague_shifts WHERE import_batch_id = ?').run(batchId);
    db.prepare("UPDATE import_batches SET undone_at = datetime('now'), pending_conflicts = NULL, pending_schedule_data = NULL WHERE id = ?").run(batchId);
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


// Persist (or clear) the review state on an import batch. Called after any pass
// over a schedule import — initial or a conflict-resolution follow-up — so a
// second device can pick up exactly where the first one left off. Storing the
// original schedule_data alongside the conflicts is what makes that possible:
// resolving needs to re-run the same matching logic with the chosen overrides,
// not just delete/insert the flagged rows directly.
function savePendingConflicts(batchId, scheduleData, conflicts) {
  if (conflicts && conflicts.length) {
    db.prepare('UPDATE import_batches SET pending_conflicts = ?, pending_schedule_data = ? WHERE id = ?')
      .run(JSON.stringify(conflicts), JSON.stringify(scheduleData), batchId);
  } else {
    db.prepare('UPDATE import_batches SET pending_conflicts = NULL, pending_schedule_data = NULL WHERE id = ?')
      .run(batchId);
  }
}

// Core of the JSON-schedule import — shared by the initial import (POST
// /colleagues/import-json, which opens a fresh batch) and conflict resolution
// (POST /colleagues/import-batches/:id/resolve-conflicts, which re-runs this
// against the SAME batch so newly-inserted shifts stay attached to the
// original import for Undo purposes). Returns the same shape either way;
// callers own creating/finalizing the batch and persisting review state.
function runJsonScheduleImport(schedule_data, overrides, batchId) {
  // Week from the header, cross-checked against the day labels (see
  // resolveWeekForSchedule) so a misread header can't shift the import a week.
  const weekDates = resolveWeekForSchedule(schedule_data.date_range, schedule_data.schedule.map(d => d && d.date));
  if (!weekDates)
    return { error: "Couldn't work out which week this is from the header: " + (schedule_data.date_range || '(missing)') };

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

  let inserted = 0, updated = 0, skipped = 0, reconciled = 0;
  const unknownNames = new Set();
  const warnings = [];
  const conflicts = []; // shifts that exist in DB with different data

  // The screenshot is treated as the authoritative picture for the home-store
  // days it actually covers: a colleague who was in a *previous* import for one
  // of those days but is completely absent from this one is stale data, not a
  // day off that just needs recording — see the reconciliation pass below.
  const incomingHomePresence = new Set(); // `${colleague_id}|${date}`
  // Same idea for shifts at another store, but keyed by store name too: moving
  // someone from Winchester to Fratton leaves the old Winchester row stale even
  // though the colleague is still in the screenshot that day.
  const incomingAwayPresence = new Set(); // `${colleague_id}|${date}|${store lower-cased}`
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
      if ((day.shifts || []).length) resolvedDates.add(dayDate);

      for (const shift of (day.shifts || [])) {
        const rawName = (shift.name || '').trim();
        if (!rawName) { skipped++; continue; }

        // Skip own shifts — "Ed" / "Ed K" / "ED KAY" all count, not just an exact match
        if (yourName && nameMatchesStrict(rawName, yourName)) { skipped++; continue; }

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
          const tr = parseTimeRange(shift.time);
          if (!tr) {
            warnings.push(`Couldn't read the time "${shift.time || ''}" for ${rawName} on ${dayDate} — skipped`);
            skipped++; continue;
          }
          shift_type = 'shift';
          start_time = tr.start;
          end_time   = tr.end;
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
        else incomingAwayPresence.add(`${col.id}|${dayDate}|${store.toLowerCase()}`);

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
          // decision has been made yet. A vague incoming entry (leave / all day)
          // never overrides a real shift; anything else is flagged as a real
          // conflict for the user to resolve.
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
    // home-store rows here; different-store rows get the same treatment just
    // below, matched on store name as well.
    const staleHomeRowsStmt = db.prepare(
      `SELECT id, colleague_id FROM colleague_shifts
       WHERE date = ? AND (store IS NULL OR store = '') AND import_batch_id IS NOT NULL`
    );
    // Only days this screenshot shows IN FULL. A day with no shifts in the reply
    // isn't evidence of anything (the model is told to list all 7 days, so a
    // screenshot of Mon–Wed comes back with Thu–Sun empty), and the first and
    // last days visible may be cut off at the top or bottom of the screen —
    // the rest of that day is often in the next screenshot. Clearing those
    // used to delete real shifts imported from the other half of the week.
    const staleAwayRowsStmt = db.prepare(
      `SELECT id, colleague_id, store FROM colleague_shifts
       WHERE date = ? AND store IS NOT NULL AND store != '' AND import_batch_id IS NOT NULL`
    );
    const shownDays = weekDates.filter(d => resolvedDates.has(d));
    const fullyShown = new Set(shownDays.slice(1, -1));
    for (const d of weekDates) {
      if (!fullyShown.has(d)) continue;
      for (const row of staleHomeRowsStmt.all(d)) {
        if (!incomingHomePresence.has(`${row.colleague_id}|${d}`)) {
          deleteShiftById.run(row.id);
          reconciled++;
        }
      }
      // A different-store shift that's no longer on the schedule for that day —
      // either dropped altogether or moved to another store — is stale too.
      // The screenshot lists every shift with its location line, so it does
      // speak for them; hand-entered shifts (no import batch) are still safe.
      for (const row of staleAwayRowsStmt.all(d)) {
        if (!incomingAwayPresence.has(`${row.colleague_id}|${d}|${String(row.store).trim().toLowerCase()}`)) {
          deleteShiftById.run(row.id);
          reconciled++;
        }
      }
    }
  })();

  // Accumulate rather than overwrite — resolve-conflicts re-runs this against the
  // same batchId, so a later pass's insert count must add to, not replace, an
  // earlier pass's.
  const priorInserted = db.prepare('SELECT inserted_count FROM import_batches WHERE id = ?').get(batchId)?.inserted_count || 0;
  finalizeImportBatch(batchId, priorInserted + inserted);
  // Kept on the batch so an import that ran in the background (queued
  // screenshot) can still tell you who it didn't recognise — and so it can be
  // re-run once they've been added.
  db.prepare('UPDATE import_batches SET summary = ?, schedule_data = ? WHERE id = ?').run(
    JSON.stringify({ inserted, updated, skipped, reconciled, warnings, unknownNames: [...unknownNames],
      week: [weekDates[0], weekDates[6]] }),
    JSON.stringify(schedule_data), batchId);
  return { inserted, updated, skipped, reconciled, conflicts, warnings, unknownNames: [...unknownNames] };
}

router.post('/colleagues/import-json', (req, res) => {
  const { schedule_data, overrides = [] } = req.body;
  if (!schedule_data || !Array.isArray(schedule_data.schedule))
    return res.status(400).json({ error: 'Expected { schedule_data: { date_range, schedule: [...] } }' });

  const batchId = createImportBatch('json', schedule_data.date_range || 'Team schedule JSON import');
  const result = runJsonScheduleImport(schedule_data, overrides, batchId);
  if (result.error) return res.status(400).json({ error: result.error });

  // Anything left unresolved gets parked on this batch so a different device
  // (e.g. reviewing on a PC after uploading from a phone) can pick it up later
  // via GET/POST /colleagues/import-batches/:id/conflicts.
  savePendingConflicts(batchId, schedule_data, result.conflicts);

  res.json({ ...result, batchId, needsReview: result.conflicts.length > 0 });
});

// GET /colleagues/import-batches/:id/conflicts — the pending conflicts + the
// original schedule JSON for a batch, so a second device can render the same
// resolution table the uploading device would have shown and decide from there.
router.get('/colleagues/import-batches/:id/conflicts', (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });
  if (!batch.pending_conflicts) return res.json({ conflicts: [], schedule_data: null });
  // The screenshot this import was read from, so the review screen can show it
  // next to the conflicts instead of making you hunt for it in the Photo Library.
  const photo = db.prepare('SELECT id FROM photo_files WHERE import_batch_id = ? ORDER BY id DESC LIMIT 1').get(batchId);
  res.json({
    photo_id:      photo?.id || null,
    conflicts:     JSON.parse(batch.pending_conflicts),
    schedule_data: JSON.parse(batch.pending_schedule_data),
    date_range:    batch.note,
  });
});

// POST /colleagues/import-batches/:id/resolve-conflicts — apply chosen overrides
// against a batch's stored pending conflicts. Re-runs against the SAME batch id
// (rather than opening a new one) so everything this import ever touched — the
// original insert plus whatever resolving conflicts adds/replaces — undoes as
// one unit, and the review queue doesn't grow a new row per resolution attempt.
router.post('/colleagues/import-batches/:id/resolve-conflicts', (req, res) => {
  const batchId = parseInt(req.params.id, 10);
  const { overrides = [] } = req.body;
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });
  if (!batch.pending_schedule_data) return res.status(409).json({ error: 'This import has no pending conflicts to resolve' });

  const schedule_data = JSON.parse(batch.pending_schedule_data);
  const result = runJsonScheduleImport(schedule_data, overrides, batchId);
  if (result.error) return res.status(400).json({ error: result.error });

  savePendingConflicts(batchId, schedule_data, result.conflicts);
  res.json({ ...result, batchId, needsReview: result.conflicts.length > 0 });
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
  // ALL of my shifts that day — a split day has two, and only ever returning the
  // first made the second invisible here. `myShift` stays as the first for
  // anything that only wants one.
  const myShifts = db.prepare(
    'SELECT start_time, end_time FROM shifts WHERE date = ? ORDER BY start_time ASC'
  ).all(target).map(r => ({ start: r.start_time, end: r.end_time }));
  const myShift = myShifts[0] || null;

  let myStatus = null;
  if (isToday && myShifts.length) {
    const onNow = myShifts.find(s => s.start <= currentTime && s.end > currentTime);
    const soon  = myShifts.find(s => s.start > currentTime && s.start <= soonTime);
    if (onNow)     myStatus = { status: 'in',   start: onNow.start, end: onNow.end };
    else if (soon) myStatus = { status: 'soon', start: soon.start,  end: soon.end };
  }

  res.json({
    date: target, today: realToday, prevDate, nextDate,
    isToday, isDefaultRollover,
    currentTime, myName, myStatus,
    inNow, inSoon, leavingInHour,
    teamShifts, myShift, myShifts,
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
  const weekDates = resolveWeekDates(dateRange) || resolveWeekDatesLoose(dateRange);
  if (!weekDates) return null;
  return labelForWeekDates(weekDates);
}

function labelForWeekDates(weekDates) {
  const toDDMMYYYY = iso => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  return { weekStart: weekDates[0], label: `${toDDMMYYYY(weekDates[0])} - ${toDDMMYYYY(weekDates[6])}` };
}

// The rename queue only ever needed the week off the top of the screenshot, but
// it was asking with OLLAMA_PROMPT — the full "transcribe every shift on this
// rota" instruction. That's a much harder job to get exactly right, it costs
// several times the tokens out of the same free-tier allowance, and any slip
// anywhere in the transcription came back as a JSON parse failure and therefore
// as "could not read a week range". Asking only for the thing we use is both
// cheaper and far more likely to succeed.
const WEEK_RANGE_PROMPT = `This image is a screenshot of a work rota for one week.

Find the week it covers. It is usually written as a header near the top, e.g.
"Feb 23, 2026 – Mar 1, 2026" or "23 Feb - 1 Mar". If there is no header, work it
out from the day/date labels down the left-hand side.

Return ONLY this JSON, nothing else:
{"week_start":"YYYY-MM-DD","week_end":"YYYY-MM-DD","header":"<the header text exactly as shown, or empty string>"}

Rules:
- week_start is the MONDAY of that week, week_end is the SUNDAY — exactly 7 days apart.
- If no year is shown anywhere, use the year that makes the dates match the weekdays shown.
- If you genuinely cannot tell which week it is, return {"week_start":null,"week_end":null,"header":""}.`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Prefer the ISO dates the model was asked for; fall back to parsing the header
// text it echoed back, so a model that ignores the schema but does read the
// header still gets the photo renamed.
function weekRangeFromParsed(parsed) {
  if (!parsed) return null;
  const start = typeof parsed.week_start === 'string' ? parsed.week_start.trim() : '';
  if (ISO_DATE_RE.test(start) && !isNaN(new Date(start + 'T12:00:00'))) {
    const d0 = new Date(start + 'T12:00:00');
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(d0);
      d.setDate(d0.getDate() + i);
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return labelForWeekDates(dates);
  }
  return weekRangeForFilename(parsed.header || parsed.date_range);
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

// POST /photo-library/folders/:id/files — multi-file upload (field: "photos").
// autoRename='1' flags the inserted rows for the background rename queue below
// instead of the caller looping Gemini calls synchronously in this request —
// same reliability fix as the screenshot-import queue: uploading has to stay
// fast and hard to fail, especially from a phone.
router.post('/photo-library/folders/:id/files', photoUpload.array('photos', 50), (req, res) => {
  const folderId = parseInt(req.params.id, 10);
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
  const autoRename = req.body?.autoRename === '1' || req.body?.autoRename === 'true';
  try {
    const dir = fsPath.join(PHOTO_BASE, String(folderId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const insert = db.prepare(
      'INSERT INTO photo_files (folder_id, filename, mime_type, file_path, queued_for_rename) VALUES (?,?,?,?,?)'
    );
    const fileIds = [];
    db.transaction(() => {
      for (const f of files) {
        const safeName = Date.now() + '_' + f.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const filePath = fsPath.join(dir, safeName);
        fs.writeFileSync(filePath, f.buffer);
        const info = insert.run(folderId, f.originalname, f.mimetype, filePath, autoRename ? 1 : 0);
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

// Shared by the synchronous single-file endpoint below and the background
// rename queue — reads the week range off a screenshot with Gemini and
// renames it. Only touches the display filename + week_start_date (sort key)
// — the file on disk is untouched. Returns { filename, weekStart }; throws
// (with .status where relevant) on failure so callers report it their own way.
async function renamePhotoFileWithGemini(f) {
  if (!f.file_path || !fs.existsSync(f.file_path)) {
    const err = new Error('Photo file not found'); err.status = 404; throw err;
  }
  const buffer = fs.readFileSync(f.file_path);
  const { parsed, rawText } = await callGeminiVision(buffer, f.mime_type || 'image/jpeg', WEEK_RANGE_PROMPT);
  const range = weekRangeFromParsed(parsed);
  if (!range) {
    // Say what it actually came back with. "Could not read a week range" on its
    // own is unactionable in the queue card — you can't tell a photo that isn't
    // a rota from a header in a format the parser doesn't know.
    const saw = (rawText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const err = new Error('Could not read a week range from this image' + (saw ? ` — Gemini said: ${saw}` : ''));
    err.status = 422;
    throw err;
  }

  const ext = fsPath.extname(f.filename) || '.jpg';
  const existingNames = new Set(
    db.prepare('SELECT filename FROM photo_files WHERE folder_id = ? AND id != ?').all(f.folder_id, f.id).map(r => r.filename)
  );
  let filename = range.label + ext;
  let n = 2;
  while (existingNames.has(filename)) { filename = `${range.label} (${n})${ext}`; n++; }

  db.prepare('UPDATE photo_files SET filename=?, week_start_date=? WHERE id=?').run(filename, range.weekStart, f.id);
  return { filename, weekStart: range.weekStart };
}

// POST /photo-library/files/:id/ai-rename — synchronous single-file rename,
// used by the "AI Rename" button on manually-selected photos in the UI.
router.post('/photo-library/files/:id/ai-rename', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const f = db.prepare('SELECT * FROM photo_files WHERE id=?').get(id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    const { filename, weekStart } = await renamePhotoFileWithGemini(f);
    res.json({ id, filename, week_start_date: weekStart });
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

// ─────────────────────────────────────────
// Screenshot auto-import queue
//
// The Auto Import (AI) panel used to run upload + Gemini read + import as one
// HTTP request from the browser. On a phone that's a bad bet: a Gemini vision
// call can take a while, and if the connection drops or the tab gets
// backgrounded mid-request (very easy to do — lock the screen, switch apps),
// the whole thing fails with a bare "Failed to fetch" and nothing is saved.
//
// Instead, POST /colleagues/screenshot-queue only saves the raw file (fast,
// small request, hard to fail) into the Photo Library's "Team Rota
// Screenshots" folder with queued_for_import=1. A server-side loop then reads
// unprocessed rows a few at a time, runs them through Gemini + the same
// import pipeline as manual JSON import, and leaves the result (including any
// conflicts) on an import batch exactly like every other import — so it shows
// up in Recent Imports / Needs Review on whichever device checks next.
// ─────────────────────────────────────────

// POST /colleagues/screenshot-queue — fast multi-file upload, no Gemini call here
router.post('/colleagues/screenshot-queue', upload.array('screenshots', 10), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
  try {
    const folderId = getOrCreatePhotoFolder('Team Rota Screenshots');
    const fileIds = files.map(f => {
      const baseName = (f.originalname || '').replace(/\.[^.]+$/, '') || `Screenshot ${Date.now()}`;
      const id = savePhotoToFolder(folderId, f.buffer, f.mimetype || 'image/jpeg', baseName, null);
      db.prepare('UPDATE photo_files SET queued_for_import = 1 WHERE id = ?').run(id);
      return id;
    });
    res.json({ ok: true, queued: fileIds.length, fileIds });
    // Start reading them now instead of waiting for the next 30s tick.
    setImmediate(() => processScreenshotQueue().catch(e => console.error('[ScreenshotQueue] kick error:', e.message)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /colleagues/screenshot-queue — only what's still waiting or failed.
// Finished screenshots (imported cleanly, or needing conflict review) belong
// in Recent Imports, not here — this is a queue of in-flight work, not a
// history log, so a completed item drops out the moment it's done.
// Three states, not two: a screenshot with an error that will still be retried
// automatically (rate limit, or a failed attempt with attempts left) used to be
// shown as "Failed" — with the reason only in a tooltip a phone can't show.
router.get('/colleagues/screenshot-queue', (req, res) => {
  const rows = db.prepare(`
    SELECT id, filename, uploaded_at, process_error, process_attempts
    FROM photo_files
    WHERE queued_for_import = 1 AND processed_at IS NULL
    ORDER BY id ASC
  `).all();
  const gaveUp = r => r.process_error && r.process_attempts >= SCREENSHOT_QUEUE_MAX_ATTEMPTS;
  res.json({
    pending: rows.filter(r => !r.process_error),
    waiting: rows.filter(r => r.process_error && !gaveUp(r)),
    failed:  rows.filter(gaveUp),
    max_attempts: SCREENSHOT_QUEUE_MAX_ATTEMPTS,
    paused_secs: geminiPauseSecsLeft(),
  });
});

// POST /colleagues/screenshot-queue/:id/retry — clear a failed item so the
// next processing tick picks it up again
router.post('/colleagues/screenshot-queue/:id/retry', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare(
    'UPDATE photo_files SET process_error = NULL, process_attempts = 0 WHERE id = ? AND queued_for_import = 1'
  ).run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Queued screenshot not found' });
  res.json({ ok: true });
});

// ── Shared Gemini throttle ────────────────────────────────────────────────
// Errors that mean "not now" rather than "not ever": out of quota, rate
// limited, the model busy, the request timing out. isGeminiOverloadError is
// deliberately narrower — it decides whether to fall back to another model,
// and a project-wide quota error follows you to every model there is.
function isTransientGeminiError(err) {
  const msg = err?.message || '';
  return err?.status === 429 || err?.status === 503 || err?.status === 504 ||
    /quota|rate.?limit|resource[_ ]exhausted|too many requests|overloaded|try again later|didn't respond within/i.test(msg);
}

// Google's quota error is three sentences and two support URLs — none of it
// readable in a 96px queue card on a phone. Keep the one fact that matters.
function waitingMessage(err) {
  const msg = err?.message || '';
  if (/quota/i.test(msg)) {
    const limit = msg.match(/limit:\s*(\d+)/);
    return 'Gemini quota reached' + (limit ? ` (${limit[1]}/min on the free tier)` : '') +
           ' — waiting, will retry itself';
  }
  if (/rate.?limit|too many requests/i.test(msg)) return 'Gemini rate limit — waiting, will retry itself';
  return 'Waiting to retry — ' + msg;
}

// Both background queues spend the same free-tier allowance, so being told
// "no" in one is a reason for the other to hold off too — otherwise they take
// turns burning a locked-out quota every 30 seconds, and neither finishes.
// Backoff doubles from a minute up to fifteen, and the first success clears it.
let geminiPausedUntil = 0;
let geminiBackoffMs   = 0;
const GEMINI_BACKOFF_MIN_MS = 60_000;
const GEMINI_BACKOFF_MAX_MS = 15 * 60_000;

function geminiPaused()      { return Date.now() < geminiPausedUntil; }
function geminiPauseSecsLeft() { return Math.max(0, Math.ceil((geminiPausedUntil - Date.now()) / 1000)); }
function noteGeminiThrottled(err) {
  // Google sometimes says how long to wait. Take it as a floor, never below a
  // minute: the free tier's window is per-minute, and its own "retry in 644ms"
  // just puts you straight back into the same wall.
  const m = (err?.message || '').match(/retry in ([\d.]+)\s*(ms|s)?/i);
  const hinted = m ? (m[2] === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000) : 0;
  geminiBackoffMs = Math.min(Math.max(geminiBackoffMs * 2, hinted, GEMINI_BACKOFF_MIN_MS), GEMINI_BACKOFF_MAX_MS);
  geminiPausedUntil = Date.now() + geminiBackoffMs;
  console.warn(`[Gemini] throttled — pausing both queues for ${Math.round(geminiBackoffMs / 1000)}s: ${err?.message || ''}`);
}
function noteGeminiOk() { geminiBackoffMs = 0; geminiPausedUntil = 0; }

const SCREENSHOT_QUEUE_MAX_ATTEMPTS = 3;
const QUEUE_GEMINI_TIMEOUT_MS = 120000;
const SCREENSHOT_QUEUE_BATCH_SIZE   = 3; // per tick — enough to keep multi-file uploads moving without hammering Gemini

async function processOneQueuedScreenshot(row) {
  if (!fs.existsSync(row.file_path)) throw new Error('File missing on disk');
  const buffer = fs.readFileSync(row.file_path);
  // Background job, nobody waiting on it: give a slow ("thinking") model time
  // to read a long rota rather than timing out at the interactive 45s.
  const { parsed: raw, rawText, modelUsed } = await callGeminiVision(buffer, row.mime_type || 'image/jpeg', OLLAMA_PROMPT,
    { timeoutMs: QUEUE_GEMINI_TIMEOUT_MS });
  const excerpt = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!raw) throw new Error(`${modelUsed || 'Gemini'} didn't reply with readable JSON` + (excerpt ? ` — it said: "${excerpt}${excerpt.length >= 160 ? '…' : ''}"` : ' (empty reply)'));
  const parsed = coerceSchedule(raw);
  if (!parsed) throw new Error(`${modelUsed || 'Gemini'} replied, but with no schedule in it — it said: "${excerpt}${excerpt.length >= 160 ? '…' : ''}"`);

  // Rename to the detected week, same as the manual "AI rename" action, so
  // queued screenshots end up named consistently in the Photo Library.
  const range = weekRangeForFilename(parsed.date_range);
  if (range) {
    const ext = fsPath.extname(row.filename) || '.jpg';
    const existingNames = new Set(
      db.prepare('SELECT filename FROM photo_files WHERE folder_id = ? AND id != ?').all(row.folder_id, row.id).map(r => r.filename)
    );
    let filename = range.label + ext;
    let n = 2;
    while (existingNames.has(filename)) { filename = `${range.label} (${n})${ext}`; n++; }
    db.prepare('UPDATE photo_files SET filename=?, week_start_date=? WHERE id=?').run(filename, range.weekStart, row.id);
  }

  const batchId = createImportBatch('gemini', `Auto-queued screenshot — ${row.filename}`);
  const result = runJsonScheduleImport(parsed, [], batchId);
  if (result.error) throw new Error(result.error);
  savePendingConflicts(batchId, parsed, result.conflicts);
  db.prepare(
    "UPDATE photo_files SET processed_at = datetime('now'), process_error = NULL, import_batch_id = ? WHERE id = ?"
  ).run(batchId, row.id);
}

// Guards against overlapping runs — each screenshot now has a bounded Gemini
// timeout (see GEMINI_VISION_TIMEOUT_MS), but a batch of a few could still run
// past the next 30s tick, and starting a second pass over the same rows
// concurrently would just waste Gemini calls on rows already in flight.
let screenshotQueueRunning = false;

async function processScreenshotQueue() {
  if (screenshotQueueRunning || geminiPaused()) return;
  screenshotQueueRunning = true;
  try {
   // Keep pulling batches until nothing is left (or Gemini throttles us): a
   // 10-screenshot upload used to take three 30s ticks minimum, doing three at
   // a time and then sitting idle. Rows that already failed this run are
   // skipped so a permanently failing one can't spin the loop.
   const seenThisRun = new Set();
   while (!geminiPaused()) {
    const rows = db.prepare(`
      SELECT * FROM photo_files
      WHERE queued_for_import = 1 AND processed_at IS NULL
        AND (process_error IS NULL OR process_attempts < ?)
      ORDER BY id ASC LIMIT ?
    `).all(SCREENSHOT_QUEUE_MAX_ATTEMPTS, SCREENSHOT_QUEUE_BATCH_SIZE + seenThisRun.size).filter(r => !seenThisRun.has(r.id));
    if (!rows.length) break;
    let throttled = false;

    for (const row of rows) {
      seenThisRun.add(row.id);
      try {
        await processOneQueuedScreenshot(row);
        noteGeminiOk();
      } catch (err) {
        console.error('[ScreenshotQueue] Failed to process', row.filename, '-', err.message);
        // Same rule as the rename queue: being rate-limited says nothing about
        // this screenshot, so it mustn't cost the screenshot one of its three
        // attempts. Record why it's waiting and stop — the API isn't taking
        // anything else this minute either.
        const transient = isTransientGeminiError(err);
        if (transient) noteGeminiThrottled(err);
        db.prepare(
          'UPDATE photo_files SET process_error = ?, process_attempts = process_attempts + ? WHERE id = ?'
        ).run(transient ? waitingMessage(err) : err.message, transient ? 0 : 1, row.id);
        if (transient) { throttled = true; break; }
      }
    }
    if (throttled) break;
   }
  } finally {
    screenshotQueueRunning = false;
  }
}

setInterval(() => { processScreenshotQueue().catch(e => console.error('[ScreenshotQueue] tick error:', e.message)); }, 30_000);
// Run once shortly after startup too, so anything left queued from before a
// restart doesn't sit idle for a full 30s before the first attempt.
setTimeout(() => { processScreenshotQueue().catch(e => console.error('[ScreenshotQueue] tick error:', e.message)); }, 5_000);

// ─────────────────────────────────────────
// AI-rename queue — "Auto-rename with AI on upload" (Photo Library)
//
// Same shape as the screenshot-import queue above, applied to renaming
// instead of importing: uploading with the checkbox on used to loop a Gemini
// call per file synchronously in the same request, which had exactly the
// same "Failed to fetch on a phone" risk as the old screenshot importer did.
// ─────────────────────────────────────────

// GET /photo-library/rename-queue — waiting/failed AI-rename jobs across all
// folders, for the Photo Library page's visual queue. Only in-flight work —
// a finished rename just shows its new filename in the grid, same as any
// other photo, so it isn't carried here once done.
router.get('/photo-library/rename-queue', (req, res) => {
  const rows = db.prepare(`
    SELECT id, filename, folder_id, rename_error, rename_attempts
    FROM photo_files
    WHERE queued_for_rename = 1 AND rename_processed_at IS NULL
    ORDER BY id ASC
  `).all();
  res.json({
    pending: rows.filter(r => (r.rename_attempts || 0) <  RENAME_QUEUE_MAX_ATTEMPTS),
    failed:  rows.filter(r => (r.rename_attempts || 0) >= RENAME_QUEUE_MAX_ATTEMPTS),
    // So the card can say "waiting for quota" rather than looking stalled
    paused_seconds: geminiPaused() ? geminiPauseSecsLeft() : 0,
  });
});

// POST /photo-library/rename-queue/bulk — flag existing photos (e.g. a large
// "Select All" → "AI Rename" batch) for the background queue instead of the
// caller looping a Gemini call per photo. A synchronous loop over hundreds of
// photos ties up the browser tab for the best part of an hour and loses all
// remaining progress the moment that tab closes or the connection drops —
// the queue survives both.
router.post('/photo-library/rename-queue/bulk', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE photo_files SET queued_for_rename = 1, rename_processed_at = NULL, rename_error = NULL, rename_attempts = 0
     WHERE id IN (${placeholders})`
  ).run(...ids);
  res.json({ queued: info.changes });
});

// POST /photo-library/rename-queue/retry-all — clear every failed job at once.
// A quota outage fails jobs by the hundred; retrying those one card at a time
// isn't a real option, least of all on a phone.
router.post('/photo-library/rename-queue/retry-all', (req, res) => {
  const info = db.prepare(`
    UPDATE photo_files SET rename_error = NULL, rename_attempts = 0
    WHERE queued_for_rename = 1 AND rename_processed_at IS NULL AND rename_error IS NOT NULL
  `).run();
  res.json({ retried: info.changes });
});

// POST /photo-library/rename-queue/:id/retry
router.post('/photo-library/rename-queue/:id/retry', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare(
    'UPDATE photo_files SET rename_error = NULL, rename_attempts = 0 WHERE id = ? AND queued_for_rename = 1'
  ).run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Queued rename not found' });
  res.json({ ok: true });
});

const RENAME_QUEUE_MAX_ATTEMPTS = 3;
// Ten a minute against the free tier's twenty, leaving room for the screenshot
// queue and anything you do by hand. Overshooting isn't fatal any more — the
// shared backoff catches it — but it wastes calls out of the same allowance.
const RENAME_QUEUE_BATCH_SIZE   = 5;
let renameQueueRunning = false;

async function processRenameQueue() {
  if (renameQueueRunning || geminiPaused()) return;
  renameQueueRunning = true;
  try {
    const rows = db.prepare(`
      SELECT * FROM photo_files
      WHERE queued_for_rename = 1 AND rename_processed_at IS NULL
        AND (rename_error IS NULL OR rename_attempts < ?)
      ORDER BY id ASC LIMIT ?
    `).all(RENAME_QUEUE_MAX_ATTEMPTS, RENAME_QUEUE_BATCH_SIZE);

    for (const row of rows) {
      try {
        await renamePhotoFileWithGemini(row);
        noteGeminiOk();
        db.prepare(
          "UPDATE photo_files SET rename_processed_at = datetime('now'), rename_error = NULL WHERE id = ?"
        ).run(row.id);
      } catch (err) {
        console.error('[RenameQueue] Failed to process', row.filename, '-', err.message);
        // A quota/rate-limit/overload error says nothing about this photo — it's
        // the API being unavailable this minute. Burning an attempt on it (three
        // in a row, 30s apart) is how a whole queued batch could end up marked
        // failed without a single photo having actually been looked at. Record
        // why it's waiting, keep the attempt count, and stop the tick: whatever
        // is throttling us applies to every job behind this one too.
        const transient = isTransientGeminiError(err);
        if (transient) noteGeminiThrottled(err);
        db.prepare(
          'UPDATE photo_files SET rename_error = ?, rename_attempts = rename_attempts + ? WHERE id = ?'
        ).run(transient ? waitingMessage(err) : err.message, transient ? 0 : 1, row.id);
        if (transient) break;
      }
    }
  } finally {
    renameQueueRunning = false;
  }
}

setInterval(() => { processRenameQueue().catch(e => console.error('[RenameQueue] tick error:', e.message)); }, 30_000);
setTimeout(() => { processRenameQueue().catch(e => console.error('[RenameQueue] tick error:', e.message)); }, 8_000);

module.exports = router;
// callGeminiText is shared with v3/didYouKnow.js. The vision counterpart isn't
// exported: its only outside caller was the payslip photo import, removed in
// v4.12.0, and everything that still reads an image with it lives in this file.
module.exports.callGeminiText = callGeminiText;
