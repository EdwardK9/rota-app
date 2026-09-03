/* ─── 🧭 Screen Time (V5.0) ────────────────────────────────────────────────
   GET /api/v5/screens[?days=90|all]

   Which parts of the app you actually use. Every view visit is one v5_events
   row carrying how long you stayed, so this can answer both "what do I open
   most" and "what do I linger on", which are rarely the same view: the
   dashboard gets opened constantly for two seconds, while Reports gets opened
   once a month and held for ten minutes.

   It also reconstructs the paths through the app — which view you land on, what
   you go to next, and where you stop — from the from_view on each visit.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, windowFromQuery, localDateStr, round1, pct, median, humanMs,
} = require('./helpers');

const router = express.Router();

/* Presentation only — the tracker records raw view ids, and anything not named
   here still shows up under its own id rather than being dropped. */
const VIEW_META = {
  dashboard: ['🏠', 'Dashboard'], shifts: ['📋', 'Shifts'], calendar: ['📅', 'Calendar'],
  settings: ['⚙️', 'Settings'], people: ['👥', 'People'], 'whos-in': ['🏪', "Who's In"],
  clock: ['🕐', 'Clock In/Out'], leave: ['🏖️', 'Leave'], weather: ['🌦️', 'Weather'],
  payslips: ['💰', 'Payslips'], reports: ['📊', 'Reports'], insights: ['🔍', 'Insights'],
  leaderboard: ['🏆', 'Leaderboard'], 'team-calendar': ['🗓️', 'Team Calendar'],
  'team-upload': ['📸', 'Team Upload'], 'manage-people': ['👤', 'Manage People'],
  'photo-library': ['📷', 'Photo Library'], import: ['📥', 'Import'], export: ['📤', 'Export'],
  notes: ['📝', 'Notes'], audit: ['📋', 'Audit Log'], notifications: ['🔔', 'Notifications'],
  key: ['🔑', 'Key'], changelog: ['📜', "What's New"], 'v2-hub': ['🚀', 'V2.0 Features'],
  'v3-hub': ['✨', 'V3.0 Features'], 'v5-hub': ['📈', 'V5.0 Analytics'],
  'v5-usage': ['📈', 'App Usage'], 'v5-screens': ['🧭', 'Screen Time'],
  'v5-locations': ['📍', 'Clock Map'], 'v5-habits': ['🔁', 'Check Habits'],
  'v5-privacy': ['🔒', 'Data & Privacy'],
};

function label(view) {
  const meta = VIEW_META[view];
  return meta
    ? { view, icon: meta[0], name: meta[1] }
    : { view, icon: '📄', name: String(view || 'unknown').replace(/-/g, ' ') };
}

/* Views that mean "I am checking my rota" rather than browsing the app. Shared
   with habits.js, which asks the same question of the same rows. */
const ROTA_VIEWS = ['dashboard', 'shifts', 'calendar', 'clock', 'team-calendar', 'whos-in'];

router.get('/screens', (req, res) => {
  const { days, since } = windowFromQuery(req.query, 90);

  const visits = db.prepare(
    "SELECT view, from_view, duration_ms, local_date, hour, session_id, ts FROM v5_events " +
    "WHERE type = 'view' AND view IS NOT NULL AND local_date >= ? ORDER BY ts ASC"
  ).all(since);

  const totalMs = visits.reduce((t, v) => t + (v.duration_ms || 0), 0);

  /* ── Per view ───────────────────────────────────────────────────────── */
  const byView = {};
  for (const v of visits) {
    const e = (byView[v.view] ||= { visits: 0, ms: 0, durations: [], days: new Set(), last: null });
    e.visits++;
    e.ms += v.duration_ms || 0;
    if (v.duration_ms) e.durations.push(v.duration_ms);
    e.days.add(v.local_date);
    if (!e.last || v.ts > e.last) e.last = v.ts;
  }

  const views = Object.entries(byView).map(([view, e]) => ({
    ...label(view),
    visits: e.visits,
    ms: e.ms,
    label_ms: humanMs(e.ms),
    share_pct: pct(e.ms, totalMs),
    visit_share_pct: pct(e.visits, visits.length),
    avg_ms: e.visits ? Math.round(e.ms / e.visits) : 0,
    avg_label: humanMs(e.visits ? e.ms / e.visits : 0),
    median_ms: Math.round(median(e.durations)),
    median_label: humanMs(median(e.durations)),
    days_seen: e.days.size,
    last_opened: e.last,
  })).sort((a, b) => b.ms - a.ms || b.visits - a.visits);

  /* ── Journeys ───────────────────────────────────────────────────────── */
  const transitions = {};
  const entryCount = {}, exitCount = {};
  const bySession = {};
  for (const v of visits) {
    if (v.from_view && v.from_view !== v.view) {
      const key = `${v.from_view}→${v.view}`;
      transitions[key] = (transitions[key] || 0) + 1;
    }
    (bySession[v.session_id || 'none'] ||= []).push(v);
  }
  for (const list of Object.values(bySession)) {
    entryCount[list[0].view] = (entryCount[list[0].view] || 0) + 1;
    const last = list[list.length - 1].view;
    exitCount[last] = (exitCount[last] || 0) + 1;
  }
  const sessionCount = Object.keys(bySession).length;

  /* ── Rota-checking as a share of everything ─────────────────────────── */
  const rotaMs = visits.filter(v => ROTA_VIEWS.includes(v.view))
                       .reduce((t, v) => t + (v.duration_ms || 0), 0);

  /* ── Unused corners ─────────────────────────────────────────────────── */
  const known = Object.keys(VIEW_META);
  const never = known.filter(v => !byView[v] && !v.startsWith('v5-')).map(label);

  /* ── When each of the top views gets used ───────────────────────────── */
  const topViews = views.slice(0, 6).map(v => v.view);
  const hourlyByView = {};
  for (const v of topViews) hourlyByView[v] = Array(24).fill(0);
  for (const v of visits) {
    if (hourlyByView[v.view]) hourlyByView[v.view][v.hour] += v.duration_ms || 0;
  }

  res.json({
    window: { days, since, today: localDateStr() },
    totals: {
      visits: visits.length,
      distinct_views: views.length,
      total_ms: totalMs,
      total_label: humanMs(totalMs),
      avg_visit_ms: visits.length ? Math.round(totalMs / visits.length) : 0,
      avg_visit_label: humanMs(visits.length ? totalMs / visits.length : 0),
      views_per_session: sessionCount ? round1(visits.length / sessionCount) : 0,
      rota_check_ms: rotaMs,
      rota_check_label: humanMs(rotaMs),
      rota_check_pct: pct(rotaMs, totalMs),
    },
    views,
    entry_views: Object.entries(entryCount)
      .map(([view, count]) => ({ ...label(view), count, pct: pct(count, sessionCount) }))
      .sort((a, b) => b.count - a.count).slice(0, 10),
    exit_views: Object.entries(exitCount)
      .map(([view, count]) => ({ ...label(view), count, pct: pct(count, sessionCount) }))
      .sort((a, b) => b.count - a.count).slice(0, 10),
    transitions: Object.entries(transitions)
      .map(([key, count]) => {
        const [from, to] = key.split('→');
        return { from: label(from), to: label(to), count, pct: pct(count, visits.length) };
      })
      .sort((a, b) => b.count - a.count).slice(0, 15),
    hourly_by_view: topViews.map(v => ({ ...label(v), hours: hourlyByView[v] })),
    never_opened: never,
  });
});

module.exports = router;
module.exports.ROTA_VIEWS = ROTA_VIEWS;
module.exports.label = label;
