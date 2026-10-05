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

// A stand-in for the Gemini API, so the screenshot queue can be tested end to
// end without a key or network. `mode` picks how it behaves.
const http = require('http');
const fake = { mode: 'ok', modelsUsed: [] };
const fakeSchedule = { date_range: 'Oct 12, 2026 – Oct 18, 2026', schedule: [
  { date: 'Mon 12', shifts: [{ name: 'Erin Ward', time: '09:00 - 17:00' }] },
  { date: 'Tue 13', shifts: [{ name: 'Wayne Aitken', time: '12:00 - 20:00' }] },
] };
const fakeGemini = http.createServer((rq, rs) => {
  let body = '';
  rq.on('data', d => { body += d; });
  rq.on('end', () => {
    const send = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
    if (rq.method === 'GET') {   // model list
      return send(200, { models: ['gemini-main', 'gemini-fallback'].map(n => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) });
    }
    const model = (rq.url.match(/models\/([^:]+):/) || [])[1];
    fake.modelsUsed.push(model);
    const reply = text => send(200, { candidates: [{ content: { parts: [{ text }] } }] });
    if (fake.mode === 'array-wrapped') return reply(JSON.stringify([fakeSchedule]));
    if (fake.mode === 'quota-then-fallback' && model === 'gemini-main') {
      return send(429, { error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0', status: 'RESOURCE_EXHAUSTED' } });
    }
    if (fake.mode === 'nonsense') return reply("Sorry, I can't read this image clearly.");
    return reply(JSON.stringify(fakeSchedule));
  });
});

(async () => {
  await new Promise(r => fakeGemini.listen(0, '127.0.0.1', r));
  const server = await startServer({ env: { MINIFY: '0', GEMINI_API_BASE: `http://127.0.0.1:${fakeGemini.address().port}` } });
  BASE = server.base;
  try {
    console.log('\nPage and assets:');
    const page = await req('GET', '/');
    check('index.html is served', page.status === 200 && page.body.includes('<title>'));
    const coreSrc = (page.body.match(/src="(\/js\/app\.core\.js\?v=[^"]+)"/) || [])[1];
    const restSrc = (page.body.match(/name="app-rest-bundle" content="(\/js\/app\.rest\.js\?v=[^"]+)"/) || [])[1];
    check('scripts are served as a core bundle plus a rest bundle', !!coreSrc && !!restSrc && (page.body.match(/<script src=/g) || []).length === 1, page.body.match(/<script src="[^"]+"/g));
    for (const [label, src, marker] of [['core', coreSrc, 'const App'], ['rest', restSrc, 'const ShiftsView']]) {
      if (!src) continue;
      const b = await req('GET', src);
      check(`${label} bundle loads`, b.status === 200 && b.body.includes(marker));
      check(`${label} bundle is cached as immutable`, /immutable/.test(b.headers.get('cache-control') || ''));
    }
    const css = (page.body.match(/href="(\/css\/style\.css\?v=[^"]+)"/) || [])[1];
    check('css carries a content-hash token', !!css && /\?v=[\w.]+-[0-9a-f]{8}$/.test(css), css);
    check('security headers set', page.headers.get('x-content-type-options') === 'nosniff');

    console.log('\nErrors come back as JSON:');
    const missing = await req('GET', '/api/does-not-exist');
    check('unknown endpoint → JSON 404', missing.status === 404 && missing.body.error);
    const badJson = await fetch(BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    check('malformed JSON → JSON 400', badJson.status === 400 && (await badJson.json()).error);

    console.log('\nSecrets stay on the server:');
    await req('POST', '/api/settings', { gemini_api_key: 'AIza-real-test-key', your_name: 'Ed Kay' });
    const st = await req('GET', '/api/settings');
    check('a saved API key is not sent to the page', st.body.gemini_api_key && !JSON.stringify(st.body).includes('AIza-real-test-key'), st.body.gemini_api_key);
    check('ordinary settings still are', st.body.your_name === 'Ed Kay', st.body.your_name);
    await req('POST', '/api/settings', { ...st.body, your_name: 'Ed K' });   // a form saving everything back
    const stored = new (require('better-sqlite3'))(require('path').join(server.dataDir, 'rota.db'), { readonly: true })
      .prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
    check('saving the placeholder back keeps the real key', stored && stored.value === 'AIza-real-test-key', stored);

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

    console.log('\nTeam import — a shift that moved to another store:');
    const amelia = (await req('POST', '/api/colleagues', { name: 'Amelia Stubbington' })).body;
    const weekOf = (tue) => ({ date_range: 'Oct 19 – Oct 25', schedule: [
      { date: 'Mon 19', shifts: [{ name: 'Erin Ward', time: '09:00 - 17:00' }] },
      { date: 'Tue 20', shifts: [{ name: 'Erin Ward', time: '09:00 - 17:00' }, ...tue] },
      { date: 'Wed 21', shifts: [{ name: 'Erin Ward', time: '09:00 - 17:00' }] },
      { date: 'Thu 22', shifts: [] }, { date: 'Fri 23', shifts: [] }, { date: 'Sat 24', shifts: [] }, { date: 'Sun 25', shifts: [] },
    ] });
    await req('POST', '/api/colleagues/import-json', { schedule_data: weekOf([{ name: 'Amelia Stubbington', time: '07:00 - 14:30', store: 'Winchester' }]) });
    const tueShifts = async () => (await req('GET', `/api/working-with/team-calendar?colleagueId=${amelia.id}&from=2026-10-20&to=2026-10-20`)).body.shifts;
    check('the Winchester shift is saved with its store', (await tueShifts()).map(x => x.store).join() === 'Winchester', await tueShifts());
    const moved = await req('POST', '/api/colleagues/import-json', { schedule_data: weekOf([{ name: 'Amelia Stubbington', time: '08:00 - 16:00', store: 'Portsmouth - Fratton' }]) });
    const after = await tueShifts();
    check('moving her to Fratton replaces the old Winchester shift', after.length === 1 && after[0].store === 'Portsmouth - Fratton', after);
    check('the clean-up is counted', moved.body.reconciled >= 1, moved.body);
    await req('POST', '/api/colleagues/import-json', { schedule_data: weekOf([]) });
    check('a different-store shift missing from a full day is cleared too', (await tueShifts()).length === 0, await tueShifts());

    console.log('\nScreenshot queue (with a stand-in Gemini):');
    await req('POST', '/api/settings', { gemini_api_key: 'test-key', gemini_model: 'gemini-main' });
    // Each test screenshot's file name shows up in its batch note.
    const queueOne = async (name) => {
      const fd = new FormData();
      fd.append('screenshots', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), name + '.jpg');
      const r = await fetch(BASE + '/api/colleagues/screenshot-queue', { method: 'POST', body: fd });
      return (await r.json()).fileIds[0];
    };
    const waitFor = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 300)); }
      return null;
    };
    const queueState = async () => (await req('GET', '/api/colleagues/screenshot-queue')).body;
    const doneBatch = async note => (await req('GET', '/api/colleagues/import-batches?limit=20')).body.batches.find(b => (b.note || '').includes(note));

    fake.mode = 'array-wrapped';
    await queueOne('array-wrapped');
    check('a reply wrapped in an array is still imported', await waitFor(() => doneBatch('array-wrapped')), await queueState());

    fake.mode = 'quota-then-fallback';
    fake.modelsUsed = [];
    const fbId = await queueOne('quota-fallback');
    const inQueue = q => [...q.pending, ...q.waiting, ...q.failed].some(x => x.id === fbId);
    const fbDone = await waitFor(async () => !inQueue(await queueState()));
    check('when the main model is out of quota, another model reads it', fbDone && fake.modelsUsed.includes('gemini-fallback'), { state: await queueState(), used: fake.modelsUsed });

    fake.mode = 'nonsense';
    const badId = await queueOne('nonsense');
    const qs = await waitFor(async () => { const q = await queueState(); return [...q.waiting, ...q.failed].some(x => x.id === badId) && q; });
    const bad = qs && [...qs.waiting, ...qs.failed].find(x => x.id === badId);
    check('after one failed try it shows as "will retry", not "failed"', bad && qs.waiting.some(x => x.id === badId), qs);
    check('…with the reason, including what Gemini actually said', bad && /Sorry, I can't read/.test(bad.process_error), bad);
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + e.stack);
  } finally {
    server.stop();
    fakeGemini.close();
  }
  if (failures && process.env.SHOW_SERVER_LOG) console.log(server.log());
  console.log(failures ? `\n${failures} check(s) FAILED.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
