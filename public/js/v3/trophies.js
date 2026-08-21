/* ─── 🏆 Trophy Cabinet (V3.0) ─────────────────────────────────────────────
   One card per trophy family, each showing its four tiers as a row of medals
   with the next target called out. Filter across all / in progress / complete.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('trophies', '🏆 Trophy Cabinet', {
  data: null,
  filter: 'all',

  async init() {
    document.getElementById('view-trophies').innerHTML = V3.loading('Polishing the silverware…');
    try {
      this.data = await V3.api.trophies();
      this.render();
    } catch (e) {
      document.getElementById('view-trophies').innerHTML = V3.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-trophies');

    // Tier tallies live on their own strip rather than inside the hero — on the
    // hero's gradient the tier colours had almost no contrast and were unreadable.
    const tierStrip = d.by_tier.map(t => `
      <div class="v3-tile" style="text-align:center">
        <div style="font-size:22px;line-height:1">${{ bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎' }[t.tier]}</div>
        <div class="v3-tile-label" style="margin-top:4px">${esc(t.label)}</div>
        <div style="font-size:19px;font-weight:800;margin-top:2px">${t.earned}<span style="font-size:13px;color:var(--text-muted)">/${t.total}</span></div>
      </div>`).join('');

    const closest = d.families.filter(f => !f.complete).slice(0, 3);

    el.innerHTML = `
      ${V3.backButton()}
      <div class="v3-hero" style="background:linear-gradient(135deg,#F59E0B,#92400E)">
        <div class="v3-hero-label">TROPHY CABINET</div>
        <div class="v3-hero-value">${d.earned_tiers} / ${d.total_tiers}</div>
        <div class="v3-hero-sub">
          medals earned across ${d.family_count} trophies · ${d.completion_pct}% complete
          ${d.families_complete ? ` · ${d.families_complete} maxed out` : ''}
        </div>
        <div class="v3-hero-bar"><span style="width:${d.completion_pct}%"></span></div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">${tierStrip}</div>

      ${closest.length ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-header"><h2>🎯 Closest to the next medal</h2></div>
          <div class="card-body">
            ${closest.map(f => `
              <div style="margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px;gap:12px">
                  <span>${f.icon} <strong>${esc(f.name)}</strong>
                    <span class="v3-muted">— ${f.next_tier.remaining_label} to ${esc(f.next_tier.label)}</span></span>
                  <span style="white-space:nowrap">${f.value_label} / ${f.next_tier.need_label}</span>
                </div>
                ${V3.bar(f.progress_pct, 'warning')}
              </div>`).join('')}
          </div>
        </div>` : ''}

      <div class="toolbar">
        <div class="radio-group" id="trophyFilter">
          ${[['all', 'All'], ['progress', 'In progress'], ['complete', 'Maxed out']].map(([v, label]) => `
            <label class="radio-label">
              <input type="radio" name="trophyFilter" value="${v}" ${this.filter === v ? 'checked' : ''}> ${label}
            </label>`).join('')}
        </div>
      </div>

      <div class="v3-grid" id="trophyGrid">${this.cards()}</div>

      <div class="v3-note">
        Every trophy has four medals — bronze, silver, gold and platinum — so there is always a next
        target. They unlock automatically from your shifts, clock-ins, payslips and colleagues;
        once earned a medal stays earned.
        <br><br>
        🏪 <strong>The Whole Store</strong> is measured against your current team
        (${d.store.worked_with} of ${d.store.active_colleagues} worked with), so when someone new
        starts it drops back until you have worked a shift with them too.
      </div>
    `;

    el.querySelectorAll('input[name="trophyFilter"]').forEach(input => {
      input.addEventListener('change', e => {
        this.filter = e.target.value;
        document.getElementById('trophyGrid').innerHTML = this.cards();
      });
    });
  },

  cards() {
    const list = this.data.families.filter(f =>
      this.filter === 'all' || (this.filter === 'complete' ? f.complete : !f.complete));

    if (!list.length) return V3.empty('🏆', 'Nothing here yet', 'Try a different filter.');

    const MEDAL = { bronze: '🥉', silver: '🥈', gold: '🥇', platinum: '💎' };

    return list.map(f => `
      <div class="v3-trophy ${f.highest_tier ? 'earned ' + f.highest_tier : 'locked'}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div class="v3-trophy-icon">${f.icon}</div>
          <div style="text-align:right">
            <div style="font-size:19px;font-weight:800">${f.value_label}</div>
            ${f.dynamic ? '<div class="v3-muted" style="font-size:10.5px">moves with the team</div>' : ''}
          </div>
        </div>
        <div class="v3-trophy-name">${esc(f.name)}</div>
        <div class="v3-trophy-desc">${esc(f.blurb)}</div>

        <div class="v3-medals">
          ${f.tiers.map(t => `
            <div class="v3-medal ${t.tier} ${t.earned ? 'earned' : 'locked'}"
                 title="${esc(t.label)} — ${t.earned ? 'earned at' : 'needs'} ${esc(t.need_label)}${
                   t.earned && t.unlocked_at ? ' · unlocked ' + fmtDate(String(t.unlocked_at).slice(0, 10)) : ''}">
              <span class="v3-medal-icon">${t.earned ? MEDAL[t.tier] : '🔒'}</span>
              <span class="v3-medal-need">${esc(t.need_label)}</span>
            </div>`).join('')}
        </div>

        ${f.complete
          ? '<div class="v3-trophy-foot"><span style="color:var(--success);font-weight:600">✨ Maxed out</span></div>'
          : `<div style="margin-top:10px">
               ${V3.bar(f.progress_pct, 'warning')}
               <div class="v3-trophy-foot">
                 <span>${f.next_tier.remaining_label} to ${esc(f.next_tier.label)}</span>
                 <span>${f.earned_count}/4 medals</span>
               </div>
             </div>`}
      </div>`).join('');
  },
});
