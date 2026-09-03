/* ─── V5.0 schema ──────────────────────────────────────────────────────────
   Tables owned by the V5 usage-analytics feature set. Everything is prefixed
   v5_ and nothing here touches an existing table — in particular the GPS
   captured at clock-in/out lives in v5_clock_locations keyed by date, rather
   than as new columns on clock_entries, so turning the whole feature off (or
   deleting its data) never touches the clock record itself.
   ───────────────────────────────────────────────────────────────────────── */

const { db } = require('../db');

db.exec(`
  -- One row per app session (a page load, or a return to the app after it has
  -- been in the background long enough to count as a fresh open). Duration is
  -- last_seen_at minus started_at, kept up to date by heartbeats so a session
  -- that ends by the phone being locked still has a sane length.
  CREATE TABLE IF NOT EXISTS v5_sessions (
    session_id   TEXT PRIMARY KEY,
    started_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    local_date   TEXT NOT NULL,
    started_hour INTEGER NOT NULL,
    dow          INTEGER NOT NULL,          -- 0 = Sunday
    active_ms    INTEGER NOT NULL DEFAULT 0,-- foreground time, not wall clock
    view_count   INTEGER NOT NULL DEFAULT 0,
    entry_view   TEXT,
    exit_view    TEXT,
    platform     TEXT,                      -- 'ios' | 'android' | 'desktop' | 'other'
    standalone   INTEGER NOT NULL DEFAULT 0,-- 1 = launched from the home screen (PWA)
    screen_w     INTEGER,
    screen_h     INTEGER,
    referrer     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_v5_sessions_date ON v5_sessions(local_date);

  -- Every discrete thing worth counting. 'view' rows carry a dwell time filled
  -- in when the view is left; the rest are point events.
  CREATE TABLE IF NOT EXISTS v5_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    ts          TEXT NOT NULL,              -- ISO local timestamp
    local_date  TEXT NOT NULL,
    local_time  TEXT NOT NULL,              -- HH:MM
    hour        INTEGER NOT NULL,
    dow         INTEGER NOT NULL,
    type        TEXT NOT NULL,              -- 'app_open' | 'view' | 'action' | 'clock_in' | 'clock_out'
    view        TEXT,                       -- the view id, for 'view' rows
    detail      TEXT,
    duration_ms INTEGER,
    from_view   TEXT                        -- what you were looking at before this
  );
  CREATE INDEX IF NOT EXISTS idx_v5_events_date ON v5_events(local_date);
  CREATE INDEX IF NOT EXISTS idx_v5_events_type_date ON v5_events(type, local_date);
  CREATE INDEX IF NOT EXISTS idx_v5_events_session ON v5_events(session_id);

  -- GPS fixes. 'kind' says what the app was doing when it asked, so clock-in
  -- points can be separated from ordinary app-open pings.
  CREATE TABLE IF NOT EXISTS v5_locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    ts          TEXT NOT NULL,
    local_date  TEXT NOT NULL,
    local_time  TEXT NOT NULL,
    kind        TEXT NOT NULL,              -- 'clock_in' | 'clock_out' | 'app_open' | 'manual'
    lat         REAL NOT NULL,
    lon         REAL NOT NULL,
    accuracy_m  REAL,
    altitude_m  REAL,
    speed_ms    REAL,
    source      TEXT                        -- 'gps' | 'network' | 'manual'
  );
  CREATE INDEX IF NOT EXISTS idx_v5_locations_date ON v5_locations(local_date);
  CREATE INDEX IF NOT EXISTS idx_v5_locations_kind ON v5_locations(kind, local_date);

  -- Named places. Points are labelled at read time by distance rather than at
  -- write time, so renaming a place (or widening its radius) relabels history.
  CREATE TABLE IF NOT EXISTS v5_places (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    icon      TEXT NOT NULL DEFAULT '📍',
    lat       REAL NOT NULL,
    lon       REAL NOT NULL,
    radius_m  INTEGER NOT NULL DEFAULT 200,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = { db };
