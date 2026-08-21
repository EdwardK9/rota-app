/* ─── ☕ Break Debt (V3.0) ─────────────────────────────────────────────────
   Unpaid break time, totalled and priced. Pay always assumes the scheduled
   break was taken, so any break you skipped is time you were on the floor for
   nothing — this is the running tally of it.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('break-debt', '☕ Break Debt', {
  year: getCurrentYear(),
  showing: 'worst',

  async init() {
    document.getElementById('view-break-debt').innerHTML = V3.loading('Adding up the lost teas…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.breakDebt(this.year);
      this.render();
    } catch (e) {
      document.getElementById('view-break-debt').innerHTML = V3.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-break-debt');
    const picker = V3.yearPicker('bdYear', this.year, true);

    if (!d.shift_count) {
      el.innerHTML = picker + V3.empty('☕', 'No completed shifts for this period', 'Pick another year.');
      document.getElementById('bdYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
      return;
    }

    const clean = d.debt.minutes === 0;
    const trendChip = d.trend ? {
      improving: '<span class="badge badge-success">📉 Improving</span>',
      worsening: '<span class="badge badge-danger">📈 Getting worse</span>',
      steady:    '<span class="badge badge-muted">➡️ Steady</span>',
    }[d.trend.direction] : '';

    el.innerHTML = `
      ${V3.backButton()}
      ${picker}

      <div class="v3-hero" style="background:${clean
        ? 'linear-gradient(135deg,#10B981,#065F46)'
        : 'linear-gradient(135deg,#F59E0B,#7C2D12)'}">
        <div class="v3-hero-label">UNPAID BREAK TIME</div>
        <div class="v3-hero-value">${clean ? 'None 🎉' : d.debt.hours + 'h'}</div>
        <div class="v3-hero-sub">
          ${clean
            ? 'You took every scheduled break in full. Nothing given away.'
            : `${d.debt.minutes} minutes worked but not paid for — worth
               <strong>${fmtCurrency(d.debt.value)}</strong>, or about
               ${d.debt.days_equivalent} full shifts of free labour.`}
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Full breaks taken', d.breaks.full_pct + '%', `${d.breaks.full} of ${d.shift_count} shifts`, 'success')}
        ${V3.tile('Part breaks', d.breaks.partial, 'Cut short', 'warning')}
        ${V3.tile('Skipped entirely', d.breaks.skipped, 'No break at all', 'danger')}
        ${V3.tile('Average per shift', d.debt.avg_mins_per_shift + ' min', `${d.debt.pct_of_paid_hours}% of paid hours`)}
      </div>

      ${d.trend ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
            <div>
              <strong>Recent trend</strong> ${trendChip}
              <div class="v3-muted" style="margin-top:4px">
                Latest quarter of shifts averages ${d.trend.recent_avg_mins} unpaid minutes each,
                against ${d.trend.previous_avg_mins} in the quarter before.
              </div>
            </div>
          </div>
        </div>` : ''}

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>📆 Debt by month</h2></div>
          <div class="card-body">
            ${V3.chart(d.by_month.map(m => ({
              label: V3.shortMonth(m.month),
              value: m.mins,
              title: `${m.month}: ${m.mins} min (${fmtCurrency(m.value)}) across ${m.shifts} shifts`,
            })), () => 'warning')}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>📅 Which days you skip</h2></div>
          <div class="card-body">
            ${V3.chart(d.by_dow.map(x => ({
              label: x.short,
              value: x.avg,
              title: `${x.day}: ${x.avg} min average across ${x.shifts} shifts`,
            })), () => 'danger')}
            <div class="v3-note">
              Average unpaid minutes per shift, by day of the week. A spike usually means one
              reliably understaffed day rather than anything you're choosing.
            </div>
          </div>
        </div>
      </div>

      ${d.worst_offenders.length ? `
        <div class="v3-section-title">🔎 The shifts behind the number</div>
        <div class="toolbar">
          <div class="radio-group" id="bdToggle">
            <label class="radio-label"><input type="radio" name="bdList" value="worst" ${this.showing === 'worst' ? 'checked' : ''}> Worst</label>
            <label class="radio-label"><input type="radio" name="bdList" value="recent" ${this.showing === 'recent' ? 'checked' : ''}> Most recent</label>
          </div>
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Date</th><th>Shift</th><th>Break</th><th>Scheduled</th><th>Taken</th><th>Unpaid</th><th>Worth</th></tr></thead>
            <tbody id="bdRows">${this.rows()}</tbody>
          </table></div>
        </div></div>` : ''}

      <div class="v3-note">
        Your pay is always calculated with the scheduled break deducted, so a break you didn't take
        is time you worked for free. This isn't about blame — it's about having the number if you
        ever want to raise it.
      </div>
    `;

    document.getElementById('bdYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
    el.querySelectorAll('input[name="bdList"]').forEach(input => {
      input.addEventListener('change', e => {
        this.showing = e.target.value;
        document.getElementById('bdRows').innerHTML = this.rows();
      });
    });
  },

  rows() {
    const list = this.showing === 'worst' ? this.data.worst_offenders : this.data.recent;
    return list.map(s => `
      <tr>
        <td><span class="shift-date">${fmtDate(s.date)}</span><br><span class="shift-day">${fmtDayShort(s.date)}</span></td>
        <td class="shift-time">${s.start_time}–${s.end_time}</td>
        <td><span class="break-chip break-${esc(s.break_taken)}">${esc(s.break_taken)}</span></td>
        <td>${s.scheduled} min</td>
        <td>${s.taken != null ? s.taken + ' min' : '—'}</td>
        <td class="diff-neg">${s.mins} min</td>
        <td>${fmtCurrency(s.value)}</td>
      </tr>`).join('');
  },
});
