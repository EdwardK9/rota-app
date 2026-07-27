/* ─── Insights View ────────────────────────────────────────────────────────── */

const InsightsView = {
  currentYear: getCurrentYear(),
  colleagueId: '',   // '' = me, number = colleague
  colleagues: [],
  data: null,
  customFrom: null,  // YYYY-MM-DD — used when currentYear === 'custom'
  customTo: null,

  async init() {
    await this.loadColleagues();
    this.render();
    await this.load();
  },

  async loadColleagues() {
    try {
      // Include left (past) employees too
      const rows = await API.get('/api/colleagues?include_left=1');
      this.colleagues = rows || [];
    } catch(_) { this.colleagues = []; }
  },

  render() {
    const el = document.getElementById('view-insights');
    const activeLeft = this.colleagues.filter(c => !c.left_date);
    const pastLeft   = this.colleagues.filter(c =>  c.left_date);

    const personOptions = [
      `<option value="">Me</option>`,
      activeLeft.map(c => `<option value="${c.id}" ${this.colleagueId == c.id ? 'selected':''}>${c.name}</option>`).join(''),
      pastLeft.length
        ? `<optgroup label="Past employees">${pastLeft.map(c => `<option value="${c.id}" ${this.colleagueId == c.id ? 'selected':''}>${c.name} (left)</option>`).join('')}</optgroup>`
        : ''
    ].join('');

    const yearOptions = [
      `<option value="all" ${this.currentYear==='all'?'selected':''}>All Time</option>`,
      `<option value="custom" ${this.currentYear==='custom'?'selected':''}>Custom range…</option>`,
      ...getYears().map(y => `<option value="${y}" ${y == this.currentYear ? 'selected':''}>${y}</option>`)
    ].join('');

    const showCustom = this.currentYear === 'custom';

    el.innerHTML = `
      <div class="toolbar" style="flex-wrap:wrap;row-gap:8px">
        <label style="margin-bottom:0;font-weight:500">Viewing:</label>
        <select id="insightsPersonSelect" style="width:auto;max-width:200px">
          ${personOptions}
        </select>
        <label style="margin-bottom:0;font-weight:500;margin-left:12px">Year:</label>
        <select id="insightsYearSelect" style="width:auto">
          ${yearOptions}
        </select>
        <span id="insightsCustomWrap" style="display:${showCustom ? 'inline-flex' : 'none'};gap:6px;align-items:center;margin-left:8px">
          <input type="date" id="insightsFromDate" value="${this.customFrom || ''}" style="width:auto" />
          <span style="color:var(--text-muted);font-size:12px">to</span>
          <input type="date" id="insightsToDate" value="${this.customTo || ''}" style="width:auto" />
          <button class="btn btn-primary btn-sm" id="insightsApplyRange">Apply</button>
        </span>
        <div class="toolbar-right">
          <button class="btn btn-ghost" id="insightsRefreshBtn">↻ Refresh</button>
        </div>
      </div>
      <div id="insightsContent" style="padding:0 20px"></div>
    `;
    document.getElementById('insightsPersonSelect').addEventListener('change', e => {
      this.colleagueId = e.target.value;
      this.load();
    });
    document.getElementById('insightsYearSelect').addEventListener('change', e => {
      this.currentYear = e.target.value;
      document.getElementById('insightsCustomWrap').style.display = this.currentYear === 'custom' ? 'inline-flex' : 'none';
      if (this.currentYear !== 'custom') this.load();
    });
    document.getElementById('insightsApplyRange')?.addEventListener('click', () => {
      const from = document.getElementById('insightsFromDate').value;
      const to   = document.getElementById('insightsToDate').value;
      if (!from || !to) { showToast('Pick both a from and to date', 'warning'); return; }
      if (from > to)     { showToast('From date must be before the to date', 'warning'); return; }
      this.customFrom = from;
      this.customTo   = to;
      this.load();
    });
    document.getElementById('insightsRefreshBtn').addEventListener('click', () => this.load());
  },

  async load() {
    const el = document.getElementById('insightsContent');
    el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</div>`;
    try {
      let params;
      if (this.currentYear === 'custom' && this.customFrom && this.customTo) {
        params = { from: this.customFrom, to: this.customTo };
      } else {
        params = { year: this.currentYear };
      }
      if (this.colleagueId) params.colleague_id = this.colleagueId;
      this.data = await API.getInsightsReport(params);
      this.renderContent();
    } catch(e) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">${e.message}</div>`;
    }
  },

  // ── Collapsible section helpers ──────────────────────────────────────────────
  // Collapsed/expanded state persists per section across reloads via localStorage.

  _isSectionCollapsed(key) {
    try { return localStorage.getItem('insights_collapsed_' + key) === '1'; } catch(_) { return false; }
  },

  _sectionHeader(key, title) {
    const collapsed = this._isSectionCollapsed(key);
    return `<h4 class="insights-section-header" data-sec="${key}"
        style="cursor:pointer;user-select:none;font-size:13px;font-weight:600;color:var(--text-muted);
        margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px">
      <span id="sec-icon-${key}" style="font-size:10px;display:inline-block;width:10px">${collapsed ? '▸' : '▾'}</span>${title}
    </h4>`;
  },

  _sectionBodyOpen(key) {
    const collapsed = this._isSectionCollapsed(key);
    return `<div id="sec-body-${key}" style="${collapsed ? 'display:none' : ''}">`;
  },

  _wireSectionToggles(root) {
    root.querySelectorAll('.insights-section-header').forEach(h => {
      h.addEventListener('click', () => {
        const key = h.dataset.sec;
        const collapsed = !this._isSectionCollapsed(key);
        try { localStorage.setItem('insights_collapsed_' + key, collapsed ? '1' : '0'); } catch(_) {}
        const body = document.getElementById('sec-body-' + key);
        const icon = document.getElementById('sec-icon-' + key);
        if (body) body.style.display = collapsed ? 'none' : '';
        if (icon) icon.textContent = collapsed ? '▸' : '▾';
      });
    });
  },

  // ── Streak helpers ───────────────────────────────────────────────────────────

  // "Time off" between two worked dates should not count approved annual leave days
  // as if they were an anomalous gap — a 2-week booked holiday would otherwise show up
  // as a huge "longest time off" spike. Mirrors the leave-exclusion logic already used
  // by longestStreak() below, so the two stats stay consistent with each other.
  gapStats(dates, leaveDates) {
    if (dates.length < 2) return { longest: 0, avg: 0 };
    const leaveSet = new Set(leaveDates || []);
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i-1]);
      const curr = new Date(dates[i]);
      const diffDays = (curr - prev) / 86400000;
      let leaveBetween = 0;
      const check = new Date(prev); check.setDate(check.getDate() + 1);
      while (check < curr) {
        if (leaveSet.has(fmtLocalDate(check))) leaveBetween++;
        check.setDate(check.getDate() + 1);
      }
      gaps.push(Math.max(0, diffDays - leaveBetween - 1));
    }
    const longest = Math.max(...gaps);
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    return { longest, avg: Math.round(avg * 10) / 10 };
  },

  // Streak counting consecutive work days, skipping leave dates
  longestStreak(workedDates, leaveDates, maxGap) {
    leaveDates = leaveDates || [];
    maxGap     = maxGap || 0;
    if (!workedDates.length) return 0;
    const leaveSet = new Set(leaveDates);
    let max = 1, cur = 1;
    for (let i = 1; i < workedDates.length; i++) {
      const prev = new Date(workedDates[i-1]);
      const curr = new Date(workedDates[i]);
      const diffDays = (curr - prev) / 86400000;
      // Count leave days that fall between the two worked dates
      let leaveBetween = 0;
      const check = new Date(prev); check.setDate(check.getDate() + 1);
      while (check < curr) {
        if (leaveSet.has(fmtLocalDate(check))) leaveBetween++;
        check.setDate(check.getDate() + 1);
      }
      const effectiveGap = diffDays - leaveBetween - 1;
      cur = effectiveGap <= maxGap ? cur + 1 : 1;
      if (cur > max) max = cur;
    }
    return max;
  },

  renderContent() {
    const el = document.getElementById('insightsContent');
    const d  = this.data;
    if (!d) return;

    const { topShiftTimes, topPairings, weeklyEarlyLate, monthlyWeekends,
            distinctWeekends, dayOfWeek, shiftDuration, bestWeek, workedDates,
            leaveDates, totalShifts, longestShift, shortestShift,
            annualLeaveDays, dowStats, deliveryDays, weeklyHours } = d;

    const leave     = leaveDates     || [];
    const alDays    = annualLeaveDays || 0;
    const delDays   = deliveryDays    || [];

    // Human-readable label for the currently selected period
    const periodLabel = this.currentYear === 'all' ? 'All Time'
      : this.currentYear === 'custom' ? `${fmtDate(d.rangeFrom || this.customFrom)} – ${fmtDate(d.rangeTo || this.customTo)}`
      : this.currentYear;

    const noData = !topShiftTimes.length && !topPairings.length && !weeklyEarlyLate.length;
    if (noData) {
      el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">
        <div style="font-size:36px;margin-bottom:8px">🔍</div>
        <div>No completed shift data for ${this.currentYear === 'all' ? 'any time' : periodLabel}</div>
      </div>`;
      return;
    }

    const totalEarly    = weeklyEarlyLate.reduce((s, w) => s + w.early_count, 0);
    const totalLate     = weeklyEarlyLate.reduce((s, w) => s + w.late_count,  0);
    const totalDelivery = weeklyEarlyLate.reduce((s, w) => s + (w.delivery_count || 0), 0);
    const totalWkShifts = weeklyEarlyLate.reduce((s, w) => s + w.total, 0);
    const totalSats     = monthlyWeekends.reduce((s, m) => s + m.saturday_count, 0);
    const totalSuns     = monthlyWeekends.reduce((s, m) => s + m.sunday_count,   0);
    const maxPairing    = topPairings.length   ? topPairings[0].count   : 1;
    const maxTime       = topShiftTimes.length ? topShiftTimes[0].count : 1;
    const streak        = this.longestStreak(workedDates, leave, 0);
    const streakGap     = this.longestStreak(workedDates, leave, 1);
    const gapStats      = this.gapStats(workedDates || [], leave);

    const viewLabel = this.colleagueId
      ? (this.colleagues.find(c => c.id == this.colleagueId)?.name || 'Colleague')
      : 'Me';

    // Weekly hours / overtime
    const wkHours = (weeklyHours && weeklyHours.length) ? weeklyHours : [];
    const hasContracted    = wkHours.some(w => w.contracted_hours != null);
    const hasOvertimePay   = !d.forColleague && wkHours.some(w => w.hourly_rate);
    // totalOvertimeHrs = sum of POSITIVE overtime weeks only (actual overtime earned)
    // Under-contract weeks don't reduce this — quiet weeks ≠ negative overtime
    const totalOvertimeHrs = wkHours.reduce((s, w) => s + Math.max(0, w.overtime ?? 0), 0);
    const totalOvertimePay = hasOvertimePay
      ? wkHours.reduce((s, w) => s + Math.max(0, w.overtime ?? 0) * (w.hourly_rate || 0), 0)
      : 0;

    // Day-of-week labels (Mon first)
    const DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const DOW_ORDER  = [1,2,3,4,5,6,0]; // Mon→Sun, SQLite 0=Sun
    const dowMap     = Object.fromEntries((dayOfWeek||[]).map(r => [r.dow, r.count]));
    const dowCounts  = DOW_ORDER.map(dow => dowMap[dow] || 0);
    const maxDow     = Math.max(...dowCounts, 1);
    const busyDowIdx = dowCounts.indexOf(Math.max(...dowCounts));

    // Days worked out of possible per DOW (me only)
    const dowStatsHtml = (!d.forColleague && dowStats) ? (() => {
      const rows = DOW_ORDER.map((sqlDow, i) => {
        const st = dowStats[sqlDow];
        if (!st || st.total === 0) return null;
        const worked   = st.worked;
        const onLeave  = st.leave;
        const effective = st.total - onLeave;
        const pct = effective > 0 ? Math.round(worked / effective * 100) : 0;
        // Total = every calendar occurrence of this weekday since you started (st.total).
        // Not Worked = Total minus Worked (holiday days count as not-worked here).
        // Not Worked (excl. holiday) = same, but holiday days count as "worked" for this
        // column only. Server-side, a date can never be counted as both worked and on
        // leave (leave takes precedence), so these can never go negative or over 100%.
        const notWorked          = st.total - worked;
        const notWorkedExclLeave = st.total - worked - onLeave; // holiday counted as "worked" for this column only
        const leaveNote = onLeave > 0
          ? ` <span style="color:var(--success);font-size:11px">(${onLeave} on holiday)</span>` : '';
        return `<tr>
          <td><strong>${DOW_LABELS[i]}</strong></td>
          <td>${worked} / ${st.total}${leaveNote}</td>
          <td>${notWorked}</td>
          <td>${notWorkedExclLeave}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="flex:1;background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                <div style="width:${pct}%;background:var(--primary);height:100%;border-radius:4px"></div>
              </div>
              <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${pct}%</span>
            </div>
          </td>
        </tr>`;
      }).filter(Boolean).join('');
      return rows ? `
        ${this._sectionHeader('days-worked', '📊 Days worked (up to today)')}
        ${this._sectionBodyOpen('days-worked')}
        <div class="table-wrapper" style="margin-bottom:20px">
          <table>
            <thead><tr><th>Day</th><th>Worked / Total</th><th title="Total minus Worked — holiday days count as not worked">Not Worked</th><th title="Same as Not Worked, but holiday days count as worked">Not Worked (excl. holiday)</th><th>Rate</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        </div>` : '';
    })() : '';

    el.innerHTML = `
      <div style="padding-bottom:16px">
        <h3 class="report-section-heading">Shift Insights — ${viewLabel} · ${periodLabel}</h3>

        <!-- ── Top stat cards ─────────────────────────────────────── -->
        <div class="stats-grid" style="margin-bottom:20px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
          <div class="stat-card">
            <div class="stat-label">Total shifts</div>
            <div class="stat-value">${totalShifts}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${this.currentYear === 'all' ? 'all time' : periodLabel}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Weekends worked</div>
            <div class="stat-value">${distinctWeekends}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${totalSats} Sat · ${totalSuns} Sun</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Avg shift length</div>
            <div class="stat-value">${shiftDuration && shiftDuration.avg_hours ? fmtHours(shiftDuration.avg_hours) : '—'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
              ${shiftDuration && shiftDuration.min_hours ? fmtHours(shiftDuration.min_hours) : '—'} – ${shiftDuration && shiftDuration.max_hours ? fmtHours(shiftDuration.max_hours) : '—'}
            </div>
          </div>
          ${longestShift ? `<div class="stat-card">
            <div class="stat-label">Longest shift</div>
            <div class="stat-value">${fmtHours(longestShift.gross_hours ?? longestShift.hours_worked)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${longestShift.start_time}–${longestShift.end_time} · ${fmtDate(longestShift.date)}</div>
          </div>` : ''}
          ${shortestShift ? `<div class="stat-card">
            <div class="stat-label">Shortest shift</div>
            <div class="stat-value">${fmtHours(shortestShift.gross_hours ?? shortestShift.hours_worked)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${shortestShift.start_time}–${shortestShift.end_time} · ${fmtDate(shortestShift.date)}</div>
          </div>` : ''}
          <div class="stat-card">
            <div class="stat-label">Longest streak</div>
            <div class="stat-value">${streak} shift${streak !== 1 ? 's' : ''}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">excl. holiday</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Streak (≤1 day off)</div>
            <div class="stat-value">${streakGap} shift${streakGap !== 1 ? 's' : ''}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">allowing 1 rest day</div>
          </div>
          ${!d.forColleague && alDays > 0 ? `<div class="stat-card">
            <div class="stat-label">Annual leave used</div>
            <div class="stat-value success">${alDays % 1 === 0 ? alDays : alDays.toFixed(1)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">day${alDays !== 1 ? 's' : ''}</div>
          </div>` : ''}
          ${bestWeek && !d.forColleague ? `<div class="stat-card">
            <div class="stat-label">Best week</div>
            <div class="stat-value success">${fmtCurrency(bestWeek.total_pay)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">w/c ${fmtDate(bestWeek.week_start)} · ${bestWeek.shift_count} shifts</div>
          </div>` : ''}
          <div class="stat-card">
            <div class="stat-label">Busiest day</div>
            <div class="stat-value">${DOW_LABELS[busyDowIdx]}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${dowCounts[busyDowIdx]} shifts</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Longest time off</div>
            <div class="stat-value">${gapStats.longest} day${gapStats.longest !== 1 ? 's' : ''}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">avg ${gapStats.avg}d between shifts</div>
          </div>
          ${wkHours.length && hasContracted ? `<div class="stat-card">
            <div class="stat-label">Overtime hours</div>
            <div class="stat-value success">+${fmtHours(totalOvertimeHrs)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">above contract</div>
          </div>` : ''}
          ${hasOvertimePay ? `<div class="stat-card">
            <div class="stat-label">Overtime pay</div>
            <div class="stat-value success">${fmtCurrency(totalOvertimePay)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">earned above contract</div>
          </div>` : ''}
        </div>

        <!-- ── Day of week bar chart ──────────────────────────────── -->
        ${this._sectionHeader('dow-chart', '📆 Shifts by day of week')}
        ${this._sectionBodyOpen('dow-chart')}
        <div style="display:flex;align-items:flex-end;gap:8px;margin-bottom:20px;height:80px">
          ${DOW_LABELS.map((label, i) => {
            const count = dowCounts[i];
            const pct   = Math.round((count / maxDow) * 100);
            const isWknd = i >= 5;
            return `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
                <span style="font-size:11px;color:var(--text-muted)">${count || ''}</span>
                <div style="width:100%;background:var(--border);border-radius:4px 4px 0 0;height:${Math.max(pct * 0.6, count ? 4 : 0)}px;background:${isWknd ? 'var(--warning)' : 'var(--primary)'}"></div>
                <span style="font-size:11px;color:${isWknd ? 'var(--warning)' : 'var(--text-muted)'};font-weight:${isWknd ? '600' : '400'}">${label}</span>
              </div>`;
          }).join('')}
        </div>
        </div>

        <!-- ── Days worked out of possible ────────────────────────── -->
        ${dowStatsHtml}

        <!-- ── Pairings + shift times ─────────────────────────────── -->
        ${this._sectionHeader('pairings-times', '👥 Pairings & common shift times')}
        ${this._sectionBodyOpen('pairings-times')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
          <div>
            <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">
              👥 Most common pairings
            </h4>
            ${topPairings.length ? topPairings.map((p, i) => {
              const pct = Math.round((p.count / maxPairing) * 100);
              const medals = ['🥇','🥈','🥉'];
              const label = medals[i] || (i + 1) + '.';
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                    <span style="font-size:13px;font-weight:${i < 3 ? '600' : '400'}">${label} ${p.name}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${p.count} shift${p.count !== 1 ? 's' : ''}</span>
                  </div>
                  <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                    <div style="width:${pct}%;background:var(--primary);height:100%;border-radius:4px;transition:width .3s"></div>
                  </div>
                </div>`;
            }).join('') : '<p style="color:var(--text-muted);font-size:13px">No colleague data found.<br>Team upload shifts to see pairings.</p>'}
          </div>

          <div>
            <h4 style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px">
              ⏰ Most common shift times
            </h4>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Top 10 · grouped by exact start–end time — a few minutes' difference in finish time counts as a different shift</div>
            ${topShiftTimes.length ? topShiftTimes.map((t, i) => {
              const pct = Math.round((t.count / maxTime) * 100);
              const medals = ['🥇','🥈','🥉'];
              const label = medals[i] || (i + 1) + '.';
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                    <span style="font-size:13px;font-weight:${i < 3 ? '600' : '400'};font-family:monospace">${label} ${t.start_time} – ${t.end_time}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${t.count}×</span>
                  </div>
                  <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
                    <div style="width:${pct}%;background:var(--success);height:100%;border-radius:4px;transition:width .3s"></div>
                  </div>
                </div>`;
            }).join('') : '<p style="color:var(--text-muted);font-size:13px">No completed shifts yet.</p>'}
          </div>
        </div>
        </div>

        <!-- ── Shift Distribution ─────────────────────────────────── -->
        ${weeklyEarlyLate.length ? `
        ${this._sectionHeader('shift-distribution', '🌅 Shift Distribution <small style="font-weight:400;font-size:11px">(early = 06:45 start · late = ends 19:00+ / 20:15+ pre-Feb 2026)</small>')}
        ${this._sectionBodyOpen('shift-distribution')}
        <div class="stats-grid" style="margin-bottom:12px;grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
          <div class="stat-card"><div class="stat-label">Early shifts</div><div class="stat-value success">${totalEarly}</div>
            <div style="font-size:11px;color:var(--text-muted)">${totalWkShifts ? Math.round(totalEarly/totalWkShifts*100) : 0}% of shifts</div></div>
          <div class="stat-card"><div class="stat-label">Late shifts</div><div class="stat-value warning">${totalLate}</div>
            <div style="font-size:11px;color:var(--text-muted)">${totalWkShifts ? Math.round(totalLate/totalWkShifts*100) : 0}% of shifts</div></div>
          ${totalDelivery > 0 ? `<div class="stat-card"><div class="stat-label">Delivery shifts</div><div class="stat-value" style="color:#8B5CF6">${totalDelivery}</div>
            <div style="font-size:11px;color:var(--text-muted)">${totalWkShifts ? Math.round(totalDelivery/totalWkShifts*100) : 0}% of shifts</div></div>` : ''}
          <div class="stat-card"><div class="stat-label">Avg early/week</div><div class="stat-value">${weeklyEarlyLate.length ? (totalEarly/weeklyEarlyLate.length).toFixed(1) : 0}</div></div>
          <div class="stat-card"><div class="stat-label">Avg late/week</div><div class="stat-value">${weeklyEarlyLate.length ? (totalLate/weeklyEarlyLate.length).toFixed(1) : 0}</div></div>
        </div>
        <div class="table-wrapper" style="margin-bottom:20px">
          <table>
            <thead><tr>
              <th>Week (Mon)</th><th>Shifts</th><th>🌅 Early (06:45)</th><th>🌆 Late (ends 19:00+)</th>
              ${totalDelivery > 0 ? '<th>🚚 Delivery</th>' : ''}<th>Split</th>
            </tr></thead>
            <tbody>
              ${weeklyEarlyLate.map(w => {
                const earlyPct = w.total ? Math.round(w.early_count / w.total * 100) : 0;
                return `<tr>
                  <td><strong>${fmtDate(w.week_start)}</strong></td>
                  <td>${w.total}</td>
                  <td style="color:var(--success)">${w.early_count}</td>
                  <td style="color:var(--warning)">${w.late_count}</td>
                  ${totalDelivery > 0 ? '<td style="color:#8B5CF6">' + (w.delivery_count || 0) + '</td>' : ''}
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;min-width:100px">
                      <div style="flex:1;background:var(--border);border-radius:4px;height:6px;overflow:hidden;display:flex">
                        <div style="width:${earlyPct}%;background:var(--success);height:100%"></div>
                        <div style="width:${100-earlyPct}%;background:var(--warning);height:100%"></div>
                      </div>
                      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${earlyPct}% Early</span>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        </div>` : ''}

        <!-- ── Weekly hours vs contracted ────────────────────────── -->
        ${wkHours.length ? `
        ${this._sectionHeader('weekly-hours', '⏱️ Weekly hours' + (hasContracted ? ' vs contracted' : ''))}
        ${this._sectionBodyOpen('weekly-hours')}
        <div class="table-wrapper" style="margin-bottom:20px">
          <table>
            <thead><tr>
              <th>Week (Mon)</th>
              <th>Worked</th>
              ${hasContracted ? '<th>Contracted</th><th>Over/Under</th>' : ''}
              ${hasOvertimePay ? '<th>Overtime pay</th>' : ''}
            </tr></thead>
            <tbody>
              ${wkHours.map(w => {
                const ot = w.overtime;
                const hasOT = ot != null;
                const otColor = hasOT && ot > 0 ? 'color:var(--success);font-weight:600'
                              : hasOT && ot < 0 ? 'color:var(--danger);font-weight:600' : '';
                const otLabel = hasOT
                  ? `${ot > 0 ? '+' : ''}${fmtHours(Math.abs(ot))}${ot < 0 ? ' under' : ot > 0 ? ' over' : ''}`
                  : '—';
                const otPay = hasOvertimePay ? Math.max(0, ot || 0) * (w.hourly_rate || 0) : 0;
                return `<tr>
                  <td><strong>${fmtDate(w.weekStart)}</strong></td>
                  <td>${fmtHours(w.hours_worked)}</td>
                  ${hasContracted ? `<td>${w.contracted_hours != null ? fmtHours(w.contracted_hours) : '—'}</td><td style="${otColor}">${otLabel}</td>` : ''}
                  ${hasOvertimePay ? `<td style="color:var(--success)">${otPay > 0 ? fmtCurrency(otPay) : '—'}</td>` : ''}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        </div>` : ''}

        <!-- ── Bank holidays worked ───────────────────────────────── -->
        ${this._sectionHeader('bank-holidays', '🎉 Bank holidays worked')}
        ${this._sectionBodyOpen('bank-holidays')}
        <div id="insightsBankHolSection" style="margin-bottom:20px"><p style="color:var(--text-muted);font-size:13px">Loading bank holiday stats…</p></div>
        </div>

        <!-- ── Weekend shifts per month ───────────────────────────── -->
        ${monthlyWeekends.length ? `
        ${this._sectionHeader('weekend-monthly', '📅 Weekend shifts per month')}
        ${this._sectionBodyOpen('weekend-monthly')}
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Month</th><th>🟡 Saturdays</th><th>🔴 Sundays</th></tr></thead>
            <tbody>
              ${monthlyWeekends.map(m => `<tr>
                <td><strong>${fmtMonth(m.month)}</strong></td>
                <td>${m.saturday_count || 0}</td>
                <td>${m.sunday_count || 0}</td>
              </tr>`).join('')}
              <tr style="font-weight:700;border-top:2px solid var(--border)">
                <td>TOTAL</td><td>${totalSats}</td><td>${totalSuns}</td>
              </tr>
            </tbody>
          </table>
        </div>
        </div>` : ''}

      </div>`;

    this._wireSectionToggles(el);

    // Async: load bank holiday stats after main render
    this.loadBankHolStats();
  },

  async loadBankHolStats() {
    const el = document.getElementById('insightsBankHolSection');
    if (!el) return;

    try {
      // Get bank holidays from the cached BankHols utility (England & Wales)
      // BankHols.load() returns a Set of YYYY-MM-DD strings
      const bhSet = await BankHols.load();
      const year = this.currentYear;
      const isCustom = year === 'custom' && this.customFrom && this.customTo;

      // Filter bank holidays for the selected year, custom range, or all years
      let bhDates = [...bhSet];
      if (isCustom) bhDates = bhDates.filter(d => d >= this.customFrom && d <= this.customTo);
      else if (year !== 'all') bhDates = bhDates.filter(d => d.startsWith(year));
      if (!bhDates.length) {
        el.innerHTML = '';
        return;
      }

      const params = new URLSearchParams({ dates: bhDates.join(',') });
      if (isCustom) { params.set('from', this.customFrom); params.set('to', this.customTo); }
      else if (year !== 'all') params.set('year', year);
      const stats = await API.get('/api/reports/bank-hol-stats?' + params.toString());

      const myPct = stats.total > 0 ? Math.round(stats.myCount / stats.total * 100) : 0;

      // Build a compact team comparison row (chips, not full table)
      let colHtml = '';
      if (!this.colleagueId && stats.colleagues.length) {
        const allEntries = [...stats.colleagues].sort((a, b) => b.count - a.count);
        const chips = allEntries.map(c => {
          const pct = Math.round(c.count / stats.total * 100);
          const firstName = c.name.split(' ')[0];
          return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;
            background:var(--bg);border:1px solid var(--border);font-size:11px;color:var(--text-muted);white-space:nowrap"
            title="${c.name}: ${c.count}/${stats.total} bank holidays">
            ${firstName}${c.left_date ? '†' : ''} <strong style="color:var(--text)">${pct}%</strong>
          </span>`;
        }).join('');
        colHtml = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>`;
      }

      const hoursStr = stats.myHoursWorked > 0
        ? (() => {
            const h = Math.floor(stats.myHoursWorked);
            const m = Math.round((stats.myHoursWorked - h) * 60);
            return m > 0 ? `${h}h ${m}m` : `${h}h`;
          })()
        : null;

      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:13px;font-weight:600;color:var(--text-muted)">Worked:</span>
          <span style="font-weight:700">${stats.myCount}/${stats.total}</span>
          <span style="font-size:12px;color:var(--text-muted)">(${myPct}%${!isCustom && year !== 'all' ? ' in ' + year : ''})</span>
          ${hoursStr ? `<span style="font-size:12px;color:var(--text-muted)">·</span>
          <span style="font-size:13px;color:var(--text-muted)">⏱ <strong style="color:var(--text)">${hoursStr}</strong> worked</span>` : ''}
        </div>
        ${colHtml}
      `;
    } catch(err) {
      console.error('[BankHolStats] error:', err);
      el.innerHTML = '';
    }
  },
};
