/* ─── 🧾 Pay Audit (V3.0) ──────────────────────────────────────────────────
   Hours worked against hours paid, as running totals so the month-in-arrears
   timing can't hide anything. The headline is deliberately cautious: the model
   of the pay rules is good to about 5%, and this says so rather than turning
   every rounding difference into an accusation.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('pay-audit', '🧾 Pay Audit', {
  year: null,
  data: null,
  showWeeks: false,

  async init() {
    document.getElementById('view-pay-audit').innerHTML = V3.loading('Adding up the weeks…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.payAudit(this.year);
      this.year = this.data.tax_year;
      this.render();
    } catch (e) {
      document.getElementById('view-pay-audit').innerHTML = V3.error(e);
    }
  },

  label(y) { return `${y}/${String(y + 1).slice(2)}`; },

  toolbar() {
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Tax year:</label>
        <select id="paYear" style="width:auto">
          ${this.data.available_years.map(y =>
            `<option value="${y}" ${y === this.year ? 'selected' : ''}>${this.label(y)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  VERDICT: {
    short:  { grad: 'linear-gradient(135deg,#EF4444,#7F1D1D)', word: 'Hours unaccounted for' },
    over:   { grad: 'linear-gradient(135deg,#F59E0B,#7C2D12)', word: 'Paid more than expected' },
    square: { grad: 'linear-gradient(135deg,#10B981,#065F46)', word: 'It balances' },
  },

  hero() {
    const d = this.data, s = d.standing;
    if (!s) {
      return `<div class="v3-hero" style="background:linear-gradient(135deg,#64748B,#1E293B)">
        <div class="v3-hero-label">PAY AUDIT ${esc(d.tax_year_label)}</div>
        <div class="v3-hero-value">No payslips</div>
        <div class="v3-hero-sub">
          Nothing to check against for this tax year yet. Add a payslip and the comparison starts.
        </div>
      </div>`;
    }
    const v = this.VERDICT[s.verdict] || this.VERDICT.square;
    const gap = Math.abs(s.hours_gap);

    return `<div class="v3-hero" style="background:${v.grad}">
      <div class="v3-hero-label">PAY AUDIT ${esc(d.tax_year_label)} · TO ${esc(fmtMonth(s.as_at)).toUpperCase()}</div>
      <div class="v3-hero-value">${v.word}</div>
      <div class="v3-hero-sub">
        You worked <strong>${d.totals.extra_owed}h</strong> above contract this tax year and were paid
        <strong>${d.totals.extra_paid}h</strong> of extra.
        ${s.verdict === 'square'
          ? `The ${gap}h between them is inside the ${s.margin}h this comparison can actually resolve, so there's nothing to chase.`
          : s.verdict === 'short'
            ? `That leaves <strong>${gap}h</strong> — about ${fmtCurrency(s.value)} — unaccounted for, beyond the ${s.margin}h margin.`
            : `That's <strong>${gap}h</strong> more than expected, beyond the ${s.margin}h margin. More likely the model missing something than free money.`}
      </div>
    </div>`;
  },

  monthRows() {
    return this.data.rows.filter(r => r.has_work || r.has_payslip).map(r => `
      <tr>
        <td>${esc(fmtMonth(r.month))}${r.awaiting_next_payslip
          ? ' <span class="badge badge-muted">awaiting next payslip</span>' : ''}</td>
        <td>${r.worked_hours}h</td>
        <td>${r.contracted_monthly}h</td>
        <td>${r.extra_owed ? r.extra_owed + 'h' : '—'}</td>
        <td>${r.extra_paid ? r.extra_paid + 'h' : '—'}
          ${r.extra_paid ? `<br><span class="v3-muted">${r.extra_paid_this_month}h now,
            ${r.extra_paid_next_month}h next</span>` : ''}</td>
        <td class="${diffClass(r.month_gap)}">${r.month_gap > 0 ? '+' : ''}${r.month_gap}h</td>
        <td class="${diffClass(r.cumulative_gap)}">${r.cumulative_gap > 0 ? '+' : ''}${r.cumulative_gap}h</td>
        <td>${r.basic_pay == null ? '—' : fmtCurrency(r.basic_pay)}
          ${r.basic_ok === false ? `<br><span class="badge badge-warning">${r.basic_diff < 0 ? '−' : '+'}${fmtCurrency(Math.abs(r.basic_diff))}</span>` : ''}</td>
      </tr>`).join('');
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-pay-audit');

    el.innerHTML = `
      ${V3.backButton()}
      ${this.toolbar()}
      ${this.hero()}

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Hours worked', d.totals.worked_hours + 'h',
                  `Across ${d.totals.weeks_worked} weeks`)}
        ${V3.tile('Weeks over contract', d.totals.weeks_over_contract,
                  `of ${d.totals.weeks_worked} worked — only these earn extra`)}
        ${V3.tile('Extra owed', d.totals.extra_owed + 'h', 'Summed week by week')}
        ${V3.tile('Extra paid', d.totals.extra_paid + 'h', 'From the payslips, both columns')}
      </div>

      ${d.pending.length ? `
        <div class="v3-note">
          ${d.pending.map(p => `${esc(fmtMonth(p.month))} has ${p.extra_owed}h of extra still to appear —
            it lands on the next payslip, which isn't recorded yet, so it isn't counted as missing.`).join(' ')}
        </div>` : ''}

      ${d.basic_issues.length ? `
        <div class="v3-section-title">⚠️ Basic pay that isn't the standard figure</div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Month</th><th>Basic paid</th><th>Expected</th><th>Difference</th><th>Contract</th></tr></thead>
            <tbody>${d.basic_issues.map(b => `
              <tr>
                <td>${esc(fmtMonth(b.month))}</td>
                <td>${fmtCurrency(b.paid)}</td>
                <td>${fmtCurrency(b.expected)}</td>
                <td class="${diffClass(b.diff)}">${b.diff < 0 ? '−' : '+'}${fmtCurrency(Math.abs(b.diff))}</td>
                <td>${b.contracted_weekly}h/week</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div></div>
        <div class="v3-note">
          Basic is a fixed monthly figure, so a month that isn't it usually means a contract change
          part-way through, unpaid absence, or an arrears adjustment folded in.
        </div>` : ''}

      <div class="v3-section-title">📆 Month by month</div>
      <div class="card"><div class="card-body" style="padding:0">
        <div class="table-wrapper"><table>
          <thead><tr>
            <th>Month</th><th>Worked</th><th>Contract</th><th>Extra owed</th>
            <th>Extra paid</th><th>Month</th><th>Running</th><th>Basic</th>
          </tr></thead>
          <tbody>${this.monthRows()}</tbody>
        </table></div>
      </div></div>
      <div class="v3-note">
        <strong>Running</strong> is the column that matters. A single month is always out, because
        extra hours are paid a month late — it's the running total failing to come back to zero
        that would mean something is genuinely missing.
      </div>

      ${d.worst_month_weeks.length ? `
        <div class="v3-section-title">🔎 The weeks behind ${esc(fmtMonth(d.worst_month.month))}</div>
        <div class="v3-muted" style="margin-bottom:10px">
          Its ${d.worst_month.owed}h of extra came from these weeks, and ${d.worst_month.paid}h was paid.
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Week from</th><th>Worked</th><th>Contract</th><th>Above contract</th><th>Days</th></tr></thead>
            <tbody>${d.worst_month_weeks.map(w => `
              <tr>
                <td>${fmtDate(w.week_start)}</td>
                <td>${w.worked}h</td>
                <td>${w.contract}h</td>
                <td class="diff-pos">+${w.excess}h</td>
                <td class="v3-muted">${w.days.map(x => `${fmtDayShort(x.date)} ${x.hours}h`).join(', ')}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div></div>` : ''}

      <div class="v3-section-title">📐 How this is worked out</div>
      <div class="card"><div class="card-body">
        <p style="margin:0 0 10px">
          Basic pay covers your contracted hours as a flat monthly amount — contracted weekly hours
          × 52 ÷ 12 × your rate — whether you work more or less. Anything above contract is paid as
          additional hours, and those are counted <strong>per week</strong>: a 25-hour week on a
          20-hour contract earns 5 extra hours, and a 15-hour week the next week doesn't take them
          back.
        </p>
        <p style="margin:0;color:var(--text-muted);font-size:13px">
          That weekly rule wasn't assumed, it was checked. Against every payslip on file, totalling
          each week's excess predicts the additional hours actually paid to within about 5%. Doing
          the same sum monthly, where a light week cancels a heavy one, is out by a third. The
          remaining 5% is why the headline has a margin and only calls a shortfall when it clears it.
        </p>
      </div></div>
    `;

    document.getElementById('paYear')?.addEventListener('change', e => {
      this.year = Number(e.target.value);
      this.load();
    });
  },
});
