/* ─── 🧭 Screen Time (V5.0) ────────────────────────────────────────────────
   Which parts of the app you actually use — by time spent and by how often you
   open them, which are usually two different rankings — plus the paths you take
   through it and the screens you have never opened at all.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-screens', '🧭 Screen Time', {
  data: null,
  sort: 'time',

  async init() {
    const el = document.getElementById('view-v5-screens');
    el.innerHTML = V5.loading('Adding up screen time…');
    try {
      this.data = await V5.api.screens(V5.days);
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-v5-screens');
    const t = d.totals;

    if (!t.visits) {
      el.innerHTML = `${V5.backButton()}${V5.daysPicker('v5ScreensDays', V5.days)}
        ${V5.empty('🧭', 'No screen time recorded in this period',
                   'Move around the app for a bit and come back.')}`;
      this._wire();
      return;
    }

    const views = [...d.views].sort((a, b) =>
      this.sort === 'visits' ? b.visits - a.visits : b.ms - a.ms);
    const top = views[0];

    el.innerHTML = `
      ${V5.backButton()}
      ${V5.daysPicker('v5ScreensDays', V5.days)}

      <div class="v3-hero" style="background:linear-gradient(135deg,#6366F1,#312E81)">
        <div class="v3-hero-label">MOST-USED SCREEN</div>
        <div class="v3-hero-value">${top.icon} ${esc(top.name)}</div>
        <div class="v3-hero-sub">
          ${esc(top.label_ms)} across ${top.visits} visit${top.visits === 1 ? '' : 's'} —
          ${top.share_pct}% of all your time in the app.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm">
        ${V5.tile('Screens opened', t.visits, `${t.views_per_session} per visit`)}
        ${V5.tile('Different screens', t.distinct_views, `of ${t.distinct_views + d.never_opened.length} you could`)}
        ${V5.tile('Typical stay', esc(t.avg_visit_label), 'per screen opened')}
        ${V5.tile('Checking the rota', esc(t.rota_check_label),
                  `${t.rota_check_pct}% of your time`, V5.pctClass(t.rota_check_pct))}
      </div>

      <div class="v3-section-title">
        📋 Every screen
        <span style="margin-left:auto;font-weight:500;font-size:12.5px">
          <button class="btn btn-ghost btn-sm ${this.sort === 'time' ? 'active' : ''}" data-sort="time">By time</button>
          <button class="btn btn-ghost btn-sm ${this.sort === 'visits' ? 'active' : ''}" data-sort="visits">By opens</button>
        </span>
      </div>
      <div class="card"><div class="card-body">
        <div class="table-wrapper"><table>
          <thead><tr><th>Screen</th><th>Time</th><th>Share</th><th>Opens</th><th>Typical stay</th><th>Days</th></tr></thead>
          <tbody>${views.map(v => `
            <tr>
              <td>${v.icon} ${esc(v.name)}</td>
              <td>${esc(v.label_ms)}</td>
              <td style="min-width:110px">
                ${V5.bar(v.share_pct)}
                <span class="v3-muted">${v.share_pct}%</span>
              </td>
              <td>${v.visits}</td>
              <td>${esc(v.median_label)}</td>
              <td>${v.days_seen}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        <p class="v3-note">"Typical stay" is the median, not the mean — one screen left open while the
        kettle boiled shouldn't make it look like your favourite.</p>
      </div></div>

      <div class="v3-grid v3-grid-lg" style="margin-top:8px">
        <div class="card"><div class="card-header"><h2>🚪 Where you start</h2></div><div class="card-body">
          ${V5.ranked(d.entry_views.map(v => ({
            icon: v.icon, label: v.name, value: v.count, display: `${v.count} (${v.pct}%)`,
          })))}
          <p class="v3-note">The first screen of a visit — what you opened the app <em>for</em>.</p>
        </div></div>

        <div class="card"><div class="card-header"><h2>🏁 Where you stop</h2></div><div class="card-body">
          ${V5.ranked(d.exit_views.map(v => ({
            icon: v.icon, label: v.name, value: v.count, display: `${v.count} (${v.pct}%)`,
          })))}
          <p class="v3-note">The last screen before you put your phone down.</p>
        </div></div>
      </div>

      ${d.transitions.length ? `
        <div class="v3-section-title">🔀 Common routes</div>
        <div class="card"><div class="card-body">
          ${V5.ranked(d.transitions.map(x => ({
            label: `${x.from.icon} ${x.from.name} → ${x.to.icon} ${x.to.name}`,
            value: x.count, display: `${x.count}×`,
          })))}
        </div></div>` : ''}

      ${d.hourly_by_view.length ? `
        <div class="v3-section-title">🕐 When each screen gets used</div>
        <div class="v3-grid v3-grid-lg">
          ${d.hourly_by_view.map(v => `
            <div class="card"><div class="card-header"><h2>${v.icon} ${esc(v.name)}</h2></div>
              <div class="card-body">
                ${V5.chart(v.hours.map((ms, h) => ({
                  label: h % 6 === 0 ? String(h) : '', value: ms,
                  title: `${String(h).padStart(2, '0')}:00 — ${V5.ms(ms)}`,
                })))}
              </div></div>`).join('')}
        </div>` : ''}

      ${d.never_opened.length ? `
        <div class="v3-section-title">🕸️ Never opened in this period</div>
        <div class="card"><div class="card-body">
          <div class="v3-chips">
            ${d.never_opened.map(v => `<span class="v3-chip">${v.icon} ${esc(v.name)}</span>`).join('')}
          </div>
          <p class="v3-note">Candidates for hiding from the sidebar — you can rearrange it by
          long-pressing the menu, or from Settings.</p>
        </div></div>` : ''}
    `;

    this._wire();
  },

  _wire() {
    document.getElementById('v5ScreensDays')?.addEventListener('change', e => {
      V5.days = e.target.value;
      this.init();
    });
    document.querySelectorAll('[data-sort]').forEach(b => {
      b.addEventListener('click', () => { this.sort = b.dataset.sort; this.render(); });
    });
  },
});
