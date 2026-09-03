/* ─── 📈 App Usage (V5.0) ──────────────────────────────────────────────────
   GET /api/v5/usage[?days=90|all]

   How much you actually use the app: opens, how long each visit lasts, what
   time of day you reach for it, which days you skip, and whether that is
   changing. Everything is derived from v5_sessions/v5_events — nothing here
   writes.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, DAYS_SHORT, windowFromQuery, localDateStr, addDays, daysBetween,
  round1, pct, median, humanMs,
} = require('./helpers');

const router = express.Router();

/** Longest and current runs of consecutive days that appear in `dates`.
 *  "Current" only counts if the run reaches today or yesterday — a streak that
 *  ended a fortnight ago is history, not a streak. */
function streaks(dates) {
  const set = new Set(dates);
  const sorted = [...set].sort();
  if (!sorted.length) return { current: 0, longest: 0, longest_ended: null };

  let longest = 0, run = 0, longestEnd = null, prev = null;
  for (const d of sorted) {
    run = (prev && daysBetween(prev, d) === 1) ? run + 1 : 1;
    if (run > longest) { longest = run; longestEnd = d; }
    prev = d;
  }

  const today = localDateStr();
  let current = 0;
  let cursor = set.has(today) ? today : (set.has(addDays(today, -1)) ? addDays(today, -1) : null);
  while (cursor && set.has(cursor)) { current++; cursor = addDays(cursor, -1); }

  return { current, longest, longest_ended: longestEnd };
}

router.get('/usage', (req, res) => {
  const { days, since } = windowFromQuery(req.query, 90);
  const today = localDateStr();

  const sessions = db.prepare(
    'SELECT * FROM v5_sessions WHERE local_date >= ? ORDER BY started_at ASC'
  ).all(since);

  const opens = db.prepare(
    "SELECT id FROM v5_events WHERE type = 'app_open' AND local_date >= ?"
  ).all(since);

  const viewEvents = db.prepare(
    "SELECT local_date, hour, dow, duration_ms FROM v5_events WHERE type = 'view' AND local_date >= ?"
  ).all(since);

  const totalActive = sessions.reduce((t, s) => t + (s.active_ms || 0), 0);
  const lengths = sessions.map(s => s.active_ms || 0).filter(ms => ms > 0);

  /* ── Time of day / day of week ──────────────────────────────────────── */
  const byHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h, label: `${String(h).padStart(2, '0')}:00`, sessions: 0, ms: 0,
  }));
  const byDow = Array.from({ length: 7 }, (_, i) => ({
    dow: i, day: DAYS[i], short: DAYS_SHORT[i], sessions: 0, ms: 0, days_seen: new Set(),
  }));
  const byDate = {};

  for (const s of sessions) {
    byHour[s.started_hour].sessions++;
    byHour[s.started_hour].ms += s.active_ms || 0;
    byDow[s.dow].sessions++;
    byDow[s.dow].ms += s.active_ms || 0;
    byDow[s.dow].days_seen.add(s.local_date);
    (byDate[s.local_date] ||= { sessions: 0, ms: 0, views: 0 });
    byDate[s.local_date].sessions++;
    byDate[s.local_date].ms += s.active_ms || 0;
    byDate[s.local_date].views += s.view_count || 0;
  }

  // Views land in the hour they actually happened, which is not always the hour
  // the session started — a long evening session shouldn't pile all its minutes
  // into one bucket.
  const viewMsByHour = Array(24).fill(0);
  for (const v of viewEvents) viewMsByHour[v.hour] += v.duration_ms || 0;

  const activeDates = Object.keys(byDate);
  const spanDays = days === 'all'
    ? (activeDates.length ? daysBetween([...activeDates].sort()[0], today) + 1 : 0)
    : days;

  /* ── Daily series, gaps included ────────────────────────────────────── */
  const series = [];
  if (spanDays > 0 && spanDays <= 400) {
    for (let i = spanDays - 1; i >= 0; i--) {
      const d = addDays(today, -i);
      const v = byDate[d] || { sessions: 0, ms: 0, views: 0 };
      series.push({ date: d, sessions: v.sessions, ms: v.ms, minutes: round1(v.ms / 60000), views: v.views });
    }
  }

  /* ── Trend: the most recent third against the one before it ─────────── */
  let trend = null;
  if (series.length >= 21) {
    const third = Math.floor(series.length / 3);
    const avg = arr => arr.reduce((t, d) => t + d.ms, 0) / (arr.length || 1);
    const recent = avg(series.slice(-third));
    const prev = avg(series.slice(-2 * third, -third));
    trend = {
      recent_avg_ms: Math.round(recent),
      previous_avg_ms: Math.round(prev),
      recent_label: humanMs(recent),
      previous_label: humanMs(prev),
      change_pct: prev > 0 ? round1(((recent - prev) / prev) * 100) : null,
      direction: recent > prev * 1.1 ? 'up' : recent < prev * 0.9 ? 'down' : 'steady',
    };
  }

  /* ── Session shape ──────────────────────────────────────────────────── */
  const buckets = [
    { label: 'Under 30s', min: 0,      max: 30000 },
    { label: '30s – 2m',  min: 30000,  max: 120000 },
    { label: '2 – 5m',    min: 120000, max: 300000 },
    { label: '5 – 15m',   min: 300000, max: 900000 },
    { label: 'Over 15m',  min: 900000, max: Infinity },
  ].map(b => ({ label: b.label, count: lengths.filter(ms => ms >= b.min && ms < b.max).length }));

  const platforms = {};
  for (const s of sessions) {
    const key = s.platform || 'unknown';
    platforms[key] = (platforms[key] || 0) + 1;
  }
  const standalone = sessions.filter(s => s.standalone).length;

  /* ── When the day starts and ends, app-wise ─────────────────────────── */
  const firstOpens = {}, lastOpens = {};
  for (const s of sessions) {
    const hhmm = s.started_at.slice(11, 16);
    if (!firstOpens[s.local_date] || hhmm < firstOpens[s.local_date]) firstOpens[s.local_date] = hhmm;
    if (!lastOpens[s.local_date]  || hhmm > lastOpens[s.local_date])  lastOpens[s.local_date]  = hhmm;
  }
  const toMinsOfDay = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const medianTime = obj => {
    const vals = Object.values(obj).map(toMinsOfDay);
    if (!vals.length) return null;
    const m = Math.round(median(vals));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  const busiestDay = Object.entries(byDate).sort((a, b) => b[1].ms - a[1].ms)[0] || null;
  const peakHour = [...byHour].sort((a, b) => b.sessions - a.sessions)[0];

  res.json({
    window: { days, since, today },
    totals: {
      sessions: sessions.length,
      opens: opens.length,
      days_used: activeDates.length,
      days_in_window: spanDays,
      usage_rate_pct: pct(activeDates.length, spanDays),
      total_ms: totalActive,
      total_label: humanMs(totalActive),
      avg_session_ms: sessions.length ? Math.round(totalActive / sessions.length) : 0,
      avg_session_label: humanMs(sessions.length ? totalActive / sessions.length : 0),
      median_session_ms: Math.round(median(lengths)),
      median_session_label: humanMs(median(lengths)),
      longest_session_ms: lengths.length ? Math.max(...lengths) : 0,
      longest_session_label: humanMs(lengths.length ? Math.max(...lengths) : 0),
      sessions_per_active_day: activeDates.length ? round1(sessions.length / activeDates.length) : 0,
      avg_daily_ms: spanDays ? Math.round(totalActive / spanDays) : 0,
      avg_daily_label: humanMs(spanDays ? totalActive / spanDays : 0),
      views: viewEvents.length,
    },
    rhythm: {
      first_open_median: medianTime(firstOpens),
      last_open_median:  medianTime(lastOpens),
      peak_hour: peakHour && peakHour.sessions ? peakHour.label : null,
      busiest_day: busiestDay
        ? { date: busiestDay[0], ms: busiestDay[1].ms, label: humanMs(busiestDay[1].ms), sessions: busiestDay[1].sessions }
        : null,
    },
    streaks: streaks(activeDates),
    trend,
    by_hour: byHour.map((h, i) => ({ ...h, view_ms: viewMsByHour[i], minutes: round1((h.ms || 0) / 60000) })),
    by_dow: byDow.map(d => {
      const seen = d.days_seen.size;
      return {
        dow: d.dow, day: d.day, short: d.short, sessions: d.sessions, ms: d.ms,
        minutes: round1(d.ms / 60000), days_seen: seen,
        avg_ms_per_day: seen ? Math.round(d.ms / seen) : 0,
        avg_label: humanMs(seen ? d.ms / seen : 0),
      };
    }),
    by_date: series,
    session_lengths: buckets,
    devices: {
      platforms: Object.entries(platforms)
        .map(([name, count]) => ({ name, count, pct: pct(count, sessions.length) }))
        .sort((a, b) => b.count - a.count),
      installed_pct: pct(standalone, sessions.length),
      standalone,
    },
    recent_sessions: sessions.slice(-40).reverse().map(s => ({
      session_id: s.session_id,
      date: s.local_date,
      started: s.started_at.slice(11, 16),
      ended: s.last_seen_at.slice(11, 16),
      ms: s.active_ms,
      label: humanMs(s.active_ms),
      views: s.view_count,
      entry_view: s.entry_view,
      exit_view: s.exit_view,
      platform: s.platform,
      standalone: !!s.standalone,
    })),
  });
});

module.exports = router;
