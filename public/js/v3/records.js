/* ─── 📖 Record Book (V3.0) ────────────────────────────────────────────────
   Personal bests grouped into sections. Records shared by more than one shift
   show a "×N" badge and expand to list every date that ties it — a 7.5h shift
   isn't a one-off, and pretending one date owns the record is misleading.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('records', '📖 Record Book', {
  data: null,
  open: {},   // record title -> expanded?

  async init() {
    document.getElementById('view-records').innerHTML = V3.loading('Leafing through the record book…');
    try {
      this.data = await V3.api.records();
      this.render();
    } catch (e) {
      document.getElementById('view-records').innerHTML = V3.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-records');

    if (!d.records.length) {
      el.innerHTML = V3.empty('📖', 'No records yet',
        'Log a few shifts and your personal bests will start showing up here.');
      return;
    }

    const l = d.lifetime;

    el.innerHTML = `
      ${V3.backButton()}
      <div class="v3-hero" style="background:linear-gradient(135deg,#8B5CF6,#4C1D95)">
        <div class="v3-hero-label">CAREER TOTALS</div>
        <div class="v3-hero-value">${l.hours}h</div>
        <div class="v3-hero-sub">
          across ${l.shifts} shifts${l.days_employed ? ` and ${l.days_employed} days at the job` : ''} —
          about ${l.days_solid} solid days on the clock, or ${l.full_weeks} full-time weeks.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Shift pay',   fmtCurrency(l.pay), 'From logged shifts')}
        ${V3.tile('Gross paid',  fmtCurrency(l.gross), 'From payslips')}
        ${V3.tile('Tax & NI',    fmtCurrency(l.tax_and_ni), 'Deducted to date', 'danger')}
        ${V3.tile('Miles driven', l.miles + ' mi', `${l.marathons} marathons`)}
        ${V3.tile('Bank holidays', l.bank_holidays, 'Worked')}
        ${V3.tile('Colleagues',  l.colleagues, 'Shared a shift with')}
      </div>

      ${d.groups.map(g => {
        const rows = d.records.filter(r => r.group === g.key);
        if (!rows.length) return '';
        return `
          <div class="v3-section-title">${g.label}</div>
          <div class="card" style="margin-bottom:18px">
            <div class="card-body" style="padding:0">
              ${rows.map(r => this.row(r)).join('')}
            </div>
          </div>`;
      }).join('')}

      <div class="v3-note">
        Records cover every shift logged up to today, whether or not you ticked it complete.
        A <strong>×N</strong> badge means N shifts share that record — tap the row to see them all.
        Clock records come from your actual clock-ins, so they can differ from the rota.
      </div>
    `;

    el.querySelectorAll('[data-expand]').forEach(row => {
      row.addEventListener('click', () => {
        const key = row.dataset.expand;
        this.open[key] = !this.open[key];
        const list = el.querySelector(`[data-list="${CSS.escape(key)}"]`);
        const chev = row.querySelector('.v3-record-chev');
        if (list) list.classList.toggle('hidden', !this.open[key]);
        if (chev) chev.textContent = this.open[key] ? '▾' : '▸';
      });
    });
  },

  row(r) {
    const expandable = r.count > 1;
    const key = r.title;
    return `
      <div class="v3-record${expandable ? ' expandable' : ''}" ${expandable ? `data-expand="${esc(key)}"` : ''}>
        <div class="v3-record-icon">${r.icon}</div>
        <div class="v3-record-body">
          <div class="v3-record-title">
            ${esc(r.title)}
            ${expandable ? `<span class="v3-count-badge">×${r.count}</span>` : ''}
          </div>
          <div class="v3-record-value">${esc(String(r.value))}</div>
        </div>
        <div class="v3-record-meta">
          ${r.sub ? `<div>${esc(r.sub)}</div>` : ''}
          ${r.date ? `<div>${fmtDate(r.date)}</div>` : ''}
        </div>
        ${expandable ? `<div class="v3-record-chev">${this.open[key] ? '▾' : '▸'}</div>` : ''}
      </div>
      ${expandable ? `
        <div class="v3-record-list ${this.open[key] ? '' : 'hidden'}" data-list="${esc(key)}">
          ${r.matches.map(m => `
            <div class="v3-record-list-item">
              <span>${esc(m.day)} ${fmtDate(m.date)}</span>
              <span class="v3-muted">${esc(m.detail || '')}</span>
            </div>`).join('')}
          ${r.count > r.matches.length
            ? `<div class="v3-record-list-item v3-muted">…and ${r.count - r.matches.length} more</div>` : ''}
        </div>` : ''}
    `;
  },
});
