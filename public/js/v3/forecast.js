/* ─── 🔮 Pay Forecast (V3.0) ───────────────────────────────────────────────
   Where the tax year is heading. Shows the build-up from banked payslips →
   worked-but-unpaid shifts → booked rota → the projected remainder, so it's
   obvious how much of the number is fact and how much is extrapolation.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('forecast', '🔮 Pay Forecast', {
  taxYear: null,
  basis: 'contracted',   // how to price the weeks after your rota runs out

  async init() {
    document.getElementById('view-forecast').innerHTML = V3.loading('Consulting the crystal ball…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.forecast(this.taxYear, this.basis));
    } catch (e) {
      document.getElementById('view-forecast').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-forecast');
    const p = d.projection;
    const c = d.certainty;
    const gap = d.projected_gap;

    // The four sources, as a stacked confidence breakdown
    const parts = [
      { label: 'Payslips banked',   value: d.banked.gross,        colour: 'var(--success)',
        note: `${d.banked.payslips} payslip${d.banked.payslips === 1 ? '' : 's'}` },
      { label: 'Worked, not yet paid', value: d.worked_unpaid.gross, colour: 'var(--info)',
        note: `${d.worked_unpaid.shifts} shifts · ${d.worked_unpaid.hours}h` },
      { label: 'Booked rota ahead', value: d.scheduled.gross,     colour: 'var(--primary)',
        note: `${d.scheduled.shifts} shifts · ${d.scheduled.hours}h` },
      { label: 'Projected remainder', value: d.projected_gap.gross, colour: 'var(--text-muted)',
        note: `${d.projected_gap.weeks} weeks at ${d.projected_gap.weekly_hours}h/wk (${d.projected_gap.basis})` },
    ];
    const totalParts = parts.reduce((t, x) => t + x.value, 0) || 1;

    const yearOptions = [0, 1, 2].map(back => {
      const start = parseInt(d.tax_year.startYear, 10) - back;
      return `<option value="${start}" ${start === d.tax_year.startYear ? 'selected' : ''}>
        ${start}/${String(start + 1).slice(2)}</option>`;
    }).join('');

    el.innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Tax year:</label>
          <select id="fcYear" style="width:auto">${yearOptions}</select>
        </div>
      </div>

      <div class="v3-hero" style="background:linear-gradient(135deg,#6366F1,#312E81)">
        <div class="v3-hero-label">PROJECTED TAKE-HOME · WHOLE OF ${d.tax_year.label}</div>
        <div class="v3-hero-value">${fmtCurrency(p.net)}</div>
        <div class="v3-hero-sub">
          from ${fmtCurrency(p.gross)} gross, after ${fmtCurrency(p.tax + p.ni)} of tax and NI
          (${p.effective_deduction_pct}%) · about ${fmtCurrency(p.monthly_net_average)} a month
        </div>
        <div class="v3-hero-bar" title="Green: already earned. Amber: shifts booked in. Grey: estimated.">
          <span style="width:${c.certain_pct}%;background:#34D399"></span>
        </div>
        <div class="v3-hero-sub" style="margin-top:8px">
          <strong>${c.certain_pct}% of this is already banked or worked</strong> (${fmtCurrency(c.certain)}) ·
          ${fmtCurrency(c.booked - c.certain)} more is on the rota ·
          the remaining ${fmtCurrency(c.estimated)} is an estimate
        </div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="card-body">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
            <div>
              <strong>Estimating the rest of the year at</strong>
              <div class="v3-muted" style="margin-top:2px">
                ${gap.weeks} weeks still to price, after your rota ends
                ${d.scheduled.rota_ends ? fmtDate(d.scheduled.rota_ends) : 'today'}.
              </div>
            </div>
            <div class="radio-group" id="fcBasis">
              <label class="radio-label">
                <input type="radio" name="fcBasis" value="contracted" ${gap.basis === 'contracted' ? 'checked' : ''}>
                Contracted (${gap.contracted_hours}h/wk)
              </label>
              <label class="radio-label">
                <input type="radio" name="fcBasis" value="recent" ${gap.basis === 'recent' ? 'checked' : ''}>
                Recent average (${gap.recent_weekly_hours}h/wk)
              </label>
            </div>
          </div>
          <div class="v3-note">
            This is the softest assumption in the forecast, so it's yours to choose.
            <strong>Contracted</strong> is the floor — what you'd earn if you never picked up an
            extra shift. <strong>Recent average</strong> is your actual paid hours per week over the
            last ${gap.recent_window_weeks} weeks, which is usually closer if you regularly work
            beyond your contract.
            Switching to ${gap.alternative.basis} (${gap.alternative.weekly_hours}h/wk) would make
            that stretch ${fmtCurrency(gap.alternative.gross)} instead of ${fmtCurrency(gap.gross)} —
            a swing of ${fmtCurrency(Math.abs(gap.alternative.gross - gap.gross))}.
          </div>
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Projected gross', fmtCurrency(p.gross), 'Whole tax year')}
        ${V3.tile('Income tax', fmtCurrency(p.tax),
                  p.tax_still_to_pay > 0 ? fmtCurrency(p.tax_still_to_pay) + ' of it not yet deducted' : 'Already deducted', 'danger')}
        ${V3.tile('National Insurance', fmtCurrency(p.ni),
                  p.ni_still_to_pay > 0 ? fmtCurrency(p.ni_still_to_pay) + ' of it not yet deducted' : 'Already deducted', 'danger')}
        ${V3.tile('Take-home', fmtCurrency(p.net), 'After tax and NI', 'success')}
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>🧱 How the number is built</h2></div>
          <div class="card-body">
            <div style="display:flex;height:14px;border-radius:999px;overflow:hidden;border:1px solid var(--border);margin-bottom:16px">
              ${parts.map(x => `<div style="width:${(x.value / totalParts) * 100}%;background:${x.colour}"
                                     title="${esc(x.label)}: ${fmtCurrency(x.value)}"></div>`).join('')}
            </div>
            ${parts.map(x => `
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--border)">
                <span style="font-size:13px">
                  <span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${x.colour};margin-right:7px"></span>
                  ${esc(x.label)}
                  <span class="v3-muted"> · ${esc(x.note)}</span>
                </span>
                <strong style="white-space:nowrap;margin-left:12px">${fmtCurrency(x.value)}</strong>
              </div>`).join('')}
            <div class="v3-note">
              Certainty falls as you go down the list, and the four never overlap — anything
              already on a payslip is counted there and nowhere else, so nothing is double-counted.
              The last row prices ${gap.weeks} remaining weeks at ${gap.weekly_hours}h a week
              and ${fmtCurrency(gap.rate)}/hr.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>🎩 Where it goes</h2></div>
          <div class="card-body">
            ${p.tax_freedom_day ? `
              <div style="text-align:center;padding:12px 0 18px;border-bottom:1px solid var(--border);margin-bottom:16px">
                <div class="v3-tile-label">Your tax freedom day</div>
                <div style="font-size:28px;font-weight:800;margin-top:4px">${fmtDate(p.tax_freedom_day)}</div>
                <div class="v3-muted" style="margin-top:4px">
                  Everything earned before this date covers your tax and NI for the year.
                  After it, you're working for yourself.
                </div>
              </div>` : ''}

            <div style="display:flex;justify-content:space-between;padding:7px 0"><span>Gross</span><strong>${fmtCurrency(p.gross)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:7px 0;color:var(--danger)"><span>Income tax</span><strong>−${fmtCurrency(p.tax)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:7px 0;color:var(--danger)"><span>National Insurance</span><strong>−${fmtCurrency(p.ni)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:10px 0 0;border-top:1px solid var(--border);margin-top:6px;font-size:15px">
              <strong>Take-home</strong><strong style="color:var(--success)">${fmtCurrency(p.net)}</strong>
            </div>

            <div class="v3-note">
              Tax is worked out on the projected <em>annual</em> gross, the way HMRC settles up over
              a full year — not by adding up your payslips. "Not yet deducted" is simply the gap
              between that annual figure and what has come off so far; it is not a bill. Real PAYE
              spreads it across your remaining payslips and self-corrects each month.
              <br><br>
              Bands used: ${fmtCurrency(d.bands.personal_allowance)} personal allowance,
              ${(d.bands.basic_rate * 100).toFixed(0)}% to ${fmtCurrency(d.bands.basic_rate_limit)},
              then ${(d.bands.higher_rate * 100).toFixed(0)}%. NI at ${(d.bands.ni_main_rate * 100).toFixed(0)}%
              above ${fmtCurrency(d.bands.ni_primary_threshold)}.
              <br><br>${esc(d.caveat)}
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('fcYear').addEventListener('change', e => {
      this.taxYear = e.target.value;
      document.getElementById('view-forecast').innerHTML = V3.loading();
      this.load();
    });

    el.querySelectorAll('input[name="fcBasis"]').forEach(input => {
      input.addEventListener('change', e => {
        this.basis = e.target.value;
        document.getElementById('view-forecast').innerHTML = V3.loading('Re-running the numbers…');
        this.load();
      });
    });
  },
});
