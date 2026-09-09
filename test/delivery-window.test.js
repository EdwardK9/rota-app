/* ─── The delivery-shift window ────────────────────────────────────────────
   Run: node test/delivery-window.test.js

   A "delivery shift" is one you were on the floor for when the delivery
   landed — not one that merely started early. That distinction only started
   mattering when delivery moved to the evening: the old rule matched shifts
   starting 05:30–08:00, which counts nothing at all once the lorry arrives at
   18:00 and you're on a 14:00–18:45.

   Delivery times are kept as history (one delivery_schedules row per change),
   so this also checks that the expression built for Insights gives each period
   its own window rather than applying today's time to old shifts.

   No database here — better-sqlite3 is a native build, so like the other tests
   in this folder this one stays dependency-free and checks the pure helpers
   plus the SQL they generate.
   ───────────────────────────────────────────────────────────────────────── */
const {
  deliveryWindow, deliveryCaseSql, normaliseDeliveryTime, DEFAULT_DELIVERY_TIME,
} = require('../delivery');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}

console.log('\nThe ± 1 hour window around a delivery time:');
check('18:00 spans 17:00–19:00', deliveryWindow('18:00'), { from: '17:00', to: '19:00' });
check('06:30 spans 05:30–07:30', deliveryWindow('06:30'), { from: '05:30', to: '07:30' });
check('clamps at the start of the day', deliveryWindow('00:15'), { from: '00:00', to: '01:15' });
check('clamps at the end of the day', deliveryWindow('23:30'), { from: '22:30', to: '23:59' });
check('a missing time falls back to the default', deliveryWindow(null), deliveryWindow(DEFAULT_DELIVERY_TIME));

console.log('\nTimes coming back off the settings form:');
check('pads a single-digit hour', normaliseDeliveryTime('6:00'), '06:00');
check('empty means "use the default"', normaliseDeliveryTime(''), DEFAULT_DELIVERY_TIME);
check('rejects a nonsense hour', normaliseDeliveryTime('25:00'), null);
check('rejects a nonsense minute', normaliseDeliveryTime('18:75'), null);
check('rejects free text', normaliseDeliveryTime('teatime'), null);

console.log('\nThe Insights expression matches on overlap, not start time:');
const evening = deliveryCaseSql([{ effective_from: '2026-09-01', days: '5', delivery_time: '18:00' }]);
check(
  'a Friday shift touching 17:00–19:00 counts',
  evening,
  `(CASE WHEN date >= '2026-09-01' AND strftime('%w', date) IN ('5')`
  + ` AND start_time <= '19:00' AND end_time >= '17:00' THEN 1 ELSE 0 END)`
);
check('nothing keys off start_time alone any more', /start_time >= /.test(evening), false);

console.log('\nHistory: delivery used to be 06:00, and moved to 18:00 on 1 Sep:');
const withHistory = deliveryCaseSql([
  { effective_from: '2026-09-01', days: '5',   delivery_time: '18:00' },
  { effective_from: '2026-01-01', days: '3,4', delivery_time: '06:00' },
]);
check('the newer period is tested first', withHistory.indexOf('2026-09-01') < withHistory.indexOf('2026-01-01'), true);
check('the new period uses the evening window', withHistory.includes(`start_time <= '19:00' AND end_time >= '17:00'`), true);
check('the old period keeps its morning window', withHistory.includes(`start_time <= '07:00' AND end_time >= '05:00'`), true);
check('the old period keeps its own days', withHistory.includes(`IN ('3','4')`), true);

console.log('\nSchedules with no time of their own (saved before the time column):');
check(
  'fall back to the default rather than to no window',
  deliveryCaseSql([{ effective_from: '2026-01-01', days: '5', delivery_time: null }])
    .includes(`start_time <= '19:00' AND end_time >= '17:00'`),
  true
);

console.log('\nNo delivery days configured at all:');
check('produces no expression rather than broken SQL', deliveryCaseSql([]), null);
check('ignores a row with empty days', deliveryCaseSql([{ effective_from: '2026-01-01', days: '', delivery_time: '18:00' }]), null);

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
