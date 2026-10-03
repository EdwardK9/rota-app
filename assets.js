// Serving the front end: index.html (with content-hashed ?v= asset tokens),
// the page scripts as two bundles (minified in the background), and the
// static files with long-lived cache headers. Split out of server.js;
// mounted there with mountAssets(app).
const express = require('express');
const fs = require('fs');
const path = require('path');
const packageJson = require('./package.json');

function mountAssets(app) {
  // index.html is served with the running app version stamped into every ?v= asset
  // token. Hand-maintained tokens were a standing trap: forget to bump one and the
  // browser keeps last week's JS while the API moves on, which fails in exactly the
  // confusing way (new HTML, old script, "X is not a function"). Deriving the token
  // from package.json plus each file's content hash (see _assetToken) means any
  // change busts exactly the assets it touched.
  const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

  // JS bundles: index.html lists ~70 separate <script defer> files, which on a
  // phone meant ~70 round trips before the first view could render. They're all
  // classic scripts sharing one global scope, so concatenating them in their
  // listed order behaves the same — built once in memory (and pre-gzipped) at
  // startup. index.html keeps the individual tags as the source of truth;
  // RAW_ASSETS=1 serves them unbundled for debugging, and so does a bundle that
  // fails to compile (a clash between two files' top-level names would
  // otherwise take down every script instead of just the later one).
  //
  // Two bundles, not one. The tags marked data-core (the app shell, dashboard,
  // clocking, offline support — ~12% of the code) are "core" and load as the
  // page opens; everything else is "rest", which the app fetches as soon as the
  // dashboard is on screen (App.loadRest). A first visit after each update no
  // longer has to download and parse every page's code before showing anything.
  const SCRIPT_TAG_RE = /[ \t]*<script src="(\/js\/[^"?]+)(?:\?[^"]*)?"([^>]*)><\/script>\r?\n?/g;
  const BUNDLE_URL = { core: '/js/app.core.js', rest: '/js/app.rest.js' };
  const hashOf = buf => require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16);
  function packBundle(code) {
    const buf = Buffer.from(code, 'utf8');
    return { raw: buf, gz: require('zlib').gzipSync(buf, { level: 9 }), etag: '"' + hashOf(buf) + '"' };
  }
  const _bundles = (() => {
    if (process.env.RAW_ASSETS === '1') return null;
    try {
      const html = fs.readFileSync(INDEX_HTML, 'utf8');
      const tags = [...html.matchAll(SCRIPT_TAG_RE)].map(m => ({ src: m[1], core: /\bdata-core\b/.test(m[2]) }));
      const join = list => list.map(t =>
        `/* ${t.src} */\n` + fs.readFileSync(path.join(__dirname, 'public', t.src), 'utf8')
      ).join('\n;\n');
      const core = join(tags.filter(t => t.core));
      const rest = join(tags.filter(t => !t.core));
      if (!core) throw new Error('no data-core scripts in index.html');
      // Syntax / redeclaration checks: each bundle alone, and both together
      // (a name declared in both would only fail once the second one runs).
      const vm = require('vm');
      new vm.Script(core, { filename: 'app.core.js' });
      new vm.Script(rest, { filename: 'app.rest.js' });
      new vm.Script(core + '\n;\n' + rest, { filename: 'app.all.js' });
      return {
        core: { ...packBundle(core), count: tags.filter(t => t.core).length },
        rest: { ...packBundle(rest), count: tags.filter(t => !t.core).length },
      };
    } catch (e) {
      console.warn('[bundle] serving scripts unbundled:', e.message);
      return null;
    }
  })();
  const kb = n => Math.round(n / 1024) + 'KB';
  if (_bundles) for (const [name, b] of Object.entries(_bundles)) {
    console.log(`[bundle] ${name}: ${b.count} scripts → ${kb(b.raw.length)} (${kb(b.gz.length)} gzipped)`);
  }

  // Minify each bundle (roughly a quarter smaller gzipped), off the main thread
  // so the server keeps answering while it works, and cached on disk under the
  // source hash so a restart with unchanged code is instant. Until it's ready
  // the plain bundle is served; afterwards the page links the minified one — a
  // different ?v= token, so nothing ever mixes the two. Top-level names are left
  // alone: the files share globals and the markup calls them from onclick="…".
  // MINIFY=0 turns it off.
  function _swapInMinified(name, code, sourceTag) {
    new (require('vm').Script)(code, { filename: `app.${name}.min.js` });   // never swap in something broken
    Object.assign(_bundles[name], packBundle(code));
    const b = _bundles[name];
    console.log(`[bundle] ${name} minified${sourceTag} → ${kb(b.raw.length)} (${kb(b.gz.length)} gzipped)`);
  }
  if (_bundles && process.env.MINIFY !== '0') {
    const cacheDir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), '.cache');
    const keep = new Set(Object.values(_bundles).map(b => `bundle-${b.etag.slice(1, -1)}.min.js`));
    const prune = () => {
      try {
        for (const f of fs.readdirSync(cacheDir)) if (/^bundle-.*\.min\.js$/.test(f) && !keep.has(f)) fs.unlinkSync(path.join(cacheDir, f));
      } catch (_) { /* nothing cached yet */ }
    };
    prune();
    for (const name of Object.keys(_bundles)) {
      const cacheFile = path.join(cacheDir, `bundle-${_bundles[name].etag.slice(1, -1)}.min.js`);
      try {
        if (fs.existsSync(cacheFile)) {
          _swapInMinified(name, fs.readFileSync(cacheFile, 'utf8'), ' (cached)');
          continue;
        }
        const { Worker } = require('worker_threads');
        const worker = new Worker(`
          const { parentPort, workerData } = require('worker_threads');
          require(workerData.terser).minify(workerData.code, {
            ecma: 2020, toplevel: false, mangle: true,
            compress: { passes: 1 }, format: { comments: false },
          }).then(r => parentPort.postMessage({ code: r.code }), e => parentPort.postMessage({ error: e.message }));
        `, { eval: true, workerData: { code: _bundles[name].raw.toString('utf8'), terser: require.resolve('terser') } });
        worker.once('message', msg => {
          worker.terminate();
          if (msg.error) return console.warn(`[bundle] ${name} minify failed, serving unminified:`, msg.error);
          try {
            _swapInMinified(name, msg.code, '');
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(cacheFile, msg.code);
          } catch (e) {
            console.warn(`[bundle] ${name} minified output rejected, serving unminified:`, e.message);
          }
        });
        worker.once('error', e => console.warn(`[bundle] ${name} minify worker failed:`, e.message));
        worker.unref();
      } catch (e) {
        console.warn(`[bundle] ${name} minify skipped:`, e.message);
      }
    }
  }

  // ?v= token for an asset URL: the app version plus a hash of the file itself, so
  // any change to a file — not just a version bump — gives it a new URL. Assets are
  // cached as immutable (and kept by the service worker), so a token that didn't
  // change with the content would pin phones to old code. Memoised per mtime.
  const _assetTokens = new Map();
  function _assetToken(urlPath) {
    if (_bundles) for (const [name, url] of Object.entries(BUNDLE_URL)) {
      if (urlPath === url) return packageJson.version + '-' + _bundles[name].etag.slice(1, 9);
    }
    const file = path.join(__dirname, 'public', urlPath);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      const hit = _assetTokens.get(file);
      if (hit && hit.mtime === mtime) return hit.token;
      const hash = require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
      const token = packageJson.version + '-' + hash;
      _assetTokens.set(file, { mtime, token });
      return token;
    } catch (e) {
      return packageJson.version;
    }
  }

  app.get(Object.values(BUNDLE_URL), (req, res, next) => {
    const name = Object.keys(BUNDLE_URL).find(k => BUNDLE_URL[k] === req.path);
    const bundle = _bundles && _bundles[name];
    if (!bundle) return next();
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: bundle.etag,
      Vary: 'Accept-Encoding',
    });
    if (req.headers['if-none-match'] === bundle.etag) return res.status(304).end();
    // Content-Encoding set here makes the compression middleware leave it alone.
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.set('Content-Encoding', 'gzip');
      return res.end(bundle.gz);
    }
    res.end(bundle.raw);
  });

  app.get(['/', '/index.html'], (req, res, next) => {
    fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
      if (err) return next();   // fall through to static, which will 404 properly
      if (_bundles) {
        // Swap the first script tag for the core bundle and drop the rest; the
        // page learns where the rest bundle is from the meta tag (App.loadRest).
        let first = true;
        html = html.replace(SCRIPT_TAG_RE, () => {
          if (!first) return '';
          first = false;
          return `  <script src="${BUNDLE_URL.core}?v=0" defer></script>\n`;
        });
        html = html.replace('</head>', `  <meta name="app-rest-bundle" content="${BUNDLE_URL.rest}?v=0" />\n</head>`);
      }
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html.replace(/(["'])(\/[^"'?]+)\?v=[\w.]+/g,
        (m, q, p) => `${q}${p}?v=${_assetToken(p)}`));
    });
  });

  // Static assets: JS/CSS includes are versioned with ?v= tokens in index.html, so they
  // can be cached hard; index.html itself must always revalidate or deploys look stale.
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // index.html, the service worker and the manifest must always revalidate;
      // everything else (versioned JS/CSS, icons) can be cached hard.
      if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\.(js|css)$/.test(filePath)) {
        // Always requested with a ?v=<version> token, so a new deploy is a new URL.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  }));
}

module.exports = { mountAssets };
