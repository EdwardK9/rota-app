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

  RANGES: [
    [4, '4 weeks'], [8, '8 weeks'], [12, '12 weeks'], [26, '6 months'],
    [52, '1 year'], [104, '2 years'], [156, '3 years'], ['all', 'All time'],
  ],

  _picker() {
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Looking back:</label>
        <select id="balWeeks" style="width:auto">
          ${this.RANGES.map(([v, label]) =>
            `<option value="${v}" ${String(v) === String(this.weeks) ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  _wire() {
    const sel = document.getElementById('balWeeks');
    if (sel) sel.addEventListener('change', e => {
      this.weeks = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
      document.getElementById('view-balance').innerHTML = V3.loading();
      this.load();
    });
  },

  _formatValue(c) {
    if (c.value == null) return '—';
    return this._threshold(c, c.value);
  },

  /** Formats a raw number in the units of that component. */
  _threshold(c, n) {
    if (c.key === 'rest_days')    return `${n} days/week`;
    if (c.key === 'weekends_off') return `${n}%`;
    if (c.key === 'turnaround')   return `${n}h`;
    if (c.key === 'breaks')       return `${n}%`;
    return `${n} days`;
  },

  _rangeLabel(d) {
    if (this.weeks === 'all') return 'ALL TIME';
    const found = this.RANGES.find(([v]) => String(v) === String(this.weeks));
    return 'LAST ' + (found ? found[1] : d.range.weeks + ' weeks').toUpperCase();
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
        <div class="v3-hero-label">WORK-LIFE BALANCE · ${esc(this._rangeLabel(d))}</div>
        <div class="v3-hero-value">${d.score}<span style="font-size:22px;opacity:0.7">/100</span></div>
        <div class="v3-hero-sub">${v.icon} <strong>${esc(v.label)}</strong> — ${esc(v.note)}</div>
        <div class="v3-hero-bar"><span style="width:${d.score}%"></span></div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="card-header"><h2>❓ What this score actually measures</h2></div>
        <div class="card-body">
          <p style="font-size:13px;line-height:1.6;margin-bottom:12px">
            It is <strong>not</strong> about how hard you work or how much you earn — it only asks
            one question: <em>how much genuine recovery time did this rota leave you?</em>
            ${esc(d.how_it_works.summary)}
          </p>
          <div class="table-wrapper" style="margin-bottom:12px">
            <table>
              <thead><tr><th>Measure</th><th>What it looks at</th><th>Full marks</th><th>Zero</th><th>Weight</th></tr></thead>
              <tbody>
                ${d.components.map(c => `
                  <tr>
                    <td><strong>${c.icon} ${esc(c.label)}</strong></td>
                    <td class="v3-muted">${esc(c.desc)}</td>
                    <td>${this._threshold(c, c.ideal)}</td>
                    <td>${this._threshold(c, c.worst)}</td>
                    <td>${c.weight}%</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            ${d.scale.slice().reverse().map(sc => `
              <span class="badge ${d.score >= sc.min && (d.verdict.label === sc.label) ? 'badge-info' : 'badge-muted'}">
                ${sc.icon} ${esc(sc.label)} ${sc.min}+
              </span>`).join('')}
          </div>
          <div class="v3-note">${esc(d.how_it_works.note)}</div>
        </div>
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
          <div class="card-header">
            <h2>📈 Hours per ${d.range.grouping} vs contract</h2>
          </div>
          <div class="card-body">
            ${V3.chart(
              d.trend.map(w => ({
                label: d.range.grouping === 'month'
                  ? V3.shortMonth(w.period)
                  : V3.shortMonth(w.period.slice(0, 7)).slice(0, 3) + ' ' + w.period.slice(8),
                value: w.hours,
                title: `${d.range.grouping === 'month' ? w.period : 'Week of ' + w.period}: ` +
                       `${w.hours}h across ${w.shifts} shifts on ${w.days_worked} days` +
                       (w.contracted ? ` (contracted ${w.contracted}h)` : ''),
                over: w.contracted ? w.hours > w.contracted : false,
              })),
              pt => (pt.over ? 'warning' : 'success')
            )}
            <div class="v3-note">
              Amber bars are above your contracted hours for that ${d.range.grouping}, green at or
              below. A run of amber isn't automatically bad — it's extra pay — but it's usually
              what drags the rest days and turnaround scores down.
              ${d.range.grouping === 'month'
                ? ' Ranges over six months group by month so the chart stays readable.' : ''}
            </div>
          </div>
        </div>
      </div>
    `;

    this._wire();
  },
});
