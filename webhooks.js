/* ─── Homelab & Smart Home Webhooks (V2.0 Phase 5) ──────────────────────────
   Endpoints:
     GET  /api/webhooks/config          — current settings + status
     POST /api/webhooks/config          — save URL / enabled / lead time / role
     POST /api/webhooks/test            — fire a test payload
     GET  /api/webhooks/log             — recent outgoing webhook activity
     GET  /api/v1/shifts/current-state  — polling endpoint for HA / Node-RED / scripts

   Outgoing events (scheduler-driven, see startWebhookScheduler()):
     shift_start_imminent — T-{lead} minutes before your shift starts
       { "event": "commute_prep", "start_time": "08:00", "weather": "rain" }
     shift_ended — fired from server.js right after a successful clock-out
       { "event": "shift_ended", "end_time": "16:32" }
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db } = require('./db');
const commute = require('./commute');
const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event      TEXT NOT NULL,
    payload    TEXT,
    success    INTEGER NOT NULL DEFAULT 1,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_log_created ON webhook_log(created_at);
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Post a webhook event to the configured URL (if enabled), logging the result. */
async function postWebhook(payload) {
  const enabled = getSetting('webhook_enabled') === '1';
  const url = getSetting('webhook_url');
  if (!enabled || !url) return { skipped: true };

  let success = true, error = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) { success = false; error = `Webhook endpoint returned ${resp.status}`; }
  } catch (e) {
    success = false; error = e.message;
  }
  db.prepare('INSERT INTO webhook_log (event, payload, success, error) VALUES (?,?,?,?)')
    .run(payload.event, JSON.stringify(payload), success ? 1 : 0, error);
  // Keep the log from growing forever
  db.prepare('DELETE FROM webhook_log WHERE id NOT IN (SELECT id FROM webhook_log ORDER BY created_at DESC LIMIT 100)').run();
  if (!success) console.error(`[Webhook] ${payload.event} failed:`, error);
  else console.log(`[Webhook] Sent ${payload.event}`);
  return { skipped: false, success, error };
}

/** Best-effort single-word/phrase weather summary for the commute_prep payload,
 *  reusing the same forecast logic as the Phase 2.1 commute overlay. Home
 *  location only (the moment you're about to leave for work). */
async function commuteWeatherSummary(date, startTime) {
  try {
    const homeLat = commute.getSetting('commute_home_lat');
    const homeLon = commute.getSetting('commute_home_lon');
    if (!homeLat || !homeLon) return null;
    const forecast = await commute.fetchHourlyForecast(homeLat, homeLon, date);
    const departTime = new Date(`${date}T${startTime}:00`); departTime.setMinutes(departTime.getMinutes() - 40);
    const point = forecast[commute.nearestHourKey(departTime)];
    if (!point) return null;
    const alerts = commute.buildAlerts(point);
    if (alerts.some(a => a.text.includes('Frost'))) return 'frost';
    if (alerts.length) return 'rain';
    return commute.weatherLabel(point.code).label.toLowerCase() || 'clear';
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────
// Scheduler — fires shift_start_imminent T-{lead} minutes before shift start
// ─────────────────────────────────────────
let webhookTimer = null;
const webhookFired = {}; // key: `${date}_${start_time}` -> true (one commute_prep per shift)

function startWebhookScheduler() {
  if (webhookTimer) { clearInterval(webhookTimer); webhookTimer = null; }
  webhookTimer = setInterval(async () => {
    const enabled = getSetting('webhook_enabled') === '1';
    const url = getSetting('webhook_url');
    if (!enabled || !url) return;
    const leadMins = parseInt(getSetting('webhook_lead_mins', '60'), 10) || 60;

    const now = new Date();
    const todayStr = localDateStr(now);
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localDateStr(tomorrow);

    const shifts = db.prepare(
      "SELECT date, start_time FROM shifts WHERE date IN (?, ?) AND start_time IS NOT NULL ORDER BY date, start_time"
    ).all(todayStr, tomorrowStr);

    const GRACE_MS = 5 * 60000; // tolerate a tick running up to 5 min late

    for (const shift of shifts) {
      const shiftMs = new Date(`${shift.date}T${shift.start_time}:00`).getTime();
      if (now.getTime() >= shiftMs) continue; // never fire once the shift's already started

      const fireAt = shiftMs - leadMins * 60000;
      const lateBy = now.getTime() - fireAt;
      if (lateBy < 0 || lateBy > GRACE_MS) continue;

      const key = `${shift.date}_${shift.start_time}`;
      if (webhookFired[key]) continue;
      webhookFired[key] = true;
      // Prune old keys so this doesn't grow forever
      const cutoff = now.getTime() - 24 * 3600000;
      Object.keys(webhookFired).forEach(k => {
        const d = new Date(`${k.split('_')[0]}T${k.split('_')[1]}:00`).getTime();
        if (d < cutoff) delete webhookFired[k];
      });

      const weather = await commuteWeatherSummary(shift.date, shift.start_time);
      await postWebhook({ event: 'commute_prep', start_time: shift.start_time, weather: weather || 'unknown' });
    }
  }, 30000);
}

/** Called from server.js right after a successful clock-out. */
function fireShiftEndedWebhook({ end_time }) {
  return postWebhook({ event: 'shift_ended', end_time });
}

// ─────────────────────────────────────────
// Config & test routes
// ─────────────────────────────────────────

router.get('/webhooks/config', (req, res) => {
  res.json({
    url: getSetting('webhook_url', ''),
    enabled: getSetting('webhook_enabled') === '1',
    lead_mins: parseInt(getSetting('webhook_lead_mins', '60'), 10) || 60,
    employee_role: getSetting('employee_role', ''),
  });
});

router.post('/webhooks/config', (req, res) => {
  const { url, enabled, lead_mins, employee_role } = req.body;
  if (url !== undefined) setSetting('webhook_url', url);
  if (enabled !== undefined) setSetting('webhook_enabled', enabled ? '1' : '0');
  if (lead_mins !== undefined) setSetting('webhook_lead_mins', String(parseInt(lead_mins, 10) || 60));
  if (employee_role !== undefined) setSetting('employee_role', employee_role);
  res.json({ ok: true });
});

router.post('/webhooks/test', async (req, res) => {
  const url = getSetting('webhook_url');
  if (!url) return res.status(400).json({ error: 'Set a webhook URL first' });
  // Test bypasses the enabled flag (so you can verify it's wired up before switching it on)
  let success = true, error = null;
  const payload = { event: 'test', message: 'Rota App webhook test', sent_at: new Date().toISOString() };
  try {
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!resp.ok) { success = false; error = `Endpoint returned ${resp.status}`; }
  } catch (e) { success = false; error = e.message; }
  db.prepare('INSERT INTO webhook_log (event, payload, success, error) VALUES (?,?,?,?)')
    .run('test', JSON.stringify(payload), success ? 1 : 0, error);
  if (success) res.json({ ok: true });
  else res.status(502).json({ error });
});

router.get('/webhooks/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM webhook_log ORDER BY created_at DESC, id DESC LIMIT 50').all();
  res.json({ rows });
});

// ─────────────────────────────────────────
// Phase 5.2 — polling REST API
// ─────────────────────────────────────────

router.get('/v1/shifts/current-state', (req, res) => {
  const today = localDateStr();
  const now = new Date();

  const todayShift = db.prepare(
    "SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC LIMIT 1"
  ).get(today);
  const isWorkingToday = !!todayShift;

  const nextShiftRow = db.prepare(
    "SELECT * FROM shifts WHERE date > ? OR (date = ? AND end_time >= ?) ORDER BY date ASC, start_time ASC LIMIT 1"
  ).get(today, today, `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);

  let nextShift = null;
  if (nextShiftRow) {
    // Reuse the Phase 2.2 synergy score for the next shift's date, if that
    // route is mounted (it lives in working-with.js, loaded separately).
    let synergyScore = null;
    try {
      const myShift = nextShiftRow;
      const dayShifts = db.prepare(`
        SELECT cs.*, c.synergy_rating FROM colleague_shifts cs
        JOIN colleagues c ON c.id = cs.colleague_id
        WHERE cs.date = ? AND cs.shift_type != 'leave'
      `).all(myShift.date);
      const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      let myDur = toMins(myShift.end_time) - toMins(myShift.start_time);
      if (myDur <= 0) myDur += 24 * 60;
      const counted = dayShifts.filter(s => {
        if (s.shift_type === 'all_day') return true;
        const os = Math.max(toMins(myShift.start_time), toMins(s.start_time));
        const oe = Math.min(toMins(myShift.end_time), toMins(s.end_time));
        return Math.max(0, oe - os) / myDur >= 0.5;
      });
      if (counted.length) {
        const sum = counted.reduce((t, c) => t + (c.synergy_rating || 0), 0);
        synergyScore = Math.max(0, Math.min(100, Math.round(50 + (sum / (counted.length * 2)) * 50)));
      }
    } catch (_) { /* best-effort — don't fail the whole endpoint over this */ }

    nextShift = {
      start: `${nextShiftRow.date}T${nextShiftRow.start_time}:00`,
      end:   `${nextShiftRow.date}T${nextShiftRow.end_time}:00`,
      role: getSetting('employee_role', '') || null,
      synergy_score: synergyScore,
    };
  }

  const teamOnDutyCount = nextShiftRow
    ? db.prepare("SELECT COUNT(*) c FROM colleague_shifts WHERE date = ? AND shift_type != 'leave'").get(nextShiftRow.date).c
    : 0;

  res.json({
    is_working_today: isWorkingToday,
    next_shift: nextShift,
    team_on_duty_count: teamOnDutyCount,
  });
});

module.exports = router;
module.exports.startWebhookScheduler = startWebhookScheduler;
module.exports.fireShiftEndedWebhook = fireShiftEndedWebhook;
