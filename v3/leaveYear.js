/* ─── Leave-year maths (V3.0) ──────────────────────────────────────────────
   A server-side mirror of the Leave view's own definition of "remaining".
   public/js/leave.js is the source of truth; this exists so V3 reports the same
   number rather than inventing a parallel one. If the rules there change, change
   them here too.

   The three rules that are easy to get wrong, and were:

     1. Entitlement is per leave year and stored in HOURS, under
        `leave_hours_<year>` (or the legacy `leave_entitlement_<year>` in days,
        multiplied by hours_per_day). The global `annual_leave_entitlement`
        setting is NOT what the Leave view uses.
     2. Only 'annual' leave counts against the entitlement — sick, unpaid and
        the rest are tracked but don't reduce your holiday.
     3. An unset entitlement means "not configured yet" (null), which is a very
        different thing from "fully used" (0 remaining).
   ───────────────────────────────────────────────────────────────────────── */

const { db, getSetting, getNumSetting, localDateStr, parseDate, round1, round2 } = require('./helpers');

/** The leave year containing `today`, as the Leave view computes it:
 *  [<lyYear>-<MM-DD>, <lyYear+1>-<MM-DD>) — end-exclusive. */
function leaveYearWindow(today = localDateStr()) {
  const lys = getSetting('leave_year_start', '04-01');
  const [lm, ld] = lys.split('-').map(Number);
  const d = parseDate(today);
  // Before this year's cutoff means we're still in the leave year that opened
  // last calendar year.
  const cutoff = new Date(d.getFullYear(), (lm || 4) - 1, ld || 1, 12, 0, 0);
  const lyYear = d >= cutoff ? d.getFullYear() : d.getFullYear() - 1;
  return { lyYear, lys, start: `${lyYear}-${lys}`, end: `${lyYear + 1}-${lys}` };
}

/** Entitlement in hours for a leave year, or null when it has never been set. */
function entitlementHours(lyYear) {
  const hpd = getNumSetting('hours_per_day', 7.4);
  const perYearHrs = parseFloat(getSetting(`leave_hours_${lyYear}`, ''));
  if (Number.isFinite(perYearHrs) && perYearHrs > 0) return round2(perYearHrs);
  const perYearDays = parseFloat(getSetting(`leave_entitlement_${lyYear}`, ''));
  if (Number.isFinite(perYearDays) && perYearDays > 0) return round2(perYearDays * hpd);
  return null;   // not configured — deliberately not 0
}

/** Everything the countdown board needs about the current leave year. */
function leaveSummary(today = localDateStr()) {
  const win = leaveYearWindow(today);
  const hpd = getNumSetting('hours_per_day', 7.4);
  const entitlement = entitlementHours(win.lyYear);

  const rows = db.prepare(
    'SELECT leave_type, days_taken, hours_taken FROM leave_entries WHERE start_date >= ? AND start_date < ?'
  ).all(win.start, win.end);

  // hours_taken is back-filled for legacy rows, but fall back anyway
  const hoursOf = r => (r.hours_taken != null ? r.hours_taken : (r.days_taken || 0) * hpd);
  const usedAnnual = round2(rows.filter(r => r.leave_type === 'annual').reduce((t, r) => t + hoursOf(r), 0));
  const usedOther  = round2(rows.filter(r => r.leave_type !== 'annual').reduce((t, r) => t + hoursOf(r), 0));

  return {
    ...win,
    hours_per_day: hpd,
    entitlement_hours: entitlement,
    used_annual_hours: usedAnnual,
    used_other_hours: usedOther,
    remaining_hours: entitlement == null ? null : round2(entitlement - usedAnnual),
    remaining_days: entitlement == null || hpd <= 0 ? null : round1((entitlement - usedAnnual) / hpd),
    configured: entitlement != null,
  };
}

module.exports = { leaveSummary };
