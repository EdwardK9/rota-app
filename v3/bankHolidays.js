/* ─── UK bank holidays (V3.0) ──────────────────────────────────────────────
   A shared, persistent source of England & Wales bank holiday dates.

   Why V3 needs this rather than just reading shifts.is_bank_holiday: that flag
   is only set when a shift is created with it, or when a recalc/Rotageek sync
   happens to fill it in. Plenty of genuinely-worked bank holidays sit in the
   table with the flag still 0, so anything counting them has to check the real
   calendar as well as the flag.

   The list is cached in the settings table, not just in memory, so it survives
   container restarts and keeps working if gov.uk is unreachable.
   ───────────────────────────────────────────────────────────────────────── */

const https = require('https');
const { getSetting, setSetting } = require('./helpers');

const CACHE_KEY = 'v3_bank_holidays_cache';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;   // dates change rarely; a week is plenty

let memo = null;   // { at, dates: Set }

function readCache() {
  try {
    const raw = getSetting(CACHE_KEY, null);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.dates)) return null;
    return { at: parsed.at || 0, dates: new Set(parsed.dates) };
  } catch (_) { return null; }
}

function writeCache(dates) {
  try {
    setSetting(CACHE_KEY, JSON.stringify({ at: Date.now(), dates: [...dates] }));
  } catch (_) { /* cache is a nicety, never fatal */ }
}

function fetchFromGov() {
  return new Promise(resolve => {
    const req = https.get('https://www.gov.uk/bank-holidays.json', { timeout: 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const division = data['england-and-wales'] || data[Object.keys(data)[0]];
          const events = division.events || [];
          resolve(events.map(e => ({ date: e.date, title: e.title })));
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** Set of 'YYYY-MM-DD' bank holiday dates. Never rejects — on failure it falls
 *  back to the last known list, or an empty set if there has never been one. */
async function bankHolidayDates() {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.dates;

  const cached = readCache();
  if (cached && Date.now() - cached.at < TTL_MS) {
    memo = cached;
    return memo.dates;
  }

  const fresh = await fetchFromGov();
  if (fresh) {
    const dates = new Set(fresh.map(e => e.date));
    // Titles are handy for the countdown board, so keep them alongside
    try { setSetting('v3_bank_holidays_titles', JSON.stringify(fresh)); } catch (_) {}
    writeCache(dates);
    memo = { at: Date.now(), dates };
    return dates;
  }

  // Offline: stale cache beats nothing
  const stale = cached || readCache();
  memo = stale || { at: 0, dates: new Set() };
  return memo.dates;
}

/** Full list with titles, for anything that wants to name the holiday. */
async function bankHolidayList() {
  await bankHolidayDates();
  try {
    const raw = getSetting('v3_bank_holidays_titles', null);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}

/** True if this shift should count as a bank holiday: either it was flagged as
 *  one, or its date really is one. */
function isBankHolidayShift(shift, dates) {
  return !!shift.is_bank_holiday || dates.has(shift.date);
}

module.exports = { bankHolidayDates, bankHolidayList, isBankHolidayShift };
