/* ─── 🚀 All V2.0 Features ─────────────────────────────────────────────────
   A landing page for the eight V2.0 views, same reasoning as the V3.0 hub:
   one sidebar button that's always visible beats an expandable group that
   pushes everything below it down the page.
   ───────────────────────────────────────────────────────────────────────── */

const V2Hub = {
  FEATURES: [
    { view: 'synergy',       icon: '🤝', name: 'Synergy Score',
      blurb: 'How the roster stacks up on any date — team highlights, keyholder gaps, notes.' },
    { view: 'team-metrics',  icon: '💷', name: 'Team Metrics',
      blurb: 'Weekly store spend, your share of it, average wage, and a cost coverage heatmap.' },
    { view: 'fatigue-audit', icon: '🩺', name: 'Fatigue Audit',
      blurb: 'Clopening detector, consecutive-day streaks and overtime alerts for the team.' },
    { view: 'shift-heatmap', icon: '🔥', name: 'Shift Heatmap',
      blurb: 'A GitHub-style year grid, one cell per day, coloured by hours worked.' },
    { view: 'weather',       icon: '🌤️', name: 'Weather',
      blurb: 'A fuller forecast for home and work, with your logged shifts overlaid.' },
    { view: 'what-if',       icon: '🧮', name: 'What If?',
      blurb: "\"If my hourly rate were £X instead\" — applied to your actual logged hours." },
    { view: 'streaks',       icon: '🏅', name: 'Streaks & Badges',
      blurb: 'Break, punctuality and on-contract streaks, with milestone badges.' },
    { view: 'wrapped',       icon: '🎁', name: 'Rota Wrapped',
      blurb: 'A Spotify-Wrapped-style year-end recap, built from data already tracked.' },
  ],

  init() {
    const el = document.getElementById('view-v2-hub');
    el.innerHTML = `
      <div class="v3-hero" style="background:linear-gradient(135deg,#0EA5E9,#0C4A6E)">
        <div class="v3-hero-label">V2.0 FEATURES</div>
        <div class="v3-hero-value">${this.FEATURES.length}</div>
        <div class="v3-hero-sub">
          The original extra views. Tap any card to jump straight in, and use
          <strong>🚀 V2.0 Features</strong> in the sidebar to come back here.
        </div>
      </div>

      <div class="v3-grid">
        ${this.FEATURES.map(f => `
          <button class="v3-hub-card" data-goto="${esc(f.view)}">
            <span class="v3-hub-icon">${f.icon}</span>
            <span class="v3-hub-name">${esc(f.name)}</span>
            <span class="v3-hub-blurb">${esc(f.blurb)}</span>
          </button>`).join('')}
      </div>
    `;

    el.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => App.navigate(btn.dataset.goto));
    });
  },
};
