/* ─── The under-contract week check ────────────────────────────────────────
   Run: node test/under-contract.test.js

   Ed is rostered at or above his weekly contract essentially always, and
   payroll only ever docks for sickness — which it pays straight back. So a
   past week landing under contract is a data error, and this is the check that
   surfaces it without anyone comparing against Rotageek by eye.

   Replicates the logic in v3/healthCheck.js (which can't be imported here
   without a database) against the real weeks that went wrong.
   ───────────────────────────────────────────────────────────────────────── */
const round2 = n => Math.round(n * 100) / 100;
const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
};
const mondayOf = (d) => {
  const x = new Date(d + 'T00:00:00'); const dow = x.getDay();
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
};

function shortWeeksOf(shifts, { contract = 20, today = '2026-09-09', leaveHoursByDay = new Map() } = {}) {
  const byWeek = new Map();
  for (const s of shifts) {
    const wk = mondayOf(s.date);
    const e = byWeek.get(wk) || { hours: 0, sick: 0, ids: [] };
    e.hours += s.hours_paid;
    if (s.absence_type === 'sick') e.sick += s.hours_paid;
    e.ids.push(s.id);
    byWeek.set(wk, e);
  }
  const out = [];
  const thisWeek = mondayOf(today);
  for (const [wk, e] of [...byWeek].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (wk >= thisWeek) continue;
    let leaveH = 0;
    for (let k = 0; k < 7; k++) leaveH += leaveHoursByDay.get(addDays(wk, k)) || 0;
    const covered = e.hours + leaveH;
    const short = round2(contract - covered);
    if (short > 0.01) out.push({ week_start: wk, covered: round2(covered), short, sick_hours: round2(e.sick) });
  }
  return out;
}

const mk = (date, hours_paid, extra = {}) => ({ id: date, date, hours_paid, ...extra });
let pass = true;
const check = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) pass = false; };

console.log('The real 9-15 Feb 2026 week, with the phantom 30m break on 14 Feb:');
const broken = [mk('2026-02-09', 5.75), mk('2026-02-10', 4.00), mk('2026-02-14', 6.25), mk('2026-02-15', 3.50)];
const r1 = shortWeeksOf(broken);
console.log(`   -> ${r1.length} flagged: covered ${r1[0]?.covered}h, short ${r1[0]?.short}h`);
check('flags the week that was 19.50h', r1.length === 1 && Math.abs(r1[0].short - 0.5) < 0.005);

console.log('\nThe same week once the break is corrected (6.75h on 14 Feb):');
const fixed = [mk('2026-02-09', 5.75), mk('2026-02-10', 4.00), mk('2026-02-14', 6.75), mk('2026-02-15', 3.50)];
check('does not flag a week that is exactly on contract', shortWeeksOf(fixed).length === 0);

console.log('\nA week off sick (rostered 20h, none worked):');
const sick = [mk('2026-01-26', 4.25, { absence_type: 'sick' }), mk('2026-01-27', 3.50, { absence_type: 'sick' }),
              mk('2026-01-28', 5.25, { absence_type: 'sick' }), mk('2026-01-29', 7.00, { absence_type: 'sick' })];
check('sickness counts towards contract, so not flagged', shortWeeksOf(sick).length === 0);

console.log('\nA week with annual leave booked (12h leave + 8h worked):');
const lv = new Map([['2026-06-02', 6], ['2026-06-03', 6]]);
check('real leave hours count towards contract',
  shortWeeksOf([mk('2026-06-01', 8)], { leaveHoursByDay: lv }).length === 0);

console.log('\nA week with a zero-hour day_off booked and only 15h worked:');
check('a day_off carries no hours, so the shortfall still shows',
  shortWeeksOf([mk('2026-06-01', 15)], { leaveHoursByDay: new Map([['2026-06-02', 0]]) }).length === 1);

console.log('\nThe current, still-running week:');
check('an in-progress week is never flagged',
  shortWeeksOf([mk('2026-09-07', 4)], { today: '2026-09-09' }).length === 0);

console.log(pass ? '\nAll checks passed.' : '\nFAILURES ABOVE.');
process.exit(pass ? 0 : 1);
