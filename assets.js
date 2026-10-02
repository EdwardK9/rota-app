// Serving the front end: index.html (with content-hashed ?v= asset tokens),
// all the page scripts as one bundle (minified in the background), and the
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

  // JS bundle: index.html lists ~70 separate <script defer> files, which on a phone
  // meant ~70 round trips before the first view could render. They're all classic
  // scripts sharing one global scope, so concatenating them in their listed order
  // behaves the same — built once in memory (and pre-gzipped) at startup, then
  // served as a single request. index.html keeps the individual tags as the source
  // of truth; RAW_ASSETS=1 serves them unbundled for debugging, and so does a
  // bundle that fails to compile (a clash between two files' top-level names
  // would otherwise take down every script instead of just the later one).
  const SCRIPT_TAG_RE = /[ \t]*<script src="(\/js\/[^"?]+)(?:\?[^"]*)?"[^>]*><\/script>\r?\n?/g;
  const _jsBundle = (() => {
    if (process.env.RAW_ASSETS === '1') return null;
    try {
      const html = fs.readFileSync(INDEX_HTML, 'utf8');
      const srcs = [...html.matchAll(SCRIPT_TAG_RE)].map(m => m[1]);
      const code = srcs.map(src =>
        `/* ${src} */\n` + fs.readFileSync(path.join(__dirname, 'public', src), 'utf8')
      ).join('\n;\n');
      new (require('vm').Script)(code, { filename: 'app.bundle.js' });   // syntax / redeclaration check only
      const buf = Buffer.from(code, 'utf8');
      return {
        count: srcs.length,
        raw: buf,
        gz: require('zlib').gzipSync(buf, { level: 9 }),
        etag: '"' + require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
      };
    } catch (e) {
      console.warn('[bundle] serving scripts unbundled:', e.message);
      return null;
    }
  })();
  if (_jsBundle) console.log(`[bundle] ${_jsBundle.count} scripts → ${Math.round(_jsBundle.raw.length / 1024)}KB (${Math.round(_jsBundle.gz.length / 1024)}KB gzipped)`);

  // Minify the bundle (roughly halves it again), off the main thread so the
  // server keeps answering while it works, and cached on disk under the source
  // hash so a restart with unchanged code is instant. Until it's ready the plain
  // bundle is served; afterwards the page links the minified one — a different
  // ?v= token, so nothing ever mixes the two. Top-level names are left alone:
  // the files share globals and the markup calls them from onclick="…".
  // MINIFY=0 turns it off.
  function _swapInMinified(code, sourceTag) {
    const buf = Buffer.from(code, 'utf8');
    new (require('vm').Script)(code, { filename: 'app.bundle.min.js' });   // never swap in something broken
    Object.assign(_jsBundle, {
      raw: buf,
      gz: require('zlib').gzipSync(buf, { level: 9 }),
      etag: '"' + require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
    });
    console.log(`[bundle] minified${sourceTag} → ${Math.round(buf.length / 1024)}KB (${Math.round(_jsBundle.gz.length / 1024)}KB gzipped)`);
  }
  if (_jsBundle && process.env.MINIFY !== '0') {
    const srcHash = _jsBundle.etag.slice(1, -1);
    const cacheDir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), '.cache');
    const cacheFile = path.join(cacheDir, `bundle-${srcHash}.min.js`);
    try {
      if (fs.existsSync(cacheFile)) {
        _swapInMinified(fs.readFileSync(cacheFile, 'utf8'), ' (cached)');
      } else {
        const { Worker } = require('worker_threads');
        const worker = new Worker(`
          const { parentPort, workerData } = require('worker_threads');
          require(workerData.terser).minify(workerData.code, {
            ecma: 2020, toplevel: false, mangle: true,
            compress: { passes: 1 }, format: { comments: false },
          }).then(r => parentPort.postMessage({ code: r.code }), e => parentPort.postMessage({ error: e.message }));
        `, { eval: true, workerData: { code: _jsBundle.raw.toString('utf8'), terser: require.resolve('terser') } });
        worker.once('message', msg => {
          worker.terminate();
          if (msg.error) return console.warn('[bundle] minify failed, serving unminified:', msg.error);
          try {
            _swapInMinified(msg.code, '');
            fs.mkdirSync(cacheDir, { recursive: true });
            for (const f of fs.readdirSync(cacheDir)) if (/^bundle-.*\.min\.js$/.test(f)) fs.unlinkSync(path.join(cacheDir, f));
            fs.writeFileSync(cacheFile, msg.code);
          } catch (e) {
            console.warn('[bundle] minified output rejected, serving unminified:', e.message);
          }
        });
        worker.once('error', e => console.warn('[bundle] minify worker failed:', e.message));
        worker.unref();
      }
    } catch (e) {
      console.warn('[bundle] minify skipped:', e.message);
    }
  }

  // ?v= token for an asset URL: the app version plus a hash of the file itself, so
  // any change to a file — not just a version bump — gives it a new URL. Assets are
  // cached as immutable (and kept by the service worker), so a token that didn't
  // change with the content would pin phones to old code. Memoised per mtime.
  const _assetTokens = new Map();
  function _assetToken(urlPath) {
    if (urlPath === '/js/app.bundle.js' && _jsBundle) return packageJson.version + '-' + _jsBundle.etag.slice(1, 9);
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

  app.get('/js/app.bundle.js', (req, res, next) => {
    if (!_jsBundle) return next();
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: _jsBundle.etag,
      Vary: 'Accept-Encoding',
    });
    if (req.headers['if-none-match'] === _jsBundle.etag) return res.status(304).end();
    // Content-Encoding set here makes the compression middleware leave it alone.
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.set('Content-Encoding', 'gzip');
      return res.end(_jsBundle.gz);
    }
    res.end(_jsBundle.raw);
  });

  app.get(['/', '/index.html'], (req, res, next) => {
    fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
      if (err) return next();   // fall through to static, which will 404 properly
      if (_jsBundle) {
        // Swap the first script tag for the bundle and drop the rest.
        let first = true;
        html = html.replace(SCRIPT_TAG_RE, () => {
          if (!first) return '';
          first = false;
          return '  <script src="/js/app.bundle.js?v=0" defer></script>\n';
        });
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
