/* ─── 🏖️ Leave Optimiser (V3.0) ───────────────────────────────────────────
   Ranks possible leave bookings by how many days off each one actually buys.
   The day strips are the point of the view — you can see at a glance that three
   booked days sit between two rest weekends rather than just being told so.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('leave-planner', '🏖️ Leave Optimiser', {
  months: 9,
  maxSpan: 16,
  data: null,

  async init() {
    document.getElementById('view-leave-planner').innerHTML = V3.loading('Looking for the long weekends…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.leavePlanner(this._to(), this.maxSpan);
      this.render();
    } catch (e) {
      document.getElementById('view-leave-planner').innerHTML = V3.error(e);
    }
  },

  /** End of the search window, `months` out from today. */
  _to() {
    const d = new Date();
    d.setMonth(d.getMonth() + this.months);
    return fmtLocalDate(d);
  },

  /* ── Small formatters ───────────────────────────────────────────────────── */

  shortDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${fmtDayShort(dateStr)} ${d} ${MONTHS_SHORT[m - 1]}`;
  },

  KINDS: {
    working:        { cls: 'working',      label: 'Rostered' },
    likely_working: { cls: 'working guess', label: 'Probably rostered' },
    off:            { cls: 'off',          label: 'Already off' },
    likely_off:     { cls: 'off guess',    label: 'Probably off' },
    booked_leave:   { cls: 'leave',        label: 'Leave already booked' },
  },

  /** One box per day of a break. Booked days (the ones costing leave) are the
   *  amber ones; everything else is time the break picks up for free. */
  strip(days) {
    return `<div class="v3-strip">${days.map(d => {
      const kind = this.KINDS[d.kind] || { cls: '' };
      const num = Number(d.date.slice(8, 10));
      return `<div class="v3-strip-day ${kind.cls}${d.booked ? ' booked' : ''}${d.is_bank_holiday ? ' bh' : ''}"
                   title="${esc(this.shortDate(d.date))} — ${esc(d.booked ? 'book leave' : kind.label)}">
        <div class="v3-strip-dow">${fmtDayShort(d.date)}</div>
        <div class="v3-strip-num">${num}</div>
      </div>`;
    }).join('')}</div>`;
  },

  key() {
    return `<div class="v3-strip-key">
      <span><i class="v3-strip-swatch" style="background:rgba(245,158,11,0.18);border-color:var(--warning)"></i> Leave you'd book</span>
      <span><i class="v3-strip-swatch" style="background:rgba(16,185,129,0.13)"></i> Already off</span>
      <span><i class="v3-strip-swatch" style="background:rgba(59,130,246,0.13)"></i> Leave already booked</span>
      <span><i class="v3-strip-swatch" style="border-style:dashed"></i> Predicted from your pattern</span>
      <span><i class="v3-strip-swatch" style="box-shadow:inset 0 -3px 0 var(--info)"></i> Bank holiday</span>
    </div>`;
  },

  confidenceBadge(c) {
    return {
      confirmed: '<span class="badge badge-success">Published rota</span>',
      'partly-predicted': '<span class="badge badge-warning">Part predicted</span>',
      predicted: '<span class="badge badge-muted">Predicted</span>',
    }[c.confidence] || '';
  },

  /** One plan, as a card. */
  plan(c) {
    const warnings = [];
    if (c.predicted_leave_days) {
      warnings.push(`${c.predicted_leave_days} of these days aren't on the published rota yet — the shape could change.`);
    }
    if (c.double_pay_lost) {
      warnings.push(`Includes a bank holiday you're rostered on: booking it gives up about
                     ${fmtCurrency(c.double_pay_lost)} of double-time as well as the day.`);
    }
    if (c.spans_leave_year_end) {
      warnings.push('Crosses the end of your leave year, so it spends from two different allowances.');
    }

    return `<div class="card" style="margin-bottom:14px"><div class="card-body">
      <div class="v3-plan-head">
        <div>
          <div class="v3-plan-ratio">${c.break_days} days off for ${c.leave_days}</div>
          <div class="v3-plan-dates">
            ${esc(this.shortDate(c.break_start))} → ${esc(this.shortDate(c.break_end))}
            · starts in ${c.starts_in_days} days
          </div>
        </div>
        <div style="text-align:right">
          <div class="v3-plan-ratio">×${c.efficiency}</div>
          <div class="v3-plan-dates">days off per day booked</div>
        </div>
      </div>

      <div style="margin:12px 0 8px">${this.strip(c.days)}</div>

      <div class="v3-chips">
        ${this.confidenceBadge(c)}
        <span class="v3-chip plain">Book: ${c.leave_dates.map(d => esc(this.shortDate(d))).join(', ')}</span>
        ${c.bank_holidays.map(b => `<span class="v3-chip">🎉 ${esc(b.title)}</span>`).join('')}
        <span class="v3-chip plain">${c.hours_booked}h of allowance</span>
      </div>

      ${warnings.map(w => `<div class="v3-note">${w}</div>`).join('')}
    </div></div>`;
  },

  toolbar() {
    const spans = [7, 10, 16, 21];
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Look ahead:</label>
        <select id="lpMonths" style="width:auto">
          ${[3, 6, 9, 12, 18].map(m =>
            `<option value="${m}" ${m === this.months ? 'selected' : ''}>${m} months</option>`).join('')}
        </select>
      </div>
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Longest break:</label>
        <select id="lpSpan" style="width:auto">
          ${spans.map(s =>
            `<option value="${s}" ${s === this.maxSpan ? 'selected' : ''}>${s} days</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-leave-planner');
    const best = d.candidates[0];

    if (!best) {
      el.innerHTML = V3.backButton() + this.toolbar() +
        V3.empty('🏖️', 'Nothing to optimise in this window',
          'Either there are no rostered days ahead, or every one of them is already leave.');
      this.wire();
      return;
    }

    const remaining = d.leave.configured ? d.leave.remaining_days : null;
    const affordable = remaining == null ? d.candidates
      : d.candidates.filter(c => c.leave_days <= Math.floor(remaining));

    el.innerHTML = `
      ${V3.backButton()}
      ${this.toolbar()}

      <div class="v3-hero" style="background:linear-gradient(135deg,#0EA5E9,#0F766E)">
        <div class="v3-hero-label">BEST VALUE BOOKING</div>
        <div class="v3-hero-value">${best.break_days} days off</div>
        <div class="v3-hero-sub">
          for <strong>${best.leave_days}</strong> day${best.leave_days === 1 ? '' : 's'} of leave —
          ${esc(this.shortDate(best.break_start))} to ${esc(this.shortDate(best.break_end))}.
          That's <strong>×${best.efficiency}</strong> back on what you spend.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Leave remaining', remaining == null ? 'Not set' : remaining + ' days',
                  d.leave.configured
                    ? `${d.leave.remaining_hours}h left of ${d.leave.entitlement_hours}h`
                    : 'Set your entitlement in the Leave tab',
                  remaining != null && remaining <= 0 ? 'danger' : '')}
        ${V3.tile('Rota published to', esc(this.shortDate(d.rota_horizon)),
                  `${d.rota_horizon_days} days out — past that is predicted`)}
        ${V3.tile('Distinct plans', d.totals.distinct_count,
                  `${d.totals.candidate_count} in all, near-identical ones collapsed`)}
        ${V3.tile('Bank holidays ahead', d.bank_holidays.length,
                  d.bank_holidays.filter(b => b.rostered).length
                    ? `${d.bank_holidays.filter(b => b.rostered).length} you're rostered on`
                    : 'None rostered yet')}
      </div>

      ${Object.keys(d.best_by_cost).length ? `
        <div class="v3-section-title">💡 Best plan at each price</div>
        <div class="v3-grid v3-grid-sm" style="margin-bottom:6px">
          ${Object.entries(d.best_by_cost).map(([cost, c]) => `
            <button class="v3-hub-card" data-jump="${esc(c.id)}" style="text-align:left">
              <span class="v3-hub-icon">${'🏖️'}</span>
              <span class="v3-hub-name">${cost} day${cost === '1' ? '' : 's'} → ${c.break_days} off</span>
              <span class="v3-hub-blurb">${esc(this.shortDate(c.break_start))} – ${esc(this.shortDate(c.break_end))} · ×${c.efficiency}</span>
            </button>`).join('')}
        </div>
        <div class="v3-muted">Tap one to scroll to the full plan below.</div>` : ''}

      <div class="v3-section-title">🥇 Top plans${affordable.length && remaining != null
        ? ` you can afford (${Math.floor(remaining)} day${Math.floor(remaining) === 1 ? '' : 's'} left)` : ''}</div>
      ${this.key()}
      <div id="lpPlans" style="margin-top:12px">
        ${(affordable.length ? affordable : d.candidates).slice(0, 10).map(c =>
          `<div id="plan-${esc(c.id)}">${this.plan(c)}</div>`).join('')}
      </div>
      ${remaining != null && !affordable.length ? `
        <div class="v3-note">
          Nothing here fits inside the ${remaining} days you have left, so these are the best
          plans regardless of allowance.
        </div>` : ''}

      <div class="v3-grid v3-grid-lg" style="margin-top:6px">
        <div class="card">
          <div class="card-header"><h2>📅 Which days you usually work</h2></div>
          <div class="card-body">
            ${V3.chart(d.pattern.map(p => ({
              label: p.short,
              value: p.pct,
              title: `${p.day}: worked ${p.worked} of ${p.occurrences} (${p.pct}%)`,
            })), p => (p.value >= 50 ? '' : 'success'))}
            <div class="v3-note">
              This is what fills in the days past ${esc(this.shortDate(d.rota_horizon))}, where there is
              no published rota to read. A weekday you work at least half the time is assumed to be a
              shift; anything below that is assumed to be a day off.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>🎉 Bank holidays in range</h2></div>
          <div class="card-body" style="padding:0">
            ${d.bank_holidays.length ? `
              <div class="table-wrapper"><table>
                <thead><tr><th>Date</th><th>Holiday</th><th>You</th></tr></thead>
                <tbody>${d.bank_holidays.map(b => `
                  <tr>
                    <td><span class="shift-date">${fmtDate(b.date)}</span><br><span class="shift-day">${esc(b.day.slice(0, 3))}</span></td>
                    <td>${esc(b.title || '—')}</td>
                    <td>${b.rostered
                      ? '<span class="badge badge-warning">Rostered — double pay</span>'
                      : b.kind === 'booked_leave'
                        ? '<span class="badge badge-info">On leave</span>'
                        : '<span class="badge badge-success">Off</span>'}</td>
                  </tr>`).join('')}</tbody>
              </table></div>` : `<div class="card-body">${V3.empty('🎉', 'No bank holidays in this window')}</div>`}
          </div>
        </div>
      </div>

      <div class="v3-note">
        Value is simply days off divided by days booked. It doesn't know what you actually want to do
        with the time — a ×4 in February is worth less than a ×2 over Christmas if Christmas is the
        one you care about. Treat the ranking as a shortlist, not an instruction.
      </div>
    `;

    this.wire();
  },

  wire() {
    const months = document.getElementById('lpMonths');
    if (months) months.addEventListener('change', e => { this.months = Number(e.target.value); this.load(); });
    const span = document.getElementById('lpSpan');
    if (span) span.addEventListener('change', e => { this.maxSpan = Number(e.target.value); this.load(); });

    document.querySelectorAll('#view-leave-planner [data-jump]').forEach(btn => {
      btn.addEventListener('click', () => {
        // The shortlist card may point at a plan outside the top ten, so render
        // it on demand rather than silently doing nothing.
        const id = btn.dataset.jump;
        let target = document.getElementById('plan-' + id);
        if (!target) {
          // The shortlist can name a plan that the near-duplicate filter kept
          // out of the main list, so look there too before giving up.
          const c = this.data.candidates.find(x => x.id === id)
            || Object.values(this.data.best_by_cost).find(x => x.id === id);
          if (!c) return;
          const wrap = document.createElement('div');
          wrap.id = 'plan-' + id;
          wrap.innerHTML = this.plan(c);
          document.getElementById('lpPlans').prepend(wrap);
          target = wrap;
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  },
});
