/* ─── V5.0 client core ─────────────────────────────────────────────────────
   The one thing every V5 view depends on: its API surface, a view registry and
   a few render helpers — the same shape as v3core.js, so app.js can route V5
   views without naming any of them individually.

   V5 deliberately reuses the .v3-* CSS classes rather than shipping a second
   copy of the same tiles, bars and charts. The handful of things V5 needs that
   V3 has no equivalent of (the map plot, the place list, the privacy switches)
   live in v5.css.
   ───────────────────────────────────────────────────────────────────────── */

const V5 = {
  /* view id (matching data-view / #view-<id>) -> view object with init() and
     optionally destroy() */
  views: {},
  titles: {},

  register(id, title, view) {
    V5.views[id] = view;
    V5.titles[id] = title;
    return view;
  },

  /* ── API ──────────────────────────────────────────────────────────────── */
  api: {
    features:  ()      => API.get('/api/v5/features'),
    usage:     (days)  => API.get('/api/v5/usage?days=' + encodeURIComponent(days || 90)),
    screens:   (days)  => API.get('/api/v5/screens?days=' + encodeURIComponent(days || 90)),
    habits:    (days)  => API.get('/api/v5/habits?days=' + encodeURIComponent(days || 90)),
    locations: (days, kind) => API.get('/api/v5/locations?' + new URLSearchParams({
                            days: days || 90, ...(kind && kind !== 'all' ? { kind } : {}),
                          })),
    places:      ()        => API.get('/api/v5/locations/places'),
    createPlace: (d)       => API.post('/api/v5/locations/places', d),
    updatePlace: (id, d)   => API.put('/api/v5/locations/places/' + id, d),
    deletePlace: (id)      => API.delete('/api/v5/locations/places/' + id),
    privacy:     ()        => API.get('/api/v5/privacy'),
    savePrivacy: (d)       => API.post('/api/v5/privacy', d),
    wipe:        (scope)   => API.delete('/api/v5/data?scope=' + encodeURIComponent(scope || 'all')),
  },

  /* ── Render helpers ───────────────────────────────────────────────────── */

  backButton() {
    return `<button class="btn btn-ghost btn-sm v3-back-btn" onclick="App.navigate('v5-hub')">← All V5 Features</button>`;
  },

  loading(text = 'Loading…') {
    return `${V5.backButton()}<div class="v3-loading">${esc(text)}</div>`;
  },

  error(err) {
    return `${V5.backButton()}<p class="v3-error">Failed to load: ${esc(err && err.message ? err.message : String(err))}</p>`;
  },

  empty(icon, text, sub) {
    return `<div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${esc(text)}</div>
      ${sub ? `<div class="empty-state-sub">${esc(sub)}</div>` : ''}
    </div>`;
  },

  tile(label, value, sub, cls) {
    return `<div class="v3-tile">
      <div class="v3-tile-label">${esc(label)}</div>
      <div class="v3-tile-value${cls ? ' ' + cls : ''}">${value}</div>
      ${sub ? `<div class="v3-tile-sub">${sub}</div>` : ''}
    </div>`;
  },

  bar(pct, variant) {
    const width = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="v3-bar${variant ? ' ' + variant : ''}"><span style="width:${width}%"></span></div>`;
  },

  /** {label, value} points as a column chart, scaled to the largest value. */
  chart(points, variantFor) {
    if (!points.length) return `<p class="v3-muted">Not enough data to chart yet.</p>`;
    const max = Math.max(...points.map(p => p.value), 0.0001);
    return `<div class="v3-chart">${points.map(p => `
      <div class="v3-chart-col" title="${esc(p.title || `${p.label}: ${p.value}`)}">
        <div class="v3-chart-bar${variantFor ? ' ' + (variantFor(p) || '') : ''}"
             style="height:${Math.max(2, (p.value / max) * 100)}%"></div>
        <div class="v3-chart-label">${esc(p.label)}</div>
      </div>`).join('')}</div>`;
  },

  /** A long daily series as a sparkline. Deliberately not V5.chart(): that one
   *  gives every column a fixed 22px basis that will not shrink, which is right
   *  for 7 or 24 columns and forces the whole page sideways at 60. These bars
   *  shrink to whatever room there is and drop the per-column labels, which
   *  were unreadable at that density anyway. */
  spark(points, caption) {
    if (!points.length) return `<p class="v3-muted">Not enough data to chart yet.</p>`;
    const max = Math.max(...points.map(p => Number(p.value) || 0), 0.0001);
    return `<div class="v5-spark">${points.map(p => `
      <span class="v5-spark-bar${p.value ? '' : ' v5-spark-empty'}"
            style="height:${Math.max(2, ((Number(p.value) || 0) / max) * 100)}%"
            title="${esc(p.title || `${p.label}: ${p.value}`)}"></span>`).join('')}</div>
      ${caption ? `<div class="v5-spark-axis"><span>${esc(caption[0])}</span><span>${esc(caption[1])}</span></div>` : ''}`;
  },

  /** A horizontal ranked list — the shape most V5 answers take ("which views",
   *  "which places", "which transitions"). */
  ranked(rows) {
    if (!rows.length) return `<p class="v3-muted">Nothing recorded yet.</p>`;
    const max = Math.max(...rows.map(r => Number(r.value) || 0), 0.0001);
    return `<div class="v5-ranked">${rows.map(r => `
      <div class="v5-ranked-row">
        <div class="v5-ranked-label">${r.icon ? `<span class="v5-ranked-icon">${r.icon}</span>` : ''}${esc(r.label)}</div>
        <div class="v5-ranked-track"><span style="width:${Math.max(1, ((Number(r.value) || 0) / max) * 100)}%"></span></div>
        <div class="v5-ranked-value">${esc(r.display != null ? r.display : String(r.value))}</div>
      </div>`).join('')}</div>`;
  },

  /** The window picker every V5 page carries, so they all agree on what "last
   *  90 days" means and remember the choice between views. */
  daysPicker(id, selected) {
    const opts = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'],
                  [365, 'Last year'], ['all', 'All time']];
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Period:</label>
        <select id="${id}" style="width:auto">
          ${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  /** The chosen window is remembered app-wide rather than per view — flicking
   *  between App Usage and Screen Time shouldn't silently change the period. */
  get days() { return localStorage.getItem('v5Days') || '90'; },
  set days(v) { localStorage.setItem('v5Days', String(v)); },

  /* ── Formatting ───────────────────────────────────────────────────────── */

  /** "1h 24m" / "42m" / "18s" — mirrors the server's humanMs so a figure
   *  formatted client-side reads identically to one that arrived pre-formatted. */
  ms(msVal) {
    const s = Math.round((msVal || 0) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  },

  metres(m) {
    if (m == null) return '—';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1609.344).toFixed(2)} mi`;
  },

  pct(n) { return (n == null ? '—' : `${n}%`); },

  /** Colours a percentage the same way across every V5 page: green good, amber
   *  middling, red poor. `invert` for figures where low is the good end. */
  pctClass(n, invert) {
    if (n == null) return '';
    const good = invert ? n <= 25 : n >= 66;
    const bad  = invert ? n >= 75 : n <= 25;
    return good ? 'v5-good' : bad ? 'v5-bad' : '';
  },
};
