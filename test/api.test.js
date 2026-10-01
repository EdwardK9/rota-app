/* ─── API smoke test against a real server ──────────────────────────────────
   Run: npm run test:api   (needs `npm install` — this one uses the real
   better-sqlite3 database, unlike the pure-helper tests in this folder)

   Starts server.js on a spare port with a throwaway DATA_DIR, then exercises
   the paths that matter most day to day: pages and assets are served (and
   bundled), shifts can be created and completed, clocking in/out works and is
   safe to retry, and a team import lands where it should.
   ───────────────────────────────────────────────────────────────────────── */
const { startServer } = require('./helpers/server');

let BASE;
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? `\n        got ${JSON.stringify(detail)}` : ''}`);
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

(async () => {
  const server = await startServer({ env: { MINIFY: '0' } });
  BASE = server.base;
  try {
    console.log('\nPage and assets:');
    const page = await req('GET', '/');
    check('index.html is served', page.status === 200 && page.body.includes('<title>'));
    const bundleSrc = (page.body.match(/src="(\/js\/app\.bundle\.js\?v=[^"]+)"/) || [])[1];
    check('scripts are served as one bundle', !!bundleSrc, page.body.match(/<script src="[^"]+"/g));
    if (bundleSrc) {
      const b = await req('GET', bundleSrc);
      check('bundle loads', b.status === 200 && b.body.includes('const App'));
      check('bundle is cached as immutable', /immutable/.test(b.headers.get('cache-control') || ''));
    }
    const css = (page.body.match(/href="(\/css\/style\.css\?v=[^"]+)"/) || [])[1];
    check('css carries a content-hash token', !!css && /\?v=[\w.]+-[0-9a-f]{8}$/.test(css), css);
    check('security headers set', page.headers.get('x-content-type-options') === 'nosniff');

    console.log('\nErrors come back as JSON:');
    const missing = await req('GET', '/api/does-not-exist');
    check('unknown endpoint → JSON 404', missing.status === 404 && missing.body.error);
    const badJson = await fetch(BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    check('malformed JSON → JSON 400', badJson.status === 400 && (await badJson.json()).error);

    console.log('\nShifts:');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const created = await req('POST', '/api/shifts', { date: today, start_time: '09:00', end_time: '17:30' });
    check('create a shift', created.status < 300 && created.body.id, created.body);
    const list = await req('GET', `/api/shifts?from=${today}&to=${today}`);
    check('it is listed for its date', list.body.length === 1 && list.body[0].start_time === '09:00', list.body);
    check('pay is calculated', list.body[0].calculated_pay > 0, list.body[0]);

    console.log('\nClock in / out:');
    const cin = await req('POST', '/api/clock/in', { time: '08:58', client_id: 'test-in-1' });
    check('clock in', cin.status === 200 && cin.body.clocked_in === '08:58', cin.body);
    const cinAgain = await req('POST', '/api/clock/in', { time: '08:58', client_id: 'test-in-1' });
    check('re-sending the same clock-in is recognised as a repeat', cinAgain.body.replayed === true && cinAgain.body.id === cin.body.id, cinAgain.body);
    const cout = await req('POST', '/api/clock/out', { time: '17:31', client_id: 'test-out-1' });
    check('clock out completes today\'s shift', cout.body.completed_shift && cout.body.completed_shift.id === created.body.id, cout.body);
    const coutAgain = await req('POST', '/api/clock/out', { time: '17:31', client_id: 'test-out-1' });
    check('re-sending the clock-out changes nothing', coutAgain.body.replayed === true, coutAgain.body);
    const todayClock = await req('GET', '/api/clock/today');
    check('exactly one clock entry for the day', todayClock.body.entries.length === 1, todayClock.body.entries);
    const badTime = await req('POST', '/api/clock/in', { time: '8am' });
    check('a malformed time is rejected', badTime.status === 400);
    const tap = await req('POST', '/api/clock/tap', { time: '18:00', client_id: 'test-tap-1' });
    check('a replayed NFC tap toggles (clocks back in)', tap.body.action === 'in', tap.body);

    console.log('\nTeam import:');
    for (const name of ['Wayne Aitken', 'Erin Ward']) await req('POST', '/api/colleagues', { name });
    const imp = await req('POST', '/api/colleagues/import-json', { schedule_data: {
      date_range: 'Oct 5 – Oct 11',
      schedule: [
        { date: 'Mon 05', shifts: [{ name: 'Erin Ward', time: '9.00 - 17.00' }, { name: 'Priya Shah', time: '09:00-17:00' }] },
        { date: 'Tue 06', shifts: [{ name: 'Wayne A', time: '1-8pm' }] },
        { date: 'Wed 07', shifts: [{ name: 'Erin Wrad', time: '9am - 5pm' }] },
        { date: 'Thu 08', shifts: [] }, { date: 'Fri 09', shifts: [] }, { date: 'Sat 10', shifts: [] }, { date: 'Sun 11', shifts: [] },
      ],
    } });
    check('imports what it can match', imp.body.inserted === 3, imp.body);
    check('reports the name it did not know', JSON.stringify(imp.body.unknownNames) === '["Priya Shah"]', imp.body.unknownNames);
    const batches = await req('GET', '/api/colleagues/import-batches?limit=5');
    check('the unknown name is shown in Recent Imports', batches.body.batches[0].unknown_names.includes('Priya Shah'), batches.body.batches[0]);
    await req('POST', '/api/colleagues', { name: 'Priya Shah' });
    const rerun = await req('POST', `/api/colleagues/import-batches/${imp.body.batchId}/rerun`, {});
    check('re-running after adding them imports their shift', rerun.body.inserted === 1 && !rerun.body.unknownNames.length, rerun.body);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + e.stack);
  } finally {
    server.stop();
  }
  if (failures && process.env.SHOW_SERVER_LOG) console.log(server.log());
  console.log(failures ? `\n${failures} check(s) FAILED.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
