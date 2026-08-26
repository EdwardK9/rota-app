/* ─── 💷 Tax Check (V3.0) ──────────────────────────────────────────────────
   GET /api/v3/tax-check[?tax_year=YYYY]

   Pay Forecast projects what tax you will pay. This checks what you actually
   did — every payslip in a tax year against what PAYE should have deducted.

   PAYE is cumulative, and that is the whole trick to checking it. By month n of
   the tax year you have had n twelfths of your personal allowance, so the tax
   due to date is simply the tax on (gross so far minus allowance so far), and
   what you were charged this month is that total minus what you had already
   paid. Getting a refund in your pay packet after a quiet month isn't a mistake
   — it's the system correcting itself, and this shows that happening rather
   than flagging it.

   National Insurance is the opposite: worked out fresh each month on that
   month's pay alone, with no memory. A quiet month never gets NI back. Both are
   checked on their own terms.

   What this is actually for: catching an emergency code. On BR or 0T you get no
   allowance at all and hand over 20% of everything from the first pound, which
   on a part-time wage is real money and is invisible unless somebody adds it
   up. If the numbers agree, that is worth knowing too.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, localDateStr, parseDate, round2 } = require('./helpers');
const { taxConfig, incomeTax, nationalInsurance } = require('./forecast');

const router = express.Router();

/* How far out a period can be before it's called wrong rather than rounding.
   HMRC works to whole pence and rounds the allowance monthly, so a few pence of
   drift each month is normal and expected. */
const TOLERANCE = 2.00;

/** Month keys of a tax year, April first, paired with the period number PAYE
 *  uses (April = 1). */
function taxYearPeriods(startYear) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;
    const y = startYear + (3 + i >= 12 ? 1 : 0);
    out.push({ month: `${y}-${String(m).padStart(2, '0')}`, period: i + 1 });
  }
  return out;
}

function currentTaxYear(today) {
  const d = parseDate(today);
  const month = d.getMonth() + 1;
  return (month > 4 || (month === 4 && d.getDate() >= 6)) ? d.getFullYear() : d.getFullYear() - 1;
}

/** Cumulative income tax due by period n, the way a payroll system works it:
 *  the annual bands scaled to n twelfths of the year. */
function cumulativeTaxDue(cumGross, period, cfg) {
  const fraction = period / 12;
  const scaled = {
    ...cfg,
    personal_allowance: cfg.personal_allowance * fraction,
    basic_rate_limit: cfg.basic_rate_limit * fraction,
    higher_rate_limit: cfg.higher_rate_limit * fraction,
  };
  return incomeTax(cumGross, scaled);
}

/** NI for one month, on that month's gross alone. */
function periodNi(gross, cfg) {
  const scaled = {
    ...cfg,
    ni_primary_threshold: cfg.ni_primary_threshold / 12,
    ni_upper_limit: cfg.ni_upper_limit / 12,
  };
  return nationalInsurance(gross, scaled);
}

router.get('/tax-check', (req, res) => {
  const today = localDateStr();
  const startYear = /^\d{4}$/.test(req.query.tax_year || '')
    ? Number(req.query.tax_year) : currentTaxYear(today);
  const cfg = taxConfig();

  const all = db.prepare('SELECT * FROM payslips ORDER BY month ASC').all();
  const byMonth = new Map(all.map(p => [p.month, p]));
  const periods = taxYearPeriods(startYear);

  let cumGross = 0, cumTaxPaid = 0, cumTaxDue = 0, cumNiPaid = 0, cumNiDue = 0;
  const rows = [];

  for (const { month, period } of periods) {
    const p = byMonth.get(month);
    if (!p) { rows.push({ month, period, present: false }); continue; }

    const gross = p.total_gross || 0;
    const taxPaid = p.tax_paid || 0;
    const niPaid = p.ni_employee || 0;

    cumGross = round2(cumGross + gross);
    cumTaxPaid = round2(cumTaxPaid + taxPaid);
    cumNiPaid = round2(cumNiPaid + niPaid);

    const dueToDate = round2(cumulativeTaxDue(cumGross, period, cfg));
    const periodTaxDue = round2(dueToDate - cumTaxDue);
    cumTaxDue = dueToDate;

    const niDue = periodNi(gross, cfg);
    cumNiDue = round2(cumNiDue + niDue);

    // The payslip's own YTD figures are a second opinion on the running totals
    // here. Where they disagree it's nearly always a typo in one payslip rather
    // than anything the employer did.
    const ytdMismatch = p.gross_ytd && Math.abs(p.gross_ytd - cumGross) > TOLERANCE
      ? round2(p.gross_ytd - cumGross) : null;

    rows.push({
      month, period, present: true,
      payment_date: p.payment_date,
      gross: round2(gross),
      cumulative_gross: cumGross,
      tax_paid: round2(taxPaid),
      tax_due: periodTaxDue,
      tax_diff: round2(taxPaid - periodTaxDue),
      cumulative_tax_paid: cumTaxPaid,
      cumulative_tax_due: cumTaxDue,
      cumulative_tax_diff: round2(cumTaxPaid - cumTaxDue),
      // A negative period figure is a refund through the payroll, which is
      // normal after a quiet month and worth naming so it doesn't read as a bug.
      refund_in_period: taxPaid < -0.005,
      ni_paid: round2(niPaid),
      ni_due: niDue,
      ni_diff: round2(niPaid - niDue),
      gross_ytd_on_payslip: p.gross_ytd || null,
      tax_ytd_on_payslip: p.tax_ytd || null,
      ytd_mismatch: ytdMismatch,
      ok: Math.abs(taxPaid - periodTaxDue) <= TOLERANCE && Math.abs(niPaid - niDue) <= TOLERANCE,
    });
  }

  const checked = rows.filter(r => r.present);
  const last = checked[checked.length - 1] || null;

  /* ── Does this look like an emergency code? ────────────────────────────── */
  // On BR/0T there is no allowance, so tax is a flat share of gross from the
  // first pound. That shows up as paying materially more than the cumulative
  // calculation says, consistently, rather than in one odd month.
  const overpaying = last && last.cumulative_tax_diff > Math.max(TOLERANCE, last.cumulative_gross * 0.01);
  const flatRate = checked.length >= 2 && checked.every(r =>
    r.gross > 0 && Math.abs(r.tax_paid / r.gross - cfg.basic_rate) < 0.02);

  /* ── What allowance do the deductions actually imply? ─────────────────────
     While earnings stay inside the basic band the arithmetic inverts cleanly:
     tax = (gross − allowance × n/12) × 20%, so the allowance the payroll was
     really working to is (gross − tax ÷ 20%) × 12/n. That turns "£32 more than
     expected" into "they're using a code around 1240L", which is the difference
     between a number you can query and a number you can only be annoyed by. */
  let implied = null;
  if (last && last.cumulative_gross > 0 && last.cumulative_tax_paid > 0
      && last.cumulative_gross < cfg.basic_rate_limit * (last.period / 12)) {
    const allowance = round2(
      (last.cumulative_gross - last.cumulative_tax_paid / cfg.basic_rate) * (12 / last.period));
    implied = {
      allowance,
      expected_allowance: cfg.personal_allowance,
      difference: round2(allowance - cfg.personal_allowance),
      // Tax codes are the allowance with the last digit dropped, so this is a
      // close read rather than a certainty — the letter especially.
      code: `${Math.floor(Math.max(0, allowance) / 10)}L`,
      expected_code: `${Math.floor(cfg.personal_allowance / 10)}L`,
      // Below ~£1000 of allowance nothing sensible is being applied at all,
      // which is what BR and 0T look like from the outside.
      looks_like_no_allowance: allowance < 1000,
    };
  }

  const refunds = db.prepare('SELECT * FROM tax_refunds ORDER BY date DESC').all();
  const yearLabel = `${startYear}/${startYear + 1}`;
  const refundThisYear = refunds.filter(r =>
    r.tax_year === yearLabel || r.tax_year === `${startYear}/${String(startYear + 1).slice(2)}`);

  const availableYears = [...new Set(all.map(p => {
    const [y, m] = p.month.split('-').map(Number);
    return m >= 4 ? y : y - 1;
  }))].sort((a, b) => b - a);

  res.json({
    today,
    tax_year: startYear,
    tax_year_label: `${startYear}/${String(startYear + 1).slice(2)}`,
    available_years: availableYears.length ? availableYears : [startYear],
    config: {
      personal_allowance: cfg.personal_allowance,
      basic_rate: cfg.basic_rate,
      ni_primary_threshold: cfg.ni_primary_threshold,
      ni_main_rate: cfg.ni_main_rate,
      monthly_allowance: round2(cfg.personal_allowance / 12),
      monthly_ni_threshold: round2(cfg.ni_primary_threshold / 12),
    },
    rows,
    summary: last ? {
      payslips_checked: checked.length,
      as_at: last.month,
      cumulative_gross: last.cumulative_gross,
      tax_paid: last.cumulative_tax_paid,
      tax_due: last.cumulative_tax_due,
      tax_diff: last.cumulative_tax_diff,
      ni_paid: round2(checked.reduce((t, r) => t + r.ni_paid, 0)),
      ni_due: round2(checked.reduce((t, r) => t + r.ni_due, 0)),
      ni_diff: round2(checked.reduce((t, r) => t + (r.ni_diff || 0), 0)),
      months_off: checked.filter(r => !r.ok).length,
      verdict: !last ? 'nothing to check'
        : Math.abs(last.cumulative_tax_diff) <= TOLERANCE ? 'tax looks right'
        : last.cumulative_tax_diff > 0 ? 'paying more than expected'
        : 'paying less than expected',
      likely_emergency_code: !!(overpaying && flatRate) || !!(implied && implied.looks_like_no_allowance),
      implied_allowance: implied,
      // What is still actually outstanding, once anything already handed back
      // is taken off — an overpayment that was refunded in June isn't a debt.
      outstanding: round2(last.cumulative_tax_diff -
        refundThisYear.reduce((t, r) => t + (r.amount || 0), 0)),
      // Tax already handed back, so an overpayment that has since been refunded
      // isn't reported as still outstanding.
      refunded: round2(refundThisYear.reduce((t, r) => t + (r.amount || 0), 0)),
    } : null,
    refunds: refunds.map(r => ({ tax_year: r.tax_year, amount: r.amount, date: r.date, notes: r.notes })),
    ytd_mismatches: checked.filter(r => r.ytd_mismatch != null)
      .map(r => ({ month: r.month, diff: r.ytd_mismatch,
                   payslip_says: r.gross_ytd_on_payslip, adds_up_to: r.cumulative_gross })),
  });
});

module.exports = router;
