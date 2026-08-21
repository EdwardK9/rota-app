/* ─── V3.0 schema ──────────────────────────────────────────────────────────
   Tables owned by the V3 feature set. Kept out of db.js so V3 stays a drop-in
   module — everything it creates is prefixed v3_ and nothing here touches an
   existing table. Runs once at require time, same as db.js's own migrations.
   ───────────────────────────────────────────────────────────────────────── */

const { db } = require('../db');

db.exec(`
  -- Goal Tracker: a money or hours target with an optional deadline.
  CREATE TABLE IF NOT EXISTS v3_goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    goal_type   TEXT NOT NULL DEFAULT 'money',   -- 'money' | 'hours' | 'shifts'
    target      REAL NOT NULL,
    start_date  TEXT NOT NULL,
    target_date TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_v3_goals_archived ON v3_goals(archived);

  -- Trophy Cabinet: remembers the first time each achievement was earned, so a
  -- trophy keeps its original unlock date even if the underlying stat later
  -- dips back below the threshold.
  CREATE TABLE IF NOT EXISTS v3_trophy_unlocks (
    code        TEXT PRIMARY KEY,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = { db };
