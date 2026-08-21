/* ─── ⚖️ Work-Life Balance (V3.0) ──────────────────────────────────────────
   One sustainability score with its five components shown separately, plus the
   week-by-week hours trend against your contract.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('balance', '⚖️ Work-Life Balance', {
  weeks: 12,

  async init() {
    document.getElementById('view-balance').innerHTML = V3.loading('Weighing things up…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.balance(this.weeks));
    } catch (e) {
      document.getElementById('view-balance').innerHTML = V3.error(e);
    }
  },

  _picker() {
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Looking back:</label>
        <select id="balWeeks" style="width:auto">
          ${[4, 8, 12, 26, 52].map(w => `<option value="${w}" ${w === this.weeks ? 'selected' : ''}>${w} weeks</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  _wire() {
    const sel = document.getElementById('balWeeks');
    if (sel) sel.addEventListener('change', e => {
      this.weeks = parseInt(e.target.value, 10);
      document.getElementById('view-balance').innerHTML = V3.loading();
      this.load();
    });
  },

  _formatValue(c) {
    if (c.value == null) return '—';
    if (c.key === 'rest_days')    return `${c.value} days/week`;
    if (c.key === 'weekends_off') return `${c.value}%`;
    if (c.key === 'turnaround')   return `${c.value}h`;
    if (c.key === 'breaks')       return `${c.value}%`;
    return `${c.value} days`;
  },

  render(d) {
    const el = document.getElementById('view-balance');

    if (!d.shift_count) {
      el.innerHTML = this._picker() + V3.empty('⚖️', 'No shifts in this window',
        'Try looking back further, or log a few shifts first.');
      this._wire();
      return;
    }

    const v = d.verdict;
    const gradient = d.score >= 70 ? 'linear-gradient(135deg,#10B981,#065F46)'
      : d.score >= 55 ? 'linear-gradient(135deg,#F59E0B,#92400E)'
      : 'linear-gradient(135deg,#EF4444,#7F1D1D)';

    el.innerHTML = `
      ${this._picker()}

      <div class="v3-hero" style="background:${gradient}">
        <div class="v3-hero-label">WORK-LIFE BALANCE · LAST ${d.range.weeks} WEEKS</div>
        <div class="v3-hero-value">${d.score}<span style="font-size:22px;opacity:0.7">/100</span></div>
        <div class="v3-hero-sub">${v.icon} <strong>${esc(v.label)}</strong> — ${esc(v.note)}</div>
        <div class="v3-hero-bar"><span style="width:${d.score}%"></span></div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Days worked', `${d.days_worked} / ${d.total_days}`, 'In this window')}
        ${V3.tile('Shifts', d.shift_count)}
        ${V3.tile('Weakest link', d.weakest_link ? esc(d.weakest_link.label) : '—',
                  d.weakest_link ? `scored ${d.weakest_link.score}` : '')}
        ${d.shortest_turnaround
          ? V3.tile('Tightest turnaround', d.shortest_turnaround.hours + 'h',
              `${fmtDate(d.shortest_turnaround.from_date)} ${d.shortest_turnaround.finished} → ${d.shortest_turnaround.started}`)
          : V3.tile('Tightest turnaround', '—')}
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>🧩 What makes up the score</h2></div>
          <div class="card-body">
            ${d.components.map(c => `
              <div class="v3-trait" title="${esc(c.desc)}">
                <div class="v3-trait-head">
                  <span>${c.icon} ${esc(c.label)} <span class="v3-muted">· ${c.weight}% of score</span></span>
                  <span class="v3-trait-score">${this._formatValue(c)}</span>
                </div>
                ${c.score == null
                  ? '<div class="v3-muted">Not enough data — its weight is shared across the others.</div>'
                  : V3.bar(c.score, c.score >= 70 ? 'success' : c.score >= 40 ? 'warning' : 'danger')}
              </div>`).join('')}
            <div class="v3-note">
              This is a slow-moving trend, deliberately different from the Fatigue Audit — that one
              flags specific risky patterns in a single week, this one asks whether the last few
              months were sustainable overall.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>📈 Hours per week vs contract</h2></div>
          <div class="card-body">
            ${V3.chart(
              d.trend.map(w => ({
                label: V3.shortMonth(w.week.slice(0, 7)).slice(0, 3) + ' ' + w.week.slice(8),
                value: w.hours,
                title: `Week of ${w.week}: ${w.hours}h across ${w.shifts} shifts on ${w.days_worked} days` +
                       (w.contracted ? ` (contracted ${w.contracted}h)` : ''),
                over: w.contracted ? w.hours > w.contracted : false,
              })),
              pt => (pt.over ? 'warning' : 'success')
            )}
            <div class="v3-note">
              Amber weeks are above your contracted hours, green at or below. A run of amber isn't
              automatically bad — it's extra pay — but it's the thing that usually drags the rest
              days and turnaround scores down.
            </div>
          </div>
        </div>
      </div>
    `;

    this._wire();
  },
});
