/* ─── Commute & Weather Overlay (V2.0 Phase 2.1) ────────────────────────────
   Endpoints:
     POST /api/commute/geocode  — resolve a UK postcode to lat/lon (postcodes.io)
     GET  /api/commute/weather  — commute-to / commute-home forecast + alerts

   Design: "Commute to" uses HOME coordinates at (shift start - 40 min) — that's
   the moment you're leaving home, so it's when a frost/rain warning is actually
   actionable (de-ice the car, grab a coat). "Commute home" uses WORK coordinates
   at (shift end + 10 min) — the moment you're leaving work. Falls back to the
   home location for both if a work postcode hasn't been set.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db }  = require('./db');
const router  = express.Router();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// WMO weather code -> short label + icon (subset covering UK-relevant conditions)
const WEATHER_CODES = {
  0: { label: 'Clear sky', icon: '☀️' },
  1: { label: 'Mainly clear', icon: '🌤️' },
  2: { label: 'Partly cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁️' },
  45: { label: 'Fog', icon: '🌫️' }, 48: { label: 'Fog', icon: '🌫️' },
  51: { label: 'Light drizzle', icon: '🌦️' }, 53: { label: 'Drizzle', icon: '🌦️' }, 55: { label: 'Heavy drizzle', icon: '🌧️' },
  61: { label: 'Light rain', icon: '🌦️' }, 63: { label: 'Rain', icon: '🌧️' }, 65: { label: 'Heavy rain', icon: '🌧️' },
  66: { label: 'Freezing rain', icon: '🌨️' }, 67: { label: 'Freezing rain', icon: '🌨️' },
  71: { label: 'Light snow', icon: '🌨️' }, 73: { label: 'Snow', icon: '❄️' }, 75: { label: 'Heavy snow', icon: '❄️' }, 77: { label: 'Snow grains', icon: '❄️' },
  80: { label: 'Rain showers', icon: '🌦️' }, 81: { label: 'Rain showers', icon: '🌧️' }, 82: { label: 'Violent showers', icon: '🌧️' },
  85: { label: 'Snow showers', icon: '🌨️' }, 86: { label: 'Snow showers', icon: '🌨️' },
  95: { label: 'Thunderstorm', icon: '⛈️' }, 96: { label: 'Thunderstorm + hail', icon: '⛈️' }, 99: { label: 'Thunderstorm + hail', icon: '⛈️' },
};
function weatherLabel(code) { return WEATHER_CODES[code] || { label: '', icon: '🌡️' }; }

/** Round a Date to the nearest hour, in local time, formatted to match
 *  Open-Meteo's hourly time keys ("YYYY-MM-DDTHH:00"). */
function nearestHourKey(d) {
  const rounded = new Date(d);
  rounded.setMinutes(rounded.getMinutes() + 30);
  rounded.setMinutes(0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${rounded.getFullYear()}-${pad(rounded.getMonth() + 1)}-${pad(rounded.getDate())}T${pad(rounded.getHours())}:00`;
}

// Forecasts don't change minute to minute, but the dashboard re-requests the same
// home/work/date combo on every load — cache each response for a while so repeat
// loads don't pay for a live round trip to Open-Meteo.
const FORECAST_CACHE_TTL_MS = 20 * 60 * 1000;
const _forecastCache = new Map(); // "lat,lon,date" -> { expires, map }

/** Fetch hourly forecast (temp, precip probability, weather code) for a lat/lon
 *  on the given date. Returns a map of "YYYY-MM-DDTHH:00" -> {temp, precipProb, code}. */
async function fetchHourlyForecast(lat, lon, dateStr) {
  const cacheKey = `${lat},${lon},${dateStr}`;
  const cached = _forecastCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.map;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&hourly=temperature_2m,precipitation_probability,weather_code&timezone=Europe%2FLondon&start_date=${dateStr}&end_date=${dateStr}`;
  // No timeout here used to mean a slow/flaky Open-Meteo response could hang
  // the Dashboard's hero card indefinitely — this call sits directly on that
  // render path. 6s is generous for a same-region API call; failing fast lets
  // the dashboard render without weather rather than stall waiting for it.
  const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error(`Open-Meteo returned ${resp.status}`);
  const data = await resp.json();
  const map = {};
  const times = data.hourly?.time || [];
  times.forEach((t, i) => {
    map[t] = {
      temp: data.hourly.temperature_2m[i],
      precipProb: data.hourly.precipitation_probability[i],
      code: data.hourly.weather_code[i],
    };
  });
  _forecastCache.set(cacheKey, { expires: Date.now() + FORECAST_CACHE_TTL_MS, map });
  return map;
}

/** Turn a forecast point into the badge alerts described in the V2.0 spec:
 *  frost below 2°C, rain warning above 60% chance of precipitation. */
function buildAlerts(point) {
  const alerts = [];
  if (point.temp != null && point.temp < 2) {
    alerts.push({ icon: '🧊', text: 'Frost Alert (De-ice)' });
  }
  if (point.precipProb != null && point.precipProb > 60) {
    alerts.push({ icon: '☔', text: point.precipProb > 80 ? 'Heavy rain likely (take a coat)' : 'Rain expected (take a coat)' });
  }
  return alerts;
}

router.post('/commute/geocode', async (req, res) => {
  const { postcode } = req.body;
  if (!postcode || !postcode.trim()) return res.status(400).json({ error: 'postcode required' });
  try {
    const resp = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.trim())}`);
    const data = await resp.json();
    if (data.status !== 200 || !data.result) return res.status(400).json({ error: 'Postcode not found' });
    res.json({ lat: data.result.latitude, lon: data.result.longitude });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach postcode lookup service' });
  }
});

// Open-Meteo's practical forecast horizon — beyond this, don't bother calling out.
const MAX_FORECAST_DAYS = 15;

router.get('/commute/weather', async (req, res) => {
  const { date, start, end } = req.query;
  if (!date || !start || !end) return res.status(400).json({ error: 'date, start, end required' });

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const daysAhead = Math.floor((new Date(date + 'T00:00:00') - todayMidnight) / 86400000);
  if (daysAhead < 0 || daysAhead > MAX_FORECAST_DAYS) {
    return res.json({ available: false, reason: 'outside forecast range' });
  }

  const homeLat = getSetting('commute_home_lat'), homeLon = getSetting('commute_home_lon');
  const workLatRaw = getSetting('commute_work_lat'), workLonRaw = getSetting('commute_work_lon');
  if (!homeLat || !homeLon) return res.json({ available: false, reason: 'no location set' });
  const workLat = workLatRaw || homeLat, workLon = workLonRaw || homeLon;

  try {
    // Leaving home -> heading to work
    const toTime = new Date(`${date}T${start}:00`); toTime.setMinutes(toTime.getMinutes() - 40);
    // Leaving work -> heading home
    const homeTime = new Date(`${date}T${end}:00`); homeTime.setMinutes(homeTime.getMinutes() + 10);

    const [homeForecast, workForecast] = await Promise.all([
      fetchHourlyForecast(homeLat, homeLon, date),
      fetchHourlyForecast(workLat, workLon, date),
    ]);

    const toPoint   = homeForecast[nearestHourKey(toTime)];
    const homePoint = workForecast[nearestHourKey(homeTime)];

    const build = (point, time) => {
      if (!point) return null;
      const w = weatherLabel(point.code);
      return {
        time: `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`,
        temp: point.temp,
        precip_probability: point.precipProb,
        description: w.label,
        icon: w.icon,
        alerts: buildAlerts(point),
      };
    };

    res.json({
      available: true,
      commute_to: build(toPoint, toTime),
      commute_home: build(homePoint, homeTime),
    });
  } catch (e) {
    res.status(502).json({ available: false, error: e.message });
  }
});

// ─────────────────────────────────────────
// Detailed multi-day forecast (Weather tab) — daily min/max, sunrise/sunset,
// wind, alongside your logged shifts for each day.
// ─────────────────────────────────────────

const DAILY_CACHE_TTL_MS = 30 * 60 * 1000;
const _dailyCache = new Map(); // "lat,lon,days" -> { expires, data }

async function fetchDailyForecast(lat, lon, days) {
  const cacheKey = `${lat},${lon},${days}`;
  const cached = _dailyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset` +
    `&timezone=Europe%2FLondon&forecast_days=${days}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo returned ${resp.status}`);
  const data = await resp.json();
  const d = data.daily || {};
  const out = (d.time || []).map((date, i) => {
    const w = weatherLabel(d.weather_code[i]);
    return {
      date,
      tempMax: d.temperature_2m_max[i],
      tempMin: d.temperature_2m_min[i],
      precipProbMax: d.precipitation_probability_max[i],
      windMax: d.wind_speed_10m_max[i],
      sunrise: (d.sunrise[i] || '').slice(11, 16),
      sunset: (d.sunset[i] || '').slice(11, 16),
      code: d.weather_code[i],
      label: w.label,
      icon: w.icon,
      alerts: buildAlerts({ temp: d.temperature_2m_min[i], precipProb: d.precipitation_probability_max[i] }),
    };
  });
  _dailyCache.set(cacheKey, { expires: Date.now() + DAILY_CACHE_TTL_MS, data: out });
  return out;
}

router.get('/commute/forecast', async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || MAX_FORECAST_DAYS, MAX_FORECAST_DAYS);
  const homeLat = getSetting('commute_home_lat'), homeLon = getSetting('commute_home_lon');
  if (!homeLat || !homeLon) return res.json({ available: false, reason: 'no location set' });
  const workLatRaw = getSetting('commute_work_lat'), workLonRaw = getSetting('commute_work_lon');
  const hasWork = !!(workLatRaw && workLonRaw);
  const workLat = workLatRaw || homeLat, workLon = workLonRaw || homeLon;

  try {
    const [homeDaily, workDaily] = await Promise.all([
      fetchDailyForecast(homeLat, homeLon, days),
      hasWork ? fetchDailyForecast(workLat, workLon, days) : Promise.resolve(null),
    ]);

    // Annotate each day with any shift(s) you're logged to work, so the Weather
    // tab can show "you're in at 06:45" alongside the forecast.
    const from = homeDaily[0]?.date, to = homeDaily[homeDaily.length - 1]?.date;
    const shifts = from && to
      ? db.prepare('SELECT date, start_time, end_time FROM shifts WHERE date >= ? AND date <= ? ORDER BY date, start_time').all(from, to)
      : [];
    const shiftsByDate = {};
    shifts.forEach(s => { (shiftsByDate[s.date] ||= []).push({ start_time: s.start_time, end_time: s.end_time }); });

    const daily = homeDaily.map(d => ({ ...d, shifts: shiftsByDate[d.date] || [] }));

    res.json({ available: true, hasWork, daily, workDaily: hasWork ? workDaily : null });
  } catch (e) {
    res.status(502).json({ available: false, error: e.message });
  }
});

// Exported alongside the router so other modules (e.g. webhooks.js, for the
// commute-prep payload's weather field) can reuse the same forecast logic
// without duplicating it.
module.exports = router;
module.exports.router = router;
module.exports.fetchHourlyForecast = fetchHourlyForecast;
module.exports.nearestHourKey = nearestHourKey;
module.exports.weatherLabel = weatherLabel;
module.exports.buildAlerts = buildAlerts;
module.exports.getSetting = getSetting;
