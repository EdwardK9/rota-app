/* ─── 🥊 Head to Head (V3.0) ───────────────────────────────────────────────
   You against one colleague, measured like for like. Reuses the Shift DNA
   people list so there is one source of who can be compared.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('head-to-head', '🥊 Head to Head', {
  year: getCurrentYear(),
  colleague: null,
  people: null,

  async init() {
    document.getElementById('view-head-to-head').innerHTML = V3.loading('Finding an opponent…');
    try {
      this.people = (await V3.api.dnaPeople()).people.filter(p => p.id !== 'me');
    } catch (e) {
      document.getElementById('view-head-to-head').innerHTML = V3.error(e);
      return;
    }
    if (!this.people.length) {
      document.getElementById('view-head-to-head').innerHTML = V3.empty('🥊', 'Nobody to compare against',
        'Import some team shifts and colleagues will show up here.');
      return;
    }
    if (!this.colleague) this.colleague = this.people[0].id;
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.headToHead(this.colleague, this.year));
    } catch (e) {
      document.getElementById('view-head-to-head').innerHTML = V3.error(e);
    }
  },

  _toolbar() {
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Versus:</label>
        <select id="h2hPerson" style="width:auto">
          ${this.people.map(p => `<option value="${esc(p.id)}" ${p.id === this.colleague ? 'selected' : ''}>
            ${esc(p.name)}${p.left ? ' (left)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
        <select id="h2hYear" style="width:auto">
          <option value="all" ${this.year === 'all' ? 'selected' : ''}>All time</option>
          ${getYears().map(y => `<option value="${y}" ${String(y) === String(this.year) ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  _wire() {
    const p = document.getElementById('h2hPerson');
    if (p) p.addEventListener('change', e => { this.colleague = e.target.value; this.load(); });
    const y = document.getElementById('h2hYear');
    if (y) y.addEventListener('change', e => { this.year = e.target.value; this.load(); });
  },

  row(r) {
    const total = (Number(r.mine) || 0) + (Number(r.theirs) || 0);
    const minePct = total > 0 ? (Number(r.mine) / total) * 100 : 50;
    const unit = r.unit || '';
    return `
      <div class="v3-h2h-row">
        <div class="v3-h2h-label">${r.icon} ${esc(r.label)}</div>
        <div class="v3-h2h-bars">
          <div class="v3-h2h-value ${r.leader === 'me' ? 'winner' : ''}">${r.mine}${unit}</div>
          <div class="v3-h2h-track">
            <div class="v3-h2h-fill mine" style="width:${minePct}%"></div>
            <div class="v3-h2h-fill theirs" style="width:${100 - minePct}%"></div>
          </div>
          <div class="v3-h2h-value ${r.leader === 'them' ? 'winner' : ''}">${r.theirs}${unit}</div>
        </div>
      </div>`;
  },

  render(d) {
    const el = document.getElementById('view-head-to-head');
    const t = d.tally;

    el.innerHTML = `
      ${this._toolbar()}

      <div class="v3-hero" style="background:linear-gradient(135deg,#6366F1,#312E81)">
        <div class="v3-hero-label">YOU VS ${esc(d.colleague.name).toUpperCase()}</div>
        <div class="v3-hero-value">${t.mine} – ${t.theirs}</div>
        <div class="v3-hero-sub">
          across ${d.rows.length} measures${t.ties ? `, ${t.ties} tied` : ''} ·
          you've shared <strong>${d.together.shifts} shifts</strong> and
          ${d.together.hours}h on the floor together
          ${d.together.last_together ? ` · last on ${fmtDate(d.together.last_together)}` : ''}
        </div>
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>📊 Measure by measure</h2></div>
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:12px">
              <span>◀ You</span><span>${esc(d.colleague.name)} ▶</span>
            </div>
            ${d.rows.map(r => this.row(r)).join('')}
            ${d.time_rows.map(r => `
              <div class="v3-h2h-row">
                <div class="v3-h2h-label">${r.icon} ${esc(r.label)}</div>
                <div class="v3-h2h-bars">
                  <div class="v3-h2h-value ${r.leader === 'me' ? 'winner' : ''}">${esc(r.mine)}</div>
                  <div class="v3-h2h-track"><div class="v3-h2h-fill mine" style="width:50%"></div><div class="v3-h2h-fill theirs" style="width:50%"></div></div>
                  <div class="v3-h2h-value ${r.leader === 'them' ? 'winner' : ''}">${esc(r.theirs)}</div>
                </div>
              </div>`).join('')}
            <div class="v3-note">${esc(d.note)}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>📅 Who works which days</h2></div>
          <div class="card-body">
            ${d.by_dow.map(x => {
              const total = x.mine + x.theirs;
              const pct = total > 0 ? (x.mine / total) * 100 : 50;
              return `
                <div class="v3-h2h-row">
                  <div class="v3-h2h-label">${esc(x.short)}</div>
                  <div class="v3-h2h-bars">
                    <div class="v3-h2h-value">${x.mine}</div>
                    <div class="v3-h2h-track">
                      <div class="v3-h2h-fill mine" style="width:${pct}%"></div>
                      <div class="v3-h2h-fill theirs" style="width:${100 - pct}%"></div>
                    </div>
                    <div class="v3-h2h-value">${x.theirs}</div>
                  </div>
                </div>`;
            }).join('')}

            <div class="v3-section-title">🤝 Time together</div>
            <div class="v3-grid v3-grid-sm">
              ${V3.tile('Shared shifts', d.together.shifts)}
              ${V3.tile('Hours together', d.together.hours + 'h')}
              ${V3.tile('Of your shifts', d.together.pct_of_my_shifts + '%')}
              ${V3.tile('Of theirs', d.together.pct_of_their_shifts + '%')}
            </div>
          </div>
        </div>
      </div>
    `;

    this._wire();
  },
});
