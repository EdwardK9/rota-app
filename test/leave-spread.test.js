/* Run: node test/leave-spread.test.js
   How a lump-sum leave entry becomes days (leaveHours.js). The DB is stubbed —
   spreadEntry itself is pure. Cases are Ed's real Rotageek figures. */
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...a) {
  return req.endsWith('/db') || req === './db' ? { db: { prepare: () => ({ get: () => null }) } } : origLoad.call(this, req, ...a);
};
const { spreadEntry } = require('../leaveHours');

let failed = 0;
const check = (name, ok) => { console.log((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) failed++; };
const E = (s, e, h) => ({ start_date: s, end_date: e, hours_taken: h });
const near = (a, b) => Math.abs(a - b) < 1e-9;

let r = spreadEntry(E('2026-10-26', '2026-11-04', 32), 4);
check('32h over 26 Oct–4 Nov = 8 weekdays × 4h', Object.keys(r).length === 8 && Object.values(r).every(h => near(h, 4)));
check('…skipping Sat 31 Oct and Sun 1 Nov', !('2026-10-31' in r) && !('2026-11-01' in r));

r = spreadEntry(E('2026-11-28', '2026-11-28', 4), 4);
check('a single Saturday at 4h is that Saturday', near(r['2026-11-28'], 4) && Object.keys(r).length === 1);

r = spreadEntry(E('2026-06-15', '2026-06-21', 20), 4);
check('20h over Mon–Sun = Mon–Fri × 4h', Object.keys(r).length === 5 && !('2026-06-20' in r));

r = spreadEntry(E('2026-03-30', '2026-04-11', 40), 4);
check('40h over 30 Mar–11 Apr = 10 weekdays', Object.keys(r).length === 10 && Object.values(r).every(h => near(h, 4)));

r = spreadEntry(E('2026-11-28', '2026-11-29', 8), 4);
check('weekend-only range still gets its hours', Object.keys(r).length === 2);

r = spreadEntry(E('2026-11-02', '2026-11-02', 6), 4);
check('more hours than one day holds stay on the one day', near(r['2026-11-02'], 6));

check('zero hours yields nothing', Object.keys(spreadEntry(E('2026-11-02', '2026-11-03', 0), 4)).length === 0);

process.exit(failed ? 1 : 0);
