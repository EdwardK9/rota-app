'use strict';
/* ─── Past Rota — routes ─────────────────────────────────────────────────────
     GET /api/rota-history/week?start=YYYY-MM-DD[&scope=all|me|team]
         every version of every shift in that Mon–Sun week, with when each one was
         added / changed / removed and where the change came from
     GET /api/rota-history/log?days=30[&scope=…][&minor=1][&limit=300]
         a readable list of what changed and when

   The data comes from rota_history (db.js), written by triggers. All the
   interpretation lives in rotaHistoryCore.js; this file only queries.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db } = require('./db');
const core = require('./rotaHistoryCore');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const marks = a => a.map(() => '?').join(',');

function tablesFor(scope) {
  return scope === 'me' ? ['shifts'] : scope === 'team' ? ['colleague_shifts'] : ['shifts', 'colleague_shifts'];
}
const cleanScope = s => (s === 'me' || s === 'team' ? s : 'all');

function colleagueInfo() {
  const names = {}, order = {};
  for (const c of db.prepare('SELECT id, name, sort_order FROM colleagues').all()) {
    names[c.id] = c.name;
    order[c.id] = c.sort_order == null ? 1e6 : c.sort_order;
  }
  return { names, order };
}

function batchInfo(events) {
  const ids = new Set();
  for (const e of events) {
    const m = /:(\d+)$/.exec(e.source || '');
    if (m) ids.add(+m[1]);
    try { const b = JSON.parse(e.new_json || 'null'); if (b && b.import_batch_id) ids.add(+b.import_batch_id); } catch (_) { /* ignore */ }
  }
  const out = {};
  for (const part of chunk([...ids], 400)) {
    for (const b of db.prepare(`SELECT id, note, source, created_at FROM import_batches WHERE id IN (${marks(part)})`).all(...part)) {
      out[b.id] = { note: b.note, source: b.source, created_at: b.created_at };
    }
  }
  return out;
}

/**
 * Your own shifts' changes were also written to the audit log, which keeps the
 * reason ("Removed — no longer in Rotageek"). Pull that onto the matching event,
 * so a deletion says why as well as when.
 */
function attachAuditNotes(events) {
  const wanted = [...new Set(events.filter(e => e.tbl === 'shifts' && !e.note).map(e => e.row_id))];
  if (!wanted.length) return;
  const byShift = new Map();
  for (const part of chunk(wanted, 400)) {
    const rows = db.prepare(
      `SELECT shift_id, action, note, created_at FROM shift_audit_log WHERE shift_id IN (${marks(part)}) AND note IS NOT NULL`
    ).all(...part);
    for (const r of rows) {
      if (!byShift.has(r.shift_id)) byShift.set(r.shift_id, []);
      byShift.get(r.shift_id).push(r);
    }
  }
  const ACTIONS = {
    insert: ['created', 'sync_created'],
    delete: ['deleted'],
    update: ['updated', 'sync_changed', 'sync_break_updated', 'break_corrected', 'break_audit_corrected'],
  };
  for (const e of events) {
    if (e.tbl !== 'shifts' || e.note) continue;
    const cands = byShift.get(e.row_id);
    if (!cands) continue;
    const t = Date.parse(core.utcIso(e.at));
    let best = null, bestGap = 180000;                       // same action: within 3 minutes
    for (const c of cands) {
      if (!(ACTIONS[e.op] || []).includes(c.action)) continue;
      const gap = Math.abs(Date.parse(core.utcIso(c.created_at)) - t);
      if (gap <= bestGap) { best = c; bestGap = gap; }
    }
    if (best) e.note = best.note;
  }
}

/** Every row of `tbl` that was ever in [from, to], with its whole event history. */
function loadRows(tbl, from, to) {
  const ids = new Set();
  for (const r of db.prepare(
    'SELECT DISTINCT row_id FROM rota_history WHERE tbl = ? AND ((date BETWEEN ? AND ?) OR (old_date BETWEEN ? AND ?))'
  ).all(tbl, from, to, from, to)) ids.add(r.row_id);
  for (const r of db.prepare(`SELECT id FROM ${tbl} WHERE date BETWEEN ? AND ?`).all(from, to)) ids.add(r.id);

  const events = new Map(), current = new Map();
  for (const part of chunk([...ids], 400)) {
    for (const e of db.prepare(
      `SELECT * FROM rota_history WHERE tbl = ? AND row_id IN (${marks(part)}) ORDER BY at, id`
    ).all(tbl, ...part)) {
      if (!events.has(e.row_id)) events.set(e.row_id, []);
      events.get(e.row_id).push(e);
    }
    for (const r of db.prepare(`SELECT * FROM ${tbl} WHERE id IN (${marks(part)})`).all(...part)) current.set(r.id, r);
  }
  return [...ids].map(id => ({ tbl, row_id: id, events: events.get(id) || [], current: current.get(id) || null }));
}

router.get('/rota-history/week', (req, res) => {
  try {
    const startParam = String(req.query.start || '');
    if (!DATE_RE.test(startParam)) return res.status(400).json({ error: 'start (YYYY-MM-DD) required' });
    const start = core.mondayOf(startParam);
    const end = core.addDays(start, 6);
    const scope = cleanScope(req.query.scope);

    const rows = [];
    for (const tbl of tablesFor(scope)) rows.push(...loadRows(tbl, start, end));
    const allEvents = rows.flatMap(r => r.events);
    attachAuditNotes(allEvents);

    const { names, order } = colleagueInfo();
    const versions = core.buildVersions(rows, { names, batches: batchInfo(allEvents) })
      .filter(v => v.date >= start && v.date <= end);

    const seen = new Map();
    for (const v of versions) if (!seen.has(v.person)) seen.set(v.person, v.name);
    const people = [...seen.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => {
        if (a.key === 'me') return -1;
        if (b.key === 'me') return 1;
        const oa = order[+a.key.slice(1)] ?? 1e6, ob = order[+b.key.slice(1)] ?? 1e6;
        return oa - ob || a.name.localeCompare(b.name);
      });

    const ctx = db.prepare('SELECT started_at FROM rota_history_ctx WHERE id = 1').get();
    const firstAudit = db.prepare('SELECT MIN(created_at) AS t FROM shift_audit_log WHERE shift_id IS NOT NULL').get();
    res.json({
      start, end, scope, people, versions,
      started: { team: core.utcIso(ctx && ctx.started_at), own: core.utcIso(firstAudit && firstAudit.t) },
      now: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[RotaHistory] week:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/rota-history/log', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 3650);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '300', 10) || 300, 1), 1000);
    const scope = cleanScope(req.query.scope);
    const tbls = tablesFor(scope);

    const events = db.prepare(
      `SELECT * FROM rota_history WHERE at >= datetime('now', ?) AND tbl IN (${marks(tbls)}) ORDER BY at, id`
    ).all(`-${days} days`, ...tbls);
    attachAuditNotes(events);

    const { names } = colleagueInfo();
    const items = core.buildLog(events, { names, batches: batchInfo(events) }, { minor: req.query.minor === '1' });
    const total = items.length;
    res.json({
      total,
      items: items.slice(0, limit).map(i => ({ ...i, week: i.date ? core.mondayOf(i.date) : null })),
    });
  } catch (e) {
    console.error('[RotaHistory] log:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
