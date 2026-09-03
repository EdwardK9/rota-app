/* ─── 📈 All V5 Features (V5.0) ────────────────────────────────────────────
   The landing page for the usage-analytics set, driven by /api/v5/features so
   it can never drift from what actually exists — same pattern as the V3 hub.

   It also carries the headline numbers, because "how much do I use this thing"
   is the question that brings you here, and making you click twice for it would
   be silly.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-hub', '📈 V5.0 Analytics', {
  features: null,
  summary: null,

  async init() {
    const el = document.getElementById('view-v5-hub');
    el.innerHTML = V5.loading('Gathering the features…');
    try {
      const [features, usage, privacy] = await Promise.all([
        V5.api.features(),
        V5.api.usage(30).catch(() => null),
        V5.api.privacy().catch(() => null),
      ]);
      this.features = features.features;
      this.summary = usage;
      this.privacy = privacy;
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  render() {
    const el = document.getElementById('view-v5-hub');
    const t = this.summary?.totals;
    const p = this.privacy?.settings;

    el.innerHTML = `
      <div class="v3-hero" style="background:linear-gradient(135deg,#0EA5E9,#0C4A6E)">
        <div class="v3-hero-label">LAST 30 DAYS</div>
        <div class="v3-hero-value">${t ? esc(t.total_label) : '—'}</div>
        <div class="v3-hero-sub">
          ${t ? `${t.sessions} visit${t.sessions === 1 ? '' : 's'} across ${t.days_used} of ${t.days_in_window} days,
                 averaging ${esc(t.avg_session_label)} each.` : 'Nothing recorded yet — it starts from the moment this is deployed.'}
        </div>
      </div>

      <p class="v3-intro">
        V5 is the app looking at itself: when you open it, how long you stay, which screens you
        actually use, how far ahead you check your shifts, and — if you switch it on — where you
        were when you clocked in. It is all stored in your own database and never leaves it.
      </p>

      ${p && !p.analytics_enabled ? `
        <div class="v5-banner v5-banner-off">
          ⏸️ <strong>Usage tracking is off.</strong> Nothing new is being recorded.
          Turn it back on in <a href="#" onclick="App.navigate('v5-privacy');return false">Data &amp; Privacy</a> or Settings.
        </div>` : ''}
      ${p && p.analytics_enabled && !p.location_enabled ? `
        <div class="v5-banner">
          📍 <strong>Location tracking is off</strong>, so the Clock Map has nothing to plot.
          It is off by default — switch it on in
          <a href="#" onclick="App.navigate('v5-privacy');return false">Data &amp; Privacy</a> if you want clock-ins pinned to a place.
        </div>` : ''}

      <div class="v3-grid" style="margin-top:18px">
        ${this.features.map(f => `
          <button class="v3-hub-card" data-goto="${esc(f.view)}">
            <span class="v3-hub-icon">${f.icon}</span>
            <span class="v3-hub-name">${esc(f.name)}</span>
            <span class="v3-hub-blurb">${esc(f.blurb)}</span>
          </button>`).join('')}
      </div>

      ${t ? `
        <div class="v3-section-title">📊 At a glance</div>
        <div class="v3-grid v3-grid-sm">
          ${V5.tile('Visits', t.sessions, 'in the last 30 days')}
          ${V5.tile('Typical visit', esc(t.median_session_label), `average ${esc(t.avg_session_label)}`)}
          ${V5.tile('Days used', `${t.days_used}<span class="v5-of">/${t.days_in_window}</span>`,
                    `${t.usage_rate_pct}% of days`, V5.pctClass(t.usage_rate_pct))}
          ${V5.tile('Current streak', `${this.summary.streaks.current}<span class="v5-of"> d</span>`,
                    `longest ${this.summary.streaks.longest} days`)}
          ${V5.tile('Screens opened', t.views, `${this.summary.totals.sessions ? (t.views / this.summary.totals.sessions).toFixed(1) : 0} per visit`)}
          ${V5.tile('First look', esc(this.summary.rhythm.first_open_median || '—'), 'median time of day')}
        </div>` : ''}
    `;

    el.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => App.navigate(btn.dataset.goto));
    });
  },
});
