/* ─── 📊 Year in Numbers (V3.0) ────────────────────────────────────────────
   Every year side by side with the change on the year before. The current year
   is flagged as partial and compared on its projection, not its raw total.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('year-numbers', '📊 Year in Numbers', {
  async init() {
    document.getElementById('view-year-numbers').innerHTML = V3.loading('Lining up the years…');
    try {
      this.render(await V3.api.yearInNumbers());
    } catch (e) {
      document.getElementById('view-year-numbers').innerHTML = V3.error(e);
    }
  },

  ROWS: [
    { key: 'shifts',         label: 'Shifts',           icon: '📋' },
    { key: 'days_worked',    label: 'Days worked',      icon: '📅' },
    { key: 'hours',          label: 'Hours',            icon: '⏱️', unit: 'h' },
    { key: 'avg_shift',      label: 'Average shift',    icon: '📏', unit: 'h', noChange: true },
    { key: 'pay',            label: 'Shift pay',        icon: '💷', money: true },
    { key: 'gross',          label: 'Gross (payslips)', icon: '🧾', money: true, noChange: true },
    { key: 'net',            label: 'Take-home',        icon: '💰', money: true, noChange: true },
    { key: 'tax_ni',         label: 'Tax & NI',         icon: '🎩', money: true, noChange: true },
    { key: 'miles',          label: 'Miles',            icon: '🚗' },
    { key: 'weekend_shifts', label: 'Weekend shifts',   icon: '⚔️' },
    { key: 'bank_holidays',  label: 'Bank holidays',    icon: '🎆', noChange: true },
    { key: 'early_starts',   label: 'Early starts',     icon: '🌅', noChange: true },
    { key: 'late_finishes',  label: 'Late finishes',    icon: '🌙', noChange: true },
    { key: 'breaks_skipped', label: 'Breaks skipped',   icon: '🚫', noChange: true },
    { key: 'colleagues',     label: 'Colleagues',       icon: '👥' },
    { key: 'leave_days',     label: 'Leave days',       icon: '🏖️', noChange: true },
  ],

  fmt(row, v) {
    if (v == null) return '—';
    if (row.money) return fmtCurrency(v);
    return v + (row.unit || '');
  },

  render(d) {
    const el = document.getElementById('view-year-numbers');

    if (!d.years.length) {
      el.innerHTML = V3.empty('📊', 'No years to compare yet', 'Log some shifts and this fills in.');
      return;
    }

    const latest = d.years[0];
    const prev = d.years[1];

    el.innerHTML = `
      ${V3.backButton()}
      <div class="v3-hero" style="background:linear-gradient(135deg,#0EA5E9,#0C4A6E)">
        <div class="v3-hero-label">${latest.year}${latest.partial ? ` · ${latest.elapsed_pct}% ELAPSED` : ''}</div>
        <div class="v3-hero-value">${latest.hours}h</div>
        <div class="v3-hero-sub">
          ${latest.shifts} shifts, ${fmtCurrency(latest.pay)} of shift pay
          ${latest.projected ? ` · on track for ${latest.projected.hours}h and ${fmtCurrency(latest.projected.pay)} by year end` : ''}
          ${prev ? `<br>${this._headline(latest, prev)}` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>📋 Year on year</h2></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th></th>
                  ${d.years.map(y => `
                    <th style="text-align:right">
                      ${y.year}
                      ${y.partial ? '<br><span style="font-weight:400;font-size:10.5px;color:var(--text-muted)">part year</span>' : ''}
                    </th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${this.ROWS.map(row => `
                  <tr>
                    <td><strong>${row.icon} ${esc(row.label)}</strong></td>
                    ${d.years.map(y => {
                      const change = !row.noChange && y.change && y.change[row.key];
                      const isBest = d.best[row.key] === y.year;
                      return `<td style="text-align:right">
                        <div>${this.fmt(row, y[row.key])}${isBest ? ' 🏆' : ''}</div>
                        ${change && change.pct != null ? `
                          <div style="font-size:11px" class="${change.diff > 0 ? 'diff-pos' : change.diff < 0 ? 'diff-neg' : ''}">
                            ${change.diff > 0 ? '+' : ''}${change.pct}%${change.projected_basis ? '*' : ''}
                          </div>` : ''}
                      </td>`;
                    }).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="v3-note">
        🏆 marks your best complete year for that measure. Percentages compare against the year
        before.
        ${latest.partial ? `
          <br><br>
          ${latest.year} is only ${latest.elapsed_pct}% done, so a straight comparison would be
          meaningless. Values marked <strong>*</strong> compare its <em>projected</em> full-year
          figure against last year's actual — the raw number in the cell is what has genuinely
          happened so far.` : ''}
      </div>
    `;
  },

  _headline(latest, prev) {
    const c = latest.change && latest.change.hours;
    if (!c || c.pct == null) return '';
    const dir = c.diff > 0 ? 'up' : c.diff < 0 ? 'down' : 'level';
    if (dir === 'level') return `Level with ${prev.year}.`;
    return `${dir === 'up' ? '📈' : '📉'} ${Math.abs(c.pct)}% ${dir} on ${prev.year}` +
           (c.projected_basis ? ' (on projection)' : '') + '.';
  },
});
