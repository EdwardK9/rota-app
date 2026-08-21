/* ─── Shift Heatmap View (V2.0) ───────────────────────────────────────────────
   GitHub-contributions-style year grid: one cell per day, coloured by hours
   worked that day; leave days shown in a distinct colour. ───────────────────── */

const ShiftHeatmapView = {
  year: new Date().getFullYear(),
  days: {},

  async init() {
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-shift-heatmap');
    el.innerHTML = `
      ${v2BackButton()}
      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="hmPrevYear">‹</button>
          <span id="hmYearLabel" style="font-weight:600;padding:0 8px">${this.year}</span>
          <button class="btn btn-ghost btn-sm" id="hmNextYear">›</button>
        </div>
        <div class="toolbar-right" id="hmStats" style="font-size:13px;color:var(--text-muted)"></div>
      </div>
      <div class="card">
        <div class="card-body" style="overflow-x:auto">
          <div id="hmGrid"></div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:16px;font-size:11px;color:var(--text-muted);flex-wrap:wrap">
            <span>Less</span>
            <span class="hm-legend-cell" style="display:inline-block;width:13px;height:13px;border-radius:2px;background:var(--border)"></span>
            <span class="hm-legend-cell" style="display:inline-block;width:13px;height:13px;border-radius:2px;background:rgba(91,157,255,.3)"></span>
            <span class="hm-legend-cell" style="display:inline-block;width:13px;height:13px;border-radius:2px;background:rgba(91,157,255,.55)"></span>
            <span class="hm-legend-cell" style="display:inline-block;width:13px;height:13px;border-radius:2px;background:rgba(91,157,255,.8)"></span>
            <span class="hm-legend-cell" style="display:inline-block;width:13px;height:13px;border-radius:2px;background:rgba(91,157,255,1)"></span>
            <span>More</span>
            <span style="margin-left:14px;display:inline-flex;align-items:center;gap:5px">
              <span style="display:inline-block;width:13px;height:13px;border-radius:2px;background:rgba(16,185,129,.55)"></span> Leave
            </span>
          </div>
        </div>
      </div>
    `;
    document.getElementById('hmPrevYear').addEventListener('click', () => { this.year--; this.load(); });
    document.getElementById('hmNextYear').addEventListener('click', () => { this.year++; this.load(); });
  },

  async load() {
    document.getElementById('hmYearLabel').textContent = this.year;
    try {
      const result = await API.getShiftHeatmap(this.year);
      this.days = result.days || {};
      this.renderGrid();
      this.renderStats();
    } catch (e) {
      showToast('Failed to load heatmap: ' + e.message, 'error');
    }
  },

  renderStats() {
    const entries = Object.values(this.days);
    const workedDays = entries.filter(d => d.type === 'worked').length;
    const leaveDays  = entries.filter(d => d.type === 'leave').length;
    const totalHours = entries.reduce((sum, d) => sum + (d.hours || 0), 0);
    document.getElementById('hmStats').textContent =
      `${workedDays} days worked · ${fmtHours(totalHours)} total · ${leaveDays} leave days`;
  },

  _bucketColor(d) {
    if (!d) return 'var(--border)';
    if (d.type === 'leave') return 'rgba(16,185,129,.55)';
    const h = d.hours || 0;
    if (h <= 0) return 'var(--border)';
    if (h < 4)  return 'rgba(91,157,255,.3)';
    if (h < 6)  return 'rgba(91,157,255,.55)';
    if (h < 8)  return 'rgba(91,157,255,.8)';
    return 'rgba(91,157,255,1)';
  },

  renderGrid() {
    const grid = document.getElementById('hmGrid');
    const year = this.year;

    const jan1 = new Date(year, 0, 1);
    const gridStart = new Date(jan1);
    gridStart.setDate(jan1.getDate() - jan1.getDay()); // back up to the preceding Sunday

    const dec31 = new Date(year, 11, 31);
    const gridEnd = new Date(dec31);
    gridEnd.setDate(dec31.getDate() + (6 - dec31.getDay())); // forward to the following Saturday

    const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
    const weeks = totalDays / 7;

    const monthLabels = [];
    let lastMonth = -1;
    let cellsHtml = '';
    const cur = new Date(gridStart);

    for (let i = 0; i < totalDays; i++) {
      const inYear = cur.getFullYear() === year;
      const dateStr = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;

      if (inYear && cur.getDay() === 0 && cur.getMonth() !== lastMonth) {
        lastMonth = cur.getMonth();
        monthLabels.push({ col: Math.floor(i / 7) + 1, label: cur.toLocaleDateString('en-GB', { month: 'short' }) });
      }

      const d     = inYear ? this.days[dateStr] : null;
      const color = inYear ? this._bucketColor(d) : 'transparent';
      const title = inYear
        ? `${dateStr}${d ? (d.type === 'leave' ? ' · Leave' : ' · ' + fmtHours(d.hours || 0)) : ' · No shift'}`
        : '';

      cellsHtml += `<div title="${esc(title)}" style="width:13px;height:13px;border-radius:2px;background:${color}"></div>`;
      cur.setDate(cur.getDate() + 1);
    }

    const labelsHtml = monthLabels
      .map(m => `<div style="grid-column:${m.col};white-space:nowrap">${m.label}</div>`)
      .join('');

    grid.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(${weeks}, 13px);gap:3px;font-size:10px;color:var(--text-muted);height:14px;margin-bottom:4px;min-width:${weeks * 16}px">
        ${labelsHtml}
      </div>
      <div style="display:grid;grid-template-columns:repeat(${weeks}, 13px);grid-auto-flow:column;grid-template-rows:repeat(7, 13px);gap:3px;min-width:${weeks * 16}px">
        ${cellsHtml}
      </div>
    `;
  },
};
