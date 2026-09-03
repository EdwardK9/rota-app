/* ─── 🔒 Data & Privacy (V5.0) ─────────────────────────────────────────────
   GET    /api/v5/privacy          — what's switched on and what's been stored
   POST   /api/v5/privacy          — flip the switches
   DELETE /api/v5/data?scope=      — delete what's been collected

   V5 records more about you than the rest of the app does, so it owns the
   controls for that in one place rather than burying them: the same switches
   appear in Settings, but this page also shows the row counts, so "location is
   off" can be checked rather than trusted.

   Deletion is real deletion — the rows go, and nothing is kept behind an
   "anonymised" fig leaf.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, setSetting, privacyFlags, localDateStr, humanMs } = require('./helpers');

const router = express.Router();

function counts() {
  const one = (sql) => db.prepare(sql).get() || {};
  const ev = one('SELECT COUNT(*) AS c, MIN(local_date) AS first, MAX(local_date) AS last FROM v5_events');
  const se = one('SELECT COUNT(*) AS c, MIN(local_date) AS first, MAX(local_date) AS last, SUM(active_ms) AS ms FROM v5_sessions');
  const lo = one('SELECT COUNT(*) AS c, MIN(local_date) AS first, MAX(local_date) AS last FROM v5_locations');
  const pl = one('SELECT COUNT(*) AS c FROM v5_places');
  return {
    events:    { rows: ev.c || 0, first: ev.first || null, last: ev.last || null },
    sessions:  { rows: se.c || 0, first: se.first || null, last: se.last || null,
                 total_ms: se.ms || 0, total_label: humanMs(se.ms || 0) },
    locations: { rows: lo.c || 0, first: lo.first || null, last: lo.last || null },
    places:    { rows: pl.c || 0 },
  };
}

router.get('/privacy', (req, res) => {
  const flags = privacyFlags();
  res.json({
    today: localDateStr(),
    settings: {
      analytics_enabled: flags.analytics,
      location_enabled: flags.location,
      location_on_open: flags.locationOnOpen,
      retention_days: flags.retentionDays,
    },
    stored: counts(),
    // Spelled out rather than left implicit — this is the page someone opens
    // when they want to know exactly what is being kept.
    collected: [
      { what: 'App opens and session length', when: 'Every time the app is opened', off_switch: 'Usage analytics' },
      { what: 'Which view you opened and for how long', when: 'On every navigation', off_switch: 'Usage analytics' },
      { what: 'GPS position at clock-in and clock-out', when: 'Only when you clock in or out', off_switch: 'Location tracking' },
      { what: 'GPS position when the app opens', when: 'Only if the extra switch is on', off_switch: 'Location on app open' },
    ],
    note: 'All of this is stored in your own SQLite database on your own server. Nothing is sent anywhere else.',
  });
});

router.post('/privacy', (req, res) => {
  const b = req.body || {};
  const bool = v => (v === true || v === '1' || v === 1 || v === 'true' ? '1' : '0');
  if (b.analytics_enabled !== undefined) setSetting('v5_analytics_enabled', bool(b.analytics_enabled));
  if (b.location_enabled !== undefined)  setSetting('v5_location_enabled',  bool(b.location_enabled));
  if (b.location_on_open !== undefined)  setSetting('v5_location_on_open',  bool(b.location_on_open));
  if (b.retention_days !== undefined) {
    const n = Math.max(0, Math.min(3650, Math.round(Number(b.retention_days) || 0)));
    setSetting('v5_retention_days', String(n));
  }
  const flags = privacyFlags();
  res.json({
    ok: true,
    settings: {
      analytics_enabled: flags.analytics,
      location_enabled: flags.location,
      location_on_open: flags.locationOnOpen,
      retention_days: flags.retentionDays,
    },
    stored: counts(),
  });
});

/** DELETE /api/v5/data?scope=all|locations|events|sessions|places */
router.delete('/data', (req, res) => {
  const scope = String(req.query.scope || 'all');
  const deleted = {};
  const wipe = (table) => { deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes; };

  if (scope === 'all' || scope === 'events')    wipe('v5_events');
  if (scope === 'all' || scope === 'sessions')  wipe('v5_sessions');
  if (scope === 'all' || scope === 'locations') wipe('v5_locations');
  if (scope === 'places')                       wipe('v5_places');   // never part of 'all'

  res.json({ ok: true, scope, deleted, stored: counts() });
});

module.exports = router;
