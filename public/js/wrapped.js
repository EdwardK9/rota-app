/* ─── Rota Wrapped (V2.0) ──────────────────────────────────────────────────
   A year-end recap, Spotify-Wrapped-style — big reveal cards built entirely
   from data already tracked (shifts, payslips, colleague_shifts). Nothing new
   to enter, just a fun lens on the year.
   ───────────────────────────────────────────────────────────────────────── */

const WrappedView = {
  year: getCurrentYear(),

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-wrapped').innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
          <select id="wrYearSelect" style="width:auto">
            ${getYears().map(y => `<option value="${y}" ${y == this.year ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="wrappedContent">
        <div style="text-align:center;padding:40px;color:var(--text-muted)">Crunching the numbers…</div>
      </div>
    `;
    document.getElementById('wrYearSelect').addEventListener('change', e => {
      this.year = e.target.value;
      this.load();
    });
  },

  async load() {
    const el = document.getElementById('wrappedContent');
    try {
      const d = await API.getWrapped(this.year);
      this.renderReveal(d);
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);padding:20px">Failed to load: ${esc(e.message)}</p>`;
    }
  },

  _slide(gradient, big, label, sub) {
    return `
      <div class="wrapped-slide" style="background:${gradient}">
        <div class="wrapped-big">${big}</div>
        <div class="wrapped-label">${label}</div>
        ${sub ? `<div class="wrapped-sub">${sub}</div>` : ''}
      </div>`;
  },

  renderReveal(d) {
    const el = document.getElementById('wrappedContent');

    if (!d.totalShifts) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎁</div>
          <div class="empty-state-text">No completed shifts for ${this.year} yet</div>
          <div class="empty-state-sub">Come back once you've logged some shifts this year.</div>
        </div>`;
      return;
    }

    const marathons  = d.totalMiles > 0 ? Math.round((d.totalMiles / 26.2) * 10) / 10 : 0;
    const daysNonStop = d.totalHours > 0 ? Math.round((d.totalHours / 24) * 10) / 10 : 0;
    const busiestLabel = d.busiestMonth
      ? new Date(d.busiestMonth.month + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'long' })
      : null;

    const slides = [];

    slides.push(this._slide(
      'linear-gradient(135deg,#3B82F6,#1B2A4A)',
      `${d.totalHours}h`,
      `worked across ${d.totalShifts} shift${d.totalShifts !== 1 ? 's' : ''} in ${d.year}`,
      daysNonStop > 0 ? `That's about ${daysNonStop} days, non-stop.` : null
    ));

    if (d.totalGross > 0) {
      slides.push(this._slide(
        'linear-gradient(135deg,#10B981,#065F46)',
        fmtCurrency(d.totalGross),
        'gross pay this year',
        (d.totalTax + d.totalNI) > 0 ? `£${(d.totalTax + d.totalNI).toFixed(2)} of that went to tax &amp; NI.` : null
      ));
    }

    if (busiestLabel) {
      slides.push(this._slide(
        'linear-gradient(135deg,#F59E0B,#92400E)',
        busiestLabel,
        'was your busiest month',
        `${d.busiestMonth.hours}h worked — your biggest stretch of the year.`
      ));
    }

    if (d.mostWorkedWith) {
      slides.push(this._slide(
        'linear-gradient(135deg,#EC4899,#831843)',
        esc(d.mostWorkedWith.name),
        'was your most-worked-with colleague',
        `${d.mostWorkedWith.shifts} shift${d.mostWorkedWith.shifts !== 1 ? 's' : ''} together, ~${d.mostWorkedWith.hours}h side by side.`
      ));
    }

    if (d.totalMiles > 0) {
      slides.push(this._slide(
        'linear-gradient(135deg,#8B5CF6,#4C1D95)',
        `${d.totalMiles} mi`,
        'driven to work this year',
        marathons > 0 ? `That's about ${marathons} marathons of driving.` : null
      ));
    }

    el.innerHTML = `<div class="wrapped-grid">${slides.join('')}</div>`;
  },
};
