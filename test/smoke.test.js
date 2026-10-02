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
