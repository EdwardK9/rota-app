/* ─── 💷 Tax Check (V3.0) ──────────────────────────────────────────────────
   Every payslip in a tax year against what PAYE should have deducted, with the
   allowance the deductions actually imply worked back out of them — which is
   the difference between "£32 more than expected" and "they're using a code
   around 1240L", and only one of those is something you can ring up about.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('tax-check', '💷 Tax Check', {
  year: null,
  data: null,

  async init() {
    document.getElementById('view-tax-check').innerHTML = V3.loading('Checking the deductions…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.taxCheck(this.year);
      this.year = this.data.tax_year;
      this.render();
    } catch (e) {
      document.getElementById('view-tax-check').innerHTML = V3.error(e);
    }
  },

  label(y) { return `${y}/${String(y + 1).slice(2)}`; },

  /** A signed difference. fmtCurrency puts the minus after the pound sign,
   *  which reads badly in a column of them. */
  diff(v) {
    if (v === null || v === undefined) return '—';
    return (v < 0 ? '−' : '+') + fmtCurrency(Math.abs(v));
  },

  toolbar() {
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Tax year:</label>
        <select id="tcYear" style="width:auto">
          ${this.data.available_years.map(y =>
            `<option value="${y}" ${y === this.year ? 'selected' : ''}>${this.label(y)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  hero() {
    const d = this.data, s = d.summary;
    if (!s) {
      return `<div class="v3-hero" style="background:linear-gradient(135deg,#64748B,#1E293B)">
        <div class="v3-hero-label">TAX CHECK ${esc(d.tax_year_label)}</div>
        <div class="v3-hero-value">No payslips</div>
        <div class="v3-hero-sub">Add a payslip for this tax year and the deductions get checked.</div>
      </div>`;
    }

    const over = s.tax_diff > 0;
    const settled = Math.abs(s.outstanding) <= 2;
    const right = s.verdict === 'tax looks right';

    return `<div class="v3-hero" style="background:${right || settled
      ? 'linear-gradient(135deg,#10B981,#065F46)'
      : over ? 'linear-gradient(135deg,#F59E0B,#7C2D12)'
             : 'linear-gradient(135deg,#EF4444,#7F1D1D)'}">
      <div class="v3-hero-label">TAX CHECK ${esc(d.tax_year_label)} · ${s.payslips_checked} PAYSLIPS</div>
      <div class="v3-hero-value">${right ? 'Looks right' : (over ? '+' : '−') + fmtCurrency(Math.abs(s.tax_diff)).slice(1)}</div>
      <div class="v3-hero-sub">
        ${right
          ? `On ${fmtCurrency(s.cumulative_gross)} of gross pay you've been taxed ${fmtCurrency(s.tax_paid)},
             against ${fmtCurrency(s.tax_due)} on the standard bands — a difference of
             ${fmtCurrency(Math.abs(s.tax_diff))}, which is rounding.`
          : over
            ? `You've paid ${fmtCurrency(s.tax_paid)} of tax on ${fmtCurrency(s.cumulative_gross)},
               where the standard bands give ${fmtCurrency(s.tax_due)}. That's
               <strong>${fmtCurrency(s.tax_diff)}</strong> more than expected${
                 s.refunded ? `, and ${fmtCurrency(s.refunded)} has already come back as a refund` : ''}.`
            : `You've paid ${fmtCurrency(s.tax_paid)} against ${fmtCurrency(Math.abs(s.tax_due))} expected —
               <strong>${fmtCurrency(Math.abs(s.tax_diff))}</strong> less. Usually a code catching up,
               but it can mean a bill later.`}
        ${s.likely_emergency_code ? ' <strong>This has the shape of an emergency code.</strong>' : ''}
      </div>
    </div>`;
  },

  implied() {
    const s = this.data.summary;
    if (!s || !s.implied_allowance) return '';
    const i = s.implied_allowance;
    const matches = Math.abs(i.difference) < 60;

    return `<div class="card" style="margin-bottom:18px"><div class="card-body">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap">
        <div>
          <div class="v3-tile-label">TAX CODE THE DEDUCTIONS IMPLY</div>
          <div class="v3-plan-ratio">${esc(i.code)}</div>
        </div>
        <div style="text-align:right">
          <div class="v3-tile-label">EXPECTED</div>
          <div class="v3-plan-ratio">${esc(i.expected_code)}</div>
        </div>
      </div>
      <div class="v3-muted" style="margin-top:10px;line-height:1.55">
        Working backwards from what was actually deducted, the payroll looks to be giving you
        <strong>${fmtCurrency(i.allowance)}</strong> of tax-free allowance against the standard
        <strong>${fmtCurrency(i.expected_allowance)}</strong>${matches
          ? ' — near enough the same thing, so the code looks right.'
          : `, a difference of <strong>${fmtCurrency(Math.abs(i.difference))}</strong>.
             ${i.difference < 0 ? 'A lower allowance means more tax taken each month.'
                                : 'A higher allowance means less tax taken each month.'}`}
      </div>
      ${i.looks_like_no_allowance ? `
        <div class="v3-chips"><span class="v3-chip flag">
          Barely any allowance is being applied — that's what BR or 0T looks like from outside
        </span></div>` : ''}
      <div class="v3-note">
        A read of the arithmetic, not a look at your code. It only holds while your earnings stay
        inside the basic-rate band, and the letter on the end is an assumption. Your actual code is
        on the payslip and in your HMRC account.
      </div>
    </div></div>`;
  },

  rows() {
    return this.data.rows.filter(r => r.present).map(r => `
      <tr${r.ok ? '' : ' class="payslip-discrepancy-row"'}>
        <td>${esc(fmtMonth(r.month))}<br><span class="v3-muted">month ${r.period}</span></td>
        <td>${fmtCurrency(r.gross)}</td>
        <td>${fmtCurrency(r.tax_paid)}${r.refund_in_period
          ? '<br><span class="badge badge-info">refund</span>' : ''}</td>
        <td>${fmtCurrency(r.tax_due)}</td>
        <td class="${diffClass(r.tax_diff)}">${this.diff(r.tax_diff)}</td>
        <td class="${diffClass(r.cumulative_tax_diff)}">${this.diff(r.cumulative_tax_diff)}</td>
        <td>${fmtCurrency(r.ni_paid)}</td>
        <td class="${diffClass(r.ni_diff)}">${this.diff(r.ni_diff)}</td>
      </tr>`).join('');
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-tax-check');
    const s = d.summary;

    el.innerHTML = `
      ${V3.backButton()}
      ${this.toolbar()}
      ${this.hero()}

      ${s ? `
        <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
          ${V3.tile('Gross so far', fmtCurrency(s.cumulative_gross), `To ${esc(fmtMonth(s.as_at))}`)}
          ${V3.tile('Tax paid', fmtCurrency(s.tax_paid), `Expected ${fmtCurrency(s.tax_due)}`,
                    Math.abs(s.tax_diff) <= 2 ? 'success' : 'warning')}
          ${V3.tile('NI paid', fmtCurrency(s.ni_paid), `Expected ${fmtCurrency(s.ni_due)}`,
                    Math.abs(s.ni_diff) <= 2 ? 'success' : 'warning')}
          ${V3.tile('Still outstanding', Math.abs(s.outstanding) <= 2 ? 'Nothing' : fmtCurrency(s.outstanding),
                    s.refunded ? `${fmtCurrency(s.refunded)} already refunded` : 'After any refunds recorded',
                    Math.abs(s.outstanding) <= 2 ? 'success' : 'warning')}
        </div>` : ''}

      ${this.implied()}

      ${d.ytd_mismatches.length ? `
        <div class="v3-section-title">⚠️ Payslip year-to-date figures that don't add up</div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Month</th><th>Payslip says YTD</th><th>Months add up to</th><th>Out by</th></tr></thead>
            <tbody>${d.ytd_mismatches.map(m => `
              <tr>
                <td>${esc(fmtMonth(m.month))}</td>
                <td>${fmtCurrency(m.payslip_says)}</td>
                <td>${fmtCurrency(m.adds_up_to)}</td>
                <td class="${diffClass(m.diff)}">${this.diff(m.diff)}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div></div>
        <div class="v3-note">
          The year-to-date box on the payslip disagrees with the individual months added together.
          Nearly always a typo when one payslip was entered rather than anything the employer did.
        </div>` : ''}

      <div class="v3-section-title">📆 Every payslip</div>
      <div class="card"><div class="card-body" style="padding:0">
        <div class="table-wrapper"><table>
          <thead><tr>
            <th>Month</th><th>Gross</th><th>Tax paid</th><th>Tax due</th>
            <th>Month</th><th>Running</th><th>NI paid</th><th>NI diff</th>
          </tr></thead>
          <tbody>${this.rows()}</tbody>
        </table></div>
      </div></div>

      ${d.refunds.length ? `
        <div class="v3-section-title">💸 Refunds on record</div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Tax year</th><th>Amount</th><th>Date</th><th>Note</th></tr></thead>
            <tbody>${d.refunds.map(r => `
              <tr>
                <td>${esc(r.tax_year)}</td>
                <td>${fmtCurrency(r.amount)}</td>
                <td>${r.date ? fmtDate(r.date) : '—'}</td>
                <td>${esc(r.notes || '')}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div></div>` : ''}

      <div class="v3-section-title">📐 How this is worked out</div>
      <div class="card"><div class="card-body">
        <p style="margin:0 0 10px">
          PAYE is cumulative. By month ${d.rows.filter(r => r.present).length || 'n'} of the tax year
          you've had that many twelfths of your ${fmtCurrency(d.config.personal_allowance)} allowance,
          so the tax due to date is the tax on everything above it, and this month's deduction is
          that total minus what you'd already paid. It's why a quiet month can hand tax
          <em>back</em> through your wages — that's the system correcting itself, not an error, and
          those months are marked rather than flagged.
        </p>
        <p style="margin:0 0 10px">
          National Insurance works the opposite way: recalculated fresh each month on that month's
          pay alone, above ${fmtCurrency(d.config.monthly_ni_threshold)}, with no memory. A quiet
          month never gets NI back.
        </p>
        <p style="margin:0;color:var(--text-muted);font-size:13px">
          Standard England &amp; Wales bands, no student loan, pension or salary sacrifice modelled
          — a workplace pension or a non-standard code will move these numbers legitimately. This is
          a sanity check on your own records, not tax advice, and HMRC is the authority on your
          actual position.
        </p>
      </div></div>
    `;

    document.getElementById('tcYear')?.addEventListener('change', e => {
      this.year = Number(e.target.value);
      this.load();
    });
  },
});
