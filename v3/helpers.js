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
  paidHours, shiftPay, rateForDate, contractHoursForDate,
  round1, round2, pct, clamp,
};
