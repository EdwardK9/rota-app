/* ─── What If? — pay rate calculator (V2.0) ───────────────────────────────
   Answers "if my hourly rate were £X instead, what would this year's pay have
   looked like?" — applies a hypothetical rate to your ACTUAL logged hours for
   the selected year, isolating just the rate change (doesn't touch bank
   holiday/arrears/other payslip extras, so it stays an honest hours × rate
   comparison rather than pretending to reconstruct a whole payslip).
   ───────────────────────────────────────────────────────────────────────── */

const WhatIfView = {
  year: getCurrentYear(),
  monthly: [],
  payRates: [],

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-what-if').innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
          <select id="wiYearSelect" style="width:auto">
            ${getYears().map(y => `<option value="${y}" ${y == this.year ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="card" style="max-width:520px;margin-bottom:16px">
        <div class="card-header"><h2>🧮 What if my rate changed?</h2></div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
            Applies a hypothetical hourly rate to your actual logged hours for ${this.year !== 'all' ? this.year : 'all years'} —
            an isolated rate comparison, not a full payslip reconstruction.
          </p>
          <div class="form-group">
            <label>Hypothetical hourly rate</label>
            <div class="input-prefix"><span>£</span><input type="number" id="wiRate" step="0.01" min="0" placeholder="e.g. 13.50" /></div>
          </div>
        </div>
      </div>

      <div id="wiResults"></div>
    `;

    document.getElementById('wiYearSelect').addEventListener('change', e => {
      this.year = e.target.value;
      this.load();
    });
    document.getElementById('wiRate').addEventListener('input', () => this.calc());
  },

  async load() {
    try {
      [this.monthly, this.payRates] = await Promise.all([
        API.getMonthlyReport({ year: this.year }),
        API.getPayRates(),
      ]);
      this.calc();
    } catch (e) {
      document.getElementById('wiResults').innerHTML = `<p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
    }
  },

  _rateForMonth(month) {
    const firstDay = month + '-01';
    let rate = null;
    for (const r of this.payRates.slice().sort((a, b) => a.effective_date.localeCompare(b.effective_date))) {
      if (r.effective_date <= firstDay) rate = r;
    }
    return rate ? rate.hourly_rate : 0;
  },

  calc() {
    const el = document.getElementById('wiResults');
    const newRate = parseFloat(document.getElementById('wiRate')?.value);
    if (!newRate || newRate <= 0) { el.innerHTML = ''; return; }
    if (!this.monthly || !this.monthly.length) {
      el.innerHTML = `<p style="color:var(--text-muted)">No shift data for this year yet.</p>`;
      return;
    }

    const months = [...this.monthly].sort((a, b) => a.month.localeCompare(b.month));
    let totalCurrent = 0, totalHypothetical = 0;

    const rows = months.map(m => {
      const currentRate = this._rateForMonth(m.month);
      const currentEst  = (m.scheduled_pay || 0) + (m.leave_pay || 0);
      // Scale the exact current estimate by the rate ratio, rather than recomputing
      // from hours — keeps this consistent with whatever the real rate history was,
      // including any mid-year rate changes already reflected in scheduled_pay.
      const hypotheticalEst = currentRate > 0 ? currentEst * (newRate / currentRate) : 0;
      totalCurrent += currentEst;
      totalHypothetical += hypotheticalEst;
      const diff = hypotheticalEst - currentEst;

      return `<tr>
        <td><strong>${fmtMonth(m.month)}</strong></td>
        <td>${currentRate ? fmtCurrency(currentRate) + '/hr' : '—'}</td>
        <td>${fmtCurrency(currentEst)}</td>
        <td>${fmtCurrency(hypotheticalEst)}</td>
        <td style="color:${diff > 0 ? 'var(--success)' : diff < 0 ? 'var(--danger)' : 'var(--text-muted)'}">
          ${diff ? (diff > 0 ? '+' : '') + fmtCurrency(diff) : '—'}
        </td>
      </tr>`;
    }).join('');

    const totalDiff = totalHypothetical - totalCurrent;

    el.innerHTML = `
      <div class="stats-grid" style="margin-bottom:16px">
        <div class="stat-card">
          <div class="stat-label">At your actual rate(s)</div>
          <div class="stat-value">${fmtCurrency(totalCurrent)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">At £${newRate.toFixed(2)}/hr</div>
          <div class="stat-value">${fmtCurrency(totalHypothetical)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Difference</div>
          <div class="stat-value ${totalDiff >= 0 ? 'success' : 'danger'}">${totalDiff >= 0 ? '+' : ''}${fmtCurrency(totalDiff)}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Month by month</h2></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Actual rate</th>
                  <th title="Shifts Est. at your actual rate(s) — matches Payslips">At actual rate</th>
                  <th>At hypothetical rate</th>
                  <th>Diff</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },
};
