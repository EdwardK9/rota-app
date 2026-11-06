/* ─── Leave hours, spread across the days they actually cover ───────────────
   A leave_entries row is a lump sum: one `hours_taken` figure for a date range,
   with no per-day breakdown. Anything that wants "how much leave falls in this
   month / this week" therefore has to spread that lump itself — and until this
   module existed, three places did it three different ways:

     • the weekly endpoint in server.js spread over Mon–Fri working days
     • v3/overtime.js spread over every calendar day, weekends included
     • the monthly report in server.js didn't spread at all — it grouped by
       strftime('%Y-%m', start_date), so a holiday running 30 Mar → 11 Apr was
       booked entirely to March and April looked 22 hours under contract

   All of them (and the Shifts page, calendar and health check, via the
   `daily_hours` field on GET /api/leave) now call in here.

   The rule — how a lump sum becomes days:
     • One leave day is worth contracted-hours-per-week / 5 (4h on a 20h
       contract), taken from the pay rate in force on the entry's first day.
       Falls back to the hours_per_day setting if there's no pay rate.
     • The number of days is hours_taken / that figure (32h → 8 days), at least 1.
     • Those days are the first N Mon–Fri days in the range; weekend days are
       only used once the weekdays run out (or if the range has none). So
       26 Oct → 4 Nov at 32h is 8 weekdays × 4h, skipping 31 Oct and 1 Nov, and a
       single Saturday at 4h is that Saturday.
     • If the range has no more days than that, every day is used and the hours
       are divided evenly between them.
   This replaces "an equal share of every calendar day", which gave 3.2h a day
   for the example above and never matched what Rotageek shows.

   Entries are selected by overlap (end_date >= from AND start_date <= to), not
   by which month or year they start in, so a range crossing the boundary
   contributes its share to both sides.

   Leave type is deliberately not filtered. `hours_taken` is what counts, and
   the only non-annual type in use (`day_off`) carries zero hours, so it costs
   nothing to include and means a future paid type is handled without a change
   here.
   ───────────────────────────────────────────────────────────────────────── */

const { db } = require('./db');

const DAY_MS = 86400000;

function toDate(s) { return new Date(s + 'T00:00:00'); }

function toStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultHoursPerDay() {
  const row = db.prepare("SELECT value FROM settings WHERE key='hours_per_day'").get();
  const n = parseFloat(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 7.4;
}

/** Hours one leave day is worth on a given date: weekly contract / 5. */
function leaveDayHours(dateStr) {
  const r = db.prepare(
    'SELECT contracted_hours_per_week AS c FROM pay_rates WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1'
  ).get(dateStr);
  return r && r.c > 0 ? r.c / 5 : defaultHoursPerDay();
}

/**
 * Spread one entry over the days it covers (see the rule above). Pure — no DB.
 * @returns {Object<string, number>} 'YYYY-MM-DD' -> hours, unclipped
 */
function spreadEntry(entry, dayHours, hpd = 7.4) {
  const start = toDate(entry.start_date);
  const end   = toDate(entry.end_date);
  if (!(end >= start)) return {};
  const total = entry.hours_taken != null ? entry.hours_taken : (entry.days_taken || 0) * hpd;
  if (!(total > 0)) return {};

  const all = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + DAY_MS)) all.push(new Date(d));

  const n = Math.max(1, Math.round(total / (dayHours > 0 ? dayHours : hpd)));
  let chosen = all;
  if (n < all.length) {
    const wk = all.filter(d => d.getDay() >= 1 && d.getDay() <= 5);
    const we = all.filter(d => d.getDay() === 0 || d.getDay() === 6);
    chosen = [...wk, ...we].slice(0, n);
  }

  const out = {};
  const perDay = total / chosen.length;
  for (const d of chosen) out[toStr(d)] = perDay;
  return out;
}

/**
 * Leave hours per calendar day across [from, to].
 * @returns {Object<string, number>} keyed 'YYYY-MM-DD'
 */
function leaveHoursByDay(from, to) {
  const rows = db.prepare(
    'SELECT start_date, end_date, hours_taken, days_taken FROM leave_entries WHERE end_date >= ? AND start_date <= ?'
  ).all(from, to);

  const hpd = defaultHoursPerDay();
  const out = {};
  for (const entry of rows) {
    const spread = spreadEntry(entry, leaveDayHours(entry.start_date), hpd);
    for (const [key, h] of Object.entries(spread)) {
      if (key < from || key > to) continue;   // clip to the window asked for
      out[key] = (out[key] || 0) + h;
    }
  }
  return out;
}

/** Leave hours per month across [from, to], keyed 'YYYY-MM'. */
function leaveHoursByMonth(from, to) {
  const out = {};
  for (const [day, hours] of Object.entries(leaveHoursByDay(from, to))) {
    const m = day.slice(0, 7);
    out[m] = (out[m] || 0) + hours;
  }
  return out;
}

/**
 * Leave hours per ISO week across [from, to], keyed by that week's Monday.
 * `mondayOf` is injected so callers keep using their own week convention.
 */
function leaveHoursByWeek(from, to, mondayOf) {
  const out = {};
  for (const [day, hours] of Object.entries(leaveHoursByDay(from, to))) {
    const wk = mondayOf(day);
    out[wk] = (out[wk] || 0) + hours;
  }
  return out;
}

module.exports = { spreadEntry, leaveDayHours, leaveHoursByDay, leaveHoursByMonth, leaveHoursByWeek, defaultHoursPerDay };
