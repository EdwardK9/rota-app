// ─────────────────────────────────────────────────────────────────────────
// Google Calendar sync
//
// Keeps the user's Google Calendar in step with their shifts. Events are titled
// with the configured title (default "Screwfix Shift"), carry no description,
// and are tagged with a private extended property (rotaApp=1) so the app can
// reliably find and clean up its own events.
//
// All settings live in the `settings` table (keys prefixed `gcal_`).
// `googleapis` is loaded lazily so the app still boots if it isn't installed yet.
// ─────────────────────────────────────────────────────────────────────────

const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS gcal_sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    shift_id    INTEGER,
    event_id    TEXT,
    shift_date  TEXT,
    status      TEXT,
    detail      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gcal_log_created ON gcal_sync_log(created_at);
`);

let google = null;
let loadError = null;
try {
  ({ google } = require('googleapis'));
} catch (e) {
  loadError = e.message;
  console.warn('[gcal] googleapis not installed — run `npm install` to enable Google Calendar sync.');
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.events',
                'https://www.googleapis.com/auth/calendar.readonly'];
const DEFAULT_TITLE = 'Screwfix Shift';

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value ?? ''));
}
function delSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

if (['', 'Work shift'].includes(getSetting('gcal_event_title'))) {
  setSetting('gcal_event_title', DEFAULT_TITLE);
}

function eventTitle() { return getSetting('gcal_event_title') || DEFAULT_TITLE; }

function getConfig() {
  return {
    clientId:         getSetting('gcal_client_id'),
    clientSecret:     getSetting('gcal_client_secret'),
    redirectUri:      getSetting('gcal_redirect_uri'),
    refreshToken:     getSetting('gcal_refresh_token'),
    calendarId:       getSetting('gcal_calendar_id') || 'primary',
    enabled:          getSetting('gcal_enabled') === '1',
    autosyncInterval: parseInt(getSetting('gcal_autosync_interval') || '0', 10),
  };
}

function isAvailable() { return !!google; }
function hasCredentials() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}
function isConnected() { return !!getConfig().refreshToken; }
function isEnabled()   { return getConfig().enabled; }

function status() {
  const c = getConfig();
  return {
    available:        isAvailable(),
    loadError,
    hasCredentials:   hasCredentials(),
    connected:        isConnected(),
    enabled:          isEnabled(),
    calendarId:       c.calendarId,
    redirectUri:      c.redirectUri,
    clientId:         c.clientId,
    eventTitle:       eventTitle(),
    autosyncInterval: c.autosyncInterval,
    autosyncLast:     getSetting('gcal_autosync_last') || null,
    needsReconnect:   getSetting('gcal_needs_reconnect') === '1',
  };
}

// Turn a raw Google/OAuth error into a message Ed can actually act on.
// "invalid_grant" is Google's standard response when the stored refresh token
// no longer works — almost always because the OAuth app is still in Google
// Cloud's "Testing" publishing status, where refresh tokens expire after
// ~7 days (or immediately if access was revoked / the token was reused after
// the client secret changed). The fix is always the same: reconnect.
function explainGoogleError(e) {
  const msg = ((e && e.message) || '').toLowerCase();
  if (msg.indexOf('invalid_grant') !== -1) {
    setSetting('gcal_needs_reconnect', '1');
    return 'Google Calendar needs reconnecting — your stored access has expired or was revoked ' +
      '(this happens automatically after about 7 days while the app is in "Testing" mode in Google ' +
      'Cloud Console, or if access was manually removed). Go to Settings → Google Calendar Sync and ' +
      'click Connect again to restore the link. (Publishing the app in Google Cloud Console, rather ' +
      'than leaving it in Testing, would stop this from recurring.)';
  }
  return (e && e.message) || 'Unknown Google Calendar error';
}

function logSync(action, opts) {
  opts = opts || {};
  try {
    db.prepare(`INSERT INTO gcal_sync_log (action, shift_id, event_id, shift_date, status, detail)
                VALUES (?, ?, ?, ?, ?, ?)`).run(
      action,
      opts.shift_id != null ? opts.shift_id : null,
      opts.event_id != null ? opts.event_id : null,
      opts.date     != null ? opts.date     : null,
      opts.status   || 'ok',
      opts.detail   != null ? opts.detail   : null
    );
  } catch (e) { console.error('[gcal] logSync error:', e.message); }
}
function getSyncLog(opts) {
  opts = opts || {};
  const limit  = Math.min(parseInt(opts.limit, 10) || 100, 500);
  const offset = parseInt(opts.offset, 10) || 0;
  const rows   = db.prepare('SELECT * FROM gcal_sync_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total  = db.prepare('SELECT COUNT(*) c FROM gcal_sync_log').get().c;
  return { rows, total };
}

function oauthClient() {
  const c = getConfig();
  if (!google) throw new Error('googleapis not installed');
  if (!c.clientId || !c.clientSecret || !c.redirectUri)
    throw new Error('Google client ID, secret and redirect URI must be set first.');
  const client = new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
  if (c.refreshToken) client.setCredentials({ refresh_token: c.refreshToken });
  return client;
}

function assertUsableRedirect(uri) {
  if (!uri) throw new Error('No redirect URI set. Enter your public https://<domain>/api/google/callback in Settings.');
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(uri);
  const isPrivate   = /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(uri) ||
                      /^https?:\/\/[^/]*\.local(:|\/|$)/i.test(uri);
  const isHttps     = /^https:\/\//i.test(uri);
  if (isPrivate) {
    throw new Error('Google won\'t allow the redirect URI "' + uri + '" — it\'s a private/LAN address. Set it to your public https://<domain>/api/google/callback in Settings (and register the same URL in Google Cloud Console), then try again.');
  }
  if (!isHttps && !isLocalhost) {
    throw new Error('Google requires an https redirect URI (or http://localhost). "' + uri + '" isn\'t allowed. Use your public https://<domain>/api/google/callback.');
  }
}

function getAuthUrl() {
  assertUsableRedirect(getConfig().redirectUri);
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function handleCallback(code) {
  const client = oauthClient();
  const tokenResp = await client.getToken(code);
  const tokens = tokenResp.tokens;
  if (tokens.refresh_token) {
    setSetting('gcal_refresh_token', tokens.refresh_token);
  } else if (!getConfig().refreshToken) {
    throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and reconnect.');
  }
  setSetting('gcal_enabled', '1');
  delSetting('gcal_needs_reconnect');
  applyAutoSyncSchedule();
  return true;
}

function disconnect() {
  delSetting('gcal_refresh_token');
  setSetting('gcal_enabled', '0');
  applyAutoSyncSchedule();
}

function calendarApi() {
  return google.calendar({ version: 'v3', auth: oauthClient() });
}

// Pace between bulk calls (ms) to stay under Google's per-user rate limits
const PACE_MS = 150;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Is a Google API error worth retrying? (rate limits / transient server errors)
function isRetryable(e) {
  const code = e && e.code;
  const msg  = ((e && e.message) || '').toLowerCase();
  if (code === 429 || code === 503 || code === 500) return true;
  if (code === 403 && (msg.indexOf('rate limit') !== -1 || msg.indexOf('quota') !== -1 || msg.indexOf('user rate') !== -1)) return true;
  return false;
}

// Run an API call with exponential backoff + jitter on rate-limit / transient errors
async function withRetry(fn) {
  let delay = 700;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isRetryable(e) || attempt >= 6) throw e;
      await sleep(delay + Math.floor(Math.random() * 400));
      delay = Math.min(delay * 2, 20000);
    }
  }
}

async function listCalendars() {
  if (!isAvailable()) throw new Error('googleapis not installed');
  if (!isConnected()) throw new Error('Not connected to Google');
  const cal = calendarApi();
  const res = await withRetry(function () { return cal.calendarList.list({ maxResults: 250, minAccessRole: 'writer' }); });
  return (res.data.items || [])
    .map(function (c) { return { id: c.id, summary: c.summary || c.id, primary: !!c.primary, accessRole: c.accessRole }; })
    .sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.summary.localeCompare(b.summary); });
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function shiftTimes(shift) {
  let endDate = shift.date;
  const sParts = String(shift.start_time).split(':').map(Number);
  const eParts = String(shift.end_time).split(':').map(Number);
  const startMins = sParts[0] * 60 + sParts[1];
  const endMins   = eParts[0] * 60 + eParts[1];
  if (endMins <= startMins) endDate = addDaysStr(shift.date, 1);
  return {
    start: { dateTime: shift.date + 'T' + shift.start_time + ':00', timeZone: 'Europe/London' },
    end:   { dateTime: endDate    + 'T' + shift.end_time   + ':00', timeZone: 'Europe/London' },
  };
}

function buildEvent(shift) {
  const t = shiftTimes(shift);
  return {
    summary: eventTitle(),
    start: t.start,
    end: t.end,
    extendedProperties: { private: { rotaApp: '1', rotaShiftId: String(shift.id) } },
  };
}

async function upsertShift(shift, opts) {
  opts = opts || {};
  const logUpdates = opts.logUpdates !== false;
  if (!isAvailable() || !isEnabled() || !isConnected()) return null;
  const cal = calendarApi();
  const calendarId = getConfig().calendarId;
  const resource = buildEvent(shift);

  if (shift.google_event_id) {
    try {
      await withRetry(function () { return cal.events.update({ calendarId: calendarId, eventId: shift.google_event_id, requestBody: resource }); });
      if (logUpdates) logSync('updated', { shift_id: shift.id, event_id: shift.google_event_id, date: shift.date });
      return shift.google_event_id;
    } catch (e) {
      if ([404, 410].indexOf(e.code) === -1) throw e;
    }
  }
  const res = await withRetry(function () { return cal.events.insert({ calendarId: calendarId, requestBody: resource }); });
  const eventId = res.data.id;
  db.prepare('UPDATE shifts SET google_event_id = ? WHERE id = ?').run(eventId, shift.id);
  logSync('created', { shift_id: shift.id, event_id: eventId, date: shift.date });
  return eventId;
}

async function deleteShiftEvent(shift) {
  if (!isAvailable() || !isEnabled() || !isConnected()) return;
  if (!shift || !shift.google_event_id) return;
  const cal = calendarApi();
  try {
    await withRetry(function () { return cal.events.delete({ calendarId: getConfig().calendarId, eventId: shift.google_event_id }); });
    logSync('deleted', { shift_id: shift.id, event_id: shift.google_event_id, date: shift.date });
  } catch (e) {
    if ([404, 410].indexOf(e.code) === -1) throw e;
  }
}

function safeUpsert(shift) {
  if (!isAvailable() || !isEnabled() || !isConnected()) return;
  Promise.resolve().then(function () { return upsertShift(shift); })
    .catch(function (e) { console.error('[gcal] upsert failed:', e.message); logSync('error', { shift_id: shift && shift.id, date: shift && shift.date, status: 'error', detail: 'upsert: ' + e.message }); });
}
function safeDelete(shift) {
  if (!isAvailable() || !isEnabled() || !isConnected()) return;
  Promise.resolve().then(function () { return deleteShiftEvent(shift); })
    .catch(function (e) { console.error('[gcal] delete failed:', e.message); logSync('error', { shift_id: shift && shift.id, date: shift && shift.date, status: 'error', detail: 'delete: ' + e.message }); });
}

async function syncAll(opts) {
  opts = opts || {};
  const futureOnly = opts.futureOnly !== false;
  if (!isAvailable()) throw new Error('googleapis not installed');
  if (!isConnected()) throw new Error('Not connected to Google');
  const today = new Date().toISOString().slice(0, 10);
  const rows = futureOnly
    ? db.prepare('SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC').all(today)
    : db.prepare('SELECT * FROM shifts ORDER BY date ASC').all();
  let synced = 0, failed = 0;
  for (const shift of rows) {
    try {
      // Re-read the row instead of trusting the snapshot taken above: this loop is
      // paced (150ms/shift) and can run for a while, so a shift edited mid-loop would
      // otherwise be upserted with stale times and/or a stale (missing) google_event_id,
      // creating a second orphaned event instead of updating the real one.
      const fresh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
      if (fresh) { await upsertShift(fresh, { logUpdates: false }); synced++; }
    }
    catch (e) { failed++; console.error('[gcal] syncAll item failed:', e.message); logSync('error', { shift_id: shift.id, date: shift.date, status: 'error', detail: 'sync: ' + e.message }); }
    await sleep(PACE_MS);
  }
  return { total: rows.length, synced: synced, failed: failed };
}

async function listAppEvents(cal, calendarId, timeMin, timeMax) {
  const title = eventTitle();
  const out = [], seen = {};
  async function pull(extra) {
    let pageToken;
    do {
      const params = Object.assign({
        calendarId: calendarId, timeMin: timeMin, timeMax: timeMax,
        singleEvents: true, showDeleted: false, maxResults: 2500, pageToken: pageToken,
      }, extra);
      const res = await withRetry(function () { return cal.events.list(params); });
      const items = res.data.items || [];
      for (const ev of items) {
        const priv = ev.extendedProperties && ev.extendedProperties.private;
        const isApp = (priv && priv.rotaApp === '1') || ev.summary === title;
        if (isApp && !seen[ev.id]) { seen[ev.id] = true; out.push(ev); }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  await pull({ privateExtendedProperty: 'rotaApp=1' });
  await pull({ q: title });
  return out;
}

async function reconcile(opts) {
  opts = opts || {};
  const futureOnly = opts.futureOnly === true;
  if (!isAvailable()) throw new Error('googleapis not installed');
  if (!isConnected()) throw new Error('Not connected to Google');

  const today = new Date().toISOString().slice(0, 10);
  const rows = futureOnly
    ? db.prepare('SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC').all(today)
    : db.prepare('SELECT * FROM shifts ORDER BY date ASC').all();

  let synced = 0, failed = 0;
  for (const shift of rows) {
    try {
      // See syncAll: re-read the row so a mid-loop edit doesn't get upserted from a stale snapshot.
      const fresh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
      if (fresh) { await upsertShift(fresh, { logUpdates: false }); synced++; }
    }
    catch (e) { failed++; logSync('error', { shift_id: shift.id, date: shift.date, status: 'error', detail: 'reconcile sync: ' + e.message }); }
    await sleep(PACE_MS);
  }

  // Safety: if any shift failed to sync (e.g. rate-limited), the set of "valid"
  // event ids is incomplete — skip deletion so we don't remove real events that
  // just haven't synced yet. The user can re-run once syncs succeed.
  if (failed > 0) {
    logSync('error', { status: 'error', detail: 'cleanup skipped deletes: ' + failed + ' shift(s) failed to sync — re-run after rate limits clear' });
    return { total: rows.length, synced: synced, deleted: 0, failed: failed, skippedCleanup: true };
  }

  const validIds = {};
  db.prepare('SELECT google_event_id FROM shifts WHERE google_event_id IS NOT NULL').all()
    .forEach(function (r) { if (r.google_event_id) validIds[r.google_event_id] = true; });

  const b = db.prepare('SELECT MIN(date) mn, MAX(date) mx FROM shifts').get();
  const lo = futureOnly ? today : (b.mn || today);
  const hi = addDaysStr(b.mx || today, 2);
  const timeMin = lo + 'T00:00:00Z';
  const timeMax = hi + 'T23:59:59Z';

  const cal = calendarApi();
  const calendarId = getConfig().calendarId;
  let deleted = 0;
  const appEvents = await listAppEvents(cal, calendarId, timeMin, timeMax);
  for (const ev of appEvents) {
    if (validIds[ev.id]) continue;
    const evDate = ((ev.start && (ev.start.dateTime || ev.start.date)) || '').slice(0, 10);
    try {
      await withRetry(function () { return cal.events.delete({ calendarId: calendarId, eventId: ev.id }); });
      logSync('deleted', { event_id: ev.id, date: evDate, detail: 'reconcile: stray event removed' });
      deleted++;
    } catch (e) {
      if ([404, 410].indexOf(e.code) === -1) { failed++; logSync('error', { event_id: ev.id, date: evDate, status: 'error', detail: 'reconcile delete: ' + e.message }); }
    }
    await sleep(PACE_MS);
  }
  return { total: rows.length, synced: synced, deleted: deleted, failed: failed };
}

let _autoTimer = null;
function applyAutoSyncSchedule() {
  if (_autoTimer) { clearInterval(_autoTimer); _autoTimer = null; }
  const mins = parseInt(getSetting('gcal_autosync_interval') || '0', 10);
  if (!mins || !isAvailable()) return;
  _autoTimer = setInterval(function () {
    if (!isEnabled() || !isConnected()) return;
    syncAll({ futureOnly: true })
      .then(function (r) { setSetting('gcal_autosync_last', new Date().toISOString()); console.log('[gcal] auto-sync', JSON.stringify(r)); })
      .catch(function (e) { console.error('[gcal] auto-sync failed:', e.message); });
  }, mins * 60 * 1000);
  if (_autoTimer.unref) _autoTimer.unref();
}
applyAutoSyncSchedule();

module.exports = {
  isAvailable: isAvailable, hasCredentials: hasCredentials, isConnected: isConnected,
  isEnabled: isEnabled, status: status, getConfig: getConfig, setSetting: setSetting,
  getAuthUrl: getAuthUrl, handleCallback: handleCallback, disconnect: disconnect,
  listCalendars: listCalendars, getSyncLog: getSyncLog,
  upsertShift: upsertShift, deleteShiftEvent: deleteShiftEvent,
  safeUpsert: safeUpsert, safeDelete: safeDelete, syncAll: syncAll, reconcile: reconcile,
  applyAutoSyncSchedule: applyAutoSyncSchedule, explainGoogleError: explainGoogleError,
};
