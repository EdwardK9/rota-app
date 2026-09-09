/* ─── Delivery schedule helpers ─────────────────────────────────────────────
   A delivery schedule is "from this date onwards, deliveries land on these
   weekdays at this time". Rows are kept rather than overwritten, so a shift
   from March is still judged against March's delivery time even after the
   time changes — that's what keeps Insights honest about the past.

   Pure functions only (no database), so they can be shared by the weather
   overlay and the Insights query, and tested directly.
   ───────────────────────────────────────────────────────────────────────── */

// Used when a schedule row predates the time column, or a client omits it.
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
 * @param schedules rows of { effective_from, days, delivery_time }, newest first
 * @returns a SQL expression string, or null when there are no delivery days
 */
function deliveryCaseSql(schedules) {
  const branches = (schedules || [])
    .filter(s => s.days && s.days.trim())
    .map(s => {
      const daysList = s.days.split(',').map(d => `'${d.trim()}'`).join(',');
      const w = deliveryWindow(s.delivery_time);
      return `WHEN date >= '${s.effective_from}' AND strftime('%w', date) IN (${daysList})`
           + ` AND start_time <= '${w.to}' AND end_time >= '${w.from}' THEN 1`;
    });
  if (!branches.length) return null;
  return `(CASE ${branches.join('\n         ')} ELSE 0 END)`;
}

module.exports = {
  DEFAULT_DELIVERY_TIME,
  DELIVERY_WINDOW_MINUTES,
  normaliseDeliveryTime,
  deliveryWindow,
  deliveryCaseSql,
};
