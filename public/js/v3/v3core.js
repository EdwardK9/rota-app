/* ─── V3.0 client core ─────────────────────────────────────────────────────
   The one thing every V3 view depends on: its API surface, a small view
   registry, and a few shared render helpers.

   The registry is what keeps V3 separable — app.js doesn't name any V3 view
   individually. It just asks V3.views for the current route, so adding a
   thirteenth feature means adding a file, a nav entry and a view div, with no
   change to the router at all.
   ───────────────────────────────────────────────────────────────────────── */

const V3 = {
  /* view id (matching data-view / #view-<id>) -> view object with init() and
     optionally destroy() */
  views: {},
  titles: {},

  register(id, title, view) {
    V3.views[id] = view;
    V3.titles[id] = title;
    return view;
  },

  /* ── API ──────────────────────────────────────────────────────────────── */
  api: {
    features:     ()          => API.get('/api/v3/features'),
    moneyClock:   ()          => API.get('/api/v3/money-clock'),
    trophies:     ()          => API.get('/api/v3/trophies'),
    records:      ()          => API.get('/api/v3/records'),
    forecast:     (taxYear, basis) => API.get('/api/v3/forecast?' + new URLSearchParams({
                                       ...(taxYear ? { tax_year: taxYear } : {}),
                                       ...(basis ? { basis } : {}),
                                     })),
    shiftDna:     (year, person) => API.get('/api/v3/shift-dna?' + new URLSearchParams({
                                      year: year || 'all', person: person || 'me',
                                    })),
    dnaPeople:    ()          => API.get('/api/v3/shift-dna/people'),
    balance:      (weeks)     => API.get('/api/v3/balance?weeks=' + encodeURIComponent(weeks || 12)),
    commuteCost:  (year)      => API.get('/api/v3/commute-cost?year=' + encodeURIComponent(year || 'all')),
    saveCommuteSettings: (d)  => API.post('/api/v3/commute-cost/settings', d),
    onThisDay:    (date, match) => API.get('/api/v3/on-this-day?' + new URLSearchParams({
                                     ...(date ? { date } : {}),
                                     ...(match ? { match } : {}),
                                   })),
    breakDebt:    (year)      => API.get('/api/v3/break-debt?year=' + encodeURIComponent(year || 'all')),
    bingo:        (week)      => API.get('/api/v3/bingo' + (week ? '?week=' + week : '')),
    bingoAllTime: ()          => API.get('/api/v3/bingo/all-time'),
    countdowns:   ()          => API.get('/api/v3/countdowns'),
    briefing:     (date)      => API.get('/api/v3/briefing' + (date ? '?date=' + date : '')),
    overtime:     (year)      => API.get('/api/v3/overtime?year=' + encodeURIComponent(year || 'all')),
    payRises:     ()          => API.get('/api/v3/pay-rises'),
    headToHead:   (colleague, year) => API.get('/api/v3/head-to-head?' + new URLSearchParams({
                                        colleague, year: year || 'all',
                                      })),
    yearInNumbers:()          => API.get('/api/v3/year-in-numbers'),
    didYouKnow:   (seed)      => API.get('/api/v3/did-you-know' + (seed ? '?seed=' + seed : '')),
    didYouKnowAI: ()          => API.get('/api/v3/did-you-know/ai'),
    leavePlanner: (to, maxSpan) => API.get('/api/v3/leave-planner?' + new URLSearchParams({
                                     ...(to ? { to } : {}),
                                     ...(maxSpan ? { max_span: maxSpan } : {}),
                                   })),
    coverFinder:  (date)      => API.get('/api/v3/cover-finder' + (date ? '?date=' + date : '')),
    crystalBall:  (week)      => API.get('/api/v3/crystal-ball' + (week ? '?week=' + week : '')),
    payAudit:     (taxYear)   => API.get('/api/v3/pay-audit' + (taxYear ? '?tax_year=' + taxYear : '')),
    taxCheck:     (taxYear)   => API.get('/api/v3/tax-check' + (taxYear ? '?tax_year=' + taxYear : '')),
    healthCheck:  ()          => API.get('/api/v3/health-check'),
    goals:        ()          => API.get('/api/v3/goals'),
    createGoal:   (d)         => API.post('/api/v3/goals', d),
    updateGoal:   (id, d)     => API.put('/api/v3/goals/' + id, d),
    deleteGoal:   (id)        => API.delete('/api/v3/goals/' + id),
  },

  /* ── Render helpers ───────────────────────────────────────────────────── */

  /** Link back to the V3 hub, meant to sit at the top of every feature page. */
  backButton() {
    return `<button class="btn btn-ghost btn-sm v3-back-btn" onclick="App.navigate('v3-hub')">← All V3 Features</button>`;
  },

  loading(text = 'Loading…') {
    return `${V3.backButton()}<div class="v3-loading">${esc(text)}</div>`;
  },

  error(err) {
    return `${V3.backButton()}<p class="v3-error">Failed to load: ${esc(err && err.message ? err.message : String(err))}</p>`;
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

  /** Renders a set of {label, value} into a simple bar chart. `variantFor` can
   *  colour individual columns. Bars are scaled against the largest value. */
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

  /** A year <select>, matching the toolbar pattern the rest of the app uses.
   *  `includeAll` adds an "All time" option. */
  yearPicker(id, selected, includeAll) {
    const years = getYears();
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
        <select id="${id}" style="width:auto">
          ${includeAll ? `<option value="all" ${selected === 'all' ? 'selected' : ''}>All time</option>` : ''}
          ${years.map(y => `<option value="${y}" ${String(y) === String(selected) ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  /** "in 3 days" / "yesterday" / "today", from a plain day count. */
  relativeDays(days) {
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days > 0) return `in ${days} days`;
    return `${Math.abs(days)} days ago`;
  },

  /** Splits a millisecond duration into a padded d/h/m/s countdown string. */
  countdownParts(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const p = n => String(n).padStart(2, '0');
    return { days, hours, mins, secs, clock: `${p(hours)}:${p(mins)}:${p(secs)}` };
  },

  /** Formats a YYYY-MM month key as "Aug 25". */
  shortMonth(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`;
  },
};
