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

   All three now call in here, and the rule is v3/overtime.js's: spread across
   every calendar day the entry covers, weekends included.

   The Mon–Fri rule the weekly endpoint used looks more correct and isn't. This
   is a retail rota that trades seven days and rotates across all of them — over
   the last twelve months 38% of shifts fell on a weekend, and Saturday is the
   single biggest day by hours. Confining leave to weekdays would pile it onto
   days often not worked, and an entry falling entirely on a weekend would
   divide by zero and silently vanish, leaving that week still reading as a
   shortfall.

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
    const start = toDate(entry.start_date);
    const end   = toDate(entry.end_date);
    if (!(end >= start)) continue;

    const total = entry.hours_taken != null
      ? entry.hours_taken
      : (entry.days_taken || 0) * hpd;
    if (!(total > 0)) continue;

    // Every calendar day the entry covers carries an equal share — see above
    // for why weekends are not excluded.
    const days = [];
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + DAY_MS)) days.push(new Date(d));
    if (!days.length) continue;

    const perDay = total / days.length;
    for (const d of days) {
      const key = toStr(d);
      if (key < from || key > to) continue;   // clip to the window asked for
      out[key] = (out[key] || 0) + perDay;
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

module.exports = { leaveHoursByDay, leaveHoursByMonth, leaveHoursByWeek, defaultHoursPerDay };
