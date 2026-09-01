const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'rota.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// -----------------------------------------
// Schema
// -----------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS pay_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_date TEXT NOT NULL,
    hourly_rate REAL NOT NULL,
    contracted_hours_per_week REAL NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    break_scheduled_minutes INTEGER DEFAULT 30,
    break_taken TEXT DEFAULT 'full',
    break_taken_minutes INTEGER DEFAULT 30,
    distance_miles REAL DEFAULT 3.6,
    hourly_rate REAL,
    hours_worked REAL,
    calculated_pay REAL,
    completed INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    payment_date TEXT,
    basic_pay REAL DEFAULT 0,
    arrears_pay REAL DEFAULT 0,
    additional_hours_qty REAL DEFAULT 0,
    additional_hours_pay REAL DEFAULT 0,
    other_payments REAL DEFAULT 0,
    total_gross REAL DEFAULT 0,
    total_deductions REAL DEFAULT 0,
    net_payment REAL DEFAULT 0,
    tax_paid REAL DEFAULT 0,
    ni_employee REAL DEFAULT 0,
    ni_employer REAL DEFAULT 0,
    gross_ytd REAL DEFAULT 0,
    taxable_ytd REAL DEFAULT 0,
    tax_ytd REAL DEFAULT 0,
    ni_able_ytd REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// -----------------------------------------
// Leave entries table
// -----------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS leave_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days_taken REAL NOT NULL,
    leave_type TEXT NOT NULL DEFAULT 'annual',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations -- new tables
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Working-with tables
db.exec(`
  CREATE TABLE IF NOT EXISTS colleagues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS colleague_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    colleague_id INTEGER NOT NULL REFERENCES colleagues(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(colleague_id, date, start_time)
  );

  CREATE INDEX IF NOT EXISTS idx_colleague_shifts_date ON colleague_shifts(date);
  CREATE INDEX IF NOT EXISTS idx_colleague_shifts_colleague ON colleague_shifts(colleague_id);
`);

// The Ollama/LM Studio local-OCR job queue was removed (Gemini covers AI screenshot
// import instead) — these tables held full-resolution screenshot blobs that were
// never cleared after a job finished, and had grown to ~234MB. Drop them once and
// reclaim the space with a one-time VACUUM; this only ever runs once, since the
// tables won't exist on the next startup.
const hadOcrTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='ocr_jobs'"
).get();
if (hadOcrTables) {
  db.exec('DROP TABLE IF EXISTS ocr_job_files');
  db.exec('DROP TABLE IF EXISTS ocr_jobs');
  try { db.exec('VACUUM'); } catch (_) { /* best-effort */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS photo_folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS photo_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id   INTEGER NOT NULL REFERENCES photo_folders(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'image/jpeg',
    file_path   TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Migrate old blob-based table if it exists -- drop image_blob, add file_path
try { db.exec('ALTER TABLE photo_files ADD COLUMN file_path TEXT NOT NULL DEFAULT ""'); } catch(_) {}
try { db.exec('ALTER TABLE photo_files DROP COLUMN image_blob'); } catch(_) {}
// week_start_date: ISO date (Monday) of the rota week this screenshot covers, when
// known — set automatically for AI-imported/AI-renamed screenshots, NULL for anything
// else. Lets the folder be sorted chronologically by week rather than upload time,
// since a DD.MM.YYYY filename doesn't sort correctly as plain text.
try { db.exec('ALTER TABLE photo_files ADD COLUMN week_start_date TEXT'); } catch(_) {}

// Screenshot auto-import queue — phone uploads used to run upload+Gemini+import
// as one HTTP request, which failed ("Failed to fetch") whenever a slow Gemini
// call outlasted a flaky mobile connection or the tab got backgrounded
// mid-upload. Now the phone only does the fast, reliable part (save the raw
// file); a server-side loop processes it afterwards, independent of any one
// device staying connected. queued_for_import distinguishes these rows from
// ordinary Photo Library uploads, which must never be auto-processed.
const screenshotQueueMigrations = [
  'ALTER TABLE photo_files ADD COLUMN queued_for_import INTEGER DEFAULT 0',
  'ALTER TABLE photo_files ADD COLUMN processed_at TEXT',
  'ALTER TABLE photo_files ADD COLUMN process_error TEXT',
  'ALTER TABLE photo_files ADD COLUMN process_attempts INTEGER DEFAULT 0',
  'ALTER TABLE photo_files ADD COLUMN import_batch_id INTEGER',
];
screenshotQueueMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// Payslip documents — the original PDFs (or photos) of payslips, kept as a safe
// copy and nothing more: nothing reads them, and no figure on the Payslips page
// comes from them. Same split as the photo library: metadata here, the file
// itself on disk under DATA_DIR/payslip-files, so the database stays small.
db.exec(`
  CREATE TABLE IF NOT EXISTS payslip_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    month       TEXT NOT NULL,                              -- YYYY-MM the document belongs to
    filename    TEXT NOT NULL,                              -- name as uploaded, shown in the list
    mime_type   TEXT NOT NULL DEFAULT 'application/pdf',
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT NOT NULL,
    notes       TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payslip_files_month ON payslip_files(month);
`);

// Clock in/out
db.exec(`
  CREATE TABLE IF NOT EXISTS clock_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL UNIQUE,
    clocked_in  TEXT,
    clocked_out TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Delivery schedules — history of which days deliveries happen
db.exec(`
  CREATE TABLE IF NOT EXISTS delivery_schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from TEXT NOT NULL,
    days          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Colleague-shifts migrations
const colShiftMigrations = [
  "ALTER TABLE colleague_shifts ADD COLUMN shift_type TEXT DEFAULT 'shift'",
  "ALTER TABLE colleague_shifts ADD COLUMN import_source TEXT",
  // store: NULL/empty = colleague's home store (yours). Any other value means this
  // shift is at a different store, so it's excluded from "working with" / coverage
  // and shown distinctly in the team calendar.
  "ALTER TABLE colleague_shifts ADD COLUMN store TEXT",
  // import_batch_id: which import run inserted this row (NULL for rows added before
  // batch tracking existed, or added by hand). Lets a whole import be undone as a unit.
  "ALTER TABLE colleague_shifts ADD COLUMN import_batch_id INTEGER",
];

// Import batches — one row per team-shift import run (screenshot OCR/Gemini/Ollama,
// JSON paste, bulk API import), so a bad import can be undone as a single action
// instead of hunting through individual rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    note TEXT,
    inserted_count INTEGER DEFAULT 0,
    undone_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Pending conflict review — a screenshot import can hit shift conflicts the
// person uploading can't easily resolve on a small phone screen. These columns
// park the raw conflict list + the original schedule JSON against the batch so
// a second device (e.g. a desktop) can review and resolve them later via
// GET/POST /colleagues/import-batches/:id/conflicts (resolve-conflicts).
const importBatchReviewMigrations = [
  'ALTER TABLE import_batches ADD COLUMN pending_conflicts TEXT',
  'ALTER TABLE import_batches ADD COLUMN pending_schedule_data TEXT',
];
importBatchReviewMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// Colleagues migrations -- start_date
const colleagueStartDateMigration = ["ALTER TABLE colleagues ADD COLUMN start_date TEXT"];
colleagueStartDateMigration.forEach(sql => { try { db.exec(sql); } catch (_) {} });
colShiftMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// Colleagues migrations
const colleagueMigrations = [
  'ALTER TABLE colleagues ADD COLUMN sort_order INTEGER DEFAULT 0',
  'ALTER TABLE colleagues ADD COLUMN birthday TEXT',
  'ALTER TABLE colleagues ADD COLUMN contract_hours REAL DEFAULT 0',
  'ALTER TABLE colleagues ADD COLUMN left_date TEXT',
];
colleagueMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// -----------------------------------------
// V2.0 Phase 1.1 -- Team pay profiles
// pay_type: 'hourly' | 'salaried'. Hourly staff use hourly_rate + contract_hours
// (contract_hours already exists above). Salaried staff use annual_salary +
// nominal_weekly_hours, from which effective_hourly_rate is derived (never
// stored -- always computed so a salary change or hours change stays in sync).
// -----------------------------------------
const payProfileMigrations = [
  "ALTER TABLE colleagues ADD COLUMN pay_type TEXT DEFAULT 'hourly'",
  'ALTER TABLE colleagues ADD COLUMN hourly_rate REAL',
  'ALTER TABLE colleagues ADD COLUMN annual_salary REAL',
  'ALTER TABLE colleagues ADD COLUMN nominal_weekly_hours REAL',
];
payProfileMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// -----------------------------------------
// V2.0 Phase 1.2 -- Colleague synergy & preference system
// tags: JSON-encoded array of strings, e.g. ["Fast on Tills","Closing Pro"]
// synergy_rating: -2 (difficult) .. +2 (dream teammate), 0 = neutral
// notes: private free-text notes about that colleague
// -----------------------------------------
const synergyMigrations = [
  "ALTER TABLE colleagues ADD COLUMN tags TEXT DEFAULT '[]'",
  'ALTER TABLE colleagues ADD COLUMN synergy_rating INTEGER DEFAULT 0',
  'ALTER TABLE colleagues ADD COLUMN notes TEXT',
];
synergyMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// -----------------------------------------
// V2.0 Phase 3 -- Job tier, for the Pay Distribution donut chart
// One of 'management' | 'supervisor' | 'floor_staff' (default).
// -----------------------------------------
try { db.exec("ALTER TABLE colleagues ADD COLUMN job_tier TEXT DEFAULT 'floor_staff'"); } catch (_) { /* already exists */ }

// Migrations -- add new shift / payslip columns (safe to re-run)
const shiftMigrations = [
  'ALTER TABLE shifts ADD COLUMN is_bank_holiday INTEGER DEFAULT 0',
  'ALTER TABLE shifts ADD COLUMN hours_paid REAL',
  // Google Calendar sync: remembers the event id created for this shift
  'ALTER TABLE shifts ADD COLUMN google_event_id TEXT',
];
shiftMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// Audit log migrations -- user-editable note + "wasn't told" flag
const auditMigrations = [
  'ALTER TABLE shift_audit_log ADD COLUMN user_note TEXT',
  'ALTER TABLE shift_audit_log ADD COLUMN not_notified INTEGER DEFAULT 0',
];
auditMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});

// Leave: add hours_taken column, migrate existing days to hours (using 7.4 h/day default)
const leaveMigrations = [
  'ALTER TABLE leave_entries ADD COLUMN hours_taken REAL',
];
leaveMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* already exists */ }
});
// Back-fill hours_taken from days_taken for any rows that predate this migration
db.exec(`UPDATE leave_entries SET hours_taken = ROUND(days_taken * 7.4, 2) WHERE hours_taken IS NULL`);

// -----------------------------------------
// Unique index on shifts(date, start_time, end_time)
// Without this, INSERT OR IGNORE never deduplicates -- every import creates fresh rows.
// First remove any exact duplicates (keep lowest id), then create the index.
// -----------------------------------------
try {
  // Remove duplicates -- keep the row with the lowest id for each (date, start_time, end_time) triple
  db.exec(`
    DELETE FROM shifts
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM shifts
      GROUP BY date, start_time, end_time
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_unique_date_times ON shifts(date, start_time, end_time)`);
} catch (_) { /* index already exists */ }

const payslipMigrations = [
  'ALTER TABLE payslips ADD COLUMN addt_hours_prev_qty REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN addt_hours_prev_amount REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN annual_leave_adj_curr REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN annual_leave_adj_prev REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN bank_hol_curr_qty REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN bank_hol_curr_amount REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN bank_hol_prev_qty REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN bank_hol_prev_amount REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN company_sick_pay REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN company_sick_pay_is_prev INTEGER DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN sip_contribution REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN sharesave_amount REAL DEFAULT 0',
  'ALTER TABLE payslips ADD COLUMN sharesave_description TEXT',
  'ALTER TABLE payslips ADD COLUMN other_pay_description TEXT',
];
payslipMigrations.forEach(sql => {
  try { db.exec(sql); } catch (_) { /* column already exists -- safe to ignore */ }
});


// -----------------------------------------
// Shift audit log
// -----------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS shift_audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id    INTEGER,
    action      TEXT NOT NULL,
    changed_fields TEXT,
    old_values  TEXT,
    new_values  TEXT,
    source      TEXT NOT NULL DEFAULT 'manual',
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_shift_id ON shift_audit_log(shift_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created  ON shift_audit_log(created_at);
`);

// -----------------------------------------
// Tax refunds
// -----------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS tax_refunds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tax_year   TEXT NOT NULL,
    amount     REAL NOT NULL,
    date       TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed leave-related settings defaults
const leaveSettings = [
  ['annual_leave_entitlement', '28'],
  ['annual_leave_hours', ''],
  ['leave_year_start', '04-01'],
  ['hours_per_day', '7.4'],
  ['job_start_date', '2024-09-24'],
];
const upsertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
leaveSettings.forEach(([k, v]) => upsertSetting.run(k, v));
upsertSetting.run('user_dob', '');

// -----------------------------------------
// Performance indexes (added 2026-07-13). shifts.date is filtered in nearly every
// query; leave_entries is range-scanned by the calendar/insights. calendar_notes,
// clock_entries and payslips already have UNIQUE (auto-indexed) key columns.
// -----------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);
  CREATE INDEX IF NOT EXISTS idx_shifts_completed_date ON shifts(completed, date);
  CREATE INDEX IF NOT EXISTS idx_leave_dates ON leave_entries(start_date, end_date);
`);

// -----------------------------------------
// Seed default data (only if tables are empty)
// -----------------------------------------

const rateCount = db.prepare('SELECT COUNT(*) as c FROM pay_rates').get();
if (rateCount.c === 0) {
  const insertRate = db.prepare(
    'INSERT INTO pay_rates (effective_date, hourly_rate, contracted_hours_per_week, notes) VALUES (?, ?, ?, ?)'
  );
  insertRate.run('2024-01-01', 12.55, 14, 'Initial rate - 12.55/hr, 14h/week contract');
  insertRate.run('2025-04-01', 13.48, 14, 'April 2025 pay rise - 13.48/hr, still 14h/week contract');
  insertRate.run('2025-11-01', 13.48, 20, 'November 2025 - hours increased to 20h/week');
}

const settingCount = db.prepare('SELECT COUNT(*) as c FROM settings').get();
if (settingCount.c === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('default_distance_miles', '3.6');
  insertSetting.run('default_break_minutes', '30');
  insertSetting.run('employee_name', 'Ed Kay');
  insertSetting.run('employer', 'Screwfix');
}

// -----------------------------------------
// Helper: get the applicable pay rate for a given date
// -----------------------------------------

function getPayRateForDate(date) {
  return db.prepare(`
    SELECT * FROM pay_rates
    WHERE effective_date <= ?
    ORDER BY effective_date DESC
    LIMIT 1
  `).get(date);
}

// -----------------------------------------
// Helper: calculate hours worked
// -----------------------------------------

function calcHoursWorked(start_time, end_time, breakMins) {
  const [sh, sm] = start_time.split(':').map(Number);
  const [eh, em] = end_time.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  mins -= (parseInt(breakMins, 10) || 0);
  if (mins < 0) mins = 0;
  return Math.round((mins / 60) * 100) / 100;
}

// -----------------------------------------
// Helper: effective hourly rate for a colleague (V2.0 pay profiles)
// Hourly staff: their stored hourly_rate, as-is.
// Salaried staff: Annual Salary / (52 * Nominal Weekly Hours), rounded to 2dp.
// Returns null if the inputs needed for that pay type aren't set yet.
// -----------------------------------------
function effectiveHourlyRate(colleague) {
  if (!colleague) return null;
  if (colleague.pay_type === 'salaried') {
    if (!colleague.annual_salary || !colleague.nominal_weekly_hours) return null;
    return Math.round((colleague.annual_salary / (52 * colleague.nominal_weekly_hours)) * 100) / 100;
  }
  return colleague.hourly_rate != null ? colleague.hourly_rate : null;
}

/** Cost of a single shift for this colleague: duration (hrs) * effective hourly rate. */
function shiftCost(colleague, durationHours) {
  const rate = effectiveHourlyRate(colleague);
  if (rate == null || durationHours == null) return null;
  return Math.round(durationHours * rate * 100) / 100;
}

module.exports = { db, getPayRateForDate, calcHoursWorked, effectiveHourlyRate, shiftCost };
