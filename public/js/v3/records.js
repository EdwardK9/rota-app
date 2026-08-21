/* ─── 📖 Record Book (V3.0) ────────────────────────────────────────────────
   Personal bests, plus the lifetime totals rendered with a few "what does that
   even mean" conversions — hours as solid days, miles as marathons.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('records', '📖 Record Book', {
  async init() {
    document.getElementById('view-records').innerHTML = V3.loading('Leafing through the record book…');
    try {
      this.render(await V3.api.records());
    } catch (e) {
      document.getElementById('view-records').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-records');

    if (!d.records.length) {
      el.innerHTML = V3.empty('📖', 'No records yet',
        'Complete a few shifts and your personal bests will start showing up here.');
      return;
    }

    const l = d.lifetime;

    el.innerHTML = `
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
        ${V3.tile('Tax & NI', fmtCurrency(l.tax_and_ni), 'Deducted to date', 'danger')}
        ${V3.tile('Miles driven', l.miles + ' mi', `${l.marathons} marathons`)}
        ${V3.tile('Leave taken', l.leave_days + ' days')}
        ${V3.tile('Colleagues',  l.colleagues, 'Shared a shift with')}
      </div>

      <div class="card">
        <div class="card-header"><h2>🥇 Personal bests</h2></div>
        <div class="card-body" style="padding:0">
          ${d.records.map(r => `
            <div class="v3-record">
              <div class="v3-record-icon">${r.icon}</div>
              <div class="v3-record-body">
                <div class="v3-record-title">${esc(r.title)}</div>
                <div class="v3-record-value">${esc(String(r.value))}</div>
              </div>
              <div class="v3-record-meta">
                ${r.sub ? `<div>${esc(r.sub)}</div>` : ''}
                ${r.date ? `<div>${fmtDate(r.date)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="v3-note">
        Records cover completed shifts only. "Shift pay" is what your logged hours are worth at the
        rate for each day; "gross paid" is what your payslips actually say — the two differ by
        bank-holiday uplifts, arrears and any extras that never appeared as a shift.
      </div>
    `;
  },
});
