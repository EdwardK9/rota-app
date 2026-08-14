/* ─── Team Pay & Analytics Dashboard (V2.0 Phase 3) ─────────────────────────
   Endpoint:
     GET /api/team-metrics?week=YYYY-MM-DD  — any date in the target Mon–Sun week

   Aggregates colleague_shifts + colleague pay profiles (Phase 1) into:
     - top-line cards: total store spend, your share of the pot, avg hourly wage
     - daily store spend (bar chart data)
     - pay distribution by job tier (donut chart data)
     - hourly coverage heatmap (headcount + cost, 06:00-23:00 x Mon-Sun)
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, effectiveHourlyRate, shiftCost } = require('./db');
const router = express.Router();

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Duration in hours for a colleague_shifts row. "all_day" rows use the
 *  hours_per_day setting (same one leave_entries uses) since they don't carry
 *  real start/end times (Rotageek OCR records them as 00:00-00:00). */
function shiftDurationHours(row, hoursPerDay) {
  if (row.shift_type === 'all_day') return hoursPerDay;
  let mins = toMins(row.end_time) - toMins(row.start_time);
  if (mins <= 0) mins += 24 * 60; // overnight
  return mins / 60;
}

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIER_LABELS = { management: 'Management', supervisor: 'Supervisor', floor_staff: 'Floor Staff' };

router.get('/team-metrics', (req, res) => {
  const weekParam = req.query.week || new Date().toISOString().slice(0, 10);
  const anchor = new Date(weekParam + 'T00:00:00');
  if (isNaN(anchor.getTime())) return res.status(400).json({ error: 'invalid week date' });

  const dow = (anchor.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const monday = new Date(anchor); monday.setDate(anchor.getDate() - dow);
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); return fmt(d);
  });
  const from = weekDates[0], to = weekDates[6];

  const hoursPerDay = parseFloat(getSetting('hours_per_day', '7.4')) || 7.4;

  // Colleague shifts for the week, joined with their pay profile + job tier.
  // Leave doesn't count towards store spend (we don't track colleague leave pay).
  const rows = db.prepare(`
    SELECT cs.*, c.pay_type, c.hourly_rate, c.annual_salary, c.nominal_weekly_hours, c.job_tier, c.name
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date >= ? AND cs.date <= ? AND cs.shift_type != 'leave'
    ORDER BY cs.date ASC, cs.start_time ASC
  `).all(from, to);

  let totalStoreSpend = 0, totalStoreHours = 0;
  const dailySpend = {}; weekDates.forEach(d => { dailySpend[d] = 0; });
  const tierSpend = { management: 0, supervisor: 0, floor_staff: 0 };
  const missingPayProfile = new Set();

  // Coverage heatmap: hours 06:00-23:00 (18 slots) x 7 days
  const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6..23
  const heatmap = {}; // date -> hour -> { headcount, cost }
  weekDates.forEach(d => { heatmap[d] = {}; HOURS.forEach(h => { heatmap[d][h] = { headcount: 0, cost: 0 }; }); });

  for (const row of rows) {
    const rate = effectiveHourlyRate(row);
    const durationHrs = shiftDurationHours(row, hoursPerDay);
    const hasRate = rate != null;
    if (!hasRate) missingPayProfile.add(row.name);

    if (hasRate) {
      const cost = Math.round(durationHrs * rate * 100) / 100;
      totalStoreSpend += cost;
      totalStoreHours += durationHrs;
      dailySpend[row.date] = Math.round((dailySpend[row.date] + cost) * 100) / 100;
      const tier = TIER_LABELS[row.job_tier] ? row.job_tier : 'floor_staff';
      tierSpend[tier] += cost;
    }

    // Heatmap contribution: which hour buckets does this shift cover? Headcount
    // reflects everyone actually on the floor regardless of pay-profile status —
    // only the cost side of the heatmap is limited to colleagues with a known rate.
    const coveredHours = row.shift_type === 'all_day'
      ? HOURS
      : HOURS.filter(h => {
          const hourStart = h * 60, hourEnd = (h + 1) * 60;
          let s = toMins(row.start_time), e = toMins(row.end_time);
          if (e <= s) e += 24 * 60; // overnight
          return s < hourEnd && e > hourStart;
        });
    coveredHours.forEach(h => {
      const cell = heatmap[row.date][h];
      cell.headcount += 1;
      if (hasRate) cell.cost = Math.round((cell.cost + rate) * 100) / 100;
    });
  }
  totalStoreSpend = Math.round(totalStoreSpend * 100) / 100;
  totalStoreHours = Math.round(totalStoreHours * 100) / 100;

  // Your own earnings for the week, from your shifts table
  const myShifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?').all(from, to);
  const yourGrossEarnings = Math.round(myShifts.reduce((t, s) => t + (s.calculated_pay || 0), 0) * 100) / 100;
  const yourSharePct = totalStoreSpend > 0 ? Math.round((yourGrossEarnings / totalStoreSpend) * 1000) / 10 : null;
  const avgHourlyWage = totalStoreHours > 0 ? Math.round((totalStoreSpend / totalStoreHours) * 100) / 100 : null;

  const dailySpendArr = weekDates.map((d, i) => ({ date: d, dow: DOW_LABELS[i], spend: dailySpend[d] }));

  const payDistribution = Object.entries(tierSpend)
    .map(([tier, spend]) => ({
      tier, label: TIER_LABELS[tier], spend: Math.round(spend * 100) / 100,
      pct: totalStoreSpend > 0 ? Math.round((spend / totalStoreSpend) * 1000) / 10 : 0,
    }))
    .filter(t => t.spend > 0);

  const heatmapArr = weekDates.map((d, i) => ({
    date: d, dow: DOW_LABELS[i],
    hours: HOURS.map(h => ({ hour: h, ...heatmap[d][h] })),
  }));

  res.json({
    week: { from, to },
    total_store_spend: totalStoreSpend,
    total_store_hours: totalStoreHours,
    your_gross_earnings: yourGrossEarnings,
    your_share_pct: yourSharePct,
    avg_hourly_wage: avgHourlyWage,
    daily_spend: dailySpendArr,
    pay_distribution: payDistribution,
    heatmap: heatmapArr,
    warnings: missingPayProfile.size
      ? [`${missingPayProfile.size} colleague(s) missing a pay profile — their shifts count towards heatmap headcount but not towards spend/cost totals: ${[...missingPayProfile].join(', ')}`]
      : [],
  });
});

module.exports = router;
