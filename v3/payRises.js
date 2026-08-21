/* ─── 📈 Pay Rise History (V3.0) ───────────────────────────────────────────
   GET /api/v3/pay-rises

   Every change to your hourly rate, what each one was worth as a percentage,
   how long you waited between them, and what the cumulative effect has been
   since you started.

   Also compares each rise against the National Living Wage for that year, since
   for retail hourly work "am I still above the floor, and by how much?" is the
   question that actually matters — a 5% rise means little if the legal minimum
   went up 6%.

   NLW figures are baked in (they are published years ahead and change once a
   year) but overridable via settings, e.g. v3_nlw_2027.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, MONTHS, getSetting, localDateStr, daysBetween, paidHours, round1, round2,
} = require('./helpers');

const router = express.Router();

/* UK National Living Wage (23+/21+ main rate), April each year. */
const NLW = {
  2021: 8.91, 2022: 9.50, 2023: 10.42, 2024: 11.44,
  2025: 12.21, 2026: 12.71,
};

function nlwFor(year) {
  const override = parseFloat(getSetting('v3_nlw_' + year, ''));
  if (Number.isFinite(override) && override > 0) return override;
  // Fall back to the most recent year we do know about
  const years = Object.keys(NLW).map(Number).filter(y => y <= year).sort((a, b) => b - a);
  return years.length ? NLW[years[0]] : null;
}

router.get('/pay-rises', (req, res) => {
  const today = localDateStr();
  const rates = db.prepare('SELECT * FROM pay_rates ORDER BY effective_date ASC').all();

  if (!rates.length) return res.json({ rises: [], summary: null, today });

  const rises = rates.map((r, i) => {
    const prev = i > 0 ? rates[i - 1] : null;
    const year = parseInt(r.effective_date.slice(0, 4), 10);
    const nlw = nlwFor(year);
    const next = rates[i + 1];
    const until = next ? next.effective_date : null;

    // What you actually earned while this rate was in force
    const earned = db.prepare(
      'SELECT COUNT(*) AS shifts, SUM(calculated_pay) AS pay, SUM(hours_paid) AS hours FROM shifts WHERE date >= ?' +
      (until ? ' AND date < ?' : '')
    ).get(...(until ? [r.effective_date, until] : [r.effective_date]));

    const changePct = prev && prev.hourly_rate > 0
      ? round1(((r.hourly_rate - prev.hourly_rate) / prev.hourly_rate) * 100) : null;
    const hoursChanged = prev && prev.contracted_hours_per_week !== r.contracted_hours_per_week;

    return {
      id: r.id,
      effective_date: r.effective_date,
      until,
      hourly_rate: r.hourly_rate,
      contracted_hours: r.contracted_hours_per_week,
      notes: r.notes || null,
      is_first: i === 0,
      change: prev ? round2(r.hourly_rate - prev.hourly_rate) : null,
      change_pct: changePct,
      rate_changed: prev ? Math.abs(r.hourly_rate - prev.hourly_rate) > 0.001 : false,
      hours_changed: hoursChanged,
      hours_change: hoursChanged ? round1(r.contracted_hours_per_week - prev.contracted_hours_per_week) : null,
      days_since_previous: prev ? daysBetween(prev.effective_date, r.effective_date) : null,
      // Weekly value of the change at contracted hours — the number that shows
      // up in your bank account rather than the abstract percentage
      weekly_value: prev
        ? round2((r.hourly_rate * r.contracted_hours_per_week) -
                 (prev.hourly_rate * prev.contracted_hours_per_week)) : null,
      nlw: nlw,
      above_nlw: nlw ? round2(r.hourly_rate - nlw) : null,
      above_nlw_pct: nlw ? round1(((r.hourly_rate - nlw) / nlw) * 100) : null,
      worked: {
        shifts: earned.shifts || 0,
        hours: round1(earned.hours || 0),
        pay: round2(earned.pay || 0),
      },
      current: !until,
    };
  });

  const first = rises[0];
  const current = rises[rises.length - 1];
  const realRises = rises.filter(r => r.rate_changed);
  const gaps = realRises.map(r => r.days_since_previous).filter(n => n != null);

  // Days since the last actual rate change — the "am I due one?" number
  const lastRise = [...rises].reverse().find(r => r.rate_changed) || first;
  const daysSinceRise = daysBetween(lastRise.effective_date, today);

  const summary = {
    first_rate: first.hourly_rate,
    first_date: first.effective_date,
    current_rate: current.hourly_rate,
    current_since: current.effective_date,
    current_contracted: current.contracted_hours_per_week,
    total_change: round2(current.hourly_rate - first.hourly_rate),
    total_change_pct: first.hourly_rate > 0
      ? round1(((current.hourly_rate - first.hourly_rate) / first.hourly_rate) * 100) : 0,
    rise_count: realRises.length,
    avg_rise_pct: realRises.length
      ? round1(realRises.reduce((t, r) => t + (r.change_pct || 0), 0) / realRises.length) : 0,
    avg_gap_days: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    days_since_last_rise: daysSinceRise,
    months_since_last_rise: round1(daysSinceRise / 30.44),
    last_rise_date: lastRise.effective_date,
    nlw_now: current.nlw,
    above_nlw: current.above_nlw,
    above_nlw_pct: current.above_nlw_pct,
    // Extra earned so far this year purely because of the latest rise
    annual_value_of_last_rise: lastRise.weekly_value != null
      ? round2(lastRise.weekly_value * 52) : null,
  };

  // What you'd have earned at the old rate — the cumulative benefit of every rise
  const allShifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?')
    .all(first.effective_date, today);
  const actualPay = round2(allShifts.reduce((t, s) => t + (s.calculated_pay || 0), 0));
  const atFirstRate = round2(allShifts.reduce((t, s) => t + paidHours(s) * first.hourly_rate, 0));

  res.json({
    rises,
    summary: {
      ...summary,
      actual_pay_since_start: actualPay,
      pay_at_original_rate: atFirstRate,
      cumulative_benefit: round2(actualPay - atFirstRate),
    },
    months: MONTHS,
    today,
  });
});

module.exports = router;
