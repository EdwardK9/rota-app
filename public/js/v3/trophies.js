/* ─── 🏆 Trophy Cabinet (V3.0) ─────────────────────────────────────────────
   Achievement grid with a filter across earned/locked and a per-tier tally.
   Locked trophies keep their progress bar so it's obvious how close each one
   is rather than just being greyed out.
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

    const tierChips = d.by_tier.map(t => `
      <span class="v3-tier-chip ${t.tier}" title="${t.earned} of ${t.total} ${t.tier} trophies earned">
        ${t.tier} ${t.earned}/${t.total}
      </span>`).join(' ');

    const nextUp = d.trophies.filter(t => !t.earned).slice(0, 3);

    el.innerHTML = `
      <div class="v3-hero" style="background:linear-gradient(135deg,#F59E0B,#92400E)">
        <div class="v3-hero-label">TROPHY CABINET</div>
        <div class="v3-hero-value">${d.earned_count} / ${d.total_count}</div>
        <div class="v3-hero-sub">${d.completion_pct}% complete · ${tierChips}</div>
        <div class="v3-hero-bar"><span style="width:${d.completion_pct}%"></span></div>
      </div>

      ${nextUp.length ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-header"><h2>🎯 Closest to unlocking</h2></div>
          <div class="card-body">
            ${nextUp.map(t => `
              <div style="margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
                  <span>${t.icon} <strong>${esc(t.name)}</strong> — ${esc(t.desc)}</span>
                  <span style="white-space:nowrap;margin-left:12px">${t.value} / ${t.need}</span>
                </div>
                ${V3.bar(t.progress_pct, 'warning')}
              </div>`).join('')}
          </div>
        </div>` : ''}

      <div class="toolbar">
        <div class="radio-group" id="trophyFilter">
          ${[['all', 'All'], ['earned', 'Earned'], ['locked', 'Locked']].map(([v, label]) => `
            <label class="radio-label">
              <input type="radio" name="trophyFilter" value="${v}" ${this.filter === v ? 'checked' : ''}> ${label}
            </label>`).join('')}
        </div>
      </div>

      <div class="v3-grid" id="trophyGrid">${this.cards()}</div>

      <div class="v3-note">
        Trophies unlock automatically from your logged shifts, clock-ins, payslips and colleagues —
        there is nothing to claim. Once earned, a trophy stays earned even if the underlying
        number later changes.
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
    const list = this.data.trophies.filter(t =>
      this.filter === 'all' || (this.filter === 'earned' ? t.earned : !t.earned));

    if (!list.length) return V3.empty('🏆', 'Nothing here yet', 'Try a different filter.');

    return list.map(t => `
      <div class="v3-trophy ${t.earned ? 'earned ' + t.tier : 'locked'}">
        <div class="v3-trophy-icon">${t.earned ? t.icon : '🔒'}</div>
        <div class="v3-trophy-name">${esc(t.name)}</div>
        <div class="v3-trophy-desc">${esc(t.desc)}</div>
        ${t.earned ? '' : V3.bar(t.progress_pct, 'warning')}
        <div class="v3-trophy-foot">
          <span class="v3-tier-chip ${t.tier}">${t.tier}</span>
          <span>${t.earned
            ? (t.unlocked_at ? 'Unlocked ' + fmtDate(String(t.unlocked_at).slice(0, 10)) : 'Unlocked')
            : `${t.value} / ${t.need}`}</span>
        </div>
      </div>`).join('');
  },
});
