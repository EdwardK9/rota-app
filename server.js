// Pin timezone to UK so all shift/date/reminder maths is correct regardless of container TZ
process.env.TZ = 'Europe/London';
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs   = require('fs');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const { execSync, execFileSync } = require('child_process');
const packageJson = require('./package.json');
const { db, getPayRateForDate, calcHoursWorked } = require('./db');
const { leaveHoursByMonth, leaveHoursByWeek } = require('./leaveHours');
const workingWithRouter = require('./working-with');
const { callGeminiVision } = workingWithRouter;
const commuteRouter = require('./commute');
const { fetchHourlyForecast, nearestHourKey, buildAlerts } = commuteRouter;
const teamMetricsRouter = require('./teamMetrics');
const fatigueAuditRouter = require('./fatigueAudit');
const webhooksRouter = require('./webhooks');
const exportsV2Router = require('./exportsV2');
// V3.0 feature set — self-contained under v3/, mounted as a single router.
const v3Router = require('./v3');
const gcal = require('./google-calendar');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);   // correct protocol/host behind Cloudflare proxy
// Gzip everything (JS/CSS/JSON) — the JS bundle alone is ~800KB uncompressed,
// which is fine on localhost but noticeably slow over a real network connection.
app.use(compression());
app.use(express.json({ limit: '10mb' }));
// index.html is served with the running app version stamped into every ?v= asset
// token. Hand-maintained tokens were a standing trap: forget to bump one and the
// browser keeps last week's JS while the API moves on, which fails in exactly the
// confusing way (new HTML, old script, "X is not a function"). Deriving the token
// from package.json means a version bump busts every asset automatically, and the
// cost is one re-download per deploy.
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/index.html'], (req, res, next) => {
  fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
    if (err) return next();   // fall through to static, which will 404 properly
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(/\?v=[\w.]+/g, '?v=' + packageJson.version));
  });
});

// Static assets: JS/CSS includes are versioned with ?v= tokens in index.html, so they
// can be cached hard; index.html itself must always revalidate or deploys look stale.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // index.html, the service worker and the manifest must always revalidate;
    // everything else (versioned JS/CSS, icons) can be cached hard.
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));
app.use('/api', workingWithRouter);
app.use('/api', commuteRouter);
app.use('/api', teamMetricsRouter);
app.use('/api', fatigueAuditRouter);
app.use('/api', webhooksRouter);
app.use('/api', exportsV2Router);
app.use('/api/v3', v3Router);

// Version readout + changelog — lets the running app be identified at a glance
// (sidebar footer, and the "What's New" page behind clicking it), so it's
// obvious whether the latest push has actually deployed.
//
// Both the commit hash and the changelog entries are read from changelog.json
// rather than live git, because the production Docker image has no .git
// directory and no git binary at all (Alpine's node:18 image doesn't ship
// one) — see scripts/generate-changelog.js, which is what actually writes
// that file, run locally (where git *is* available) before every push. The
// live git attempts below are kept only as a fallback for local dev on a
// machine that has git, e.g. running the server straight after a code change
// before bothering to regenerate the file.
let _gitCommit = null;
let _changelog = [];
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
  _gitCommit = data.commit || null;
  _changelog = data.entries || [];
} catch (_) { /* no changelog.json yet — fall through to live git below */ }

if (!_gitCommit) {
  try {
    _gitCommit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (_) { /* not a git checkout, or git unavailable — commit stays null */ }
}

if (!_changelog.length) {
  try {
    const raw = execFileSync(
      'git', ['log', '--date=short', '--pretty=format:%ad|||%B%x00'],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10 * 1024 * 1024 }
    ).toString();
    _changelog = raw.split('\x00')
      .map(chunk => chunk.trim())
      .filter(Boolean)
      .map(chunk => {
        const sep = chunk.indexOf('|||');
        if (sep === -1) return null;
        const date = chunk.slice(0, sep);
        const body = chunk.slice(sep + 3).trim();
        const lines = body.split('\n');
        const m = lines[0].match(/^v(\d+\.\d+\.\d+):\s*(.+)$/);
        if (!m) return null;
        const details = lines.slice(1).join('\n')
          .replace(/^Co-Authored-By:.*$/gim, '')
          .trim();
        return { version: m[1], date, summary: m[2], details };
      })
      .filter(Boolean);
  } catch (_) { /* no changelog.json and no usable git — changelog stays empty */ }
}

const SERVER_STARTED_AT = new Date().toISOString();

app.get('/api/version', (req, res) => {
  res.json({ version: packageJson.version, commit: _gitCommit, startedAt: SERVER_STARTED_AT });
});

app.get('/api/changelog', (req, res) => {
  res.json({ entries: _changelog, currentVersion: packageJson.version });
});

// ─────────────────────────────────────────
// SHIFTS
// ─────────────────────────────────────────

// List shifts — optional ?month=YYYY-MM, ?year=YYYY, or ?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/shifts', (req, res) => {
  const { month, year, from, to } = req.query;
  let query = 'SELECT * FROM shifts';
  const params = [];

  if (from && to) {
    query += ' WHERE date >= ? AND date <= ?';
    params.push(from, to);
  } else if (month) {
    query += " WHERE strftime('%Y-%m', date) = ?";
    params.push(month);
  } else if (year) {
    query += " WHERE strftime('%Y', date) = ?";
    params.push(year);
  }

  query += ' ORDER BY date ASC, start_time ASC';
  res.json(db.prepare(query).all(...params));
});

// Bulk complete — must come BEFORE /:id routes to avoid Express treating 'bulk-complete' as an id
app.patch('/api/shifts/bulk-complete', (req, res) => {
  // break_taken / break_taken_minutes are optional overrides
  const { ids, completed = true, break_taken, break_taken_minutes } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids array required' });
  }
  let updated = 0;
  const doUpdate = db.transaction(() => {
    for (const id of ids) {
      const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
      if (!existing) continue;

      // Use override break info if provided, otherwise keep what the shift already has
      const usedBreakTaken   = break_taken !== undefined ? break_taken : existing.break_taken;
      const usedBreakMins    = break_taken_minutes !== undefined
        ? break_taken_minutes
        : resolveBreakMinutes(existing.break_taken, existing.break_scheduled_minutes);

      const hours_worked = calcHoursWorked(existing.start_time, existing.end_time, usedBreakMins);
      const hours_paid   = calcHoursWorked(existing.start_time, existing.end_time, existing.break_scheduled_minutes);
      const bhRate = existing.hourly_rate ? existing.hourly_rate * (existing.is_bank_holiday ? 2 : 1) : null;
      const calculated_pay = bhRate ? Math.round(hours_paid * bhRate * 100) / 100 : null;
      db.prepare(`
        UPDATE shifts
        SET completed=?, break_taken=?, break_taken_minutes=?,
            hours_worked=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
        WHERE id=?
      `).run(completed ? 1 : 0, usedBreakTaken, usedBreakMins, hours_worked, hours_paid, calculated_pay, id);
      logAudit({
        shift_id: id,
        action: completed ? 'bulk_completed' : 'bulk_uncompleted',
        changed_fields: ['completed', 'break_taken', 'break_taken_minutes'],
        old_values: { completed: existing.completed, break_taken: existing.break_taken, break_taken_minutes: existing.break_taken_minutes },
        new_values: { completed: completed ? 1 : 0, break_taken: usedBreakTaken, break_taken_minutes: usedBreakMins },
        source: 'manual',
      });
      updated++;
    }
  });
  doUpdate();
  res.json({ updated });
});

// Bulk mileage update
app.patch('/api/shifts/bulk-mileage', (req, res) => {
  const { ids, distance_miles } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (distance_miles === undefined || distance_miles === null) {
    return res.status(400).json({ error: 'distance_miles required' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const newDist = parseFloat(distance_miles);
  const existingRows = db.prepare(`SELECT id, distance_miles FROM shifts WHERE id IN (${placeholders})`).all(...ids);
  const result = db.prepare(
    `UPDATE shifts SET distance_miles=?, updated_at=datetime('now') WHERE id IN (${placeholders})`
  ).run(newDist, ...ids);
  for (const row of existingRows) {
    logAudit({
      shift_id: row.id,
      action: 'bulk_mileage_updated',
      changed_fields: ['distance_miles'],
      old_values: { distance_miles: row.distance_miles },
      new_values: { distance_miles: newDist },
      source: 'manual',
    });
  }
  res.json({ updated: result.changes });
});

// Get a single shift
// Break audit — completed shifts where the SCHEDULED break differs from autoBreakMinutes().
// IMPORTANT: this compares/corrects break_scheduled_minutes (the policy value that always
// drives pay — hours_paid is always gross minus the SCHEDULED break, never the actual break
// taken). It deliberately never compares or touches break_taken/break_taken_minutes, which is
// the employee's real recorded attendance (full/partial/none) — e.g. a shift where you
// genuinely worked through your break (break_taken='none') is NOT a data error to "fix" back
// to a full break; it's real history, and rewriting it would also erase the "unused break"
// hours_worked-vs-hours_paid gap used elsewhere for that entitlement.
// (registered BEFORE /api/shifts/:id below, otherwise Express matches :id="break-audit" first and 404s)
app.get('/api/shifts/break-audit', (req, res) => {
  const shifts = db.prepare(
    `SELECT id, date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes, hours_worked, hours_paid
     FROM shifts
     WHERE completed = 1
     ORDER BY date DESC`
  ).all();

  const discrepancies = [];
  for (const s of shifts) {
    const expected = autoBreakMinutes(s.start_time, s.end_time);
    const stored   = s.break_scheduled_minutes ?? 0;
    if (stored !== expected) {
      // Gross minutes
      const [sh, sm] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);
      let gross = (eh * 60 + em) - (sh * 60 + sm);
      if (gross < 0) gross += 24 * 60;
      const correctedHours = Math.round((gross - expected) / 60 * 100) / 100;
      const storedHours    = Math.round((gross - stored)   / 60 * 100) / 100;
      discrepancies.push({
        id:             s.id,
        date:           s.date,
        start_time:     s.start_time,
        end_time:       s.end_time,
        break_taken:        s.break_taken,
        break_taken_minutes: s.break_taken_minutes,
        stored_break:   stored,
        expected_break: expected,
        stored_hours:   storedHours,
        corrected_hours: correctedHours,
        diff_hours:     Math.round((correctedHours - storedHours) * 100) / 100,
      });
    }
  }

  res.json(discrepancies);
});

// Apply break-schedule corrections for selected shift IDs. Only ever touches
// break_scheduled_minutes (+ the pay fields that derive from it) — break_taken and
// break_taken_minutes are left exactly as recorded.
app.post('/api/shifts/break-audit/apply', (req, res) => {
  const { ids } = req.body;  // array of shift IDs to correct
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ updated: 0 });

  let updated = 0;
  const doUpdate = db.transaction(() => {
    for (const id of ids) {
      const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
      if (!s || !s.completed) continue;
      const expected = autoBreakMinutes(s.start_time, s.end_time);
      const hp = calcHoursWorked(s.start_time, s.end_time, expected);
      const rateRecord = getPayRateForDate(s.date);
      const rate = s.hourly_rate || (rateRecord ? rateRecord.hourly_rate : null);
      const effectiveRate = rate ? rate * (s.is_bank_holiday ? 2 : 1) : null;
      const cp = effectiveRate ? Math.round(hp * effectiveRate * 100) / 100 : null;
      db.prepare(`
        UPDATE shifts
        SET break_scheduled_minutes=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
        WHERE id=?
      `).run(expected, hp, cp, id);
      logAudit({
        shift_id: id,
        action: 'break_audit_corrected',
        changed_fields: ['break_scheduled_minutes','hours_paid','calculated_pay'],
        old_values: { break_scheduled_minutes: s.break_scheduled_minutes, hours_paid: s.hours_paid, calculated_pay: s.calculated_pay },
        new_values: { break_scheduled_minutes: expected, hours_paid: hp, calculated_pay: cp },
        source: 'manual',
        note: `Scheduled break corrected from ${s.break_scheduled_minutes}min to ${expected}min via break audit (actual break taken left as-is: ${s.break_taken}, ${s.break_taken_minutes}min)`,
      });
      updated++;
    }
  });
  doUpdate();
  res.json({ updated });
});

app.get('/api/shifts/:id', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Not found' });
  res.json(shift);
});

// Create shift
app.post('/api/shifts', (req, res) => {
  const {
    date, start_time, end_time,
    break_scheduled_minutes = 30,
    break_taken = 'full',
    break_taken_minutes,
    distance_miles,
    notes,
    is_bank_holiday = 0
  } = req.body;

  if (!date || !start_time || !end_time) {
    return res.status(400).json({ error: 'date, start_time, end_time required' });
  }

  const rateRecord = getPayRateForDate(date);
  const hourly_rate = rateRecord ? rateRecord.hourly_rate : null;
  const isBH = is_bank_holiday ? 1 : 0;

  const actualBreak = resolveBreakMinutes(break_taken, break_scheduled_minutes, break_taken_minutes);
  const hours_worked = calcHoursWorked(start_time, end_time, actualBreak);
  const hours_paid   = calcHoursWorked(start_time, end_time, break_scheduled_minutes);
  // Bank holiday = double pay; pay always based on hours_paid (scheduled break always deducted)
  const effectiveRate = hourly_rate ? hourly_rate * (isBH ? 2 : 1) : null;
  const calculated_pay = effectiveRate ? Math.round(hours_paid * effectiveRate * 100) / 100 : null;

  const defaultDist = db.prepare("SELECT value FROM settings WHERE key = 'default_distance_miles'").get();
  const dist = distance_miles !== undefined ? distance_miles : parseFloat(defaultDist?.value || 3.6);

  const result = db.prepare(`
    INSERT INTO shifts (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
      distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, notes, is_bank_holiday)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, start_time, end_time, break_scheduled_minutes, break_taken, actualBreak,
     dist, hourly_rate, hours_worked, hours_paid, calculated_pay, notes || null, isBH);

  const created = db.prepare('SELECT * FROM shifts WHERE id = ?').get(result.lastInsertRowid);
  logAudit({ shift_id: created.id, action: 'created', new_values: created, source: 'manual' });
  gcal.safeUpsert(created);
  res.status(201).json(created);
});

// Update shift
app.put('/api/shifts/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    date = existing.date,
    start_time = existing.start_time,
    end_time = existing.end_time,
    break_scheduled_minutes = existing.break_scheduled_minutes,
    break_taken = existing.break_taken,
    break_taken_minutes,
    distance_miles = existing.distance_miles,
    notes = existing.notes,
    completed = existing.completed,
    is_bank_holiday = existing.is_bank_holiday
  } = req.body;

  const isBH = is_bank_holiday ? 1 : 0;
  const rateRecord = getPayRateForDate(date);
  const hourly_rate = rateRecord ? rateRecord.hourly_rate : existing.hourly_rate;
  const actualBreak = resolveBreakMinutes(break_taken, break_scheduled_minutes, break_taken_minutes !== undefined ? break_taken_minutes : existing.break_taken_minutes);
  const hours_worked = calcHoursWorked(start_time, end_time, actualBreak);
  const hours_paid   = calcHoursWorked(start_time, end_time, break_scheduled_minutes);
  const effectiveRate = hourly_rate ? hourly_rate * (isBH ? 2 : 1) : null;
  const calculated_pay = effectiveRate ? Math.round(hours_paid * effectiveRate * 100) / 100 : null;

  db.prepare(`
    UPDATE shifts SET date=?, start_time=?, end_time=?, break_scheduled_minutes=?, break_taken=?,
      break_taken_minutes=?, distance_miles=?, hourly_rate=?, hours_worked=?, hours_paid=?, calculated_pay=?,
      notes=?, completed=?, is_bank_holiday=?, updated_at=datetime('now')
    WHERE id=?
  `).run(date, start_time, end_time, break_scheduled_minutes, break_taken, actualBreak,
     distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, notes, completed, isBH, req.params.id);

  const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);

  // Detect what changed and log it
  const changedFields = [];
  const oldVals = {}, newVals = {};
  for (const k of ['date','start_time','end_time','break_scheduled_minutes','notes','completed','is_bank_holiday']) {
    if (String(existing[k] ?? '') !== String(updated[k] ?? '')) {
      changedFields.push(k);
      oldVals[k] = existing[k];
      newVals[k] = updated[k];
    }
  }
  if (changedFields.length) {
    logAudit({ shift_id: updated.id, action: 'updated', changed_fields: changedFields, old_values: oldVals, new_values: newVals, source: 'manual' });
  }

  gcal.safeUpsert(updated);
  res.json(updated);
});

// Complete / uncomplete a shift
app.patch('/api/shifts/:id/complete', (req, res) => {
  const existing = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { completed, break_taken, break_taken_minutes } = req.body;

  const bt = break_taken !== undefined ? break_taken : existing.break_taken;
  const actualBreak = resolveBreakMinutes(bt, existing.break_scheduled_minutes,
    break_taken_minutes !== undefined ? break_taken_minutes : existing.break_taken_minutes);
  const hours_worked = calcHoursWorked(existing.start_time, existing.end_time, actualBreak);
  const hours_paid   = calcHoursWorked(existing.start_time, existing.end_time, existing.break_scheduled_minutes);
  const effectiveRate = existing.hourly_rate ? existing.hourly_rate * (existing.is_bank_holiday ? 2 : 1) : null;
  const calculated_pay = effectiveRate ? Math.round(hours_paid * effectiveRate * 100) / 100 : null;

  db.prepare(`
    UPDATE shifts SET completed=?, break_taken=?, break_taken_minutes=?,
      hours_worked=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
    WHERE id=?
  `).run(completed ? 1 : 0, bt, actualBreak, hours_worked, hours_paid, calculated_pay, req.params.id);

  const completedShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  logAudit({
    shift_id: completedShift.id,
    action: completed ? 'completed' : 'uncompleted',
    changed_fields: ['completed', 'break_taken', 'break_taken_minutes'],
    old_values: { completed: existing.completed, break_taken: existing.break_taken, break_taken_minutes: existing.break_taken_minutes },
    new_values: { completed: completed ? 1 : 0, break_taken: bt, break_taken_minutes: actualBreak },
    source: 'manual',
  });
  gcal.safeUpsert(completedShift);
  res.json(completedShift);
});

// Delete shift
app.delete('/api/shifts/:id', (req, res) => {
  const toDelete = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!toDelete) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  logAudit({ shift_id: toDelete.id, action: 'deleted', old_values: toDelete, source: 'manual' });
  gcal.safeDelete(toDelete);
  res.json({ success: true });
});

// Recalculate break_scheduled_minutes, hours_worked, hours_paid, calculated_pay for all shifts
app.post('/api/shifts/recalculate', async (req, res) => {
  try {
    const shifts = db.prepare('SELECT * FROM shifts').all();
    // Also catch up any shift that fell on a UK bank holiday but never got flagged
    // (e.g. shifts synced from Rotageek before that flag was set automatically) —
    // only ever adds the flag, never removes a manually-set one.
    const bankHolidays = await getUkBankHolidays();
    let updated = 0;
    let bankHolidaysFixed = 0;
    const doUpdate = db.transaction(() => {
      for (const s of shifts) {
        const break_scheduled = autoBreakMinutes(s.start_time, s.end_time);
        const actualBreak    = s.completed
          ? resolveBreakMinutes(s.break_taken, break_scheduled, s.break_taken_minutes)
          : break_scheduled;
        const hours_worked   = calcHoursWorked(s.start_time, s.end_time, actualBreak);
        const hours_paid     = calcHoursWorked(s.start_time, s.end_time, break_scheduled);
        const is_bank_holiday = s.is_bank_holiday || (bankHolidays.has(s.date) ? 1 : 0);
        if (is_bank_holiday && !s.is_bank_holiday) bankHolidaysFixed++;
        const effectiveRate  = s.hourly_rate ? s.hourly_rate * (is_bank_holiday ? 2 : 1) : null;
        const calculated_pay = effectiveRate ? Math.round(hours_paid * effectiveRate * 100) / 100 : null;
        db.prepare(`
          UPDATE shifts
          SET break_scheduled_minutes=?, break_taken_minutes=?,
              hours_worked=?, hours_paid=?, calculated_pay=?, is_bank_holiday=?, updated_at=datetime('now')
          WHERE id=?
        `).run(break_scheduled, actualBreak, hours_worked, hours_paid, calculated_pay, is_bank_holiday, s.id);
        updated++;
      }
    });
    doUpdate();
    res.json({ updated, bankHolidaysFixed });
  } catch (e) {
    console.error('Recalculate all shifts failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// PAYSLIPS
// ─────────────────────────────────────────

app.get('/api/payslips', (req, res) => {
  const { year } = req.query;
  let query = 'SELECT * FROM payslips';
  const params = [];
  if (year) {
    // month is stored as YYYY-MM so use substr rather than strftime (which needs YYYY-MM-DD)
    query += ' WHERE substr(month, 1, 4) = ?';
    params.push(String(year));
  }
  query += ' ORDER BY month DESC';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/payslips/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payslips WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.post('/api/payslips', (req, res) => {
  const {
    month, payment_date,
    basic_pay = 0, arrears_pay = 0,
    additional_hours_qty = 0, additional_hours_pay = 0,
    addt_hours_prev_qty = 0, addt_hours_prev_amount = 0,
    annual_leave_adj_curr = 0, annual_leave_adj_prev = 0,
    bank_hol_curr_qty = 0, bank_hol_curr_amount = 0,
    bank_hol_prev_qty = 0, bank_hol_prev_amount = 0,
    company_sick_pay = 0, company_sick_pay_is_prev = 0,
    sip_contribution = 0,
    other_payments = 0,
    total_gross = 0, total_deductions = 0, net_payment = 0,
    tax_paid = 0, ni_employee = 0, ni_employer = 0,
    sharesave_amount = 0, sharesave_description = null,
    other_pay_description = null,
    gross_ytd = 0, taxable_ytd = 0, tax_ytd = 0, ni_able_ytd = 0,
    notes
  } = req.body;

  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  try {
    const result = db.prepare(`
      INSERT INTO payslips (
        month, payment_date,
        basic_pay, arrears_pay,
        additional_hours_qty, additional_hours_pay,
        addt_hours_prev_qty, addt_hours_prev_amount,
        annual_leave_adj_curr, annual_leave_adj_prev,
        bank_hol_curr_qty, bank_hol_curr_amount,
        bank_hol_prev_qty, bank_hol_prev_amount,
        company_sick_pay, company_sick_pay_is_prev,
        sip_contribution, other_payments,
        total_gross, total_deductions, net_payment,
        tax_paid, ni_employee, ni_employer,
        sharesave_amount, sharesave_description,
        other_pay_description,
        gross_ytd, taxable_ytd, tax_ytd, ni_able_ytd, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      month, payment_date || null,
      basic_pay, arrears_pay,
      additional_hours_qty, additional_hours_pay,
      addt_hours_prev_qty, addt_hours_prev_amount,
      annual_leave_adj_curr, annual_leave_adj_prev,
      bank_hol_curr_qty, bank_hol_curr_amount,
      bank_hol_prev_qty, bank_hol_prev_amount,
      company_sick_pay, company_sick_pay_is_prev,
      sip_contribution, other_payments,
      total_gross, total_deductions, net_payment,
      tax_paid, ni_employee, ni_employer,
      sharesave_amount, sharesave_description || null,
      other_pay_description || null,
      gross_ytd, taxable_ytd, tax_ytd, ni_able_ytd, notes || null
    );

    res.status(201).json(db.prepare('SELECT * FROM payslips WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Payslip for this month already exists' });
    throw e;
  }
});

// Read a photo of a payslip with Gemini and return figures matching the payslip form
// fields exactly — no DB write. The frontend opens the Add/Edit Payslip modal
// pre-filled with this so you can review before saving, same pattern as the team
// schedule screenshot import.
const PAYSLIP_PROMPT = `You are reading a UK payslip (Screwfix format) from a photo. Extract the following figures exactly as printed — never estimate or guess a figure that isn't visible.

Return ONLY valid JSON, no markdown, no explanation, matching this exact shape (use 0 for any money/hours figure that isn't present on the payslip, use null for text fields that aren't present):

{
  "month": "YYYY-MM",
  "payment_date": "YYYY-MM-DD",
  "basic_pay": 0,
  "arrears_pay": 0,
  "additional_hours_qty": 0,
  "additional_hours_pay": 0,
  "addt_hours_prev_qty": 0,
  "addt_hours_prev_amount": 0,
  "annual_leave_adj_curr": 0,
  "annual_leave_adj_prev": 0,
  "bank_hol_curr_qty": 0,
  "bank_hol_curr_amount": 0,
  "bank_hol_prev_qty": 0,
  "bank_hol_prev_amount": 0,
  "company_sick_pay": 0,
  "company_sick_pay_is_prev": 0,
  "sip_contribution": 0,
  "other_payments": 0,
  "other_pay_description": null,
  "total_gross": 0,
  "total_deductions": 0,
  "net_payment": 0,
  "tax_paid": 0,
  "ni_employee": 0,
  "ni_employer": 0,
  "sharesave_amount": 0,
  "sharesave_description": null,
  "gross_ytd": 0,
  "taxable_ytd": 0,
  "tax_ytd": 0,
  "ni_able_ytd": 0
}

FIELD NOTES:
- "month" is the pay period the payslip covers (YYYY-MM), not the payment date.
- basic_pay / additional_hours_qty / additional_hours_pay / bank_hol_curr_* / annual_leave_adj_curr are for THIS pay period.
- arrears_pay / addt_hours_prev_* / annual_leave_adj_prev / bank_hol_prev_* are corrections for a PREVIOUS pay period shown on this payslip — payslips often show these as a separate line, sometimes negative.
- sip_contribution (Share Incentive Plan) and sharesave_amount are usually deductions — enter as negative if shown that way on the payslip.
- other_payments / other_pay_description is for any one-off line that doesn't fit the above (e.g. SSP, bonus).
- ni_employer is only present on some payslip formats — use 0 if not shown.

RULES:
1. Use exact figures as printed — never round, rephrase, or infer a number that isn't shown.
2. If a line item isn't present on the payslip at all, use 0 (numbers) or null (text) — do not guess.
3. Return ONLY the JSON — no surrounding text.`;

const payslipPhotoUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/payslips/import-photo', payslipPhotoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { parsed, rawText, modelUsed } = await callGeminiVision(req.file.buffer, req.file.mimetype || 'image/png', PAYSLIP_PROMPT);
    if (!parsed) {
      return res.status(502).json({ error: 'Gemini returned unexpected output — could not parse JSON', rawText: (rawText || '').slice(0, 3000) });
    }
    res.json({ data: parsed, model_used: modelUsed });
  } catch (err) {
    console.error('Payslip photo import error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/payslips/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM payslips WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = [
    'month', 'payment_date',
    'basic_pay', 'arrears_pay',
    'additional_hours_qty', 'additional_hours_pay',
    'addt_hours_prev_qty', 'addt_hours_prev_amount',
    'annual_leave_adj_curr', 'annual_leave_adj_prev',
    'bank_hol_curr_qty', 'bank_hol_curr_amount',
    'bank_hol_prev_qty', 'bank_hol_prev_amount',
    'company_sick_pay', 'company_sick_pay_is_prev',
    'sip_contribution', 'other_payments',
    'total_gross', 'total_deductions', 'net_payment',
    'tax_paid', 'ni_employee', 'ni_employer',
    'sharesave_amount', 'sharesave_description',
    'other_pay_description',
    'gross_ytd', 'taxable_ytd', 'tax_ytd', 'ni_able_ytd', 'notes',
  ];

  const values = fields.map(f => req.body[f] !== undefined ? req.body[f] : existing[f]);
  const sets = fields.map(f => `${f}=?`).join(', ');

  db.prepare(`UPDATE payslips SET ${sets}, updated_at=datetime('now') WHERE id=?`)
    .run(...values, req.params.id);

  res.json(db.prepare('SELECT * FROM payslips WHERE id = ?').get(req.params.id));
});

app.delete('/api/payslips/:id', (req, res) => {
  const result = db.prepare('DELETE FROM payslips WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─────────────────────────────────────────
// PAY RATES
// ─────────────────────────────────────────

app.get('/api/pay-rates', (req, res) => {
  res.json(db.prepare('SELECT * FROM pay_rates ORDER BY effective_date DESC').all());
});

app.post('/api/pay-rates', (req, res) => {
  const { effective_date, hourly_rate, contracted_hours_per_week, notes } = req.body;
  if (!effective_date || !hourly_rate || !contracted_hours_per_week) {
    return res.status(400).json({ error: 'effective_date, hourly_rate, contracted_hours_per_week required' });
  }
  const result = db.prepare(
    'INSERT INTO pay_rates (effective_date, hourly_rate, contracted_hours_per_week, notes) VALUES (?,?,?,?)'
  ).run(effective_date, hourly_rate, contracted_hours_per_week, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM pay_rates WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/pay-rates/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM pay_rates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { effective_date = existing.effective_date, hourly_rate = existing.hourly_rate,
    contracted_hours_per_week = existing.contracted_hours_per_week, notes = existing.notes } = req.body;
  db.prepare('UPDATE pay_rates SET effective_date=?, hourly_rate=?, contracted_hours_per_week=?, notes=? WHERE id=?')
    .run(effective_date, hourly_rate, contracted_hours_per_week, notes, req.params.id);
  res.json(db.prepare('SELECT * FROM pay_rates WHERE id = ?').get(req.params.id));
});

app.delete('/api/pay-rates/:id', (req, res) => {
  const result = db.prepare('DELETE FROM pay_rates WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  Object.entries(req.body).forEach(([key, value]) => upsert.run(key, String(value)));
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// -----------------------------------------
// Delivery Schedules
// -----------------------------------------

app.get('/api/delivery-schedules', (req, res) => {
  res.json(db.prepare('SELECT * FROM delivery_schedules ORDER BY effective_from ASC').all());
});

app.post('/api/delivery-schedules', (req, res) => {
  const { effective_from, days } = req.body;
  if (!effective_from || !days) return res.status(400).json({ error: 'effective_from and days required' });
  const info = db.prepare('INSERT INTO delivery_schedules (effective_from, days) VALUES (?,?)').run(effective_from, days);
  res.json({ id: info.lastInsertRowid, effective_from, days });
});

app.put('/api/delivery-schedules/:id', (req, res) => {
  const { effective_from, days } = req.body;
  if (!effective_from || !days) return res.status(400).json({ error: 'effective_from and days required' });
  db.prepare('UPDATE delivery_schedules SET effective_from=?, days=? WHERE id=?').run(effective_from, days, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/delivery-schedules/:id', (req, res) => {
  db.prepare('DELETE FROM delivery_schedules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/colleagues/next-shifts?from=YYYY-MM-DD&days=N
// Day-grouped roster for the dashboard "Next In" card:
//   days  — every colleague shift in the next N days, grouped by date (dashboard requests
//           days=2 — today + tomorrow only, per Ed: nothing further out on this card)
//   later — colleagues whose NEXT shift falls beyond that window (one row each). Kept in
//           the API response for other potential callers, but the dashboard card ignores
//           it entirely — Next In only ever shows today/tomorrow now.
//   none  — active colleagues with no upcoming shifts at all (same: unused by the dashboard)
app.get('/api/colleagues/next-shifts', (req, res) => {
  const from = req.query.from || localDateStr();
  const nDays = Math.min(Math.max(parseInt(req.query.days, 10) || 2, 1), 14);
  const toDate = new Date(from + 'T12:00:00');
  toDate.setDate(toDate.getDate() + nDays - 1);
  const to = toDate.toISOString().slice(0, 10);

  // All shifts inside the window, grouped client-side by date
  const windowRows = db.prepare(`
    SELECT cs.date, cs.start_time, cs.end_time, cs.shift_type, c.id, c.name
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date >= ? AND cs.date <= ?
      AND (c.left_date IS NULL OR c.left_date = '')
      AND (cs.store IS NULL OR cs.store = '')
    ORDER BY cs.date ASC, cs.start_time ASC, c.name ASC
  `).all(from, to);

  // Next shift per colleague *after* the window
  const laterRows = db.prepare(`
    SELECT c.id, c.name,
           MIN(cs.date) AS next_date,
           (SELECT cs2.start_time FROM colleague_shifts cs2
            WHERE cs2.colleague_id = c.id AND cs2.date > ?
            ORDER BY cs2.date ASC, cs2.start_time ASC LIMIT 1) AS next_start,
           (SELECT cs2.shift_type FROM colleague_shifts cs2
            WHERE cs2.colleague_id = c.id AND cs2.date > ?
            ORDER BY cs2.date ASC, cs2.start_time ASC LIMIT 1) AS next_shift_type
    FROM colleagues c
    JOIN colleague_shifts cs ON cs.colleague_id = c.id AND cs.date > ?
    WHERE (c.left_date IS NULL OR c.left_date = '')
      AND c.id NOT IN (
        SELECT DISTINCT colleague_id FROM colleague_shifts WHERE date >= ? AND date <= ?
      )
    GROUP BY c.id
    ORDER BY next_date ASC, c.name ASC
  `).all(to, to, to, from, to);

  // Active colleagues with nothing upcoming at all
  const noneRows = db.prepare(`
    SELECT c.id, c.name FROM colleagues c
    WHERE (c.left_date IS NULL OR c.left_date = '')
      AND NOT EXISTS (SELECT 1 FROM colleague_shifts cs WHERE cs.colleague_id = c.id AND cs.date >= ?)
    ORDER BY c.name ASC
  `).all(from);

  res.json({ from, to, days: windowRows, later: laterRows, none: noneRows });
});

// ─────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────

// GET /api/reports/summary?from=YYYY-MM&to=YYYY-MM
app.get('/api/reports/summary', (req, res) => {
  const { from, to } = req.query;

  let shiftWhere = '';
  const shiftParams = [];
  if (from) { shiftWhere += " AND strftime('%Y-%m', date) >= ?"; shiftParams.push(from); }
  if (to)   { shiftWhere += " AND strftime('%Y-%m', date) <= ?"; shiftParams.push(to); }

  const shiftStats = db.prepare(`
    SELECT
      COUNT(*) as total_shifts,
      SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as completed_shifts,
      SUM(CASE WHEN completed=1 THEN hours_worked ELSE 0 END) as total_hours,
      SUM(CASE WHEN completed=1 THEN calculated_pay ELSE 0 END) as total_calculated_pay,
      SUM(CASE WHEN completed=1 THEN distance_miles ELSE 0 END) as total_distance
    FROM shifts WHERE 1=1 ${shiftWhere}
  `).get(...shiftParams);

  let payslipWhere = '';
  const payslipParams = [];
  if (from) { payslipWhere += ' AND month >= ?'; payslipParams.push(from); }
  if (to)   { payslipWhere += ' AND month <= ?'; payslipParams.push(to); }

  const payslipStats = db.prepare(`
    SELECT
      SUM(total_gross) as total_gross_paid,
      SUM(net_payment) as total_net_paid,
      SUM(tax_paid) as total_tax,
      SUM(ni_employee) as total_ni
    FROM payslips WHERE 1=1 ${payslipWhere}
  `).get(...payslipParams);

  res.json({ shifts: shiftStats, payslips: payslipStats });
});

// Helper: count Mon-Fri working days in a YYYY-MM month
function workingDaysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= dim; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// Monthly breakdown — returns per-month rows with shift data + payslip data joined
app.get('/api/reports/monthly', (req, res) => {
  const { year } = req.query;
  const yearFilter = year || new Date().getFullYear().toString();

  const shiftRows = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      COUNT(*) as shift_count,
      SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN completed=1 THEN hours_worked ELSE 0 END) as hours_worked,
      SUM(hours_worked) as scheduled_hours,
      SUM(CASE WHEN completed=1 THEN calculated_pay ELSE 0 END) as calculated_pay,
      SUM(calculated_pay) as scheduled_pay,
      SUM(CASE WHEN completed=1 THEN distance_miles ELSE 0 END) as distance_miles,
      -- Break stats (completed shifts only)
      SUM(CASE WHEN completed=1 AND break_taken != 'none' THEN 1 ELSE 0 END) as breaks_taken_count,
      SUM(CASE WHEN completed=1 AND break_taken != 'none' THEN break_taken_minutes ELSE 0 END) as breaks_taken_minutes,
      SUM(CASE WHEN completed=1 AND break_taken = 'none' THEN 1 ELSE 0 END) as breaks_skipped_count,
      SUM(CASE WHEN completed=1 AND break_taken = 'none' THEN break_scheduled_minutes ELSE 0 END) as breaks_skipped_minutes
    FROM shifts
    WHERE strftime('%Y', date) = ?
    GROUP BY month
    ORDER BY month DESC
  `).all(yearFilter);

  const payslipRows = db.prepare(`
    SELECT * FROM payslips
    WHERE substr(month, 1, 4) = ?
    ORDER BY month DESC
  `).all(yearFilter);

  // Merge by month
  const payslipMap = {};
  payslipRows.forEach(p => { payslipMap[p.month] = p; });

  // Get pay rates for contracted hours lookup and leave pay calculation
  const allPayRates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();
  function getRateForMonth(monthStr) {
    const firstDay = monthStr + '-01';
    let rate = null;
    for (const r of allPayRates) {
      if (r.effective_date <= firstDay) rate = r;
    }
    return rate || null;
  }
  function getContractedForMonth(monthStr) {
    const rate = getRateForMonth(monthStr);
    if (!rate) return 0;
    return Math.round(rate.contracted_hours_per_week * workingDaysInMonth(monthStr) / 5 * 100) / 100;
  }

  // Leave hours per month, spread across the working days each entry actually
  // covers. Grouping by the entry's start month (which this used to do) put a
  // holiday running 30 Mar → 11 Apr entirely in March, leaving April looking
  // over 20 hours under contract. See leaveHours.js.
  const leaveMap = leaveHoursByMonth(`${yearFilter}-01-01`, `${yearFilter}-12-31`);

  const merged = shiftRows.map(s => {
    const rate = getRateForMonth(s.month);
    const leaveHours = leaveMap[s.month] || 0;
    const leavePay = rate ? Math.round(leaveHours * rate.hourly_rate * 100) / 100 : 0;
    const breakUnusedPay = rate
      ? Math.round((s.breaks_skipped_minutes || 0) / 60 * rate.hourly_rate * 100) / 100
      : 0;
    return {
      month: s.month,
      shift_count: s.shift_count,
      completed_count: s.completed_count,
      hours_worked: s.hours_worked || 0,
      scheduled_hours: s.scheduled_hours || 0,
      calculated_pay: s.calculated_pay || 0,
      scheduled_pay: s.scheduled_pay || 0,
      leave_hours: leaveHours,
      leave_pay: leavePay,
      distance_miles: s.distance_miles || 0,
      contracted_hours: getContractedForMonth(s.month),
      breaks_taken_count: s.breaks_taken_count || 0,
      breaks_taken_minutes: s.breaks_taken_minutes || 0,
      breaks_skipped_count: s.breaks_skipped_count || 0,
      breaks_skipped_minutes: s.breaks_skipped_minutes || 0,
      break_unused_pay: breakUnusedPay,
      payslip: payslipMap[s.month] || null
    };
  });

  // Add months that have a payslip but no shifts in our data
  payslipRows.forEach(p => {
    if (!merged.find(m => m.month === p.month)) {
      const rate = getRateForMonth(p.month);
      const leaveHours = leaveMap[p.month] || 0;
      const leavePay = rate ? Math.round(leaveHours * rate.hourly_rate * 100) / 100 : 0;
      merged.push({ month: p.month, shift_count: 0, completed_count: 0,
        hours_worked: 0, calculated_pay: 0, scheduled_pay: 0, scheduled_hours: 0, leave_hours: leaveHours, leave_pay: leavePay,
        distance_miles: 0, contracted_hours: getContractedForMonth(p.month), payslip: p });
    }
  });

  merged.sort((a, b) => b.month.localeCompare(a.month));
  res.json(merged);
});

// GET /api/streaks — Streaks & Badges: break-not-skipped, punctual clock-in, and
// on-contract-hours streaks. current = consecutive up to the most recent qualifying
// item; longest = best run ever. Kept as one endpoint since all three are cheap,
// read-only scans over data that's already indexed by date.
function _computeStreak(items, predicate) {
  let longest = 0, run = 0;
  for (const it of items) {
    if (predicate(it)) { run++; longest = Math.max(longest, run); }
    else { run = 0; }
  }
  return { current: run, longest };
}

app.get('/api/streaks', (req, res) => {
  // Break-not-skipped streak — completed shifts, in date order
  const doneShifts = db.prepare(
    "SELECT date, break_taken FROM shifts WHERE completed = 1 ORDER BY date ASC, start_time ASC"
  ).all();
  const breakStreak = _computeStreak(doneShifts, s => !!s.break_taken && s.break_taken !== 'none');

  // Punctual clock-in streak — clock-in at or before shift start (5 min grace)
  const clockRows = db.prepare(`
    SELECT ce.date, ce.clocked_in, MIN(s.start_time) as start_time
    FROM clock_entries ce
    JOIN shifts s ON s.date = ce.date
    WHERE ce.clocked_in IS NOT NULL
    GROUP BY ce.date
    ORDER BY ce.date ASC
  `).all();
  const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const GRACE_MINS = 5;
  const punctualStreak = _computeStreak(clockRows, r => toMins(r.clocked_in) <= toMins(r.start_time) + GRACE_MINS);

  // On-contract-hours streak — completed calendar months only (excludes the
  // current in-progress month, which hasn't had a chance to hit its hours yet)
  const monthRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(hours_worked) as scheduled_hours
    FROM shifts GROUP BY month ORDER BY month ASC
  `).all();
  const allPayRates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();
  const getContractedForMonth = (monthStr) => {
    let rate = null;
    for (const r of allPayRates) { if (r.effective_date <= monthStr + '-01') rate = r; }
    return rate ? Math.round(rate.contracted_hours_per_week * workingDaysInMonth(monthStr) / 5 * 100) / 100 : 0;
  };
  const currentMonth = localDateStr().slice(0, 7);
  const completedMonths = monthRows.filter(m => m.month < currentMonth && getContractedForMonth(m.month) > 0);
  const contractStreak = _computeStreak(completedMonths, m =>
    (m.scheduled_hours || 0) >= getContractedForMonth(m.month) - 1
  );

  res.json({ breakStreak, punctualStreak, contractStreak });
});

// GET /api/wrapped?year=YYYY — "Rota Wrapped": a year-end recap of fun facts,
// pulled together from data that already exists across shifts/payslips/colleague_shifts.
app.get('/api/wrapped', (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const from = `${year}-01-01`, to = `${year}-12-31`;

  const shifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?').all(from, to);
  const completed = shifts.filter(s => s.completed);

  const totalHours = Math.round(completed.reduce((s, x) => s + (x.hours_worked || 0), 0) * 10) / 10;
  const totalMiles = Math.round(completed.reduce((s, x) => s + (x.distance_miles || 0), 0) * 10) / 10;
  const totalShifts = completed.length;

  const payslips = db.prepare("SELECT * FROM payslips WHERE substr(month, 1, 4) = ?").all(year);
  const totalGross = Math.round(payslips.reduce((s, p) => s + (p.total_gross || 0), 0) * 100) / 100;
  const totalTax   = Math.round(payslips.reduce((s, p) => s + (p.tax_paid    || 0), 0) * 100) / 100;
  const totalNI    = Math.round(payslips.reduce((s, p) => s + (p.ni_employee || 0), 0) * 100) / 100;

  // Busiest month by hours worked
  const hoursByMonth = {};
  completed.forEach(s => { const m = s.date.slice(0, 7); hoursByMonth[m] = (hoursByMonth[m] || 0) + (s.hours_worked || 0); });
  const busiestEntry = Object.entries(hoursByMonth).sort((a, b) => b[1] - a[1])[0];
  const busiestMonth = busiestEntry ? { month: busiestEntry[0], hours: Math.round(busiestEntry[1] * 10) / 10 } : null;

  // Most-worked-with colleague — same overlap-minutes logic as the leaderboard,
  // scoped to this year and excluding other-store colleague shifts
  const overlapMins = (s1, e1, s2, e2) => {
    const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    return Math.max(0, Math.min(toMins(e1), toMins(e2)) - Math.max(toMins(s1), toMins(s2)));
  };
  const colShifts = db.prepare(
    "SELECT * FROM colleague_shifts WHERE date >= ? AND date <= ? AND shift_type = 'shift' AND (store IS NULL OR store = '')"
  ).all(from, to);
  const colleagues = db.prepare('SELECT id, name FROM colleagues').all();
  const nameById = {}; colleagues.forEach(c => { nameById[c.id] = c.name; });
  const withStats = {}; // colleague_id -> { shifts, minutes }
  for (const my of completed) {
    for (const cs of colShifts.filter(c => c.date === my.date)) {
      const mins = overlapMins(my.start_time, my.end_time, cs.start_time, cs.end_time);
      if (mins <= 0) continue;
      if (!withStats[cs.colleague_id]) withStats[cs.colleague_id] = { shifts: 0, minutes: 0 };
      withStats[cs.colleague_id].shifts++;
      withStats[cs.colleague_id].minutes += mins;
    }
  }
  const topColleague = Object.entries(withStats)
    .sort((a, b) => b[1].shifts - a[1].shifts)[0];
  const mostWorkedWith = topColleague
    ? { name: nameById[topColleague[0]] || 'Unknown', shifts: topColleague[1].shifts, hours: Math.round(topColleague[1].minutes / 60 * 10) / 10 }
    : null;

  res.json({
    year, totalHours, totalMiles, totalShifts,
    totalGross, totalTax, totalNI,
    busiestMonth, mostWorkedWith,
  });
});

// Yearly summary — GET /api/reports/yearly
app.get('/api/reports/yearly', (req, res) => {
  const shiftRows = db.prepare(`
    SELECT
      strftime('%Y', date) as year,
      COUNT(*) as shift_count,
      SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN completed=1 THEN hours_worked ELSE 0 END) as hours_worked,
      SUM(CASE WHEN completed=1 THEN calculated_pay ELSE 0 END) as calculated_pay,
      SUM(CASE WHEN completed=1 THEN distance_miles ELSE 0 END) as distance_miles
    FROM shifts
    GROUP BY year
    ORDER BY year DESC
  `).all();

  const payslipRows = db.prepare(`
    SELECT
      substr(month, 1, 4) as year,
      SUM(total_gross) as total_gross,
      SUM(net_payment) as net_payment,
      SUM(tax_paid) as tax_paid,
      SUM(ni_employee) as ni_employee
    FROM payslips
    GROUP BY year
    ORDER BY year DESC
  `).all();

  const payMap = {};
  payslipRows.forEach(p => { payMap[p.year] = p; });

  const years = new Set([...shiftRows.map(r => r.year), ...payslipRows.map(r => r.year)]);
  const result = [...years].sort((a, b) => b.localeCompare(a)).map(year => {
    const s = shiftRows.find(r => r.year === year) || {};
    const p = payMap[year] || {};
    return {
      year,
      shift_count:     s.shift_count    || 0,
      completed_count: s.completed_count || 0,
      hours_worked:    s.hours_worked    || 0,
      calculated_pay:  s.calculated_pay  || 0,
      distance_miles:  s.distance_miles  || 0,
      total_gross:     p.total_gross     || 0,
      net_payment:     p.net_payment     || 0,
      tax_paid:        p.tax_paid        || 0,
      ni_employee:     p.ni_employee     || 0,
    };
  });

  res.json(result);
});

// ─────────────────────────────────────────
// REPORTS — WEEKLY (contracted hours)
// ─────────────────────────────────────────

// GET /api/reports/weekly?year=YYYY
app.get('/api/reports/weekly', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();

  // Fetch shifts in an extended range to capture cross-year weeks (e.g. 29 Dec – 4 Jan)
  const yearInt   = parseInt(year);
  const fetchFrom = `${yearInt - 1}-12-25`;
  const fetchTo   = `${yearInt + 1}-01-07`;
  const shifts = db.prepare(`
    SELECT date, hours_paid, hours_worked, break_scheduled_minutes, start_time, end_time FROM shifts
    WHERE completed = 1 AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(fetchFrom, fetchTo);

  // Use hours_paid (scheduled break always deducted) for consistency with Shifts tab
  function calcHours(shift) {
    if (shift.hours_paid != null) return shift.hours_paid;
    if (shift.hours_worked != null) return shift.hours_worked;
    const [sh, sm] = shift.start_time.split(':').map(Number);
    const [eh, em] = shift.end_time.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm) - (shift.break_scheduled_minutes || 0);
    return Math.max(0, mins) / 60;
  }

  // Fetch all pay rates for contracted-hours lookup
  const payRates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();

  function getContractedHours(dateStr) {
    let rate = null;
    for (const r of payRates) {
      if (r.effective_date <= dateStr) rate = r;
    }
    return rate ? rate.contracted_hours_per_week : 0;
  }

  // Group by ISO week (Mon–Sun). Week key = date of Monday for that week.
  function getMondayKey(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = (dt.getDay() + 6) % 7; // 0=Mon
    dt.setDate(dt.getDate() - dow);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  }

  const weekMap = {};
  for (const shift of shifts) {
    const key = getMondayKey(shift.date);
    if (!weekMap[key]) {
      weekMap[key] = { weekStart: key, hours_worked: 0, contracted_hours: getContractedHours(shift.date), shift_count: 0 };
    }
    weekMap[key].hours_worked += calcHours(shift);
    weekMap[key].shift_count++;
  }

  // Also include leave hours so leave weeks don't look under-contracted.
  // Spreading lives in leaveHours.js so this, the monthly report and V3
  // Overtime can't drift apart again.
  for (const [week, hours] of Object.entries(
    leaveHoursByWeek(`${year}-01-01`, `${year}-12-31`, getMondayKey)
  )) {
    if (!weekMap[week]) {
      weekMap[week] = { weekStart: week, hours_worked: 0, contracted_hours: getContractedHours(week), shift_count: 0 };
    }
    weekMap[week].hours_worked += hours;
  }

  // Only include weeks whose Monday falls within the requested year
  const weeks = Object.values(weekMap)
    .filter(w => w.weekStart.startsWith(year))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  res.json(weeks);
});

// ─────────────────────────────────────────
// REPORTS — INSIGHTS
// ─────────────────────────────────────────

// GET /api/reports/insights?year=YYYY[&colleague_id=N]
// GET /api/reports/insights?from=YYYY-MM-DD&to=YYYY-MM-DD[&colleague_id=N]  — custom range
// GET /api/insights/heatmap — per-day worked hours / leave for a year, for the
// GitHub-contributions-style Shift Heatmap view. Split shifts on the same date have
// their hours summed into one cell.
app.get('/api/insights/heatmap', (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const from = `${year}-01-01`, to = `${year}-12-31`;

  const shifts = db.prepare(
    'SELECT date, hours_paid, hours_worked, completed, is_bank_holiday FROM shifts WHERE date >= ? AND date <= ?'
  ).all(from, to);
  const leaves = db.prepare(
    'SELECT start_date, end_date, leave_type FROM leave_entries WHERE end_date >= ? AND start_date <= ?'
  ).all(from, to);

  const days = {};
  for (const s of shifts) {
    const hours = s.hours_paid != null ? s.hours_paid : (s.hours_worked || 0);
    const existing = days[s.date];
    days[s.date] = {
      type: 'worked',
      hours: Math.round(((existing?.hours || 0) + (hours || 0)) * 100) / 100,
      completed: existing ? (existing.completed && !!s.completed) : !!s.completed,
      is_bank_holiday: !!(existing?.is_bank_holiday || s.is_bank_holiday),
    };
  }
  for (const le of leaves) {
    const cur = new Date(le.start_date + 'T00:00:00');
    const end = new Date(le.end_date + 'T00:00:00');
    while (cur <= end) {
      const d = localDateStr(cur);
      if (d >= from && d <= to && !days[d]) {
        days[d] = { type: 'leave', hours: 0, leave_type: le.leave_type };
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  res.json({ year, days });
});

app.get('/api/reports/insights', (req, res) => {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const customFrom = DATE_RE.test(req.query.from || '') ? req.query.from : null;
  const customTo   = DATE_RE.test(req.query.to   || '') ? req.query.to   : null;
  const isCustomRange = !!(customFrom && customTo);

  const year        = req.query.year || new Date().getFullYear().toString();
  const allTime     = !isCustomRange && year === 'all';
  const colleagueId = req.query.colleague_id ? parseInt(req.query.colleague_id, 10) : null;
  const forColleague = !!colleagueId;

  // Date bounds for this report — either a calendar year, "all time", or an explicit
  // custom range. Every year-filtered query below is built from these two bounds
  // rather than a literal calendar year, so a custom range flows through uniformly.
  const rangeFrom = isCustomRange ? customFrom : (allTime ? '2000-01-01' : `${year}-01-01`);
  const rangeTo   = isCustomRange ? customTo   : (allTime ? '2099-12-31' : `${year}-12-31`);

  // Helper: date-range WHERE clause
  const yWhere  = `AND date >= '${rangeFrom}' AND date <= '${rangeTo}'`;
  const yWhereS = `AND s.date >= '${rangeFrom}' AND s.date <= '${rangeTo}'`;
  const yWhereCs1 = `AND cs1.date >= '${rangeFrom}' AND cs1.date <= '${rangeTo}'`;

  // Delivery days — use delivery_schedules table (newest first) for per-date accuracy;
  // fall back to legacy delivery_days setting if no schedules exist
  const delivSchedules = db.prepare(`SELECT effective_from, days FROM delivery_schedules ORDER BY effective_from DESC`).all();
  let delivDayList, delivDayExpr, DELIVERY_CASE;
  if (delivSchedules.length) {
    // Build a SQL CASE expression: for each shift date, pick the applicable schedule
    const cases = delivSchedules.map(s => {
      const daysList = s.days.split(',').map(d => `'${d.trim()}'`).join(',');
      return `WHEN date >= '${s.effective_from}' AND strftime('%w', date) IN (${daysList}) THEN 1`;
    }).join('\n         ');
    DELIVERY_CASE = `(CASE ${cases} ELSE 0 END)`;
    // For the response delivDayList, use the most-recent schedule
    delivDayList = delivSchedules[0].days.split(',').map(d => d.trim()).filter(Boolean);
    delivDayExpr = delivDayList.map(d => `'${d}'`).join(',');
  } else {
    // Legacy: single setting
    const deliveryDaysSetting = db.prepare(`SELECT value FROM settings WHERE key='delivery_days'`).get();
    const deliveryDays = deliveryDaysSetting ? deliveryDaysSetting.value : '3,4,5';
    delivDayList = deliveryDays.split(',').map(d => d.trim()).filter(Boolean);
    delivDayExpr = delivDayList.map(d => `'${d}'`).join(',');
    DELIVERY_CASE = null;
  }

  // Top 10 most common shift times — grouped by EXACT (start_time, end_time) pair,
  // excluding leave/all-day (00:00) entries. Because retail shifts often finish a few
  // minutes early/late or get extended, many shifts that "feel" the same don't share an
  // identical end_time, so counts here can look lower than expected — that's real
  // variation in the data, not a bug (verified against the raw DB 2026-07-11).
  const topShiftTimes = forColleague
    ? db.prepare(`
        SELECT start_time, end_time, COUNT(*) as count
        FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere}
          AND shift_type = 'shift'
          AND start_time IS NOT NULL AND start_time != '' AND start_time != '00:00'
        GROUP BY start_time, end_time ORDER BY count DESC LIMIT 10
      `).all()
    : db.prepare(`
        SELECT start_time, end_time, COUNT(*) as count
        FROM shifts
        WHERE completed = 1 ${yWhere}
          AND start_time IS NOT NULL AND start_time != '' AND start_time != '00:00'
        GROUP BY start_time, end_time ORDER BY count DESC LIMIT 10
      `).all();

  // Most common pairings — exclude any entry that is leave/all_day.
  // Guard both on shift_type AND on start_time != '00:00', because some leave entries
  // are imported with shift_type='shift' but 00:00-00:00 times.
  const topPairings = forColleague
    ? db.prepare(`
        SELECT c.name, COUNT(*) as count
        FROM colleague_shifts cs1
        JOIN colleague_shifts cs2 ON cs2.date = cs1.date
          AND cs2.colleague_id != cs1.colleague_id
          AND cs2.shift_type = 'shift'
          AND cs2.start_time IS NOT NULL AND cs2.start_time != '' AND cs2.start_time != '00:00'
        JOIN colleagues c ON c.id = cs2.colleague_id
        WHERE cs1.colleague_id = ${colleagueId}
          AND cs1.shift_type = 'shift'
          AND cs1.start_time IS NOT NULL AND cs1.start_time != '' AND cs1.start_time != '00:00'
          ${yWhereCs1}
        GROUP BY c.id, c.name ORDER BY count DESC
      `).all()
    : db.prepare(`
        SELECT c.name, COUNT(*) as count
        FROM shifts s
        JOIN colleague_shifts cs ON cs.date = s.date
          AND cs.shift_type = 'shift'
          AND cs.start_time IS NOT NULL AND cs.start_time != '' AND cs.start_time != '00:00'
        JOIN colleagues c ON c.id = cs.colleague_id
        WHERE s.completed = 1 ${yWhereS}
        GROUP BY c.id, c.name ORDER BY count DESC
      `).all();

  const WEEK_START_EXPR = `CASE strftime('%w', date)
    WHEN '0' THEN date(date, '-6 days') WHEN '1' THEN date(date, '+0 days')
    WHEN '2' THEN date(date, '-1 day')  WHEN '3' THEN date(date, '-2 days')
    WHEN '4' THEN date(date, '-3 days') WHEN '5' THEN date(date, '-4 days')
    WHEN '6' THEN date(date, '-5 days') END`;

  // Late = ends 19:00+ (or 20:15+ pre Feb 2026)
  const EARLY_LATE_SELECT = `
    SUM(CASE WHEN start_time = '06:45' THEN 1 ELSE 0 END) as early_count,
    SUM(CASE WHEN (date >= '2026-02-01' AND end_time >= '19:00') OR
                  (date < '2026-02-01' AND end_time >= '20:15') THEN 1 ELSE 0 END) as late_count,
    COUNT(*) as total`;

  // Delivery shift = early start (05:30–08:00, covers ~6:30 arrivals) on a delivery day
  const DELIVERY_SHIFT_EXPR = delivDayList.length
    ? DELIVERY_CASE
      ? `SUM(CASE WHEN ${DELIVERY_CASE} = 1 AND start_time >= '05:30' AND start_time <= '08:00' THEN 1 ELSE 0 END) as delivery_count`
      : `SUM(CASE WHEN strftime('%w', date) IN (${delivDayExpr}) AND start_time >= '05:30' AND start_time <= '08:00' THEN 1 ELSE 0 END) as delivery_count`
    : `0 as delivery_count`;

  const weeklyEarlyLate = forColleague
    ? db.prepare(`SELECT ${WEEK_START_EXPR} as week_start, ${EARLY_LATE_SELECT}, ${DELIVERY_SHIFT_EXPR}
        FROM colleague_shifts WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'
        GROUP BY week_start ORDER BY week_start ASC`).all()
    : db.prepare(`SELECT ${WEEK_START_EXPR} as week_start, ${EARLY_LATE_SELECT}, ${DELIVERY_SHIFT_EXPR}
        FROM shifts WHERE completed = 1 ${yWhere}
        GROUP BY week_start ORDER BY week_start ASC`).all();

  const WKND_SELECT = `strftime('%Y-%m', date) as month,
    SUM(CASE WHEN strftime('%w', date) = '6' THEN 1 ELSE 0 END) as saturday_count,
    SUM(CASE WHEN strftime('%w', date) = '0' THEN 1 ELSE 0 END) as sunday_count`;

  const monthlyWeekends = forColleague
    ? db.prepare(`SELECT ${WKND_SELECT} FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'
        GROUP BY month ORDER BY month ASC`).all()
    : db.prepare(`SELECT ${WKND_SELECT} FROM shifts
        WHERE completed = 1 ${yWhere}
        GROUP BY month ORDER BY month ASC`).all();

  const DISTINCT_WKND = `SELECT COUNT(DISTINCT CASE strftime('%w', date)
    WHEN '6' THEN date(date, '+2 days') WHEN '0' THEN date(date, '+1 day') END) as value`;

  const distinctWeekends = forColleague
    ? db.prepare(`${DISTINCT_WKND} FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'
          AND strftime('%w', date) IN ('0','6')`).get()
    : db.prepare(`${DISTINCT_WKND} FROM shifts
        WHERE completed = 1 ${yWhere} AND strftime('%w', date) IN ('0','6')`).get();

  const dayOfWeek = forColleague
    ? db.prepare(`SELECT strftime('%w', date) as dow, COUNT(*) as count
        FROM colleague_shifts WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'
        GROUP BY dow ORDER BY dow ASC`).all()
    : db.prepare(`SELECT strftime('%w', date) as dow, COUNT(*) as count
        FROM shifts WHERE completed = 1 ${yWhere}
        GROUP BY dow ORDER BY dow ASC`).all();

  // Shift duration — calculate from start/end for colleague_shifts (no hours_worked column)
  const shiftDuration = forColleague
    ? db.prepare(`SELECT
        AVG((strftime('%H', end_time)*60 + strftime('%M', end_time) -
             strftime('%H', start_time)*60 - strftime('%M', start_time) - 30.0) / 60.0) as avg_hours,
        MAX((strftime('%H', end_time)*60 + strftime('%M', end_time) -
             strftime('%H', start_time)*60 - strftime('%M', start_time) - 30.0) / 60.0) as max_hours,
        MIN((strftime('%H', end_time)*60 + strftime('%M', end_time) -
             strftime('%H', start_time)*60 - strftime('%M', start_time) - 30.0) / 60.0) as min_hours
        FROM colleague_shifts WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'`).get()
    : db.prepare(`SELECT AVG(hours_worked) as avg_hours, MAX(hours_worked) as max_hours,
        MIN(hours_worked) as min_hours, start_time as shortest_start, end_time as shortest_end,
        MAX(hours_worked) as longest_hours
        FROM shifts WHERE completed = 1 ${yWhere} AND hours_worked IS NOT NULL`).get();

  // Longest and shortest shift details (for "me" only) — ordered by gross duration
  const GROSS_MINS = `(strftime('%H', end_time)*60 + strftime('%M', end_time) - strftime('%H', start_time)*60 - strftime('%M', start_time))`;
  const longestShift = forColleague ? null : db.prepare(`
    SELECT date, start_time, end_time, hours_worked,
      ROUND(${GROSS_MINS} / 60.0, 2) as gross_hours
    FROM shifts WHERE completed = 1 ${yWhere} AND hours_worked IS NOT NULL
    ORDER BY ${GROSS_MINS} DESC LIMIT 1`).get();
  const shortestShift = forColleague ? null : db.prepare(`
    SELECT date, start_time, end_time, hours_worked,
      ROUND(${GROSS_MINS} / 60.0, 2) as gross_hours
    FROM shifts WHERE completed = 1 ${yWhere} AND hours_worked IS NOT NULL AND hours_worked > 0
    ORDER BY ${GROSS_MINS} ASC LIMIT 1`).get();

  // Best week — earnings only available for "me"
  const bestWeek = forColleague ? null : db.prepare(`
    SELECT ${WEEK_START_EXPR} as week_start,
      SUM(calculated_pay) as total_pay, COUNT(*) as shift_count, SUM(hours_worked) as hours
    FROM shifts WHERE completed = 1 ${yWhere} AND calculated_pay IS NOT NULL
    GROUP BY week_start ORDER BY total_pay DESC LIMIT 1`).get();

  // Worked dates (for streaks etc.) — excluding leave days
  const workedDates = forColleague
    ? db.prepare(`SELECT DISTINCT date FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift' ORDER BY date ASC`).all().map(r => r.date)
    : db.prepare(`SELECT DISTINCT date FROM shifts
        WHERE completed = 1 ${yWhere} ORDER BY date ASC`).all().map(r => r.date);

  // Leave dates this period (for streak / "longest time off" gap exclusion).
  // "Me" tracks leave via leave_entries; colleagues get theirs from colleague_shifts rows
  // imported as shift_type='leave' (e.g. from a Team-view screenshot showing "Annual Leave").
  // Without this, a colleague's booked holiday shows up as a huge, misleading gap in
  // "longest time off" since there'd be nothing to tell it apart from a genuine absence.
  // Include 'all_day' entries alongside 'leave' — these cover sickness, TOIL,
  // training, and other rota-labelled absences that aren't literally "Annual Leave"
  // but are still explicit, tracked reasons the colleague wasn't rostered. Without
  // this, e.g. a week of sick days imported as all_day showed up as a huge,
  // misleading "longest time off" gap for that colleague.
  const leaveDates = forColleague
    ? db.prepare(`SELECT DISTINCT date FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type IN ('leave','all_day') ORDER BY date ASC`)
        .all().map(r => r.date)
    : (() => {
    const yearStart = rangeFrom;
    const yearEnd   = rangeTo;
    // All leave types (annual, sick, unpaid, day_off, other) count as an explicit,
    // tracked absence — not filtering to 'annual' only was inflating "longest time off"
    // for anyone who'd taken sick/unpaid/other leave, since those days were treated as
    // a genuine gap instead of excluded leave.
    const leaves = db.prepare(`SELECT start_date, end_date FROM leave_entries
      WHERE end_date >= ? AND start_date <= ?`)
      .all(yearStart, yearEnd);
    const dates = new Set();
    for (const le of leaves) {
      const cur = new Date(le.start_date + 'T00:00:00');
      const end = new Date(le.end_date   + 'T00:00:00');
      while (cur <= end) {
        dates.add(localDateStr(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }
    return [...dates].sort();
  })();

  // Annual leave days taken — use hours_taken / hours_per_day for accuracy
  const annualLeaveDays = forColleague ? 0 : (() => {
    const yearStart = rangeFrom;
    const yearEnd   = rangeTo;
    const hpdRow = db.prepare(`SELECT value FROM settings WHERE key='hours_per_day'`).get();
    const hpd = parseFloat(hpdRow?.value || '7.4');
    const r = db.prepare(`SELECT SUM(hours_taken) as total_hours, SUM(days_taken) as total_days
      FROM leave_entries WHERE leave_type = 'annual' AND start_date >= ? AND end_date <= ?`)
      .get(yearStart, yearEnd);
    if (!r) return 0;
    // Prefer hours_taken (accurate); fall back to days_taken for legacy rows
    if (r.total_hours != null) return Math.round((r.total_hours / hpd) * 10) / 10;
    return r.total_days ?? 0;
  })();

  // Days worked out of possible per day-of-week (me only, current year up to today)
  const dowStats = forColleague ? null : (() => {
    const today = localDateStr();
    const periodStart = allTime
      ? (workedDates.length ? workedDates[0] : today)
      : rangeFrom;
    const periodEnd = rangeTo < today ? rangeTo : today;
    if (periodStart > periodEnd) return null;

    // Count how many of each DOW occurred in the period
    const stats = {};
    const cur = new Date(periodStart + 'T00:00:00');
    const end = new Date(periodEnd   + 'T00:00:00');
    while (cur <= end) {
      const dow = cur.getDay(); // 0=Sun
      if (!stats[dow]) stats[dow] = { total: 0, worked: 0, leave: 0 };
      stats[dow].total++;
      cur.setDate(cur.getDate() + 1);
    }
    // Worked counts. Total = every calendar occurrence of that weekday since periodStart
    // (matches "Worked / Total" as originally designed). Leave takes precedence over worked
    // for a given date — if a day is flagged as annual leave it should never ALSO be counted
    // as worked, even if a shift row on that date was (incorrectly) left marked complete —
    // otherwise worked+leave can exceed total and produce impossible >100%/negative figures.
    const workedSet = new Set(workedDates);
    const leaveSet  = new Set(leaveDates);
    const allDates  = [];
    const cur2 = new Date(periodStart + 'T00:00:00');
    while (cur2 <= end) {
      allDates.push(localDateStr(cur2));
      cur2.setDate(cur2.getDate() + 1);
    }
    for (const d of allDates) {
      const dow = new Date(d + 'T00:00:00').getDay();
      if (!stats[dow]) stats[dow] = { total: 0, worked: 0, leave: 0 };
      const onLeave = leaveSet.has(d);
      if (onLeave) stats[dow].leave++;
      else if (workedSet.has(d)) stats[dow].worked++;
    }
    return stats;
  })();

  const totalShifts = forColleague
    ? db.prepare(`SELECT COUNT(*) as value FROM colleague_shifts
        WHERE colleague_id = ${colleagueId} ${yWhere} AND shift_type = 'shift'`).get()
    : db.prepare(`SELECT COUNT(*) as value FROM shifts
        WHERE completed = 1 ${yWhere}`).get();

  // Shared helper: get Monday key for a date string
  function getMonKey(dateStr) {
    const [y2, m2, d2] = dateStr.split('-').map(Number);
    const dt = new Date(y2, m2 - 1, d2);
    const dow = (dt.getDay() + 6) % 7; // 0=Mon
    dt.setDate(dt.getDate() - dow);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  }

  // Weekly hours vs contracted — "me" and colleagues
  const weeklyHours = (() => {
    if (forColleague) {
      // Colleague: hours from start/end times (no hours_worked column on colleague_shifts)
      const colleague = db.prepare('SELECT contract_hours, pay_type FROM colleagues WHERE id = ?').get(colleagueId);
      // Salaried staff (managers etc.) don't accrue overtime against a weekly hours
      // target the way hourly staff do — a leftover contract_hours value (e.g. from
      // before they were switched to salaried) shouldn't produce an overtime figure.
      const contractedHours = (colleague && colleague.contract_hours && colleague.pay_type !== 'salaried')
        ? colleague.contract_hours : null;

      const rows = db.prepare(`
        SELECT date, start_time, end_time FROM colleague_shifts
        WHERE colleague_id = ${colleagueId}
          AND shift_type = 'shift'
          AND start_time IS NOT NULL AND start_time != '' AND start_time != '00:00'
          ${yWhere}
        ORDER BY date ASC
      `).all();

      const wMap = {};
      for (const s of rows) {
        const key = getMonKey(s.date);
        if (!wMap[key]) wMap[key] = { weekStart: key, hours_worked: 0, contracted_hours: contractedHours };
        const [sh, sm] = s.start_time.split(':').map(Number);
        const [eh, em] = s.end_time.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 24 * 60;
        wMap[key].hours_worked += Math.max(0, mins) / 60;
      }
      return Object.values(wMap)
        .map(w => ({
          ...w,
          hours_worked: parseFloat(w.hours_worked.toFixed(2)),
          overtime: w.contracted_hours != null
            ? parseFloat((w.hours_worked - w.contracted_hours).toFixed(2))
            : null
        }))
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    } else {
      // Me: hours from shifts table, contracted from pay_rates (rate can change over time)
      const payRates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();
      function getRateForDate(dateStr) {
        let rate = null;
        for (const r of payRates) { if (r.effective_date <= dateStr) rate = r; }
        return rate;
      }
      function hoursFromShift(s) {
        if (s.hours_paid != null) return s.hours_paid;
        if (s.hours_worked != null) return s.hours_worked;
        const [sh, sm] = s.start_time.split(':').map(Number);
        const [eh, em] = s.end_time.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 24 * 60;
        return Math.max(0, mins - (s.break_scheduled_minutes || 0)) / 60;
      }

      // Fetch a week's buffer either side of the range so weeks straddling the boundary
      // (e.g. a week starting a few days before rangeFrom that still overlaps it) aren't cut off
      const wkFetchFrom = allTime ? '2000-01-01' : localDateStr(new Date(new Date(rangeFrom + 'T00:00:00').getTime() - 7 * 86400000));
      const wkFetchTo   = allTime ? '2099-12-31' : localDateStr(new Date(new Date(rangeTo   + 'T00:00:00').getTime() + 7 * 86400000));
      const shiftsForWeek = db.prepare(`
        SELECT date, hours_paid, hours_worked, break_scheduled_minutes, start_time, end_time FROM shifts
        WHERE completed = 1 AND date >= ? AND date <= ?
        ORDER BY date ASC
      `).all(wkFetchFrom, wkFetchTo);

      const wMap = {};
      for (const s of shiftsForWeek) {
        const key = getMonKey(s.date);
        if (!wMap[key]) {
          const rate = getRateForDate(s.date);
          wMap[key] = {
            weekStart: key,
            hours_worked: 0,
            contracted_hours: rate ? rate.contracted_hours_per_week : 0,
            hourly_rate: rate ? rate.hourly_rate : 0
          };
        }
        wMap[key].hours_worked += hoursFromShift(s);
      }

      // Also include annual leave hours so leave weeks don't appear under-contracted
      {
        const hpdRow = db.prepare(`SELECT value FROM settings WHERE key='hours_per_day'`).get();
        const hpd = parseFloat(hpdRow?.value || '7.4');
        const yearStart = rangeFrom;
        const yearEnd   = rangeTo;
        const leaveEntries = db.prepare(
          `SELECT start_date, end_date, hours_taken, days_taken FROM leave_entries
           WHERE start_date <= ? AND end_date >= ?`
        ).all(yearEnd, yearStart);

        for (const entry of leaveEntries) {
          const fullStart = new Date(entry.start_date + 'T00:00:00');
          const fullEnd   = new Date(entry.end_date   + 'T00:00:00');
          let workingDays = 0;
          const counter = new Date(fullStart);
          while (counter <= fullEnd) {
            const dow = counter.getDay();
            if (dow >= 1 && dow <= 5) workingDays++;
            counter.setDate(counter.getDate() + 1);
          }
          if (workingDays === 0) continue;
          const totalHours = entry.hours_taken != null ? entry.hours_taken : (entry.days_taken * hpd);
          const hoursPerDay = totalHours / workingDays;

          const clampedStart = new Date(Math.max(fullStart, new Date(yearStart + 'T00:00:00')));
          const clampedEnd   = new Date(Math.min(fullEnd,   new Date(yearEnd   + 'T00:00:00')));
          const cur = new Date(clampedStart);
          while (cur <= clampedEnd) {
            const dow = cur.getDay();
            if (dow >= 1 && dow <= 5) {
              const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
              const key = getMonKey(dateStr);
              if (!wMap[key]) {
                const rate = getRateForDate(dateStr);
                wMap[key] = {
                  weekStart: key,
                  hours_worked: 0,
                  contracted_hours: rate ? rate.contracted_hours_per_week : 0,
                  hourly_rate: rate ? rate.hourly_rate : 0
                };
              }
              wMap[key].hours_worked += hoursPerDay;
            }
            cur.setDate(cur.getDate() + 1);
          }
        }
      }

      return Object.values(wMap)
        .filter(w => allTime || (w.weekStart >= rangeFrom && w.weekStart <= rangeTo))
        .map(w => ({
          ...w,
          hours_worked: parseFloat(w.hours_worked.toFixed(2)),
          overtime: parseFloat((w.hours_worked - w.contracted_hours).toFixed(2))
        }))
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    }
  })();

  res.json({
    topShiftTimes, topPairings, weeklyEarlyLate, monthlyWeekends,
    distinctWeekends: distinctWeekends?.value ?? 0,
    dayOfWeek, shiftDuration, bestWeek, workedDates, leaveDates,
    totalShifts: totalShifts?.value ?? 0, forColleague,
    longestShift, shortestShift, annualLeaveDays, dowStats,
    deliveryDays: delivDayList,
    deliverySchedules: delivSchedules,
    weeklyHours,
    isCustomRange, rangeFrom, rangeTo,
  });
});

// GET /api/reports/bank-hol-stats?dates=YYYY-MM-DD,YYYY-MM-DD,...&year=YYYY
// Compare how many bank holidays Ed and each colleague worked
app.get('/api/reports/bank-hol-stats', (req, res) => {
  const dates = (req.query.dates || '').split(',').map(d => d.trim()).filter(Boolean);
  if (!dates.length) return res.json({ myCount: 0, total: 0, colleagues: [] });

  // NOTE: the caller (insights.js) already filters `dates` down to the selected year
  // before calling this endpoint, so no separate year filter is needed server-side.

  // Ed's bank holiday shifts, in one batched query instead of one per date
  const datePlaceholders = dates.map(() => '?').join(',');
  const myRows = db.prepare(
    `SELECT hours_worked FROM shifts WHERE completed = 1 AND date IN (${datePlaceholders})`
  ).all(...dates);
  const myCount = myRows.length;
  const myHoursWorked = myRows.reduce((sum, r) => sum + (r.hours_worked || 0), 0);

  // Per-colleague count, in one grouped query instead of one per (colleague, date) pair
  const allColleagues = db.prepare('SELECT id, name, left_date FROM colleagues ORDER BY sort_order ASC, name ASC').all();
  const countRows = db.prepare(
    `SELECT colleague_id, COUNT(*) as n FROM colleague_shifts
     WHERE shift_type = 'shift' AND date IN (${datePlaceholders})
     GROUP BY colleague_id`
  ).all(...dates);
  const countById = {};
  for (const r of countRows) countById[r.colleague_id] = r.n;
  const colleagues = allColleagues
    .map(c => ({ id: c.id, name: c.name, left_date: c.left_date || null, count: countById[c.id] || 0 }))
    .filter(c => c.count > 0);

  res.json({ myCount, myHoursWorked: Math.round(myHoursWorked * 100) / 100, total: dates.length, colleagues });
});

// ─────────────────────────────────────────
// LEAVE
// ─────────────────────────────────────────

app.get('/api/leave', (req, res) => {
  const { year, from, to } = req.query;
  let query = 'SELECT * FROM leave_entries';
  const params = [];
  if (from && to) {
    // Overlap: entry overlaps [from, to] if start_date <= to AND end_date >= from
    query += ' WHERE start_date <= ? AND end_date >= ?';
    params.push(to, from);
  } else if (year) {
    query += " WHERE strftime('%Y', start_date) = ? OR strftime('%Y', end_date) = ?";
    params.push(year, year);
  }
  query += ' ORDER BY start_date DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/leave/best-days?days=60 — upcoming shifts of yours where the team is
// already well covered without you, so booking leave there is least likely to
// create a coverage gap. Excludes other-store colleague shifts and days you've
// already got leave booked.
app.get('/api/leave/best-days', (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 60, 120);
  const today = localDateStr();
  const endDate = (() => {
    const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + days);
    return localDateStr(d);
  })();

  const myShifts = db.prepare(
    "SELECT date, start_time, end_time FROM shifts WHERE date > ? AND date <= ? ORDER BY date"
  ).all(today, endDate);

  const existingLeave = db.prepare(
    'SELECT start_date, end_date FROM leave_entries WHERE end_date >= ? AND start_date <= ?'
  ).all(today, endDate);
  const leaveDates = new Set();
  existingLeave.forEach(le => {
    let cur = new Date(le.start_date + 'T00:00:00');
    const end = new Date(le.end_date + 'T00:00:00');
    while (cur <= end) { leaveDates.add(localDateStr(cur)); cur.setDate(cur.getDate() + 1); }
  });

  const colShifts = db.prepare(`
    SELECT date, colleague_id FROM colleague_shifts
    WHERE date > ? AND date <= ? AND shift_type = 'shift' AND (store IS NULL OR store = '')
  `).all(today, endDate);
  const headcountByDate = {};
  colShifts.forEach(cs => {
    (headcountByDate[cs.date] ||= new Set()).add(cs.colleague_id);
  });

  const candidates = myShifts
    .filter(s => !leaveDates.has(s.date))
    .map(s => ({
      date: s.date,
      start_time: s.start_time,
      end_time: s.end_time,
      coverage: headcountByDate[s.date] ? headcountByDate[s.date].size : 0,
    }))
    .sort((a, b) => b.coverage - a.coverage || a.date.localeCompare(b.date))
    .slice(0, 10);

  res.json({ from: today, to: endDate, candidates });
});

app.post('/api/leave', (req, res) => {
  const { start_date, end_date, hours_taken, leave_type = 'annual', notes } = req.body;
  if (!start_date || !end_date || hours_taken === undefined) {
    return res.status(400).json({ error: 'start_date, end_date, hours_taken required' });
  }
  const hrs = Number(hours_taken);
  const result = db.prepare(
    'INSERT INTO leave_entries (start_date, end_date, days_taken, hours_taken, leave_type, notes) VALUES (?,?,?,?,?,?)'
  ).run(start_date, end_date, hrs, hrs, leave_type, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM leave_entries WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/leave/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM leave_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const {
    start_date   = existing.start_date,
    end_date     = existing.end_date,
    hours_taken  = existing.hours_taken ?? existing.days_taken,
    leave_type   = existing.leave_type,
    notes        = existing.notes,
  } = req.body;
  const hrs = Number(hours_taken);
  db.prepare('UPDATE leave_entries SET start_date=?, end_date=?, days_taken=?, hours_taken=?, leave_type=?, notes=? WHERE id=?')
    .run(start_date, end_date, hrs, hrs, leave_type, notes, req.params.id);
  res.json(db.prepare('SELECT * FROM leave_entries WHERE id = ?').get(req.params.id));
});

app.delete('/api/leave/:id', (req, res) => {
  const result = db.prepare('DELETE FROM leave_entries WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─────────────────────────────────────────
// CALENDAR NOTES
// ─────────────────────────────────────────

app.get('/api/calendar-notes', (req, res) => {
  const { month } = req.query;
  let query = 'SELECT * FROM calendar_notes';
  const params = [];
  if (month) {
    query += " WHERE strftime('%Y-%m', date) = ?";
    params.push(month);
  }
  query += ' ORDER BY date ASC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/calendar-notes', (req, res) => {
  const { date, note } = req.body;
  if (!date || !note) return res.status(400).json({ error: 'date and note required' });
  const result = db.prepare(
    `INSERT INTO calendar_notes (date, note) VALUES (?,?)
     ON CONFLICT(date) DO UPDATE SET note=excluded.note, updated_at=datetime('now')`
  ).run(date, note.trim());
  const id = result.lastInsertRowid || db.prepare('SELECT id FROM calendar_notes WHERE date=?').get(date).id;
  res.status(201).json(db.prepare('SELECT * FROM calendar_notes WHERE id=?').get(id));
});

app.delete('/api/calendar-notes/:id', (req, res) => {
  const result = db.prepare('DELETE FROM calendar_notes WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─────────────────────────────────────────
// BACKUP & RESTORE
// ─────────────────────────────────────────

app.get('/api/backup', (req, res) => {
  const backup = {
    version: 1,
    exported_at: new Date().toISOString(),
    shifts:         db.prepare('SELECT * FROM shifts').all(),
    payslips:       db.prepare('SELECT * FROM payslips').all(),
    pay_rates:      db.prepare('SELECT * FROM pay_rates').all(),
    leave_entries:  db.prepare('SELECT * FROM leave_entries').all(),
    settings:       db.prepare('SELECT * FROM settings').all(),
    calendar_notes: db.prepare('SELECT * FROM calendar_notes').all(),
  };
  res.setHeader('Content-Disposition', `attachment; filename="rota-backup-${localDateStr()}.json"`);
  res.json(backup);
});

// ── Automatic nightly database backups ──────────────────────────────────────
// Copies the whole SQLite file (safe under WAL via better-sqlite3's backup API)
// to data/backups/rota-YYYY-MM-DD.db once a day after 03:00, keeping the last 14.
const BACKUP_DIR  = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'backups');
const BACKUP_KEEP = 14;
const BACKUP_HOUR = 3;
const BACKUP_NAME_RE = /^rota-\d{4}-\d{2}-\d{2}\.db$/;

function listDbBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => BACKUP_NAME_RE.test(f))
      .sort().reverse()
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, size: st.size, created: st.mtime.toISOString() };
      });
  } catch (_) { return []; }
}

async function runDbBackup(reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `rota-${localDateStr()}.db`;
  await db.backup(path.join(BACKUP_DIR, name));
  const files = fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_NAME_RE.test(f)).sort();
  while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  console.log(`[Backup] ${reason} backup saved: ${name}`);

  let github = null;
  if (githubBackupConfigured()) {
    try {
      await pushDbBackupToGitHub(path.join(BACKUP_DIR, name), name);
      github = { ok: true };
      console.log(`[Backup] ${reason} backup pushed to GitHub: ${name}`);
    } catch (e) {
      github = { ok: false, error: e.message };
      console.error(`[Backup] GitHub push failed:`, e.message);
    }
  }
  return { name, github };
}

// ── Offsite copy: push the same .db backup to a GitHub repo ─────────────────
// Configurable two ways — a value entered in Settings (stored in the `settings`
// table) always wins; otherwise falls back to the matching env var (see
// docker-compose.yml):
//   GITHUB_BACKUP_REPO   "owner/repo" to push into (required)
//   GITHUB_BACKUP_TOKEN  a PAT with `contents:write` on that repo (required)
//   GITHUB_BACKUP_BRANCH branch to commit to (default "main")
//   GITHUB_BACKUP_PATH   folder within the repo (default "backups")
function ghBackupSetting(key, envVar, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(`github_backup_${key}`);
  if (row && row.value) return row.value;
  return process.env[envVar] || fallback || '';
}

function githubBackupConfigured() {
  return !!(ghBackupSetting('repo', 'GITHUB_BACKUP_REPO') && ghBackupSetting('token', 'GITHUB_BACKUP_TOKEN'));
}

function githubBackupHeaders() {
  return {
    Authorization: `Bearer ${ghBackupSetting('token', 'GITHUB_BACKUP_TOKEN')}`,
    'User-Agent': 'rota-app-backup',
    Accept: 'application/vnd.github+json',
  };
}

async function pushDbBackupToGitHub(localFilePath, name) {
  const repo = ghBackupSetting('repo', 'GITHUB_BACKUP_REPO');
  const branch = ghBackupSetting('branch', 'GITHUB_BACKUP_BRANCH', 'main');
  const dir = ghBackupSetting('path', 'GITHUB_BACKUP_PATH', 'backups').replace(/^\/+|\/+$/g, '');
  const repoPath = `${dir}/${name}`;
  const apiBase = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, '/')}`;
  const headers = githubBackupHeaders();

  // Look up the existing file's sha (needed to update rather than create)
  let sha;
  const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) sha = (await getRes.json()).sha;
  else if (getRes.status !== 404) throw new Error(`GitHub lookup failed: ${getRes.status} ${await getRes.text()}`);

  const content = fs.readFileSync(localFilePath).toString('base64');
  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Backup ${name}`, content, branch, sha }),
  });
  if (!putRes.ok) throw new Error(`GitHub push failed: ${putRes.status} ${await putRes.text()}`);

  // Mirror local retention: keep only the newest BACKUP_KEEP files in the repo folder
  const listRes = await fetch(`https://api.github.com/repos/${repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`, { headers });
  if (!listRes.ok) return;
  const remoteFiles = (await listRes.json())
    .filter(f => f.type === 'file' && BACKUP_NAME_RE.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  while (remoteFiles.length > BACKUP_KEEP) {
    const old = remoteFiles.shift();
    await fetch(`https://api.github.com/repos/${repo}/contents/${dir}/${old.name}`, {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Prune old backup ${old.name}`, sha: old.sha, branch }),
    });
  }
}

let dbBackupTimer = null;
function startDbBackupSync() {
  if (dbBackupTimer) { clearInterval(dbBackupTimer); dbBackupTimer = null; }
  dbBackupTimer = setInterval(async () => {
    const now = new Date();
    if (now.getHours() < BACKUP_HOUR) return;
    if (fs.existsSync(path.join(BACKUP_DIR, `rota-${localDateStr()}.db`))) return;
    try { await runDbBackup('nightly'); }
    catch (e) { console.error('[Backup] nightly backup failed:', e.message); }
  }, 10 * 60000);
  if (dbBackupTimer.unref) dbBackupTimer.unref();
}

// GET /api/db-backups — list stored automatic backups
app.get('/api/db-backups', (req, res) => {
  res.json({
    keep: BACKUP_KEEP,
    hour: BACKUP_HOUR,
    backups: listDbBackups(),
    github: githubBackupConfigured()
      ? { configured: true, repo: ghBackupSetting('repo', 'GITHUB_BACKUP_REPO'), branch: ghBackupSetting('branch', 'GITHUB_BACKUP_BRANCH', 'main') }
      : { configured: false },
  });
});

// GET /api/db-backups/github-settings — current GitHub backup config (token never returned)
app.get('/api/db-backups/github-settings', (req, res) => {
  res.json({
    repo: ghBackupSetting('repo', 'GITHUB_BACKUP_REPO'),
    branch: ghBackupSetting('branch', 'GITHUB_BACKUP_BRANCH', 'main'),
    path: ghBackupSetting('path', 'GITHUB_BACKUP_PATH', 'backups'),
    hasToken: !!ghBackupSetting('token', 'GITHUB_BACKUP_TOKEN'),
  });
});

// POST /api/db-backups/github-settings — save GitHub backup config from Settings
// Blank/omitted token leaves the currently stored token untouched.
app.post('/api/db-backups/github-settings', (req, res) => {
  const { repo, token, branch, path: repoPath } = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  upsert.run('github_backup_repo', String(repo || ''));
  upsert.run('github_backup_branch', String(branch || ''));
  upsert.run('github_backup_path', String(repoPath || ''));
  if (token) upsert.run('github_backup_token', String(token));
  res.json({ ok: true });
});

// DELETE /api/db-backups/github-settings — clear GitHub backup config (including token)
app.delete('/api/db-backups/github-settings', (req, res) => {
  const del = db.prepare('DELETE FROM settings WHERE key=?');
  ['repo', 'token', 'branch', 'path'].forEach(k => del.run(`github_backup_${k}`));
  res.json({ ok: true });
});

// POST /api/db-backups/run — take a backup right now (overwrites today's if present)
app.post('/api/db-backups/run', async (req, res) => {
  try {
    const result = await runDbBackup('manual');
    res.json({ ok: true, file: result.name, github: result.github });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/db-backups/:file — download one backup (filename strictly validated)
app.get('/api/db-backups/:file', (req, res) => {
  const f = req.params.file;
  if (!BACKUP_NAME_RE.test(f)) return res.status(400).json({ error: 'bad filename' });
  const full = path.join(BACKUP_DIR, f);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  res.download(full);
});

app.post('/api/restore', (req, res) => {
  const { shifts = [], payslips = [], pay_rates = [], leave_entries = [],
          settings = [], calendar_notes = [] } = req.body;

  try {
    db.transaction(() => {
      // Clear existing data
      db.prepare('DELETE FROM shifts').run();
      db.prepare('DELETE FROM payslips').run();
      db.prepare('DELETE FROM pay_rates').run();
      db.prepare('DELETE FROM leave_entries').run();
      db.prepare('DELETE FROM settings').run();
      db.prepare('DELETE FROM calendar_notes').run();

      // Restore shifts
      const insShift = db.prepare(`INSERT INTO shifts VALUES (
        @id,@date,@start_time,@end_time,@break_scheduled_minutes,@break_taken,@break_taken_minutes,
        @distance_miles,@hourly_rate,@hours_worked,@calculated_pay,@completed,@notes,
        @created_at,@updated_at,@is_bank_holiday)`);
      shifts.forEach(r => insShift.run({ is_bank_holiday: 0, ...r }));

      // Restore payslips
      const payFields = db.prepare('PRAGMA table_info(payslips)').all().map(c => c.name);
      const payPlaceholders = payFields.map(f => `@${f}`).join(',');
      const insPayslip = db.prepare(`INSERT INTO payslips (${payFields.join(',')}) VALUES (${payPlaceholders})`);
      payslips.forEach(r => insPayslip.run(r));

      // Restore pay rates
      pay_rates.forEach(r => db.prepare(
        'INSERT INTO pay_rates VALUES (@id,@effective_date,@hourly_rate,@contracted_hours_per_week,@notes,@created_at)'
      ).run(r));

      // Restore leave entries
      leave_entries.forEach(r => db.prepare(
        'INSERT INTO leave_entries VALUES (@id,@start_date,@end_date,@days_taken,@leave_type,@notes,@created_at)'
      ).run(r));

      // Restore settings
      settings.forEach(r => db.prepare('INSERT INTO settings VALUES (@key,@value)').run(r));

      // Restore calendar notes
      calendar_notes.forEach(r => db.prepare(
        'INSERT INTO calendar_notes VALUES (@id,@date,@note,@created_at,@updated_at)'
      ).run(r));
    })();

    res.json({ success: true, message: 'Restore complete' });
  } catch(e) {
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
});

// ─────────────────────────────────────────
// IMPORT — ICS (iCalendar)
// ─────────────────────────────────────────

/**
 * Parse an iCalendar (.ics) file text into an array of VEVENT objects.
 * Handles RFC 5545 line folding and the most common property formats.
 */
function parseICS(text) {
  // Unfold folded lines (CRLF/LF followed by a space or tab is a continuation)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let current = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = {};
    } else if (upper === 'END:VEVENT' && current) {
      events.push(current);
      current = null;
    } else if (current) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const namePart = line.substring(0, colonIdx);   // e.g. DTSTART;TZID=Europe/London
      const value    = line.substring(colonIdx + 1);  // e.g. 20241015T090000
      const baseName = namePart.split(';')[0].toUpperCase();
      current[baseName] = value;
      // Preserve the full property line for DTSTART/DTEND so we can detect UTC
      if (baseName === 'DTSTART' || baseName === 'DTEND') {
        current[baseName + '_IS_UTC'] = value.endsWith('Z');
      }
    }
  }
  return events;
}

/**
 * Auto-calculate break duration from shift length:
 *   ≤ 4 h → 0 min
 *   4–6 h → 15 min
 *   > 6 h → 30 min
 */
function autoBreakMinutes(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  // Break increases only when the shift length EXCEEDS the boundary (strict >),
  // so a 6h00 shift = 15 min and an 8h00 shift = 30 min (per the rota break policy).
  const T430 = 4 * 60 + 30; // 270 min
  if (mins > 8*60)  return 45;  // over 8h      → 45 min
  if (mins > 6*60)  return 30;  // over 6h–8h   → 30 min
  if (mins > T430)  return 15;  // over 4h30–6h → 15 min
  return 0;                     // 4h30 or less → no break
}

// ─────────────────────────────────────────
// UK Bank Holidays (server-side, cached) — used so shifts created/updated by the
// Rotageek sync get is_bank_holiday (and therefore double pay) set automatically.
// Mirrors the client-side BankHols utility (public/js/utils.js) but runs on the server
// since the sync loop has no browser context.
// ─────────────────────────────────────────
let _bankHolidayCache = null;      // Set of 'YYYY-MM-DD' (England & Wales)
let _bankHolidayCacheTime = 0;
const BANK_HOLIDAY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

async function getUkBankHolidays() {
  const now = Date.now();
  if (_bankHolidayCache && (now - _bankHolidayCacheTime) < BANK_HOLIDAY_CACHE_TTL) {
    return _bankHolidayCache;
  }
  try {
    const r = await fetch('https://www.gov.uk/bank-holidays.json');
    const data = await r.json();
    const events = data?.['england-and-wales']?.events || [];
    _bankHolidayCache = new Set(events.map(e => e.date));
    _bankHolidayCacheTime = now;
  } catch (e) {
    console.error('[BankHolidays] fetch failed:', e.message);
    if (!_bankHolidayCache) _bankHolidayCache = new Set(); // don't crash the sync — just skip BH detection this run
  }
  return _bankHolidayCache;
}

/**
 * Parse an iCal datetime string to { date, time } in local (UK) representation.
 * Handles: 20241015T090000, 20241015T090000Z, 20241015 (all-day)
 */
function parseICSDateTime(raw) {
  if (!raw) return null;
  const clean = raw.replace(/Z$/, '');

  const dtMatch = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (dtMatch) {
    return {
      date:   `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`,
      time:   `${dtMatch[4]}:${dtMatch[5]}`,
      allDay: false,
    };
  }

  const dateMatch = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateMatch) {
    return {
      date:   `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
      time:   null,
      allDay: true,
    };
  }
  return null;
}

// Helper: count weekday days between two date strings (inclusive of start, exclusive of end)
function countWeekdaysBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end   = new Date(endStr);
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Subtract one day from a YYYY-MM-DD string (ICS all-day DTEND is exclusive)
function prevDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

// POST /api/import/ics-preview — parse ICS and return detected shifts + leave for review
app.post('/api/import/ics-preview', (req, res) => {
  const { ics } = req.body;
  if (!ics) return res.status(400).json({ error: 'ics required' });

  const events = parseICS(ics);
  const shifts = [];
  const leaveEntries = [];
  let hasUtc = false;

  for (const ev of events) {
    const start = parseICSDateTime(ev.DTSTART);
    const end   = parseICSDateTime(ev.DTEND);

    if (!start) continue;

    const summary = ev.SUMMARY ? ev.SUMMARY.replace(/\\n/g, ' ').replace(/\\,/g, ',').trim() : '';

    // All-day events → leave entries
    if (start.allDay) {
      const endDate = end && end.allDay ? prevDay(end.date) : start.date;
      const days_taken = countWeekdaysBetween(start.date, end && end.allDay ? end.date : start.date + 'T24') || 1;
      leaveEntries.push({
        start_date: start.date,
        end_date:   endDate,
        days_taken,
        leave_type: 'annual',
        summary,
      });
      continue;
    }

    if (ev.DTSTART_IS_UTC) hasUtc = true;

    const end_time = end && !end.allDay ? end.time : null;
    shifts.push({
      date:          start.date,
      start_time:    start.time,
      end_time,
      break_minutes: autoBreakMinutes(start.time, end_time),
      summary,
      description:   ev.DESCRIPTION ? ev.DESCRIPTION.replace(/\\n/g, ' ').replace(/\\,/g, ',').trim() : '',
      uid:           ev.UID || '',
    });
  }

  shifts.sort((a, b) => a.date.localeCompare(b.date));
  leaveEntries.sort((a, b) => a.start_date.localeCompare(b.start_date));

  res.json({ shifts, total: shifts.length, hasUtc, leaveEntries, leaveTotal: leaveEntries.length });
});

// POST /api/import/ics-shifts — import events from ICS as shifts + all-day as leave
app.post('/api/import/ics-shifts', (req, res) => {
  const { ics, breakMinutes = 30, importLeave = true } = req.body;
  if (!ics) return res.status(400).json({ error: 'ics required' });

  const events = parseICS(ics);
  let imported = 0, leaveImported = 0, skipped = 0;
  const errors = [];

  const insertShift = db.prepare(`
    INSERT OR IGNORE INTO shifts
      (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
       distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, completed, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const insertLeave = db.prepare(
    'INSERT INTO leave_entries (start_date, end_date, days_taken, leave_type, notes) VALUES (?,?,?,?,?)'
  );

  const defaultDist = parseFloat(
    db.prepare("SELECT value FROM settings WHERE key='default_distance_miles'").get()?.value || 3.6
  );

  const bk = parseInt(breakMinutes, 10) || 30;

  const doImport = db.transaction(() => {
    for (const ev of events) {
      try {
        const start = parseICSDateTime(ev.DTSTART);
        const end   = parseICSDateTime(ev.DTEND);
        const summary = ev.SUMMARY ? ev.SUMMARY.replace(/\\n/g, ' ').replace(/\\,/g, ',').trim() : null;

        // All-day events → leave entries
        if (start && start.allDay && importLeave) {
          const endDate  = end && end.allDay ? prevDay(end.date) : start.date;
          const daysTaken = countWeekdaysBetween(start.date, end && end.allDay ? end.date : start.date) || 1;
          insertLeave.run(start.date, endDate, daysTaken, 'annual', summary);
          leaveImported++;
          continue;
        }

        if (!start || start.allDay || !start.time || !end || !end.time) {
          skipped++; continue;
        }

        const date       = start.date;
        const start_time = start.time;
        const end_time   = end.time;

        // Derive the break from the shift length (policy-based) unless the caller
        // forces a specific value; keeps ICS imports consistent with everything else.
        const evBreak        = (breakMinutes === 'auto' || breakMinutes === undefined)
          ? autoBreakMinutes(start_time, end_time) : bk;
        const rateRecord     = getPayRateForDate(date);
        const hourly_rate    = rateRecord ? rateRecord.hourly_rate : null;
        const hours_worked   = calcHoursWorked(start_time, end_time, evBreak);
        const hours_paid     = calcHoursWorked(start_time, end_time, evBreak);
        const calculated_pay = hourly_rate ? Math.round(hours_paid * hourly_rate * 100) / 100 : null;

        insertShift.run(
          date, start_time, end_time, evBreak, 'full', evBreak,
          defaultDist, hourly_rate, hours_worked, hours_paid, calculated_pay, 0, summary
        );
        imported++;
      } catch (e) {
        errors.push(`Event "${ev.SUMMARY || '?'}": ${e.message}`);
        skipped++;
      }
    }
  });

  doImport();
  res.json({ imported, leaveImported, skipped, errors });
});

// ─────────────────────────────────────────
// IMPORT — CSV
// ─────────────────────────────────────────

// Split a single CSV line respecting quoted fields
function splitCSVLine(line) {
  const vals = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  vals.push(cur.trim());
  return vals;
}

// Parse a CSV — headerRow is 0-indexed row number containing column headers
function parseCSV(text, headerRow = 0) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length <= headerRow) return [];
  const headers = splitCSVLine(lines[headerRow]).map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(headerRow + 1).map(line => {
    const vals = splitCSVLine(line).map(v => v.replace(/^"|"$/g, '').trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  }).filter(row => Object.values(row).some(v => v !== ''));
}

// POST /api/import/shifts — body: { csv: "...", mapping: { date, start_time, end_time, ... }, headerRow }
app.post('/api/import/shifts', (req, res) => {
  const { csv, mapping, headerRow = 0 } = req.body;
  if (!csv || !mapping) return res.status(400).json({ error: 'csv and mapping required' });

  const rows = parseCSV(csv, parseInt(headerRow, 10) || 0);
  let imported = 0, skipped = 0;
  const errors = [];

  const insertShift = db.prepare(`
    INSERT OR IGNORE INTO shifts
      (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
       distance_miles, hourly_rate, hours_worked, calculated_pay, completed, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const defaultDist = parseFloat(
    db.prepare("SELECT value FROM settings WHERE key='default_distance_miles'").get()?.value || 3.6
  );

  const doImport = db.transaction(() => {
    rows.forEach((row, idx) => {
      try {
        const rawDate  = row[mapping.date]       || '';
        const rawStart = row[mapping.start_time] || '';
        const rawEnd   = row[mapping.end_time]   || '';
        const date       = normaliseDate(rawDate);
        const start_time = normaliseTime(rawStart);
        const end_time   = normaliseTime(rawEnd);
        if (!date || !start_time || !end_time) {
          // Only report the first 10 parse failures so the user can see what
          // format the server actually received (helps debug date/time mismatches)
          if (errors.length < 10) {
            if (!date && rawDate)       errors.push(`Row ${idx + 2} skipped — couldn't parse date: "${rawDate}"`);
            else if (!start_time && rawStart) errors.push(`Row ${idx + 2} skipped — couldn't parse start time: "${rawStart}"`);
            else if (!end_time   && rawEnd)   errors.push(`Row ${idx + 2} skipped — couldn't parse end time: "${rawEnd}"`);
          }
          skipped++; return;
        }

        const breakMins = parseInt(row[mapping.break_minutes] || 30, 10) || 30;
        const rateRecord = getPayRateForDate(date);
        const hourly_rate = rateRecord ? rateRecord.hourly_rate : null;
        const actualBreak = resolveBreakMinutes('full', breakMins, breakMins);
        const hours_worked = calcHoursWorked(start_time, end_time, actualBreak);
        const hours_paid   = calcHoursWorked(start_time, end_time, breakMins);
        const calculated_pay = hourly_rate ? Math.round(hours_paid * hourly_rate * 100) / 100 : null;
        const distThere  = parseFloat(row[mapping.distance_miles]        || 0) || 0;
        const distReturn = parseFloat(row[mapping.distance_miles_return] || 0) || 0;
        const distance_miles = (distThere || distReturn)
          ? distThere + distReturn
          : defaultDist;
        const completed = row[mapping.completed] ? (row[mapping.completed].toLowerCase() === 'true' || row[mapping.completed] === '1' ? 1 : 0) : 0;
        const notes = row[mapping.notes] || null;

        insertShift.run(date, start_time, end_time, breakMins, 'full', actualBreak,
          distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, completed, notes);
        imported++;
      } catch (e) {
        errors.push(`Row ${idx + 2}: ${e.message}`);
        skipped++;
      }
    });
  });

  doImport();
  res.json({ imported, skipped, errors });
});

// POST /api/import/payslips — body: { csv: "...", mapping: { month, ... }, headerRow }
app.post('/api/import/payslips', (req, res) => {
  const { csv, mapping, headerRow = 0 } = req.body;
  if (!csv || !mapping) return res.status(400).json({ error: 'csv and mapping required' });

  const rows = parseCSV(csv, parseInt(headerRow, 10) || 0);
  let imported = 0, skipped = 0;
  const errors = [];

  const upsertPayslip = db.prepare(`
    INSERT INTO payslips (month, payment_date, basic_pay, arrears_pay, additional_hours_qty,
      additional_hours_pay, other_payments, total_gross, total_deductions, net_payment,
      tax_paid, ni_employee, gross_ytd, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(month) DO UPDATE SET
      basic_pay=excluded.basic_pay, arrears_pay=excluded.arrears_pay,
      total_gross=excluded.total_gross, net_payment=excluded.net_payment,
      updated_at=datetime('now')
  `);

  const doImport = db.transaction(() => {
    rows.forEach((row, idx) => {
      try {
        const month = normaliseMonth(row[mapping.month] || '');
        if (!month) { skipped++; return; }
        const g = f => parseFloat(row[mapping[f]] || 0) || 0;
        upsertPayslip.run(
          month,
          normaliseDate(row[mapping.payment_date] || '') || null,
          g('basic_pay'), g('arrears_pay'), g('additional_hours_qty'), g('additional_hours_pay'),
          g('other_payments'), g('total_gross'), g('total_deductions'), g('net_payment'),
          g('tax_paid'), g('ni_employee'), g('gross_ytd'), row[mapping.notes] || null
        );
        imported++;
      } catch (e) {
        errors.push(`Row ${idx + 2}: ${e.message}`);
        skipped++;
      }
    });
  });

  doImport();
  res.json({ imported, skipped, errors });
});

// Preview CSV — returns raw rows + parsed headers/sample based on headerRow
app.post('/api/import/preview', (req, res) => {
  const { csv, headerRow = 0, endRow = null } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv required' });
  const allLines = csv.trim().split(/\r?\n/).filter(l => l.trim());
  if (allLines.length === 0) return res.json({ headers: [], sample: [], rawRows: [] });

  const hRow = parseInt(headerRow, 10) || 0;

  // Show enough rows so the ⬇ end-row marker is always visible.
  // At minimum show 20 rows; if endRow is set, show up to endRow + 1 (capped at 200).
  const eRow = endRow ? parseInt(endRow, 10) : null;
  const previewCount = eRow ? Math.min(Math.max(20, eRow + 1), 200) : 20;

  const rawRows = allLines.slice(0, previewCount).map((line, i) => ({
    rowNum: i + 1,
    cells: splitCSVLine(line).map(v => v.replace(/^"|"$/g, '').trim())
  }));

  // Parsed headers and sample using the chosen headerRow
  const headers = splitCSVLine(allLines[hRow] || '').map(h => h.replace(/^"|"$/g, '').trim());
  const sample = allLines.slice(hRow + 1, hRow + 4).map(line =>
    splitCSVLine(line).map(v => v.replace(/^"|"$/g, '').trim())
  );
  const totalRows = Math.max(0, allLines.length - hRow - 1);

  res.json({ headers, sample, totalRows, rawRows });
});

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function resolveBreakMinutes(break_taken, scheduled, explicit) {
  if (break_taken === 'none') return 0;
  if (break_taken === 'partial' && explicit !== undefined && explicit !== null) {
    return parseInt(explicit, 10) || 0;
  }
  // 'full' or anything else — use the scheduled break length
  // Use ?? (not ||) so a 0-minute scheduled break stays 0 instead of falling back to 30.
  return parseInt(scheduled ?? 30, 10);
}

// Month abbreviations used by normaliseDate
const SHORT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Given a day-of-week name ("Sun", "Mon" …) + month number + day number,
 * search backwards through recent years to find the year where that calendar
 * date actually falls on that day of the week.  This lets us reliably parse
 * strings like "Sun, 1 Sep" without needing an explicit year in the text.
 */
function inferYearFromDayOfWeek(dayStr, month, day) {
  const DOW = ['sun','mon','tue','wed','thu','fri','sat'];
  const target = DOW.indexOf(dayStr.toLowerCase().substring(0, 3));
  const now = new Date();
  if (target === -1) {
    // No recognisable day name — fall back to current year, or last year if month > now
    return month <= now.getMonth() + 1 ? now.getFullYear() : now.getFullYear() - 1;
  }
  // Search from this year back 7 years (covers any reasonable rota history)
  for (let y = now.getFullYear(); y >= now.getFullYear() - 7; y--) {
    if (new Date(y, month - 1, day).getDay() === target) return y;
  }
  return now.getFullYear();
}

function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // YYYY-MM-DD  (ISO — preferred output from SheetJS dateNF option)
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2,'0')}-${ymd[3].padStart(2,'0')}`;

  // D/M/Y or M/D/Y  (with / or -)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3];
    let day = dmy[1], month = dmy[2];
    // If the "month" slot is > 12 it must actually be the day (US m/d/y) — swap
    if (parseInt(month, 10) > 12) { [day, month] = [month, day]; }
    return `${y}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
  }

  // "Weekday, D Mon[th]"  e.g. "Sun, 1 Sep"  or  "Monday, 12 September"
  // The day-of-week prefix is used to disambiguate the year.
  const wdm = s.match(/^(\w+),?\s+(\d{1,2})\s+([A-Za-z]+)$/);
  if (wdm) {
    const monIdx = SHORT_MONTHS.indexOf(wdm[3].toLowerCase().substring(0, 3));
    if (monIdx >= 0) {
      const day   = parseInt(wdm[2], 10);
      const month = monIdx + 1;
      const year  = inferYearFromDayOfWeek(wdm[1], month, day);
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }

  // "D Mon[th] YYYY"  e.g. "1 Sep 2024"  or  "12 September 2024"
  const dmY = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dmY) {
    const monIdx = SHORT_MONTHS.indexOf(dmY[2].toLowerCase().substring(0, 3));
    if (monIdx >= 0)
      return `${dmY[3]}-${String(monIdx + 1).padStart(2,'0')}-${String(parseInt(dmY[1], 10)).padStart(2,'0')}`;
  }

  return null;
}

function normaliseTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // HH:MM or HH:MM:SS with nothing after (e.g. "11:00" or "11:00:00")
  // Must end here so "3:15 PM" falls through to the AM/PM branch below
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return `${m[1].padStart(2,'0')}:${m[2]}`;
  // AM/PM format  (e.g. "7:00 AM", "11:30 PM")
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2];
    const period = ampm[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${min}`;
  }
  // Excel decimal fraction (e.g. 0.458333... = 11:00) — fallback when SheetJS
  // outputs raw numeric values instead of formatted time strings
  const n = parseFloat(s);
  if (!isNaN(n) && n >= 0 && n < 1) {
    const totalMins = Math.round(n * 24 * 60);
    const h   = Math.floor(totalMins / 60);
    const min = totalMins % 60;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  }
  return null;
}

function normaliseMonth(raw) {
  if (!raw) return null;
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  // Try to parse a date and extract month
  const d = normaliseDate(raw);
  if (d) return d.substring(0, 7);
  // Month name + year e.g. "October 2024"
  const months = ['january','february','march','april','may','june',
    'july','august','september','october','november','december'];
  const mMatch = raw.toLowerCase().match(/(\w+)\s+(\d{4})/);
  if (mMatch) {
    const mi = months.indexOf(mMatch[1]);
    if (mi >= 0) return `${mMatch[2]}-${String(mi+1).padStart(2,'0')}`;
  }
  return null;
}

// ─────────────────────────────────────────
// SHIFT ↔ COLLEAGUE HELPERS
// ─────────────────────────────────────────

// How close a non-overlapping (or barely-overlapping) colleague shift has to be
// to one of your shift's boundaries to count as a "crossover"/handover rather
// than a real overlap.
const CROSSOVER_WINDOW_MIN = 15;

function _hwTimeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Classify how a colleague's shift relates to yours:
//  - 'overlap'   — any genuine time overlap at all — you're actually working together
//  - 'crossover' — no overlap, but they leave up to 15 min BEFORE your shift starts,
//                  or arrive up to 15 min AFTER your shift ends (a handover, not overlap)
//  - null        — too far apart in time to be relevant
function _classifyShiftRelation(myStart, myEnd, csStart, csEnd) {
  if (myEnd <= myStart) myEnd += 1440;   // overnight shift normalisation
  if (csEnd <= csStart) csEnd += 1440;

  const overlaps = csStart < myEnd && csEnd > myStart;
  if (overlaps) {
    return { relation: 'overlap', note: null };
  }

  // No overlap — check whether they leave shortly before your start, or arrive shortly after your end
  const gapBeforeYourStart = myStart - csEnd;   // they finished this many minutes before your start
  const gapAfterYourEnd    = csStart - myEnd;   // they start this many minutes after your end

  if (gapBeforeYourStart >= 0 && gapBeforeYourStart <= CROSSOVER_WINDOW_MIN) {
    return {
      relation: 'crossover',
      note: gapBeforeYourStart === 0 ? 'Leaves right as you arrive' : `Leaves ${gapBeforeYourStart} min before you start`,
    };
  }
  if (gapAfterYourEnd >= 0 && gapAfterYourEnd <= CROSSOVER_WINDOW_MIN) {
    return {
      relation: 'crossover',
      note: gapAfterYourEnd === 0 ? 'Arrives right as you leave' : `Arrives ${gapAfterYourEnd} min after you end`,
    };
  }
  return { relation: null, note: null };
}

// GET /api/working-with/:date?start_time=HH:MM&end_time=HH:MM
// Returns colleagues whose stored shifts on that date overlap the given window,
// classified as a genuine 'overlap' or a brief 'crossover' handover (<=15 min).
app.get('/api/working-with/:date', (req, res) => {
  const { date } = req.params;
  const { start_time, end_time } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  if (start_time && end_time) {
    const myStart = _hwTimeToMinutes(start_time);
    const myEnd   = _hwTimeToMinutes(end_time);

    const csRows = db.prepare(`
      SELECT c.id, c.name, cs.start_time, cs.end_time, cs.shift_type
      FROM colleague_shifts cs
      JOIN colleagues c ON c.id = cs.colleague_id
      WHERE cs.date = ? AND (cs.store IS NULL OR cs.store = '')
      ORDER BY c.sort_order ASC, c.name ASC
    `).all(date);

    const RELATION_RANK = { overlap: 2, crossover: 1 };
    const byColleague = new Map();
    for (const r of csRows) {
      if (r.shift_type === 'leave' || r.shift_type === 'all_day') continue; // no meaningful times
      const csStart = _hwTimeToMinutes(r.start_time);
      const csEnd   = _hwTimeToMinutes(r.end_time);
      if (csStart === null || csEnd === null || myStart === null || myEnd === null) continue;

      const { relation, note } = _classifyShiftRelation(myStart, myEnd, csStart, csEnd);
      if (!relation) continue;

      const existing = byColleague.get(r.id);
      if (!existing || RELATION_RANK[relation] > RELATION_RANK[existing.relation]) {
        byColleague.set(r.id, { id: r.id, name: r.name, start_time: r.start_time, end_time: r.end_time, shift_type: r.shift_type, relation, note });
      }
    }
    return res.json(Array.from(byColleague.values()));
  }

  // No time filter — return all colleagues on that date, no relation classification
  const rows = db.prepare(`
    SELECT c.id, c.name, cs.start_time, cs.end_time, cs.shift_type
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date = ? AND (cs.store IS NULL OR cs.store = '')
    GROUP BY c.id
    ORDER BY c.sort_order ASC, c.name ASC
  `).all(date);
  res.json(rows);
});

// POST /api/shift-colleagues — bulk-add manual colleague associations for a shift
// body: { shift_id, colleague_ids: [1, 2, ...] }
app.post('/api/shift-colleagues', (req, res) => {
  const { shift_id, colleague_ids = [] } = req.body;
  if (!shift_id) return res.status(400).json({ error: 'shift_id required' });

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift_id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  let inserted = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO colleague_shifts (colleague_id, date, shift_type, start_time, end_time)
    VALUES (?, ?, 'manual', ?, ?)
  `);
  const doInsert = db.transaction(() => {
    for (const cid of colleague_ids) {
      const r = insert.run(cid, shift.date, shift.start_time, shift.end_time);
      inserted += r.changes;
    }
  });
  doInsert();
  res.json({ inserted });
});


// ─────────────────────────────────────────
// AUDIT LOG HELPER
// ─────────────────────────────────────────

function logAudit({ shift_id = null, action, changed_fields = null, old_values = null, new_values = null, source = 'manual', note = null }) {
  try {
    db.prepare(`
      INSERT INTO shift_audit_log (shift_id, action, changed_fields, old_values, new_values, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      shift_id,
      action,
      changed_fields ? JSON.stringify(changed_fields) : null,
      old_values     ? JSON.stringify(old_values)     : null,
      new_values     ? JSON.stringify(new_values)     : null,
      source,
      note
    );
  } catch (e) { console.error('logAudit error:', e.message); }
}

// ─────────────────────────────────────────
// NTFY NOTIFICATIONS
// ─────────────────────────────────────────

async function sendNtfy(title, body, priority = 'default') {
  const topic   = rgSetting('ntfy_topic');
  const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const enabled = rgSetting('ntfy_enabled');
  if (!topic || enabled !== '1') return;
  // Map named priorities to ntfy numeric scale (1=min, 3=default, 4=high, 5=max)
  const priorityMap = { min: 1, low: 2, default: 3, high: 4, max: 5 };
  const p = priorityMap[priority] ?? 3;
  try {
    // POST to root URL with JSON body so Unicode in title/message is handled correctly
    await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message: body, priority: p }),
    });
  } catch (e) { console.error('ntfy send error:', e.message); }
}

// ─────────────────────────────────────────
// ROTAGEEK API PROXY
// ─────────────────────────────────────────

const RG_DEFAULT_URL = 'https://publicapi.rotageek.com';

function rgSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('rotageek_' + key);
  return row ? row.value : null;
}
function rgUpsert(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('rotageek_' + key, value);
}

// POST /api/rotageek/auth — try username/password login against multiple known endpoint formats
app.post('/api/rotageek/auth', async (req, res) => {
  const { username, password, base_url } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  // Use the provided base_url, otherwise default to the Screwfix tenant subdomain
  const baseUrl = (base_url || 'https://screwfix.rotageek.com').replace(/\/$/, '');

  // Attempt order — try common endpoint/body formats used by Rotageek tenant apps
  const attempts = [
    { url: baseUrl, path: '/api/v1/users/sign_in', body: { user: { email: username, password } } },
    { url: baseUrl, path: '/api/v1/auth',           body: { email: username, password } },
    { url: baseUrl, path: '/api/v1/sessions',       body: { email: username, password } },
  ];

  let lastError = 'Auth failed';
  for (const attempt of attempts) {
    try {
      const r = await fetch(`${attempt.url}${attempt.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const token = data.access_token || data.token || data.auth_token ||
                      data.user?.token  || data.user?.authentication_token || '';
        if (token) {
          rgUpsert('token', token);
          rgUpsert('base_url', attempt.url);
          rgUpsert('username', username);
          rgUpsert('auth_mode', 'credentials');
          return res.json({ ok: true, token });
        }
      }
      // Record the error for this attempt
      lastError = data.error || data.message || data.errors?.full_messages?.join(', ') || `HTTP ${r.status} on ${attempt.path}`;
      // If it's a credentials error (401/422) rather than endpoint-not-found, stop trying
      if (r.status === 401 || r.status === 422) break;
    } catch(e) {
      lastError = e.message;
    }
  }
  res.status(401).json({ error: lastError });
});

// POST /api/rotageek/save-token — store a manually pasted Bearer token
app.post('/api/rotageek/save-token', (req, res) => {
  const { token, base_url } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  rgUpsert('token', token.replace(/^Bearer\s+/i, '').trim());
  rgUpsert('base_url', (base_url || 'https://app.rotageek.com').replace(/\/$/, ''));
  rgUpsert('auth_mode', 'manual');
  res.json({ ok: true });
});

// POST /api/rotageek/save-session — store cookie + CSRF token (the F12 method / bookmarklet)
// CORS enabled so the bookmarklet can POST from screwfix.rotageek.com
app.options('/api/rotageek/save-session', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});
app.post('/api/rotageek/save-session', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { cookie, csrf_token, base_url } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie required' });
  rgUpsert('cookie',    cookie.trim());
  rgUpsert('csrf_token', (csrf_token || '').trim());
  rgUpsert('base_url',   (base_url || 'https://screwfix.rotageek.com').replace(/\/$/, ''));
  rgUpsert('auth_mode',      'session');
  rgUpsert('session_expired', '0');
  // Restart auto-sync with fresh session
  startAutoSync();
  res.json({ ok: true, auth_mode: 'session' });
});

// GET /api/rotageek/save-session-bm — bookmarklet redirect (avoids HTTPS→HTTP fetch block)
// The bookmarklet opens this URL in a new tab; data is base64-encoded JSON {cookie, csrf_token}
app.get('/api/rotageek/save-session-bm', (req, res) => {
  try {
    const raw = Buffer.from(req.query.data || '', 'base64').toString('utf8');
    const { cookie, csrf_token, base_url } = JSON.parse(raw);
    if (!cookie) throw new Error('no cookie');
    rgUpsert('cookie',    cookie.trim());
    rgUpsert('csrf_token', (csrf_token || '').trim());
    rgUpsert('base_url',   (base_url || 'https://screwfix.rotageek.com').replace(/\/$/, ''));
    rgUpsert('auth_mode',      'session');
    rgUpsert('session_expired', '0');
    startAutoSync();
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
      .box{text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.1);border-top:4px solid #22c55e}
      h2{margin:0 0 8px;color:#16a34a}p{color:#555;margin:0 0 20px}
      button{padding:10px 24px;background:#22c55e;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px}
      button:hover{background:#16a34a}</style></head>
      <body><div class="box"><h2>✅ Session Saved</h2>
      <p>Your Rotageek session has been saved to the Rota App.</p>
      <button onclick="window.close()">Close this tab</button></div></body></html>`);
  } catch(e) {
    res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fef2f2}
      .box{text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.1);border-top:4px solid #ef4444}
      h2{margin:0 0 8px;color:#dc2626}p{color:#555;margin:0}</style></head>
      <body><div class="box"><h2>❌ Error</h2><p>${e.message}</p></div></body></html>`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Rotageek login proxy — lets the user log in through the Rota App so the
// server can capture the session cookie automatically (handles MFA fine).
// Usage: navigate to /rotageek-proxy/ in your browser and log in normally.
// ─────────────────────────────────────────────────────────────────────────────
const RG_PROXY_TARGET = 'screwfix.rotageek.com';
const RG_PROXY_BASE   = '/rotageek-proxy';

app.all(`${RG_PROXY_BASE}*`, (req, res) => {
  const targetPath = req.path.slice(RG_PROXY_BASE.length) || '/';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const fullPath = targetPath + qs;

  // Forward cookies the browser already has for our proxy back to Rotageek
  const fwdHeaders = { ...req.headers };
  delete fwdHeaders['host'];
  fwdHeaders['host'] = RG_PROXY_TARGET;
  // Strip encoding so we can inspect/rewrite the body easily
  delete fwdHeaders['accept-encoding'];

  const options = {
    hostname: RG_PROXY_TARGET,
    port: 443,
    path: fullPath,
    method: req.method,
    headers: fwdHeaders,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Intercept Set-Cookie — save any auth cookies to DB
    const setCookieHeaders = proxyRes.headers['set-cookie'] || [];
    if (setCookieHeaders.length) {
      const cookieStr = setCookieHeaders
        .map(c => c.split(';')[0])  // strip attributes, keep name=value
        .join('; ');
      // Look for meaningful auth cookies (not just tracking)
      const hasAuthCookie = setCookieHeaders.some(c => {
        const name = c.split('=')[0].toLowerCase().replace(/-/g,'');
        return name.includes('auth') || name.includes('session') || name.includes('.aspnet') ||
               name.includes('identity') || name.includes('user');
      });
      if (hasAuthCookie && cookieStr) {
        // Merge with any existing stored cookie
        const existing = rgSetting('cookie') || '';
        const merged = mergeCookies(existing, cookieStr);
        rgUpsert('cookie', merged);
        rgUpsert('auth_mode', 'session');
        rgUpsert('base_url', 'https://' + RG_PROXY_TARGET);
        startAutoSync();
        console.log('[proxy] Auth cookie captured and saved');
      }
    }

    // Rewrite Location header for redirects
    const respHeaders = { ...proxyRes.headers };
    if (respHeaders['location']) {
      respHeaders['location'] = respHeaders['location']
        .replace(`https://${RG_PROXY_TARGET}`, RG_PROXY_BASE)
        .replace(`http://${RG_PROXY_TARGET}`,  RG_PROXY_BASE);
    }
    // Remove security headers that would break the proxy
    delete respHeaders['content-security-policy'];
    delete respHeaders['x-frame-options'];
    delete respHeaders['strict-transport-security'];

    const ct = (respHeaders['content-type'] || '');
    const isHtml = ct.includes('text/html');
    const isText = isHtml || ct.includes('text/css') || ct.includes('javascript') || ct.includes('json');

    if (!isText) {
      // Binary — stream straight through
      res.writeHead(proxyRes.statusCode, respHeaders);
      proxyRes.pipe(res);
      return;
    }

    // Text — collect, rewrite, send
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (isHtml) {
        // Rewrite absolute URLs to go through our proxy
        body = body
          .replace(/https:\/\/${RG_PROXY_TARGET}/g, RG_PROXY_BASE)
          .replace(/http:\/\/${RG_PROXY_TARGET}/g,  RG_PROXY_BASE);
        // Inject a small banner so the user knows they're in the proxy
        const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;
          background:#1B2A4A;color:#fff;font-family:sans-serif;font-size:13px;
          padding:8px 16px;display:flex;align-items:center;gap:10px">
          <span>🔧 <strong>Rota App proxy</strong> — Log in below. Your session will be saved automatically.</span>
          <a href="/" style="margin-left:auto;color:#FFD600;text-decoration:none;font-weight:700">← Back to Rota App</a>
        </div>
        <div style="height:38px"></div>`;
        body = body.replace('<body', '<body').replace(/(<body[^>]*>)/i, `\$1${banner}`);
      }
      delete respHeaders['content-length']; // length may have changed
      res.writeHead(proxyRes.statusCode, respHeaders);
      res.end(body);
    });
  });

  proxyReq.on('error', (e) => {
    console.error('[proxy] error:', e.message);
    res.status(502).send('Proxy error: ' + e.message);
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

// Helper: merge two cookie strings, newer values win
function mergeCookies(existing, incoming) {
  const map = new Map();
  for (const part of (existing + '; ' + incoming).split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// GET /api/rotageek/status — check if connected
app.get('/api/rotageek/status', (req, res) => {
  const token     = rgSetting('token');
  const cookie    = rgSetting('cookie');
  const base_url  = rgSetting('base_url');
  const username  = rgSetting('username');
  const auth_mode = rgSetting('auth_mode');
  const sessionExpired = rgSetting('session_expired') === '1';
  res.json({
    connected:       !!(token || cookie),
    session_expired: sessionExpired,
    auth_mode:       auth_mode || null,
    token:           token || null,
    base_url:        base_url || 'https://screwfix.rotageek.com',
    username:        username || null,
  });
});

// POST /api/rotageek/fetch — proxy a request to Rotageek (Bearer or session auth)
app.post('/api/rotageek/fetch', async (req, res) => {
  const token     = rgSetting('token');
  const cookie    = rgSetting('cookie');
  const csrf      = rgSetting('csrf_token');
  const auth_mode = rgSetting('auth_mode') || 'token';
  if (!token && !cookie) return res.status(401).json({ error: 'Not connected to Rotageek' });
  const base_url = rgSetting('base_url') || RG_DEFAULT_URL;
  const { path: rgPath, params } = req.body;
  if (!rgPath) return res.status(400).json({ error: 'path required' });
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const fullUrl = `${base_url}${rgPath}${qs}`;
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (auth_mode === 'session' && cookie) {
    headers['Cookie'] = cookie;
    if (csrf) headers['requestverificationtoken'] = csrf;
    headers['X-Requested-With'] = 'XMLHttpRequest';
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  try {
    const r = await fetch(fullUrl, { headers });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch(_) { data = { raw: text }; }
    res.status(r.ok ? 200 : r.status).json(data);
  } catch(e) { res.status(502).json({ error: 'Fetch failed: ' + e.message }); }
});

// POST /api/rotageek/import-schedule — import parsed shifts from Rotageek response
app.post('/api/rotageek/import-schedule', (req, res) => {
  const { shifts: rgShifts = [] } = req.body;
  if (!Array.isArray(rgShifts) || !rgShifts.length) {
    return res.status(400).json({ error: 'shifts array required' });
  }

  const defaultDist = parseFloat(
    db.prepare("SELECT value FROM settings WHERE key='default_distance_miles'").get()?.value || 3.6
  );

  let imported = 0, skipped = 0;
  const errors = [];
  const insertShift = db.prepare(`
    INSERT OR IGNORE INTO shifts
      (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
       distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, completed, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const doImport = db.transaction(() => {
    for (const s of rgShifts) {
      try {
        const date = s.date;
        const start_time = s.start_time;
        const end_time = s.end_time;
        const breakMins = s.break_minutes || 0;
        if (!date || !start_time || !end_time) { skipped++; continue; }
        const rateRecord = getPayRateForDate(date);
        const hourly_rate = rateRecord ? rateRecord.hourly_rate : null;
        const hours_worked = calcHoursWorked(start_time, end_time, breakMins);
        const hours_paid   = calcHoursWorked(start_time, end_time, breakMins);
        const calculated_pay = hourly_rate ? Math.round(hours_paid * hourly_rate * 100) / 100 : null;
        insertShift.run(date, start_time, end_time, breakMins, 'full', breakMins,
          defaultDist, hourly_rate, hours_worked, hours_paid, calculated_pay, 0, s.notes || null);
        imported++;
      } catch(e) {
        errors.push(e.message);
        skipped++;
      }
    }
  });
  doImport();
  res.json({ imported, skipped, errors });
});

// POST /api/rotageek/graphql-sync — fetch & auto-import your shifts via GraphQL session auth
// Also detects changes vs what's already in the DB and sends ntfy notifications
app.post('/api/rotageek/graphql-sync', async (req, res) => {
  const result = await runRotageekSync({ from: req.body?.from, to: req.body?.to, source: 'manual_sync' });
  res.status(result.error ? 502 : 200).json(result);
});

// Resolve the widest sensible date range: job start (or 2018-01-01) → now + 60 days
function allTimeRange() {
  const jobStart = db.prepare("SELECT value FROM settings WHERE key='job_start_date'").get()?.value;
  const from = (jobStart && /^\d{4}-\d{2}-\d{2}$/.test(jobStart)) ? jobStart : '2018-01-01';
  const to = new Date(); to.setDate(to.getDate() + 60);
  return { from, to: localDateStr(to) };
}

// POST /api/rotageek/diff-all — read-only comparison across all time; reports differences, writes nothing
app.post('/api/rotageek/diff-all', async (req, res) => {
  const range = allTimeRange();
  const from = req.body?.from || range.from;
  const to   = req.body?.to   || range.to;
  const result = await runRotageekSync({ from, to, source: 'diff_all', compareOnly: true });
  res.status(result.error ? 502 : 200).json(result);
});

// POST /api/rotageek/sync-all — apply a full-history sync (job start → now + 60 days)
app.post('/api/rotageek/sync-all', async (req, res) => {
  const range = allTimeRange();
  const from = req.body?.from || range.from;
  const to   = req.body?.to   || range.to;
  const result = await runRotageekSync({ from, to, source: 'sync_all' });
  res.status(result.error ? 502 : 200).json(result);
});

// POST /api/rotageek/apply-diffs — apply a user-selected subset of diffs from the compare report.
// Body: { diffs: [ { type, id?, date, start?, end?, new_start?, new_end?, new_break?, break? }, ... ] }
// Unlike sync-all this WILL change completed shifts when the user explicitly selects them.
app.post('/api/rotageek/apply-diffs', (req, res) => {
  const items = Array.isArray(req.body?.diffs) ? req.body.diffs : [];
  if (!items.length) return res.status(400).json({ error: 'diffs array required' });

  const defaultDist = parseFloat(
    db.prepare("SELECT value FROM settings WHERE key='default_distance_miles'").get()?.value || 3.6
  );

  let applied = 0, skipped = 0;
  const errors = [];
  const gcalUpsertIds = [];   // shift ids to push to Google Calendar after commit
  const gcalDeleteRows = [];  // full shift rows to remove from Google Calendar after commit

  const run = db.transaction(() => {
    for (const d of items) {
      try {
        if (d.type === 'new') {
          const brk = d.break != null ? d.break : autoBreakMinutes(d.start, d.end);
          const rate = getPayRateForDate(d.date);
          const hourly = rate ? rate.hourly_rate : null;
          const hw = calcHoursWorked(d.start, d.end, brk);
          const cp = hourly ? Math.round(hw * hourly * 100) / 100 : null;
          const r = db.prepare(`
            INSERT OR IGNORE INTO shifts
              (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
               distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, completed, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(d.date, d.start, d.end, brk, 'full', brk, defaultDist, hourly, hw, hw, cp, 0, null);
          if (r.changes > 0) {
            const ns = db.prepare('SELECT id FROM shifts WHERE rowid = ?').get(r.lastInsertRowid);
            logAudit({ shift_id: ns?.id, action: 'sync_created', new_values: { date: d.date, start_time: d.start, end_time: d.end }, source: 'apply_diffs' });
            if (ns?.id) gcalUpsertIds.push(ns.id);
            applied++;
          } else { skipped++; }
          continue;
        }

        if (!d.id) { skipped++; continue; }
        const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(d.id);
        if (!sh) { skipped++; continue; }

        if (d.type === 'break') {
          const brk = d.new_break;
          const rate = getPayRateForDate(sh.date);
          const hourly = sh.hourly_rate != null ? sh.hourly_rate : (rate ? rate.hourly_rate : null);
          const effRate = hourly ? hourly * (sh.is_bank_holiday ? 2 : 1) : null;
          const hp = calcHoursWorked(sh.start_time, sh.end_time, brk);
          // For completed shifts keep hours_worked aligned to the corrected break too
          const hw = hp;
          const cp = effRate ? Math.round(hp * effRate * 100) / 100 : null;
          db.prepare(`
            UPDATE shifts SET break_scheduled_minutes=?, break_taken_minutes=?,
              hours_worked=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
            WHERE id=?
          `).run(brk, brk, hw, hp, cp, sh.id);
          logAudit({ shift_id: sh.id, action: 'break_corrected', changed_fields: ['break_scheduled_minutes','break_taken_minutes','hours_worked'],
            old_values: { break_scheduled_minutes: sh.break_scheduled_minutes }, new_values: { break_scheduled_minutes: brk },
            source: 'apply_diffs', note: `Break ${sh.break_scheduled_minutes}m → ${brk}m via selected sync` });
          gcalUpsertIds.push(sh.id);
          applied++;

        } else if (d.type === 'changed' || d.type === 'changed_completed') {
          const brk = d.new_break != null ? d.new_break : sh.break_scheduled_minutes;
          const rate = getPayRateForDate(sh.date);
          const hourly = sh.hourly_rate != null ? sh.hourly_rate : (rate ? rate.hourly_rate : null);
          const effRate = hourly ? hourly * (sh.is_bank_holiday ? 2 : 1) : null;
          const hw = calcHoursWorked(d.new_start, d.new_end, brk);
          const cp = effRate ? Math.round(hw * effRate * 100) / 100 : null;
          db.prepare(`
            UPDATE shifts SET start_time=?, end_time=?, break_scheduled_minutes=?, break_taken_minutes=?,
              hours_worked=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
            WHERE id=?
          `).run(d.new_start, d.new_end, brk, brk, hw, hw, cp, sh.id);
          logAudit({ shift_id: sh.id, action: 'sync_changed', changed_fields: ['start_time','end_time'],
            old_values: { start_time: sh.start_time, end_time: sh.end_time }, new_values: { start_time: d.new_start, end_time: d.new_end },
            source: 'apply_diffs' });
          gcalUpsertIds.push(sh.id);
          applied++;

        } else if (d.type === 'removed' || d.type === 'missing') {
          gcalDeleteRows.push(sh);
          db.prepare('DELETE FROM shifts WHERE id = ?').run(sh.id);
          logAudit({ shift_id: sh.id, action: 'deleted', old_values: { date: sh.date, start_time: sh.start_time, end_time: sh.end_time },
            source: 'apply_diffs', note: d.type === 'missing' ? 'Deleted — not in Rotageek (selected)' : 'Removed from rota (selected)' });
          applied++;
        } else {
          skipped++;
        }
      } catch (e) { errors.push(e.message); skipped++; }
    }
  });
  try { run(); } catch (e) { errors.push(e.message); }

  // Mirror the applied changes to Google Calendar (fire-and-forget, after commit)
  for (const id of gcalUpsertIds) {
    const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (row) gcal.safeUpsert(row);
  }
  for (const row of gcalDeleteRows) gcal.safeDelete(row);

  res.json({ applied, skipped, errors });
});

// Re-authenticate with stored credentials; captures Set-Cookie for session-based GraphQL auth
async function rgReAuth(base_url) {
  const username = rgSetting('username');
  const password = rgSetting('password');
  if (!username || !password) return null;

  const endpoints = [
    { path: '/api/v1/users/sign_in', body: { user: { email: username, password } } },
    { path: '/api/v1/auth',           body: { email: username, password } },
    { path: '/api/v1/sessions',       body: { email: username, password } },
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch(`${base_url}${ep.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(ep.body),
      });
      if (!r.ok) continue;

      // Capture Set-Cookie — Node 18+ supports getSetCookie(); fall back to get()
      const cookies = (typeof r.headers.getSetCookie === 'function')
        ? r.headers.getSetCookie()
        : (r.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+)/).filter(Boolean);

      if (cookies.length) {
        // Join all cookie name=value pairs into a single Cookie header string
        const cookieStr = cookies.map(c => c.split(';')[0].trim()).join('; ');
        rgUpsert('cookie',    cookieStr);
        rgUpsert('auth_mode', 'session');
        console.log('[Rotageek] Re-auth captured new session cookie');
      }

      const data  = await r.json().catch(() => ({}));
      const token = data.access_token || data.token || data.auth_token ||
                    data.user?.token  || data.user?.authentication_token || '';
      if (token) {
        rgUpsert('token',     token);
        rgUpsert('auth_mode', cookies.length ? 'session' : 'credentials');
        console.log('[Rotageek] Re-auth obtained bearer token');
      }

      if (cookies.length || token) return { cookie: cookies.length ? rgSetting('cookie') : null, token };
    } catch (_) { /* try next endpoint */ }
  }
  return null;
}

// Shared sync logic used by both the manual endpoint and the auto-sync scheduler
async function runRotageekSync({ from: fromOverride, to: toOverride, source = 'auto_sync', compareOnly = false } = {}) {
  let cookie   = rgSetting('cookie');
  let csrf     = rgSetting('csrf_token');
  const base_url = (rgSetting('base_url') || 'https://screwfix.rotageek.com').replace(/\/$/, '');

  // If no cookie at all, try to re-auth up front
  if (!cookie) {
    const auth = await rgReAuth(base_url);
    if (!auth) {
      return { error: 'No Rotageek session. Store your password in Settings → Notifications & Auto-Sync, or refresh your session cookie on the Import page.' };
    }
    cookie = auth.cookie || null;
    csrf   = rgSetting('csrf_token');
  }

  const now = new Date();
  const defaultFrom = new Date(now); defaultFrom.setDate(now.getDate() - 7);
  const defaultTo   = new Date(now); defaultTo.setDate(now.getDate() + 60);

  const fromDate = fromOverride || localDateStr(defaultFrom);
  const toDate   = toOverride   || localDateStr(defaultTo);
  const fromStr  = fromDate + 'T00:00:00+00:00';
  const toStr    = toDate   + 'T23:59:59+00:00';

  const gqlBody = JSON.stringify({
    query: `query GetDateRangeSchedule($start: DateTime!, $end: DateTime!) {
      dateRangeSchedule(start: $start, end: $end) {
        userId
        journals { id start end breaks { start end paid } }
      }
    }`,
    variables: { start: fromStr, end: toStr },
  });

  // Build auth headers — try cookie first, bearer token as fallback
  function makeHeaders(useCookie) {
    const h = {
      'Content-Type':     'application/json',
      'Accept':           'application/json',
      'Origin':           base_url,
      'Referer':          base_url + '/',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (useCookie && cookie) {
      h['Cookie'] = cookie;
      if (csrf) h['requestverificationtoken'] = csrf;
    } else {
      const token = rgSetting('token');
      if (token) h['Authorization'] = `Bearer ${token}`;
    }
    return h;
  }

  async function doGqlRequest(headers) {
    const r = await fetch(`${base_url}/api/graphql-userschedules`, {
      method: 'POST', headers, body: gqlBody,
    });
    const data = await r.json().catch(() => null);
    return { status: r.status, ok: r.ok, data };
  }

  let gqlData;
  try {
    // Attempt 1: cookie auth
    let result = await doGqlRequest(makeHeaders(true));

    if (result.status === 401) {
      console.log('[Rotageek] Cookie auth 401 — trying re-auth then bearer token fallback');

      // Try password re-auth (may fail if MFA is required)
      const auth = await rgReAuth(base_url);
      if (auth) {
        cookie = rgSetting('cookie');
        csrf   = rgSetting('csrf_token');
        result = await doGqlRequest(makeHeaders(true));  // Attempt 2: fresh cookie
      }

      // Attempt 3: stored bearer token (works if MFA blocks password re-auth)
      if (result.status === 401) {
        console.log('[Rotageek] Trying stored bearer token on GraphQL endpoint');
        result = await doGqlRequest(makeHeaders(false));
      }

      // Still 401 — session expired, notify user but keep stored credentials intact
      if (result.status === 401) {
        rgUpsert('session_expired', '1');
        const msg = 'Rotageek session expired. Open the Import page, log in to Rotageek Live, and your session will be stored automatically.';
        if (rgSetting('ntfy_disconnect_alert') !== '0') {
          await sendNtfy('Rota sync - session expired', msg, 'high');
        }
        return { error: msg };
      }
    }

    if (!result.ok || !result.data) {
      const isTimeout = result.status === 502 || result.status === 503 || result.status === 504;
      return { error: isTimeout
        ? `Rotageek didn't respond in time (HTTP ${result.status}). This usually happens when the date range is too wide — try a smaller range (a few weeks to a couple of months) and try again.`
        : `Rotageek returned HTTP ${result.status}` };
    }
    if (result.data.errors) {
      return { error: result.data.errors[0]?.message || 'GraphQL error' };
    }
    gqlData = result.data;
  } catch (e) {
    return { error: 'Could not reach Rotageek: ' + e.message };
  }

  const journals = gqlData?.data?.dateRangeSchedule?.journals || [];
  if (!journals.length) {
    rgUpsert('autosync_last_run',    new Date().toISOString());
    rgUpsert('autosync_last_result', JSON.stringify({ imported: 0, changed: 0, message: 'No shifts found' }));
    return { imported: 0, changed: 0, skipped: 0, errors: [], message: 'No shifts found in that date range' };
  }

  const defaultDist = parseFloat(
    db.prepare("SELECT value FROM settings WHERE key='default_distance_miles'").get()?.value || 3.6
  );

  // Bank holidays are needed so synced shifts get is_bank_holiday (double pay) set
  // automatically — fetched here (outside the sync transaction, since it's async).
  const bankHolidays = await getUkBankHolidays();

  // Build a map of Rotageek journals grouped by date
  const rgByDate = {};
  for (const j of journals) {
    const date       = j.start.slice(0, 10);
    const start_time = j.start.slice(11, 16);
    const end_time   = j.end.slice(11, 16);

    let breakMins = 0;
    for (const b of (j.breaks || [])) {
      if (b.paid === false) breakMins += Math.round((new Date(b.end) - new Date(b.start)) / 60000);
    }
    if (!j.breaks?.length) {
      // No break data from Rotageek — apply the same thresholds as autoBreakMinutes:
      // ≤4h30 → 0, over 4h30–6h → 15, over 6h–8h → 30, over 8h → 45 (strict > boundaries)
      const totalMins = Math.round((new Date(j.end) - new Date(j.start)) / 60000);
      if (totalMins > 480)      breakMins = 45;
      else if (totalMins > 360) breakMins = 30;
      else if (totalMins > 270) breakMins = 15;
    }

    if (!rgByDate[date]) rgByDate[date] = [];
    rgByDate[date].push({ date, start_time, end_time, breakMins, rgId: j.id });
  }

  let imported = 0, changed = 0, skipped = 0;
  const gcalUpsertIds = [];   // shift ids to push to Google Calendar after the sync applies
  const gcalDeleteRows = [];  // full shift rows to remove from Google Calendar after the sync applies
  const errors = [];
  const changeMessages = [];
  const diffs = [];  // read-only record of every difference found (used by compare/diff-all)

  const doSync = db.transaction(() => {
    for (const [date, rgShifts] of Object.entries(rgByDate)) {
      // Include completed shifts — a past shift may have been retroactively changed on Rotageek
      const dbShifts = db.prepare(
        "SELECT * FROM shifts WHERE date = ? ORDER BY start_time"
      ).all(date);

      const dbKey = s => `${s.start_time}-${s.end_time}`;
      const rgKey = s => `${s.start_time}-${s.end_time}`;

      const dbSet = new Set(dbShifts.map(dbKey));
      const rgSet = new Set(rgShifts.map(rgKey));
      // DB shifts already accounted for (matched or changed) so the DB-only loop
      // below doesn't ALSO report/delete them as "removed".
      const consumedDbIds = new Set();

      // Shifts only in RG → new/changed
      for (const rg of rgShifts) {
        if (dbSet.has(rgKey(rg))) {
          // Times match — check whether the break length differs from Rotageek
          const existing = dbShifts.find(d => dbKey(d) === rgKey(rg));
          if (existing) consumedDbIds.add(existing.id);
          if (existing && existing.break_scheduled_minutes !== rg.breakMins) {
            // Record the difference for the report (covers completed shifts too)
            diffs.push({ id: existing.id, date, type: 'break', start: rg.start_time, end: rg.end_time,
              old_break: existing.break_scheduled_minutes, new_break: rg.breakMins,
              completed: !!existing.completed });
            // Only auto-apply to incomplete shifts; completed shifts are left untouched
            if (!compareOnly && existing.completed === 0) {
              const rateRecord   = getPayRateForDate(date);
              const hourly_rate  = rateRecord ? rateRecord.hourly_rate : null;
              const hw = calcHoursWorked(rg.start_time, rg.end_time, rg.breakMins);
              // Never un-flag a shift someone manually marked as a bank holiday — only add the flag
              const isBH = existing.is_bank_holiday || (bankHolidays.has(date) ? 1 : 0);
              const effRate = hourly_rate ? hourly_rate * (isBH ? 2 : 1) : null;
              const cp = effRate ? Math.round(hw * effRate * 100) / 100 : null;
              db.prepare(`
                UPDATE shifts
                SET break_scheduled_minutes=?, break_taken_minutes=?,
                    hours_worked=?, hours_paid=?, calculated_pay=?, is_bank_holiday=?, updated_at=datetime('now')
                WHERE id=?
              `).run(rg.breakMins, rg.breakMins, hw, hw, cp, isBH, existing.id);
              logAudit({
                shift_id: existing.id,
                action: 'sync_break_updated',
                changed_fields: ['break_scheduled_minutes','break_taken_minutes','hours_worked'],
                old_values: { break_scheduled_minutes: existing.break_scheduled_minutes },
                new_values: { break_scheduled_minutes: rg.breakMins },
                source,
                note: `Break corrected from ${existing.break_scheduled_minutes}min to ${rg.breakMins}min via Rotageek journal`,
              });
              changed++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        const rateRecord     = getPayRateForDate(date);
        const hourly_rate    = rateRecord ? rateRecord.hourly_rate : null;
        const hours_worked   = calcHoursWorked(rg.start_time, rg.end_time, rg.breakMins);
        const hours_paid     = calcHoursWorked(rg.start_time, rg.end_time, rg.breakMins);
        const isBankHolDate  = bankHolidays.has(date) ? 1 : 0;

        // Check if there's an existing INCOMPLETE shift for this date with different times (= change)
        // Completed shifts are left untouched — times are locked once worked
        const existingForDate = dbShifts.find(d => d.completed === 0 && !rgSet.has(dbKey(d)) && !consumedDbIds.has(d.id));

        if (existingForDate) {
          consumedDbIds.add(existingForDate.id);
          // Never un-flag a shift someone manually marked as a bank holiday — only add the flag
          const isBH = existingForDate.is_bank_holiday || isBankHolDate;
          const effRate = hourly_rate ? hourly_rate * (isBH ? 2 : 1) : null;
          const calculated_pay = effRate ? Math.round(hours_paid * effRate * 100) / 100 : null;
          // It's a change to an incomplete shift
          diffs.push({ id: existingForDate.id, date, type: 'changed', old_start: existingForDate.start_time, old_end: existingForDate.end_time, new_start: rg.start_time, new_end: rg.end_time, new_break: rg.breakMins });
          if (!compareOnly) {
            db.prepare(`
              UPDATE shifts
              SET start_time=?, end_time=?, break_scheduled_minutes=?, break_taken_minutes=?,
                  hours_worked=?, hours_paid=?, calculated_pay=?, is_bank_holiday=?, updated_at=datetime('now')
              WHERE id=?
            `).run(rg.start_time, rg.end_time, rg.breakMins, rg.breakMins, hours_worked, hours_paid, calculated_pay, isBH, existingForDate.id);

            changeMessages.push({ date, old_start: existingForDate.start_time, old_end: existingForDate.end_time, new_start: rg.start_time, new_end: rg.end_time });
            logAudit({
              shift_id: existingForDate.id,
              action: 'sync_changed',
              changed_fields: ['start_time','end_time'],
              old_values: { date, start_time: existingForDate.start_time, end_time: existingForDate.end_time },
              new_values: { date, start_time: rg.start_time, end_time: rg.end_time },
              source,
              note: `Rotageek journal ${rg.rgId}`,
            });
            gcalUpsertIds.push(existingForDate.id);
            changed++;
          }
        } else {
          // It's a new shift
          const effRate = hourly_rate ? hourly_rate * (isBankHolDate ? 2 : 1) : null;
          const calculated_pay = effRate ? Math.round(hours_paid * effRate * 100) / 100 : null;
          diffs.push({ date, type: 'new', start: rg.start_time, end: rg.end_time, break: rg.breakMins });
          if (!compareOnly) {
            try {
              const result = db.prepare(`
                INSERT OR IGNORE INTO shifts
                  (date, start_time, end_time, break_scheduled_minutes, break_taken, break_taken_minutes,
                   distance_miles, hourly_rate, hours_worked, hours_paid, calculated_pay, completed, notes, is_bank_holiday)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              `).run(date, rg.start_time, rg.end_time, rg.breakMins, 'full', rg.breakMins,
                defaultDist, hourly_rate, hours_worked, hours_paid, calculated_pay, 0, null, isBankHolDate);

              if (result.changes > 0) {
                const newShift = db.prepare('SELECT * FROM shifts WHERE rowid = ?').get(result.lastInsertRowid);
                logAudit({ shift_id: newShift?.id, action: 'sync_created', new_values: { date, start_time: rg.start_time, end_time: rg.end_time }, source });
                if (newShift?.id) gcalUpsertIds.push(newShift.id);
                imported++;
              } else {
                skipped++;
              }
            } catch (e) { errors.push(e.message); skipped++; }
          } else {
            imported++;  // counts as "would import" in compare mode
          }
        }
      }

      // Shifts only in DB (for this date, not in RG)
      for (const dbS of dbShifts) {
        if (consumedDbIds.has(dbS.id)) continue;  // already matched or changed above
        if (!rgSet.has(dbKey(dbS))) {
          if (dbS.completed === 0 && date >= fromDate) {
            // Future/current incomplete shift removed from Rotageek
            diffs.push({ id: dbS.id, date: dbS.date, type: 'removed', old_start: dbS.start_time, old_end: dbS.end_time });
            if (!compareOnly) {
              gcalDeleteRows.push(dbS);
              db.prepare('DELETE FROM shifts WHERE id = ?').run(dbS.id);
              logAudit({
                shift_id: dbS.id,
                action: 'deleted',
                old_values: { date: dbS.date, start_time: dbS.start_time, end_time: dbS.end_time },
                source,
                note: 'Removed — no longer in Rotageek',
              });
              changeMessages.push({ date: dbS.date, type: 'removed', old_start: dbS.start_time, old_end: dbS.end_time });
            }
          } else {
            // Past/completed shift missing — record + log once, never delete
            diffs.push({ id: dbS.id, date: dbS.date, type: 'missing', old_start: dbS.start_time, old_end: dbS.end_time, completed: !!dbS.completed });
            if (!compareOnly) {
              const recentMissing = db.prepare(`
                SELECT id FROM shift_audit_log
                WHERE shift_id=? AND action='sync_missing'
                AND created_at >= datetime('now', '-2 hours')
              `).get(dbS.id);
              if (!recentMissing) {
                logAudit({ shift_id: dbS.id, action: 'sync_missing', old_values: { date: dbS.date, start_time: dbS.start_time, end_time: dbS.end_time }, source, note: 'Not returned by Rotageek' });
              }
            }
          }
        }
      }
    }
  });

  try { doSync(); } catch (e) { errors.push(e.message); }

  if (compareOnly) {
    // Merge same-date "new" + "missing(completed)" into a single "time changed (completed)"
    // entry. These pairs occur when a completed (time-locked) shift's times changed in
    // Rotageek — splitting them is confusing and applying "new" would create a duplicate.
    const byDate = {};
    for (const d of diffs) { (byDate[d.date] ||= []).push(d); }
    const merged = [];
    const consumed = new Set();
    for (const d of diffs) {
      if (consumed.has(d)) continue;
      if (d.type === 'new') {
        const pair = (byDate[d.date] || []).find(x => x.type === 'missing' && !consumed.has(x));
        if (pair) {
          consumed.add(d); consumed.add(pair);
          merged.push({
            id: pair.id, date: d.date, type: 'changed_completed',
            old_start: pair.old_start, old_end: pair.old_end,
            new_start: d.start, new_end: d.end, new_break: d.break,
            completed: true,
          });
          continue;
        }
      }
      merged.push(d);
    }
    // Read-only comparison — don't notify or persist last-run state
    return { compareOnly: true, imported, changed, skipped, errors, total: journals.length, from: fromDate, to: toDate, diffs: merged };
  }

  // Send ntfy notification for each changed/removed shift individually
  for (const chg of changeMessages) {
    if (!chg.date) continue;
    const d = new Date(chg.date + 'T00:00:00');
    const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    if (chg.type === 'removed') {
      await sendNtfy(`Shift removed - ${dayLabel}`, `Shift ${chg.old_start}-${chg.old_end} has been removed from your rota`, 'high');
    } else {
      const title = `Shift updated - ${dayLabel}`;
      const body  = `Was: ${chg.old_start}-${chg.old_end}\nNow: ${chg.new_start}-${chg.new_end}`;
      await sendNtfy(title, body, 'high');
    }
  }
  // Also send a summary if new shifts were added
  if (imported > 0) {
    await sendNtfy(`Rota sync - ${imported} new shift${imported > 1 ? 's' : ''} added`, `${imported} new shift${imported > 1 ? 's' : ''} imported from Rotageek`, 'default');
  }

  const summary = { imported, changed, skipped, errors, total: journals.length, from: fromDate, to: toDate, changeDetails: changeMessages, diffs };
  rgUpsert('autosync_last_run',    new Date().toISOString());
  rgUpsert('autosync_last_result', JSON.stringify(summary));

  // Mirror Rotageek-driven changes to Google Calendar (fire-and-forget)
  for (const id of gcalUpsertIds) {
    const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (row) gcal.safeUpsert(row);
  }
  for (const row of gcalDeleteRows) gcal.safeDelete(row);

  return summary;
}

// DELETE /api/rotageek/disconnect — clear stored credentials
app.delete('/api/rotageek/disconnect', (req, res) => {
  ['token', 'base_url', 'username', 'auth_mode', 'cookie', 'csrf_token'].forEach(k =>
    db.prepare('DELETE FROM settings WHERE key = ?').run('rotageek_' + k)
  );
  res.json({ ok: true });
});

// GET /api/rotageek/autosync-status
app.get('/api/rotageek/autosync-status', (req, res) => {
  const lastResult = rgSetting('autosync_last_result');
  res.json({
    enabled:             rgSetting('autosync_enabled')       === '1',
    interval:            parseFloat(rgSetting('autosync_interval_hours') || '1'),
    ntfyTopic:           rgSetting('ntfy_topic')             || '',
    ntfyServer:          rgSetting('ntfy_server')            || 'https://ntfy.sh',
    ntfyEnabled:         rgSetting('ntfy_enabled')           === '1',
    ntfyTimes:           rgSetting('ntfy_times')             || '',
    ntfyDisconnectAlert:   rgSetting('ntfy_disconnect_alert') !== '0',
    ntfyShiftReminders:    rgSetting('ntfy_shift_reminders') || '',
    ntfyJsonReminderEnabled: rgSetting('ntfy_json_reminder_enabled') === '1',
    ntfyJsonReminderTime:    rgSetting('ntfy_json_reminder_time') || '08:00',
    ntfyBirthdayEnabled:     rgSetting('ntfy_birthday_enabled') === '1',
    ntfyBirthdayTime:        rgSetting('ntfy_birthday_time') || '08:00',
    ntfyArrivalEnabled:      rgSetting('ntfy_arrival_enabled') === '1',
    ntfyArrivalLeadMins:     parseInt(rgSetting('ntfy_arrival_lead_mins') || '10', 10),
    ntfyArrivalOnlyOnShift:  rgSetting('ntfy_arrival_only_on_shift') !== '0',
    ntfyWeatherEnabled:      rgSetting('ntfy_weather_enabled') === '1',
    ntfyWeatherTime:         rgSetting('ntfy_weather_time') || '19:00',
    running:             !!autoSyncTimer,
    lastRun:             rgSetting('autosync_last_run')      || null,
    lastResult:          lastResult ? JSON.parse(lastResult) : null,
  });
});

// POST /api/rotageek/autosync-config
app.post('/api/rotageek/autosync-config', (req, res) => {
  const { enabled, interval_hours, ntfy_topic, ntfy_server, ntfy_enabled, ntfy_times, ntfy_disconnect_alert, ntfy_shift_reminders, ntfy_json_reminder_enabled, ntfy_json_reminder_time, ntfy_birthday_enabled, ntfy_birthday_time, ntfy_arrival_enabled, ntfy_arrival_lead_mins, ntfy_arrival_only_on_shift, ntfy_weather_enabled, ntfy_weather_time, password } = req.body;
  if (enabled !== undefined)               rgUpsert('autosync_enabled',         enabled ? '1' : '0');
  if (interval_hours !== undefined)        rgUpsert('autosync_interval_hours',   String(interval_hours));
  if (ntfy_topic !== undefined)            rgUpsert('ntfy_topic',               ntfy_topic);
  if (ntfy_server !== undefined)           rgUpsert('ntfy_server',              ntfy_server || 'https://ntfy.sh');
  if (ntfy_enabled !== undefined)          rgUpsert('ntfy_enabled',             ntfy_enabled ? '1' : '0');
  if (ntfy_times !== undefined)            rgUpsert('ntfy_times',               ntfy_times || '');
  if (ntfy_disconnect_alert !== undefined) rgUpsert('ntfy_disconnect_alert',    ntfy_disconnect_alert ? '1' : '0');
  if (ntfy_shift_reminders !== undefined) rgUpsert('ntfy_shift_reminders',     ntfy_shift_reminders || '');
  if (ntfy_json_reminder_enabled !== undefined) rgUpsert('ntfy_json_reminder_enabled', ntfy_json_reminder_enabled ? '1' : '0');
  if (ntfy_json_reminder_time !== undefined)    rgUpsert('ntfy_json_reminder_time',    ntfy_json_reminder_time || '08:00');
  if (ntfy_birthday_enabled !== undefined) rgUpsert('ntfy_birthday_enabled',    ntfy_birthday_enabled ? '1' : '0');
  if (ntfy_birthday_time !== undefined)    rgUpsert('ntfy_birthday_time',       ntfy_birthday_time || '08:00');
  if (ntfy_arrival_enabled !== undefined)  rgUpsert('ntfy_arrival_enabled',     ntfy_arrival_enabled ? '1' : '0');
  if (ntfy_arrival_lead_mins !== undefined) rgUpsert('ntfy_arrival_lead_mins',  String(parseInt(ntfy_arrival_lead_mins, 10) || 10));
  if (ntfy_arrival_only_on_shift !== undefined) rgUpsert('ntfy_arrival_only_on_shift', ntfy_arrival_only_on_shift ? '1' : '0');
  if (ntfy_weather_enabled !== undefined)  rgUpsert('ntfy_weather_enabled',     ntfy_weather_enabled ? '1' : '0');
  if (ntfy_weather_time !== undefined)     rgUpsert('ntfy_weather_time',        ntfy_weather_time || '19:00');
  if (password)                            rgUpsert('password',                 password);
  startAutoSync();
  startTimeSync();
  startShiftReminderSync();
  startJsonReminderSync();
  startBirthdayReminderSync();
  startArrivalReminderSync();
  startWeatherReminderSync();
  res.json({ ok: true });
});

// POST /api/rotageek/test-ntfy
app.post('/api/rotageek/test-ntfy', async (req, res) => {
  const { topic, server } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const srv = (server || 'https://ntfy.sh').replace(/\/$/, '');
  try {
    const r = await fetch(`${srv}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Title': 'Rota App test', 'Content-Type': 'text/plain' },
      body: 'Test notification from your Rota App! 🎉',
    });
    if (!r.ok) return res.status(r.status).json({ error: `ntfy returned ${r.status}` });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rotageek/test-reminder -- send a test shift reminder notification right now
app.post('/api/rotageek/test-reminder', async (req, res) => {
  const topic   = rgSetting('ntfy_topic');
  const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const enabled = rgSetting('ntfy_enabled') === '1';
  if (!topic)    return res.status(400).json({ error: 'No ntfy topic configured.' });
  if (!enabled)  return res.status(400).json({ error: 'Notifications are disabled. Enable them first.' });
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: '⏰ Shift starting soon', message: 'Test shift reminder — real reminders fire automatically before each shift.', priority: 4 }),
    });
    if (!r.ok) return res.status(r.status).json({ error: `ntfy returned ${r.status}` });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rotageek/test-birthday-reminder -- send a test birthday notification now
app.post('/api/rotageek/test-birthday-reminder', async (req, res) => {
  const topic   = rgSetting('ntfy_topic');
  const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const enabled = rgSetting('ntfy_enabled') === '1';
  if (!topic)    return res.status(400).json({ error: 'No ntfy topic configured.' });
  if (!enabled)  return res.status(400).json({ error: 'Notifications are disabled. Enable them first.' });
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: '🎂 Alex\'s birthday', message: 'Today! (test)', priority: 3 }),
    });
    if (!r.ok) return res.status(r.status).json({ error: `ntfy returned ${r.status}` });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rotageek/test-arrival-reminder -- send a test "about to arrive" notification now
app.post('/api/rotageek/test-arrival-reminder', async (req, res) => {
  const topic   = rgSetting('ntfy_topic');
  const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const enabled = rgSetting('ntfy_enabled') === '1';
  const leadMins = parseInt(rgSetting('ntfy_arrival_lead_mins') || '10', 10) || 10;
  if (!topic)    return res.status(400).json({ error: 'No ntfy topic configured.' });
  if (!enabled)  return res.status(400).json({ error: 'Notifications are disabled. Enable them first.' });
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: '👋 Alex arriving', message: `in ${leadMins}m · 09:00 (test)`, priority: 3 }),
    });
    if (!r.ok) return res.status(r.status).json({ error: `ntfy returned ${r.status}` });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rotageek/test-json-reminder -- send a test weekly JSON-upload reminder now
app.post('/api/rotageek/test-json-reminder', async (req, res) => {
  const topic   = rgSetting('ntfy_topic');
  const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const enabled = rgSetting('ntfy_enabled') === '1';
  if (!topic)    return res.status(400).json({ error: 'No ntfy topic configured.' });
  if (!enabled)  return res.status(400).json({ error: 'Notifications are disabled. Enable them first.' });
  try {
    const r = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: '\ud83d\udcf8 Upload last week\'s team JSON', message: 'Grab a screenshot of last week\'s Rotageek team schedule, run it through Team Upload, and paste in the JSON \u2014 keeps everyone\'s Team Calendar accurate.', priority: 4 }),
    });
    if (!r.ok) return res.status(r.status).json({ error: `ntfy returned ${r.status}` });
    res.json({ ok: true });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// POST /api/rotageek/autosync -- run sync now (called from Notifications page)
app.post('/api/rotageek/autosync', async (req, res) => {
  const result = await runRotageekSync({ source: 'manual_sync' });
  res.status(result.error ? 502 : 200).json(result);
});

// -----------------------------------------
// AUTO-SYNC SCHEDULER
// -----------------------------------------

let autoSyncTimer = null;

function startAutoSync() {
  stopAutoSync();
  const enabled  = rgSetting('autosync_enabled');
  const interval = parseFloat(rgSetting('autosync_interval_hours') || '1') * 60 * 60 * 1000;
  if (enabled !== '1') return;
  console.log(`[AutoSync] Starting -- interval ${interval / 3600000}h`);
  autoSyncTimer = setInterval(async () => {
    console.log('[AutoSync] Running scheduled sync...');
    const result = await runRotageekSync({ source: 'auto_sync' });
    if (result.error) {
      console.error('[AutoSync] Error:', result.error);
      sendNtfy('Rota auto-sync failed', result.error, 'high');
    } else {
      console.log(`[AutoSync] Done -- imported:${result.imported} changed:${result.changed}`);
    }
  }, interval);
}

function stopAutoSync() {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

// Time-based notification scheduler
// Fires a sync at specific times of day (ntfy_times = "HH:MM,HH:MM" in settings)
let timeSyncTimer = null;
const timeSyncLastFired = {};

function startTimeSync() {
  if (timeSyncTimer) { clearInterval(timeSyncTimer); timeSyncTimer = null; }
  timeSyncTimer = setInterval(async () => {
    const timesStr = rgSetting('ntfy_times');
    if (!timesStr) return;
    const times = timesStr.split(',').map(t => t.trim()).filter(Boolean);
    if (!times.length) return;
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (!times.includes(hhmm)) return;
    // Deduplicate: only fire once per minute per time slot
    const key = now.toDateString() + hhmm;
    if (timeSyncLastFired[key]) return;
    timeSyncLastFired[key] = true;
    // Clear stale entries
    Object.keys(timeSyncLastFired).forEach(k => { if (k !== key) delete timeSyncLastFired[k]; });
    console.log(`[TimeSync] Firing scheduled sync at ${hhmm}`);
    const result = await runRotageekSync({ source: 'time_sync' });
    if (result.error) console.error('[TimeSync] Error:', result.error);
    else console.log(`[TimeSync] Done -- imported:${result.imported} changed:${result.changed}`);
  }, 30000); // check every 30 seconds
}

// Shift-reminder notification scheduler
// Fires an ntfy push N minutes before each upcoming shift start
let shiftReminderTimer = null;
const shiftReminderFired = {}; // key: `${date}_${startTime}_${mins}` → true

function startShiftReminderSync() {
  if (shiftReminderTimer) { clearInterval(shiftReminderTimer); shiftReminderTimer = null; }
  shiftReminderTimer = setInterval(async () => {
    const topic    = rgSetting('ntfy_topic');
    const server   = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
    const enabled  = rgSetting('ntfy_enabled') === '1';
    const remStr   = rgSetting('ntfy_shift_reminders');
    if (!topic || !enabled || !remStr) return;

    const reminders = remStr.split(',').map(m => parseInt(m.trim())).filter(m => m > 0);
    if (!reminders.length) return;

    const now = new Date();
    const todayStr    = localDateStr();
    const tomorrow    = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.getFullYear() + '-'
      + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-'
      + String(tomorrow.getDate()).padStart(2, '0');

    const shifts = db.prepare(
      "SELECT date, start_time FROM shifts WHERE date IN (?, ?) AND start_time IS NOT NULL ORDER BY date, start_time"
    ).all(todayStr, tomorrowStr);

    // How late a tick may be and still send a given reminder. The old code used a
    // rigid 90s window: if a tick was even slightly delayed the reminder was silently
    // dropped. We widen this so a briefly-busy/restarted server still sends, while
    // still bounding lateness so a restart can't dump a pile of stale reminders.
    const GRACE_MS = 8 * 60000; // 8 minutes

    for (const shift of shifts) {
      const shiftMs  = new Date(`${shift.date}T${shift.start_time}:00`).getTime();

      // NEVER announce a shift as "upcoming" once it has already started. This is the
      // key fix for "got a 'starts in an hour' notification AFTER the shift began":
      // if our tick is delayed past the start time we simply skip rather than lie.
      if (now.getTime() >= shiftMs) continue;

      const dayLabel = shift.date === todayStr ? 'today' : 'tomorrow';

      for (const mins of reminders) {
        const fireAt = shiftMs - mins * 60000;
        const lateBy = now.getTime() - fireAt;
        if (lateBy < 0)        continue; // not yet time for this reminder
        if (lateBy > GRACE_MS) continue; // tick missed by too much — don't fire stale

        const key = `${shift.date}_${shift.start_time}_${mins}`;
        if (shiftReminderFired[key]) continue;
        shiftReminderFired[key] = true;
        // Prune old keys
        const cutoff = now.getTime() - 3600000;
        Object.keys(shiftReminderFired).forEach(k => {
          const parts = k.split('_'); // date_HH:MM_mins
          const d = new Date(`${parts[0]}T${parts[1]}:00`).getTime();
          if (d < cutoff) delete shiftReminderFired[k];
        });

        // Compute the label from the ACTUAL time remaining at send, not the configured
        // value — so even if the tick ran a few minutes late the message stays truthful.
        const minsLeft = Math.max(1, Math.round((shiftMs - now.getTime()) / 60000));
        const label = minsLeft >= 60
          ? (minsLeft % 60 === 0 ? `${minsLeft / 60}h` : `${Math.floor(minsLeft/60)}h ${minsLeft%60}m`)
          : `${minsLeft} min`;
        try {
          await fetch(server, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Lead with the absolute start time: if a push is delivered late by the
            // phone (Android Doze / ntfy queue), the real time is still front-and-centre.
            body: JSON.stringify({ topic, title: `⏰ Shift at ${shift.start_time} ${dayLabel}`, message: `Starts in ${label} (${shift.start_time} ${dayLabel})`, priority: 4 }),
          });
          console.log(`[ShiftReminder] Sent ${new Date().toISOString()} for ${shift.date} ${shift.start_time} — scheduled ${mins}m, actual ${minsLeft}m left`);
        } catch(e) {
          console.error('[ShiftReminder] ntfy error:', e.message);
        }
      }
    }
  }, 30000);
}

// Weekly "upload last week's team JSON" reminder
// Fires once, on the configured day/time, reminding Ed to run last week's Rotageek
// team screenshot through Team Upload -- the most reliable way to keep the shared
// Team Calendar current since there's no live Rotageek team feed.
let jsonReminderTimer = null;
const jsonReminderLastFired = {}; // key: ISO week string ("2026-W27") -> true

function _isoWeekKey(d) {
  // Monday-based week key, stable across the whole week (Mon-Sun)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${weekNum}`;
}

function startJsonReminderSync() {
  if (jsonReminderTimer) { clearInterval(jsonReminderTimer); jsonReminderTimer = null; }
  jsonReminderTimer = setInterval(async () => {
    const topic   = rgSetting('ntfy_topic');
    const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
    const enabled = rgSetting('ntfy_enabled') === '1';
    const jrEnabled = rgSetting('ntfy_json_reminder_enabled') === '1';
    if (!topic || !enabled || !jrEnabled) return;

    const now = new Date();
    if (now.getDay() !== 1) return; // Monday only -- the week just completed ended yesterday

    const targetTime = rgSetting('ntfy_json_reminder_time') || '08:00';
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (hhmm !== targetTime) return;

    const key = _isoWeekKey(now);
    if (jsonReminderLastFired[key]) return;
    jsonReminderLastFired[key] = true;
    Object.keys(jsonReminderLastFired).forEach(k => { if (k !== key) delete jsonReminderLastFired[k]; });

    try {
      await fetch(server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          title: '\ud83d\udcf8 Upload last week\'s team JSON',
          message: 'Grab a screenshot of last week\'s Rotageek team schedule, run it through Team Upload, and paste in the JSON \u2014 keeps everyone\'s Team Calendar accurate.',
          priority: 4,
        }),
      });
      console.log(`[JsonReminder] Sent ${new Date().toISOString()} for week ${key}`);
    } catch (e) {
      console.error('[JsonReminder] ntfy error:', e.message);
    }
  }, 30000);
}

// Colleague birthday reminder — fires once a day at the configured time for any
// active colleague whose birthday (MM-DD) is today. Kept short for watch notifications.
let birthdayReminderTimer = null;
const birthdayReminderLastFired = {}; // key: "YYYY-MM-DD" -> true (any birthday sent that day)

function startBirthdayReminderSync() {
  if (birthdayReminderTimer) { clearInterval(birthdayReminderTimer); birthdayReminderTimer = null; }
  birthdayReminderTimer = setInterval(async () => {
    const topic   = rgSetting('ntfy_topic');
    const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
    const enabled = rgSetting('ntfy_enabled') === '1';
    const bdEnabled = rgSetting('ntfy_birthday_enabled') === '1';
    if (!topic || !enabled || !bdEnabled) return;

    const now = new Date();
    const targetTime = rgSetting('ntfy_birthday_time') || '08:00';
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (hhmm !== targetTime) return;

    const todayStr = localDateStr();
    const key = todayStr;
    if (birthdayReminderLastFired[key]) return;

    const mmdd = todayStr.slice(5); // MM-DD
    const people = db.prepare(
      `SELECT name, birthday FROM colleagues
       WHERE birthday IS NOT NULL AND birthday != '' AND left_date IS NULL
         AND substr(birthday, 6, 5) = ?`
    ).all(mmdd);

    birthdayReminderLastFired[key] = true;
    Object.keys(birthdayReminderLastFired).forEach(k => { if (k !== key) delete birthdayReminderLastFired[k]; });
    if (!people.length) return;

    for (const p of people) {
      const firstName = p.name.split(' ')[0];
      try {
        await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, title: `🎂 ${firstName}'s birthday`, message: 'Today!', priority: 3 }),
        });
        console.log(`[BirthdayReminder] Sent ${new Date().toISOString()} for ${p.name}`);
      } catch (e) {
        console.error('[BirthdayReminder] ntfy error:', e.message);
      }
    }
  }, 30000);
}

// Commute weather nudge — the evening before a shift, check whether the commute
// forecast has a frost/rain alert and push it, instead of only showing it if you
// happen to open the dashboard. Uses the same alert logic as the per-shift badge.
let weatherReminderTimer = null;
const weatherReminderLastFired = {}; // key: "YYYY-MM-DD" -> true

function startWeatherReminderSync() {
  if (weatherReminderTimer) { clearInterval(weatherReminderTimer); weatherReminderTimer = null; }
  weatherReminderTimer = setInterval(async () => {
    const topic   = rgSetting('ntfy_topic');
    const enabled = rgSetting('ntfy_enabled') === '1';
    const wxEnabled = rgSetting('ntfy_weather_enabled') === '1';
    if (!topic || !enabled || !wxEnabled) return;

    const now = new Date();
    const targetTime = rgSetting('ntfy_weather_time') || '19:00';
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (hhmm !== targetTime) return;

    const todayStr = localDateStr();
    if (weatherReminderLastFired[todayStr]) return;
    weatherReminderLastFired[todayStr] = true;
    Object.keys(weatherReminderLastFired).forEach(k => { if (k !== todayStr) delete weatherReminderLastFired[k]; });

    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localDateStr(tomorrow);
    const shift = db.prepare('SELECT start_time FROM shifts WHERE date = ? ORDER BY start_time ASC').get(tomorrowStr);
    if (!shift) return; // not working tomorrow — nothing to warn about

    const homeLat = db.prepare("SELECT value FROM settings WHERE key='commute_home_lat'").get()?.value;
    const homeLon = db.prepare("SELECT value FROM settings WHERE key='commute_home_lon'").get()?.value;
    if (!homeLat || !homeLon) return; // no home location configured

    try {
      const forecast = await fetchHourlyForecast(homeLat, homeLon, tomorrowStr);
      const toTime = new Date(`${tomorrowStr}T${shift.start_time}:00`); toTime.setMinutes(toTime.getMinutes() - 40);
      const point = forecast[nearestHourKey(toTime)];
      if (!point) return;
      const alerts = buildAlerts(point);
      if (!alerts.length) return;
      await sendNtfy(`${alerts[0].icon} Tomorrow's commute`, `${alerts.map(a => a.text).join(' · ')} — shift starts ${shift.start_time}`, 'default');
      console.log(`[WeatherReminder] Sent ${new Date().toISOString()} for ${tomorrowStr}`);
    } catch (e) {
      console.error('[WeatherReminder] error:', e.message);
    }
  }, 30000);
}

// "About to arrive" reminder — a colleague's shift starts within the configured lead
// time (default 10 min). Message kept deliberately short so it fits on a watch screen.
let arrivalReminderTimer = null;
const arrivalReminderFired = {}; // key: colleagueId_date_start -> true

function startArrivalReminderSync() {
  if (arrivalReminderTimer) { clearInterval(arrivalReminderTimer); arrivalReminderTimer = null; }
  arrivalReminderTimer = setInterval(async () => {
    const topic   = rgSetting('ntfy_topic');
    const server  = (rgSetting('ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
    const enabled = rgSetting('ntfy_enabled') === '1';
    const arrEnabled = rgSetting('ntfy_arrival_enabled') === '1';
    if (!topic || !enabled || !arrEnabled) return;

    const leadMins = parseInt(rgSetting('ntfy_arrival_lead_mins') || '10', 10) || 10;
    // Only notify while Ed is on shift (default ON) — a colleague arriving when he's
    // not at work isn't useful. Toggle: ntfy_arrival_only_on_shift ('0' disables).
    const onlyOnShift = rgSetting('ntfy_arrival_only_on_shift') !== '0';
    const now = new Date();
    const todayStr = localDateStr();

    const myShifts = onlyOnShift
      ? db.prepare('SELECT start_time, end_time FROM shifts WHERE date = ?').all(todayStr)
      : null;
    if (onlyOnShift && myShifts.length === 0) return; // not working today — nothing to send

    const rows = db.prepare(
      `SELECT cs.colleague_id, cs.date, cs.start_time, c.name FROM colleague_shifts cs
       JOIN colleagues c ON c.id = cs.colleague_id
       WHERE cs.date = ? AND cs.shift_type = 'shift'
         AND cs.start_time IS NOT NULL AND cs.start_time != '' AND cs.start_time != '00:00'
         AND c.left_date IS NULL`
    ).all(todayStr);

    const GRACE_MS = 5 * 60000; // 5 minutes — allow a briefly-delayed tick to still fire

    for (const row of rows) {
      const startMs = new Date(`${row.date}T${row.start_time}:00`).getTime();
      if (now.getTime() >= startMs) continue; // already arrived/started — never "about to"

      // Skip colleagues arriving outside Ed's own shift window (HH:MM string compare)
      if (onlyOnShift && !myShifts.some(s =>
        s.start_time && s.end_time && row.start_time >= s.start_time && row.start_time <= s.end_time
      )) continue;

      const fireAt = startMs - leadMins * 60000;
      const lateBy = now.getTime() - fireAt;
      if (lateBy < 0 || lateBy > GRACE_MS) continue;

      const key = `${row.colleague_id}_${row.date}_${row.start_time}`;
      if (arrivalReminderFired[key]) continue;
      arrivalReminderFired[key] = true;
      const cutoff = now.getTime() - 3600000;
      Object.keys(arrivalReminderFired).forEach(k => {
        const parts = k.split('_'); // colleagueId_date_HH:MM
        const d = new Date(`${parts[1]}T${parts[2]}:00`).getTime();
        if (d < cutoff) delete arrivalReminderFired[k];
      });

      const firstName = row.name.split(' ')[0];
      const minsLeft = Math.max(1, Math.round((startMs - now.getTime()) / 60000));
      try {
        await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, title: `👋 ${firstName} arriving`, message: `in ${minsLeft}m · ${row.start_time}`, priority: 3 }),
        });
        console.log(`[ArrivalReminder] Sent ${new Date().toISOString()} for ${row.name} (${row.start_time})`);
      } catch (e) {
        console.error('[ArrivalReminder] ntfy error:', e.message);
      }
    }
  }, 30000);
}

// Kick off on startup
startAutoSync();
startTimeSync();
startShiftReminderSync();
startJsonReminderSync();
startBirthdayReminderSync();
startArrivalReminderSync();
startWeatherReminderSync();
startDbBackupSync();
webhooksRouter.startWebhookScheduler();

// -----------------------------------------
// CLOCK IN / OUT
// -----------------------------------------

function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function localTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function _timeToMins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
// On split-shift days (more than one shift scheduled the same date), matching a clock
// event against whichever shift is "first" by start_time picks the wrong shift for the
// second half of the day, producing a bogus large diff. Instead pick the shift whose
// given field (start_time or end_time) is closest to the actual clock time.
function _nearestShiftByField(shiftsForDate, field, targetTime) {
  if (!shiftsForDate || !shiftsForDate.length || !targetTime) return null;
  const targetMins = _timeToMins(targetTime);
  return shiftsForDate.reduce((best, s) =>
    Math.abs(_timeToMins(s[field]) - targetMins) < Math.abs(_timeToMins(best[field]) - targetMins) ? s : best
  );
}

// GET /api/clock/today
app.get('/api/clock/today', (req, res) => {
  const today = localDateStr();
  const entry = db.prepare('SELECT * FROM clock_entries WHERE date = ?').get(today) || null;
  const dayShifts = db.prepare(
    "SELECT id, start_time, end_time, break_scheduled_minutes FROM shifts WHERE date = ? ORDER BY start_time ASC"
  ).all(today);
  const nowMins = _timeToMins(localTimeStr());
  const shift = dayShifts.length
    ? dayShifts.reduce((best, s) => {
        const dist     = Math.min(Math.abs(_timeToMins(s.start_time) - nowMins), Math.abs(_timeToMins(s.end_time) - nowMins));
        const bestDist = Math.min(Math.abs(_timeToMins(best.start_time) - nowMins), Math.abs(_timeToMins(best.end_time) - nowMins));
        return dist < bestDist ? s : best;
      })
    : null;
  res.json({ today, entry, shift });
});

// GET /api/clock/history
app.get('/api/clock/history', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '30', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT * FROM clock_entries ORDER BY date DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  const dates = [...new Set(rows.map(r => r.date))];
  const shiftsByDate = {};
  if (dates.length) {
    const placeholders = dates.map(() => '?').join(',');
    const allShifts = db.prepare(
      `SELECT date, start_time, end_time FROM shifts WHERE date IN (${placeholders}) ORDER BY start_time ASC`
    ).all(...dates);
    for (const s of allShifts) (shiftsByDate[s.date] ||= []).push(s);
  }
  const entries = rows.map(r => {
    const dayShifts = shiftsByDate[r.date] || [];
    const inShift  = _nearestShiftByField(dayShifts, 'start_time', r.clocked_in)  || dayShifts[0] || null;
    const outShift = _nearestShiftByField(dayShifts, 'end_time',   r.clocked_out) || dayShifts[0] || null;
    return { ...r, sched_start: inShift?.start_time || null, sched_end: outShift?.end_time || null };
  });
  res.json({ entries });
});

// POST /api/clock/in
app.post('/api/clock/in', (req, res) => {
  const date = req.body.date || localDateStr();
  const time = req.body.time || localTimeStr();
  const note = req.body.note || null;
  db.prepare(`
    INSERT INTO clock_entries (date, clocked_in, note) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      clocked_in = excluded.clocked_in,
      note = COALESCE(excluded.note, note)
  `).run(date, time, note);
  res.json(db.prepare('SELECT * FROM clock_entries WHERE date = ?').get(date));
});

// POST /api/clock/out
app.post('/api/clock/out', (req, res) => {
  const date = req.body.date || localDateStr();
  const time = req.body.time || localTimeStr();
  const note = req.body.note || null;
  db.prepare(`
    INSERT INTO clock_entries (date, clocked_out, note) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      clocked_out = excluded.clocked_out,
      note = COALESCE(excluded.note, note)
  `).run(date, time, note);
  webhooksRouter.fireShiftEndedWebhook({ end_time: time }).catch(() => {});
  res.json(db.prepare('SELECT * FROM clock_entries WHERE date = ?').get(date));
});

// PATCH /api/clock/:id
app.patch('/api/clock/:id', (req, res) => {
  const { clocked_in, clocked_out, note } = req.body;
  const entry = db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE clock_entries SET
      clocked_in  = COALESCE(?, clocked_in),
      clocked_out = COALESCE(?, clocked_out),
      note        = COALESCE(?, note)
    WHERE id = ?
  `).run(
    clocked_in  !== undefined ? clocked_in  : null,
    clocked_out !== undefined ? clocked_out : null,
    note        !== undefined ? note        : null,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(req.params.id));
});

// DELETE /api/clock/:id
app.delete('/api/clock/:id', (req, res) => {
  db.prepare('DELETE FROM clock_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/clock/analytics
app.get('/api/clock/analytics', (req, res) => {
  const entries = db.prepare(`
    SELECT * FROM clock_entries
    WHERE clocked_in IS NOT NULL AND clocked_out IS NOT NULL
    ORDER BY date ASC
  `).all();

  const dates = [...new Set(entries.map(e => e.date))];
  const shiftsByDate = {};
  if (dates.length) {
    const placeholders = dates.map(() => '?').join(',');
    const allShifts = db.prepare(
      `SELECT date, start_time, end_time FROM shifts WHERE date IN (${placeholders})`
    ).all(...dates);
    for (const s of allShifts) (shiftsByDate[s.date] ||= []).push(s);
  }
  // Match clock-in against whichever shift's start_time it's closest to, and clock-out
  // against whichever shift's end_time it's closest to — independently, since a split
  // shift day means the "first" shift by start_time isn't necessarily the right one for
  // an evening clock-out. Fixes both false early/late flags and inflated extra-time totals.
  const rows = entries.map(e => {
    const dayShifts = shiftsByDate[e.date] || [];
    const inShift  = _nearestShiftByField(dayShifts, 'start_time', e.clocked_in);
    const outShift = _nearestShiftByField(dayShifts, 'end_time',   e.clocked_out);
    return { ...e, sched_start: inShift?.start_time || null, sched_end: outShift?.end_time || null };
  });

  // Clock-in:  Early = >5 min before start | On Time = 0–5 min before | Late = any minute after
  // Clock-out: Early = any minute before end | On Time = 0–5 min after | Late = >5 min after

  let inTotal = 0,  inCount = 0,  inEarly = 0,  inLate = 0,  inOnTime = 0;
  let outTotal = 0, outCount = 0, outEarly = 0, outLate = 0, outOnTime = 0;
  let hoursWorkedTotal = 0, hoursSchedTotal = 0, hoursCount = 0;
  // Total "extra" time actually spent at work outside the scheduled shift window —
  // time clocked in before the scheduled start, plus time clocked out after the
  // scheduled end. Unlike avgOvertime (an average difference), this is a running
  // total of unpaid-schedule minutes, so early-in and late-out both add to it
  // (they never cancel each other out).
  let extraBeforeTotal = 0, extraAfterTotal = 0, extraCount = 0;

  rows.forEach(r => {
    // Arrival diff
    if (r.sched_start && r.clocked_in) {
      const [sh, sm] = r.sched_start.split(':').map(Number);
      const [ch, cm] = r.clocked_in.split(':').map(Number);
      const diff = (ch * 60 + cm) - (sh * 60 + sm);
      inTotal += diff; inCount++;
      if (diff < -5) inEarly++;       // >5 min before start
      else if (diff > 0) inLate++;    // any minute past start
      else inOnTime++;                 // 0–5 min before start
      if (diff < 0) extraBeforeTotal += -diff; // minutes clocked in before scheduled start
    }
    // Departure diff
    if (r.sched_end && r.clocked_out) {
      const [sh, sm] = r.sched_end.split(':').map(Number);
      const [ch, cm] = r.clocked_out.split(':').map(Number);
      const diff = (ch * 60 + cm) - (sh * 60 + sm);
      outTotal += diff; outCount++;
      if (diff < 0) outEarly++;       // left before end
      else if (diff > 5) outLate++;   // >5 min after end
      else outOnTime++;                // 0–5 min after end
      if (diff > 0) extraAfterTotal += diff; // minutes clocked out after scheduled end
    }
    if ((r.sched_start && r.clocked_in) || (r.sched_end && r.clocked_out)) extraCount++;
    // Hours worked vs scheduled
    if (r.clocked_in && r.clocked_out && r.sched_start && r.sched_end) {
      const [ci_h, ci_m] = r.clocked_in.split(':').map(Number);
      const [co_h, co_m] = r.clocked_out.split(':').map(Number);
      const [ss_h, ss_m] = r.sched_start.split(':').map(Number);
      const [se_h, se_m] = r.sched_end.split(':').map(Number);
      hoursWorkedTotal += (co_h * 60 + co_m) - (ci_h * 60 + ci_m);
      hoursSchedTotal  += (se_h * 60 + se_m) - (ss_h * 60 + ss_m);
      hoursCount++;
    }
  });

  res.json({
    entries: rows,
    stats: {
      // Arrival
      count: inCount,
      avgDiffMins: inCount ? Math.round(inTotal / inCount) : 0,
      earlyCount: inEarly, onTimeCount: inOnTime, lateCount: inLate,
      // Departure
      outCount,
      avgOutDiffMins: outCount ? Math.round(outTotal / outCount) : 0,
      earlyOutCount: outEarly, onTimeOutCount: outOnTime, lateOutCount: outLate,
      // Hours
      hoursCount,
      avgWorkedMins: hoursCount ? Math.round(hoursWorkedTotal / hoursCount) : 0,
      avgSchedMins:  hoursCount ? Math.round(hoursSchedTotal  / hoursCount) : 0,
      // Total extra time (early-in + late-out minutes, summed rather than averaged)
      extraCount,
      totalExtraBeforeMins: extraBeforeTotal,
      totalExtraAfterMins:  extraAfterTotal,
      totalExtraMins: extraBeforeTotal + extraAfterTotal,
    },
  });
});

// -----------------------------------------
// NFC / QUICK-TAP CLOCK IN-OUT
// -----------------------------------------
// A plain GET page (not /api/...) designed to be written to an NFC tag — tapping
// your phone on the tag opens this URL directly with no app needed. Each tap
// toggles: not clocked in today -> clock in, clocked in -> clock out, already both
// set today -> updates the clock-out time (same as "Re-clock Out" in the app).
// Protected by a token from Settings, since this is an unauthenticated GET with a
// side effect and phones will happily open it in the background.
function nfcTapPage(title, body, color = '#2e9e5b') {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1420;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  .card{max-width:340px}
  h1{font-size:22px;margin:0 0 10px;color:${color}}
  p{color:#9aa4b8;font-size:14px;line-height:1.5}
  a{color:#5b9dff}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p><p><a href="/">Open Rota App</a></p></div></body></html>`;
}

app.get('/clock-tap', (req, res) => {
  const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'nfc_clock_token'").get();
  const configuredToken = tokenRow && tokenRow.value && tokenRow.value.trim();
  if (!configuredToken) {
    return res.send(nfcTapPage('Not set up yet', 'No NFC clock-in token is configured. Set one up in Settings → NFC Clock In/Out first.', '#e5a13c'));
  }
  if (!req.query.token || req.query.token !== configuredToken) {
    return res.status(403).send(nfcTapPage('Not authorised', "This link's token doesn't match what's configured in Settings.", '#e5573c'));
  }

  const today = localDateStr();
  const time  = localTimeStr();
  const entry = db.prepare('SELECT * FROM clock_entries WHERE date = ?').get(today);

  let title, body;
  if (!entry || !entry.clocked_in) {
    db.prepare(`
      INSERT INTO clock_entries (date, clocked_in) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET clocked_in = excluded.clocked_in
    `).run(today, time);
    title = '✅ Clocked in';
    body  = `Recorded at ${time}.`;
  } else if (!entry.clocked_out) {
    db.prepare('UPDATE clock_entries SET clocked_out = ? WHERE date = ?').run(time, today);
    webhooksRouter.fireShiftEndedWebhook({ end_time: time }).catch(() => {});
    title = '👋 Clocked out';
    body  = `Recorded at ${time}. Open the app to log your break if you took one.`;
  } else {
    db.prepare('UPDATE clock_entries SET clocked_out = ? WHERE date = ?').run(time, today);
    title = '🔁 Clock-out updated';
    body  = `Updated to ${time}.`;
  }
  res.send(nfcTapPage(title, body));
});

// -----------------------------------------
// TAX REFUNDS API
// -----------------------------------------

app.get('/api/tax-refunds', (req, res) => {
  const { tax_year } = req.query;
  const rows = tax_year
    ? db.prepare('SELECT * FROM tax_refunds WHERE tax_year = ? ORDER BY date DESC').all(tax_year)
    : db.prepare('SELECT * FROM tax_refunds ORDER BY tax_year DESC, date DESC').all();
  res.json(rows);
});

app.post('/api/tax-refunds', (req, res) => {
  const { tax_year, amount, date, notes } = req.body;
  if (!tax_year || amount == null) return res.status(400).json({ error: 'tax_year and amount required' });
  const r = db.prepare(
    'INSERT INTO tax_refunds (tax_year, amount, date, notes) VALUES (?, ?, ?, ?)'
  ).run(tax_year, amount, date || null, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM tax_refunds WHERE id = ?').get(r.lastInsertRowid));
});

app.delete('/api/tax-refunds/:id', (req, res) => {
  db.prepare('DELETE FROM tax_refunds WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// -----------------------------------------
// SHIFT AUDIT LOG API
// -----------------------------------------

app.get('/api/audit', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const days   = parseInt(req.query.days   || '0',  10);
  const action = req.query.action || '';
  const search = (req.query.search || '').trim();
  const from   = (req.query.from || '').trim();   // YYYY-MM-DD (created_at date)
  const to     = (req.query.to   || '').trim();   // YYYY-MM-DD (created_at date)
  const flagged = req.query.flagged === '1' || req.query.flagged === 'true';

  // Conditions reference the shift_audit_log columns via the "sal" alias, since the
  // query below joins across to shifts as well.
  const conditions = [];
  const params     = [];
  if (days)    { conditions.push(`sal.created_at >= datetime('now', ? || ' days')`); params.push(`-${days}`); }
  if (from)    { conditions.push(`date(sal.created_at) >= date(?)`); params.push(from); }
  if (to)      { conditions.push(`date(sal.created_at) <= date(?)`); params.push(to); }
  if (flagged) { conditions.push(`sal.not_notified = 1`); }
  if (search)  {
    conditions.push(`(sal.user_note LIKE ? OR sal.note LIKE ? OR sal.action LIKE ? OR sal.source LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (action === 'time_changed') {
    conditions.push(`(sal.changed_fields LIKE '%start_time%' OR sal.changed_fields LIKE '%end_time%')`);
  } else if (action) {
    conditions.push('sal.action = ?'); params.push(action);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // Join back to shifts on shift_id so the log always shows the real shift date/times
  // rather than relying on old_values/new_values JSON, which doesn't always include a
  // `date` field (e.g. break-correction entries only record break minutes). shift_exists
  // tells the frontend whether it's safe to link through to the Shifts tab — a deleted
  // shift still has its shift_id on the log row, but there's nothing left to click into.
  const rows  = db.prepare(`
    SELECT sal.*, s.date AS shift_date, s.start_time AS shift_start, s.end_time AS shift_end,
      (s.id IS NOT NULL) AS shift_exists
    FROM shift_audit_log sal
    LEFT JOIN shifts s ON s.id = sal.shift_id
    ${where}
    ORDER BY sal.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM shift_audit_log sal ${where}`).get(...params).c;
  res.json({ rows, total });
});

// PATCH /api/audit/:id — set the user's note and/or the "wasn't told" flag on an entry
app.patch('/api/audit/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM shift_audit_log WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const sets = [], params = [];
  if (req.body.user_note !== undefined) {
    sets.push('user_note = ?');
    params.push(req.body.user_note === null || req.body.user_note === '' ? null : String(req.body.user_note));
  }
  if (req.body.not_notified !== undefined) {
    sets.push('not_notified = ?');
    params.push(req.body.not_notified ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE shift_audit_log SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM shift_audit_log WHERE id = ?').get(req.params.id));
});

// GET /api/audit/stats — totals by action + monthly change counts for the last 12 months
app.get('/api/audit/stats', (req, res) => {
  try {
    const byAction = db.prepare(`
      SELECT action, COUNT(*) AS count FROM shift_audit_log
      WHERE created_at >= datetime('now', '-12 months')
      GROUP BY action ORDER BY count DESC
    `).all();
    const byMonth = db.prepare(`
      SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count FROM shift_audit_log
      WHERE created_at >= datetime('now', '-12 months')
      GROUP BY month ORDER BY month
    `).all();
    res.json({ byAction, byMonth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// -----------------------------------------
// GOOGLE CALENDAR SYNC API
// -----------------------------------------

// Current connection / config status (never returns the client secret)
app.get('/api/google/status', (req, res) => {
  res.json(gcal.status());
});

// Save credentials / options. Only updates the fields that are provided.
app.post('/api/google/config', (req, res) => {
  const { client_id, client_secret, redirect_uri, calendar_id, event_title, enabled, autosync_interval } = req.body;
  if (client_id    !== undefined) gcal.setSetting('gcal_client_id',     client_id);
  if (client_secret!== undefined && client_secret !== '') gcal.setSetting('gcal_client_secret', client_secret);
  if (redirect_uri !== undefined) gcal.setSetting('gcal_redirect_uri',  redirect_uri);
  if (calendar_id  !== undefined) gcal.setSetting('gcal_calendar_id',   calendar_id || 'primary');
  if (event_title  !== undefined) gcal.setSetting('gcal_event_title',   event_title);
  if (enabled      !== undefined) gcal.setSetting('gcal_enabled',       enabled ? '1' : '0');
  if (autosync_interval !== undefined) gcal.setSetting('gcal_autosync_interval', parseInt(autosync_interval, 10) || 0);
  gcal.applyAutoSyncSchedule();
  res.json(gcal.status());
});

// Begin the OAuth consent flow (opened in the user's browser)
app.get('/api/google/auth', (req, res) => {
  try {
    if (!gcal.isAvailable()) return res.status(500).send('googleapis is not installed on the server yet. Run npm install and restart.');
    res.redirect(gcal.getAuthUrl());
  } catch (e) {
    res.status(400).send('Cannot start Google sign-in: ' + e.message);
  }
});

// OAuth redirect target — Google sends the user back here with ?code=...
app.get('/api/google/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/?gcal=error#settings');
  try {
    await gcal.handleCallback(req.query.code);
    res.redirect('/?gcal=connected#settings');
  } catch (e) {
    console.error('[gcal] callback error:', e.message);
    res.redirect('/?gcal=error&msg=' + encodeURIComponent(e.message) + '#settings');
  }
});

app.post('/api/google/disconnect', (req, res) => {
  gcal.disconnect();
  res.json(gcal.status());
});

// List the user's writable calendars (for the picker dropdown)
app.get('/api/google/calendars', async (req, res) => {
  try {
    res.json({ calendars: await gcal.listCalendars() });
  } catch (e) {
    res.status(400).json({ error: gcal.explainGoogleError(e) });
  }
});

// Recent calendar-sync activity log
app.get('/api/google/sync-log', (req, res) => {
  try {
    res.json(gcal.getSyncLog({ limit: req.query.limit, offset: req.query.offset }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Push all (by default future) shifts to the calendar in one go
app.post('/api/google/sync-all', async (req, res) => {
  try {
    const futureOnly = req.body?.futureOnly !== false;
    const result = await gcal.syncAll({ futureOnly });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: gcal.explainGoogleError(e) });
  }
});

// Re-sync shifts AND delete stray app events (wrong day / orphaned)
app.post('/api/google/reconcile', async (req, res) => {
  try {
    const futureOnly = req.body?.futureOnly === true;
    const result = await gcal.reconcile({ futureOnly });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: gcal.explainGoogleError(e) });
  }
});

// -----------------------------------------
// ICAL SUBSCRIPTION FEED (2026-07-08)
// Subscribe from a phone calendar app: http://<server>:<port>/calendar.ics
// Optional protection: a token, either from Settings (ical_token, set on the
// Export page) or the ICAL_TOKEN env var. Settings wins, matching how the
// GitHub backup credentials work. With one set the feed needs
// /calendar.ics?token=<value>; with neither it's open, as it always was.
//
// Worth protecting if this path is exempted from an authenticating proxy
// (e.g. a Cloudflare Access bypass rule), since calendar apps can't log in —
// the bypass is what makes the feed reachable, and the token is then the only
// thing standing between the internet and your rota.
// -----------------------------------------

function icalToken() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ical_token'").get();
  const fromSettings = row && row.value && row.value.trim();
  return fromSettings || process.env.ICAL_TOKEN || null;
}

function _icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

app.get('/calendar.ics', (req, res) => {
  const token = icalToken();
  if (token && req.query.token !== token) {
    return res.status(403).send('Forbidden');
  }
  try {
    // Window: 90 days back, 12 months forward
    const now = new Date();
    const fmt = d => localDateStr(d);
    const from = fmt(new Date(now.getTime() - 90 * 86400000));
    const to = fmt(new Date(now.getTime() + 365 * 86400000));

    const shifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date').all(from, to);
    const leave = db.prepare('SELECT * FROM leave_entries WHERE end_date >= ? AND start_date <= ?').all(from, to);

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Rota Tracker//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Work Rota',
      'X-WR-TIMEZONE:Europe/London',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/London',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0100',
      'TZNAME:BST',
      'DTSTART:19700329T010000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0000',
      'TZNAME:GMT',
      'DTSTART:19701025T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE'
    ];

    const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    for (const s of shifts) {
      const d = s.date.replace(/-/g, '');
      const st = (s.start_time || '09:00').replace(':', '') + '00';
      const et = (s.end_time || '17:00').replace(':', '') + '00';
      const brk = s.break_scheduled_minutes ? ` (${s.break_scheduled_minutes}m break)` : '';
      lines.push(
        'BEGIN:VEVENT',
        `UID:shift-${s.id}@rota-tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Europe/London:${d}T${st}`,
        `DTEND;TZID=Europe/London:${d}T${et}`,
        `SUMMARY:${_icsEscape('Work ' + (s.start_time || '') + '\u2013' + (s.end_time || ''))}`,
        `DESCRIPTION:${_icsEscape((s.hours_worked ? s.hours_worked + 'h' : '') + brk + (s.notes ? ' \u2014 ' + s.notes : ''))}`,
        'END:VEVENT'
      );
    }
    for (const l of leave) {
      // DTEND for all-day events is exclusive -> day after end_date
      const endExcl = new Date(l.end_date + 'T00:00:00Z');
      endExcl.setUTCDate(endExcl.getUTCDate() + 1);
      lines.push(
        'BEGIN:VEVENT',
        `UID:leave-${l.id}@rota-tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${l.start_date.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${endExcl.toISOString().slice(0, 10).replace(/-/g, '')}`,
        `SUMMARY:${_icsEscape((l.leave_type === 'annual' ? 'Annual Leave' : l.leave_type) + (l.notes ? ' \u2014 ' + l.notes : ''))}`,
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="rota.ics"');
    res.send(lines.join('\r\n'));
  } catch (e) {
    res.status(500).send('Error building calendar: ' + e.message);
  }
});

// -----------------------------------------
// START SERVER
// -----------------------------------------

app.listen(PORT, () => console.log(`Rota app listening on port ${PORT}`));
