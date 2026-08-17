/* ─── Payslips View ───────────────────────────────────────────────────────── */

const PayslipsView = {
  payslips: [],
  taxRefunds: [],
  allPayslips: [],   // all years — used for financial-year YTD calculations
  settings: {},
  currentYear: getCurrentYear(),

  async init() {
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-payslips');
    el.innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
          <select id="payslipYearSelect" style="width:auto">
            ${getYears().map(y => `<option value="${y}" ${y == this.currentYear ? 'selected':''}>${y}</option>`).join('')}
          </select>
        </div>
        <div class="toolbar-right" style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="importPayslipPhotoBtn" title="Read a payslip photo with AI and pre-fill the form">📷 Import from Photo</button>
          <input type="file" id="payslipPhotoInput" accept="image/*" style="display:none" />
          <button class="btn btn-primary" id="addPayslipBtn">+ Add Payslip</button>
        </div>
      </div>

      <!-- Year totals -->
      <div class="stats-grid" id="payslipYearStats"></div>

      <!-- Tracking table -->
      <div class="table-wrapper">
        <table id="payslipsTable">
          <thead>
            <tr>
              <th title="Pay period (year-month)">Month</th>
              <th title="Total hours for the month from your logged shifts — includes shifts not worked yet">Hours</th>
              <th title="Total miles driven to work this month">Distance</th>
              <th title="What the app calculates you should earn for the whole month based on all logged shifts (worked and upcoming) and your pay rate">Shifts Est.</th>
              <th title="Your contracted basic salary for this month, before any extras">Basic Pay</th>
              <th title="Extra hours worked this month beyond your contracted hours, shown as hours and £">Extra Hrs</th>
              <th title="Adjustments carried over from the previous month — e.g. arrears, extra hours, or annual leave corrections paid a month late">Prev Month</th>
              <th title="Total gross pay shown on your payslip for this month — includes basic, extras, and all adjustments">Gross (Payslip)</th>
              <th title="The true total earned for this calendar month: this month's own pay items plus any adjustments for this month that were paid in the next payslip">Month Total</th>
              <th title="The actual amount paid into your bank after tax, NI, and deductions">Net (Paid)</th>
              <th title="Was I paid enough? Compares what was paid (Month Total) against your shifts estimate. ✓ green = paid more than estimated. ⚠️ red = paid less than estimated — worth checking your payslip. Only shows once the following month's payslip has been entered.">Paid vs Est.</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="payslipsTbody">
            <tr><td colspan="12" style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Hours vs contract — helps explain why a month's pay came in low -->
      <div id="monthComparisonSection" style="margin-top:24px"></div>

      <!-- Year-to-date running totals -->
      <div id="ytdSection" style="margin-top:24px"></div>
      <div id="psTaxRefundsSection" style="margin-top:24px"></div>
    `;

    document.getElementById('payslipYearSelect').addEventListener('change', e => {
      this.currentYear = e.target.value;
      this.load();
    });

    document.getElementById('addPayslipBtn').addEventListener('click', () => this.openAddModal());

    document.getElementById('importPayslipPhotoBtn').addEventListener('click', () =>
      document.getElementById('payslipPhotoInput').click());
    document.getElementById('payslipPhotoInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._importPayslipPhoto(file);
      e.target.value = '';
    });
  },

  // Read a payslip photo with Gemini, then open the Add/Edit modal pre-filled with
  // whatever it found — figures are never saved automatically, always reviewed first.
  async _importPayslipPhoto(file) {
    showToast('Reading payslip with Gemini…', 'info');
    try {
      const result = await API.extractPayslipPhoto(file);
      const data = result.data || {};
      const month = data.month || getCurrentMonth();
      const existing = this.payslips.find(p => p.month === month);
      if (existing) {
        Modal.open('Edit Payslip (from photo — review before saving)', this.payslipFormHtml({ ...existing, ...data }));
        this.wirePayslipForm(existing.id);
      } else {
        Modal.open('Add Payslip (from photo — review before saving)', this.payslipFormHtml(data));
        this.wirePayslipForm(null);
      }
      const usedFallback = result.model_used && App.settings?.gemini_model && result.model_used !== App.settings.gemini_model;
      showToast(
        usedFallback
          ? `Payslip read via ${result.model_used} (your configured model was overloaded) — check the figures before saving`
          : 'Payslip read — check the figures before saving',
        'success'
      );
    } catch (e) {
      showToast('Failed to read payslip: ' + e.message, 'error');
    }
  },

  async load() {
    try {
      [this.payslips, this.allPayslips, this.monthly, this.settings, this.taxRefunds, this.payRates] = await Promise.all([
        API.getPayslips({ year: this.currentYear }),
        API.getPayslips({}),          // all years — for financial-year YTD
        API.getMonthlyReport({ year: this.currentYear }),
        API.getSettings(),
        API.get('/api/tax-refunds'),
        API.getPayRates(),
      ]);
      this.renderStats();
      this.renderTable();
      this.renderMonthComparison();
      this.renderYtd();
      this.renderTaxRefunds();
    } catch(e) { showToast('Failed to load payslips: ' + e.message, 'error'); }
  },

  // Hourly rate in effect for a given YYYY-MM month — latest pay_rates row whose
  // effective_date falls on or before the 1st of that month (mirrors the server's
  // getRateForMonth in /api/reports/monthly).
  _rateForMonth(month) {
    const firstDay = month + '-01';
    let rate = null;
    for (const r of (this.payRates || []).slice().sort((a, b) => a.effective_date.localeCompare(b.effective_date))) {
      if (r.effective_date <= firstDay) rate = r;
    }
    return rate ? rate.hourly_rate : 0;
  },

  renderStats() {
    const totalGross = this.payslips.reduce((s,p) => s + (p.total_gross  || 0), 0);
    const totalNet   = this.payslips.reduce((s,p) => s + (p.net_payment  || 0), 0);
    const totalTax   = this.payslips.reduce((s,p) => s + (p.tax_paid     || 0), 0);
    const totalNI    = this.payslips.reduce((s,p) => s + (p.ni_employee  || 0), 0);
    const shiftEst   = this.monthly.reduce((s,m) => s + (m.scheduled_pay ?? m.calculated_pay ?? 0) + (m.leave_pay || 0), 0);
    const diff       = totalGross - shiftEst;  // positive = paid more than estimated (good)

    document.getElementById('payslipYearStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Gross (${this.currentYear})</div>
        <div class="stat-value">${fmtCurrency(totalGross)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Net Paid</div>
        <div class="stat-value success">${fmtCurrency(totalNet)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tax Paid</div>
        <div class="stat-value warning">${fmtCurrency(totalTax)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">NI (Employee)</div>
        <div class="stat-value warning">${fmtCurrency(totalNI)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Shifts Estimated</div>
        <div class="stat-value">${fmtCurrency(shiftEst)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Paid vs Estimated</div>
        <div class="stat-value ${diff >= 0 ? 'success' : 'danger'}" title="${diff >= 0 ? 'Paid more than shift estimate — looks good' : 'Paid less than shift estimate — worth checking'}">${diff >= 0 ? '+' : '-'}${fmtCurrency(Math.abs(diff))}</div>
      </div>
    `;
  },

  renderTable() {
    const tbody = document.getElementById('payslipsTbody');

    const monthMap = {};
    this.payslips.forEach(p => { monthMap[p.month] = { payslip: p, shiftData: null }; });
    this.monthly.forEach(m => {
      if (!monthMap[m.month]) monthMap[m.month] = { payslip: null, shiftData: m };
      else monthMap[m.month].shiftData = m;
    });

    const months = Object.keys(monthMap).sort((a,b) => b.localeCompare(a));

    // Build a lookup: month → next/prev month's payslip (for "Month Total" column)
    const payslipByMonth = {};
    this.payslips.forEach(p => { payslipByMonth[p.month] = p; });
    const nextMonth = nextMonthStr;
    const prevMonth = (m) => {
      const [y, mo] = m.split('-').map(Number);
      const d = new Date(y, mo - 2, 1); // one month back
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    // "Paid in next month" helpers — per-month flag stored in settings
    const isPaidInNext  = (m) => this.settings[`paid_in_next_${m}`] === '1';
    const shiftMapByMonth = {};
    this.monthly.forEach(m => { shiftMapByMonth[m.month] = m; });

    if (!months.length) {
      tbody.innerHTML = `<tr><td colspan="12">
        <div class="empty-state">
          <div class="empty-state-icon">💰</div>
          <div class="empty-state-text">No payslips for ${this.currentYear}</div>
          <div class="empty-state-sub">Add your first payslip or check the year filter</div>
        </div>
      </td></tr>`;
      return;
    }

    // Collect large discrepancies for a banner alert
    const bigDiscrepancies = [];

    tbody.innerHTML = months.map(month => {
      const { payslip: p, shiftData: sd } = monthMap[month];

      // If previous month was "paid in next", fold its shift pay into this month's total
      const prev          = prevMonth(month);
      const prevMerged    = isPaidInNext(prev);
      const prevShiftData = prevMerged ? shiftMapByMonth[prev] : null;
      const prevShiftPay  = prevMerged ? ((prevShiftData?.scheduled_pay ?? prevShiftData?.calculated_pay ?? 0) + (prevShiftData?.leave_pay || 0)) : 0;

      const ownShiftPay = sd ? (sd.scheduled_pay ?? sd.calculated_pay ?? 0) + (sd.leave_pay || 0) : null;
      const shiftPay    = ownShiftPay !== null || prevShiftPay > 0
        ? (ownShiftPay || 0) + prevShiftPay
        : null;

      const gross    = p  ? (p.total_gross     || 0) : null;

      // If this month itself is flagged "paid in next", suppress diff entirely
      const thisMerged = !p && isPaidInNext(month);

      // Month Total = this month's "own" items + next month's prev-month adjustments for this month
      const next = payslipByMonth[nextMonth(month)];
      const monthTotal = (() => {
        if (!p && !next) return null;
        let total = 0;
        if (p) {
          total += (p.basic_pay || 0)
                +  (p.additional_hours_pay || 0)
                +  (p.annual_leave_adj_curr || 0)
                +  (p.bank_hol_curr_amount || 0)
                +  (!p.company_sick_pay_is_prev ? (p.company_sick_pay || 0) : 0);
        }
        if (next) {
          total += (next.arrears_pay || 0)
                +  (next.addt_hours_prev_amount || 0)
                +  (next.annual_leave_adj_prev || 0)
                +  (next.bank_hol_prev_amount || 0)
                +  (next.company_sick_pay_is_prev ? (next.company_sick_pay || 0) : 0);
        }
        return total || null;
      })();

      // Use monthTotal for the diff when available — it correctly accounts for
      // items paid a month late (e.g. extra hours in next month's payslip).
      // Fall back to gross if monthTotal isn't ready yet (next payslip not entered).
      const compareTotal = monthTotal ?? gross;
      // positive = paid more than estimated (good/green), negative = underpaid (bad/red)
      const diff = thisMerged ? null
        : (shiftPay !== null && compareTotal !== null ? compareTotal - shiftPay : null);

      // Only warn when underpaid by more than £5 (diff < 0 means paid < estimated)
      const isLargeDiff = diff !== null && diff < -5 && !thisMerged;
      if (isLargeDiff) bigDiscrepancies.push({ month, diff });

      // Shift est. label — show combined note if prev month was merged or leave pay included
      const hasLeave = sd && (sd.leave_pay || 0) > 0;
      const shiftPayLabel = shiftPay !== null
        ? (() => {
            let label = fmtCurrency(shiftPay);
            const notes = [];
            if (prevMerged) notes.push(`incl. ${fmtMonth(prev)} shifts`);
            if (hasLeave) notes.push(`incl. ~${fmtCurrency(sd.leave_pay)} leave`);
            if (notes.length) label += ` <span style="font-size:11px;color:var(--text-muted)" title="${notes.join(', ')}">(${notes.map((n,i) => i===0 && prevMerged ? `+${fmtMonth(prev)}` : '🏖️').join(' ')})</span>`;
            return label;
          })()
        : '—';

      const diffHtml = thisMerged
        ? `<span style="font-size:11px;color:var(--text-muted)">→ paid in ${fmtMonth(nextMonth(month))}</span>`
        : diff !== null
          ? isLargeDiff
            ? `<span class="diff-alert diff-alert-under" title="Paid less than shift estimate — check your payslip">⚠️ -${fmtCurrency(Math.abs(diff))}</span>`
            : diff > 5
              ? `<span class="diff-pos" title="Paid more than shift estimate">✓ +${fmtCurrency(diff)}</span>`
              : `<span style="color:var(--text-muted)" title="Within £5 of estimate">~</span>`
          : '—';

      const mergeBtn = !p
        ? `<button class="btn btn-sm btn-ghost paid-in-next-btn" data-month="${month}"
             title="${thisMerged ? 'Unmark: include this month\'s shifts in its own comparison' : 'Mark: this month\'s shifts were paid in the next month\'s payslip'}"
             style="${thisMerged ? 'color:var(--primary);border-color:var(--primary)' : ''}">
             ${thisMerged ? '📎 Merged' : '📎 Merge →'}
           </button>`
        : '';

      return `<tr${isLargeDiff ? ' class="payslip-discrepancy-row"' : ''}>
        <td><strong>${fmtMonth(month)}</strong></td>
        <td>${sd ? fmtHours(sd.scheduled_hours ?? sd.hours_worked) : '—'}</td>
        <td>${sd ? fmtMiles(sd.distance_miles) : '—'}</td>
        <td>${shiftPayLabel}</td>
        <td>${p ? fmtCurrency(p.basic_pay) : '—'}</td>
        <td>${p && p.additional_hours_qty ? `${p.additional_hours_qty}h &nbsp;${fmtCurrency(p.additional_hours_pay)}` : '—'}</td>
        <td>${(() => {
          if (!p) return '—';
          const total = (p.arrears_pay || 0) + (p.addt_hours_prev_amount || 0) +
                        (p.annual_leave_adj_prev || 0) + (p.bank_hol_prev_amount || 0);
          return total ? fmtCurrency(total) : '—';
        })()}</td>
        <td><strong>${p ? fmtCurrency(p.total_gross) : '—'}</strong></td>
        <td style="font-weight:600">${monthTotal !== null ? fmtCurrency(monthTotal) : '—'}</td>
        <td style="color:var(--success);font-weight:600">${p ? fmtCurrency(p.net_payment) : '—'}</td>
        <td>${diffHtml}</td>
        <td class="actions">
          ${p
            ? `<button class="btn btn-sm btn-ghost edit-payslip-btn" title="Edit payslip" data-id="${p.id}">✏️ Edit</button>
               <button class="btn-icon danger delete-payslip-btn" title="Delete" data-id="${p.id}" style="margin-left:4px">🗑️</button>`
            : `<button class="btn btn-sm btn-ghost add-payslip-month-btn" data-month="${month}">+ Add</button>`
          }
          ${mergeBtn}
        </td>
      </tr>`;
    }).join('');

    // Render or remove the discrepancy banner above the table
    const existingBanner = document.getElementById('payslipDiscrepancyBanner');
    if (existingBanner) existingBanner.remove();
    if (bigDiscrepancies.length > 0) {
      const banner = document.createElement('div');
      banner.id = 'payslipDiscrepancyBanner';
      banner.className = 'discrepancy-banner';
      banner.innerHTML = `
        <span class="discrepancy-banner-icon">⚠️</span>
        <div>
          <strong>Possible underpayment</strong> —
          ${bigDiscrepancies.map(d =>
            `${fmtMonth(d.month)}: paid ${fmtCurrency(Math.abs(d.diff))} less than shift estimate`
          ).join('; ')}
        </div>`;
      const tableWrapper = document.querySelector('.table-wrapper');
      if (tableWrapper) tableWrapper.insertAdjacentElement('beforebegin', banner);
    }

    tbody.querySelectorAll('.edit-payslip-btn').forEach(btn =>
      btn.addEventListener('click', () => this.openEditModal(+btn.dataset.id))
    );
    tbody.querySelectorAll('.delete-payslip-btn').forEach(btn =>
      btn.addEventListener('click', () => this.deletePayslip(+btn.dataset.id))
    );
    tbody.querySelectorAll('.add-payslip-month-btn').forEach(btn =>
      btn.addEventListener('click', () => this.openAddModal(btn.dataset.month))
    );
    tbody.querySelectorAll('.paid-in-next-btn').forEach(btn =>
      btn.addEventListener('click', () => this.togglePaidInNext(btn.dataset.month))
    );
  },

  // Hours vs Contract — a diagnostic view separate from the main table. The main
  // table's "Paid vs Est." tells you THAT a month came in low; this tells you
  // whether fewer logged hours than your contract is WHY, so you're not left
  // wondering if it's a payroll error when it's actually just a quieter rota.
  renderMonthComparison() {
    const el = document.getElementById('monthComparisonSection');
    if (!el) return;
    if (!this.monthly || !this.monthly.length) { el.innerHTML = ''; return; }

    const months = [...this.monthly].sort((a, b) => b.month.localeCompare(a.month));

    const rows = months.map(m => {
      const contracted = m.contracted_hours || 0;
      const logged     = m.scheduled_hours  || 0;
      const hrsDiff     = logged - contracted;
      const rate        = this._rateForMonth(m.month);
      const hrsDiffPay  = hrsDiff * rate;

      let note, noteColour;
      if (contracted === 0) {
        note = 'No contracted hours set for this month'; noteColour = 'var(--text-muted)';
      } else if (Math.abs(hrsDiff) < 1) {
        note = 'On contract'; noteColour = 'var(--text-muted)';
      } else if (hrsDiff < 0) {
        note = `${fmtHours(Math.abs(hrsDiff))} under contract ${rate ? `(≈ ${fmtCurrency(Math.abs(hrsDiffPay))} less)` : ''}`;
        noteColour = 'var(--danger)';
      } else {
        note = `${fmtHours(hrsDiff)} over contract ${rate ? `(≈ +${fmtCurrency(hrsDiffPay)})` : ''}`;
        noteColour = 'var(--success)';
      }

      return `<tr>
        <td><strong>${fmtMonth(m.month)}</strong></td>
        <td>${contracted ? fmtHours(contracted) : '—'}</td>
        <td>${logged ? fmtHours(logged) : '—'}</td>
        <td style="color:${hrsDiff < 0 ? 'var(--danger)' : hrsDiff > 0 ? 'var(--success)' : 'var(--text-muted)'}">
          ${hrsDiff ? (hrsDiff > 0 ? '+' : '') + fmtHours(hrsDiff) : '—'}
        </td>
        <td>${rate ? fmtCurrency(rate) + '/hr' : '—'}</td>
        <td style="color:${noteColour}">${note}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>📊 Hours vs Contract</h2>
        </div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
            Compares your contracted hours against hours actually logged (worked + upcoming shifts) each month —
            useful for telling whether a low "Paid vs Est." month above was really just fewer hours on the rota,
            rather than a payroll mistake.
          </p>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th title="Your contracted hours for this month, based on your pay rate settings">Contracted Hrs</th>
                  <th title="Total hours from your logged shifts this month — includes shifts not worked yet">Logged Hrs</th>
                  <th>Hours Diff</th>
                  <th title="Hourly rate in effect for this month">Rate</th>
                  <th>What this means</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

  async togglePaidInNext(month) {
    const key     = `paid_in_next_${month}`;
    const current = this.settings[key] === '1';
    try {
      this.settings = await API.saveSettings({ [key]: current ? '0' : '1' });
      this.renderTable();
      showToast(current ? 'Merge removed' : `${fmtMonth(month)} shifts merged into ${fmtMonth(nextMonthStr(month))} ✓`, 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  renderYtd() {
    const el = document.getElementById('ytdSection');
    const latest = [...this.payslips].sort((a,b) => b.month.localeCompare(a.month))[0];
    if (!latest || !latest.gross_ytd) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Year to Date (from last payslip)</h2></div>
        <div class="card-body">
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">Gross YTD</div><div class="stat-value">${fmtCurrency(latest.gross_ytd)}</div></div>
            <div class="stat-card"><div class="stat-label">Taxable YTD</div><div class="stat-value">${fmtCurrency(latest.taxable_ytd)}</div></div>
            <div class="stat-card"><div class="stat-label">Tax YTD</div><div class="stat-value warning">${fmtCurrency(latest.tax_ytd)}</div></div>
            <div class="stat-card"><div class="stat-label">NI'able YTD</div><div class="stat-value">${fmtCurrency(latest.ni_able_ytd)}</div></div>
          </div>
        </div>
      </div>`;
  },

  renderTaxRefunds() {
    const el = document.getElementById('psTaxRefundsSection');
    if (!el) return;
    const refunds = this.taxRefunds || [];

    // Group by UK tax year and sum (read-only summary — full management lives in Reports → Tax Year)
    const byYear = {};
    refunds.forEach(r => {
      if (!byYear[r.tax_year]) byYear[r.tax_year] = { total: 0, entries: [] };
      byYear[r.tax_year].total += r.amount;
      byYear[r.tax_year].entries.push(r);
    });
    const yearKeys = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
    const totalAll = refunds.reduce((s, r) => s + r.amount, 0);

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>Tax Refunds <span style="font-size:12px;font-weight:400;color:var(--text-muted)">· by UK tax year</span></h2>
          <button class="btn btn-ghost btn-sm" id="manageRefundsBtn">📊 Manage in Reports → Tax Year</button>
        </div>
        <div class="card-body">
          ${yearKeys.length ? `
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              ${yearKeys.map(y => `
                <div class="stat-card" style="min-width:140px;text-align:center">
                  <div class="stat-label">${esc(y)}</div>
                  <div class="stat-value" style="color:var(--success)">${fmtCurrency(byYear[y].total)}</div>
                  <div style="font-size:11px;color:var(--text-muted)">${byYear[y].entries.length} refund${byYear[y].entries.length !== 1 ? 's' : ''}</div>
                </div>`).join('')}
              ${yearKeys.length > 1 ? `
                <div class="stat-card" style="min-width:140px;text-align:center">
                  <div class="stat-label">All tax years</div>
                  <div class="stat-value" style="color:var(--success)">${fmtCurrency(totalAll)}</div>
                </div>` : ''}
            </div>
            <p style="font-size:12px;color:var(--text-muted);margin-top:12px">
              Refunds are tracked against the UK tax year (6 Apr – 5 Apr). Add, edit or delete them under <strong>Reports → 🏛️ Tax Year</strong>.
            </p>` :
            '<p style="color:var(--text-muted);font-size:13px">No tax refunds recorded yet. Add them under <strong>Reports → 🏛️ Tax Year</strong>.</p>'
          }
        </div>
      </div>`;

    document.getElementById('manageRefundsBtn')?.addEventListener('click', () => {
      if (window.ReportsView) ReportsView.activeTab = 'tax-year';
      App.navigate('reports');
    });
  },

  openAddTaxRefundModal() {
    // Guess current UK tax year
    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const defaultYear = `${y}-${String(y + 1).slice(-2)}`;

    Modal.open('Add Tax Refund', `
      <div class="form-group">
        <label>Tax Year *</label>
        <input type="text" id="trYear" class="form-control" value="${defaultYear}" placeholder="e.g. 2024-25" />
        <div class="form-hint">UK tax year format, e.g. 2024-25</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Amount (£) *</label>
          <input type="number" id="psTrAmount" class="form-control" step="0.01" min="0" placeholder="0.00" />
        </div>
        <div class="form-group">
          <label>Date received</label>
          <input type="date" id="psTrDate" class="form-control" />
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input type="text" id="psTrNotes" class="form-control" placeholder="e.g. HMRC P800 refund" />
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="trSaveBtn">Save</button>
      </div>`);

    document.getElementById('trSaveBtn').addEventListener('click', async () => {
      const tax_year = document.getElementById('trYear').value.trim();
      const amount   = parseFloat(document.getElementById('psTrAmount').value);
      const date     = document.getElementById('psTrDate').value || null;
      const notes    = document.getElementById('psTrNotes').value.trim() || null;
      if (!tax_year || isNaN(amount) || amount <= 0) {
        showToast('Tax year and a positive amount are required', 'error'); return;
      }
      try {
        await API.post('/api/tax-refunds', { tax_year, amount, date, notes });
        Modal.close();
        showToast('Tax refund saved ✓', 'success');
        await this.load();
      } catch(e) { showToast(e.message, 'error'); }
    });
  },

  async deleteTaxRefund(id) {
    if (!confirm('Delete this refund entry?')) return;
    try {
      await API.delete(`/api/tax-refunds/${id}`);
      showToast('Deleted', 'success');
      await this.load();
    } catch(e) { showToast(e.message, 'error'); }
  },

  openAddModal(prefillMonth) {
    const month = prefillMonth || getCurrentMonth();
    // If a payslip already exists for this month, go straight to edit
    const existing = this.payslips.find(p => p.month === month);
    if (existing) {
      this.openEditModal(existing.id);
      return;
    }
    Modal.open('Add Payslip', this.payslipFormHtml({ month }));
    this.wirePayslipForm(null);
  },

  openEditModal(id) {
    const p = this.payslips.find(p => p.id === id);
    if (!p) return;
    Modal.open('Edit Payslip', this.payslipFormHtml(p));
    this.wirePayslipForm(id);
  },

  // ── Toggle helpers ──────────────────────────────────────────────────────────

  _toggleSection(toggleId, sectionId) {
    const cb  = document.getElementById(toggleId);
    const sec = document.getElementById(sectionId);
    if (!cb || !sec) return;
    sec.style.display = cb.checked ? 'block' : 'none';
  },

  _bindToggle(toggleId, sectionId) {
    const cb = document.getElementById(toggleId);
    if (!cb) return;
    this._toggleSection(toggleId, sectionId);
    cb.addEventListener('change', () => this._toggleSection(toggleId, sectionId));
  },

  // ── Form HTML ───────────────────────────────────────────────────────────────

  payslipFormHtml(p = {}) {
    const v  = (k, def = '') => (p[k] != null && p[k] !== 0) ? p[k] : def;
    const vn = (k)           => (p[k] != null && p[k] !== 0) ? p[k] : '';

    // Determine which toggles should be ON (because the existing payslip has values)
    const hasPrevMonth   = !!(p.arrears_pay || p.addt_hours_prev_qty || p.addt_hours_prev_amount || p.annual_leave_adj_prev);
    const hasALCurr      = !!p.annual_leave_adj_curr;
    const hasBankHol     = !!(p.bank_hol_curr_qty || p.bank_hol_curr_amount || p.bank_hol_prev_qty || p.bank_hol_prev_amount);
    const hasSickPay     = !!p.company_sick_pay;
    const hasSIP         = !!p.sip_contribution;
    const hasSharesave   = !!(p.sharesave_amount || p.sharesave_description);
    const hasOtherPay   = !!(p.other_payments || p.other_pay_description);

    const chk = (val) => val ? 'checked' : '';

    return `
<p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
  Enter figures directly from your payslip. Toggle optional line items to show/hide fields.
</p>

<!-- Header row -->
<div class="form-row">
  <div class="form-group">
    <label>Month *</label>
    <select id="pfMonth">${getMonthOptions(p.month || getCurrentMonth())}</select>
  </div>
  <div class="form-group">
    <label>Payment Date</label>
    <input type="date" id="pfPayDate" value="${esc(p.payment_date || '')}" />
  </div>
</div>

<!-- ══════════════════════════════════════════════ PAYMENTS ══ -->
<div class="section-label" style="margin:12px -20px 0;padding:6px 20px;background:var(--primary);color:#1B2A4A;font-weight:700;font-size:13px;letter-spacing:.05em">
  PAYMENTS
</div>

<!-- Always-visible: Basic Salary (this month) -->
<div style="padding:10px 0 0">
  <div class="form-row">
    <div class="form-group">
      <label>Basic Salary <span style="font-size:11px;color:var(--text-muted)">(this month)</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfBasicPay" step="0.01" value="${vn('basic_pay')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- Always-visible: Additional Hours (this month) -->
<div style="padding:2px 0 0">
  <div class="form-row">
    <div class="form-group">
      <label>Additional Hours <span style="font-size:11px;color:var(--text-muted)">(this month) — hrs</span></label>
      <input type="number" id="pfExtraQty" step="0.01" value="${vn('additional_hours_qty')}" placeholder="0.00" />
    </div>
    <div class="form-group">
      <label>Additional Hours <span style="font-size:11px;color:var(--text-muted)">(this month) — £</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfExtraPay" step="0.01" value="${vn('additional_hours_pay')}" placeholder="0.00" /></div>
    </div>
  </div>
</div>

<!-- ── Toggle: Prev Month Items ── -->
<div class="toggle-header" style="margin-top:10px">
  <label class="toggle-label">
    <input type="checkbox" id="togPrevMonth" ${chk(hasPrevMonth)} />
    <span>Previous Month Adjustments</span>
    <span class="toggle-hint">Basic Salary arrears, Addt Hours, Annual Leave</span>
  </label>
</div>
<div id="secPrevMonth" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Basic Salary <span style="font-size:11px;color:var(--text-muted)">(prev month) — can be negative</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfArrears" step="0.01" value="${vn('arrears_pay')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>Additional Hours <span style="font-size:11px;color:var(--text-muted)">(prev month) — hrs</span></label>
      <input type="number" id="pfPrevExtraQty" step="0.01" value="${vn('addt_hours_prev_qty')}" placeholder="0.00" />
    </div>
    <div class="form-group">
      <label>Additional Hours <span style="font-size:11px;color:var(--text-muted)">(prev month) — £</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfPrevExtraPay" step="0.01" value="${vn('addt_hours_prev_amount')}" placeholder="0.00" /></div>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>Annual Leave Adj <span style="font-size:11px;color:var(--text-muted)">(prev month) — can be negative</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfALPrev" step="0.01" value="${vn('annual_leave_adj_prev')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- ── Toggle: Annual Leave Adj (this month) ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togALCurr" ${chk(hasALCurr)} />
    <span>Annual Leave Adj <span style="font-size:11px;font-weight:400">(this month)</span></span>
  </label>
</div>
<div id="secALCurr" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Annual Leave Adj <span style="font-size:11px;color:var(--text-muted)">(this month) — can be negative</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfALCurr" step="0.01" value="${vn('annual_leave_adj_curr')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- ── Toggle: Bank Holiday Hours ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togBankHol" ${chk(hasBankHol)} />
    <span>Bank Holiday Hours</span>
  </label>
</div>
<div id="secBankHol" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Bank Holiday Hrs <span style="font-size:11px;color:var(--text-muted)">(this month) — hrs</span></label>
      <input type="number" id="pfBHCurrQty" step="0.01" value="${vn('bank_hol_curr_qty')}" placeholder="0.00" />
    </div>
    <div class="form-group">
      <label>Bank Holiday Hrs <span style="font-size:11px;color:var(--text-muted)">(this month) — £</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfBHCurrAmt" step="0.01" value="${vn('bank_hol_curr_amount')}" placeholder="0.00" /></div>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>Bank Holiday Hrs <span style="font-size:11px;color:var(--text-muted)">(prev month) — hrs</span></label>
      <input type="number" id="pfBHPrevQty" step="0.01" value="${vn('bank_hol_prev_qty')}" placeholder="0.00" />
    </div>
    <div class="form-group">
      <label>Bank Holiday Hrs <span style="font-size:11px;color:var(--text-muted)">(prev month) — £</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfBHPrevAmt" step="0.01" value="${vn('bank_hol_prev_amount')}" placeholder="0.00" /></div>
    </div>
  </div>
</div>

<!-- ── Toggle: Company Sick Pay ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togSickPay" ${chk(hasSickPay)} />
    <span>Company Sick Pay</span>
  </label>
</div>
<div id="secSickPay" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Company Sick Pay — £ <span style="font-size:11px;color:var(--text-muted)">(can be negative)</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfSickPay" step="0.01" value="${vn('company_sick_pay')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group">
      <label>Period</label>
      <div style="display:flex;gap:16px;align-items:center;padding-top:6px">
        <label style="margin:0;font-weight:400;cursor:pointer">
          <input type="radio" name="sickPayPeriod" id="sickPayCurr" value="0" ${!p.company_sick_pay_is_prev ? 'checked' : ''} />
          This month
        </label>
        <label style="margin:0;font-weight:400;cursor:pointer">
          <input type="radio" name="sickPayPeriod" id="sickPayPrev" value="1" ${p.company_sick_pay_is_prev ? 'checked' : ''} />
          Prev month
        </label>
      </div>
    </div>
  </div>
</div>

<!-- ── Toggle: SIP Contribution ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togSIP" ${chk(hasSIP)} />
    <span>SIP Contribution <span style="font-size:11px;font-weight:400">(share incentive plan — reduces gross)</span></span>
  </label>
</div>
<div id="secSIP" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>SIP Contribution — £ <span style="font-size:11px;color:var(--text-muted)">(enter as negative, e.g. −50.00)</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfSIP" step="0.01" value="${vn('sip_contribution')}" placeholder="-50.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- ── Toggle: Other Pay ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togOtherPay" ${chk(hasOtherPay)} />
    <span>Other Pay</span>
  </label>
  <span class="toggle-hint">Any other payment line (e.g. SSP, bonus)</span>
</div>
<div id="secOtherPay" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Description <span style="font-size:11px;color:var(--text-muted)">(e.g. SSP Paid Days Jan)</span></label>
      <input type="text" id="pfOtherPayDesc" value="${esc(p.other_pay_description || '')}" placeholder="e.g. SSP Paid Days Jan" />
    </div>
    <div class="form-group">
      <label>Amount — £</label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfOtherPayAmt" step="0.01" value="${vn('other_payments')}" placeholder="0.00" /></div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════ DEDUCTIONS ══ -->
<div class="section-label" style="margin:14px -20px 0;padding:6px 20px;background:var(--primary);color:#1B2A4A;font-weight:700;font-size:13px;letter-spacing:.05em">
  DEDUCTIONS
</div>

<div style="padding:10px 0 0">
  <div class="form-row">
    <div class="form-group">
      <label>Tax Paid</label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfTax" step="0.01" value="${vn('tax_paid')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group">
      <label>National Insurance <span style="font-size:11px;color:var(--text-muted)">(employee)</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfNI" step="0.01" value="${vn('ni_employee')}" placeholder="0.00" /></div>
    </div>
  </div>
</div>

<!-- ── Toggle: Sharesave ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togSharesave" ${chk(hasSharesave)} />
    <span>Sharesave</span>
  </label>
</div>
<div id="secSharesave" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>Sharesave — £</label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfSharesaveAmt" step="0.01" value="${p.sharesave_amount != null && p.sharesave_amount !== 0 ? p.sharesave_amount : 250}" placeholder="250" /></div>
    </div>
    <div class="form-group">
      <label>Description <span style="font-size:11px;color:var(--text-muted)">(e.g. Nov25 3yrs £250)</span></label>
      <input type="text" id="pfSharesaveDesc" value="${esc(p.sharesave_description || '')}" placeholder="optional" />
    </div>
  </div>
</div>

<!-- ── NI Employer (optional) ── -->
<div class="toggle-header">
  <label class="toggle-label">
    <input type="checkbox" id="togNIEmp" ${chk(p.ni_employer)} />
    <span>NI Employer <span style="font-size:11px;font-weight:400">(employer NI — informational)</span></span>
  </label>
</div>
<div id="secNIEmp" class="toggle-section">
  <div class="form-row">
    <div class="form-group">
      <label>NI Employer — £</label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfNIEmp" step="0.01" value="${vn('ni_employer')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- ══════════════════════════════════════════════ TOTALS ══ -->
<div class="section-label" style="margin:14px -20px 0;padding:6px 20px;background:var(--primary);color:#1B2A4A;font-weight:700;font-size:13px;letter-spacing:.05em">
  TOTALS <span style="font-weight:400;font-size:11px;opacity:.8">(auto-calculated from above if left blank)</span>
</div>
<div style="padding:10px 0 0">
  <div class="form-row">
    <div class="form-group">
      <label>
        Total Gross Payments
        <button type="button" id="pfCalcGrossBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto-calculate ↻</button>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfTotalGross" step="0.01" value="${vn('total_gross')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group">
      <label>
        Total Deductions
        <button type="button" id="pfCalcDeducBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto-calculate ↻</button>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfDeductions" step="0.01" value="${vn('total_deductions')}" placeholder="0.00" /></div>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>
        Net Payment <span style="font-size:11px;color:var(--text-muted)">(actual amount paid into bank)</span>
        <button type="button" id="pfCalcNetBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto-calculate ↻</button>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfNetPay" step="0.01" value="${vn('net_payment')}" placeholder="0.00" /></div>
    </div>
    <div class="form-group"></div>
  </div>
</div>

<!-- ══════════════════════════════════════════════ YTD ══ -->
<div class="section-label" style="margin:14px -20px 0;padding:6px 20px;background:var(--primary);color:#1B2A4A;font-weight:700;font-size:13px;letter-spacing:.05em">
  YEAR TO DATE (from payslip) <span style="font-weight:400;font-size:11px;opacity:.8">(auto-calculated if left blank)</span>
</div>
<div style="padding:10px 0 0">
  <div class="form-row">
    <div class="form-group">
      <label>
        Gross Pay YTD
        <button type="button" id="pfCalcGrossYtdBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto ↻</button>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfGrossYtd" step="0.01" value="${vn('gross_ytd')}" /></div>
    </div>
    <div class="form-group">
      <label>
        Tax Paid YTD
        <button type="button" id="pfCalcTaxYtdBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto ↻</button>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfTaxYtd" step="0.01" value="${vn('tax_ytd')}" /></div>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group">
      <label>
        Taxable Pay YTD
        <button type="button" id="pfCalcTaxableYtdBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto ↻</button>
        <span style="font-size:11px;color:var(--text-muted)">(estimated — check against payslip)</span>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfTaxableYtd" step="0.01" value="${vn('taxable_ytd')}" /></div>
    </div>
    <div class="form-group">
      <label>
        NI'able Pay YTD
        <button type="button" id="pfCalcNiYtdBtn" class="btn btn-sm btn-ghost" style="margin-left:8px;padding:1px 8px;font-size:11px">Auto ↻</button>
        <span style="font-size:11px;color:var(--text-muted)">(estimated — check against payslip)</span>
      </label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfNiYtd" step="0.01" value="${vn('ni_able_ytd')}" /></div>
    </div>
  </div>
  <p style="font-size:11px;color:var(--text-muted);margin-top:4px">
    Gross/Tax YTD are exact running totals from your logged payslips. Taxable/NI'able YTD are estimated as
    Gross − SIP contribution (Sharesave isn't deducted pre-tax) — if your payslip shows a different figure, trust the payslip and enter it directly.
  </p>
</div>

<div class="form-group" style="margin-top:10px">
  <label>Notes</label>
  <textarea id="pfNotes" rows="2">${esc(p.notes || '')}</textarea>
</div>

<div class="modal-footer">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
  <button class="btn btn-primary" id="pfSaveBtn">Save Payslip</button>
</div>`;
  },

  // ── Wire toggles + auto-calc ────────────────────────────────────────────────

  wirePayslipForm(editId) {
    // Bind all toggle checkboxes
    const togglePairs = [
      ['togPrevMonth',  'secPrevMonth'],
      ['togALCurr',     'secALCurr'],
      ['togBankHol',    'secBankHol'],
      ['togSickPay',    'secSickPay'],
      ['togSIP',        'secSIP'],
      ['togSharesave',  'secSharesave'],
      ['togOtherPay',   'secOtherPay'],
      ['togNIEmp',      'secNIEmp'],
    ];
    togglePairs.forEach(([tid, sid]) => this._bindToggle(tid, sid));

    // Auto-calculate gross total
    const calcGross = () => {
      const basic    = pf('pfBasicPay');
      const extra    = pf('pfExtraPay');
      const arrears  = pfToggled('togPrevMonth', 'pfArrears');
      const prevExtr = pfToggled('togPrevMonth', 'pfPrevExtraPay');
      const alPrev   = pfToggled('togPrevMonth', 'pfALPrev');
      const alCurr   = pfToggled('togALCurr',    'pfALCurr');
      const bhCA     = pfToggled('togBankHol',   'pfBHCurrAmt');
      const bhPA     = pfToggled('togBankHol',   'pfBHPrevAmt');
      const sick     = pfToggled('togSickPay',   'pfSickPay');
      const sip      = pfToggled('togSIP',       'pfSIP');
      const other    = pfToggled('togOtherPay',  'pfOtherPayAmt');
      const total    = basic + extra + arrears + prevExtr + alPrev + alCurr + bhCA + bhPA + sick + sip + other;
      document.getElementById('pfTotalGross').value = round2(total);
    };

    // Auto-calculate deductions total
    const calcDeduc = () => {
      const tax   = pf('pfTax');
      const ni    = pf('pfNI');
      const saves = pfToggled('togSharesave', 'pfSharesaveAmt');
      const total = tax + ni + saves;
      document.getElementById('pfDeductions').value = round2(total);
    };

    const calcNet = () => {
      const gross  = pf('pfTotalGross');
      const deduc  = pf('pfDeductions');
      document.getElementById('pfNetPay').value = round2(gross - deduc);
    };

    document.getElementById('pfCalcGrossBtn').addEventListener('click', calcGross);
    document.getElementById('pfCalcDeducBtn').addEventListener('click', calcDeduc);
    document.getElementById('pfCalcNetBtn').addEventListener('click', calcNet);

    // YTD auto-calc from accumulated payslips in the same UK tax year (6 Apr - 5 Apr,
    // bucketed here by calendar month since that's how payslips are stored).
    // gross/tax are exact running sums of each month's own payslip figure.
    // taxable/ni are estimated as gross minus SIP contribution — SIP is a genuine
    // pre-tax salary sacrifice, Sharesave (SAYE) is deducted from net pay so it
    // doesn't reduce taxable/NI'able pay.
    const periodTaxableNiablePay = (grossVal) => {
      const sip = Math.abs(pfToggled('togSIP', 'pfSIP'));
      return grossVal - sip;
    };
    const calcYtd = (field) => {
      const month = document.getElementById('pfMonth').value;
      if (!month) { showToast('Select a month first', 'warning'); return; }
      const [y, m] = month.split('-').map(Number);
      const taxYearStart = m >= 4 ? String(y) + '-04' : String(y - 1) + '-04';
      const prev = PayslipsView.allPayslips.filter(p =>
        p.month >= taxYearStart && p.month < month && p.id !== editId
      );
      const thisGross = pf('pfTotalGross') || pf('pfBasicPay');
      if (field === 'gross') {
        const prevSum = prev.reduce((s, p) => s + (p.total_gross || 0), 0);
        document.getElementById('pfGrossYtd').value = round2(prevSum + thisGross);
      } else if (field === 'tax') {
        const prevSum = prev.reduce((s, p) => s + (p.tax_paid || 0), 0);
        document.getElementById('pfTaxYtd').value = round2(prevSum + pf('pfTax'));
      } else if (field === 'taxable') {
        // Re-derive each prior month's taxable pay the same way (gross - SIP) for consistency
        const prevSum = prev.reduce((s, p) => s + ((p.total_gross || 0) - Math.abs(p.sip_contribution || 0)), 0);
        document.getElementById('pfTaxableYtd').value = round2(prevSum + periodTaxableNiablePay(thisGross));
      } else if (field === 'ni') {
        const prevSum = prev.reduce((s, p) => s + ((p.total_gross || 0) - Math.abs(p.sip_contribution || 0)), 0);
        document.getElementById('pfNiYtd').value = round2(prevSum + periodTaxableNiablePay(thisGross));
      }
    };

    document.getElementById('pfCalcGrossYtdBtn').addEventListener('click',   () => calcYtd('gross'));
    document.getElementById('pfCalcTaxYtdBtn').addEventListener('click',    () => calcYtd('tax'));
    document.getElementById('pfCalcTaxableYtdBtn').addEventListener('click', () => calcYtd('taxable'));
    document.getElementById('pfCalcNiYtdBtn').addEventListener('click',      () => calcYtd('ni'));

    // Auto-run once on open for any YTD field that's still blank, so YTD "just works"
    // without needing a click — the buttons stay available to refresh after edits.
    ['pfGrossYtd', 'pfTaxYtd', 'pfTaxableYtd', 'pfNiYtd'].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el && !el.value) calcYtd(['gross', 'tax', 'taxable', 'ni'][i]);
    });

    document.getElementById('pfSaveBtn').addEventListener('click', () => this.savePayslipForm(editId));
  },

  async savePayslipForm(editId) {
    const month = document.getElementById('pfMonth').value;
    if (!month) { showToast('Month is required', 'error'); return; }

    if (!editId) {
      const existing = this.payslips.find(p => p.month === month);
      if (existing) {
        if (!window.confirm('A payslip for ' + fmtMonth(month) + ' already exists. Update it with these details?')) return;
        editId = existing.id;
      }
    }

    const toggled = (id) => !!(document.getElementById(id)?.checked);
    const nVal    = (id) => parseFloat(document.getElementById(id)?.value) || 0;
    const strVal  = (id) => document.getElementById(id)?.value?.trim() || null;

    const basic_pay              = nVal('pfBasicPay');
    const additional_hours_pay   = nVal('pfExtraPay');
    const additional_hours_qty   = nVal('pfExtraQty');
    const arrears_pay            = toggled('togPrevMonth') ? nVal('pfArrears')          : 0;
    const addt_hours_prev_qty    = toggled('togPrevMonth') ? nVal('pfPrevExtraQty')     : 0;
    const addt_hours_prev_amount = toggled('togPrevMonth') ? nVal('pfPrevExtraPay')     : 0;
    const annual_leave_adj_prev  = toggled('togPrevMonth') ? nVal('pfALPrev')           : 0;
    const annual_leave_adj_curr  = toggled('togALCurr')    ? nVal('pfALCurr')           : 0;
    const bank_hol_curr_qty      = toggled('togBankHol')   ? nVal('pfBHCurrQty')        : 0;
    const bank_hol_curr_amount   = toggled('togBankHol')   ? nVal('pfBHCurrAmt')        : 0;
    const bank_hol_prev_qty      = toggled('togBankHol')   ? nVal('pfBHPrevQty')        : 0;
    const bank_hol_prev_amount   = toggled('togBankHol')   ? nVal('pfBHPrevAmt')        : 0;
    const company_sick_pay       = toggled('togSickPay')   ? nVal('pfSickPay')          : 0;
    const company_sick_pay_is_prev = toggled('togSickPay') ? (document.getElementById('pfSickPayIsPrev')?.checked ? 1 : 0) : 0;
    const sip_contribution       = toggled('togSIP')       ? nVal('pfSIP')              : 0;
    const other_payments         = toggled('togOtherPay')  ? nVal('pfOtherPayAmt')      : 0;
    const other_pay_description  = toggled('togOtherPay')  ? strVal('pfOtherPayDesc')   : null;
    const sharesave_amount       = toggled('togSharesave') ? nVal('pfSharesaveAmt')     : 0;
    const sharesave_description  = toggled('togSharesave') ? strVal('pfSharesaveDesc')  : null;
    const ni_employer            = toggled('togNIEmp')     ? nVal('pfNIEmp')            : 0;

    const tax_paid         = nVal('pfTax');
    const ni_employee      = nVal('pfNI');
    const total_gross      = nVal('pfTotalGross');
    const total_deductions = nVal('pfDeductions');
    const net_payment      = nVal('pfNetPay');
    const gross_ytd        = nVal('pfGrossYtd');
    const tax_ytd          = nVal('pfTaxYtd');
    const taxable_ytd      = nVal('pfTaxableYtd');
    const ni_able_ytd      = nVal('pfNiYtd');
    const payment_date     = strVal('pfPayDate');
    const notes            = strVal('pfNotes');

    const body = {
      month, payment_date,
      basic_pay, arrears_pay,
      additional_hours_qty, additional_hours_pay,
      addt_hours_prev_qty, addt_hours_prev_amount,
      annual_leave_adj_curr, annual_leave_adj_prev,
      bank_hol_curr_qty, bank_hol_curr_amount,
      bank_hol_prev_qty, bank_hol_prev_amount,
      company_sick_pay, company_sick_pay_is_prev,
      sip_contribution, other_payments, other_pay_description,
      sharesave_amount, sharesave_description,
      ni_employer,
      tax_paid, ni_employee,
      total_gross, total_deductions, net_payment,
      gross_ytd, tax_ytd, taxable_ytd, ni_able_ytd,
      notes,
    };

    try {
      if (editId) {
        await API.updatePayslip(editId, body);
      } else {
        await API.createPayslip(body);
      }
      Modal.close();
      await this.load();
      showToast(editId ? 'Payslip updated' : 'Payslip saved', 'success');
    } catch (e) {
      showToast('Error saving payslip: ' + e.message, 'error');
    }
  },

  async deletePayslip(id) {
    if (!confirmAction('Delete this payslip? This cannot be undone.')) return;
    try {
      await API.deletePayslip(id);
      await this.load();
      showToast('Payslip deleted', 'success');
    } catch (e) {
      showToast('Error deleting payslip: ' + e.message, 'error');
    }
  },

  _bindToggle(toggleId, sectionId) {
    const tog = document.getElementById(toggleId);
    const sec = document.getElementById(sectionId);
    if (!tog || !sec) return;
    const update = () => { sec.style.display = tog.checked ? '' : 'none'; };
    tog.addEventListener('change', update);
    update();
  },
};

function pf(id) { return parseFloat(document.getElementById(id)?.value) || 0; }
function pfToggled(togId, inputId) { return document.getElementById(togId)?.checked ? pf(inputId) : 0; }
function round2(v) { return Math.round(v * 100) / 100; }
function nextMonthStr(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m, 1); // JS months are 0-indexed, so m = next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
