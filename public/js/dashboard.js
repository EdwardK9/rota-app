/* ─── Dashboard View (Next Shift) ─────────────────────────────────────────── */

const DashboardView = {
  _refreshTimer: null,

  async init(settings) {
    this.settings = settings || {};
    await this.render();
    // Refresh countdown every minute
    clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this.updateCountdown(), 1000);
  },

  // Rollover cutoff for the "Next In" card: once the store's effectively done for the
  // day, treat the roster as showing FROM tomorrow rather than today. 19:30 weekdays,
  // 18:30 Saturday, 16:30 Sunday. Independent of the physical store-closing time used
  // elsewhere (Team Calendar coverage gaps) — this is purely about when the dashboard
  // stops dwelling on a day that's already over.
  _nextInAnchorDate(today) {
    const pad = n => String(n).padStart(2, '0');
    const currentTime = `${pad(today.getHours())}:${pad(today.getMinutes())}`;
    const dow = today.getDay(); // 0=Sun … 6=Sat
    const cutoff = dow === 6 ? '18:30' : dow === 0 ? '16:30' : '19:30';
    if (currentTime < cutoff) return _fmtDateDash(today);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    return _fmtDateDash(tomorrow);
  },

  async render() {
    const el = document.getElementById('view-dashboard');
    el.innerHTML = `<div class="dash-loading">Loading…</div>`;

    // Fetch upcoming shifts (today → 60 days ahead)
    const today = new Date();
    const todayStr = _fmtDateDash(today);
    const future = new Date(today); future.setDate(future.getDate() + 60);
    const futureStr = _fmtDateDash(future);
    const nextInAnchor = this._nextInAnchorDate(today);

    // Whole current month (for the month summary card)
    const monthStart = `${todayStr.slice(0, 7)}-01`;
    const monthEnd = _fmtDateDash(new Date(today.getFullYear(), today.getMonth() + 1, 0));

    let shifts = [], nextIn = null, clockToday = null, monthShifts = [];
    try {
      [shifts, nextIn, clockToday, monthShifts] = await Promise.all([
        API.get(`/api/shifts?from=${todayStr}&to=${futureStr}`),
        API.get(`/api/colleagues/next-shifts?from=${nextInAnchor}&days=2`).catch(() => null),
        API.get('/api/clock/today').catch(() => null),
        API.get(`/api/shifts?from=${monthStart}&to=${monthEnd}`).catch(() => []),
      ]);
    } catch (e) {
      el.innerHTML = `<div class="dash-error">Could not load shifts.</div>`;
      return;
    }
    this._clockToday = clockToday;

    const now = new Date();
    const ce  = clockToday?.entry || null;
    const clockedInNotOut = !!(ce && ce.clocked_in && !ce.clocked_out);

    // Normal upcoming: shifts that haven't ended yet
    let upcoming = shifts.filter(s => new Date(`${s.date}T${s.end_time}`) > now);

    // If clocked in but not out, keep TODAY's shift as the hero even after it ends,
    // so the dashboard shows a live timer instead of jumping to tomorrow's shift.
    const todayShift = shifts.find(s => s.date === todayStr);
    if (clockedInNotOut && todayShift && !upcoming.some(s => s.id === todayShift.id)) {
      upcoming = [todayShift, ...upcoming];
    }

    el.innerHTML = `
      ${this._jsonReminderBanner()}
      <div class="dash-wrap">
        <div class="dash-left-col">
          <div id="dash-hero"></div>
          <div id="dash-upcoming"></div>
        </div>
        <div class="dash-right-col">
          <div id="dash-month-summary"></div>
          <div id="dash-next-in"></div>
        </div>
      </div>
    `;
    const jrDismiss = document.getElementById('dashJsonReminderDismiss');
    if (jrDismiss) jrDismiss.addEventListener('click', () => this._dismissJsonReminder());

    if (upcoming.length === 0) {
      document.getElementById('dash-hero').innerHTML = `
        <div class="dash-no-shift">
          <div class="dash-no-shift-icon">☀️</div>
          <div class="dash-no-shift-msg">No upcoming shifts in the next 60 days</div>
          <button class="btn btn-ghost btn-sm" onclick="App.navigate('shifts')">View all shifts →</button>
        </div>
      `;
    } else {
      await this.renderHero(upcoming[0], clockToday);
      this.renderUpcoming(upcoming.slice(1));
    }

    this.renderMonthSummary(monthShifts, todayStr);
    this.renderNextIn(nextIn, nextInAnchor);
  },

  // Compact month-at-a-glance card: worked/pay so far vs the full scheduled month
  renderMonthSummary(monthShifts, todayStr) {
    const el = document.getElementById('dash-month-summary');
    if (!el) return;
    if (!monthShifts || !monthShifts.length) { el.innerHTML = ''; return; }

    const done = monthShifts.filter(s => s.completed);
    const workedHours = done.reduce((t, s) => t + (s.hours_worked || 0), 0);
    const paySoFar    = done.reduce((t, s) => t + (s.calculated_pay || 0), 0);
    const schedHours  = monthShifts.reduce((t, s) => t + (s.hours_worked || 0), 0);
    const schedPay    = monthShifts.reduce((t, s) => t + (s.calculated_pay || 0), 0);
    const shiftsLeft  = monthShifts.filter(s => !s.completed && s.date >= todayStr).length;

    const monthName = new Date(todayStr + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long' });
    const fmtH = h => (Math.round(h * 10) / 10) + 'h';
    const fmtP = p => '£' + p.toFixed(2);

    const row = (label, value) => `
      <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13.5px">
        <span style="color:var(--text-muted)">${label}</span>
        <span style="font-weight:600">${value}</span>
      </div>`;

    el.innerHTML = `
      <div class="dash-upcoming-section" style="margin-top:0;margin-bottom:16px">
        <div class="dash-section-title">This Month — ${monthName}</div>
        ${row('Worked so far', `${fmtH(workedHours)} · ${fmtP(paySoFar)}`)}
        ${row('Month total (est.)', `${fmtH(schedHours)} · ${fmtP(schedPay)}`)}
        ${row('Shifts left', `${shiftsLeft}`)}
      </div>
    `;
  },

  // Monday date (YYYY-MM-DD) of the current week -- used as the dismiss key so the
  // banner reappears fresh each week rather than staying hidden forever.
  _currentMondayKey() {
    const d = new Date();
    const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
    d.setDate(d.getDate() - dow);
    return _fmtDateDash(d);
  },

  // Reminder card: nudge to upload last week's team JSON early in the week, when it's
  // still useful. Dismissible for the current week only (localStorage), shows Mon-Wed.
  _jsonReminderBanner() {
    const dow = new Date().getDay(); // 0=Sun..6=Sat
    if (dow !== 1 && dow !== 2 && dow !== 3) return '';
    const weekKey = this._currentMondayKey();
    if (localStorage.getItem('jsonReminderDismissed') === weekKey) return '';
    return `
      <div id="dashJsonReminder" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
        background:var(--card-bg);border:1px solid var(--border);border-left:4px solid var(--primary);
        border-radius:8px;padding:12px 14px;margin-bottom:16px">
        <span style="font-size:20px">📸</span>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;font-size:13.5px">Upload last week's team JSON</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:2px">
            The best way to keep everyone's Team Calendar accurate — screenshot last week's
            Rotageek team schedule and run it through Team Upload.
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="App.navigate('team-upload')">Upload now</button>
        <button class="btn btn-ghost btn-sm" id="dashJsonReminderDismiss" title="Hide for this week">✕</button>
      </div>`;
  },

  _dismissJsonReminder() {
    localStorage.setItem('jsonReminderDismissed', this._currentMondayKey());
    const el = document.getElementById('dashJsonReminder');
    if (el) el.remove();
  },

  async renderHero(shift, clockToday) {
    // Fetch colleagues working the same shift (clock state passed in from render)
    let colleagues = [], weather = null;
    if (clockToday === undefined) clockToday = this._clockToday || null;
    [colleagues, weather] = await Promise.all([
      API.get(`/api/working-with/${shift.date}?start_time=${shift.start_time}&end_time=${shift.end_time}`).catch(() => []),
      API.getCommuteWeather(shift.date, shift.start_time, shift.end_time).catch(() => null),
    ]);

    const el = document.getElementById('dash-hero');
    const isToday  = shift.date === _fmtDateDash(new Date());
    const isTomorrow = shift.date === _fmtDateDash(new Date(Date.now() + 86400000));
    const ceLive     = !!(clockToday?.entry && clockToday.entry.clocked_in && !clockToday.entry.clocked_out);
    const isOngoing  = this._isOngoing(shift.date, shift.start_time, shift.end_time) || ceLive;

    const dayFull      = this._fullDay(shift.date);
    const dateFormatted = this._longDate(shift.date);
    const duration     = this._duration(shift.start_time, shift.end_time);
    const countdown    = this._countdown(shift.date, shift.start_time, shift.end_time);

    let badgeClass, badgeText;
    if (isOngoing)       { badgeClass = 'dash-status-live';     badgeText = '● ON SHIFT'; }
    else if (isToday)    { badgeClass = 'dash-status-today';    badgeText = 'TODAY'; }
    else if (isTomorrow) { badgeClass = 'dash-status-tomorrow'; badgeText = 'TOMORROW'; }
    else {
      const d = new Date(shift.date + 'T12:00:00');
      const diffDays = Math.round((d - new Date(_fmtDateDash(new Date()) + 'T12:00:00')) / 86400000);
      badgeClass = 'dash-status-future';
      badgeText  = diffDays < 7
        ? d.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase()
        : `IN ${diffDays} DAYS`;
    }

    const colleagueHtml = colleagues.length > 0
      ? `<div class="dash-colleagues dash-colleagues-clickable" title="Tap to see who you're working with">
           <div class="dash-colleagues-label">👥 Working with</div>
           <div class="dash-colleagues-list">
             ${colleagues.map(c => `<span class="dash-colleague-chip${c.relation === 'crossover' ? ' dash-colleague-chip-crossover' : ''}"${c.note ? ` title="${c.note.replace(/"/g,'&quot;')}"` : ''}>${c.relation === 'crossover' ? '🔄 ' : ''}${c.name}</span>`).join('')}
           </div>
         </div>`
      : `<div class="dash-colleagues dash-colleagues-clickable" title="Tap to see who you're working with">
           <div class="dash-colleagues-label dash-colleagues-none">👤 No colleagues recorded for this shift</div>
         </div>`;

    el.innerHTML = `
      <div class="dash-hero-card${isOngoing ? ' dash-hero-live' : ''}">
        <div class="dash-hero-header">
          <div class="dash-hero-label">${ceLive ? 'Current Shift' : 'Next Shift'}</div>
          <span class="dash-status ${badgeClass}">${badgeText}</span>
        </div>

        <div class="dash-hero-day">${dayFull}</div>
        <div class="dash-hero-date">${dateFormatted}</div>

        <div class="dash-hero-time">${shift.start_time} <span class="dash-arrow">→</span> ${shift.end_time}</div>

        <div class="dash-hero-meta">
          <span class="dash-meta-pill">⏱ ${duration}</span>
          ${(() => {
            const sched = shift.break_scheduled_minutes || 0;
            const bt = shift.break_taken;
            const actual = bt === 'none' ? 0 : bt === 'half' ? Math.round(sched / 2) : sched;
            return actual > 0 ? `<span class="dash-meta-pill">☕ ${actual}m break</span>` : '';
          })()}
          ${shift.is_bank_holiday ? `<span class="dash-meta-pill dash-meta-bh">🏦 Bank Holiday</span>` : ''}
        </div>

        ${this._renderWeatherBadges(weather)}

        ${(() => {
          const ce = clockToday?.entry || null;
          const live = !!(ce && ce.clocked_in && !ce.clocked_out);
          const t = this._timerState(shift, ce, live);
          if (!t.text) return '';
          const payHtml = isOngoing ? this._renderPayCounter(shift) : '';
          return `<div class="dash-countdown${t.over ? ' dash-countdown-over' : ''}" id="dashCountdown"
            data-date="${shift.date}" data-start="${shift.start_time}" data-end="${shift.end_time}"
            data-live="${live ? '1' : '0'}" data-clockin="${ce?.clocked_in || ''}">
            ${t.text}
          </div>${payHtml}`;
        })()}

        ${colleagueHtml}

        ${shift.notes ? `<div class="dash-notes"><span class="dash-notes-icon">📝</span>${shift.notes}</div>` : ''}

        ${(() => {
          const ce = clockToday?.entry || null;
          if (!ce || !ce.clocked_in) {
            return `<button class="btn btn-clock-in" onclick="DashboardView.clockIn()">Clock In</button>`;
          } else if (!ce.clocked_out) {
            return `<div class="dash-clock-status">
              <span class="dash-clock-in-time">Clocked in ${ce.clocked_in}</span>
              <button class="btn btn-clock-out" onclick="DashboardView.clockOut()">Clock Out</button>
            </div>`;
          } else {
            return `<div class="dash-clock-status">
              <span class="dash-clock-done">✓ Clocked out ${ce.clocked_out}</span>
            </div>`;
          }
        })()}
      </div>
    `;

    const colleaguesEl = el.querySelector('.dash-colleagues-clickable');
    if (colleaguesEl) colleaguesEl.addEventListener('click', () => this.showWorkingWithModal(shift));
  },

  // Commute weather badges (V2.0 Phase 2.1) — shown on the hero card when a
  // home postcode is configured in Settings and the shift is within the
  // forecast horizon (~15 days).
  _renderWeatherBadges(weather) {
    if (!weather || !weather.available) return '';
    const leg = (icon, label, point) => {
      if (!point) return '';
      const alertsHtml = point.alerts && point.alerts.length
        ? point.alerts.map(a => ` <span class="dash-weather-alert">${a.icon} ${a.text}</span>`).join('')
        : '';
      return `<div class="dash-weather-row">
        <span>${icon} ${label} (${point.time}): ${Math.round(point.temp)}°C ${point.icon}</span>${alertsHtml}
      </div>`;
    };
    const rows = leg('🚗', 'Commute To', weather.commute_to) + leg('🚶', 'Commute Home', weather.commute_home);
    if (!rows) return '';
    return `<div class="dash-weather-box">${rows}</div>`;
  },

  _thr(dir, kind) {
    const st = window.App?.settings || {};
    const v = st[`clock_${dir}_${kind}_threshold`]
      ?? st[`clock_${kind}_threshold`]
      ?? 5;
    return parseInt(v, 10) || 0;
  },

  _timeDiffMins(actualHHMM, scheduledHHMM) {
    if (!actualHHMM || !scheduledHHMM) return 0;
    const [ah, am] = actualHHMM.split(':').map(Number);
    const [sh, sm] = scheduledHHMM.split(':').map(Number);
    return (ah * 60 + am) - (sh * 60 + sm);
  },

  _promptReason(diff, isClockOut = false) {
    return new Promise(resolve => {
      const direction = diff > 0 ? 'late' : 'early';
      const absMins   = Math.abs(diff);
      const lateInReasons   = ['🚌 Transport / traffic', '😴 Overslept', '🏥 Personal matter', '📋 Manager approved', '✏️ Other…'];
      const earlyInReasons  = ['⚡ Arrived early', '📋 Agreed with manager', '🏃 Beat the traffic', '✏️ Other…'];
      const lateOutReasons  = ['💼 Required to work', '🙋 Manager asked to stay', '🏪 Busy / couldn\'t leave', '📋 Manager approved', '✏️ Other…'];
      const earlyOutReasons = ['✅ Shift ended early', '📋 Manager agreed', '🏥 Personal matter', '✏️ Other…'];
      const reasons = isClockOut
        ? (diff > 0 ? lateOutReasons : earlyOutReasons)
        : (diff > 0 ? lateInReasons  : earlyInReasons);
      const opts = reasons.map((r, i) =>
        `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
          <input type="radio" name="dashReason" value="${r}" style="accent-color:var(--primary)" ${i===0?'checked':''} />
          <span style="font-size:14px">${r}</span>
        </label>`
      ).join('');
      const html = `
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">
          You're clocking ${direction} by <strong>${absMins} min</strong>. Please select a reason:
        </p>
        <div style="display:flex;flex-direction:column;gap:6px">${opts}</div>
        <div id="dashOtherWrap" style="display:none;margin-top:10px">
          <input type="text" id="dashOtherText" class="form-control" placeholder="Describe reason…" maxlength="120" />
        </div>
        <div style="display:flex;gap:8px;margin-top:18px">
          <button class="btn btn-primary" id="dashReasonConfirm" style="flex:1">Confirm</button>
          <button class="btn btn-ghost" id="dashReasonSkip">Skip</button>
        </div>`;
      Modal.open('Reason for clocking ' + direction, html);
      document.querySelectorAll('input[name="dashReason"]').forEach(r =>
        r.addEventListener('change', () => {
          const isOther = r.value.startsWith('✏️');
          document.getElementById('dashOtherWrap').style.display = isOther ? '' : 'none';
          if (isOther) document.getElementById('dashOtherText').focus();
        })
      );
      document.getElementById('dashReasonSkip').addEventListener('click', () => { Modal.close(); resolve(null); });
      document.getElementById('dashReasonConfirm').addEventListener('click', () => {
        const selected = document.querySelector('input[name="dashReason"]:checked')?.value || '';
        const note = selected.startsWith('✏️')
          ? (document.getElementById('dashOtherText').value.trim() || 'Other')
          : selected;
        Modal.close(); resolve(note);
      });
    });
  },

  async clockIn() {
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const clockData = await API.get('/api/clock/today').catch(() => null);
    const schedStart = clockData?.shift?.start_time || null;
    const diff = this._timeDiffMins(hhmm, schedStart);
    let note = null;
    if (diff > this._thr('in','late') || diff < -this._thr('in','early')) note = await this._promptReason(diff);
    try {
      await API.post('/api/clock/in', { time: hhmm, note });
      await this.render();
    } catch(e) { showToast('Clock in failed', 'error'); }
  },

  async clockOut() {
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const clockData = await API.get('/api/clock/today').catch(() => null);
    const schedEnd = clockData?.shift?.end_time || null;
    const diff = this._timeDiffMins(hhmm, schedEnd);
    // Prompt when clocking out early or late beyond the configured leeway window
    let note = null;
    if (diff < -this._thr('out','early') || diff > this._thr('out','late')) note = await this._promptReason(diff, true);
    try {
      await API.post('/api/clock/out', { time: hhmm, note });
      // Ask about the break and mark the linked shift complete (same as the Clock In/Out page)
      const shift = clockData?.shift;
      if (shift?.id) {
        const breakResult = await this._promptBreak(shift.break_scheduled_minutes || 0);
        if (breakResult !== null) {
          await API.patch('/api/shifts/bulk-complete', {
            ids: [shift.id],
            completed: true,
            break_taken: breakResult.break_taken,
            break_taken_minutes: breakResult.break_taken_minutes,
          });
          showToast('Shift marked complete ✓', 'success');
        }
      }
      await this.render();
    } catch(e) { showToast('Clock out failed', 'error'); }
  },

  // Break prompt on clock-out (mirrors the Clock In/Out page)
  _promptBreak(scheduledMins) {
    return new Promise(resolve => {
      const schedLabel = scheduledMins ? `${scheduledMins} min` : 'none scheduled';
      const html = `
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 16px">
          Scheduled break: <strong>${schedLabel}</strong>. How much break did you take?
        </p>
        <div style="display:flex;flex-direction:column;gap:8px" id="dashBreakOpts">
          ${scheduledMins ? `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="dashBreak" value="full" style="accent-color:var(--primary)" checked />
            <span style="font-size:14px">Full break (${scheduledMins} min)</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="dashBreak" value="partial" style="accent-color:var(--primary)" />
            <span style="font-size:14px">Shorter break…</span>
          </label>` : ''}
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="dashBreak" value="none" style="accent-color:var(--primary)" ${!scheduledMins ? 'checked' : ''} />
            <span style="font-size:14px">No break taken</span>
          </label>
        </div>
        <div id="dashPartialWrap" style="display:none;margin-top:10px">
          <label style="font-size:13px;color:var(--text-muted);margin-bottom:4px;display:block">Minutes taken:</label>
          <input type="number" id="dashPartialMins" class="form-control" min="1" max="${scheduledMins - 1 || 60}"
            value="${Math.floor(scheduledMins / 2) || 15}" style="width:120px" />
        </div>
        <div style="display:flex;gap:8px;margin-top:18px">
          <button class="btn btn-primary" id="dashBreakConfirm" style="flex:1">Confirm</button>
          <button class="btn btn-ghost" id="dashBreakSkip">Skip</button>
        </div>`;
      Modal.open('Break taken', html);
      document.querySelectorAll('input[name="dashBreak"]').forEach(r =>
        r.addEventListener('change', () => {
          document.getElementById('dashPartialWrap').style.display = r.value === 'partial' ? '' : 'none';
        })
      );
      document.getElementById('dashBreakSkip').addEventListener('click', () => { Modal.close(); resolve(null); });
      document.getElementById('dashBreakConfirm').addEventListener('click', () => {
        const selected = document.querySelector('input[name="dashBreak"]:checked')?.value || 'full';
        let break_taken = selected, break_taken_minutes;
        if (selected === 'full')         break_taken_minutes = scheduledMins;
        else if (selected === 'partial') break_taken_minutes = parseInt(document.getElementById('dashPartialMins').value, 10) || Math.floor(scheduledMins / 2);
        else                             break_taken_minutes = 0;
        Modal.close();
        resolve({ break_taken, break_taken_minutes });
      });
    });
  },

  renderUpcoming(shifts) {
    const el = document.getElementById('dash-upcoming');
    if (!shifts.length) { el.innerHTML = ''; return; }

    this._upcomingById = {};
    const rows = shifts.slice(0, 7).map((s, i) => {
      this._upcomingById[s.id ?? i] = s;
      const d = new Date(s.date + 'T12:00:00');
      const dayShort = d.toLocaleDateString('en-GB', { weekday: 'short' });
      const dateStr  = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const dur = this._duration(s.start_time, s.end_time);
      return `
        <div class="dash-upcoming-row dash-upcoming-clickable" data-shift-id="${s.id ?? i}" title="Tap to see who you're working with">
          <div class="dash-upcoming-day">${dayShort}</div>
          <div class="dash-upcoming-date">${dateStr}</div>
          <div class="dash-upcoming-time">${s.start_time} – ${s.end_time}</div>
          <div class="dash-upcoming-dur">${dur}</div>
          <div class="dash-upcoming-who">👥</div>
        </div>
      `;
    }).join('');

    el.innerHTML = `
      <div class="dash-upcoming-section">
        <div class="dash-section-title">Coming Up</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin:-6px 0 8px">Tap a shift to see who you're working with 👥</div>
        ${rows}
        <button class="btn btn-ghost btn-sm dash-all-btn" onclick="App.navigate('shifts')">View all shifts →</button>
      </div>
    `;

    el.querySelectorAll('.dash-upcoming-clickable').forEach(row => {
      row.addEventListener('click', () => {
        const s = this._upcomingById[row.getAttribute('data-shift-id')];
        if (s) this.showWorkingWithModal(s);
      });
    });
  },

  // Modal: who's working the same shift, and their times
  async showWorkingWithModal(shift) {
    const d = new Date(shift.date + 'T12:00:00');
    const dayFull = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    Modal.open(`Working with — ${dayFull}`, `<p style="color:var(--text-muted)">Loading…</p>`);

    let colleagues = [];
    try {
      colleagues = await API.get(`/api/working-with/${shift.date}?start_time=${shift.start_time}&end_time=${shift.end_time}`);
    } catch (_) {}

    const overlapC   = colleagues.filter(c => c.relation !== 'crossover');
    const crossoverC = colleagues.filter(c => c.relation === 'crossover');

    const rowHtml = (c, isCrossover) => `
      <div style="padding:10px 12px;border:1px solid var(--border);border-left:3px solid ${isCrossover ? 'var(--warning, #f59e0b)' : 'var(--primary)'};border-radius:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">${esc(c.name)}</span>
          <span style="color:var(--text-muted);font-size:13.5px">
            ${c.shift_type === 'leave' ? 'Annual Leave' : `${c.start_time || '?'} – ${c.end_time || '?'}`}
          </span>
        </div>
        ${c.note ? `<div style="font-size:11.5px;color:var(--warning, #f59e0b);margin-top:4px">🔄 ${esc(c.note)}</div>` : ''}
      </div>
    `;

    const body = colleagues.length > 0
      ? `
        <div style="margin-bottom:14px;color:var(--text-muted);font-size:13.5px">
          Your shift: <strong>${shift.start_time} – ${shift.end_time}</strong>
        </div>
        ${overlapC.length ? `
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:8px">👥 Working with you</div>
          <div style="display:flex;flex-direction:column;gap:8px${crossoverC.length ? ';margin-bottom:18px' : ''}">
            ${overlapC.map(c => rowHtml(c, false)).join('')}
          </div>
        ` : ''}
        ${crossoverC.length ? `
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--warning, #f59e0b);margin-bottom:8px">🔄 Crossing over (within 15 min)</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${crossoverC.map(c => rowHtml(c, true)).join('')}
          </div>
        ` : ''}
      `
      : `
        <div style="margin-bottom:8px;color:var(--text-muted);font-size:13.5px">
          Your shift: <strong>${shift.start_time} – ${shift.end_time}</strong>
        </div>
        <p style="color:var(--text-muted)">No colleague shifts recorded for this day yet.</p>
      `;

    Modal.open(`Working with — ${dayFull}`, body);
  },

  renderNextIn(data, todayStr) {
    const el = document.getElementById('dash-next-in');
    if (!el) return;
    if (!data || !data.days?.length) {
      el.innerHTML = '';
      return;
    }

    const tomorrowStr = _fmtDateDash(new Date(new Date(todayStr + 'T12:00:00').getTime() + 86400000));
    const isLeave = (r) => r.shift_type === 'leave' || r.start_time === '00:00' || r.start_time === '00:00:00';

    const dayLabel = (dateStr) => {
      if (dateStr === todayStr) return 'Today';
      if (dateStr === tomorrowStr) return 'Tomorrow';
      const d = new Date(dateStr + 'T12:00:00');
      const diffDays = Math.round((d - new Date(todayStr + 'T12:00:00')) / 86400000);
      return diffDays < 7
        ? d.toLocaleDateString('en-GB', { weekday: 'long' })
        : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    };

    // Group window shifts by date (server sends them date/time sorted; put leave last per day)
    const byDate = new Map();
    for (const r of (data.days || [])) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    // Always show Today + Tomorrow headers, even when a day is empty
    for (const d of [todayStr, tomorrowStr]) if (!byDate.has(d)) byDate.set(d, []);

    const daySections = [...byDate.keys()].sort().map(dateStr => {
      // Working shifts only — annual leave isn't shown here (Ed: "doesn't need to show holiday")
      const shifts = byDate.get(dateStr).filter(r => !isLeave(r)).slice().sort((a, b) =>
        a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a.name.localeCompare(b.name));
      const rows = shifts.length ? shifts.map(r => `
        <div class="dash-nextin-row">
          <span class="dash-nextin-name">${esc(r.name)}</span>
          <span class="dash-nextin-date ${dateStr === todayStr ? 'dash-nextin-today' : ''}">
            ${r.start_time} – ${r.end_time}
          </span>
        </div>`).join('')
        : `<div class="dash-nextin-row"><span class="dash-nextin-date" style="color:var(--text-muted)">No one scheduled</span></div>`;
      return `
        <div style="font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;
          color:var(--text-muted);margin:10px 0 4px">${dayLabel(dateStr)}</div>
        ${rows}`;
    }).join('');

    el.innerHTML = `
      <div class="dash-upcoming-section" style="margin-top:0">
        <div class="dash-section-title">Next In</div>
        ${daySections}
      </div>
    `;
  },

  updateCountdown() {
    const el = document.getElementById('dashCountdown');
    if (!el) return;
    if (el.dataset.live === '1') {
      const r = this._liveTimer(el.dataset.clockin, el.dataset.end, el.dataset.date);
      el.textContent = r.text;
      el.classList.toggle('dash-countdown-over', r.over);
      this._updatePayCounter();
      return;
    }
    el.textContent = this._countdown(el.dataset.date, el.dataset.start, el.dataset.end);
    this._updatePayCounter();
  },

  // Decide what the hero timer should show right now
  _timerState(shift, ce, live) {
    if (live) return this._liveTimer(ce.clocked_in, shift.end_time, shift.date);
    return { text: this._countdown(shift.date, shift.start_time, shift.end_time), over: false };
  },

  // ── Live pay counter (shown alongside the shift timer while a shift is in progress) ──

  // Work out how much has been "earned" so far into the shift. Break time doesn't count
  // towards pay, and since we don't know exactly when the break was/will be taken until
  // the shift is completed, we assume it falls in the middle of the shift (paid time
  // split evenly either side of it) — matches how autoBreakMinutes/pay is calculated
  // server-side, just spread across the clock instead of applied as a lump deduction.
  _payState(shift) {
    const rate = shift.hourly_rate ? shift.hourly_rate * (shift.is_bank_holiday ? 2 : 1) : null;
    if (!rate) return null;

    let shiftStart = new Date(`${shift.date}T${shift.start_time}`);
    let shiftEnd   = new Date(`${shift.date}T${shift.end_time}`);
    if (shiftEnd <= shiftStart) shiftEnd = new Date(shiftEnd.getTime() + 86400000); // overnight

    const grossMin  = (shiftEnd - shiftStart) / 60000;
    const breakMin  = Math.max(0, Math.min(shift.break_scheduled_minutes || 0, grossMin));
    const paidMin   = grossMin - breakMin;
    const totalPay  = (shift.calculated_pay != null) ? shift.calculated_pay : Math.round((paidMin / 60) * rate * 100) / 100;

    // Break centred in the shift
    const breakStart = new Date(shiftStart.getTime() + ((grossMin - breakMin) / 2) * 60000);
    const breakEnd    = new Date(breakStart.getTime() + breakMin * 60000);

    const now = new Date();
    const nowClamped = now < shiftStart ? shiftStart : (now > shiftEnd ? shiftEnd : now);
    const elapsedMin  = (nowClamped - shiftStart) / 60000;
    const breakOverlapMin = Math.max(0, Math.min(nowClamped, breakEnd) - breakStart) / 60000;
    let paidElapsedMin = Math.max(0, elapsedMin - breakOverlapMin);
    paidElapsedMin = Math.min(paidElapsedMin, paidMin);

    const pay = paidMin > 0 ? Math.min(totalPay, (paidElapsedMin / paidMin) * totalPay) : 0;
    const onBreak = breakMin > 0 && now >= breakStart && now < breakEnd;
    return { pay, totalPay, onBreak, complete: paidElapsedMin >= paidMin };
  },

  _renderPayCounter(shift) {
    const p = this._payState(shift);
    if (!p) return '';
    return `<div class="dash-pay-counter" id="dashPayCounter"
      data-date="${shift.date}" data-start="${shift.start_time}" data-end="${shift.end_time}"
      data-rate="${shift.hourly_rate || ''}" data-bh="${shift.is_bank_holiday ? '1' : '0'}"
      data-break="${shift.break_scheduled_minutes || 0}" data-calcpay="${shift.calculated_pay ?? ''}">
      ${this._payCounterText(p)}
    </div>`;
  },

  _payCounterText(p) {
    const amt = `£${p.pay.toFixed(2)}`;
    if (p.onBreak) return `☕ ${amt} <span class="dash-pay-note">earned so far · paused for unpaid break</span>`;
    if (p.complete) return `💷 ${amt} <span class="dash-pay-note">full shift pay reached</span>`;
    return `💷 ${amt} <span class="dash-pay-note">earned so far</span>`;
  },

  _updatePayCounter() {
    const el = document.getElementById('dashPayCounter');
    if (!el) return;
    const shift = {
      date: el.dataset.date, start_time: el.dataset.start, end_time: el.dataset.end,
      hourly_rate: parseFloat(el.dataset.rate) || null,
      is_bank_holiday: el.dataset.bh === '1',
      break_scheduled_minutes: parseInt(el.dataset.break, 10) || 0,
      calculated_pay: el.dataset.calcpay !== '' ? parseFloat(el.dataset.calcpay) : null,
    };
    const p = this._payState(shift);
    if (p) el.innerHTML = this._payCounterText(p);
  },

  // Live timer while clocked in and not yet clocked out.
  // Before scheduled end → green countdown to end. After end → red count-UP "overtime".
  _liveTimer(clockIn, end, dateStr) {
    const now = new Date();
    const shiftEnd = new Date(`${dateStr}T${end}`);
    if (now <= shiftEnd) {
      return { text: this._countdownToEnd(dateStr, end), over: false };
    }
    const startT = clockIn ? new Date(`${dateStr}T${clockIn}`) : shiftEnd;
    let secs = Math.round((now - startT) / 1000);
    if (secs < 0) secs = 0;
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sc = secs % 60;
    const elapsed = (h > 0 ? `${h}h ` : '') + `${m}m ${sc}s`;
    return { text: `🔴 Still clocked in · ${elapsed} on shift`, over: true };
  },

  // Countdown to a given end time (used by live timer before shift end)
  _countdownToEnd(dateStr, end) {
    const now = new Date();
    const shiftEnd = new Date(`${dateStr}T${end}`);
    const secs = Math.round((shiftEnd - now) / 1000);
    if (secs <= 0) return '';
    const m = Math.floor(secs / 60), sc = secs % 60;
    if (m < 60) return `⏳ ${m}m ${sc}s left`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `⏳ ${h}h ${rm}m ${sc}s left`;
  },

  // ── Private helpers ──────────────────────────────────────────────────────────────────────────────────

  _fullDay(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' });
  },

  _longDate(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  },

  _duration(start, end) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 1440;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  },

  _isOngoing(dateStr, start, end) {
    const now = new Date();
    return now >= new Date(`${dateStr}T${start}`) && now <= new Date(`${dateStr}T${end}`);
  },

  _countdown(dateStr, start, end) {
    const now        = new Date();
    const shiftStart = new Date(`${dateStr}T${start}`);
    const shiftEnd   = new Date(`${dateStr}T${end}`);

    if (now >= shiftStart && now <= shiftEnd) {
      const totalSecs = Math.round((shiftEnd - now) / 1000);
      if (totalSecs < 60) return `⏳ ${totalSecs}s left`;
      const totalMins = Math.floor(totalSecs / 60);
      const s = totalSecs % 60;
      if (totalMins < 60) return `⏳ ${totalMins}m ${s}s left`;
      const h = Math.floor(totalMins / 60), rm = totalMins % 60;
      return rm > 0 ? `⏳ ${h}h ${rm}m ${s}s left` : `⏳ ${h}h ${s}s left`;
    }

    const totalSecs = Math.round((shiftStart - now) / 1000);
    if (totalSecs <= 0) return '';
    if (totalSecs < 60) return `Starts in ${totalSecs}s`;
    const totalMins = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    if (totalMins < 60) return `Starts in ${totalMins}m ${s}s`;
    const h = Math.floor(totalMins / 60), rm = totalMins % 60;
    if (totalMins < 1440) return rm > 0 ? `Starts in ${h}h ${rm}m ${s}s` : `Starts in ${h}h ${s}s`;
    const days = Math.floor(totalMins / 1440), remH = Math.floor((totalMins % 1440) / 60);
    return remH > 0 ? `Starts in ${days}d ${remH}h` : `Starts in ${days}d`;
  }
};

function _fmtDateDash(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
