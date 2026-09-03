/* ─── V5.0 shared helpers ──────────────────────────────────────────────────
   Everything the V5 usage-analytics modules need, kept self-contained the same
   way v3/helpers.js is: V5 shares the app's SQLite handle and nothing else, so
   the whole feature set can be lifted out (or switched off) by deleting the one
   mount line in server.js.
   ───────────────────────────────────────────────────────────────────────── */

const { db } = require('../db');

const DAYS       = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

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

/** A settings flag that defaults to ON unless it has been explicitly turned off.
 *  Used for `v5_analytics_enabled`; location is the opposite (see below). */
function flagOn(key, defaultOn) {
  const raw = getSetting(key, null);
  if (raw === null) return !!defaultOn;
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** The two privacy switches, resolved in one place so the ingest endpoint and
 *  the settings page can never disagree about what "off" means.
 *  Usage tracking is on by default (it's local-only and the whole point of the
 *  feature set); location is OFF until it's deliberately turned on, because GPS
 *  is the part someone might not want recorded. */
function privacyFlags() {
  return {
    analytics: flagOn('v5_analytics_enabled', true),
    location:  flagOn('v5_location_enabled', false),
    locationOnOpen: flagOn('v5_location_on_open', false),
    retentionDays: Math.max(0, Math.round(getNumSetting('v5_retention_days', 365))),
  };
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

/** The `days=` query param, clamped, plus the cutoff date it implies.
 *  `days=all` (or 0) means "everything ever recorded". */
function windowFromQuery(query, fallbackDays = 90) {
  const raw = query.days;
  if (raw === 'all' || raw === '0') return { days: 'all', since: '0000-01-01' };
  const n = Math.min(3650, Math.max(1, parseInt(raw || fallbackDays, 10) || fallbackDays));
  return { days: n, since: addDays(localDateStr(), -(n - 1)) };
}

function toMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** "1h 24m" / "42m" / "18s" — durations read far better than raw milliseconds
 *  and every V5 view wants the same phrasing. */
function humanMs(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ── Geo ──────────────────────────────────────────────────────────────── */

const R_EARTH_M = 6371000;

/** Great-circle distance in metres. Fine at the scale this is used at (a
 *  commute), and it needs no dependencies. */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function metresToMiles(m) { return m / 1609.344; }

/** Every place a recorded point can be labelled with: the user's own saved
 *  places, plus Home and Work inferred from the commute postcodes that are
 *  already in settings, so labels work before anything has been set up here. */
function allPlaces() {
  const saved = db.prepare('SELECT * FROM v5_places ORDER BY id ASC').all()
    .map(p => ({ ...p, source: 'saved' }));

  const implied = [];
  const addImplied = (id, name, icon, latKey, lonKey) => {
    const lat = parseFloat(getSetting(latKey, ''));
    const lon = parseFloat(getSetting(lonKey, ''));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    // A saved place of the same name wins — it's the one that was set up here
    // deliberately, and it can have its own radius.
    if (saved.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
    implied.push({ id: null, key: id, name, icon, lat, lon, radius_m: 200, source: 'commute' });
  };
  addImplied('home', 'Home', '🏠', 'commute_home_lat', 'commute_home_lon');
  addImplied('work', 'Work', '🏪', 'commute_work_lat', 'commute_work_lon');

  return [...saved, ...implied];
}

/** Nearest place within its own radius, or null for "somewhere else". */
function labelPoint(lat, lon, places) {
  if (lat == null || lon == null) return null;
  let best = null, bestDist = Infinity;
  for (const p of places) {
    const d = haversineMetres(lat, lon, p.lat, p.lon);
    if (d <= (p.radius_m || 200) && d < bestDist) { best = p; bestDist = d; }
  }
  return best ? { name: best.name, icon: best.icon || '📍', distance_m: Math.round(bestDist) } : null;
}

/* ── Numbers ──────────────────────────────────────────────────────────── */

const round1 = n => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const pct    = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0);

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

module.exports = {
  db, DAYS, DAYS_SHORT,
  getSetting, getNumSetting, setSetting, flagOn, privacyFlags,
  localDateStr, parseDate, addDays, daysBetween, windowFromQuery, toMins, humanMs,
  haversineMetres, metresToMiles, allPlaces, labelPoint,
  round1, round2, pct, median,
};
