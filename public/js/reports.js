/* ─── Reports View ────────────────────────────────────────────────────────── */

const ReportsView = {
  currentYear: getCurrentYear(),
  activeTab: 'monthly',
  monthlyData: [],
  insightsData: null,
  taxYearData: null, // { payslips, monthly, taxYear }
  currentTaxYear: (() => {
    const now = new Date();
    const m = now.getMonth() + 1; // 1-12
    return m >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  })(),

  async init() {
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-reports');
    el.innerHTML = `
      <div class="toolbar">
        <label style="margin-bottom:0;font-weight:500">Year:</label>
        <select id="reportYearSelect" style="width:auto">
          ${getYears().map(y => `<option value="${y}" ${y == this.currentYear ? 'selected':''}>${y}</option>`).join('')}
        </select>
        <div class="toolbar-right">
          <button class="btn btn-ghost" id="reportRefreshBtn">↻ Refresh</button>
        </div>
      </div>

      <div id="reportSummaryStats" class="stats-grid" style="margin-bottom:16px"></div>

      <!-- Tabs -->
      <div class="import-tabs" style="margin-bottom:0">
        <button class="import-tab ${this.activeTab === 'monthly'  ? 'active' : ''}" data-tab="monthly">Monthly</button>
        <button class="import-tab ${this.activeTab === 'weekly'   ? 'active' : ''}" data-tab="weekly">Weekly</button>
        <button class="import-tab ${this.activeTab === 'yearly'   ? 'active' : ''}" data-tab="yearly">Yearly</button>
        <button class="import-tab ${this.activeTab === 'tax-year' ? 'active' : ''}" data-tab="tax-year">🏛️ Tax Year</button>
        <button class="import-tab ${this.activeTab === 'custom'   ? 'active' : ''}" data-tab="custom">Custom Range</button>
      </div>

      <div id="reportTabContent" style="border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius) var(--radius);padding:20px 0 4px">
        <!-- content injected per tab -->
      </div>
    `;

    document.getElementById('reportYearSelect').addEventListener('change', e => {
      this.currentYear = e.target.value;
      this.load();
    });
    document.getElementById('reportRefreshBtn').addEventListener('click', () => this.load());
    document.querySelectorAll('.import-tab[data-tab]').forEach(btn =>
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset.tab;
        document.querySelectorAll('.import-tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === this.activeTab));
        this.renderActiveTab();
      })
    );
  },

  async load() {
    try {
      const [monthly, summary, weekly, yearly] = await Promise.all([
        API.getMonthlyReport({ year: this.currentYear }),
        API.getReportSummary({ from: `${this.currentYear}-01`, to: `${this.currentYear}-12` }),
        API.getWeeklyReport({ year: this.currentYear }),
        API.getYearlyReport(),
      ]);
      this.monthlyData  = monthly;
      this.weeklyData   = weekly;
      this.yearlyData   = yearly;
      this.renderSummaryStats(summary);
      this.renderActiveTab();
    } catch(e) { showToast('Failed to load reports: ' + e.message, 'error'); }
  },

  renderActiveTab() {
    switch(this.activeTab) {
      case 'monthly':  this.renderMonthly();  break;
      case 'weekly':   this.renderWeekly();   break;
      case 'yearly':   this.renderYearly();   break;
      case 'tax-year': this.renderTaxYear();  break;
      case 'custom':   this.renderCustom();   break;
      case 'insights': this.renderInsights(); break;
    }
  },

  // ─── Summary stats strip ───────────────────────────────────────────────────

  renderSummaryStats(summary) {
    const s = summary.shifts || {};
    const p = summary.payslips || {};
    document.getElementById('reportSummaryStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Shifts</div>
        <div class="stat-value">${s.total_shifts || 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value success">${s.completed_shifts || 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Hours Worked</div>
        <div class="stat-value">${fmtHours(s.total_hours || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Est. Pay (shifts)</div>
        <div class="stat-value">${fmtCurrency(s.total_calculated_pay || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Gross Paid</div>
        <div class="stat-value">${fmtCurrency(p.total_gross_paid || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Net Paid</div>
        <div class="stat-value success">${fmtCurrency(p.total_net_paid || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tax Paid</div>
        <div class="stat-value warning">${fmtCurrency(p.total_tax || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Distance Driven</div>
        <div class="stat-value">${fmtMiles(s.total_distance || 0)}</div>
      </div>
    `;
  },

  // ─── Monthly tab ───────────────────────────────────────────────────────────

  renderMonthly() {
    const monthly = this.monthlyData || [];
    const el = document.getElementById('reportTabContent');

    if (!monthly.length) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">
        <div style="font-size:36px;margin-bottom:8px">📊</div>
        <div>No data for ${this.currentYear}</div>
      </div>`;
      return;
    }

    // Break summary totals
    const totalBreaksTaken   = monthly.reduce((s,m) => s + (m.breaks_taken_count   || 0), 0);
    const totalBreakMin      = monthly.reduce((s,m) => s + (m.breaks_taken_minutes  || 0), 0);
    const totalBreaksSkipped = monthly.reduce((s,m) => s + (m.breaks_skipped_count  || 0), 0);
    const totalSkippedMin    = monthly.reduce((s,m) => s + (m.breaks_skipped_minutes|| 0), 0);
    const totalBreakUnusedPay= monthly.reduce((s,m) => s + (m.break_unused_pay     || 0), 0);

    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <h3 class="report-section-heading">Monthly Breakdown — ${this.currentYear}</h3>

        <!-- Break summary cards -->
        <div class="stats-grid" style="margin-bottom:16px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
          <div class="stat-card">
            <div class="stat-label">Breaks taken</div>
            <div class="stat-value success">${totalBreaksTaken}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${fmtMins(totalBreakMin)} total</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Breaks skipped</div>
            <div class="stat-value warning">${totalBreaksSkipped}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${fmtMins(totalSkippedMin)} unused</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Unused break pay</div>
            <div class="stat-value warning">${fmtCurrency(totalBreakUnusedPay)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">extra earned on skipped breaks</div>
          </div>
        </div>

        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Shifts</th>
                <th>Done</th>
                <th>Hours</th>
                <th>Contracted</th>
                <th title="Booked leave falling in this month — counts towards your contract">Leave</th>
                <th title="Logged hours plus leave, against contracted">Over/Under</th>
                <th>Est. Pay</th>
                <th>Gross (slip)</th>
                <th>Net Paid</th>
                <th>Diff</th>
                <th>Breaks taken</th>
                <th>Breaks skipped</th>
                <th>Unused pay</th>
                <th>Distance</th>
              </tr>
            </thead>
            <tbody>
              ${monthly.map(m => {
                const gross = m.payslip ? (m.payslip.total_gross || 0) : null;
                const net   = m.payslip ? (m.payslip.net_payment || 0) : null;
                const diff  = gross !== null ? (m.calculated_pay || 0) - gross : null;
                const diffHtml = diff !== null
                  ? `<span class="${diffClass(diff)}">${diff >= 0 ? '+' : ''}${fmtCurrency(Math.abs(diff))}</span>`
                  : '—';
                const contracted = m.contracted_hours != null ? m.contracted_hours : null;
                // Leave counts towards the contract — see leaveHours.js
                const overUnder  = contracted !== null ? (m.scheduled_hours || 0) + (m.leave_hours || 0) - contracted : null;
                const contractedHtml = contracted !== null
                  ? `<span style="color:var(--text-muted)">${fmtHours(contracted)}</span>`
                  : '<span style="color:var(--text-muted)">—</span>';
                const overUnderHtml  = overUnder !== null
                  ? `<span class="${diffClass(overUnder)}">${overUnder >= 0 ? '+' : '−'}${fmtHours(Math.abs(overUnder))}</span>`
                  : '—';
                return `<tr>
                  <td><strong>${fmtMonth(m.month)}</strong></td>
                  <td>${m.shift_count}</td>
                  <td><span class="badge badge-success">${m.completed_count}</span></td>
                  <td>${fmtHours(m.hours_worked)}</td>
                  <td>${contractedHtml}</td>
                    <td style="color:${(m.leave_hours || 0) > 0 ? 'var(--info)' : 'var(--text-muted)'}">${(m.leave_hours || 0) > 0 ? fmtHours(m.leave_hours) : '—'}</td>
                  <td>${overUnderHtml}</td>
                  <td>${fmtCurrency(m.calculated_pay)}</td>
                  <td>${gross !== null ? fmtCurrency(gross) : '<span style="color:var(--text-muted)">—</span>'}</td>
                  <td style="color:var(--success);font-weight:600">${net !== null ? fmtCurrency(net) : '<span style="color:var(--text-muted)">—</span>'}</td>
                  <td>${diffHtml}</td>
                  <td style="color:var(--success)">${m.breaks_taken_count || 0} <small style="color:var(--text-muted)">(${fmtMins(m.breaks_taken_minutes || 0)})</small></td>
                  <td style="color:var(--warning)">${m.breaks_skipped_count || 0} <small style="color:var(--text-muted)">(${fmtMins(m.breaks_skipped_minutes || 0)})</small></td>
                  <td style="color:var(--warning)">${m.break_unused_pay ? fmtCurrency(m.break_unused_pay) : '<span style="color:var(--text-muted)">—</span>'}</td>
                  <td>${fmtMiles(m.distance_miles)}</td>
                </tr>`;
              }).join('')}
              <tr style="font-weight:700;border-top:2px solid var(--border)">
                <td>TOTAL</td>
                <td>${monthly.reduce((s,m)=>s+m.shift_count,0)}</td>
                <td>${monthly.reduce((s,m)=>s+m.completed_count,0)}</td>
                <td>${fmtHours(monthly.reduce((s,m)=>s+(m.hours_worked||0),0))}</td>
                <td style="color:var(--text-muted)">${fmtHours(monthly.reduce((s,m)=>s+(m.contracted_hours||0),0))}</td>
                <td style="color:var(--info)">${fmtHours(monthly.reduce((s,m)=>s+(m.leave_hours||0),0))}</td>
                <td>${(() => { const d = monthly.reduce((s,m)=>s+(m.scheduled_hours||0)+(m.leave_hours||0),0) - monthly.reduce((s,m)=>s+(m.contracted_hours||0),0); return `<span class="${diffClass(d)}">${d>=0?'+':'−'}${fmtHours(Math.abs(d))}</span>`; })()}</td>
                <td>${fmtCurrency(monthly.reduce((s,m)=>s+(m.calculated_pay||0),0))}</td>
                <td>${fmtCurrency(monthly.reduce((s,m)=>s+(m.payslip?.total_gross||0),0))}</td>
                <td style="color:var(--success)">${fmtCurrency(monthly.reduce((s,m)=>s+(m.payslip?.net_payment||0),0))}</td>
                <td>—</td>
                <td style="color:var(--success)">${totalBreaksTaken} <small style="color:var(--text-muted)">(${fmtMins(totalBreakMin)})</small></td>
                <td style="color:var(--warning)">${totalBreaksSkipped} <small style="color:var(--text-muted)">(${fmtMins(totalSkippedMin)})</small></td>
                <td style="color:var(--warning)">${fmtCurrency(totalBreakUnusedPay)}</td>
                <td>${fmtMiles(monthly.reduce((s,m)=>s+(m.distance_miles||0),0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`;
  },

  // ─── Weekly tab ────────────────────────────────────────────────────────────

  renderWeekly() {
    const weeks = this.weeklyData || [];
    const el = document.getElementById('reportTabContent');

    if (!weeks.length) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">No completed shifts for ${this.currentYear}.</div>`;
      return;
    }

    const totalWorked     = weeks.reduce((s, w) => s + w.hours_worked, 0);
    const totalContracted = weeks.reduce((s, w) => s + w.contracted_hours, 0);
    const totalDiff       = totalWorked - totalContracted;

    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <h3 class="report-section-heading">Weekly Hours — ${this.currentYear}</h3>
        <div class="stats-grid" style="margin-bottom:16px">
          <div class="stat-card"><div class="stat-label">Weeks with shifts</div><div class="stat-value">${weeks.length}</div></div>
          <div class="stat-card"><div class="stat-label">Total hours worked</div><div class="stat-value">${fmtHours(totalWorked)}</div></div>
          <div class="stat-card"><div class="stat-label">Total contracted</div><div class="stat-value">${fmtHours(totalContracted)}</div></div>
          <div class="stat-card"><div class="stat-label">Over/under contract</div><div class="stat-value ${diffClass(totalDiff)}">${totalDiff >= 0 ? '+' : ''}${fmtHours(Math.abs(totalDiff))}</div></div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Week (Mon)</th>
                <th>Week (Sun)</th>
                <th>Shifts</th>
                <th>Hours worked</th>
                <th>Contracted</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              ${weeks.map(w => {
                const diff = w.hours_worked - w.contracted_hours;
                const [y,m,d] = w.weekStart.split('-').map(Number);
                const sun = new Date(y, m-1, d+6);
                const sunStr = `${String(sun.getDate()).padStart(2,'0')}/${String(sun.getMonth()+1).padStart(2,'0')}/${sun.getFullYear()}`;
                return `<tr>
                  <td><strong>${fmtDate(w.weekStart)}</strong></td>
                  <td>${sunStr}</td>
                  <td>${w.shift_count}</td>
                  <td>${fmtHours(w.hours_worked)}</td>
                  <td style="color:var(--text-muted)">${fmtHours(w.contracted_hours)}</td>
                  <td><span class="${diffClass(diff)}">${diff >= 0 ? '+' : ''}${fmtHours(Math.abs(diff))}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  // ─── Yearly tab ────────────────────────────────────────────────────────────

  renderYearly() {
    const yearly = this.yearlyData || [];
    const el = document.getElementById('reportTabContent');

    if (!yearly.length) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">No data yet.</div>`;
      return;
    }

    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <h3 class="report-section-heading">Year-on-Year Comparison</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th>Shifts</th>
                <th>Done</th>
                <th>Hours</th>
                <th>Est. Pay</th>
                <th>Gross Paid</th>
                <th>Net Paid</th>
                <th>Diff</th>
                <th>Tax</th>
                <th>Distance</th>
              </tr>
            </thead>
            <tbody>
              ${yearly.map(y => {
                const diff = (y.calculated_pay || 0) - (y.total_gross || 0);
                return `<tr>
                  <td><strong>${y.year}</strong></td>
                  <td>${y.shift_count}</td>
                  <td><span class="badge badge-success">${y.completed_count}</span></td>
                  <td>${fmtHours(y.hours_worked)}</td>
                  <td>${fmtCurrency(y.calculated_pay)}</td>
                  <td>${y.total_gross ? fmtCurrency(y.total_gross) : '<span style="color:var(--text-muted)">—</span>'}</td>
                  <td style="color:var(--success);font-weight:600">${y.net_payment ? fmtCurrency(y.net_payment) : '<span style="color:var(--text-muted)">—</span>'}</td>
                  <td>${y.total_gross ? `<span class="${diffClass(diff)}">${diff >= 0 ? '+' : ''}${fmtCurrency(Math.abs(diff))}</span>` : '—'}</td>
                  <td style="color:var(--warning)">${y.tax_paid ? fmtCurrency(y.tax_paid) : '—'}</td>
                  <td>${fmtMiles(y.distance_miles)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  // ─── Tax Year tab ──────────────────────────────────────────────────────────

  async renderTaxYear() {
    const el = document.getElementById('reportTabContent');
    const ty = this.currentTaxYear;
    const from = `${ty}-04`;
    const to   = `${ty + 1}-03`;

    // Build tax year options (2024 onwards)
    const startYear = 2024;
    const nowYear   = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    let tyOptions = '';
    for (let y = nowYear; y >= startYear; y--) {
      tyOptions += `<option value="${y}" ${y === ty ? 'selected' : ''}>${y}/${String(y + 1).slice(-2)} (Apr ${y} – Mar ${y + 1})</option>`;
    }

    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          <h3 class="report-section-heading" style="margin-bottom:0">Tax Year Summary</h3>
          <select id="taxYearSelect" style="width:auto">${tyOptions}</select>
          <button class="btn btn-ghost btn-sm" id="taxYearRefresh">↻ Load</button>
        </div>
        <div id="taxYearContent"><p style="color:var(--text-muted)">Loading…</p></div>
      </div>`;

    document.getElementById('taxYearSelect').addEventListener('change', e => {
      this.currentTaxYear = parseInt(e.target.value, 10);
      this.renderTaxYear();
    });
    document.getElementById('taxYearRefresh').addEventListener('click', () => this.renderTaxYear());

    try {
      const taxYearStr = `${ty}/${ty + 1}`;
      const [payslips, monthlyRows, tyRefunds] = await Promise.all([
        API.getPayslips().catch(() => []),
        API.getMonthlyReport({ year: ty }).then(r => r).catch(() => []),
        API.get(`/api/tax-refunds?tax_year=${encodeURIComponent(taxYearStr)}`).catch(() => []),
      ]);
      const totalRefunded = (tyRefunds || []).reduce((sum, r) => sum + (r.amount || 0), 0);

      // Filter payslips for this tax year
      const tyPayslips = payslips.filter(p => p.month >= from && p.month <= to)
        .sort((a, b) => a.month.localeCompare(b.month));

      // Filter monthly rows — April of ty, then Jan–March of ty+1
      const aprilToMarch = [...monthlyRows].filter(m => m.month >= from)
        .concat(
          await API.getMonthlyReport({ year: ty + 1 }).then(r => r.filter(m => m.month <= to)).catch(() => [])
        ).sort((a, b) => a.month.localeCompare(b.month));

      const contentEl = document.getElementById('taxYearContent');
      if (!contentEl) return;

      if (!tyPayslips.length && !aprilToMarch.length) {
        contentEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
          No data for tax year ${ty}/${ty + 1}
        </div>`;
        return;
      }

      // Totals
      const totalGross      = tyPayslips.reduce((s, p) => s + (p.total_gross      || 0), 0);
      const totalNet        = tyPayslips.reduce((s, p) => s + (p.net_payment      || 0), 0);
      const totalTax        = tyPayslips.reduce((s, p) => s + (p.tax_paid         || 0), 0);
      const totalNI         = tyPayslips.reduce((s, p) => s + (p.ni_employee      || 0), 0);
      const totalNIEmp      = tyPayslips.reduce((s, p) => s + (p.ni_employer      || 0), 0);
      const totalSIP        = tyPayslips.reduce((s, p) => s + (p.sip_contribution || 0), 0);
      const totalSharesave  = tyPayslips.reduce((s, p) => s + (p.sharesave_amount || 0), 0);
      const totalShiftEst   = aprilToMarch.reduce((s, m) => s + (m.calculated_pay || 0), 0);
      const totalHours      = aprilToMarch.reduce((s, m) => s + (m.hours_worked   || 0), 0);

      // Latest YTD from last payslip in the year
      const latestSlip = tyPayslips[tyPayslips.length - 1];

      // Build month map
      const monthlyMap = {};
      aprilToMarch.forEach(m => { monthlyMap[m.month] = m; });

      contentEl.innerHTML = `
        <!-- Summary cards -->
        <div class="stats-grid" style="margin-bottom:16px">
          <div class="stat-card">
            <div class="stat-label">Total Gross</div>
            <div class="stat-value">${fmtCurrency(totalGross)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Net Paid</div>
            <div class="stat-value success">${fmtCurrency(totalNet)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Income Tax</div>
            <div class="stat-value warning">${fmtCurrency(totalTax)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">NI (Employee)</div>
            <div class="stat-value warning">${fmtCurrency(totalNI)}</div>
          </div>
          ${totalSIP ? `<div class="stat-card">
            <div class="stat-label">SIP (pre-tax)</div>
            <div class="stat-value" style="color:var(--text-muted)">${fmtCurrency(Math.abs(totalSIP))}</div>
          </div>` : ''}
          ${totalSharesave ? `<div class="stat-card">
            <div class="stat-label">Sharesave</div>
            <div class="stat-value" style="color:var(--text-muted)">${fmtCurrency(totalSharesave)}</div>
          </div>` : ''}
          ${totalNIEmp ? `<div class="stat-card">
            <div class="stat-label">NI (Employer)</div>
            <div class="stat-value" style="color:var(--text-muted)">${fmtCurrency(totalNIEmp)}</div>
          </div>` : ''}
          <div class="stat-card">
            <div class="stat-label">Hours Worked</div>
            <div class="stat-value">${fmtHours(totalHours)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Shifts Est.</div>
            <div class="stat-value">${fmtCurrency(totalShiftEst)}</div>
          </div>
        </div>

        ${latestSlip && latestSlip.gross_ytd ? `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><h3 style="font-size:14px;font-weight:600">Year-to-Date (from last payslip in period)</h3></div>
          <div class="card-body">
            <div class="stats-grid">
              <div class="stat-card"><div class="stat-label">Gross YTD</div><div class="stat-value">${fmtCurrency(latestSlip.gross_ytd)}</div></div>
              ${latestSlip.taxable_ytd ? `<div class="stat-card"><div class="stat-label">Taxable YTD</div><div class="stat-value">${fmtCurrency(latestSlip.taxable_ytd)}</div></div>` : ''}
              <div class="stat-card"><div class="stat-label">Tax YTD</div><div class="stat-value warning">${fmtCurrency(latestSlip.tax_ytd)}</div></div>
              ${totalRefunded > 0 ? `
              <div class="stat-card" style="border-left:3px solid var(--success)"><div class="stat-label">Tax Refunded</div><div class="stat-value success">${fmtCurrency(totalRefunded)}</div></div>
              <div class="stat-card" style="border-left:3px solid var(--primary)"><div class="stat-label">Net Tax (after refund)</div><div class="stat-value">${fmtCurrency(Math.max(0, (latestSlip.tax_ytd || 0) - totalRefunded))}</div></div>` : ''}
              ${latestSlip.ni_able_ytd ? `<div class="stat-card"><div class="stat-label">NI'able YTD</div><div class="stat-value">${fmtCurrency(latestSlip.ni_able_ytd)}</div></div>` : ''}
            </div>
          </div>
        </div>` : ''}

        <!-- Monthly breakdown -->
        <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px">Monthly Breakdown — Apr ${ty} to Mar ${ty + 1}</h4>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Basic</th>
                <th>Extra Hrs</th>
                <th>Bank Hols</th>
                <th>SIP</th>
                <th>Gross</th>
                <th>Tax</th>
                <th>NI</th>
                <th>Sharesave</th>
                <th>Net Paid</th>
                <th>Shift Est.</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>
              ${(() => {
                // Generate all 12 months Apr–Mar
                const months = [];
                for (let i = 0; i < 12; i++) {
                  const d = new Date(ty, 3 + i, 1); // month 3 = April (0-indexed)
                  months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
                }
                return months.map(month => {
                  const p  = tyPayslips.find(x => x.month === month);
                  const sd = monthlyMap[month];
                  const shiftEst = sd ? (sd.calculated_pay || 0) : null;
                  const gross    = p  ? (p.total_gross || 0)      : null;
                  const diff     = shiftEst !== null && gross !== null ? shiftEst - gross : null;
                  const isLarge  = diff !== null && Math.abs(diff) > 5;
                  const diffHtml = diff !== null
                    ? isLarge
                      ? `<span class="diff-alert ${diff >= 0 ? 'diff-alert-over' : 'diff-alert-under'}">⚠️ ${diff >= 0 ? '+' : ''}${fmtCurrency(Math.abs(diff))}</span>`
                      : `<span class="${diffClass(diff)}">${diff >= 0 ? '+' : ''}${fmtCurrency(Math.abs(diff))}</span>`
                    : '—';
                  if (!p && !sd) {
                    return `<tr style="color:var(--text-muted)">
                      <td>${fmtMonth(month)}</td>
                      <td colspan="11" style="font-style:italic">No data</td>
                    </tr>`;
                  }
                  const bhTotal = (p?.bank_hol_curr_amount || 0) + (p?.bank_hol_prev_amount || 0);
                  const extraHrsTotal = (p?.additional_hours_pay || 0) + (p?.addt_hours_prev_amount || 0);
                  return `<tr${isLarge ? ' class="payslip-discrepancy-row"' : ''}>
                    <td><strong>${fmtMonth(month)}</strong></td>
                    <td>${p ? fmtCurrency(p.basic_pay) : '—'}</td>
                    <td>${p && extraHrsTotal ? fmtCurrency(extraHrsTotal) : '—'}</td>
                    <td>${p && bhTotal ? fmtCurrency(bhTotal) : '—'}</td>
                    <td>${p && p.sip_contribution ? `<span style="color:var(--text-muted)">${fmtCurrency(p.sip_contribution)}</span>` : '—'}</td>
                    <td><strong>${p ? fmtCurrency(p.total_gross) : '—'}</strong></td>
                    <td style="color:var(--warning)">${p ? fmtCurrency(p.tax_paid) : '—'}</td>
                    <td style="color:var(--warning)">${p ? fmtCurrency(p.ni_employee) : '—'}</td>
                    <td>${p && p.sharesave_amount ? fmtCurrency(p.sharesave_amount) : '—'}</td>
                    <td style="color:var(--success);font-weight:600">${p ? fmtCurrency(p.net_payment) : '—'}</td>
                    <td>${shiftEst !== null ? fmtCurrency(shiftEst) : '—'}</td>
                    <td>${diffHtml}</td>
                  </tr>`;
                }).join('');
              })()}
              <tr style="font-weight:700;border-top:2px solid var(--border)">
                <td>TOTAL</td>
                <td>${fmtCurrency(tyPayslips.reduce((s,p)=>s+(p.basic_pay||0),0))}</td>
                <td>${fmtCurrency(tyPayslips.reduce((s,p)=>s+(p.additional_hours_pay||0)+(p.addt_hours_prev_amount||0),0))}</td>
                <td>${fmtCurrency(tyPayslips.reduce((s,p)=>s+(p.bank_hol_curr_amount||0)+(p.bank_hol_prev_amount||0),0))}</td>
                <td style="color:var(--text-muted)">${totalSIP ? fmtCurrency(totalSIP) : '—'}</td>
                <td>${fmtCurrency(totalGross)}</td>
                <td style="color:var(--warning)">${fmtCurrency(totalTax)}</td>
                <td style="color:var(--warning)">${fmtCurrency(totalNI)}</td>
                <td>${totalSharesave ? fmtCurrency(totalSharesave) : '—'}</td>
                <td style="color:var(--success)">${fmtCurrency(totalNet)}</td>
                <td>${fmtCurrency(totalShiftEst)}</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>

        ${totalSIP || totalSharesave ? `
        <div style="margin-top:12px;padding:12px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text-muted)">
          💡 <strong>Note:</strong>
          ${totalSIP ? `SIP contributions (${fmtCurrency(Math.abs(totalSIP))}) are deducted <em>before</em> tax, reducing your taxable gross.` : ''}
          ${totalSharesave ? ` Sharesave (${fmtCurrency(totalSharesave)}) is deducted <em>after</em> tax from net pay.` : ''}
        </div>` : ''}

        <!-- Tax Refunds -->
        <div id="rptTaxRefundsSection" style="margin-top:20px"></div>
      `;

      // Load and render tax refunds
      await this.renderTaxRefunds(ty);
    } catch(e) {
      const contentEl = document.getElementById('taxYearContent');
      if (contentEl) contentEl.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  async renderTaxRefunds(ty) {
    const el = document.getElementById('rptTaxRefundsSection');
    if (!el) return;

    const taxYear = `${ty}/${ty + 1}`;
    let refunds = [];
    try { refunds = await API.get(`/api/tax-refunds?tax_year=${encodeURIComponent(taxYear)}`); }
    catch(_) { refunds = []; }

    // Default date: within the tax year being viewed, preferring the currently selected report year
    const viewedYear = parseInt(this.currentYear, 10);
    const defaultDateYear = (viewedYear >= ty && viewedYear <= ty + 1) ? viewedYear : ty + 1;
    const defaultDate = `${defaultDateYear}-04-06`;

    el.innerHTML = `
      <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Tax Refunds — ${taxYear}</h4>
      <div class="card" style="margin-bottom:12px">
        <div class="card-body" style="padding:12px 16px">
          <div class="form-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:0">
            <div class="form-group" style="margin-bottom:0;min-width:120px">
              <label style="font-size:12px">Amount (£)</label>
              <input type="number" id="rptTrAmount" step="0.01" min="0" placeholder="0.00" style="width:120px" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label style="font-size:12px">Date received</label>
              <input type="date" id="rptTrDate" value="${defaultDate}" />
            </div>
            <div class="form-group" style="margin-bottom:0;flex:1;min-width:160px">
              <label style="font-size:12px">Notes (optional)</label>
              <input type="text" id="rptTrNotes" placeholder="e.g. PAYE refund cheque" />
            </div>
            <button class="btn btn-primary btn-sm" id="trAddBtn" style="margin-bottom:0">+ Add</button>
          </div>
        </div>
      </div>
      ${refunds.length ? `
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Notes</th><th></th></tr></thead>
            <tbody id="trTableBody">
              ${refunds.map(r => `
                <tr>
                  <td>${fmtDate(r.date) || '—'}</td>
                  <td style="color:var(--success);font-weight:600">${fmtCurrency(r.amount)}</td>
                  <td>${r.notes || '—'}</td>
                  <td><button class="btn-icon danger tr-delete-btn" data-id="${r.id}" title="Delete">🗑️</button></td>
                </tr>
              `).join('')}
              <tr style="font-weight:700;border-top:2px solid var(--border)">
                <td colspan="2">Total refunded: ${fmtCurrency(refunds.reduce((s,r)=>s+(r.amount||0),0))}</td>
                <td colspan="2"></td>
              </tr>
            </tbody>
          </table>
        </div>
      ` : `<p style="font-size:13px;color:var(--text-muted)">No tax refunds recorded for ${taxYear}.</p>`}
    `;

    document.getElementById('trAddBtn').addEventListener('click', async () => {
      const amount = parseFloat(document.getElementById('rptTrAmount').value);
      const date   = document.getElementById('rptTrDate').value;
      const notes  = document.getElementById('rptTrNotes').value.trim();
      if (!amount || amount <= 0) { showToast('Enter a valid amount', 'warning'); return; }
      try {
        await API.post('/api/tax-refunds', { tax_year: taxYear, amount, date: date || null, notes: notes || null });
        showToast('Refund added ✓', 'success');
        await this.renderTaxRefunds(ty);
      } catch(e) { showToast('Error: ' + e.message, 'error'); }
    });

    el.querySelectorAll('.tr-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this refund?')) return;
        try {
          await API.delete(`/api/tax-refunds/${btn.dataset.id}`);
          showToast('Deleted', 'success');
          await this.renderTaxRefunds(ty);
        } catch(e) { showToast('Error: ' + e.message, 'error'); }
      });
    });
  },

  // ─── Custom Range tab ──────────────────────────────────────────────────────

  renderCustom() {
    const el = document.getElementById('reportTabContent');
    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <h3 class="report-section-heading">Custom Date Range</h3>
        <div class="card card-body" style="margin-bottom:16px">
          <div class="form-row" style="margin-bottom:12px">
            <div class="form-group" style="margin-bottom:0">
              <label>From (month)</label>
              <input type="month" id="reportFrom" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label>To (month)</label>
              <input type="month" id="reportTo" value="${this.currentYear}-${String(new Date().getMonth()+1).padStart(2,'0')}" />
            </div>
          </div>
          <button class="btn btn-primary" id="reportRangeBtn">Run Report</button>
        </div>
        <div id="reportRangeResult"></div>
      </div>`;

    document.getElementById('reportRangeBtn').addEventListener('click', () => this.runCustomRange());
  },

  async runCustomRange() {
    const from = document.getElementById('reportFrom').value;
    const to   = document.getElementById('reportTo').value;
    const resultEl = document.getElementById('reportRangeResult');

    if (!from || !to) { showToast('Please set both From and To months', 'warning'); return; }
    if (from > to)    { showToast('From must be before To', 'warning'); return; }

    resultEl.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';

    try {
      const summary = await API.getReportSummary({ from, to });
      const s = summary.shifts || {};
      const p = summary.payslips || {};
      const diff = (s.total_calculated_pay || 0) - (p.total_gross_paid || 0);

      resultEl.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">Shifts (completed)</div><div class="stat-value">${s.completed_shifts || 0} / ${s.total_shifts || 0}</div></div>
          <div class="stat-card"><div class="stat-label">Hours Worked</div><div class="stat-value">${fmtHours(s.total_hours||0)}</div></div>
          <div class="stat-card"><div class="stat-label">Est. Pay (shifts)</div><div class="stat-value">${fmtCurrency(s.total_calculated_pay||0)}</div></div>
          <div class="stat-card"><div class="stat-label">Gross Paid</div><div class="stat-value">${fmtCurrency(p.total_gross_paid||0)}</div></div>
          <div class="stat-card"><div class="stat-label">Net Paid</div><div class="stat-value success">${fmtCurrency(p.total_net_paid||0)}</div></div>
          <div class="stat-card"><div class="stat-label">Est. vs Gross Diff</div><div class="stat-value ${diffClass(diff)}">${diff>=0?'+':''}${fmtCurrency(Math.abs(diff))}</div></div>
          <div class="stat-card"><div class="stat-label">Tax Paid</div><div class="stat-value warning">${fmtCurrency(p.total_tax||0)}</div></div>
          <div class="stat-card"><div class="stat-label">Distance</div><div class="stat-value">${fmtMiles(s.total_distance||0)}</div></div>
        </div>`;
    } catch(e) { showToast(e.message, 'error'); resultEl.innerHTML = ''; }
  },

  // ─── Insights tab ─────────────────────────────────────────────────────────────

  renderInsights() {
    const el = document.getElementById('reportTabContent');
    const d  = this.insightsData;

    if (!d) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</div>`;
      return;
    }

    const { topShiftTimes, topPairings, weeklyEarlyLate, monthlyWeekends } = d;

    const noData = !topShiftTimes.length && !topPairings.length && !weeklyEarlyLate.length;
    if (noData) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">
        <div style="font-size:36px;margin-bottom:8px">🔍</div>
        <div>No completed shift data for ${this.currentYear}</div>
      </div>`;
      return;
    }

    const totalEarly    = weeklyEarlyLate.reduce((s, w) => s + w.early_count, 0);
    const totalLate     = weeklyEarlyLate.reduce((s, w) => s + w.late_count,  0);
    const totalWkShifts = weeklyEarlyLate.reduce((s, w) => s + w.total, 0);
    const totalSats     = monthlyWeekends.reduce((s, m) => s + m.saturday_count, 0);
    const totalSuns     = monthlyWeekends.reduce((s, m) => s + m.sunday_count,   0);
    const maxPairing    = topPairings.length   ? topPairings[0].count   : 1;
    const maxTime       = topShiftTimes.length ? topShiftTimes[0].count : 1;

    el.innerHTML = `
      <div style="padding:0 20px 16px">
        <h3 class="report-section-heading">Shift Insights — ${this.currentYear}</h3>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">

          <div>
            <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">
              👥 Most common pairings
            </h4>
            ${topPairings.length ? topPairings.map((p, i) => {
              const pct = Math.round((p.count / maxPairing) * 100);
              const medals = ['🥇','🥈','🥉'];
              const label = medals[i] || `${i + 1}.`;
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                    <span style="font-size:13px;font-weight:${i < 3 ? '600' : '400'}">${label} ${p.name}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${p.count} shift${p.count !== 1 ? 's' : ''}</span>
                  </div>
                  <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                    <div style="width:${pct}%;background:var(--primary);height:100%;border-radius:4px;transition:width .3s"></div>
                  </div>
                </div>`;
            }).join('') : '<p style="color:var(--text-muted);font-size:13px">No colleague data found.<br>Team upload shifts to see pairings.</p>'}
          </div>

          <div>
            <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">
              ⏰ Most common shift times
            </h4>
            ${topShiftTimes.length ? topShiftTimes.map((t, i) => {
              const pct = Math.round((t.count / maxTime) * 100);
              const medals = ['🥇','🥈','🥉'];
              const label = medals[i] || `${i + 1}.`;
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                    <span style="font-size:13px;font-weight:${i < 3 ? '600' : '400'};font-family:monospace">${label} ${t.start_time} – ${t.end_time}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${t.count}×</span>
                  </div>
                  <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                    <div style="width:${pct}%;background:var(--success);height:100%;border-radius:4px;transition:width .3s"></div>
                  </div>
                </div>`;
            }).join('') : '<p style="color:var(--text-muted);font-size:13px">No completed shifts yet.</p>'}
          </div>
        </div>

        ${weeklyEarlyLate.length ? `
        <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">
          🌅 Early vs Late shifts <small style="font-weight:400;font-size:11px">(early = 06:45 start · late = ends 19:15+ / 20:15+ pre-Feb 2025)</small>
        </h4>
        <div class="stats-grid" style="margin-bottom:12px;grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
          <div class="stat-card">
            <div class="stat-label">Early shifts</div>
            <div class="stat-value success">${totalEarly}</div>
            <div style="font-size:11px;color:var(--text-muted)">${totalWkShifts ? Math.round(totalEarly / totalWkShifts * 100) : 0}% of shifts</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Late shifts</div>
            <div class="stat-value warning">${totalLate}</div>
            <div style="font-size:11px;color:var(--text-muted)">${totalWkShifts ? Math.round(totalLate / totalWkShifts * 100) : 0}% of shifts</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Avg early/week</div>
            <div class="stat-value">${weeklyEarlyLate.length ? (totalEarly / weeklyEarlyLate.length).toFixed(1) : 0}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Avg late/week</div>
            <div class="stat-value">${weeklyEarlyLate.length ? (totalLate / weeklyEarlyLate.length).toFixed(1) : 0}</div>
          </div>
        </div>
        <div class="table-wrapper" style="margin-bottom:20px">
          <table>
            <thead>
              <tr>
                <th>Week (Mon)</th><th>Shifts</th><th>🌅 Early (06:45)</th><th>🌆 Late (ends 19:15+)</th><th>Split</th>
              </tr>
            </thead>
            <tbody>
              ${weeklyEarlyLate.map(w => {
                const earlyPct = w.total ? Math.round(w.early_count / w.total * 100) : 0;
                return `<tr>
                  <td><strong>${fmtDate(w.week_start)}</strong></td>
                  <td>${w.total}</td>
                  <td style="color:var(--success)">${w.early_count}</td>
                  <td style="color:var(--warning)">${w.late_count}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;min-width:100px">
                      <div style="flex:1;background:var(--border);border-radius:4px;height:6px;overflow:hidden;display:flex">
                        <div style="width:${earlyPct}%;background:var(--success);height:100%"></div>
                        <div style="width:${100 - earlyPct}%;background:var(--warning);height:100%"></div>
                      </div>
                      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${earlyPct}% E</span>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : ''}

        ${monthlyWeekends.length ? `
        <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">
          📅 Weekend shifts per month
        </h4>
        <div class="stats-grid" style="margin-bottom:12px;grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
          <div class="stat-card"><div class="stat-label">Saturdays worked</div><div class="stat-value">${totalSats}</div></div>
          <div class="stat-card"><div class="stat-label">Sundays worked</div><div class="stat-value">${totalSuns}</div></div>
          <div class="stat-card"><div class="stat-label">Avg Sat/month</div><div class="stat-value">${monthlyWeekends.length ? (totalSats / monthlyWeekends.length).toFixed(1) : 0}</div></div>
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Month</th><th>🟡 Saturdays</th><th>🔴 Sundays</th><th>Total days</th></tr>
            </thead>
            <tbody>
              ${monthlyWeekends.map(m => `<tr>
                <td><strong>${fmtMonth(m.month)}</strong></td>
                <td>${m.saturday_count || 0}</td>
                <td>${m.sunday_count || 0}</td>
                <td style="color:var(--text-muted)">${(m.saturday_count || 0) + (m.sunday_count || 0)}</td>
              </tr>`).join('')}
              <tr style="font-weight:700;border-top:2px solid var(--border)">
                <td>TOTAL</td><td>${totalSats}</td><td>${totalSuns}</td><td>${totalSats + totalSuns}</td>
              </tr>
            </tbody>
          </table>
        </div>` : ''}

      </div>`;
  }
};

// ── Local helper ──────────────────────────────────────────────────────────────────────────────
function fmtMins(mins) {
  if (!mins) return '0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
