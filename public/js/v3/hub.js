/* ─── ✨ Features ──────────────────────────────────────────────────────────
   The one index page for everything that isn't in the sidebar: the /api/v3
   feature list (so it can't drift from what the server actually has) plus the
   handful of older pages listed in EXTRAS below. Each card opens its page.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('v3-hub', '✨ Features', {
  features: null,
  filter: '',

  /* Pages that have no /api/v3/features entry of their own: the older extras
     and the Clock Map. Listed here so there is one Features page rather than a
     hub per generation of the app. */
  EXTRAS: [
    { view: 'what-if',       icon: '🧮', name: 'What If?',
      blurb: '“If my hourly rate were £X instead” — applied to your actual logged hours.' },
    { view: 'weather',       icon: '🌤️', name: 'Weather',
      blurb: 'A fuller forecast for home and work, with your logged shifts overlaid.' },
    { view: 'team-metrics',  icon: '💷', name: 'Team Metrics',
      blurb: 'Weekly store spend, your share of it, average wage, and a cost coverage heatmap.' },
    { view: 'fatigue-audit', icon: '🩺', name: 'Fatigue Audit',
      blurb: 'Close-then-open turnarounds, long runs without a day off and overtime alerts for the team.' },
    { view: 'v5-locations',  icon: '📍', name: 'Clock Map',
      blurb: 'Where you were when you clocked in and out — off by default.' },
    { view: 'v5-privacy',    icon: '🔒', name: 'Data & Privacy',
      blurb: 'What location data is stored, the switches to stop it, and a button to delete it.' },
  ],

  /* Grouping is presentational only — the server list stays a flat registry. */
  GROUPS: [
    { key: 'money',  label: '💷 Money',      views: ['money-clock', 'forecast', 'pay-audit', 'tax-check', 'overtime', 'pay-rises', 'what-if', 'goals', 'savings', 'commute-cost', 'break-debt'] },
    { key: 'rota',   label: '🗓️ Rota',       views: ['annoying-shifts', 'year-numbers', 'leave-planner', 'cover-finder', 'weather'] },
    { key: 'team',   label: '👥 Team',       views: ['team-metrics', 'fatigue-audit'] },
    { key: 'upkeep', label: '🔧 Upkeep',     views: ['health-check', 'v5-locations', 'v5-privacy'] },
  ],

  async init() {
    document.getElementById('view-v3-hub').innerHTML = V3.loading('Gathering the features…');
    try {
      this.features = [...(await V3.api.features()).features, ...this.EXTRAS];
      this.render();
    } catch (e) {
      document.getElementById('view-v3-hub').innerHTML = V3.error(e);
    }
  },

  render() {
    const el = document.getElementById('view-v3-hub');
    const byView = Object.fromEntries(this.features.map(f => [f.view, f]));
    const grouped = new Set(this.GROUPS.flatMap(g => g.views));
    // Anything the server knows about but this page hasn't been told where to
    // put still shows up, rather than silently vanishing.
    const ungrouped = this.features.filter(f => !grouped.has(f.view)).map(f => f.view);

    const groups = [
      ...this.GROUPS,
      ...(ungrouped.length ? [{ key: 'other', label: '✨ Also here', views: ungrouped }] : []),
    ];

    const q = this.filter.trim().toLowerCase();
    const matches = f => !q || f.name.toLowerCase().includes(q) || f.blurb.toLowerCase().includes(q);
    const visible = this.features.filter(matches).length;

    el.innerHTML = `
      <div class="toolbar">
        <input type="search" id="hubSearch" placeholder="Search features…" aria-label="Search features"
               value="${esc(this.filter)}" style="max-width:280px" />
        ${q ? `<span class="v3-muted" style="align-self:center">${visible} of ${this.features.length}</span>` : ''}
      </div>

      <div id="hubGroups">
        ${groups.map(g => {
          const items = g.views.map(v => byView[v]).filter(Boolean).filter(matches);
          if (!items.length) return '';
          return `
            <div class="v3-section-title">${g.label}</div>
            <div class="v3-grid" style="margin-bottom:20px">
              ${items.map(f => `
                <button class="v3-hub-card" data-goto="${esc(f.view)}">
                  <span class="v3-hub-icon">${f.icon}</span>
                  <span class="v3-hub-name">${esc(f.name)}</span>
                  <span class="v3-hub-blurb">${esc(f.blurb)}</span>
                </button>`).join('')}
            </div>`;
        }).join('')}
      </div>

      ${q && !visible ? V3.empty('🔍', 'Nothing matches that', 'Try a different word.') : ''}
    `;

    el.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => App.navigate(btn.dataset.goto));
    });

    const search = document.getElementById('hubSearch');
    search.addEventListener('input', e => {
      this.filter = e.target.value;
      const pos = e.target.selectionStart;
      this.render();
      const again = document.getElementById('hubSearch');
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  },
});
