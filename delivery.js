/* ─── Delivery schedule helpers ─────────────────────────────────────────────
   A delivery schedule is "from this date onwards, deliveries land on these
   weekdays, each at its own time". Rows are kept rather than overwritten, so a
   shift from March is still judged against March's delivery times even after
   they change — that's what keeps Insights honest about the past.

   Two columns describe the times, because `days` predates them both:
     days          '3,5'                       — which weekdays (0=Sun … 6=Sat)
     day_times     '{"3":"06:00","5":"18:00"}' — that day's time, where set
     delivery_time '18:00'                     — fallback for a day with no entry

   day_times is the source of truth; delivery_time covers days it doesn't
   mention and rows saved before per-day times existed.

   Pure functions only (no database), so they can be shared by the weather
   overlay, the briefing and the Insights query, and tested directly.
   ───────────────────────────────────────────────────────────────────────── */

// Used when a schedule row predates the time columns, or a client omits them.
const DEFAULT_DELIVERY_TIME = '18:00';

// How far either side of the target a shift still counts as "on for delivery".
const DELIVERY_WINDOW_MINUTES = 60;

/** 'HH:MM' (or 'H:MM') -> 'HH:MM'; '' -> default; anything else -> null. */
function normaliseDeliveryTime(value) {
  if (value == null || value === '') return DEFAULT_DELIVERY_TIME;
  const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** The weekday indices a schedule row covers, as strings. */
function scheduleDays(schedule) {
  return String((schedule && schedule.days) || '')
    .split(',').map(d => d.trim()).filter(Boolean);
}

/**
 * Parse the day_times column. Bad JSON or a bad time is dropped rather than
 * thrown: a schedule with one unreadable entry should still deliver on the
 * other days, and the fallback time is always a sensible answer.
 */
function parseDayTimes(raw) {
  if (!raw) return {};
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [day, time] of Object.entries(obj)) {
    const d = String(day).trim();
    const t = normaliseDeliveryTime(time);
    if (/^[0-6]$/.test(d) && t) out[d] = t;
  }
  return out;
}

/** Serialise a {dow: 'HH:MM'} map for storage, keeping only valid entries. */
function serialiseDayTimes(map) {
  return JSON.stringify(parseDayTimes(map));
}

/** What time delivery lands on this weekday under this schedule row. */
function timeForDay(schedule, dow) {
  const dayTimes = parseDayTimes(schedule && schedule.day_times);
  return dayTimes[String(dow)]
    || normaliseDeliveryTime(schedule && schedule.delivery_time)
    || DEFAULT_DELIVERY_TIME;
}

/**
 * The ± window around a delivery time, clamped to the day so a 00:30 or 23:30
 * delivery doesn't produce a time that sorts outside 'HH:MM' comparisons.
 */
function deliveryWindow(time) {
  const norm = normaliseDeliveryTime(time) || DEFAULT_DELIVERY_TIME;
  const [h, m] = norm.split(':').map(Number);
  const target = h * 60 + m;
  const clamp = (mins) => Math.max(0, Math.min(24 * 60 - 1, mins));
  const fmt = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return {
    from: fmt(clamp(target - DELIVERY_WINDOW_MINUTES)),
    to:   fmt(clamp(target + DELIVERY_WINDOW_MINUTES)),
  };
}

/**
 * SQL that evaluates to 1 when a shift row was on the floor for that date's
 * delivery. Overlap, not start time: a 14:00–18:45 shift covers an 18:00
 * delivery even though it started four hours earlier.
 *
 * One branch per (schedule, weekday) pair rather than per schedule, because
 * Wednesday's delivery and Friday's can land at different times.
 *
 * @param schedules rows of { effective_from, days, day_times, delivery_time },
 *                  newest first
 * @returns a SQL expression string, or null when there are no delivery days
 */
function deliveryCaseSql(schedules) {
  // Newest first, and each period bounded above by the next one's start. Without
  // the upper bound a weekday dropped from the current schedule would still be
  // matched by an older branch, whose `date >=` alone stays true for every later
  // date.
  const ordered = [...(schedules || [])]
    .filter(s => s && s.effective_from)
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));

  const branches = [];
  ordered.forEach((s, i) => {
    const until = i > 0 ? ` AND date < '${ordered[i - 1].effective_from}'` : '';
    for (const day of scheduleDays(s)) {
      const w = deliveryWindow(timeForDay(s, day));
      branches.push(
        `WHEN date >= '${s.effective_from}'${until} AND strftime('%w', date) = '${day}'`
        + ` AND start_time <= '${w.to}' AND end_time >= '${w.from}' THEN 1`
      );
    }
  });
  if (!branches.length) return null;
  return `(CASE ${branches.join('\n         ')} ELSE 0 END)`;
}

module.exports = {
  DEFAULT_DELIVERY_TIME,
  DELIVERY_WINDOW_MINUTES,
  normaliseDeliveryTime,
  scheduleDays,
  parseDayTimes,
  serialiseDayTimes,
  timeForDay,
  deliveryWindow,
  deliveryCaseSql,
};
