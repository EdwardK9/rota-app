/* ─── 🧾 Pay Audit (V3.0) ──────────────────────────────────────────────────
   GET /api/v3/pay-audit[?tax_year=YYYY]

   The Payslips tab flags a month whose money doesn't match. It can't tell you
   whether that means you were underpaid, because two things get in the way:
   basic pay is a fixed monthly amount whatever you actually work, and hours
   above contract are paid a month in arrears. So a busy month looks short, the
   next one looks long, and neither is a problem.

   How the pay actually works — read off 22 real payslips rather than assumed:

     • Basic is contracted weekly hours × 52 ÷ 12 × rate. A constant. On a 20h
       contract that is 86.67 hours every month, in a short month and a long
       one alike, and it doesn't move when you work less.
     • Additional hours are counted PER WEEK, not per month: each week's hours
       above contract, with no credit for a quiet week the other side of it.

   That second point is worth being explicit about, because guessing it wrong
   changes the answer a lot. Across every payslip on file, additional hours
   actually paid came to 250.5. Totalling each week's excess predicts 263.75 —
   within 5%. Doing the same sum month by month, where a light week cancels a
   heavy one, predicts 174, which is nowhere near. So: weekly.

   Everything is then totalled from the start of the tax year and compared as
   running totals. Hours paid late close their own gap the following month and
   the cumulative line returns to zero; hours never paid at all open a gap that
   stays open. That gap is the only number here worth acting on.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, parseDate, addDays, mondayOf,
  paidHours, rateForDate, contractHoursForDate, round1, round2,
} = require('./helpers');

const router = express.Router();

/* Weeks per month, as payroll uses it: 52 ÷ 12. This is what basic pay is
   actually built from — not the number of working days in the month, which is
   how the Reports tab spreads contracted hours, a different convention for a
   different purpose. */
const WEEKS_PER_MONTH = 52 / 12;

/* Under a quarter of an hour either way is somebody's rounding, not a dispute. */
const HOURS_TOLERANCE = 0.25;
/* Basic is a fixed figure, so more than a pound out is a real difference — a
   contract change mid-month, unpaid absence, or a typo in the record. */
const BASIC_TOLERANCE = 1.00;

function taxYearMonths(startYear) {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;
    const y = startYear + (3 + i >= 12 ? 1 : 0);
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
}

function currentTaxYear(today) {
  const d = parseDate(today);
  const month = d.getMonth() + 1;
  return (month > 4 || (month === 4 && d.getDate() >= 6)) ? d.getFullYear() : d.getFullYear() - 1;
}

router.get('/pay-audit', (req, res) => {
  const today = localDateStr();
  const startYear = /^\d{4}$/.test(req.query.tax_year || '')
    ? Number(req.query.tax_year) : currentTaxYear(today);
  const months = taxYearMonths(startYear);
  const from = `${startYear}-04-06`, to = `${startYear + 1}-04-05`;

  const payslipRows = db.prepare('SELECT * FROM payslips ORDER BY month ASC').all();
  const payslipByMonth = new Map(payslipRows.map(p => [p.month, p]));

  /* ── Weekly excess ─────────────────────────────────────────────────────── */
  // Pull a week either side so a week straddling 6 April is counted whole.
  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? AND date <= ? AND completed = 1 ORDER BY date ASC'
  ).all(addDays(from, -7), addDays(to, 7));

  const hoursByDate = new Map();
  for (const s of shifts) {
    hoursByDate.set(s.date, round2((hoursByDate.get(s.date) || 0) + paidHours(s)));
  }

  const weeks = [];
  for (let w = mondayOf(from); w <= mondayOf(to); w = addDays(w, 7)) {
    let worked = 0;
    const days = [];
    for (let k = 0; k < 7; k++) {
      const d = addDays(w, k);
      const h = hoursByDate.get(d) || 0;
      worked += h;
      if (h) days.push({ date: d, hours: round1(h) });
    }
    const contract = contractHoursForDate(w) || 0;
    weeks.push({
      week_start: w,
      // A week is attributed to the month its Monday falls in. A week straddling
      // a month end therefore lands slightly early or late — exactly the kind of
      // error the cumulative view exists to absorb.
      month: w.slice(0, 7),
      worked: round2(worked),
      contract,
      excess: round2(Math.max(0, worked - contract)),
      days,
    });
  }

  const weeksByMonth = new Map();
  for (const w of weeks) {
    if (!weeksByMonth.has(w.month)) weeksByMonth.set(w.month, []);
    weeksByMonth.get(w.month).push(w);
  }

  /* ── Month by month ────────────────────────────────────────────────────── */
  let cumOwed = 0, cumPaid = 0;
  const rows = [];

  for (const month of months) {
    const monthWeeks = weeksByMonth.get(month) || [];
    const payslip = payslipByMonth.get(month) || null;
    const nextMonth = months[months.indexOf(month) + 1] || `${startYear + 1}-04`;
    const next = payslipByMonth.get(nextMonth) || null;

    const worked = round2(monthWeeks.reduce((t, w) => t + w.worked, 0));
    const owed = round2(monthWeeks.reduce((t, w) => t + w.excess, 0));

    // Extra actually paid for this month's work: this payslip's own additional
    // hours plus the next one's previous-period column.
    const paidThis = payslip ? (payslip.additional_hours_qty || 0) : 0;
    const paidNext = next ? (next.addt_hours_prev_qty || 0) : 0;
    const paid = round2(paidThis + paidNext);

    const rate = rateForDate(month + '-01') || 0;
    const weekly = contractHoursForDate(month + '-01') || 0;
    const expectedBasic = round2(weekly * WEEKS_PER_MONTH * rate);
    const basicDiff = payslip ? round2((payslip.basic_pay || 0) - expectedBasic) : null;

    // Nothing to judge until the following payslip exists — that is where most
    // of this month's extra is going to appear.
    const awaiting = !!payslip && !next && owed > 0;
    const hasWork = monthWeeks.some(w => w.worked > 0);

    if (payslip || hasWork) {
      cumOwed = round2(cumOwed + owed);
      cumPaid = round2(cumPaid + paid);
    }

    rows.push({
      month,
      has_payslip: !!payslip,
      has_work: hasWork,
      awaiting_next_payslip: awaiting,
      weeks: monthWeeks.length,
      worked_hours: worked,
      contracted_monthly: round2(weekly * WEEKS_PER_MONTH),
      contracted_weekly: weekly,
      extra_owed: owed,
      extra_paid: paid,
      extra_paid_this_month: round2(paidThis),
      extra_paid_next_month: round2(paidNext),
      month_gap: round2(paid - owed),
      cumulative_owed: cumOwed,
      cumulative_paid: cumPaid,
      cumulative_gap: round2(cumPaid - cumOwed),
      basic_pay: payslip ? payslip.basic_pay : null,
      expected_basic: expectedBasic,
      basic_diff: basicDiff,
      basic_ok: basicDiff == null ? null : Math.abs(basicDiff) <= BASIC_TOLERANCE,
      gross: payslip ? payslip.total_gross : null,
      rate,
      week_detail: monthWeeks.map(w => ({
        week_start: w.week_start, worked: w.worked, contract: w.contract, excess: w.excess,
      })),
    });
  }

  /* ── Where it stands ───────────────────────────────────────────────────── */
  const settled = rows.filter(r => r.has_payslip && !r.awaiting_next_payslip);
  const last = settled[settled.length - 1] || null;

  // A month only counts as short if it clears the same proportional margin the
  // headline uses. Without that, a month owing 11 hours and paid 10.75 gets a
  // section of its own, which is noise dressed up as a finding.
  const shortMonths = rows.filter(r =>
    r.has_work && r.extra_owed > 0 && !r.awaiting_next_payslip &&
    r.month_gap < -Math.max(HOURS_TOLERANCE * 2, r.extra_owed * 0.1));
  const basicIssues = rows.filter(r => r.basic_ok === false);

  const worst = shortMonths.slice().sort((a, b) => a.month_gap - b.month_gap)[0] || null;
  const worstWeeks = worst
    ? (weeksByMonth.get(worst.month) || []).filter(w => w.excess > 0)
        .map(w => ({ week_start: w.week_start, worked: w.worked, contract: w.contract,
                     excess: w.excess, days: w.days }))
    : [];

  const availableYears = [...new Set(payslipRows.map(p => {
    const [y, m] = p.month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  }))].sort((a, b) => b - a);

  const rate = last ? last.rate : (rateForDate(today) || 0);

  res.json({
    today,
    tax_year: startYear,
    tax_year_label: `${startYear}/${String(startYear + 1).slice(2)}`,
    available_years: availableYears.length ? availableYears : [startYear],
    rows,
    weeks: weeks.filter(w => w.worked > 0),
    totals: {
      worked_hours: round2(weeks.reduce((t, w) => t + w.worked, 0)),
      extra_owed: cumOwed,
      extra_paid: cumPaid,
      gross: round2(rows.reduce((t, r) => t + (r.gross || 0), 0)),
      weeks_over_contract: weeks.filter(w => w.excess > 0).length,
      weeks_worked: weeks.filter(w => w.worked > 0).length,
    },
    standing: last ? (() => {
      // The weekly model matched real payslips to within about 5% over two
      // years, so it is not precise enough to call a small surplus or shortfall
      // a finding. Anything inside an hour, or a tenth of what was owed, is the
      // model's own margin — week-versus-month boundaries, a bank holiday
      // handled its own way — and gets reported as square.
      const margin = Math.max(1, last.cumulative_owed * 0.1);
      const gap = last.cumulative_gap;
      return {
        as_at: last.month,
        hours_gap: gap,
        margin: round2(margin),
        verdict: gap < -margin ? 'short' : gap > margin ? 'over' : 'square',
        value: round2(Math.abs(gap) * rate),
        // Worth chasing only when it is both real money and outside the margin
        actionable: gap < -margin && Math.abs(gap) * rate >= 10,
      };
    })() : null,
    short_months: shortMonths.map(r => ({
      month: r.month, owed: r.extra_owed, paid: r.extra_paid, gap: r.month_gap,
    })),
    basic_issues: basicIssues.map(r => ({
      month: r.month, paid: r.basic_pay, expected: r.expected_basic, diff: r.basic_diff,
      contracted_weekly: r.contracted_weekly,
    })),
    worst_month: worst ? { month: worst.month, gap: worst.month_gap,
                           owed: worst.extra_owed, paid: worst.extra_paid } : null,
    worst_month_weeks: worstWeeks,
    pending: rows.filter(r => r.awaiting_next_payslip)
      .map(r => ({ month: r.month, extra_owed: r.extra_owed })),
  });
});

module.exports = router;
