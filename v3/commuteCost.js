/* ─── ⛽ Commute Cost (V3.0) ───────────────────────────────────────────────
   GET  /api/v3/commute-cost[?year=YYYY|all]
   POST /api/v3/commute-cost/settings   { mpg, fuel_price_ppl, parking_per_shift, ... }

   What the drive to work actually costs, and what share of your pay it eats.
   The headline number is "minutes worked per shift purely to cover the journey"
   — the same figure as the percentage, but far easier to feel.

   Also compares against HMRC's 45p/mile approved mileage rate, which is what
   you'd be reimbursed if these were business miles (ordinary commuting isn't
   claimable — the comparison is there for context, not as tax advice).
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, getSetting, getNumSetting, setSetting, localDateStr, paidHours, shiftPay, round1, round2, pct,
} = require('./helpers');

const router = express.Router();

const LITRES_PER_GALLON = 4.54609;   // imperial gallon — UK MPG figures
const HMRC_RATE_PER_MILE = 0.45;     // approved mileage allowance, first 10k miles

/* Editable in the view itself so V3 doesn't need to reach into the Settings
   screen. Defaults are UK-typical for a small petrol car in 2026. Electric
   fields sit alongside the petrol ones rather than replacing them, so
   switching fuel_type back and forth doesn't lose whichever you're not
   currently using. */
const COST_DEFAULTS = {
  mpg: 45,
  fuel_price_ppl: 139.9,             // pence per litre
  miles_per_kwh: 3.5,                // typical small-medium EV efficiency
  elec_price_per_kwh: 27,            // pence per kWh, home charging
  parking_per_shift: 0,
  wear_per_mile: 0.06,               // tyres, servicing, depreciation
};

function costSettings() {
  const cfg = {};
  for (const [key, fallback] of Object.entries(COST_DEFAULTS)) {
    cfg[key] = getNumSetting('v3_commute_' + key, fallback);
  }
  cfg.fuel_type = getSetting('v3_commute_fuel_type', 'petrol') === 'electric' ? 'electric' : 'petrol';
  return cfg;
}

router.post('/commute-cost/settings', (req, res) => {
  const body = req.body || {};
  if (body.fuel_type !== undefined) {
    setSetting('v3_commute_fuel_type', body.fuel_type === 'electric' ? 'electric' : 'petrol');
  }
  for (const key of Object.keys(COST_DEFAULTS)) {
    if (body[key] === undefined) continue;
    const value = parseFloat(body[key]);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: `${key} must be a number of 0 or more` });
    }
    if ((key === 'mpg' || key === 'miles_per_kwh') && value === 0) {
      return res.status(400).json({ error: `${key} must be greater than 0` });
    }
    setSetting('v3_commute_' + key, value);
  }
  res.json(costSettings());
});

/** Cost per mile in £, for whichever fuel type is configured. */
function costPerMileFor(cfg) {
  if (cfg.fuel_type === 'electric') {
    return cfg.miles_per_kwh > 0 ? (cfg.elec_price_per_kwh / 100) / cfg.miles_per_kwh : 0;
  }
  const pricePerLitre = cfg.fuel_price_ppl / 100;
  return cfg.mpg > 0 ? (pricePerLitre * LITRES_PER_GALLON) / cfg.mpg : 0;
}

router.get('/commute-cost', (req, res) => {
  const year = req.query.year && req.query.year !== 'all' ? String(req.query.year) : null;
  const cfg = costSettings();

  const shifts = year
    ? db.prepare('SELECT * FROM shifts WHERE completed = 1 AND date >= ? AND date <= ? ORDER BY date ASC')
        .all(`${year}-01-01`, `${year}-12-31`)
    : db.prepare('SELECT * FROM shifts WHERE completed = 1 ORDER BY date ASC').all();

  // distance_miles is stored as the one-way distance, so every shift is a round trip.
  const totalMiles = round1(shifts.reduce((t, s) => t + (s.distance_miles || 0) * 2, 0));
  const totalHours = round1(shifts.reduce((t, s) => t + paidHours(s), 0));
  const totalPay   = round2(shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0));

  const costPerMile   = costPerMileFor(cfg);
  const fuelCost      = round2(totalMiles * costPerMile);
  const wearCost      = round2(totalMiles * cfg.wear_per_mile);
  const parkingCost   = round2(shifts.length * cfg.parking_per_shift);
  const totalCost     = round2(fuelCost + wearCost + parkingCost);

  const effectiveHourly = totalHours > 0 ? round2(totalPay / totalHours) : 0;
  const netPay = round2(totalPay - totalCost);
  const netHourly = totalHours > 0 ? round2(netPay / totalHours) : 0;

  // The headline: how long you work each shift just to pay for getting there.
  const costPerShift = shifts.length ? totalCost / shifts.length : 0;
  const minutesPerShift = effectiveHourly > 0 ? Math.round((costPerShift / effectiveHourly) * 60) : 0;

  // Monthly series, for the chart
  const byMonth = {};
  for (const s of shifts) {
    const m = s.date.slice(0, 7);
    (byMonth[m] ||= { miles: 0, shifts: 0, pay: 0 });
    byMonth[m].miles += (s.distance_miles || 0) * 2;
    byMonth[m].shifts += 1;
    byMonth[m].pay += shiftPay(s) || 0;
  }
  const monthly = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => {
    const cost = round2(v.miles * costPerMile + v.miles * cfg.wear_per_mile + v.shifts * cfg.parking_per_shift);
    return {
      month,
      miles: round1(v.miles),
      shifts: v.shifts,
      cost,
      pay: round2(v.pay),
      pct_of_pay: pct(cost, v.pay),
    };
  });

  const litres = cfg.fuel_type !== 'electric' && cfg.mpg > 0 ? round1(totalMiles / cfg.mpg * LITRES_PER_GALLON) : 0;
  const kwh    = cfg.fuel_type === 'electric' && cfg.miles_per_kwh > 0 ? round1(totalMiles / cfg.miles_per_kwh) : 0;

  // ── Petrol vs electricity, side by side ──────────────────────────────────
  // Both sets of figures are stored regardless of which fuel_type is selected,
  // so the same mileage can be costed both ways without changing any setting.
  // Wear and parking are identical either way, so they're carried through
  // rather than dropped — the totals then answer the actual question ("what
  // would this same year of commuting have cost me on the other one?") instead
  // of only comparing the energy line.
  const sideBySide = fuelType => {
    const alt = { ...cfg, fuel_type: fuelType };
    const perMile = costPerMileFor(alt);
    const energy  = round2(totalMiles * perMile);
    const total   = round2(energy + wearCost + parkingCost);
    return {
      fuel_type: fuelType,
      // Pence per mile — £/mile rounds to nothing useful at this scale.
      pence_per_mile: Math.round(perMile * 100 * 100) / 100,
      energy_cost: energy,
      total_cost: total,
      per_shift: shifts.length ? round2(total / shifts.length) : 0,
      units: fuelType === 'electric'
        ? { label: 'kWh', amount: alt.miles_per_kwh > 0 ? round1(totalMiles / alt.miles_per_kwh) : 0 }
        : { label: 'litres', amount: alt.mpg > 0 ? round1(totalMiles / alt.mpg * LITRES_PER_GALLON) : 0 },
      minutes_per_shift: effectiveHourly > 0 && shifts.length
        ? Math.round(((total / shifts.length) / effectiveHourly) * 60) : 0,
    };
  };
  const petrol   = sideBySide('petrol');
  const electric = sideBySide('electric');
  const cheaper  = electric.total_cost === petrol.total_cost
    ? null : (electric.total_cost < petrol.total_cost ? 'electric' : 'petrol');

  // The price at which the two swap places, so the comparison survives the next
  // energy-price change without having to re-run it by hand.
  const petrolPerMile = costPerMileFor({ ...cfg, fuel_type: 'petrol' });
  const elecPerMile   = costPerMileFor({ ...cfg, fuel_type: 'electric' });
  const breakEven = {
    // p/kWh at which electricity costs the same per mile as petrol does now
    elec_price_per_kwh: cfg.miles_per_kwh > 0
      ? Math.round(petrolPerMile * cfg.miles_per_kwh * 100 * 100) / 100 : null,
    // p/litre at which petrol costs the same per mile as electricity does now
    fuel_price_ppl: cfg.mpg > 0
      ? Math.round((elecPerMile * cfg.mpg / LITRES_PER_GALLON) * 100 * 100) / 100 : null,
  };

  res.json({
    year: year || 'all',
    settings: cfg,
    shifts: shifts.length,
    total_miles: totalMiles,
    total_hours: totalHours,
    total_pay: totalPay,
    cost: {
      fuel: fuelCost,
      wear: wearCost,
      parking: parkingCost,
      total: totalCost,
      per_mile: round2(costPerMile + cfg.wear_per_mile),
      per_shift: round2(costPerShift),
      litres_burned: litres,
      tank_fills: litres > 0 ? round1(litres / 45) : 0,   // a typical 45-litre tank
      kwh_used: kwh,
    },
    impact: {
      pct_of_pay: pct(totalCost, totalPay),
      minutes_per_shift: minutesPerShift,
      shifts_worked_for_free: costPerShift > 0 && shifts.length
        ? round1(totalCost / (totalPay / shifts.length)) : 0,
      gross_hourly: effectiveHourly,
      net_hourly: netHourly,
      net_pay: netPay,
    },
    hmrc: {
      rate_per_mile: HMRC_RATE_PER_MILE,
      would_reimburse: round2(totalMiles * HMRC_RATE_PER_MILE),
      difference: round2(totalMiles * HMRC_RATE_PER_MILE - totalCost),
      note: 'For comparison only — ordinary commuting to a permanent workplace is not claimable.',
    },
    comparison: {
      petrol,
      electric,
      cheaper,
      saving: round2(Math.abs(petrol.total_cost - electric.total_cost)),
      break_even: breakEven,
    },
    monthly,
    today: localDateStr(),
  });
});

module.exports = router;
// Reused by briefing.js so a single shift's commute cost (fuel or electricity,
// plus wear) matches this page's numbers instead of a separate petrol-only calc.
module.exports.costSettings = costSettings;
module.exports.costPerMileFor = costPerMileFor;
