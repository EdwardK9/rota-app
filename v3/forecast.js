/* ─── 🔮 Pay Forecast (V3.0) ───────────────────────────────────────────────
   GET /api/v3/forecast[?tax_year=2025]

   Projects the current UK tax year to its 5 April finish line: what you'll have
   grossed, what HMRC will have taken, and what actually lands in your account.

   Three sources are stitched together, in descending order of certainty:
     1. payslips already logged        — banked, exact
     2. shifts logged but not yet paid — near-certain, priced at your real rate
     3. the remaining weeks            — projected from your contracted hours

   Tax and NI are computed from the standard England/Wales bands, which are
   editable in settings if the thresholds move. It's an estimate, and the
   response says so — student loan, pension and salary sacrifice aren't modelled.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, getNumSetting, localDateStr, parseDate, addDays, daysBetween,
  paidHours, shiftPay, rateForDate, contractHoursForDate, round2, round1,
} = require('./helpers');

const router = express.Router();

/* 2025/26 England & Wales defaults. Overridable via settings so a Budget change
   doesn't need a code change. */
const TAX_DEFAULTS = {
  personal_allowance: 12570,
  basic_rate_limit:   50270,   // top of the 20% band (income, not taxable income)
  higher_rate_limit:  125140,
  basic_rate:  0.20,
  higher_rate: 0.40,
  additional_rate: 0.45,
  ni_primary_threshold: 12570,
  ni_upper_limit: 50270,
  ni_main_rate: 0.08,
  ni_upper_rate: 0.02,
};

function taxConfig() {
  const cfg = {};
  for (const [key, fallback] of Object.entries(TAX_DEFAULTS)) {
    cfg[key] = getNumSetting('v3_tax_' + key, fallback);
  }
  return cfg;
}

/** Income tax on an annual gross, using cumulative bands. */
function incomeTax(gross, c) {
  // The personal allowance tapers away by £1 for every £2 over £100,000.
  const taper = Math.max(0, Math.min(c.personal_allowance, (gross - 100000) / 2));
  const allowance = Math.max(0, c.personal_allowance - taper);
  if (gross <= allowance) return 0;

  let tax = 0;
  const basicBand  = Math.max(0, Math.min(gross, c.basic_rate_limit) - allowance);
  const higherBand = Math.max(0, Math.min(gross, c.higher_rate_limit) - Math.max(allowance, c.basic_rate_limit));
  const addBand    = Math.max(0, gross - c.higher_rate_limit);

  tax += basicBand  * c.basic_rate;
  tax += higherBand * c.higher_rate;
  tax += addBand    * c.additional_rate;
  return round2(tax);
}

/** Employee National Insurance on an annual gross. */
function nationalInsurance(gross, c) {
  const main  = Math.max(0, Math.min(gross, c.ni_upper_limit) - c.ni_primary_threshold);
  const upper = Math.max(0, gross - c.ni_upper_limit);
  return round2(main * c.ni_main_rate + upper * c.ni_upper_rate);
}

/** UK tax year containing a date: 6 April YYYY to 5 April YYYY+1. */
function taxYearFor(dateStr) {
  const d = parseDate(dateStr);
  const startYear = (d.getMonth() + 1 > 4 || (d.getMonth() + 1 === 4 && d.getDate() >= 6))
    ? d.getFullYear() : d.getFullYear() - 1;
  return { startYear, from: `${startYear}-04-06`, to: `${startYear + 1}-04-05` };
}

router.get('/forecast', (req, res) => {
  const today = localDateStr();
  const requested = parseInt(req.query.tax_year, 10);
  const ty = Number.isFinite(requested)
    ? { startYear: requested, from: `${requested}-04-06`, to: `${requested + 1}-04-05` }
    : taxYearFor(today);
  const cfg = taxConfig();

  // ── 1. Banked: payslips already logged inside this tax year ──────────────
  // A payslip's month is the month it was paid in, which is what determines the
  // tax year it falls into.
  const payslips = db.prepare('SELECT * FROM payslips WHERE month >= ? AND month <= ? ORDER BY month ASC')
    .all(ty.from.slice(0, 7), ty.to.slice(0, 7));
  const bankedGross = round2(payslips.reduce((t, p) => t + (p.total_gross || 0), 0));
  const bankedTax   = round2(payslips.reduce((t, p) => t + (p.tax_paid || 0), 0));
  const bankedNI    = round2(payslips.reduce((t, p) => t + (p.ni_employee || 0), 0));
  const bankedNet   = round2(payslips.reduce((t, p) => t + (p.net_payment || 0), 0));
  const lastPaidMonth = payslips.length ? payslips[payslips.length - 1].month : null;

  // ── 2. Worked/booked but not yet on a payslip ────────────────────────────
  // Everything after the last payslipped month, so the two never double-count.
  // "-32" is deliberate: dates compare as plain strings here, and no real date
  // sorts above it, so this cleanly means "past the end of that month".
  const unpaidFrom = lastPaidMonth ? `${lastPaidMonth}-32` : ty.from;
  const shifts = db.prepare('SELECT * FROM shifts WHERE date > ? AND date <= ? ORDER BY date ASC')
    .all(unpaidFrom, ty.to);
  const worked    = shifts.filter(s => s.date <= today);
  const scheduled = shifts.filter(s => s.date > today);
  const workedGross    = round2(worked.reduce((t, s) => t + (shiftPay(s) || 0), 0));
  const scheduledGross = round2(scheduled.reduce((t, s) => t + (shiftPay(s) || 0), 0));

  // ── 3. The gap after the rota runs out ───────────────────────────────────
  // Priced at your contracted weekly hours × current rate — the honest "if
  // nothing changes" baseline rather than an optimistic extrapolation of a
  // busy patch.
  const rotaEndsOn = shifts.length ? shifts[shifts.length - 1].date : today;
  const gapFrom = rotaEndsOn > today ? rotaEndsOn : today;
  const gapDays = Math.max(0, daysBetween(gapFrom, ty.to));
  const gapWeeks = round1(gapDays / 7);
  const rate = rateForDate(today) || 0;
  const contracted = contractHoursForDate(today) || 0;
  const projectedGap = round2(gapWeeks * contracted * rate);

  const projectedGross = round2(bankedGross + workedGross + scheduledGross + projectedGap);

  // ── Tax on the projected annual figure ───────────────────────────────────
  const projectedTax = incomeTax(projectedGross, cfg);
  const projectedNI  = nationalInsurance(projectedGross, cfg);
  const projectedNet = round2(projectedGross - projectedTax - projectedNI);

  const remainingTax = round2(Math.max(0, projectedTax - bankedTax));
  const remainingNI  = round2(Math.max(0, projectedNI - bankedNI));

  const effectiveRate = projectedGross > 0
    ? round1(((projectedTax + projectedNI) / projectedGross) * 100) : 0;

  // How much of the year is behind you — useful context for how firm the
  // projection is.
  const yearDays = daysBetween(ty.from, ty.to) || 1;
  const elapsed = Math.min(yearDays, Math.max(0, daysBetween(ty.from, today)));

  res.json({
    tax_year: { label: `${ty.startYear}/${String(ty.startYear + 1).slice(2)}`, ...ty },
    today,
    elapsed_pct: round1((elapsed / yearDays) * 100),
    banked:    { gross: bankedGross, tax: bankedTax, ni: bankedNI, net: bankedNet, payslips: payslips.length,
                 last_month: lastPaidMonth },
    worked_unpaid:  { gross: workedGross, shifts: worked.length,
                      hours: round1(worked.reduce((t, s) => t + paidHours(s), 0)) },
    scheduled:      { gross: scheduledGross, shifts: scheduled.length,
                      hours: round1(scheduled.reduce((t, s) => t + paidHours(s), 0)),
                      rota_ends: shifts.length ? rotaEndsOn : null },
    projected_gap:  { gross: projectedGap, weeks: gapWeeks, contracted_hours: contracted, rate },
    projection: {
      gross: projectedGross,
      tax: projectedTax,
      ni: projectedNI,
      net: projectedNet,
      effective_deduction_pct: effectiveRate,
      tax_still_to_pay: remainingTax,
      ni_still_to_pay: remainingNI,
      monthly_net_average: round2(projectedNet / 12),
      // The point in the year where you stop working for HMRC and start
      // working for yourself — a nicer way to read the effective rate.
      tax_freedom_day: (() => {
        if (projectedGross <= 0) return null;
        const share = (projectedTax + projectedNI) / projectedGross;
        return addDays(ty.from, Math.round(share * yearDays));
      })(),
    },
    bands: cfg,
    caveat: 'Estimate only — assumes a standard tax code and no student loan, pension or salary sacrifice deductions.',
  });
});

module.exports = router;
module.exports.incomeTax = incomeTax;
module.exports.nationalInsurance = nationalInsurance;
module.exports.taxYearFor = taxYearFor;
