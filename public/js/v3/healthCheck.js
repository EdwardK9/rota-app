/* ─── 🩺 Data Doctor (V3.0) ────────────────────────────────────────────────
   Findings grouped by severity, each one expandable to the actual rows behind
   it. The rows matter more than the count — "87 shifts have stale hours" is a
   statistic, and the list of which ones is something you can act on.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('health-check', '🩺 Data Doctor', {
  data: null,
  open: {},

  async init() {
    document.getElementById('view-health-check').innerHTML = V3.loading('Reading every row…');
    try {
      this.data = await V3.api.healthCheck();
      this.render();
    } catch (e) {
      document.getElementById('view-health-check').innerHTML = V3.error(e);
    }
  },

  SEVERITY: {
    error:   { badge: 'badge-danger',  icon: '🛑', label: 'Costing you something' },
    warning: { badge: 'badge-warning', icon: '⚠️', label: 'Probably wrong' },
    info:    { badge: 'badge-muted',   icon: 'ℹ️', label: 'Worth tidying' },
  },

  /* ── Item tables ────────────────────────────────────────────────────────── */

  LABELS: {
    id: 'ID', date: 'Date', start_time: 'From', end_time: 'To', stored: 'Stored',
    expected: 'Should be', diff: 'Out by', break_scheduled_minutes: 'Break set',
    break_implied_by_hours: 'Break the hours imply', policy_break: 'Break policy gives',
    hours_are_stale: 'Hours are the stale bit', worth: 'Double-time lost', rate: 'Rate',
    is_bank_holiday: 'Bank holiday', ids: 'Shift IDs', overlap_mins: 'Overlap',
    first: 'One', second: 'The other', leave_type: 'Leave type', week_start: 'Week from',
    week_end: 'to', weeks_ago: 'Weeks ago', month: 'Month', shifts: 'Shifts', hours: 'Hours',
    days_taken: 'Days', clocked_in: 'Clocked in', clocked_out: 'Clocked out',
    rostered: 'Rostered', issue: 'What', name: 'Who', count: 'How many',
    start_date: 'From', end_date: 'To',
  },

  cell(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value)) return esc(value.join(', '));
    if (key === 'worth') return fmtCurrency(value);
    if (key === 'rate') return fmtCurrency(value);
    if (key === 'overlap_mins') return value + ' min';
    if (/_minutes$|^policy_break$|_by_hours$/.test(key)) return value + ' min';
    if (/^date$|_date$|^week_start$|^week_end$/.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${fmtDate(value)} <span class="v3-muted">${fmtDayShort(value)}</span>`;
    }
    if (key === 'month' && /^\d{4}-\d{2}$/.test(value)) return esc(fmtMonth(value));
    return esc(String(value));
  },

  table(items) {
    const keys = Object.keys(items[0]);
    return `<div class="table-wrapper"><table>
      <thead><tr>${keys.map(k => `<th>${esc(this.LABELS[k] || k.replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
      <tbody>${items.map(it => `<tr>${keys.map(k =>
        `<td>${this.cell(k, it[k])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  },

  finding(f) {
    const sev = this.SEVERITY[f.severity] || {};
    const isOpen = !!this.open[f.code];
    return `<div class="card" style="margin-bottom:12px">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <div style="font-weight:700;font-size:14.5px">
              ${sev.icon} ${esc(f.title)}
              <span class="badge ${sev.badge}" style="margin-left:6px">${f.count}</span>
            </div>
            <div class="v3-muted" style="margin-top:6px;line-height:1.55">${esc(f.detail)}</div>
            ${f.fix ? `<div class="v3-chips"><span class="v3-chip plain">🔧 ${esc(f.fix)}</span></div>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" data-toggle="${esc(f.code)}">
            ${isOpen ? 'Hide' : `Show ${f.count > 50 ? 'first 50' : 'the rows'}`}
          </button>
        </div>
        ${isOpen ? `<div style="margin-top:14px">
          ${this.table(f.items)}
          ${f.truncated ? `<div class="v3-muted" style="margin-top:8px">…and ${f.truncated} more.</div>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-health-check');
    const clean = !d.findings.length;

    const order = { error: 0, warning: 1, info: 2 };
    const findings = d.findings.slice().sort((a, b) =>
      order[a.severity] - order[b.severity] || b.count - a.count);

    el.innerHTML = `
      ${V3.backButton()}

      <div class="v3-hero" style="background:${clean
        ? 'linear-gradient(135deg,#10B981,#065F46)'
        : d.counts.errors
          ? 'linear-gradient(135deg,#EF4444,#7F1D1D)'
          : 'linear-gradient(135deg,#F59E0B,#7C2D12)'}">
        <div class="v3-hero-label">DATA HEALTH</div>
        <div class="v3-hero-value">${clean ? 'All clear' : d.score + '/100'}</div>
        <div class="v3-hero-sub">
          ${clean
            ? `Every check passed across ${d.checked.shifts} shifts, ${d.checked.payslips} payslips and ${d.checked.colleague_shifts} team rows.`
            : `${d.counts.groups} thing${d.counts.groups === 1 ? '' : 's'} worth looking at across
               ${d.checked.shifts} shifts, ${d.checked.leave_entries} leave entries and
               ${d.checked.clock_entries} clock records. Nothing here has been changed — this only looks.`}
        </div>
        ${clean ? '' : `<div class="v3-hero-bar"><span style="width:${Math.max(0, Math.min(100, d.score))}%"></span></div>`}
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Costing you money', d.counts.errors, 'Unflagged bank holidays, missing rates',
                  d.counts.errors ? 'danger' : 'success')}
        ${V3.tile('Probably wrong', d.counts.warnings, 'Stale figures, duplicates, gaps',
                  d.counts.warnings ? 'warning' : 'success')}
        ${V3.tile('Worth tidying', d.counts.info, 'Nothing breaks if you ignore these')}
        ${V3.tile('Checks run', d.checked.checks_run, `Over ${(d.checked.shifts + d.checked.colleague_shifts).toLocaleString()} rows`)}
      </div>

      ${clean
        ? V3.empty('✅', 'Nothing to report', 'Every check passed. Come back after the next import.')
        : `<div id="hcFindings">${findings.map(f => this.finding(f)).join('')}</div>`}

      <div class="v3-note">
        The score is how many rows came through clean, weighted so a bank holiday paying single
        time counts for more than a shift you forgot to tick off. It's a prompt, not a grade —
        some of these are genuinely fine, and a few will be things you did on purpose.
      </div>
    `;

    el.querySelectorAll('[data-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.toggle;
        this.open[code] = !this.open[code];
        this.render();
        // Keep the finding you just expanded under the cursor rather than
        // jumping back to the top of a long page.
        document.querySelector(`[data-toggle="${CSS.escape(code)}"]`)
          ?.scrollIntoView({ block: 'center' });
      });
    });
  },
});
