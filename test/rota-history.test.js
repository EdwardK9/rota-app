/* ─── Rota history — replaying the change log ──────────────────────────────
   Run: node test/rota-history.test.js

   rotaHistoryCore.js has no database dependency, so this exercises the real
   module: events go in, "this shift looked like this from X until Y" comes out.
   ───────────────────────────────────────────────────────────────────────── */
const core = require('../rotaHistoryCore');

let pass = true;
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : (detail ? '  -> ' + detail : '')}`);
  if (!ok) pass = false;
}

let evId = 0;
const ev = (tbl, row_id, op, at, o) => ({
  id: ++evId, tbl, row_id, op, at,
  date: (o.new || o.old || {}).date || null,
  old_date: (o.old || {}).date || null,
  old_json: o.old ? JSON.stringify(o.old) : null,
  new_json: o.new ? JSON.stringify(o.new) : null,
  source: o.source || null, note: o.note || null,
});
const ownRow = (o = {}) => ({ id: 1, date: '2026-11-17', start_time: '09:00', end_time: '17:00', break_scheduled_minutes: 30,
  hours_paid: 7.5, hours_worked: 7.5, created_at: '2026-10-25 08:00:00', ...o });
const colRow = (o = {}) => ({ id: 10, colleague_id: 3, date: '2026-11-17', start_time: '09:00', end_time: '17:00',
  shift_type: 'shift', store: null, import_batch_id: 7, name: 'Jo', created_at: '2026-11-01 10:00:00', ...o });
const build = (rows, ctx) => core.buildVersions(rows, ctx || { names: { 3: 'Jo' }, batches: { 7: { note: 'Week of 16 Nov' } } });

console.log('\nA shift that predates the log and is still there:');
{
  const v = build([{ tbl: 'shifts', row_id: 1, events: [], current: ownRow() }]);
  check('one version, from its created_at', v.length === 1 && v[0].from === '2026-10-25T08:00:00Z' && v[0].from_op === 'legacy');
  check('still alive', v[0].to === null);
  check('hours are the paid hours', v[0].hours === 7.5, v[0].hours);
}

console.log('\nAdded, then deleted (live trigger events — full rows):');
{
  const full = ownRow();
  const v = build([{ tbl: 'shifts', row_id: 1, current: null, events: [
    ev('shifts', 1, 'insert', '2026-11-01 10:00:00', { new: full, source: 'auto_sync' }),
    ev('shifts', 1, 'delete', '2026-11-09 14:02:00', { old: full, source: 'midnight_sync', note: 'Removed — no longer in Rotageek' }),
  ] }]);
  check('one version', v.length === 1, v.length);
  check('added 1 Nov by the sync', v[0].from === '2026-11-01T10:00:00Z' && v[0].from_op === 'insert' && v[0].from_label === 'Rotageek sync');
  check('removed 9 Nov by the midnight sync, with its reason',
    v[0].to === '2026-11-09T14:02:00Z' && v[0].to_op === 'delete' && v[0].to_label === 'Midnight Rotageek sync'
    && v[0].to_note === 'Removed — no longer in Rotageek');
}

console.log('\nAdded, moved to different hours, then deleted:');
{
  const a = ownRow(), b = ownRow({ start_time: '10:00', end_time: '18:00' });
  const v = build([{ tbl: 'shifts', row_id: 1, current: null, events: [
    ev('shifts', 1, 'insert', '2026-11-01 10:00:00', { new: a }),
    ev('shifts', 1, 'update', '2026-11-05 09:00:00', { old: a, new: b, source: 'auto_sync' }),
    ev('shifts', 1, 'delete', '2026-11-09 14:00:00', { old: b }),
  ] }]);
  check('two versions', v.length === 2, v.length);
  check('the first ended by an edit, and says what it became',
    v[0].to_op === 'update' && v[0].next && v[0].next.start_time === '10:00');
  check('the second says what it was before', v[1].from_op === 'update' && v[1].prev.start_time === '09:00' && v[1].prev.end_time === '17:00');
  check('the second was removed', v[1].to_op === 'delete');
}

console.log('\nA pre-history row that is then deleted (first event is the delete):');
{
  const full = ownRow({ created_at: '2026-10-20 12:00:00' });
  const v = build([{ tbl: 'shifts', row_id: 1, current: null, events: [
    ev('shifts', 1, 'delete', '2026-11-09 14:00:00', { old: full }),
  ] }]);
  check('starts at its created_at', v.length === 1 && v[0].from === '2026-10-20T12:00:00Z' && v[0].from_op === 'legacy');
  check('ends at the delete', v[0].to === '2026-11-09T14:00:00Z' && v[0].to_op === 'delete');
}

console.log('\nRows backfilled from the audit log (partial values only):');
{
  // now: 15 min break. Break-only entry recorded old break 30.
  const current = ownRow({ break_scheduled_minutes: 15, hours_paid: 7.75, hours_worked: 7.75 });
  const v = build([{ tbl: 'shifts', row_id: 1, current, events: [
    ev('shifts', 1, 'insert', '2026-11-01 10:00:00', { new: { date: '2026-11-17', start_time: '09:00', end_time: '17:00' }, source: 'auto_sync' }),
    ev('shifts', 1, 'update', '2026-11-06 09:00:00', { old: { break_scheduled_minutes: 30 }, new: { break_scheduled_minutes: 15 }, source: 'auto_sync' }),
  ] }]);
  check('two versions (the break edit changes the hours)', v.length === 2, JSON.stringify(v.map(x => x.hours)));
  check('the earlier break is recovered from old_values', v[0].break_min === 30 && v[1].break_min === 15, JSON.stringify(v.map(x => x.break_min)));
  check('the first shows its start from the insert, the second from the edit', v[0].from_op === 'insert' && v[1].from_op === 'update');
}

console.log('\nClocking out does not clutter the history:');
{
  const a = ownRow(), done = ownRow({ completed: 1, hours_worked: 7.25 });
  const v = build([{ tbl: 'shifts', row_id: 1, current: done, events: [
    ev('shifts', 1, 'insert', '2026-11-01 10:00:00', { new: a }),
    ev('shifts', 1, 'update', '2026-11-17 17:05:00', { old: a, new: done, source: 'clock-out' }),
  ] }]);
  check('the completed flag / hours worked change folds into one version', v.length === 1 && v[0].from_op === 'insert' && v[0].to === null, v.length);
  check('and the shift is still "added 1 Nov"', v[0].from === '2026-11-01T10:00:00Z');
}

console.log('\nA team shift REPLACED by an identical one (new row id, same moment):');
{
  const a = colRow({ id: 10 }), b = colRow({ id: 11, created_at: '2026-11-09 12:00:00' });
  const v = build([
    { tbl: 'colleague_shifts', row_id: 10, current: null, events: [
      ev('colleague_shifts', 10, 'insert', '2026-11-01 10:00:00', { new: a, source: 'team_import:7' }),
      ev('colleague_shifts', 10, 'delete', '2026-11-09 12:00:00', { old: a }) ] },
    { tbl: 'colleague_shifts', row_id: 11, current: b, events: [
      ev('colleague_shifts', 11, 'insert', '2026-11-09 12:00:00', { new: b }) ] },
  ]);
  check('merged into a single shift', v.length === 1, v.length);
  check('"added" stays 1 Nov, not the day it was re-saved', v[0].from === '2026-11-01T10:00:00Z', v[0].from);
  check('and it is still alive', v[0].to === null);
  check('the import batch note is in the label', v[0].from_label === 'Team screenshot import — Week of 16 Nov', v[0].from_label);
}

console.log('\nA team shift replaced by a DIFFERENT one:');
{
  const a = colRow({ id: 10 }), b = colRow({ id: 11, start_time: '13:00', end_time: '21:00' });
  const v = build([
    { tbl: 'colleague_shifts', row_id: 10, current: null, events: [
      ev('colleague_shifts', 10, 'insert', '2026-11-01 10:00:00', { new: a }),
      ev('colleague_shifts', 10, 'delete', '2026-11-09 12:00:00', { old: a }) ] },
    { tbl: 'colleague_shifts', row_id: 11, current: b, events: [
      ev('colleague_shifts', 11, 'insert', '2026-11-09 12:00:00', { new: b }) ] },
  ]);
  check('two shifts', v.length === 2, v.length);
  check('the old one is removed on 9 Nov, the new one added on 9 Nov',
    v[0].to_op === 'delete' && v[1].from === '2026-11-09T12:00:00Z');
  check('names come from the colleagues table', v.every(x => x.name === 'Jo' && x.person === 'c3'));
}

console.log('\nTwo people, same time: not confused with each other:');
{
  const a = colRow({ id: 10, colleague_id: 3 }), b = colRow({ id: 11, colleague_id: 4, name: 'Sam' });
  const v = build([
    { tbl: 'colleague_shifts', row_id: 10, current: null, events: [
      ev('colleague_shifts', 10, 'insert', '2026-11-01 10:00:00', { new: a }),
      ev('colleague_shifts', 10, 'delete', '2026-11-09 12:00:00', { old: a }) ] },
    { tbl: 'colleague_shifts', row_id: 11, current: b, events: [
      ev('colleague_shifts', 11, 'insert', '2026-11-09 12:00:00', { new: b }) ] },
  ], { names: { 3: 'Jo', 4: 'Sam' } });
  check('Jo\'s removal is not swallowed by Sam\'s identical shift', v.length === 2, v.length);
}

console.log('\nThe change log:');
{
  const a = colRow({ id: 10 }), same = colRow({ id: 11 }), moved = colRow({ id: 12, start_time: '13:00', end_time: '21:00' });
  const logEv = [
    ev('colleague_shifts', 10, 'delete', '2026-11-09 12:00:00', { old: a, source: 'team_import:7' }),
    ev('colleague_shifts', 11, 'insert', '2026-11-09 12:00:00', { new: same, source: 'team_import:7' }),
  ];
  check('delete + identical insert is dropped entirely', core.buildLog(logEv, { names: { 3: 'Jo' } }).length === 0);

  const logEv2 = [
    ev('colleague_shifts', 10, 'delete', '2026-11-09 12:00:00', { old: a, source: 'team_import:7' }),
    ev('colleague_shifts', 12, 'insert', '2026-11-09 12:00:01', { new: moved, source: 'team_import:7' }),
  ];
  const l2 = core.buildLog(logEv2, { names: { 3: 'Jo' }, batches: { 7: { note: 'Week of 16 Nov' } } });
  check('delete + different insert becomes one "changed" line', l2.length === 1 && l2[0].kind === 'changed', JSON.stringify(l2.map(i => i.kind)));
  check('with before and after', l2[0].old.start_time === '09:00' && l2[0].new.start_time === '13:00');
  check('and where it came from', l2[0].label === 'Team screenshot import — Week of 16 Nov');

  const split = [
    ev('colleague_shifts', 20, 'delete', '2026-11-09 12:00:00', { old: colRow({ id: 20, start_time: '06:00', end_time: '10:00' }) }),
    ev('colleague_shifts', 21, 'delete', '2026-11-09 12:00:00', { old: colRow({ id: 21, start_time: '16:00', end_time: '20:00' }) }),
    ev('colleague_shifts', 22, 'insert', '2026-11-09 12:00:01', { new: colRow({ id: 22, start_time: '16:00', end_time: '20:00' }) }),
  ];
  const l3 = core.buildLog(split, { names: { 3: 'Jo' } });
  check('a split-shift day: the identical half is matched, the other half stays "removed"',
    l3.length === 1 && l3[0].kind === 'removed' && l3[0].old.start_time === '06:00', JSON.stringify(l3.map(i => [i.kind, i.old && i.old.start_time])));

  const plain = [ev('shifts', 1, 'delete', '2026-11-09 14:00:00', { old: ownRow(), source: 'midnight_sync', note: 'Removed — no longer in Rotageek' })];
  const l4 = core.buildLog(plain, {});
  check('your own removed shift is "You", with its reason', l4.length === 1 && l4[0].name === 'You' && l4[0].note === 'Removed — no longer in Rotageek');

  const brk = [ev('shifts', 1, 'update', '2026-11-09 14:00:00', { old: ownRow(), new: ownRow({ break_scheduled_minutes: 15, hours_paid: 7.75 }) })];
  const l6 = core.buildLog(brk, {});
  check('a corrected break changes your paid hours, so it IS in the log by default',
    l6.length === 1 && l6[0].kind === 'changed' && l6[0].old.hours === 7.5 && l6[0].new.hours === 7.75 && l6[0].old.break_min === 30 && l6[0].new.break_min === 15, JSON.stringify(l6));

  // The audit-log-seeded case: the break entry carries no times, they come from the shift's earlier event
  const seeded = [
    ev('shifts', 1, 'insert', '2026-11-01 10:00:00', { new: { date: '2026-11-17', start_time: '09:00', end_time: '17:00' }, source: 'auto_sync' }),
    ev('shifts', 1, 'update', '2026-11-06 09:00:00', { old: { break_scheduled_minutes: 30 }, new: { break_scheduled_minutes: 15 }, source: 'auto_sync' }),
  ];
  const l7 = core.buildLog(seeded, {});
  const l7u = l7.find(i => i.op === 'update');
  check('a break correction seeded from the audit log (no times in the entry) still reads as that shift, paid differently',
    l7u && l7u.kind === 'changed' && l7u.date === '2026-11-17' && l7u.old.start_time === '09:00' && l7u.old.hours === 7.5 && l7u.new.hours === 7.75
    && l7u.old.break_min === 30 && l7u.new.break_min === 15, JSON.stringify(l7u));

  const minor = [ev('shifts', 1, 'update', '2026-11-09 14:00:00', { old: ownRow(), new: ownRow({ completed: 1, hours_worked: 7.25 }) })];
  check('a clock-out (completed flag, hours worked) is left out of the log by default', core.buildLog(minor, {}).length === 0);
  const l5 = core.buildLog(minor, {}, { minor: true });
  check('and shown when asked for', l5.length === 1 && l5[0].kind === 'detail');
}

console.log('\nBreak estimate for a shift whose break was never recorded:');
{
  // The same trick break-policy.test.js uses: pull the real function out of db.js
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'db.js'), 'utf8');
  const m = src.match(/function autoBreakMinutes[\s\S]*?\n}/);
  const real = new Function(m[0] + '; return autoBreakMinutes;')();
  let drift = null;
  for (let mins = 0; mins <= 14 * 60 && !drift; mins += 5) {
    const h = String(Math.floor(mins / 60)).padStart(2, '0'), mm = String(mins % 60).padStart(2, '0');
    const end = `${String((6 * 60 + mins) / 60 | 0).padStart(2, '0')}:${String((6 * 60 + mins) % 60).padStart(2, '0')}`;
    if (real('06:00', end) !== core.policyBreakMinutes('06:00', end)) drift = `${mins} min shift`;
  }
  check("matches db.js autoBreakMinutes for every shift length (so the two can't drift apart)", !drift, drift);
  const v = build([{ tbl: 'shifts', row_id: 1, current: null, events: [
    ev('shifts', 1, 'delete', '2026-11-09 14:00:00', { old: { date: '2026-11-17', start_time: '09:00', end_time: '17:00', created_at: '2026-11-01 10:00:00' } }),
  ] }]);
  check('an 8h shift with no recorded break counts as 7.5h paid (30m policy break)', v[0].hours === 7.5, v[0].hours);
}

console.log('\nSource labels and dates:');
{
  check('no source means edited in the app', core.sourceLabel(null) === 'Edited in the app');
  check('known code', core.sourceLabel('midnight_sync') === 'Midnight Rotageek sync');
  check('unknown code is made readable', core.sourceLabel('some_new_thing') === 'Some new thing');
  check('the Monday of a Sunday is six days back', core.mondayOf('2026-11-22') === '2026-11-16');
  check('the Monday of a Monday is itself', core.mondayOf('2026-11-16') === '2026-11-16');
  check('addDays crosses a month', core.addDays('2026-11-29', 3) === '2026-12-02');
  check('SQLite timestamps become UTC instants', core.utcIso('2026-11-01 10:00:00') === '2026-11-01T10:00:00Z');
}

console.log(pass ? '\nAll checks passed.' : '\nFAILURES ABOVE.');
process.exit(pass ? 0 : 1);
