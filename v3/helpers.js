/* ─── V3.0 shared helpers ──────────────────────────────────────────────────
   Small utilities every V3 module needs. Deliberately self-contained: V3 talks
   to the same SQLite handle as the rest of the app but keeps its own date/pay
   helpers here so the V3 feature set can be lifted out (or turned off) without
   touching server.js or db.js beyond the single mount line.
   ───────────────────────────────────────────────────────────────────────── */

const { db } = require('../db');

const DAYS       = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS     = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

/* ── Settings ─────────────────────────────────────────────────────────── */

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value !== '' ? row.value : fallback;
}

function getNumSetting(key, fallback) {
  const v = parseFloat(getSetting(key, ''));
  return Number.isFinite(v) ? v : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/* ── Dates ────────────────────────────────────────────────────────────── */

const pad = n => String(n).padStart(2, '0');

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a YYYY-MM-DD string as local noon — avoids every DST/UTC off-by-one. */
function parseDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

function daysBetween(fromStr, toStr) {
  return Math.round((parseDate(toStr) - parseDate(fromStr)) / 86400000);
}

/** Monday of the week containing dateStr (ISO weeks — Mon..Sun). */
function mondayOf(dateStr) {
  const d = parseDate(dateStr);
  return addDays(dateStr, -((d.getDay() + 6) % 7));
}

function dowIndex(dateStr) { return parseDate(dateStr).getDay(); }        // 0 = Sun
function isWeekend(dateStr) { const d = dowIndex(dateStr); return d === 0 || d === 6; }

/* ── Times ────────────────────────────────────────────────────────────── */

function toMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function fromMins(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Length of a shift in minutes, handling an overnight end time. */
function spanMins(start, end) {
  let mins = toMins(end) - toMins(start);
  if (mins <= 0) mins += 1440;
  return mins;
}

/** Minutes two time ranges overlap on the same day. */
function overlapMins(s1, e1, s2, e2) {
  return Math.max(0, Math.min(toMins(e1), toMins(e2)) - Math.max(toMins(s1), toMins(s2)));
}

/* ── Pay ──────────────────────────────────────────────────────────────── */

/** Paid hours for a shift row — the scheduled break is always deducted, which
 *  is how the Shifts tab and the payslip reconciliation both count it. */
function paidHours(shift) {
  if (shift.hours_paid != null) return shift.hours_paid;
  if (shift.hours_worked != null) return shift.hours_worked;
  return Math.max(0, spanMins(shift.start_time, shift.end_time) - (shift.break_scheduled_minutes || 0)) / 60;
}

function shiftPay(shift) {
  if (shift.calculated_pay != null) return shift.calculated_pay;
  const rate = shift.hourly_rate != null ? shift.hourly_rate : rateForDate(shift.date);
  if (rate == null) return 0;
  return round2(paidHours(shift) * rate * (shift.is_bank_holiday ? 2 : 1));
}

let _rateCache = null;
function allRates() {
  if (!_rateCache) _rateCache = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();
  return _rateCache;
}
/** Rates change rarely but a stale cache would be wrong for the rest of the
 *  process's life, so every request-scoped read refreshes it. */
function refreshRates() { _rateCache = null; return allRates(); }

function rateRecordForDate(dateStr) {
  let found = null;
  for (const r of refreshRates()) if (r.effective_date <= dateStr) found = r;
  return found;
}

function rateForDate(dateStr) {
  const r = rateRecordForDate(dateStr);
  return r ? r.hourly_rate : null;
}

function contractHoursForDate(dateStr) {
  const r = rateRecordForDate(dateStr);
  return r ? r.contracted_hours_per_week : null;
}

/* ── Whose shifts? ────────────────────────────────────────────────────── */

/**
 * Every V3 module is written against the `shifts` table — my shifts, with a
 * break, a rate and a pay figure on each row. Colleague shifts live in a much
 * thinner table: date, times, store, nothing else. Rather than teach eight
 * modules a second data model, this returns a FROM-clause fragment that makes
 * a colleague's shifts look exactly like mine, so the existing SQL and the
 * existing paidHours/shiftPay maths carry over untouched.
 *
 * The two derived columns are the whole trick:
 *   break_scheduled_minutes — the same policy everyone is on (autoBreakMinutes)
 *   hourly_rate             — the rate for their ROLE as of that shift's date,
 *                             or their own if they're flagged as an exception
 *
 * distance_miles is deliberately always NULL: mileage is a property of MY
 * commute, and there's no colleague equivalent to be had. Anything costing a
 * journey should skip colleagues rather than invent a number for them.
 *
 * Pass the result where a table name goes: `FROM ${shiftsSource(id)} s`.
 */
function shiftsSource(colleagueId) {
  if (!colleagueId) return 'shifts';
  const id = parseInt(colleagueId, 10);
  if (!Number.isInteger(id)) return 'shifts';

  // Minutes between start and end, wrapping past midnight — the SQL twin of
  // spanMins() above.
  const DUR = `(((CAST(substr(cs.end_time,1,2) AS INTEGER) * 60 + CAST(substr(cs.end_time,4,2) AS INTEGER))
                - (CAST(substr(cs.start_time,1,2) AS INTEGER) * 60 + CAST(substr(cs.start_time,4,2) AS INTEGER))
                + 1440) % 1440)`;

  // Mirrors autoBreakMinutes() in db.js: >8h → 45, >6h → 30, >=4h30 → 15, else
  // 0. The 4h30 step is inclusive and the others are not — see db.js for why.
  // Has to be SQL, so it cannot call it.
  const BREAK = `(CASE WHEN ${DUR} > 480 THEN 45
                       WHEN ${DUR} > 360 THEN 30
                       WHEN ${DUR} >= 270 THEN 15
                       ELSE 0 END)`;

  // Their own figures only when flagged as an exception; otherwise the role's
  // rate as of this shift's date, so past shifts keep their historic cost.
  const OWN_RATE = `(CASE WHEN c.pay_type = 'salaried'
                          THEN CASE WHEN c.annual_salary > 0 AND c.nominal_weekly_hours > 0
                                    THEN ROUND(c.annual_salary / (52.0 * c.nominal_weekly_hours), 2) END
                          ELSE c.hourly_rate END)`;
  const ROLE_RATE = `(SELECT CASE WHEN rp.pay_type = 'salaried'
                                  THEN CASE WHEN rp.annual_salary > 0 AND rp.nominal_weekly_hours > 0
                                            THEN ROUND(rp.annual_salary / (52.0 * rp.nominal_weekly_hours), 2) END
                                  ELSE rp.hourly_rate END
                        FROM role_pay rp
                       WHERE rp.role = c.job_tier AND rp.effective_date <= cs.date
                       ORDER BY rp.effective_date DESC LIMIT 1)`;
  const RATE = `(CASE WHEN c.pay_override = 1 THEN ${OWN_RATE} ELSE COALESCE(${ROLE_RATE}, ${OWN_RATE}) END)`;

  const PAID_HOURS = `ROUND(MAX(0, ${DUR} - ${BREAK}) / 60.0, 2)`;

  return `(
    SELECT
      cs.id                       AS id,
      cs.date                     AS date,
      cs.start_time               AS start_time,
      cs.end_time                 AS end_time,
      ${BREAK}                    AS break_scheduled_minutes,
      'full'                      AS break_taken,
      ${BREAK}                    AS break_taken_minutes,
      ${PAID_HOURS}               AS hours_worked,
      ${PAID_HOURS}               AS hours_paid,
      ${RATE}                     AS hourly_rate,
      ROUND(${PAID_HOURS} * COALESCE(${RATE}, 0), 2) AS calculated_pay,
      -- A rostered shift in the past is one they worked; there's no per-colleague
      -- completion flag to consult, and treating everything as incomplete would
      -- empty every "completed = 1" query the modules run.
      CASE WHEN cs.date <= date('now') THEN 1 ELSE 0 END AS completed,
      0                           AS is_bank_holiday,
      NULL                        AS notes,
      NULL                        AS distance_miles,
      cs.store                    AS store,
      cs.created_at               AS created_at,
      cs.created_at               AS updated_at
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.colleague_id = ${id}
      AND cs.shift_type = 'shift'
      AND (cs.store IS NULL OR cs.store = '')
  )`;
}

/* ── Numbers ──────────────────────────────────────────────────────────── */

const round1 = n => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const pct    = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0);
const clamp  = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

module.exports = {
  db, DAYS, MONTHS,
  getSetting, getNumSetting, setSetting,
  localDateStr, parseDate, addDays, daysBetween, mondayOf, dowIndex, isWeekend,
  toMins, fromMins, spanMins, overlapMins,
  paidHours, shiftPay, rateForDate, contractHoursForDate, shiftsSource,
  round1, round2, pct, clamp,
};
