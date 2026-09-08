/* ─── Break policy, checked against Rotageek ───────────────────────────────
   Run: node test/break-policy.test.js   (exits non-zero on a mismatch)

   autoBreakMinutes() decides how much unpaid break comes off a shift, so it
   sets paid hours, pay, and every contract comparison in the app. It was wrong
   at one boundary for a long time and nothing noticed, because the only way to
   catch it is to compare against what the employer actually did.

   These are real shifts, with the break Rotageek's own journal shows as unpaid.
   The two boundaries genuinely differ — 4h30 is inclusive, 6h is not — so if a
   future tidy-up makes them consistent with each other, this fails.
   ───────────────────────────────────────────────────────────────────────── */
// Pull the real autoBreakMinutes out of db.js without loading better-sqlite3
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'db.js'), 'utf8');
const m = src.match(/function autoBreakMinutes[\s\S]*?\n}/);
if (!m) throw new Error('could not find autoBreakMinutes in db.js');
const autoBreakMinutes = new Function(m[0] + '; return autoBreakMinutes;')();

const oldRule = (start, end) => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm); if (mins < 0) mins += 1440;
  if (mins > 480) return 45;
  if (mins > 360) return 30;
  if (mins > 270) return 15;
  return 0;
};

// [date, start, end, break Rotageek shows as unpaid]
const shifts = [
  ['2026-02-16', '14:45', '19:15', 15], ['2026-02-17', '15:30', '19:00', 0],
  ['2026-02-21', '09:15', '16:00', 30], ['2026-02-22', '08:45', '16:15', 30],
  ['2026-02-09', '10:00', '16:15', 30], ['2026-02-10', '15:00', '19:00', 0],
  // 14 Feb omitted: manager removed the break, so Rotageek's 0m there is a
  // deliberate exception rather than the policy. That is what break_locked is for.
  ['2026-02-15', '10:45', '14:15', 0],
  ['2026-08-14', '14:15', '18:45', 15], ['2026-08-15', '12:30', '16:30', 0],
  ['2026-08-21', '12:00', '19:15', 30], ['2026-08-28', '14:15', '19:15', 15],
  ['2026-08-19', '11:30', '17:30', 15], ['2026-08-27', '06:45', '14:30', 30],
  ['2026-08-26', '06:45', '12:00', 15],
  ['2026-09-01', '11:15', '15:15', 0],  ['2026-09-02', '12:00', '19:00', 30],
  ['2026-09-03', '12:15', '18:45', 30], ['2026-09-09', '13:45', '18:45', 15],
  ['2026-09-11', '14:00', '18:45', 15], ['2026-09-12', '13:15', '17:00', 0],
  ['2026-09-13', '08:45', '16:15', 30], ['2026-09-15', '12:00', '17:15', 15],
  ['2026-09-16', '14:15', '18:45', 15], ['2026-09-17', '13:30', '18:45', 15],
  ['2026-09-18', '12:30', '18:45', 30], ['2026-09-19', '06:45', '12:00', 15],
  ['2026-09-26', '14:15', '18:15', 0],  ['2026-09-27', '08:45', '16:00', 30],
  ['2026-08-31', '13:00', '18:00', 15],
];

const span = (a, b) => {
  const [sh, sm] = a.split(':').map(Number), [eh, em] = b.split(':').map(Number);
  let m = (eh * 60 + em) - (sh * 60 + sm); if (m < 0) m += 1440; return m;
};

let oldWrong = 0, newWrong = 0;
console.log('Date        Span    Rotageek  old  new');
for (const [date, start, end, actual] of shifts) {
  const o = oldRule(start, end), n = autoBreakMinutes(start, end), m = span(start, end);
  const oBad = o !== actual, nBad = n !== actual;
  if (oBad) oldWrong++;
  if (nBad) newWrong++;
  if (oBad || nBad) {
    console.log(`${date}  ${String(Math.floor(m/60))}h${String(m%60).padStart(2,'0')}   ${String(actual).padStart(3)}m` +
                `      ${String(o).padStart(2)}m${oBad ? '*' : ' '} ${String(n).padStart(2)}m${nBad ? '*' : ' '}`);
  }
}
console.log(`\n${shifts.length} shifts checked against Rotageek's own break figures.`);
console.log(`  old rule (strict >): ${oldWrong} wrong`);
console.log(`  new rule (>=):       ${newWrong} wrong`);
console.log(newWrong === 0 ? '\nNew rule matches Rotageek on every shift.' : '\nSTILL MISMATCHING');
process.exit(newWrong === 0 ? 0 : 1);
