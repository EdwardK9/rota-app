/* ─── ✨ All V3 Features (V3.0) ────────────────────────────────────────────
   A landing page listing every V3 feature as a card you can click straight
   into, driven by /api/v3/features so it can never drift from what actually
   exists.

   It earns its place because the sidebar cannot show eighteen items at once on
   a normal screen — the group scrolls, and everything past the tenth or so is
   invisible unless you know to look for it. This is the index that makes the
   whole set discoverable in one glance.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('v3-hub', '✨ All V3 Features', {
  features: null,
  filter: '',

  /* Grouping is presentational only — the server list stays a flat registry. */
  GROUPS: [
    { key: 'money',  label: '💷 Money',        views: ['money-clock', 'forecast', 'overtime', 'pay-rises', 'goals', 'commute-cost', 'break-debt'] },
    { key: 'stats',  label: '📊 Stats & records', views: ['records', 'trophies', 'shift-dna', 'balance', 'year-numbers', 'head-to-head'] },
    { key: 'daily',  label: '🗓️ Day to day',   views: ['briefing', 'countdowns'] },
    { key: 'fun',    label: '🎉 For fun',      views: ['on-this-day', 'bingo', 'did-you-know'] },
  ],

  async init() {
    document.getElementById('view-v3-hub').innerHTML = V3.loading('Gathering the features…');
    try {
      this.features = (await V3.api.features()).features;
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
      <div class="v3-hero" style="background:linear-gradient(135deg,#8B5CF6,#4C1D95)">
        <div class="v3-hero-label">V3.0 FEATURES</div>
        <div class="v3-hero-value">${this.features.length}</div>
        <div class="v3-hero-sub">
          extra views, all built from data the app already holds. Tap any card to jump straight in —
          they are also in the sidebar under <strong>V3.0 Features</strong>, which scrolls.
        </div>
      </div>

      <div class="toolbar">
        <input type="search" id="hubSearch" placeholder="Search features…"
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
