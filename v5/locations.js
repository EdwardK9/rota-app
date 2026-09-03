/* ─── 📍 Clock Map (V5.0) ──────────────────────────────────────────────────
   GET    /api/v5/locations[?days=90|all&kind=]
   GET    /api/v5/locations/places
   POST   /api/v5/locations/places          { name, icon, lat, lon, radius_m }
   DELETE /api/v5/locations/places/:id

   Where you were when you clocked in and out. Every fix is labelled at *read*
   time against the saved places (plus Home/Work from the commute postcodes
   already in settings), so renaming a place or widening its radius relabels the
   whole history rather than only what's recorded afterwards.

   The honest framing of what this can tell you: a clock-in 40 metres from the
   store is you at work; one three miles away is you clocking in from the sofa.
   That distinction is the whole point, so distance-from-work is computed for
   every point rather than only the ones that fall outside a place.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS_SHORT, windowFromQuery, localDateStr, getSetting, parseDate,
  haversineMetres, metresToMiles, allPlaces, labelPoint,
  round1, round2, pct, median, privacyFlags,
} = require('./helpers');

const router = express.Router();

/** The store's coordinates, if the commute settings have been filled in — the
 *  reference point every clock fix is measured against. */
function workPoint() {
  const lat = parseFloat(getSetting('commute_work_lat', ''));
  const lon = parseFloat(getSetting('commute_work_lon', ''));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

router.get('/locations', (req, res) => {
  const { days, since } = windowFromQuery(req.query, 90);
  const kind = req.query.kind && req.query.kind !== 'all' ? String(req.query.kind) : null;
  const flags = privacyFlags();

  const rows = kind
    ? db.prepare('SELECT * FROM v5_locations WHERE local_date >= ? AND kind = ? ORDER BY ts DESC').all(since, kind)
    : db.prepare('SELECT * FROM v5_locations WHERE local_date >= ? ORDER BY ts DESC').all(since);

  const places = allPlaces();
  const work = workPoint();

  // Clock entries for the same window, so a fix can be shown next to the time
  // it was actually recorded against.
  const clockByDate = {};
  for (const c of db.prepare('SELECT date, clocked_in, clocked_out FROM clock_entries WHERE date >= ?').all(since)) {
    clockByDate[c.date] = c;
  }

  const points = rows.map(r => {
    const place = labelPoint(r.lat, r.lon, places);
    const distM = work ? haversineMetres(r.lat, r.lon, work.lat, work.lon) : null;
    const clock = clockByDate[r.local_date];
    return {
      id: r.id,
      date: r.local_date,
      time: r.local_time,
      dow: DAYS_SHORT[parseDate(r.local_date).getDay()],
      kind: r.kind,
      lat: r.lat,
      lon: r.lon,
      accuracy_m: r.accuracy_m != null ? Math.round(r.accuracy_m) : null,
      source: r.source,
      place: place ? place.name : null,
      place_icon: place ? place.icon : null,
      place_distance_m: place ? place.distance_m : null,
      distance_from_work_m: distM != null ? Math.round(distM) : null,
      distance_from_work_miles: distM != null ? round2(metresToMiles(distM)) : null,
      // "At work" is judged against the accuracy of the fix as well as the
      // distance — a 500 m-accurate network fix 300 m away is not evidence of
      // anything, and shouldn't be flagged as clocking in from elsewhere.
      at_work: distM != null ? distM <= Math.max(250, (r.accuracy_m || 0)) : null,
      clocked_in: clock?.clocked_in || null,
      clocked_out: clock?.clocked_out || null,
      maps_url: `https://www.google.com/maps?q=${r.lat},${r.lon}`,
    };
  });

  /* ── Summary by kind ────────────────────────────────────────────────── */
  const byKind = {};
  for (const p of points) {
    const e = (byKind[p.kind] ||= { kind: p.kind, count: 0, at_work: 0, distances: [] });
    e.count++;
    if (p.at_work) e.at_work++;
    if (p.distance_from_work_m != null) e.distances.push(p.distance_from_work_m);
  }

  /* ── Where you clock in from ────────────────────────────────────────── */
  const byPlace = {};
  for (const p of points) {
    const key = p.place || 'Elsewhere';
    const e = (byPlace[key] ||= { name: key, icon: p.place_icon || '❓', count: 0, kinds: {} });
    e.count++;
    e.kinds[p.kind] = (e.kinds[p.kind] || 0) + 1;
  }

  const clockPoints = points.filter(p => p.kind === 'clock_in' || p.kind === 'clock_out');
  const away = clockPoints.filter(p => p.at_work === false);
  const accuracies = points.map(p => p.accuracy_m).filter(a => a != null);

  res.json({
    window: { days, since, today: localDateStr() },
    enabled: flags.location,
    location_on_open: flags.locationOnOpen,
    work_configured: !!work,
    work,
    totals: {
      points: points.length,
      clock_points: clockPoints.length,
      at_work: clockPoints.filter(p => p.at_work).length,
      at_work_pct: pct(clockPoints.filter(p => p.at_work).length, clockPoints.filter(p => p.at_work !== null).length),
      away_from_work: away.length,
      median_accuracy_m: accuracies.length ? Math.round(median(accuracies)) : null,
      dates_covered: new Set(points.map(p => p.date)).size,
    },
    by_kind: Object.values(byKind).map(e => ({
      kind: e.kind, count: e.count, at_work: e.at_work,
      at_work_pct: pct(e.at_work, e.count),
      median_distance_m: e.distances.length ? Math.round(median(e.distances)) : null,
    })),
    by_place: Object.values(byPlace).sort((a, b) => b.count - a.count),
    away_points: away.slice(0, 20),
    points: points.slice(0, 300),
    places: places.map(p => ({
      id: p.id, name: p.name, icon: p.icon || '📍', lat: p.lat, lon: p.lon,
      radius_m: p.radius_m, source: p.source,
      // How many recorded fixes this place actually accounts for — a place with
      // zero hits usually means the radius is too tight.
      hits: points.filter(x => x.place === p.name).length,
    })),
    // Rough distance travelled between consecutive clock fixes on the same day,
    // which is the closest thing to a commute this data can honestly claim.
    commutes: (() => {
      const out = [];
      const byDate = {};
      for (const p of clockPoints) (byDate[p.date] ||= []).push(p);
      for (const [date, list] of Object.entries(byDate)) {
        const inP = list.find(p => p.kind === 'clock_in');
        const outP = list.find(p => p.kind === 'clock_out');
        if (!inP || !outP) continue;
        const m = haversineMetres(inP.lat, inP.lon, outP.lat, outP.lon);
        out.push({
          date, in_time: inP.time, out_time: outP.time,
          drift_m: Math.round(m), drift_miles: round2(metresToMiles(m)),
          in_place: inP.place, out_place: outP.place,
        });
      }
      return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    })(),
  });
});

/* ── Places ───────────────────────────────────────────────────────────── */

router.get('/locations/places', (req, res) => {
  res.json({ places: allPlaces() });
});

router.post('/locations/places', (req, res) => {
  const { name, icon, lat, lon, radius_m } = req.body || {};
  const la = Number(lat), lo = Number(lon);
  if (!name || !Number.isFinite(la) || !Number.isFinite(lo)) {
    return res.status(400).json({ error: 'name, lat and lon are required' });
  }
  const r = Math.min(20000, Math.max(20, Math.round(Number(radius_m) || 200)));
  const info = db.prepare(
    'INSERT INTO v5_places (name, icon, lat, lon, radius_m) VALUES (?,?,?,?,?)'
  ).run(String(name).slice(0, 60), String(icon || '📍').slice(0, 8), la, lo, r);
  res.json(db.prepare('SELECT * FROM v5_places WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/locations/places/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM v5_places WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, icon, lat, lon, radius_m } = req.body || {};
  db.prepare(`
    UPDATE v5_places SET name = ?, icon = ?, lat = ?, lon = ?, radius_m = ? WHERE id = ?
  `).run(
    name != null ? String(name).slice(0, 60) : existing.name,
    icon != null ? String(icon).slice(0, 8) : existing.icon,
    Number.isFinite(Number(lat)) ? Number(lat) : existing.lat,
    Number.isFinite(Number(lon)) ? Number(lon) : existing.lon,
    Number.isFinite(Number(radius_m)) ? Math.min(20000, Math.max(20, Math.round(Number(radius_m)))) : existing.radius_m,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM v5_places WHERE id = ?').get(req.params.id));
});

router.delete('/locations/places/:id', (req, res) => {
  db.prepare('DELETE FROM v5_places WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
