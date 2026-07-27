/* ─── Compare Sources View ──────────────────────────────────────────────────── */

const CompareView = {
  _from: null,
  _to: null,

  async init() {
    if (!this._from) {
      const now = new Date();
      const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
      this._from = `${y}-${m}-01`;
      const last = new Date(y, now.getMonth()+1, 0);
      this._to = `${y}-${m}-${String(last.getDate()).padStart(2,'0')}`;
    }
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-compare').innerHTML = `
      <div class="card" style="margin-bottom:14px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:600">Date range:</span>
          <input type="date" id="cmpFrom" class="form-control" style="width:150px" value="${this._from}" />
          <span style="color:var(--text-muted)">to</span>
          <input type="date" id="cmpTo" class="form-control" style="width:150px" value="${this._to}" />
          <button id="cmpLoadBtn" class="btn btn-primary" style="padding:6px 16px">Compare</button>
        </div>
      </div>
      <div id="cmpResult"></div>
    `;
    document.getElementById('cmpLoadBtn').addEventListener('click', async () => {
      this._from = document.getElementById('cmpFrom').value;
      this._to   = document.getElementById('cmpTo').value;
      await this.load();
    });
  },

  async load() {
    const result = document.getElementById('cmpResult');
    result.innerHTML = '<p style="color:var(--text-muted);padding:16px">Loading...</p>';
    try {
      const data = await API.compareSources(this._from, this._to);
      this._renderResult(data, result);
    } catch(e) {
      result.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  _sourceLabelMap: {
    'gemini':        'Gemini',
    'ollama-server': 'Ollama (server)',
    'ollama-remote': 'Ollama (remote)',
    'lmstudio':      'LM Studio',
    'tesseract':     'Tesseract',
    'manual':        'Manual',
  },

  _renderResult(data, el) {
    const { sources, rows } = data;

    if (!rows.length) {
      el.innerHTML = '<div class="card" style="padding:24px;text-align:center;color:var(--text-muted)">No shifts found in this date range.</div>';
      return;
    }

    const srcLabel = s => this._sourceLabelMap[s] || s;
    const counts = {};
    for (const s of sources) counts[s] = rows.filter(r => r.bySource[s]).length;
    const disagreeCount = rows.filter(r => r.disagrees).length;

    const summaryHtml = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
        ${sources.map(s => `
          <div class="card" style="padding:10px 14px;flex:1;min-width:120px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${srcLabel(s)}</div>
            <div style="font-size:20px;font-weight:700">${counts[s]}</div>
            <div style="font-size:11px;color:var(--text-muted)">entries</div>
          </div>`).join('')}
        ${disagreeCount > 0 ? `
          <div class="card" style="padding:10px 14px;flex:1;min-width:120px;text-align:center;border-left:3px solid #F59E0B">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Disagreements</div>
            <div style="font-size:20px;font-weight:700;color:#F59E0B">${disagreeCount}</div>
            <div style="font-size:11px;color:var(--text-muted)">entries differ</div>
          </div>` : `
          <div class="card" style="padding:10px 14px;flex:1;min-width:120px;text-align:center;border-left:3px solid #10B981">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Agreement</div>
            <div style="font-size:20px;font-weight:700;color:#10B981">100%</div>
            <div style="font-size:11px;color:var(--text-muted)">all match</div>
          </div>`}
      </div>`;

    const filterHtml = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-muted)">Show:</span>
        <button id="cmpFilterAll"  class="btn btn-primary" style="padding:3px 10px;font-size:12px" onclick="CompareView._setFilter('all')">All</button>
        <button id="cmpFilterDiff" class="btn btn-ghost"   style="padding:3px 10px;font-size:12px" onclick="CompareView._setFilter('diff')">Differences only</button>
      </div>`;

    const headerCells = sources.map(s =>
      `<th style="padding:8px 10px;font-size:12px;white-space:nowrap;background:var(--sidebar-bg);color:#fff">${srcLabel(s)}</th>`
    ).join('');

    const rowsHtml = rows.map(r => {
      const bg = r.disagrees ? 'background:rgba(245,158,11,0.08);' : '';
      const cells = sources.map(s => {
        const entries = r.bySource[s] || [];
        if (!entries.length) return `<td style="padding:8px 10px;font-size:12px;color:var(--text-muted);text-align:center">-</td>`;
        const e = entries[0];
        const val = e.shift_type === 'leave'   ? 'Leave'
                  : e.shift_type === 'all_day' ? 'All day'
                  : `${e.start_time}-${e.end_time}`;
        return `<td style="padding:8px 10px;font-size:12px">${val}</td>`;
      }).join('');
      const flag = r.disagrees ? `<td style="padding:8px 10px;font-size:11px;color:#F59E0B;white-space:nowrap">differs</td>` : '<td></td>';
      return `<tr class="cmp-row${r.disagrees ? ' cmp-diff' : ''}" style="${bg}border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px;font-size:12px;white-space:nowrap">${r.date}</td>
        <td style="padding:8px 10px;font-size:12px;font-weight:500">${r.name}</td>
        ${cells}${flag}
      </tr>`;
    }).join('');

    el.innerHTML = summaryHtml + filterHtml + `
      <div class="card" style="overflow-x:auto;padding:0">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="padding:8px 10px;text-align:left;background:var(--sidebar-bg);color:#fff;font-size:12px">Date</th>
              <th style="padding:8px 10px;text-align:left;background:var(--sidebar-bg);color:#fff;font-size:12px">Person</th>
              ${headerCells}
              <th style="background:var(--sidebar-bg)"></th>
            </tr>
          </thead>
          <tbody id="cmpTableBody">${rowsHtml}</tbody>
        </table>
      </div>`;

    this._currentFilter = 'all';
  },

  _currentFilter: 'all',
  _setFilter(f) {
    this._currentFilter = f;
    const allBtn  = document.getElementById('cmpFilterAll');
    const diffBtn = document.getElementById('cmpFilterDiff');
    if (allBtn)  allBtn.className  = `btn ${f === 'all'  ? 'btn-primary' : 'btn-ghost'}`;
    if (diffBtn) diffBtn.className = `btn ${f === 'diff' ? 'btn-primary' : 'btn-ghost'}`;
    document.querySelectorAll('#cmpTableBody .cmp-row').forEach(row => {
      row.style.display = (f === 'diff' && !row.classList.contains('cmp-diff')) ? 'none' : '';
    });
  }
};
