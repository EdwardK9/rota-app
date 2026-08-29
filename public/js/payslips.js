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
      <div id="psDocumentsSection" style="margin-top:24px"></div>
    `;

    document.getElementById('payslipYearSelect').addEventListener('change', e => {
      this.currentYear = e.target.value;
      this.load();
    });

    document.getElementById('addPayslipBtn').addEventListener('click', () => this.openAddModal());
  },

  async load() {
    try {
      let docs, docYears;
      [this.payslips, this.allPayslips, this.monthly, this.settings, this.taxRefunds, this.payRates, docs, docYears] = await Promise.all([
        API.getPayslips({ year: this.currentYear }),
        API.getPayslips({}),          // all years — for financial-year YTD
        API.getMonthlyReport({ year: this.currentYear }),
        API.getSettings(),
        API.get('/api/tax-refunds'),
        API.getPayRates(),
        API.getPayslipFiles(this.currentYear),
        API.getPayslipFileYears(),
      ]);
      this.documents     = docs.files || [];
      this.documentYears = docYears.years || [];
      this.renderStats();
      this.renderTable();
      this.renderMonthComparison();
      this.renderYtd();
      this.renderTaxRefunds();
      this.renderDocuments();
    } catch(e) { showToast('Failed to load payslips: ' + e.message, 'error'); }
  },

  // Hourly rate in effect for a given YYYY-MM month — latest pay_rates row whose
  // effective_date falls on or before the 1st of that month (mirrors the server's
  // getRateForMonth in /api/reports/monthly).
  _rateRecordForMonth(month) {
    const firstDay = month + '-01';
    let rate = null;
    for (const r of (this.payRates || []).slice().sort((a, b) => a.effective_date.localeCompare(b.effective_date))) {
      if (r.effective_date <= firstDay) rate = r;
    }
    return rate;
  },

  _rateForMonth(month) {
    const rec = this._rateRecordForMonth(month);
    return rec ? rec.hourly_rate : 0;
  },

  /* ── Payslip autofill ─────────────────────────────────────────────────────
     Every suggestion here was checked against all 22 recorded payslips before
     being wired up, and the obvious formula lost more than once (see the v4.9.0
     and v4.11.0 commit messages for the numbers).

     Hourly extras are qty x the hourly rate — but the rate for the month the
     hours were WORKED, not the month they're paid in. The previous-month hours
     on the April 2026 payslip were paid at March's £13.04, not April's £13.48.

     Basic pay is a fixed monthly amount that only moves when the rate or the
     contract does, so the best predictor is what payroll actually paid last
     month on the same rate, not a formula: carrying it forward is exact,
     whereas contracted x 52/12 x rate is consistently a penny or two out (and
     21p out on the current rate). The formula is the fallback for the first
     month on a new rate, where there's nothing to carry.

     NI is 8% of gross above the monthly primary threshold. Tax is cumulative
     PAYE on the tax code fitted to the tax already deducted this year, rather
     than on an assumed one. */

  WEEKS_PER_MONTH: 52 / 12,

  // → { value, source: 'carried' | 'formula', basis } or null
  _suggestedBasicPay(month, editId) {
    const rec = this._rateRecordForMonth(month);
    if (!rec) return null;

    const priors = (this.allPayslips || []).filter(p =>
      p.month < month &&
      p.id !== editId &&
      (p.basic_pay || 0) > 0 &&
      this._rateRecordForMonth(p.month)?.id === rec.id
    );

    if (priors.length) {
      // Most common value, ties going to the most recent — one odd month
      // (an underpayment, a transition) shouldn't become the suggestion.
      const counts = new Map();
      priors.forEach(p => counts.set(p.basic_pay, (counts.get(p.basic_pay) || 0) + 1));
      let best = null, bestCount = -1;
      priors.slice().sort((a, b) => a.month.localeCompare(b.month)).forEach(p => {
        const c = counts.get(p.basic_pay);
        if (c >= bestCount) { bestCount = c; best = p.basic_pay; }
      });
      return { value: round2(best), source: 'carried', basis: bestCount };
    }

    const weekly = rec.contracted_hours_per_week || 0;
    if (!weekly || !rec.hourly_rate) return null;
    return {
      value: round2(weekly * this.WEEKS_PER_MONTH * rec.hourly_rate),
      source: 'formula',
      basis: rec,
    };
  },

  // Additional hours and bank holiday hours, current or previous month — pass
  // the month the hours were worked in, since that's what sets the rate. Exact
  // on all 21 payslips with current-month hours, all 17 with previous-month
  // hours (paying those at the payslip's own rate misses April 2026 by £1.98)
  // and all 5 with bank holiday hours.
  _suggestedHoursPay(qty, month) {
    const rate = this._rateForMonth(month);
    if (!rate || !(qty > 0)) return null;
    return { value: round2(qty * rate), rate };
  },

  /* Employee NI: 8% of everything above the primary threshold of £1,048 a
     month, frozen since 2022/23. Exact on 21 of the 22 recorded payslips —
     including all nine months under the threshold, where it correctly comes to
     nothing — the one miss being Nov 2025, a penny over. */
  NI_PRIMARY_THRESHOLD: 1048,
  NI_EMPLOYEE_RATE: 0.08,

  _suggestedNI(gross) {
    if (!(gross > 0)) return null;
    const over = gross - this.NI_PRIMARY_THRESHOLD;
    return { value: over > 0 ? round2(over * this.NI_EMPLOYEE_RATE) : 0, over };
  },

  /* PAYE. Tax is worked out on the year to date rather than the month: 20% of
     everything earned since 6 April above the free pay the tax code allows by
     this point in the year, less the tax already deducted in it.

     The code is fitted, not assumed. PAYE is deterministic, so one taxed
     payslip pins the code down to a pound or two of allowance and two pin it
     exactly — and assuming would have been wrong, since 2025/26 actually ran on
     1240L. Carrying a fitted code across April would be wrong too, HMRC having
     put it back to 1257L for 2026/27, so each tax year is fitted from its own
     payslips and falls back to the standard code until one of them has tax on
     it. Right on 21 of the 22 recorded payslips; the miss is July 2025, the
     first taxed month of a year, where there was nothing yet to fit to. */
  TAX_BASIC_RATE: 0.20,
  BASIC_RATE_BAND: 37700,
  STANDARD_TAX_CODE: 1257,

  _taxMonthIndex(month) {
    const mo = +month.split('-')[1];
    return mo >= 4 ? mo - 3 : mo + 9;      // April = 1 … March = 12
  },

  _taxYearStart(month) {
    const [y, mo] = month.split('-').map(Number);
    return (mo >= 4 ? y : y - 1) + '-04';
  },

  // HMRC's free pay tables: a code of N allows (N x 10) + 9 for the year,
  // spread over 12 months and rounded up to the penny at each one.
  _freePayToDate(code, monthIndex) {
    return Math.ceil(monthIndex * ((code * 10 + 9) / 12) * 100) / 100;
  },

  _priorPayslipsThisTaxYear(month, editId) {
    const start = this._taxYearStart(month);
    return (this.allPayslips || [])
      .filter(p => p.month >= start && p.month < month && p.id !== editId)
      .sort((a, b) => a.month.localeCompare(b.month));
  },

  // The tax a payslip should show, given a code and the months before it.
  _paye(code, month, priors, gross) {
    const ytdGross = priors.reduce((s, p) => s + (p.total_gross || 0), 0) + gross;
    const ytdTax   = priors.reduce((s, p) => s + (p.tax_paid    || 0), 0);
    // HMRC rounds taxable pay to date down to whole pounds before taxing it.
    const taxable   = Math.floor(ytdGross - this._freePayToDate(code, this._taxMonthIndex(month)));
    const dueToDate = taxable > 0 ? round2(taxable * this.TAX_BASIC_RATE) : 0;
    return round2(Math.max(0, dueToDate - ytdTax));
  },

  // → { code, fitted } — fitted false means "assuming the standard code".
  _fittedTaxCode(month, editId) {
    const priors = this._priorPayslipsThisTaxYear(month, editId);
    const taxed  = priors.filter(p => (p.tax_paid || 0) > 0);
    if (!taxed.length) return { code: this.STANDARD_TAX_CODE, fitted: false };

    const fits = [];
    for (let code = 0; code <= 2000; code++) {
      const ok = taxed.every(p =>
        Math.abs(this._paye(code, p.month, priors.filter(q => q.month < p.month), p.total_gross || 0)
                 - (p.tax_paid || 0)) < 0.005);
      if (ok) fits.push(code);
    }
    if (!fits.length) return { code: this.STANDARD_TAX_CODE, fitted: false };
    // Any code in the fitted range reproduces the year so far; prefer the
    // standard one when it's among them, otherwise take the middle.
    return {
      code: fits.includes(this.STANDARD_TAX_CODE) ? this.STANDARD_TAX_CODE : fits[Math.floor(fits.length / 2)],
      fitted: true,
    };
  },

  // → { value, code, fitted } or null
  _suggestedTax(month, gross, editId, codeInfo) {
    if (!month || !(gross > 0)) return null;
    const { code, fitted } = codeInfo || this._fittedTaxCode(month, editId);
    const priors   = this._priorPayslipsThisTaxYear(month, editId);
    const idx      = this._taxMonthIndex(month);
    const ytdGross = priors.reduce((s, p) => s + (p.total_gross || 0), 0) + gross;
    // Only the basic rate is modelled — say nothing rather than guess if the
    // year's earnings ever reach the higher-rate band.
    if (ytdGross - this._freePayToDate(code, idx) > this.BASIC_RATE_BAND * idx / 12) return null;
    return { value: this._paye(code, month, priors, gross), code, fitted };
  },

  // Figures that stay put month to month until they change — carried from the
  // most recent payslip that had one, rather than hard-coded.
  _lastRecorded(field, month, editId) {
    const priors = (this.allPayslips || [])
      .filter(p => p.month < month && p.id !== editId && p[field])
      .sort((a, b) => a.month.localeCompare(b.month));
    return priors.length ? priors[priors.length - 1][field] : null;
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
    const prevMonth = prevMonthStr;
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
      // Booked leave counts towards the contract — you were paid for those hours
      // and weren't expected to be on the rota. Without this a fortnight off read
      // as a 20-hour shortfall and looked exactly like a payroll error.
      const leave      = m.leave_hours || 0;
      const covered    = logged + leave;
      const hrsDiff    = covered - contracted;
      const rate       = this._rateForMonth(m.month);
      const hrsDiffPay = hrsDiff * rate;

      let note, noteColour;
      const leaveNote = leave > 0 ? ` (incl. ${fmtHours(leave)} leave)` : '';
      if (contracted === 0) {
        note = 'No contracted hours set for this month'; noteColour = 'var(--text-muted)';
      } else if (Math.abs(hrsDiff) < 1) {
        note = `On contract${leaveNote}`; noteColour = 'var(--text-muted)';
      } else if (hrsDiff < 0) {
        note = `${fmtHours(Math.abs(hrsDiff))} under contract ${rate ? `(≈ ${fmtCurrency(Math.abs(hrsDiffPay))} less)` : ''}${leaveNote}`;
        noteColour = 'var(--danger)';
      } else {
        note = `${fmtHours(hrsDiff)} over contract ${rate ? `(≈ +${fmtCurrency(hrsDiffPay)})` : ''}${leaveNote}`;
        noteColour = 'var(--success)';
      }

      return `<tr>
        <td><strong>${fmtMonth(m.month)}</strong></td>
        <td>${contracted ? fmtHours(contracted) : '—'}</td>
        <td>${logged ? fmtHours(logged) : '—'}</td>
        <td style="color:${leave > 0 ? 'var(--info)' : 'var(--text-muted)'}">${leave > 0 ? fmtHours(leave) : '—'}</td>
        <td><strong>${covered ? fmtHours(covered) : '—'}</strong></td>
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
            Compares your contracted hours against hours actually logged (worked + upcoming shifts) plus any
            booked leave each month — useful for telling whether a low "Paid vs Est." month above was really
            just fewer hours on the rota, rather than a payroll mistake. Leave counts towards the contract:
            you were paid for those hours and weren't expected on the rota, so a holiday isn't a shortfall.
          </p>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th title="Your contracted hours for this month, based on your pay rate settings">Contracted Hrs</th>
                  <th title="Total hours from your logged shifts this month — includes shifts not worked yet">Logged Hrs</th>
                  <th title="Booked leave falling in this month, spread across the days each entry covers">Leave Hrs</th>
                  <th title="Logged hours plus leave — what to compare against your contract">Covered Hrs</th>
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

  /* ── Payslip documents ────────────────────────────────────────────────────
     A safe copy of the original payslip PDFs, and nothing more. Deliberately
     inert: nothing reads these files, and no figure on this page comes from
     one. Keep it that way — the figures are typed in and worked out, and a
     stored document is only ever a document. */
  renderDocuments() {
    const el = document.getElementById('psDocumentsSection');
    if (!el) return;
    const docs = this.documents || [];
    // Documents filed under a year other than the one being viewed, so an empty
    // list doesn't read as "nothing was ever uploaded".
    const elsewhere = (this.documentYears || [])
      .filter(y => String(y.year) !== String(this.currentYear))
      .reduce((s, y) => s + y.count, 0);

    const icon = (mime) => (mime || '').startsWith('image/') ? '🖼️' : '📄';

    const rows = docs.map(d => `
      <tr>
        <td><strong>${fmtMonth(d.month)}</strong></td>
        <td>
          <a href="/api/payslip-files/${d.id}" target="_blank" rel="noopener" title="Open in a new tab">
            ${icon(d.mime_type)} ${esc(d.filename)}
          </a>
          ${d.missing ? '<span class="diff-alert diff-alert-under" style="margin-left:6px" title="The record is here but the file is not on disk any more">⚠️ file missing</span>' : ''}
          ${d.notes ? `<div style="font-size:11px;color:var(--text-muted)">${esc(d.notes)}</div>` : ''}
        </td>
        <td>${fmtFileSize(d.size_bytes)}</td>
        <td>${fmtStamp(d.uploaded_at)}</td>
        <td class="actions">
          <a class="btn btn-sm btn-ghost" href="/api/payslip-files/${d.id}?download=1" title="Save a copy">⬇ Save</a>
          <button class="btn btn-sm btn-ghost doc-edit-btn" data-id="${d.id}" title="Change month, name or note" style="margin-left:4px">✏️</button>
          <button class="btn-icon danger doc-del-btn" data-id="${d.id}" title="Delete this document" style="margin-left:4px">🗑️</button>
        </td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>📎 Payslip Documents <span style="font-size:12px;font-weight:400;color:var(--text-muted)">· ${this.currentYear}</span></h2>
        </div>
        <div class="card-body">
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
            Your original payslips, kept exactly as they came. Nothing is read from them and nothing on this page
            is worked out from them — they're here so the real document is safe. PDFs and photos, up to 25MB each.
          </p>

          <div id="psDocDrop" style="border:2px dashed var(--border);border-radius:8px;padding:14px;transition:border-color .15s,background .15s">
            <div class="form-row">
              <div class="form-group">
                <label>Month</label>
                <select id="psDocMonth">${getMonthOptions(getCurrentMonth())}</select>
              </div>
              <div class="form-group">
                <label>File(s)</label>
                <input type="file" id="psDocInput" accept="application/pdf,image/*" multiple />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Note <span style="font-size:11px;color:var(--text-muted)">(optional)</span></label>
                <input type="text" id="psDocNotes" placeholder="e.g. corrected version" />
              </div>
              <div class="form-group" style="display:flex;align-items:flex-end">
                <button class="btn btn-primary" id="psDocUploadBtn">⬆ Upload</button>
              </div>
            </div>
            <div style="font-size:11px;color:var(--text-muted)">Or drag files anywhere onto this box — they'll be filed under the month selected above.</div>
          </div>

          ${docs.length ? `
            <div class="table-wrapper" style="margin-top:14px">
              <table>
                <thead>
                  <tr><th>Month</th><th>Document</th><th>Size</th><th>Uploaded</th><th></th></tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>` : `
            <div class="empty-state" style="margin-top:14px">
              <div class="empty-state-icon">📎</div>
              <div class="empty-state-text">No documents saved for ${this.currentYear}</div>
              <div class="empty-state-sub">Upload the PDF your payslip came as, and it stays here untouched</div>
            </div>`}

          ${elsewhere ? `<p style="font-size:12px;color:var(--text-muted);margin-top:10px">
            ${elsewhere} document${elsewhere === 1 ? '' : 's'} filed under other years — switch the year at the top of the page to see ${elsewhere === 1 ? 'it' : 'them'}.
          </p>` : ''}

          <p style="font-size:11px;color:var(--text-muted);margin-top:10px">
            Files are kept in the app's data folder rather than inside the database, so they're covered by whatever
            backs that folder up — the nightly GitHub backup carries the database only.
          </p>
        </div>
      </div>`;

    const drop  = document.getElementById('psDocDrop');
    const input = document.getElementById('psDocInput');

    document.getElementById('psDocUploadBtn').addEventListener('click', () => {
      const files = [...(input.files || [])];
      if (!files.length) { showToast('Choose a file to upload first', 'warning'); return; }
      this.uploadDocuments(files);
    });

    // Drag and drop over the whole box — the month select still decides where
    // the file is filed, so dropping is just a shortcut past the file picker.
    const glow = (on) => {
      drop.style.borderColor = on ? 'var(--primary)' : 'var(--border)';
      drop.style.background  = on ? 'var(--bg-hover, transparent)' : 'transparent';
    };
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); glow(true); }));
    ['dragleave', 'dragend'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); glow(false); }));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      glow(false);
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.uploadDocuments(files);
    });

    el.querySelectorAll('.doc-edit-btn').forEach(b =>
      b.addEventListener('click', () => this.openDocumentModal(+b.dataset.id)));
    el.querySelectorAll('.doc-del-btn').forEach(b =>
      b.addEventListener('click', () => this.deleteDocument(+b.dataset.id)));
  },

  async uploadDocuments(files) {
    const month = document.getElementById('psDocMonth')?.value || getCurrentMonth();
    const notes = document.getElementById('psDocNotes')?.value?.trim() || '';
    showToast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, 'info');
    try {
      await API.uploadPayslipFiles(files, month, notes);
      const wrongYear = month.slice(0, 4) !== String(this.currentYear);
      await this.load();
      showToast(
        wrongYear
          ? `Saved under ${fmtMonth(month)} — switch the year to ${month.slice(0, 4)} to see it`
          : `Saved under ${fmtMonth(month)}`,
        'success'
      );
    } catch (e) {
      showToast('Upload failed: ' + e.message, 'error');
    }
  },

  openDocumentModal(id) {
    const d = (this.documents || []).find(x => x.id === id);
    if (!d) return;
    Modal.open('Payslip Document', `
      <div class="form-group">
        <label>Month</label>
        <select id="pdMonth">${getMonthOptions(d.month)}</select>
      </div>
      <div class="form-group">
        <label>Name <span style="font-size:11px;color:var(--text-muted)">(how it's listed here)</span></label>
        <input type="text" id="pdName" value="${esc(d.filename)}" />
      </div>
      <div class="form-group">
        <label>Note <span style="font-size:11px;color:var(--text-muted)">(optional)</span></label>
        <input type="text" id="pdNotes" value="${esc(d.notes || '')}" placeholder="e.g. corrected version" />
      </div>
      <p style="font-size:12px;color:var(--text-muted)">
        The stored file itself is never altered — this only changes how it's filed and listed.
      </p>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="pdSaveBtn">Save</button>
      </div>`);

    document.getElementById('pdSaveBtn').addEventListener('click', async () => {
      const filename = document.getElementById('pdName').value.trim();
      if (!filename) { showToast('Name cannot be empty', 'error'); return; }
      try {
        await API.updatePayslipFile(id, {
          month: document.getElementById('pdMonth').value,
          filename,
          notes: document.getElementById('pdNotes').value.trim(),
        });
        Modal.close();
        await this.load();
        showToast('Document updated', 'success');
      } catch (e) { showToast('Error saving: ' + e.message, 'error'); }
    });
  },

  async deleteDocument(id) {
    const d = (this.documents || []).find(x => x.id === id);
    if (!confirmAction(`Delete ${d ? d.filename : 'this document'}? The file is removed for good.`)) return;
    try {
      await API.deletePayslipFile(id);
      await this.load();
      showToast('Document deleted', 'success');
    } catch (e) { showToast('Error deleting: ' + e.message, 'error'); }
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

    // Standing amounts — SIP and Sharesave sit at the same figure month after
    // month, so an empty one carries from the last payslip that had it rather
    // than being hard-coded, and follows along if it ever changes.
    const carried = (k) => vn(k) || (this._lastRecorded(k, p.month || getCurrentMonth(), p.id) ?? '');

    // Determine which toggles should be ON (because the existing payslip has values)
    const hasPrevMonth   = !!(p.arrears_pay || p.addt_hours_prev_qty || p.addt_hours_prev_amount || p.annual_leave_adj_prev);
    const hasALCurr      = !!p.annual_leave_adj_curr;
    const hasBankHol     = !!(p.bank_hol_curr_qty || p.bank_hol_curr_amount || p.bank_hol_prev_qty || p.bank_hol_prev_amount);
    const hasSickPay     = !!p.company_sick_pay;
    // Sharesave and SIP run at the same figure every month until they stop, so
    // a brand-new payslip starts with whichever of them the month before had.
    const prevSlip       = p.id == null
      ? (this.allPayslips || []).find(q => q.month === prevMonthStr(p.month || getCurrentMonth()))
      : null;
    const hasSIP         = !!(p.sip_contribution || prevSlip?.sip_contribution);
    const hasSharesave   = !!(p.sharesave_amount || p.sharesave_description || prevSlip?.sharesave_amount);
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
      <div class="form-hint" id="pfBasicPayHint"></div>
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
      <div class="form-hint" id="pfExtraPayHint"></div>
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
      <div class="form-hint" id="pfPrevExtraPayHint"></div>
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
      <div class="form-hint" id="pfBHCurrAmtHint"></div>
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
      <div class="form-hint" id="pfBHPrevAmtHint"></div>
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
      <div class="input-prefix"><span>£</span><input type="number" id="pfSIP" step="0.01" value="${carried('sip_contribution')}" placeholder="-50.00" /></div>
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
      <div class="form-hint" id="pfTaxHint"></div>
    </div>
    <div class="form-group">
      <label>National Insurance <span style="font-size:11px;color:var(--text-muted)">(employee)</span></label>
      <div class="input-prefix"><span>£</span><input type="number" id="pfNI" step="0.01" value="${vn('ni_employee')}" placeholder="0.00" /></div>
      <div class="form-hint" id="pfNIHint"></div>
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
      <div class="input-prefix"><span>£</span><input type="number" id="pfSharesaveAmt" step="0.01" value="${carried('sharesave_amount') || 250}" placeholder="250" /></div>
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
  TOTALS <span style="font-weight:400;font-size:11px;opacity:.8">(kept in step with the figures above until you type your own)</span>
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
  YEAR TO DATE (from payslip) <span style="font-weight:400;font-size:11px;opacity:.8">(kept in step until you type your own)</span>
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
    All four are running totals from your logged payslips for the tax year so far. Taxable and NI'able pay equal gross:
    the SIP contribution is a negative payment line, so it has already come off the gross above, and Sharesave comes out of net pay.
    If your payslip shows a different figure, trust the payslip and enter it directly.
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

    // Everything numeric on this form fills itself in and keeps in step as you
    // type — see _wireAutofill.
    this._wireAutofill(editId);

    document.getElementById('pfSaveBtn').addEventListener('click', () => this.savePayslipForm(editId));
  },

  /* Fills in every figure the app can work out for itself — basic salary, both
     pairs of hourly extras, tax, NI, the three totals and the four YTD boxes —
     and keeps them in step as you type, so entering a payslip is mostly
     checking figures rather than typing them.

     Everything stays editable. A field is only ever written while the form
     still owns it; typing in it hands it over for good, and anything that
     already had a value when the form opened — every field of a saved payslip
     — counts as typed from the start. So a figure you entered by hand is never
     overwritten by a later change to the month, the hours or anything else. An
     Auto-calculate button hands a field back to the form. */
  _wireAutofill(editId) {
    const el    = id => document.getElementById(id);
    const write = (id, value) => { const e = el(id); if (e) e.value = value; };
    const hint  = (id, text)  => { const h = el(id); if (h) h.textContent = text || ''; };

    const monthSel = el('pfMonth');
    if (!monthSel) return;
    const month     = () => monthSel.value;
    const prevMonth = () => prevMonthStr(monthSel.value);
    const monthName = m => fmtMonth(m).split(' ')[0];

    // The fields the form fills in. A value already sitting in one when the
    // form opens came from somewhere else, so that field is hands-off.
    const MANAGED = ['pfBasicPay', 'pfExtraPay', 'pfPrevExtraPay', 'pfBHCurrAmt', 'pfBHPrevAmt',
                     'pfTax', 'pfNI', 'pfTotalGross', 'pfDeductions', 'pfNetPay',
                     'pfGrossYtd', 'pfTaxYtd', 'pfTaxableYtd', 'pfNiYtd'];
    MANAGED.forEach(id => {
      const e = el(id);
      if (!e) return;
      if (e.value !== '') e.dataset.manual = '1';
      e.addEventListener('input', () => { e.dataset.manual = '1'; });
    });
    const mine = id => el(id) && el(id).dataset.manual !== '1';

    // Fitting a tax code walks every code against the year's payslips, so do it
    // once per month rather than on every keystroke.
    const codeCache = new Map();
    const taxCodeFor = (m) => {
      if (!codeCache.has(m)) codeCache.set(m, this._fittedTaxCode(m, editId));
      return codeCache.get(m);
    };

    const fillBasic = () => {
      if (!mine('pfBasicPay')) return;
      const s = this._suggestedBasicPay(month(), editId);
      if (!s) { write('pfBasicPay', ''); hint('pfBasicPayHint', ''); return; }
      write('pfBasicPay', s.value);
      hint('pfBasicPayHint', s.source === 'carried'
        ? `Auto-filled — what you were paid in ${s.basis === 1 ? 'the previous month' : `${s.basis} previous months`} on this rate. Edit if your payslip differs.`
        : `Estimated — ${s.basis.contracted_hours_per_week}h/week × 52 ÷ 12 × £${s.basis.hourly_rate}. First month on this rate, so check it against the payslip.`);
    };

    // Hours are paid at the rate in force for the month they were worked, so
    // the previous-month columns follow the previous month's rate.
    const fillHours = (qtyId, amtId, hintId, workedIn) => {
      if (!mine(amtId)) return;
      const qty = pf(qtyId);
      const m   = workedIn();
      const s   = this._suggestedHoursPay(qty, m);
      if (!s) { write(amtId, ''); hint(hintId, ''); return; }
      write(amtId, s.value);
      hint(hintId, `Auto-filled — ${qty} × £${s.rate}${m === month() ? '' : ` (${monthName(m)}'s rate)`}. Edit if your payslip differs.`);
    };

    const grossTotal = () =>
      pf('pfBasicPay') + pf('pfExtraPay') +
      pfToggled('togPrevMonth', 'pfArrears')   + pfToggled('togPrevMonth', 'pfPrevExtraPay') +
      pfToggled('togPrevMonth', 'pfALPrev')    + pfToggled('togALCurr',    'pfALCurr') +
      pfToggled('togBankHol',   'pfBHCurrAmt') + pfToggled('togBankHol',   'pfBHPrevAmt') +
      pfToggled('togSickPay',   'pfSickPay')   + pfToggled('togSIP',       'pfSIP') +
      pfToggled('togOtherPay',  'pfOtherPayAmt');

    const fillGross = () => {
      if (!mine('pfTotalGross')) return;
      write('pfTotalGross', round2(grossTotal()) || '');
    };

    const fillNI = () => {
      if (!mine('pfNI')) return;
      const s = this._suggestedNI(pf('pfTotalGross'));
      if (!s) { write('pfNI', ''); hint('pfNIHint', ''); return; }
      write('pfNI', s.value || '');
      hint('pfNIHint', s.over > 0
        ? `Auto-filled — 8% of the ${fmtCurrency(s.over)} above the £${this.NI_PRIMARY_THRESHOLD.toLocaleString()} monthly threshold.`
        : `Nothing due — gross is under the £${this.NI_PRIMARY_THRESHOLD.toLocaleString()} monthly NI threshold.`);
    };

    const fillTax = () => {
      if (!mine('pfTax')) return;
      const s = this._suggestedTax(month(), pf('pfTotalGross') || pf('pfBasicPay'), editId, taxCodeFor(month()));
      if (!s) { write('pfTax', ''); hint('pfTaxHint', ''); return; }
      write('pfTax', s.value || '');
      hint('pfTaxHint', s.fitted
        ? `Estimated — cumulative PAYE on code ${s.code}L, the code that matches the tax on your earlier payslips this tax year. Check it against the payslip.`
        : `Estimated — cumulative PAYE assuming the standard ${s.code}L code; no taxed payslip yet this tax year to check it against.`);
    };

    const fillDeduc = () => {
      if (!mine('pfDeductions')) return;
      write('pfDeductions', round2(pf('pfTax') + pf('pfNI') + pfToggled('togSharesave', 'pfSharesaveAmt')) || '');
    };

    const fillNet = () => {
      if (!mine('pfNetPay')) return;
      write('pfNetPay', round2(pf('pfTotalGross') - pf('pfDeductions')) || '');
    };

    /* YTD running totals for the UK tax year (6 Apr – 5 Apr, bucketed here by
       calendar month since that's how payslips are stored). Gross and tax are
       exact sums of each month's own payslip figure. Taxable and NI'able pay
       come to the same as gross: the SIP contribution is a negative payment
       line, so it has already come off the gross, and Sharesave comes out of
       net pay. The May 2026 payslip bears that out — taxable YTD £2,753.06,
       exactly the two months' gross. */
    const YTD = { gross: 'pfGrossYtd', tax: 'pfTaxYtd', taxable: 'pfTaxableYtd', ni: 'pfNiYtd' };
    const calcYtd = (field) => {
      const id = YTD[field];
      if (!mine(id) || !month()) return;
      const priors = this._priorPayslipsThisTaxYear(month(), editId);
      const sum = (k) => priors.reduce((s, p) => s + (p[k] || 0), 0);
      write(id, field === 'tax'
        ? round2(sum('tax_paid') + pf('pfTax'))
        : round2(sum('total_gross') + (pf('pfTotalGross') || pf('pfBasicPay'))));
    };

    // Order matters: the totals feed tax and NI, which feed the deductions and
    // the net, and the YTD boxes count this month's gross and tax.
    const recalc = () => {
      fillBasic();
      fillHours('pfExtraQty',     'pfExtraPay',     'pfExtraPayHint',     month);
      fillHours('pfPrevExtraQty', 'pfPrevExtraPay', 'pfPrevExtraPayHint', prevMonth);
      fillHours('pfBHCurrQty',    'pfBHCurrAmt',    'pfBHCurrAmtHint',    month);
      fillHours('pfBHPrevQty',    'pfBHPrevAmt',    'pfBHPrevAmtHint',    prevMonth);
      fillGross();
      fillNI();
      fillTax();
      fillDeduc();
      fillNet();
      Object.keys(YTD).forEach(f => calcYtd(f));
    };

    // Any change anywhere can move the totals, so recalculate on all of them.
    // The listeners go on the fields themselves, which the modal throws away.
    document.querySelectorAll('#modalBody input, #modalBody select').forEach(input => {
      const evt = (input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'radio')
        ? 'change' : 'input';
      input.addEventListener(evt, recalc);
    });

    // Auto-calculate ↻ hands a field back to the form and refills it.
    const rearm = (id) => { const e = el(id); if (e) delete e.dataset.manual; recalc(); };
    [['pfCalcGrossBtn',      'pfTotalGross'],
     ['pfCalcDeducBtn',      'pfDeductions'],
     ['pfCalcNetBtn',        'pfNetPay'],
     ['pfCalcGrossYtdBtn',   'pfGrossYtd'],
     ['pfCalcTaxYtdBtn',     'pfTaxYtd'],
     ['pfCalcTaxableYtdBtn', 'pfTaxableYtd'],
     ['pfCalcNiYtdBtn',      'pfNiYtd']].forEach(([btnId, fieldId]) =>
      el(btnId)?.addEventListener('click', () => rearm(fieldId)));

    recalc();
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
function fmtFileSize(bytes) {
  if (!bytes) return '—';
  return bytes < 1024 * 1024
    ? Math.max(1, Math.round(bytes / 1024)) + ' KB'
    : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
// SQLite datetime ("YYYY-MM-DD HH:MM:SS", UTC) -> "29/08/2026 21:16"
function fmtStamp(stamp) {
  if (!stamp) return '—';
  const d = new Date(stamp.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return fmtDate(String(stamp).slice(0, 10));
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function nextMonthStr(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m, 1); // JS months are 0-indexed, so m = next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prevMonthStr(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // one month back
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
