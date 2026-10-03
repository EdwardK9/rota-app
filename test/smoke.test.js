/* ─── Browser smoke test: every page opens on a phone without errors ────────
   Run: npm run test:smoke
   (needs the dev dependencies and a Chromium for Playwright:
    `npm install && npx playwright install chromium`)

   Starts the real server on a throwaway database, waits for the minified
   bundle (what phones actually get), then opens every view at phone size and
   fails on: a JavaScript error, a view showing its "couldn't load" card, or
   the page scrolling sideways.
   ───────────────────────────────────────────────────────────────────────── */
const { chromium, devices } = require('playwright');
const { startServer } = require('./helpers/server');

(async () => {
  const server = await startServer();
  // The server minifies in the background; test what a phone would get.
  const deadline = Date.now() + 60000;
  while (!/\[bundle\] minified/.test(server.log()) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  const minified = /\[bundle\] minified/.test(server.log());
  console.log(minified ? '\nUsing the minified bundle.' : '\n(minified bundle not ready — testing the plain one)');

  let failures = 0;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'Europe/London' })).newPage();
    let errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      // External CDNs (xlsx, leaflet, jszip) may be unreachable in CI — not our failure.
      if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text());
    });
    page.on('dialog', d => d.dismiss());

    await page.goto(server.base + '/', { waitUntil: 'networkidle' });
    const views = await page.evaluate(() => {
      const fromDom = [...document.querySelectorAll('.view')].map(v => v.id.replace('view-', ''));
      const registered = [...Object.keys(window.V3 ? V3.views : {}), ...Object.keys(window.V5 ? V5.views : {})];
      return [...new Set([...fromDom, ...registered])];
    });
    console.log(`Opening ${views.length} views at phone size:\n`);

    for (const view of views) {
      errors = [];
      await page.evaluate(v => App.navigate(v), view).catch(e => errors.push('navigate: ' + e.message));
      await page.waitForTimeout(400);
      const state = await page.evaluate(v => ({
        broken: !!document.querySelector(`#view-${v} .view-error`),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }), view);
      const problems = [...errors];
      if (state.broken) problems.push('showed its "couldn\'t load" card');
      if (state.overflow > 1) problems.push(`page scrolls sideways by ${state.overflow}px`);
      if (problems.length) failures++;
      console.log(`  ${problems.length ? 'FAIL' : 'PASS'}  ${view}${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
    }
    // Opening a page other than the dashboard directly (a bookmark, a link, or
    // the back button after a reload): its code is in the second bundle, which
    // has to be fetched before the page can draw.
    console.log('\nOpening pages directly, on a fresh load:\n');
    for (const view of ['shifts', 'clock', 'money-clock', 'v5-hub']) {
      const fresh = await (await browser.newContext({ ...devices['Pixel 7'], timezoneId: 'Europe/London' })).newPage();
      const errs = [];
      fresh.on('pageerror', e => errs.push(e.message));
      await fresh.goto(`${server.base}/#${view}`, { waitUntil: 'networkidle' });
      await fresh.waitForTimeout(400);
      const state = await fresh.evaluate(v => {
        const el = document.getElementById('view-' + v);
        return { visible: !!el && !el.classList.contains('hidden'), filled: !!el && el.innerText.trim().length > 20,
                 broken: !!(el && el.querySelector('.view-error')) };
      }, view);
      const problems = [...errs];
      if (!state.visible || !state.filled) problems.push('page did not draw');
      if (state.broken) problems.push('showed its "couldn\'t load" card');
      if (problems.length) failures++;
      console.log(`  ${problems.length ? 'FAIL' : 'PASS'}  #${view}${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
      await fresh.context().close();
    }
    // Wide-screen check for pages with their own charts: nothing inside them
    // may scroll sideways (Who's In used to show a sliver of horizontal scroll).
    console.log('\nNo sideways scrolling inside pages on a wide screen:\n');
    // A realistic day of team shifts first, so there's a chart to check.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const day = [['Holly Woonton', '06:45', '12:15'], ['Janice Dennett', '10:15', '18:15'],
                 ['Lucas Topliss', '10:45', '15:15'], ['Erin Ward', '15:15', '18:15']];
    const post = (path, body) => fetch(server.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const [name] of day) await post('/api/colleagues', { name });
    await post('/api/team-shifts/import', { shifts: day.map(([name, start_time, end_time]) => ({ name, date: today, start_time, end_time })) });
    const wide = await (await browser.newContext({ viewport: { width: 1880, height: 906 }, timezoneId: 'Europe/London' })).newPage();
    await wide.goto(server.base + '/', { waitUntil: 'networkidle' });
    for (const view of ['whos-in', 'team-calendar', 'dashboard']) {
      await wide.evaluate(v => App.navigate(v), view);
      await wide.waitForTimeout(400);
      const scrollers = await wide.evaluate(v => [...document.querySelectorAll(`#view-${v} *`)]
        .filter(e => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)
          && !e.closest('.table-wrapper'))   // wide data tables scroll on purpose
        .map(e => e.className || e.tagName).slice(0, 3), view);
      if (scrollers.length) failures++;
      console.log(`  ${scrollers.length ? 'FAIL' : 'PASS'}  ${view}${scrollers.length ? '\n        scrolls sideways: ' + scrollers.join(', ') : ''}`);
    }
    await wide.context().close();
  } catch (e) {
    failures++;
    console.log('  FAIL  ' + e.stack);
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(failures ? `\n${failures} view(s) FAILED.\n` : '\nAll views passed.\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
