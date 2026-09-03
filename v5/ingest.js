/* ─── 📥 V5.0 ingest ───────────────────────────────────────────────────────
   POST /api/v5/ingest — the single write endpoint the client tracker posts to.

   Everything about how much is recorded is decided here, on the server, not in
   the browser: the client sends what it has, and the two privacy switches in
   settings decide what actually gets written. A tampered-with (or simply stale)
   client cannot record a GPS fix while location is switched off, and switching
   it off takes effect on the next request rather than the next page load.

   The endpoint is deliberately forgiving — it is called from a page-unload
   beacon, so it must never 4xx over a malformed field and it must never make
   the caller wait. It returns what it stored, which is what the Privacy view
   uses to show the switches are being honoured.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, privacyFlags, localDateStr, addDays,
} = require('./helpers');

const router = express.Router();

const MAX_EVENTS_PER_POST = 200;   // a beacon should never be bigger than this
const VALID_EVENT_TYPES = new Set(['app_open', 'view', 'action', 'clock_in', 'clock_out']);
const VALID_LOCATION_KINDS = new Set(['clock_in', 'clock_out', 'app_open', 'manual']);

const pad = n => String(n).padStart(2, '0');

/** Client clocks can be anything, and a wrong one would land rows in the wrong
 *  day bucket forever. So the *server's* clock stamps every row; the client's
 *  timestamp is only used to order events inside a single batch. */
function stamp() {
  const d = new Date();
  return {
    ts: `${localDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    local_date: localDateStr(d),
    local_time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    hour: d.getHours(),
    dow: d.getDay(),
  };
}

const str = (v, max = 120) => (v == null ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/* ── Retention ────────────────────────────────────────────────────────── */

let _lastPrune = 0;
/** Drop anything older than the retention window. Runs at most hourly and only
 *  off the back of a write, so there is no timer to leak and nothing to run on
 *  an app that is never opened. */
function pruneIfDue(retentionDays) {
  if (!retentionDays) return;                       // 0 = keep forever
  if (Date.now() - _lastPrune < 3600_000) return;
  _lastPrune = Date.now();
  const cutoff = addDays(localDateStr(), -retentionDays);
  db.prepare('DELETE FROM v5_events    WHERE local_date < ?').run(cutoff);
  db.prepare('DELETE FROM v5_locations WHERE local_date < ?').run(cutoff);
  db.prepare('DELETE FROM v5_sessions  WHERE local_date < ?').run(cutoff);
}

/* ── Writers ──────────────────────────────────────────────────────────── */

const upsertSession = db.prepare(`
  INSERT INTO v5_sessions
    (session_id, started_at, last_seen_at, local_date, started_hour, dow,
     active_ms, view_count, entry_view, exit_view, platform, standalone, screen_w, screen_h, referrer)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    -- Counters are cumulative totals from the client for this session, so take
    -- the larger value: a late-arriving beacon must never shrink a session.
    active_ms    = MAX(v5_sessions.active_ms,  excluded.active_ms),
    view_count   = MAX(v5_sessions.view_count, excluded.view_count),
    exit_view    = COALESCE(excluded.exit_view, v5_sessions.exit_view),
    entry_view   = COALESCE(v5_sessions.entry_view, excluded.entry_view)
`);

const insertEvent = db.prepare(`
  INSERT INTO v5_events (session_id, ts, local_date, local_time, hour, dow, type, view, detail, duration_ms, from_view)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

const insertLocation = db.prepare(`
  INSERT INTO v5_locations (session_id, ts, local_date, local_time, kind, lat, lon, accuracy_m, altitude_m, speed_ms, source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

function writeSession(s, sessionId) {
  if (!s || !sessionId) return;
  const t = stamp();
  const existing = db.prepare('SELECT started_at, local_date FROM v5_sessions WHERE session_id = ?').get(sessionId);
  upsertSession.run(
    sessionId,
    existing?.started_at || t.ts,
    t.ts,
    existing?.local_date || t.local_date,
    t.hour, t.dow,
    Math.max(0, Math.round(num(s.active_ms) || 0)),
    Math.max(0, Math.round(num(s.view_count) || 0)),
    str(s.entry_view, 60),
    str(s.exit_view, 60),
    str(s.platform, 20),
    s.standalone ? 1 : 0,
    num(s.screen_w), num(s.screen_h), str(s.referrer, 200)
  );
}

/** POST /api/v5/ingest
 *  Body: { session_id, session: {...}, events: [...], location: {...} } */
router.post('/ingest', (req, res) => {
  const flags = privacyFlags();
  const body = req.body || {};
  const sessionId = str(body.session_id, 40);

  const stored = { session: false, events: 0, location: false, analytics: flags.analytics, location_enabled: flags.location };

  // The master switch. With analytics off nothing is written at all — including
  // location, which is a subset of "usage" rather than a separate stream.
  if (!flags.analytics) return res.json({ ok: true, ...stored, skipped: 'analytics_disabled' });

  try {
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_POST) : [];

    db.transaction(() => {
      if (body.session) { writeSession(body.session, sessionId); stored.session = true; }

      for (const e of events) {
        const type = str(e && e.type, 20);
        if (!VALID_EVENT_TYPES.has(type)) continue;
        const t = stamp();
        insertEvent.run(
          sessionId, t.ts, t.local_date, t.local_time, t.hour, t.dow,
          type, str(e.view, 60), str(e.detail, 200),
          e.duration_ms != null ? Math.max(0, Math.round(num(e.duration_ms) || 0)) : null,
          str(e.from_view, 60)
        );
        stored.events++;
      }

      const loc = body.location;
      // Location is the switch people actually care about, so it is checked
      // separately and last: usage can be recorded with GPS silently dropped.
      if (loc && flags.location) {
        const lat = num(loc.lat), lon = num(loc.lon);
        const kind = VALID_LOCATION_KINDS.has(str(loc.kind, 20)) ? str(loc.kind, 20) : 'manual';
        const allowed = kind !== 'app_open' || flags.locationOnOpen;
        if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && allowed) {
          const t = stamp();
          insertLocation.run(
            sessionId, t.ts, t.local_date, t.local_time, kind,
            lat, lon, num(loc.accuracy_m), num(loc.altitude_m), num(loc.speed_ms),
            str(loc.source, 20) || 'gps'
          );
          stored.location = true;
        }
      }
    })();

    pruneIfDue(flags.retentionDays);
  } catch (e) {
    // Never fail the caller over analytics — it is the least important write
    // the app makes, and the beacon has nowhere to report an error to anyway.
    console.error('[V5] ingest failed:', e.message);
  }

  res.json({ ok: true, ...stored });
});

module.exports = router;
module.exports.stamp = stamp;
