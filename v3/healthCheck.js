/* ─── 🩺 Data Doctor (V3.0) ────────────────────────────────────────────────
   GET /api/v3/health-check

   Everything else in this app is only as good as what's in the database, and a
   lot of what's in the database arrived by OCR, a bookmarklet or a Rotageek
   sync. Those go wrong quietly: a shift lands twice, a week never imports at
   all, a rate change doesn't reach the rows it should have, a bank holiday sits
   there unflagged and paying single time. None of that announces itself — it
   just makes a number somewhere slightly wrong.

   This runs every check in one pass and reports what it finds with the actual
   rows attached, so a problem can be looked at rather than just counted.

   Deliberately read-only. Several of these look like errors and aren't: a shift
   on a leave day is usually a mistake but occasionally real, and a "stale" pay
   figure might be a manual override somebody meant. Nothing here edits, deletes
   or "fixes" anything — it points, and the existing tools (Shifts, the break
   audit, the recalc button in Settings) do the changing.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, addDays, daysBetween, mondayOf,
  toMins, spanMins, overlapMins, paidHours, rateForDate, contractHoursForDate, round1, round2,
} = require('./helpers');
const { autoBreakMinutes } = require('../db');
const { bankHolidayDates } = require('./bankHolidays');

const router = express.Router();

/* Tolerances. Money is stored to the penny and hours to two decimals, so these
   are just float-noise guards rather than judgement calls. */
const PAY_TOLERANCE = 0.05;
const HOURS_TOLERANCE = 0.02;
/* How far a clock-in can sit from the rostered start before it's worth a look.
   Fifteen minutes early is normal; an hour out usually means the shift record
   and the day that actually happened have diverged. */
const CLOCK_TOLERANCE_MINS = 60;

/** The rota's break policy, by shift length. A copy of autoBreakMinutes() in
 *  server.js — V3 doesn't reach into server.js, and this is only ever used to
 *  explain a discrepancy, never to change a break. If the policy there changes,
 *  change it here; the numbers are also written down in the README. */
function policyBreakMinutes(start, end) {
  // Was a hand-copied duplicate and drifted: it kept strict > boundaries after
  // db.js moved to inclusive ones, so every 4h30 shift looked like a
  // discrepancy that wasn't. Call the real thing instead.
  return autoBreakMinutes(start, end);
}

/** One finding. `items` carry enough to identify the row in the UI. */
function finding(code, severity, title, detail, items, fix) {
  return { code, severity, title, detail, count: items.length, items: items.slice(0, 50),
           truncated: Math.max(0, items.length - 50), fix };
}

router.get('/health-check', async (req, res) => {
  const today = localDateStr();
  const shifts = db.prepare('SELECT * FROM shifts ORDER BY date ASC, start_time ASC').all();
  const leave = db.prepare('SELECT * FROM leave_entries').all();
  const payslips = db.prepare('SELECT month FROM payslips').all();
  const clocks = db.prepare('SELECT * FROM clock_entries').all();
  const bhDates = await bankHolidayDates();

  const findings = [];
  const label = s => ({ id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time });

  /* ── Shift arithmetic ──────────────────────────────────────────────────── */
  const staleHours = [], stalePay = [], missingRate = [];
  for (const s of shifts) {
    const expectedHours = round2(
      Math.max(0, spanMins(s.start_time, s.end_time) - (s.break_scheduled_minutes || 0)) / 60);

    if (s.hours_worked != null && Math.abs(s.hours_worked - expectedHours) > HOURS_TOLERANCE) {
      // Which of the two fields is the stale one? The break implied by the hours
      // that were stored, next to the break the policy says this length gets,
      // usually settles it at a glance.
      const impliedBreak = Math.round(spanMins(s.start_time, s.end_time) - s.hours_worked * 60);
      const policy = policyBreakMinutes(s.start_time, s.end_time);
      staleHours.push({ ...label(s), stored: round2(s.hours_worked), expected: expectedHours,
                        diff: round2(expectedHours - s.hours_worked),
                        break_scheduled_minutes: s.break_scheduled_minutes,
                        break_implied_by_hours: impliedBreak,
                        policy_break: policy,
                        // The break field agrees with policy, so the hours are the odd one out
                        hours_are_stale: s.break_scheduled_minutes === policy });
    }

    const rate = s.hourly_rate != null ? s.hourly_rate : rateForDate(s.date);
    if (rate == null) {
      missingRate.push(label(s));
    } else if (s.calculated_pay != null) {
      const expectedPay = round2(expectedHours * rate * (s.is_bank_holiday ? 2 : 1));
      if (Math.abs(s.calculated_pay - expectedPay) > PAY_TOLERANCE) {
        stalePay.push({ ...label(s), stored: round2(s.calculated_pay), expected: expectedPay,
                        diff: round2(expectedPay - s.calculated_pay), rate,
                        is_bank_holiday: !!s.is_bank_holiday });
      }
    }
  }

  if (staleHours.length) findings.push(finding('stale_hours', 'warning',
    'Stored hours don\'t match the times',
    'The hours on these shifts aren\'t what their start, end and scheduled break add up to, so every total built on them is slightly off. Each row shows the break its stored hours imply next to the break the policy gives a shift that length — where those two disagree but the shift\'s own break field matches policy, it\'s the hours that went stale, usually left behind by an edit or a policy change.',
    staleHours, 'Recalculate in Settings rebuilds these. The break audit on the Shifts tab is the one to use if it\'s the break field that looks wrong instead.'));

  if (stalePay.length) findings.push(finding('stale_pay', 'warning',
    'Stored pay doesn\'t match hours × rate',
    'Calculated pay on these shifts isn\'t hours × rate (doubled on a bank holiday). Most often a backdated pay rise that never reached rows already in the table.',
    stalePay, 'Recalculate in Settings will rebuild these from the rate history.'));

  if (missingRate.length) findings.push(finding('missing_rate', 'error',
    'No pay rate covers these shifts',
    'These shifts have no rate of their own and no entry in Pay Rates effective on or before their date, so they count as £0 everywhere in the app.',
    missingRate, 'Add a Pay Rates entry starting on or before the earliest date listed.'));

  /* ── Bank holidays ─────────────────────────────────────────────────────── */
  const unflagged = shifts
    .filter(s => bhDates.has(s.date) && !s.is_bank_holiday)
    .map(s => ({ ...label(s), worth: round2(paidHours(s) * (s.hourly_rate || rateForDate(s.date) || 0)) }));
  if (unflagged.length) findings.push(finding('unflagged_bank_holiday', 'error',
    'Bank holidays not flagged',
    'These shifts fall on an England & Wales bank holiday but aren\'t marked as one, so they\'re being paid at single time in every calculation here. The figure shown is what the missing double-time half is worth.',
    unflagged, 'Tick Bank Holiday on the shift, or use the bank holiday fix in Settings.'));

  /* ── Duplicates and overlaps ───────────────────────────────────────────── */
  const byDate = new Map();
  for (const s of shifts) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const duplicates = [], overlaps = [];
  for (const [date, list] of byDate) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.start_time === b.start_time && a.end_time === b.end_time) {
          duplicates.push({ date, ids: [a.id, b.id], start_time: a.start_time, end_time: a.end_time });
        } else if (overlapMins(a.start_time, a.end_time, b.start_time, b.end_time) > 0) {
          overlaps.push({ date, ids: [a.id, b.id],
                          first: `${a.start_time}–${a.end_time}`, second: `${b.start_time}–${b.end_time}`,
                          overlap_mins: overlapMins(a.start_time, a.end_time, b.start_time, b.end_time) });
        }
      }
    }
  }
  if (duplicates.length) findings.push(finding('duplicate_shifts', 'error',
    'The same shift logged twice',
    'Identical date and times on two rows. An import that ran twice is the usual cause, and it inflates hours and pay everywhere.',
    duplicates, 'Delete one of each pair from the Shifts tab.'));

  if (overlaps.length) findings.push(finding('overlapping_shifts', 'warning',
    'Two shifts overlapping on one day',
    'Different times, but they overlap — so the hours are being counted twice for the period they share. A split shift entered as two rows is fine; anything else probably isn\'t.',
    overlaps, 'Check the day in Shifts and merge or correct the times.'));

  /* ── Shifts against leave ──────────────────────────────────────────────── */
  const leaveDates = new Map();
  // Hours per day too, spread across every day the entry covers — the same rule
  // as leaveHours.js. Needed by the under-contract check below, where counting a
  // zero-hour 'day_off' as if it were a full day would hide a real shortfall.
  const leaveHoursByDay = new Map();
  for (const l of leave) {
    let days = 0;
    for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) days++;
    const total = l.hours_taken != null ? l.hours_taken : 0;
    const perDay = days > 0 ? total / days : 0;
    for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) {
      leaveDates.set(d, l.leave_type);
      leaveHoursByDay.set(d, (leaveHoursByDay.get(d) || 0) + perDay);
    }
  }
  const onLeave = shifts.filter(s => leaveDates.has(s.date))
    .map(s => ({ ...label(s), leave_type: leaveDates.get(s.date) }));
  if (onLeave.length) findings.push(finding('shift_on_leave', 'warning',
    'A shift on a day booked as leave',
    'You were rostered and booked off on the same date. Either the leave entry covers a day you actually worked, or the shift should have come off the rota — and whichever it is, the day is currently being counted as both.',
    onLeave, 'Correct whichever of the two is wrong in Shifts or Leave.'));

  /* ── Past shifts never completed ───────────────────────────────────────── */
  const incomplete = shifts.filter(s => s.date < today && !s.completed).map(label);
  if (incomplete.length) findings.push(finding('past_incomplete', 'info',
    'Past shifts not marked complete',
    'These are in the past but still count as planned rather than worked, so they sit outside anything measuring what you actually did — records, trophies, break debt and the monthly worked-hours totals.',
    incomplete, 'Use Bulk Complete on the Shifts tab.'));

  /* ── Gaps in the rota ──────────────────────────────────────────────────── */
  // A week with nothing in it, sitting between two weeks that do have shifts,
  // is far more likely to be an import that failed than a week you had off —
  // a real week off normally has leave booked against it.
  const gaps = [];
  if (shifts.length) {
    const weeks = new Set(shifts.map(s => mondayOf(s.date)));
    const first = mondayOf(shifts[0].date);
    const last = mondayOf(shifts[shifts.length - 1].date);
    for (let w = addDays(first, 7); w < last; w = addDays(w, 7)) {
      if (weeks.has(w)) continue;
      const covered = [...Array(7)].some((_, k) => leaveDates.has(addDays(w, k)));
      if (covered) continue;
      gaps.push({ week_start: w, week_end: addDays(w, 6),
                  weeks_ago: Math.round(daysBetween(w, today) / 7) });
    }
  }
  if (gaps.length) findings.push(finding('rota_gap', 'warning',
    'Weeks with no shifts and no leave',
    'Nothing rostered and nothing booked off — between two weeks that do have shifts. Occasionally that\'s a genuine unpaid week, but far more often it\'s a week that never imported, which quietly drags down every average and streak in the app.',
    gaps, 'Re-import that week, or add a leave entry if you really were off.'));

  /* ── Weeks that came out under the weekly contract ─────────────────────── */
  // Ed is rostered at or above his contract essentially always, and payroll
  // never docks for a short week — only for sickness, which it then pays back.
  // So a completed week that lands under contract is a reliable sign the data
  // is wrong, not that he under-worked: a shift that never imported, or a break
  // deducted that wasn't taken. This is the check that would have caught the
  // 4h30 break bug and the phantom break on 14 Feb without anyone eyeballing
  // Rotageek. Leave and sickness both count towards the contract, so a week
  // covered by either is not short.
  const shortWeeks = [];
  {
    const byWeek = new Map();
    for (const s of shifts) {
      const wk = mondayOf(s.date);
      const e = byWeek.get(wk) || { hours: 0, sick: 0, ids: [] };
      e.hours += paidHours(s);
      if (s.absence_type === 'sick') e.sick += paidHours(s);
      e.ids.push(s.id);
      byWeek.set(wk, e);
    }
    const thisWeek = mondayOf(today);
    for (const [wk, e] of [...byWeek].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (wk >= thisWeek) continue;                       // still in progress
      const contract = contractHoursForDate(wk);
      if (!contract) continue;
      // Leave booked in this week also counts towards the contract, by its real
      // hours — a 'day_off' carries none and so must not paper over a shortfall.
      let leaveH = 0;
      for (let k = 0; k < 7; k++) leaveH += leaveHoursByDay.get(addDays(wk, k)) || 0;
      const covered = e.hours + leaveH;
      const short = round2(contract - covered);
      if (short > 0.01) {
        shortWeeks.push({ week_start: wk, week_end: addDays(wk, 6),
                          contracted: contract, covered: round2(covered),
                          short, sick_hours: round2(e.sick), shifts: e.ids.length });
      }
    }
  }
  if (shortWeeks.length) findings.push(finding('week_under_contract', 'warning',
    'Weeks that came out under the weekly contract',
    'You are rostered at or above contract essentially always, and payroll only ever docks for sickness — which it pays straight back. So a past week landing under contract usually means the data is wrong rather than the week was: a shift that never imported, or a break taken off that was never actually taken. Worth checking each against Rotageek.',
    shortWeeks, 'Compare the week against Rotageek (Import → Compare). If a break is the culprit, fix it and tick "Keep this break exactly as set".'));

  /* ── Months with shifts but no payslip ─────────────────────────────────── */
  const paidMonths = new Set(payslips.map(p => p.month));
  const thisMonth = today.slice(0, 7);
  const shiftMonths = [...new Set(shifts.filter(s => s.completed).map(s => s.date.slice(0, 7)))];
  const unpaidMonths = shiftMonths
    .filter(m => m < thisMonth && !paidMonths.has(m))
    .map(m => {
      const rows = shifts.filter(s => s.completed && s.date.startsWith(m));
      return { month: m, shifts: rows.length,
               hours: round1(rows.reduce((t, s) => t + paidHours(s), 0)) };
    });
  if (unpaidMonths.length) findings.push(finding('month_without_payslip', 'info',
    'Months worked with no payslip recorded',
    'You have completed shifts in these months but no payslip on file, so there is nothing to check the pay against — and they\'re missing from the yearly gross, tax and net totals.',
    unpaidMonths, 'Add the payslip from the Payslips tab, or import it.'));

  /* ── Leave without hours ───────────────────────────────────────────────── */
  const leaveNoHours = leave.filter(l => l.hours_taken == null)
    .map(l => ({ id: l.id, start_date: l.start_date, end_date: l.end_date,
                 days_taken: l.days_taken, leave_type: l.leave_type }));
  if (leaveNoHours.length) findings.push(finding('leave_missing_hours', 'info',
    'Leave entries with no hours recorded',
    'Entitlement is tracked in hours. These only have days, so anything reading them has to fall back to converting with your hours-per-day setting rather than what was really booked.',
    leaveNoHours, 'Open the entry in Leave and set the hours.'));

  /* ── Clock entries vs the rota ─────────────────────────────────────────── */
  const shiftByDate = new Map(shifts.map(s => [s.date, s]));
  const clockOddities = [];
  for (const c of clocks) {
    const s = shiftByDate.get(c.date);
    if (!s) {
      if (c.clocked_in) clockOddities.push({ date: c.date, issue: 'no shift on this date',
                                             clocked_in: c.clocked_in, clocked_out: c.clocked_out });
      continue;
    }
    if (!c.clocked_in) continue;
    const inDiff = Math.abs(toMins(c.clocked_in) - toMins(s.start_time));
    if (inDiff > CLOCK_TOLERANCE_MINS) {
      clockOddities.push({ date: c.date, issue: `clocked in ${Math.round(inDiff)} min from the rostered start`,
                           clocked_in: c.clocked_in, rostered: s.start_time });
    }
  }
  if (clockOddities.length) findings.push(finding('clock_mismatch', 'info',
    'Clock records that don\'t match the rota',
    'A clock-in an hour or more from the rostered start, or on a day with no shift at all. Sometimes it\'s a genuine early start; sometimes the shift record was never updated to what actually happened.',
    clockOddities, 'Compare the day in Clock In/Out against Shifts.'));

  /* ── Team data ─────────────────────────────────────────────────────────── */
  const teamZero = db.prepare(
    "SELECT cs.id, cs.date, cs.start_time, cs.end_time, c.name FROM colleague_shifts cs " +
    "JOIN colleagues c ON c.id = cs.colleague_id " +
    "WHERE cs.shift_type = 'shift' AND cs.start_time = cs.end_time"
  ).all();
  if (teamZero.length) findings.push(finding('team_zero_length', 'warning',
    'Team shifts with no length',
    'Start and end are the same, so these count as zero hours in team coverage and store-spend figures. Usually an all-day or leave row that came in from OCR typed as a normal shift.',
    teamZero, 'Fix the times, or change the type, in the Team Calendar.'));

  const teamOrphan = db.prepare(
    'SELECT COUNT(*) AS c FROM colleague_shifts WHERE colleague_id NOT IN (SELECT id FROM colleagues)'
  ).get();
  if (teamOrphan && teamOrphan.c > 0) findings.push(finding('team_orphans', 'warning',
    'Team shifts belonging to nobody',
    'Rows pointing at a colleague that no longer exists. They are invisible everywhere but still counted in raw totals.',
    [{ count: teamOrphan.c }], 'Delete them, or re-add the colleague.'));

  /* ── Score ─────────────────────────────────────────────────────────────── */
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');
  const infos = findings.filter(f => f.severity === 'info');

  // Weighted against how much data there is, so ten bad rows out of a few
  // hundred doesn't read the same as ten out of twelve.
  const rows = shifts.length + leave.length + clocks.length || 1;
  const affected = findings.reduce((t, f) =>
    t + f.count * (f.severity === 'error' ? 3 : f.severity === 'warning' ? 2 : 1), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - (affected / rows) * 100)));

  res.json({
    today,
    checked: {
      shifts: shifts.length,
      leave_entries: leave.length,
      clock_entries: clocks.length,
      payslips: payslips.length,
      colleague_shifts: db.prepare('SELECT COUNT(*) AS c FROM colleague_shifts').get().c,
      checks_run: 13,
    },
    score,
    verdict: errors.length ? 'needs attention' : warnings.length ? 'a few things to look at' : 'clean',
    counts: {
      errors: errors.reduce((t, f) => t + f.count, 0),
      warnings: warnings.reduce((t, f) => t + f.count, 0),
      info: infos.reduce((t, f) => t + f.count, 0),
      groups: findings.length,
    },
    findings,
  });
});

module.exports = router;
