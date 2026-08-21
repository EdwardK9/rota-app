/* ─── ⏰ Overtime Tracker (V3.0) ───────────────────────────────────────────
   Hours beyond contract, week by week, and what share of your pay they are.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('overtime', '⏰ Overtime Tracker', {
  year: getCurrentYear(),

  async init() {
    document.getElementById('view-overtime').innerHTML = V3.loading('Counting the extra hours…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.overtime(this.year));
    } catch (e) {
      document.getElementById('view-overtime').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-overtime');
    const picker = V3.yearPicker('otYear', this.year, true);

    if (!d.totals || !d.totals.weeks_counted) {
      el.innerHTML = picker + V3.empty('⏰', 'No complete weeks in this period',
        'Pick another year, or come back once a full week has passed.');
      document.getElementById('otYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
      return;
    }

    const t = d.totals;
    const positive = t.net_hours >= 0;

    el.innerHTML = `
      ${picker}

      <div class="v3-hero" style="background:${positive
        ? 'linear-gradient(135deg,#10B981,#065F46)' : 'linear-gradient(135deg,#6366F1,#312E81)'}">
        <div class="v3-hero-label">HOURS BEYOND CONTRACT</div>
        <div class="v3-hero-value">${positive ? '+' : ''}${t.net_hours}h</div>
        <div class="v3-hero-sub">
          ${t.extra_hours}h over across ${t.weeks_over} weeks${t.short_hours > 0 ? `, ${t.short_hours}h short across ${t.weeks_under}` : ''} —
          worth <strong>${fmtCurrency(t.extra_value)}</strong>, or ${t.extra_share_pct}% of everything you earned.
        </div>
        <div class="v3-hero-bar"><span style="width:${t.over_pct}%"></span></div>
        <div class="v3-hero-sub" style="margin-top:8px">
          You went over contract in ${t.over_pct}% of complete weeks (${t.weeks_over} of ${t.weeks_counted}).
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Average week', t.avg_week + 'h', `contracted ${t.avg_contracted}h`)}
        ${V3.tile('Extra hours', t.extra_hours + 'h', `≈ ${t.extra_as_shifts} extra shifts`, 'success')}
        ${V3.tile('Worth', fmtCurrency(t.extra_value), 'At your normal rate', 'success')}
        ${V3.tile('Weeks over / under', `${t.weeks_over} / ${t.weeks_under}`, `${t.weeks_exact} bang on`)}
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="card-header"><h2>📊 Hours over contract, by month</h2></div>
        <div class="card-body">
          ${V3.chart(d.by_month.map(m => ({
            label: V3.shortMonth(m.month),
            value: Math.abs(m.extra),
            title: `${m.month}: ${m.extra > 0 ? '+' : ''}${m.extra}h vs contract (${m.hours}h worked, ${m.contracted}h contracted)`,
            over: m.extra >= 0,
          })), pt => (pt.over ? 'success' : 'danger'))}
          <div class="v3-note">
            Green months went over contract, red fell short. Bar height is the size of the gap
            either way, so a tall red bar is a quiet month, not a busy one.
          </div>
        </div>
      </div>

      ${d.biggest_week ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
            <div>
              <strong>🏆 Your biggest week over contract</strong>
              <div class="v3-muted" style="margin-top:4px">
                Week of ${fmtDate(d.biggest_week.week)} — ${d.biggest_week.hours}h against a
                ${d.biggest_week.contracted}h contract, across ${d.biggest_week.shifts} shifts.
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:26px;font-weight:800;color:var(--success)">+${d.biggest_week.extra}h</div>
              <div class="v3-muted">${fmtCurrency(d.biggest_week.extra_value)} extra</div>
            </div>
          </div>
        </div>` : ''}

      <div class="card">
        <div class="card-header"><h2>📅 Week by week</h2></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Week</th><th>Shifts</th><th>Hours</th><th>Contracted</th><th>Difference</th><th>Extra worth</th></tr></thead>
              <tbody>
                ${d.weeks.slice().reverse().slice(0, 60).map(w => `
                  <tr${w.partial ? ' style="opacity:0.55"' : ''}>
                    <td><span class="shift-date">${fmtDate(w.week)}</span>${w.partial ? '<br><span class="shift-day">in progress</span>' : ''}</td>
                    <td>${w.shifts}</td>
                    <td>${w.hours}h</td>
                    <td>${w.contracted || '—'}h</td>
                    <td class="${w.extra > 0 ? 'diff-pos' : w.extra < 0 ? 'diff-neg' : ''}">
                      ${w.extra > 0 ? '+' : ''}${w.extra}h
                    </td>
                    <td>${w.extra > 0 ? fmtCurrency(w.extra_value) : '—'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="v3-note">
        Additional hours are paid at your normal rate rather than a premium, so this tracks
        <em>how much of your pay depends on shifts you were never contracted to do</em> rather than
        overtime uplift. The current week is greyed out and excluded from every average — a
        part-worked week always looks short.
      </div>
    `;

    document.getElementById('otYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
  },
});
