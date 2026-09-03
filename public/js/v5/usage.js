/* ─── 📈 App Usage (V5.0) ──────────────────────────────────────────────────
   Opens, session lengths, the hours of the day you reach for the app and the
   days you skip it entirely. Everything comes from /api/v5/usage; this file
   only draws.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-usage', '📈 App Usage', {
  data: null,

  async init() {
    const el = document.getElementById('view-v5-usage');
    el.innerHTML = V5.loading('Working out how you use this thing…');
    try {
      this.data = await V5.api.usage(V5.days);
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-v5-usage');
    const t = d.totals;

    if (!t.sessions) {
      el.innerHTML = `${V5.backButton()}${V5.daysPicker('v5UsageDays', V5.days)}
        ${V5.empty('📈', 'Nothing recorded in this period',
                   'Usage is recorded from the moment the feature is deployed — there is no history before that.')}`;
      this._wirePicker();
      return;
    }

    const trend = d.trend;
    const trendArrow = trend ? ({ up: '▲', down: '▼', steady: '▬' })[trend.direction] : '';
    const trendCls = trend ? ({ up: 'v5-bad', down: 'v5-good', steady: '' })[trend.direction] : '';

    el.innerHTML = `
      ${V5.backButton()}
      ${V5.daysPicker('v5UsageDays', V5.days)}

      <div class="v3-hero" style="background:linear-gradient(135deg,#0EA5E9,#0C4A6E)">
        <div class="v3-hero-label">TIME IN THE APP</div>
        <div class="v3-hero-value">${esc(t.total_label)}</div>
        <div class="v3-hero-sub">
          across ${t.sessions} visit${t.sessions === 1 ? '' : 's'} on ${t.days_used} days —
          about ${esc(t.avg_daily_label)} a day.
          ${trend ? `Lately ${trend.direction === 'steady' ? 'steady at' : trend.direction === 'up' ? 'up to' : 'down to'}
                     ${esc(trend.recent_label)} a day, from ${esc(trend.previous_label)}.` : ''}
        </div>
      </div>

      <div class="v3-grid v3-grid-sm">
        ${V5.tile('Visits', t.sessions, `${t.sessions_per_active_day} per day you used it`)}
        ${V5.tile('Typical visit', esc(t.median_session_label), `average ${esc(t.avg_session_label)}`)}
        ${V5.tile('Longest visit', esc(t.longest_session_label), 'single session')}
        ${V5.tile('Days used', `${t.days_used}<span class="v5-of">/${t.days_in_window}</span>`,
                  `${t.usage_rate_pct}% of days in the period`, V5.pctClass(t.usage_rate_pct))}
        ${V5.tile('Current streak', `${d.streaks.current}<span class="v5-of"> d</span>`,
                  `longest ever ${d.streaks.longest} days`)}
        ${V5.tile('Screens opened', t.views, `${(t.views / t.sessions).toFixed(1)} per visit`)}
        ${trend ? V5.tile('Trend', `${trendArrow} ${trend.change_pct != null ? Math.abs(trend.change_pct) + '%' : '—'}`,
                          `${esc(trend.recent_label)}/day vs ${esc(trend.previous_label)}`, trendCls) : ''}
        ${V5.tile('Installed', V5.pct(d.devices.installed_pct), 'visits from the home screen')}
      </div>

      <div class="v3-section-title">🕐 What time of day</div>
      <div class="card"><div class="card-body">
        <p class="v3-muted" style="margin-bottom:12px">
          When visits start. Median first look of the day
          <strong>${esc(d.rhythm.first_open_median || '—')}</strong>,
          last <strong>${esc(d.rhythm.last_open_median || '—')}</strong>.
        </p>
        ${V5.chart(d.by_hour.map(h => ({
          label: h.hour % 3 === 0 ? String(h.hour) : '',
          value: h.sessions,
          title: `${h.label} — ${h.sessions} visit${h.sessions === 1 ? '' : 's'}, ${V5.ms(h.view_ms)} on screen`,
        })), p => (p.value > 0 && p.value === Math.max(...d.by_hour.map(x => x.sessions)) ? 'highlight' : ''))}
      </div></div>

      <div class="v3-section-title">📅 Which days</div>
      <div class="card"><div class="card-body">
        ${V5.ranked(d.by_dow.map(x => ({
          label: x.day, value: x.ms,
          display: `${V5.ms(x.ms)} · ${x.sessions} visit${x.sessions === 1 ? '' : 's'}`,
        })))}
        <p class="v3-note">Totals, not averages — a day of the week that has come round more often in
        this period naturally accumulates more.</p>
      </div></div>

      <div class="v3-section-title">⏱️ How long you stay</div>
      <div class="card"><div class="card-body">
        ${V5.ranked(d.session_lengths.map(b => ({
          label: b.label, value: b.count,
          display: `${b.count} (${Math.round((b.count / t.sessions) * 100)}%)`,
        })))}
      </div></div>

      ${d.by_date.length ? (() => {
        const span = d.by_date.slice(-90);
        return `
        <div class="v3-section-title">📈 Day by day</div>
        <div class="card"><div class="card-body">
          ${V5.spark(span.map(x => ({
            label: x.date, value: x.minutes,
            title: `${x.date} — ${x.minutes} min across ${x.sessions} visit${x.sessions === 1 ? '' : 's'}`,
          })), [span[0].date, span[span.length - 1].date])}
          <p class="v3-note">Minutes per day. Gaps are days you never opened it.</p>
        </div></div>`;
      })() : ''}

      <div class="v3-section-title">🗂️ Recent visits</div>
      <div class="card"><div class="card-body">
        <div class="table-wrapper"><table>
          <thead><tr><th>Date</th><th>From</th><th>To</th><th>Length</th><th>Screens</th><th>Started on</th><th>Left on</th></tr></thead>
          <tbody>${d.recent_sessions.map(s => `
            <tr>
              <td>${esc(fmtDayShort(s.date))}</td>
              <td>${esc(s.started)}</td>
              <td>${esc(s.ended)}</td>
              <td>${esc(s.label)}</td>
              <td>${s.views}</td>
              <td class="v3-muted">${esc(s.entry_view || '—')}</td>
              <td class="v3-muted">${esc(s.exit_view || '—')}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div></div>

      ${d.devices.platforms.length > 1 ? `
        <div class="v3-section-title">📱 Devices</div>
        <div class="card"><div class="card-body">
          ${V5.ranked(d.devices.platforms.map(p => ({ label: p.name, value: p.count, display: `${p.count} (${p.pct}%)` })))}
        </div></div>` : ''}
    `;

    this._wirePicker();
  },

  _wirePicker() {
    document.getElementById('v5UsageDays')?.addEventListener('change', e => {
      V5.days = e.target.value;
      this.init();
    });
  },
});
