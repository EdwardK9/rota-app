/* ─── Team-rota import parsing ──────────────────────────────────────────────
   Run: node test/team-import-parse.test.js

   The screenshot import goes image → Gemini JSON → these helpers → database.
   Every case below is a way a real screenshot or model reply was (or could
   be) written that used to drop shifts, fail the whole import, or file a
   shift under the wrong colleague.
   ───────────────────────────────────────────────────────────────────────── */
const {
  resolveWeekDates, resolveWeekForSchedule, resolveDayDate, parseTimeRange, fuzzyMatch, nameMatchesStrict, extractJson,
} = require('../teamImportParse');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}
const first = w => w && w[0];
const last = w => w && w[6];
const NOW = new Date(2026, 9, 1);   // 1 Oct 2026, for headers with no year

console.log('\nWeek header → Monday…Sunday:');
check('Rotageek "Mon D, YYYY – Mon D, YYYY"', [first(resolveWeekDates('Sep 28, 2026 – Oct 4, 2026', NOW)), last(resolveWeekDates('Sep 28, 2026 – Oct 4, 2026', NOW))], ['2026-09-28', '2026-10-04']);
check('short form "01 - Dec 7, 2025"', first(resolveWeekDates('01 - Dec 7, 2025', NOW)), '2025-12-01');
check('no year at all', first(resolveWeekDates('Sep 28 – Oct 4', NOW)), '2026-09-28');
check('day-first "28 Sep – 4 Oct 2026"', first(resolveWeekDates('28 Sep – 4 Oct 2026', NOW)), '2026-09-28');
check('numeric dd/mm/yyyy', first(resolveWeekDates('28/09/2026 - 04/10/2026', NOW)), '2026-09-28');
check('"Aug 24 – 30, 2026"', first(resolveWeekDates('Aug 24 – 30, 2026', NOW)), '2026-08-24');
check('only a start date shown still gives that week', first(resolveWeekDates('Week commencing 28 Sep 2026', NOW)), '2026-09-28');
check('trailing junk after the year', first(resolveWeekDates('Sep 28, 2026 – Oct 4, 2026 ▾', NOW)), '2026-09-28');
check('New Year: no year, early Jan read in late Dec', first(resolveWeekDates('Dec 29 – Jan 4', new Date(2025, 11, 20))), '2025-12-29');
check('nothing date-like', resolveWeekDates('Team schedule', NOW), null);

const sched = ['Mon 28', 'Tue 29', 'Wed 30', 'Thu 01', 'Fri 02', 'Sat 03', 'Sun 04'];
check('header misread a day late is corrected by the day labels', first(resolveWeekForSchedule('Sep 28, 2026 – Oct 5, 2026', sched, NOW)), '2026-09-28');
check('header misread a week late is corrected by the day labels', first(resolveWeekForSchedule('Oct 11, 2026', sched, NOW)), '2026-09-28');
check('labels with no numbers keep the header week', first(resolveWeekForSchedule('Sep 28, 2026 – Oct 4, 2026', ['Monday', 'Tuesday'], NOW)), '2026-09-28');

const week = resolveWeekDates('Sep 28, 2026 – Oct 4, 2026', NOW);
console.log('\nDay label → date within that week:');
check('"Mon 28"', resolveDayDate('Mon 28', week), '2026-09-28');
check('"Sun 04" across the month boundary', resolveDayDate('Sun 04', week), '2026-10-04');
check('"Tue 29th"', resolveDayDate('Tue 29th', week), '2026-09-29');
check('"28 Sep" (number not at the end)', resolveDayDate('28 Sep', week), '2026-09-28');
check('"Wednesday" with no number', resolveDayDate('Wednesday', week), '2026-09-30');
check('a number not in this week is skipped, not guessed', resolveDayDate('Thu 11', week), null);
check('ISO date', resolveDayDate('2026-10-02', week), '2026-10-02');
check('unrelated', resolveDayDate('Total', week), null);

console.log('\nShift times:');
check('"09:00 - 17:30"', parseTimeRange('09:00 - 17:30'), { start: '09:00', end: '17:30' });
check('"9:00–17:30" (en dash, single-digit hour)', parseTimeRange('9:00–17:30'), { start: '09:00', end: '17:30' });
check('"09.00 - 17.30"', parseTimeRange('09.00 - 17.30'), { start: '09:00', end: '17:30' });
check('"0900-1730"', parseTimeRange('0900-1730'), { start: '09:00', end: '17:30' });
check('"9am - 5:30pm"', parseTimeRange('9am - 5:30pm'), { start: '09:00', end: '17:30' });
check('"1-5pm" is an afternoon', parseTimeRange('1-5pm'), { start: '13:00', end: '17:00' });
check('"9-5pm" is a morning start', parseTimeRange('9-5pm'), { start: '09:00', end: '17:00' });
check('"12pm - 8pm"', parseTimeRange('12pm - 8pm'), { start: '12:00', end: '20:00' });
check('"9:00 to 17:00"', parseTimeRange('9:00 to 17:00'), { start: '09:00', end: '17:00' });
check('"9 - 5" is too ambiguous', parseTimeRange('9 - 5'), null);
check('nonsense hour', parseTimeRange('25:00 - 26:00'), null);
check('empty', parseTimeRange(''), null);

const people = [
  { id: 1, name: 'Wayne Aitken' }, { id: 2, name: 'Erin Ward' }, { id: 3, name: 'Tom Jones' },
  { id: 4, name: 'Nikki Houghton' }, { id: 5, name: 'Sam Smith' }, { id: 6, name: 'Sam Patel' },
  { id: 7, name: "Sean O'Brien" },
];
const who = raw => (fuzzyMatch(raw, people) || {}).id || null;
console.log('\nMatching names off a screenshot:');
check('exact', who('Erin Ward'), 2);
check('case and spacing', who('  erin   WARD '), 2);
check('initial for surname', who('Wayne A'), 1);
check('first name only when unique', who('Nikki'), 4);
check('first name only when two people share it → unknown', who('Sam'), null);
check('OCR typo in surname', who('Nikki Hougton'), 4);
check('OCR typo in first name', who('Erin Wrad'), 2);
check('apostrophe dropped', who('Sean OBrien'), 7);
check('words run together', who('ErinWard'), 2);
check('a NEW starter "Sam Jones" is not Tom Jones', who('Sam Jones'), null);
check('a stranger', who('Priya Shah'), null);
check('own-name check: "Ed Kay" vs setting "Ed Kay"', nameMatchesStrict('ED KAY', 'Ed Kay'), true);
check('own-name check: first name only', nameMatchesStrict('Ed', 'Ed Kay'), true);
check('own-name check: someone else', nameMatchesStrict('Edna Kay', 'Ed Kay'), false);

console.log('\nReading the model reply:');
check('plain JSON', extractJson('{"a":1}'), { a: 1 });
check('```json fenced', extractJson('```json\n{"a":1}\n```'), { a: 1 });
check('chatter before and after', extractJson('Here is the schedule:\n{"a":{"b":2}}\nLet me know!'), { a: { b: 2 } });
check('not JSON', extractJson('Sorry, I cannot read this image.'), null);

console.log(failures ? `\n${failures} check(s) FAILED.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
