/* ─── 📈 Pay Rise History (V3.0) ───────────────────────────────────────────
   Every rate change as a timeline, with what each was worth and how you sit
   against the National Living Wage.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('pay-rises', '📈 Pay Rise History', {
  async init() {
    document.getElementById('view-pay-rises').innerHTML = V3.loading('Reading the pay history…');
    try {
      this.render(await V3.api.payRises());
    } catch (e) {
      document.getElementById('view-pay-rises').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-pay-rises');

    if (!d.rises.length) {
      el.innerHTML = V3.empty('📈', 'No pay rates recorded',
        'Add your pay rates in Settings and this fills in automatically.');
      return;
    }

    const s = d.summary;
    // A year with no rise is worth flagging — this is the "am I due one?" number
    const overdue = s.days_since_last_rise > 400;

    el.innerHTML = `
      <div class="v3-hero" style="background:linear-gradient(135deg,#10B981,#065F46)">
        <div class="v3-hero-label">CURRENT RATE</div>
        <div class="v3-hero-value">${fmtCurrency(s.current_rate)}<span style="font-size:20px;opacity:0.75">/hr</span></div>
        <div class="v3-hero-sub">
          up ${fmtCurrency(s.total_change)} (${s.total_change_pct}%) from ${fmtCurrency(s.first_rate)} when you started ·
          ${s.rise_count} rise${s.rise_count === 1 ? '' : 's'} so far
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Since last rise', `${s.months_since_last_rise} mo`,
          fmtDate(s.last_rise_date), overdue ? 'warning' : '')}
        ${V3.tile('Average rise', s.avg_rise_pct + '%',
          s.avg_gap_days ? `every ~${Math.round(s.avg_gap_days / 30.44)} months` : '')}
        ${s.above_nlw != null
          ? V3.tile('Above minimum wage', fmtCurrency(s.above_nlw),
              `${s.above_nlw_pct}% over the ${fmtCurrency(s.nlw_now)} NLW`,
              s.above_nlw <= 0 ? 'danger' : s.above_nlw < 0.5 ? 'warning' : 'success')
          : V3.tile('Above minimum wage', '—')}
        ${V3.tile('Rises have earned you', fmtCurrency(s.cumulative_benefit),
          'vs staying on your first rate', 'success')}
      </div>

      ${overdue ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-body" style="display:flex;align-items:center;gap:12px">
            <div style="font-size:26px">⏳</div>
            <div>
              <strong>It has been ${s.months_since_last_rise} months since your last rise.</strong>
              <div class="v3-muted" style="margin-top:3px">
                Your average gap is about ${s.avg_gap_days ? Math.round(s.avg_gap_days / 30.44) : '—'} months.
                Worth a conversation, or at least worth knowing.
              </div>
            </div>
          </div>
        </div>` : ''}

      <div class="v3-section-title">🕰️ The timeline</div>
      <div class="card">
        <div class="card-body" style="padding:0">
          ${d.rises.slice().reverse().map(r => `
            <div class="v3-record">
              <div class="v3-record-icon">${r.is_first ? '🌱' : r.rate_changed ? (r.change > 0 ? '📈' : '📉') : '📋'}</div>
              <div class="v3-record-body">
                <div class="v3-record-value">
                  ${fmtCurrency(r.hourly_rate)}/hr
                  ${r.current ? '<span class="badge badge-success" style="margin-left:6px">current</span>' : ''}
                </div>
                <div class="v3-record-title">
                  From ${fmtDate(r.effective_date)}${r.until ? ` to ${fmtDate(r.until)}` : ''}
                  · ${r.contracted_hours}h/week contract
                  ${r.hours_changed ? ` <span class="badge badge-info">${r.hours_change > 0 ? '+' : ''}${r.hours_change}h contract</span>` : ''}
                </div>
                ${r.notes ? `<div class="v3-muted" style="margin-top:3px">${esc(r.notes)}</div>` : ''}
              </div>
              <div class="v3-record-meta">
                ${r.is_first ? '<div>Starting rate</div>'
                  : r.rate_changed ? `
                    <div class="${r.change > 0 ? 'diff-pos' : 'diff-neg'}" style="font-size:14px">
                      ${r.change > 0 ? '+' : ''}${fmtCurrency(r.change)} (${r.change_pct > 0 ? '+' : ''}${r.change_pct}%)
                    </div>
                    <div>${r.weekly_value != null ? (r.weekly_value >= 0 ? '+' : '') + fmtCurrency(r.weekly_value) + '/week' : ''}</div>
                    ${r.days_since_previous ? `<div>${Math.round(r.days_since_previous / 30.44)} mo after the last</div>` : ''}`
                  : '<div>Contract change only</div>'}
                ${r.above_nlw != null ? `
                  <div style="margin-top:3px" class="${r.above_nlw <= 0 ? 'diff-neg' : ''}">
                    ${r.above_nlw >= 0 ? '+' : ''}${fmtCurrency(r.above_nlw)} vs NLW
                  </div>` : ''}
                ${r.worked.shifts ? `<div>${r.worked.shifts} shifts · ${fmtCurrency(r.worked.pay)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="v3-note">
        "Rises have earned you" compares what you were actually paid against what the same hours
        would have paid at your original ${fmtCurrency(s.first_rate)}/hr.
        <br><br>
        The National Living Wage comparison is the one that matters most for hourly retail work —
        a rise that only matches the legal minimum is not really a rise. Figures are the published
        UK rates; override any of them in Settings with a <code>v3_nlw_&lt;year&gt;</code> key.
      </div>
    `;
  },
});
