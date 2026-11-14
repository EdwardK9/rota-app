'use strict';
/* ─── Rota history — pure logic (no database, no Express) ────────────────────
   rota_history (see db.js) is an append-only log of every insert / update /
   delete on `shifts` and `colleague_shifts`. This turns that log back into
   something you can look at:

     buildVersions(...)  one entry per "this shift looked like this, from X until Y"
                         — what the Past Rota page draws, for any date
     buildLog(...)       a readable list of what changed and when

   Kept free of I/O so it can be unit-tested and so rotaHistory.js (the routes)
   stays a thin query layer.
   ───────────────────────────────────────────────────────────────────────── */

// Two events this close together on the same shift are one action: a REPLACE, a
// backup restore, or "delete and re-add" in one go. Not a change worth showing.
const SAME_ACTION_MS = 120 * 1000;

const ME = 'me';

// ── small helpers ──────────────────────────────────────────────────────────
const parseJson = s => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

/** SQLite's datetime('now') is UTC without a zone marker; make it an ISO instant. */
function utcIso(s) {
  if (!s) return null;
  return String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z';
}
const ms = iso => (iso ? Date.parse(iso) : NaN);

const toMins = t => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};

function durationHours(start, end) {
  const s = toMins(start), e = toMins(end);
  if (s == null || e == null) return 0;
  let mins = e - s;
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
}
const round2 = n => Math.round(n * 100) / 100;

/** The company break policy — the same thresholds as autoBreakMinutes in db.js
 *  (4h30+ -> 15m, over 6h -> 30m, over 8h -> 45m; the odd inclusive/exclusive
 *  mix there is deliberate). Duplicated rather than required so this file stays
 *  free of the database and testable; test/rota-history.test.js pins it. */
function policyBreakMinutes(start, end) {
  const s = toMins(start), e = toMins(end);
  if (s == null || e == null) return 0;
  let mins = e - s;
  if (mins < 0) mins += 24 * 60;
  if (mins > 8 * 60) return 45;
  if (mins > 6 * 60) return 30;
  if (mins >= 4 * 60 + 30) return 15;
  return 0;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;            // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── where a change came from ───────────────────────────────────────────────
// rota_history.source is a short code set by db.withHistorySource() ('auto_sync',
// 'team_import:12'), or the audit log's own source for the backfilled past.
const SOURCE_LABELS = {
  auto_sync:        'Rotageek sync',
  manual_sync:      'Rotageek sync (run by hand)',
  midnight_sync:    'Midnight Rotageek sync',
  sync_all:         'Full Rotageek sync',
  apply_diffs:      'Rotageek compare (applied)',
  rotageek_import:  'Rotageek import',
  ics_import:       'Calendar file import',
  csv_import:       'CSV import',
  restore:          'Backup restore',
  'clock-out':      'Clock out',
  manual:           'Edited in the app',
  break_audit:      'Break audit',
  team_import:      'Team screenshot import',
  team_import_undo: 'Team import undone',
  team_bulk:        'Team calendar bulk edit',
};

/**
 * @param {string|null} code     rota_history.source
 * @param {object}      batches  import_batches by id: { [id]: { note, created_at } }
 */
function sourceLabel(code, batches) {
  if (!code) return 'Edited in the app';
  const [name, arg] = String(code).split(':');
  let label = SOURCE_LABELS[name]
    || (name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '));
  const batch = arg && batches ? batches[arg] : null;
  if (batch && batch.note) label += ' — ' + batch.note;
  return label;
}

// ── turning one row's events into versions ─────────────────────────────────

/** The columns the page cares about, from either table's row JSON. */
function normValues(tbl, v) {
  v = v || {};
  const isOwn = tbl === 'shifts';
  const type = isOwn ? 'shift' : (v.shift_type || 'shift');
  const breakMin = v.break_scheduled_minutes == null ? null : Number(v.break_scheduled_minutes);
  // Your paid hours are the shift length less the scheduled break (db.js
  // calcHoursWorked) — worked out here rather than read from hours_paid, because
  // rows rebuilt from the audit log only carry the fields that changed, so a
  // stored hours_paid can belong to a different break than the one being shown.
  let hours;
  if (type !== 'shift') hours = 0;                                  // leave / all-day carry no hours
  else if (isOwn && breakMin == null && v.hours_paid != null && isFinite(Number(v.hours_paid))) hours = Number(v.hours_paid);
  else if (isOwn) {
    // No break recorded at all (a shift deleted before the log kept breaks): assume
    // the usual break policy, which is what the sync would have given it.
    const brk = breakMin == null ? policyBreakMinutes(v.start_time, v.end_time) : breakMin;
    hours = durationHours(v.start_time, v.end_time) - brk / 60;
  } else hours = durationHours(v.start_time, v.end_time);
  return {
    date:         v.date || null,
    start_time:   v.start_time || null,
    end_time:     v.end_time || null,
    shift_type:   type,
    store:        v.store || null,
    absence_type: v.absence_type || null,
    break_min:    breakMin,
    hours:        round2(Math.max(0, hours)),
    colleague_id: isOwn ? null : (v.colleague_id == null ? null : Number(v.colleague_id)),
    name:         v.name || null,
    batch:        v.import_batch_id == null ? null : Number(v.import_batch_id),
    created_at:   v.created_at || null,
  };
}

/** What makes two versions "the same shift" for display (hours and the like don't). */
const identity = v => [v.colleague_id == null ? ME : 'c' + v.colleague_id,
  v.date, v.start_time, v.end_time, v.shift_type, v.store || '', v.absence_type || ''].join('|');

const brief = v => v && ({
  date: v.date, start_time: v.start_time, end_time: v.end_time,
  shift_type: v.shift_type, store: v.store, hours: v.hours, break_min: v.break_min,
  absence_type: v.absence_type,
});

/**
 * Replay one row's events into the versions it went through.
 *
 * Works backwards from the row as it is now: an update's old_json says what it
 * was before, a delete's old_json is what was deleted, an insert means "did not
 * exist". That makes it independent of how complete the early events are — rows
 * backfilled from the audit log only carry the fields that changed, and are
 * filled in from the newer state.
 *
 * @param {string} tbl      'shifts' | 'colleague_shifts'
 * @param {Array}  events   this row's rota_history rows (any order)
 * @param {object|null} current  the live row, or null if it no longer exists
 */
function buildRowVersions(tbl, events, current) {
  const evs = events.map(e => {
    const oldV = parseJson(e.old_json) || null;
    const newV = parseJson(e.new_json) || null;
    if (newV && newV.date == null && e.date) newV.date = e.date;
    if (oldV && e.op === 'delete' && oldV.date == null && e.date) oldV.date = e.date;
    if (oldV && e.op === 'update' && e.old_date) oldV.date = e.old_date;
    return { id: e.id, at: utcIso(e.at), op: e.op, old: oldV, new: newV, source: e.source || null, note: e.note || null };
  }).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));

  const n = evs.length;
  const cur = current ? { ...current, created_at: utcIso(current.created_at) } : null;

  if (!n) {
    if (!cur) return [];
    return [{ tbl, values: normValues(tbl, cur), from: cur.created_at, from_op: 'legacy', from_source: null, from_note: null,
      to: null, to_op: null, to_source: null, to_note: null, prev: null }];
  }

  // S[i] = the row's state after i events (S[0] = before any, S[n] = now)
  const S = new Array(n + 1);
  S[n] = cur ? { ...cur } : null;
  for (let i = n - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.op === 'insert') S[i] = null;
    else if (e.op === 'delete') S[i] = { ...(e.old || {}) };
    else S[i] = { ...(S[i + 1] || {}), ...(e.old || {}) };
  }

  const out = [];
  const closeWith = (v, next) => {
    if (!next) return v;
    v.to = next.at; v.to_op = next.op === 'delete' ? 'delete' : 'update';
    v.to_source = next.source; v.to_note = next.note;
    return v;
  };

  if (S[0]) {                                   // existed before the log began watching it
    out.push(closeWith({
      tbl, values: normValues(tbl, S[0]),
      from: utcIso(S[0].created_at) || (cur && cur.created_at) || null, from_op: 'legacy', from_source: null, from_note: null,
      to: null, to_op: null, to_source: null, to_note: null, prev: null,
    }, evs[0]));
  }
  for (let i = 0; i < n; i++) {
    const e = evs[i];
    if (e.op === 'delete') continue;
    // Overlay the event's own new values: for live events that is the whole row,
    // for backfilled ones it fills in what the newer state may have overwritten.
    const after = { ...(S[i + 1] || {}), ...(e.new || {}) };
    out.push(closeWith({
      tbl, values: normValues(tbl, after),
      from: e.at, from_op: e.op, from_source: e.source, from_note: e.note,
      to: null, to_op: null, to_source: null, to_note: null,
      prev: e.op === 'update' && S[i] ? brief(normValues(tbl, S[i])) : null,
    }, evs[i + 1]));
  }
  return out;
}

/**
 * Link each version to what it turned into, then fold together the versions that
 * only differ by something not worth showing.
 */
function finishVersions(all) {
  // what a version became, when it was ended by an edit
  for (let i = 0; i < all.length; i++) {
    const v = all[i];
    if (v.to_op === 'update') {
      const nx = all.find(o => o !== v && o.rowKey === v.rowKey && o.from === v.to && o.from_op === 'update');
      v.next = nx ? brief(nx.values) : null;
    } else v.next = null;
  }

  // Fold: same shift, same hours, touching in time (within one action) -> one version.
  const byId = new Map();
  for (const v of all) {
    const k = identity(v.values) + '|' + v.values.hours;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(v);
  }
  const result = [];
  for (const group of byId.values()) {
    group.sort((a, b) => ms(a.from) - ms(b.from));
    let cur = null;
    for (const v of group) {
      if (cur && cur.to && ms(v.from) - ms(cur.to) <= SAME_ACTION_MS && ms(v.from) - ms(cur.to) >= -SAME_ACTION_MS) {
        // v carries on from cur: keep cur's start, take v's end
        cur.to = v.to; cur.to_op = v.to_op; cur.to_source = v.to_source; cur.to_note = v.to_note; cur.next = v.next;
      } else {
        if (cur) result.push(cur);
        cur = v;
      }
    }
    if (cur) result.push(cur);
  }
  return result;
}

/**
 * Everything the page needs for a set of rows.
 *
 * @param {Array}  rows     [{ tbl, row_id, events: [...], current: row|null }]
 * @param {object} ctx      { names: {colleague_id: name}, batches: {id: {note}} }
 * @returns {Array} versions, ready to send to the browser
 */
function buildVersions(rows, ctx) {
  ctx = ctx || {};
  const names = ctx.names || {};
  const batches = ctx.batches || {};
  const all = [];
  for (const r of rows) {
    const vs = buildRowVersions(r.tbl, r.events || [], r.current || null);
    vs.forEach((v, i) => { v.rowKey = r.tbl + ':' + r.row_id; v.seq = i; });
    all.push(...vs);
  }
  const done = finishVersions(all);

  return done.map(v => {
    const val = v.values;
    const person = val.colleague_id == null ? ME : 'c' + val.colleague_id;
    return {
      id: v.rowKey + '#' + v.seq,
      row: v.rowKey,
      person,
      name: person === ME ? 'You' : (names[val.colleague_id] || val.name || ('Colleague #' + val.colleague_id)),
      date: val.date, start_time: val.start_time, end_time: val.end_time,
      shift_type: val.shift_type, store: val.store, absence_type: val.absence_type,
      hours: val.hours, break_min: val.break_min,
      from: v.from, from_op: v.from_op,
      from_label: v.from_op === 'legacy' ? null : sourceLabel(v.from_source, batches),
      from_note: v.from_note,
      to: v.to, to_op: v.to_op,
      to_label: v.to ? sourceLabel(v.to_source, batches) : null,
      to_note: v.to_note,
      prev: v.prev, next: v.next,
    };
  }).sort((a, b) => (a.date || '').localeCompare(b.date || '')
    || (a.start_time || '').localeCompare(b.start_time || '')
    || (a.from || '').localeCompare(b.from || ''));
}

// ── the change log ─────────────────────────────────────────────────────────

/**
 * A readable "what changed and when" list from raw events.
 *
 * A changed colleague shift arrives as a delete + an insert (the importer replaces
 * rows rather than editing them); a delete and an insert for the same person and
 * date in one action are shown as one "changed" line, or dropped if nothing
 * actually differs (a REPLACE of an identical shift, or a backup restore).
 *
 * @param {Array}  events  rota_history rows, with notes already attached
 * @param {object} ctx     { names, batches }
 * @param {object} opts    { minor: include break/hours-only edits }
 */
function buildLog(events, ctx, opts) {
  ctx = ctx || {}; opts = opts || {};
  const names = ctx.names || {};
  const batches = ctx.batches || {};

  const items = [];
  const pendingDelete = new Map();               // `${person}|${date}` -> item

  const sorted = events.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  // Events seeded from the audit log can carry only the fields that changed (a break
  // correction has no times). Fill the gaps from what the same row looked like at its
  // previous event, so "break 30m -> 15m" still knows which shift it was and what it paid.
  const shape = new Map();
  for (const e of sorted) {
    const k = e.tbl + ':' + e.row_id;
    const known = shape.get(k) || {};
    let oldV = parseJson(e.old_json), newV = parseJson(e.new_json);
    if (e.op === 'update') { oldV = { ...known, ...(oldV || {}) }; newV = { ...oldV, ...(newV || {}) }; }
    else if (e.op === 'delete') oldV = { ...known, ...(oldV || {}) };
    if (e.op === 'delete') shape.delete(k); else if (newV) shape.set(k, newV);
    const ov = oldV ? normValues(e.tbl, { ...oldV, date: oldV.date || e.old_date || e.date }) : null;
    const nv = newV ? normValues(e.tbl, { ...newV, date: newV.date || e.date }) : null;
    const base = ov || nv;
    if (!base) continue;
    const colId = (nv || ov).colleague_id;
    const person = colId == null ? ME : 'c' + colId;
    const item = {
      id: e.id, at: utcIso(e.at), tbl: e.tbl, person,
      name: person === ME ? 'You' : (names[colId] || base.name || ('Colleague #' + colId)),
      date: (nv || ov).date,
      op: e.op, kind: null,
      old: brief(ov), new: brief(nv),
      label: sourceLabel(e.source, batches), note: e.note || null,
    };
    const key = person + '|' + item.date;

    if (e.op === 'insert') {
      item.kind = 'added';
      // Deletes for this person and day within one action. A day can hold several
      // shifts (split shifts), so look for an identical one first — that is a
      // re-add — and only then fall back to "the shift that was replaced".
      const pend = pendingDelete.get(key) || [];
      const live = pend.filter(p => ms(item.at) - ms(p.at) <= SAME_ACTION_MS);
      if (live.length) {
        const same = live.find(p => identity({ ...p.old, colleague_id: colId }) === identity(nv));
        const pick = same || live[0];
        pend.splice(pend.indexOf(pick), 1);
        items.splice(items.indexOf(pick), 1);    // the delete is folded into this line
        if (same) continue;                      // identical -> nothing happened
        item.kind = 'changed'; item.old = pick.old; item.note = item.note || pick.note;
      }
    } else if (e.op === 'delete') {
      item.kind = 'removed';
      if (!pendingDelete.has(key)) pendingDelete.set(key, []);
      pendingDelete.get(key).push(item);
    } else {
      // A different shift (date, times, store…), or the same shift paid differently
      // (a corrected break) is a change. Anything else — a clock-out marking it
      // completed, a bank-holiday flag — is detail.
      const paidDifferently = ov && nv && (ov.hours !== nv.hours || (ov.break_min != null && nv.break_min != null && ov.break_min !== nv.break_min));
      item.kind = (ov && nv && (identity(ov) !== identity(nv) || paidDifferently)) ? 'changed' : 'detail';
    }
    items.push(item);
  }
  return items
    .filter(i => opts.minor || i.kind !== 'detail')
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
}

module.exports = {
  buildVersions, buildRowVersions, buildLog, sourceLabel,
  utcIso, mondayOf, addDays, normValues, identity, durationHours, policyBreakMinutes,
  SAME_ACTION_MS,
};
