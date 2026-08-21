/* ─── Team Metrics View (V2.0 Phase 3) ──────────────────────────────────────
   Team Pay & Analytics Dashboard: weekly store spend, your share of the pot,
   average hourly wage, daily spend bar chart, pay distribution donut, and an
   hourly headcount/cost coverage heatmap. No charting library — everything
   is plain CSS (div bars, conic-gradient donut, grid heatmap) to match the
   rest of the app's dependency-free style.
   ───────────────────────────────────────────────────────────────────────── */

const TeamMetricsView = {
  _week: null, // any date within the target Mon-Sun week

  async init() {
    if (!this._week) this._week = _fmtDateDashTM(new Date());
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-team-metrics');
    el.innerHTML = `
      ${v2BackButton()}
      <div style="max-width:900px">
        <div class="card" style="padding:16px 20px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="tmPrevWeek">← Prev week</button>
            <span id="tmWeekLabel" style="font-weight:600;font-size:13.5px;min-width:220px"></span>
            <button class="btn btn-ghost btn-sm" id="tmNextWeek">Next week →</button>
            <button class="btn btn-ghost btn-sm" id="tmThisWeek">This week</button>
          </div>
        </div>

        <div id="tmWarnings"></div>
        <div id="tmCards"></div>
        <div id="tmDailyChart"></div>
        <div id="tmDonut"></div>
        <div id="tmHeatmap"></div>
      </div>
    `;
    document.getElementById('tmPrevWeek').addEventListener('click', () => this._shiftWeek(-7));
    document.getElementById('tmNextWeek').addEventListener('click', () => this._shiftWeek(7));
    document.getElementById('tmThisWeek').addEventListener('click', () => {
      this._week = _fmtDateDashTM(new Date());
      this.load();
    });
  },

  _shiftWeek(deltaDays) {
    const d = new Date(this._week + 'T12:00:00');
    d.setDate(d.getDate() + deltaDays);
    this._week = _fmtDateDashTM(d);
    this.load();
  },

  async load() {
    document.getElementById('tmCards').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
    let data;
    try {
      data = await API.getTeamMetrics(this._week);
    } catch (e) {
      document.getElementById('tmCards').innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(e.message)}</p>`;
      return;
    }
    this._data = data;
    this.renderWeekLabel(data.week);
    this.renderWarnings(data.warnings);
    this.renderCards(data);
    this.renderDailyChart(data.daily_spend);
    this.renderDonut(data.pay_distribution);
    this.renderHeatmap(data.heatmap);
  },

  renderWeekLabel(week) {
    const fmt = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    document.getElementById('tmWeekLabel').textContent = `${fmt(week.from)} – ${fmt(week.to)}`;
  },

  renderWarnings(warnings) {
    const el = document.getElementById('tmWarnings');
    if (!warnings || !warnings.length) { el.innerHTML = ''; return; }
    el.innerHTML = warnings.map(w => `
      <div style="padding:10px 12px;background:rgba(245,158,11,0.1);border-left:4px solid var(--warning,#f59e0b);
        border-radius:6px;margin-bottom:14px;font-size:13px;color:#b45309">⚠️ ${esc(w)}</div>
    `).join('');
  },

  renderCards(data) {
    const fmtP = v => v == null ? '—' : '£' + v.toFixed(2);
    const fmtPct = v => v == null ? '—' : v.toFixed(1) + '%';
    document.getElementById('tmCards').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
        <div class="stat-card">
          <div class="stat-label">Est. Store Wage Bill</div>
          <div class="stat-value">${fmtP(data.total_store_spend)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${data.total_store_hours}h scheduled</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Your Capture Share</div>
          <div class="stat-value">${fmtPct(data.your_share_pct)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${fmtP(data.your_gross_earnings)} of the pot</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Store Rate</div>
          <div class="stat-value">${data.avg_hourly_wage != null ? '£' + data.avg_hourly_wage.toFixed(2) + '/hr' : '—'}</div>
        </div>
      </div>
    `;
  },

  renderDailyChart(daily) {
    const el = document.getElementById('tmDailyChart');
    if (!daily || !daily.length) { el.innerHTML = ''; return; }
    const max = Math.max(...daily.map(d => d.spend), 1);
    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Daily Store Spend</h4>
        <div style="display:flex;align-items:flex-end;gap:8px;height:120px">
          ${daily.map(d => {
            const pct = Math.round((d.spend / max) * 100);
            const isWknd = d.dow === 'Sat' || d.dow === 'Sun';
            return `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
                <span style="font-size:10.5px;color:var(--text-muted)">${d.spend ? '£' + d.spend.toFixed(0) : ''}</span>
                <div style="width:100%;background:${isWknd ? 'var(--warning,#f59e0b)' : 'var(--primary)'};
                  border-radius:4px 4px 0 0;height:${Math.max(pct, d.spend ? 4 : 0)}px;transition:height .3s"></div>
                <span style="font-size:11px;color:${isWknd ? 'var(--warning,#f59e0b)' : 'var(--text-muted)'};font-weight:${isWknd ? 600 : 400}">${d.dow}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
  },

  renderDonut(dist) {
    const el = document.getElementById('tmDonut');
    if (!dist || !dist.length) { el.innerHTML = ''; return; }
    const colors = { management: '#6366f1', supervisor: '#f59e0b', floor_staff: '#10b981' };
    let cum = 0;
    const segments = dist.map(d => {
      const start = cum, end = cum + d.pct;
      cum = end;
      return `${colors[d.tier] || '#94a3b8'} ${start}% ${end}%`;
    }).join(', ');

    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Pay Distribution</h4>
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
          <div style="width:120px;height:120px;border-radius:50%;flex-shrink:0;
            background:conic-gradient(${segments}); position:relative">
            <div style="position:absolute;inset:18px;border-radius:50%;background:var(--card-bg);
              display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-muted)">
              ${dist.reduce((t, d) => t + d.spend, 0).toFixed(0) ? '£' + dist.reduce((t, d) => t + d.spend, 0).toFixed(0) : ''}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${dist.map(d => `
              <div style="display:flex;align-items:center;gap:8px;font-size:13px">
                <span style="width:10px;height:10px;border-radius:50%;background:${colors[d.tier] || '#94a3b8'};display:inline-block"></span>
                <span>${esc(d.label)} — £${d.spend.toFixed(2)} (${d.pct.toFixed(1)}%)</span>
              </div>`).join('')}
          </div>
        </div>
      </div>
    `;
  },

  renderHeatmap(heatmap) {
    const el = document.getElementById('tmHeatmap');
    if (!heatmap || !heatmap.length) { el.innerHTML = ''; return; }
    const hours = heatmap[0].hours.map(h => h.hour);

    const cellColor = (headcount) => {
      if (headcount === 0) return 'transparent';
      if (headcount <= 2) return 'rgba(239,68,68,0.55)';   // red — thin cover
      if (headcount === 3) return 'rgba(245,158,11,0.5)';  // amber — borderline
      return 'rgba(16,185,129,0.45)';                       // green — healthy
    };

    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px;overflow-x:auto">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Coverage Heatmap</h4>
        <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Headcount per hour · red = 2 or fewer on the floor · green = healthy cover</p>
        <table style="border-collapse:collapse;font-size:11px;white-space:nowrap">
          <thead>
            <tr>
              <th style="padding:3px 6px;text-align:left"></th>
              ${hours.map(h => `<th style="padding:3px 4px;color:var(--text-muted);font-weight:500">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${heatmap.map(day => `
              <tr>
                <td style="padding:3px 8px 3px 0;font-weight:600;color:var(--text-muted)">${day.dow}</td>
                ${day.hours.map(cell => `
                  <td title="${cell.headcount} staff · £${cell.cost.toFixed(2)}/hr"
                    style="padding:0;width:26px;height:24px;text-align:center;
                    background:${cellColor(cell.headcount)};border:1px solid var(--border)">
                    ${cell.headcount || ''}
                  </td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  },
};

function _fmtDateDashTM(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
