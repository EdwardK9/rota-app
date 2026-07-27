/* ─── Who's In Store View ───────────────────────────────────────────────────── */

const WhosInView = {
  _refreshInterval: null,
  _clockInterval:   null,
  _viewDate:        null, // null = follow the live default (today, rolling to tomorrow after cutoff)

  async init() {
    clearInterval(this._refreshInterval);
    clearInterval(this._clockInterval);
    this._viewDate = null;
    this._render();
    await this._load();
    this._refreshInterval = setInterval(() => this._load(), 60_000);
  },

  _render() {
    document.getElementById('view-whos-in').innerHTML = `
      <style>
        .wi-wrap        { display:flex; flex-direction:column; height:calc(100vh - var(--topbar-height) - 32px); gap:0; }
        .wi-topbar      { display:flex; align-items:center; gap:8px; padding:12px 16px 8px;
                          border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; }
        .wi-nav-btn     { background:none; border:1px solid var(--border); border-radius:6px;
                          padding:4px 9px; cursor:pointer; font-size:13px; color:var(--text); line-height:1; }
        .wi-nav-btn:hover { background:var(--border); }
        .wi-day-label   { font-weight:700; font-size:15px; }
        .wi-spacer      { flex:1; }
        .wi-today-btn   { background:none; border:1px solid var(--primary); color:var(--primary);
                          border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; font-weight:600; }
        .wi-today-btn:hover { background:var(--primary); color:var(--primary-text); }
        .wi-clock       { font-size:13px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
        .wi-refresh-btn { background:none; border:1px solid var(--border); border-radius:6px;
                          padding:4px 10px; cursor:pointer; font-size:12px; color:var(--text-muted); }
        .wi-refresh-btn:hover { background:var(--border); }

        .wi-columns     { display:flex; flex:1; min-height:0; overflow:hidden; }

        /* ── Left panel ── */
        .wi-left        { width:260px; flex-shrink:0; display:flex; flex-direction:column;
                          border-right:1px solid var(--border); overflow-y:auto; }
        .wi-left-head   { padding:12px 16px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }
        .wi-left-title  { font-weight:700; font-size:13px; text-transform:uppercase;
                          letter-spacing:.05em; color:var(--text-muted); }
        .wi-left-body   { padding:10px; display:flex; flex-direction:column; gap:8px; }

        .wi-card        { display:flex; align-items:center; gap:10px; padding:10px 12px;
                          background:var(--card-bg); border-radius:10px;
                          box-shadow:var(--card-shadow); border:1px solid var(--border); }
        .wi-card.wi-me  { border-color:var(--primary); background:color-mix(in srgb, var(--primary) 8%, var(--card-bg)); }
        .wi-avatar      { width:36px; height:36px; border-radius:50%; background:var(--sidebar-bg);
                          color:#fff; display:flex; align-items:center; justify-content:center;
                          font-weight:700; font-size:14px; flex-shrink:0; }
        .wi-card.wi-me .wi-avatar { background:var(--primary); color:var(--primary-text); }
        .wi-card-info   { flex:1; min-width:0; }
        .wi-card-name   { font-weight:600; font-size:13px; white-space:nowrap;
                          overflow:hidden; text-overflow:ellipsis; }
        .wi-card-times  { font-size:11px; color:var(--text-muted); margin-top:1px; }
        .wi-badge       { font-size:10px; font-weight:700; padding:3px 7px; border-radius:20px;
                          white-space:nowrap; flex-shrink:0; }
        .wi-badge-in    { background:#D1FAE5; color:#065F46; }
        .wi-badge-soon  { background:#DBEAFE; color:#1E40AF; }
        .wi-badge-opener{ background:#FEF3C7; color:#92400E; }
        [data-theme="dark"] .wi-badge-in     { background:#064E3B; color:#A7F3D0; }
        [data-theme="dark"] .wi-badge-soon   { background:#1E3A5F; color:#93C5FD; }
        [data-theme="dark"] .wi-badge-opener { background:#78350F; color:#FDE68A; }

        .wi-empty       { padding:20px 16px; font-size:13px; color:var(--text-muted);
                          text-align:center; line-height:1.5; }

        /* ── Right panel ── */
        .wi-right       { flex:1; display:flex; flex-direction:column; min-width:0; overflow:hidden; }
        .wi-right-head  { padding:12px 16px 8px; border-bottom:1px solid var(--border); flex-shrink:0; }
        .wi-right-title { font-weight:700; font-size:13px; text-transform:uppercase;
                          letter-spacing:.05em; color:var(--text-muted); }
        .wi-tl-wrap     { flex:1; overflow:auto; padding:12px 16px; }

        /* Timeline */
        .wi-timeline    { display:flex; flex-direction:column; gap:0; min-width:500px; }
        .wi-tl-axis     { display:flex; align-items:flex-end; margin-bottom:4px; }
        .wi-name-col    { width:90px; flex-shrink:0; }
        .wi-hours-strip { flex:1; position:relative; height:20px; }
        .wi-hour-tick   { position:absolute; top:0; bottom:0; display:flex; flex-direction:column;
                          align-items:center; gap:0; }
        .wi-hour-tick span { font-size:10px; color:var(--text-muted); white-space:nowrap; }
        .wi-hour-tick::after { content:''; display:block; flex:1; width:1px;
                               background:var(--border); margin-top:2px; }

        .wi-tl-row      { display:flex; align-items:center; margin-bottom:6px; }
        .wi-tl-name     { width:90px; flex-shrink:0; font-size:12px; font-weight:600;
                          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                          padding-right:8px; color:var(--text); }
        .wi-tl-name.me  { color:var(--primary-dark); }
        .wi-tl-track    { flex:1; position:relative; height:28px; background:var(--bg);
                          border-radius:4px; overflow:visible; }
        .wi-bar         { position:absolute; top:4px; height:20px; border-radius:4px;
                          display:flex; align-items:center; justify-content:center;
                          font-size:10px; font-weight:600; overflow:hidden;
                          white-space:nowrap; cursor:default; transition:opacity .15s; }
        .wi-bar:hover   { opacity:.85; }
        .wi-bar-me      { background:var(--primary); color:var(--primary-text); }
        .wi-bar-active  { background:#10B981; color:#fff; }
        .wi-bar-upcoming{ background:#3B82F6; color:#fff; }
        .wi-bar-past    { background:#9CA3AF; color:#fff; opacity:.6; }
        .wi-bar-future  { background:#3B82F6; color:#fff; }  /* non-today day */
        .wi-bar span    { padding:0 5px; pointer-events:none; }

        .wi-now-line    { position:absolute; top:-4px; bottom:-4px; width:2px;
                          background:var(--danger); border-radius:1px; z-index:5; }
        .wi-now-label   { display:none; }
        .wi-grid-line   { position:absolute; top:0; bottom:0; width:1px;
                          background:var(--border); opacity:.5; }

        @media (max-width: 640px) {
          .wi-columns  { flex-direction: column; overflow-y:auto; }
          .wi-left     { width:100%; border-right:none; border-bottom:1px solid var(--border); }
          .wi-right    { min-height:320px; }
          .wi-tl-wrap  { overflow-x:auto; }
        }
      </style>

      <div class="wi-wrap">
        <div class="wi-topbar">
          <button class="wi-nav-btn" id="wiPrevBtn" title="Previous day">←</button>
          <div id="wiDayLabel" class="wi-day-label">Loading…</div>
          <button class="wi-nav-btn" id="wiNextBtn" title="Next day">→</button>
          <button class="wi-today-btn" id="wiTodayBtn" style="display:none">Today</button>
          <div class="wi-spacer"></div>
          <div id="wiClock"    class="wi-clock"></div>
          <button class="wi-refresh-btn" id="wiRefreshBtn">↻ Refresh</button>
        </div>
        <div class="wi-columns">
          <div class="wi-left">
            <div class="wi-left-head">
              <div class="wi-left-title" id="wiLeftTitle">Currently In</div>
            </div>
            <div class="wi-left-body" id="wiLeftBody">
              <div class="wi-empty">Loading…</div>
            </div>
          </div>
          <div class="wi-right">
            <div class="wi-right-head">
              <div class="wi-right-title" id="wiRightTitle">Today's Schedule</div>
            </div>
            <div class="wi-tl-wrap" id="wiTlWrap">
              <div class="wi-empty">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('wiRefreshBtn').addEventListener('click', () => this._load());
    document.getElementById('wiPrevBtn').addEventListener('click', () => this._navigate(this._lastData ? this._lastData.prevDate : null));
    document.getElementById('wiNextBtn').addEventListener('click', () => this._navigate(this._lastData ? this._lastData.nextDate : null));
    document.getElementById('wiTodayBtn').addEventListener('click', () => { this._viewDate = null; this._load(); });
    this._startClock();
  },

  _navigate(date) {
    if (!date) return;
    this._viewDate = date;
    this._load();
  },

  _startClock() {
    const tick = () => {
      const el = document.getElementById('wiClock');
      if (!el) return;
      el.textContent = new Date().toLocaleTimeString('en-GB',
        { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    tick();
    this._clockInterval = setInterval(tick, 1000);
  },

  async _load() {
    try {
      const data = await API.getWhosIn(this._viewDate);
      this._lastData = data;
      this._renderLeft(data);
      this._renderTimeline(data);
      const todayBtn = document.getElementById('wiTodayBtn');
      if (todayBtn) todayBtn.style.display = this._viewDate ? '' : 'none';
    } catch (e) {
      const b = document.getElementById('wiLeftBody');
      if (b) b.innerHTML = `<div class="wi-empty" style="color:var(--danger)">Error: ${e.message}</div>`;
    }
  },

  _dayLabelFor(dateStr, todayStr) {
    if (dateStr === todayStr) return 'Today';
    const d = new Date(dateStr + 'T12:00:00');
    const diffDays = Math.round((d - new Date(todayStr + 'T12:00:00')) / 86400000);
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    return diffDays > 0 && diffDays < 7
      ? d.toLocaleDateString('en-GB', { weekday: 'long' })
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  },

  _renderLeft(data) {
    const { isToday, myName, myStatus, teamShifts, myShift, date, today } = data;

    const titleEl = document.getElementById('wiLeftTitle');
    const bodyEl  = document.getElementById('wiLeftBody');
    const dayEl   = document.getElementById('wiDayLabel');
    if (!titleEl || !bodyEl) return;

    // Day label
    if (dayEl) {
      const d = new Date(date + 'T00:00:00');
      const longLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      dayEl.textContent = `${this._dayLabelFor(date, today)} — ${longLabel}`;
    }

    // Right panel title
    const rtEl = document.getElementById('wiRightTitle');
    if (rtEl) rtEl.textContent = `${this._dayLabelFor(date, today)}'s Schedule`;

    const toMins = t => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
    const card = ({ name, start, end, isMe, badgeClass, badgeText }) => `
      <div class="wi-card${isMe ? ' wi-me' : ''}">
        <div class="wi-avatar">${name.charAt(0).toUpperCase()}</div>
        <div class="wi-card-info">
          <div class="wi-card-name">${name}</div>
          <div class="wi-card-times">${start} – ${end}</div>
        </div>
        <div class="wi-badge ${badgeClass}">${badgeText}</div>
      </div>`;

    if (isToday) {
      // ── Viewing real today: who's currently in ───────────────────────────
      titleEl.textContent = 'Currently In';

      const myCards = [];
      if (myStatus && (myStatus.status === 'in' || myStatus.status === 'soon')) {
        const [h, s] = myStatus.status === 'in'
          ? ['wi-badge-in', 'On shift']
          : ['wi-badge-soon', 'Starting soon'];
        myCards.push(card({ name: myName, start: myStatus.start, end: myStatus.end,
                            isMe: true, badgeClass: h, badgeText: s }));
      }

      const nowMins = toMins(data.currentTime);
      const colleagueCards = data.inNow.map(p => {
        const minsLeft = toMins(p.end) - nowMins;
        const h = Math.floor(minsLeft / 60), m = minsLeft % 60;
        const label = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
        return card({ name: p.name, start: p.start, end: p.end,
                      isMe: false, badgeClass: 'wi-badge-in', badgeText: label + ' left' });
      });

      const soonCards = data.inSoon.map(p =>
        card({ name: p.name, start: p.start, end: p.end,
               isMe: false, badgeClass: 'wi-badge-soon', badgeText: 'In ' + (() => {
                 const diff = toMins(p.start) - nowMins;
                 const h = Math.floor(diff / 60), m = diff % 60;
                 return h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
               })() })
      );

      let html = [...myCards, ...colleagueCards].join('');
      if (soonCards.length) {
        html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;
                   letter-spacing:.05em;color:var(--text-muted);padding:8px 2px 4px">
                   ⏰ Arriving Soon</div>` + soonCards.join('');
      }
      if (!html) html = `<div class="wi-empty">Nobody on shift right now</div>`;
      bodyEl.innerHTML = html;

    } else {
      // ── Any other day (past, tomorrow, or navigated-to): static schedule ──
      titleEl.textContent = 'Opening';

      const all = [];
      if (myShift) all.push({ name: myName, ...myShift, isMe: true });
      teamShifts.forEach(s => all.push({ ...s, isMe: false }));

      if (!all.length) {
        bodyEl.innerHTML = `<div class="wi-empty">No team shifts found for this day.<br><small>Import the team rota to see openers.</small></div>`;
        return;
      }

      const minStart = Math.min(...all.map(s => toMins(s.start)));
      const openers  = all
        .filter(s => toMins(s.start) <= minStart + 30)
        .sort((a, b) => toMins(a.start) - toMins(b.start));

      bodyEl.innerHTML = openers.map(p =>
        card({ name: p.name, start: p.start, end: p.end,
               isMe: p.isMe, badgeClass: 'wi-badge-opener', badgeText: 'Opener' })
      ).join('');
    }
  },

  _renderTimeline(data) {
    const { isToday, myName, currentTime, teamShifts, myShift } = data;

    const wrap = document.getElementById('wiTlWrap');
    if (!wrap) return;

    // Build entries: me first, then colleagues sorted by start
    const entries = [];
    if (myShift) entries.push({ name: myName, start: myShift.start, end: myShift.end, isMe: true });
    teamShifts.forEach(s => entries.push({ name: s.name, start: s.start, end: s.end, isMe: false }));
    entries.sort((a, b) => {
      if (a.isMe && !b.isMe) return -1;
      if (!a.isMe && b.isMe) return 1;
      return a.start.localeCompare(b.start);
    });

    if (!entries.length) {
      wrap.innerHTML = `<div class="wi-empty">No shift data for this day.<br><small>Import the team rota from the Import page to see the full schedule.</small></div>`;
      return;
    }

    const toMins = t => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
    const allStarts = entries.map(e => toMins(e.start));
    const allEnds   = entries.map(e => toMins(e.end));
    const axisStart = Math.floor(Math.min(...allStarts) / 60) * 60;
    const axisEnd   = Math.ceil(Math.max(...allEnds)   / 60) * 60;
    const axisDur   = axisEnd - axisStart;

    const pct = mins => ((mins - axisStart) / axisDur * 100).toFixed(3) + '%';

    // Hour marks
    const hours = [];
    for (let m = axisStart; m <= axisEnd; m += 60) hours.push(m);

    const hourTicks = hours.map(m =>
      `<div class="wi-hour-tick" style="left:${pct(m)}"><span>${String(m / 60).padStart(2,'0')}:00</span></div>`
    ).join('');

    const gridLines = hours.map(m =>
      `<div class="wi-grid-line" style="left:${pct(m)}"></div>`
    ).join('');

    // Now-line (only when viewing real today)
    const nowMins = toMins(currentTime);
    const showNow = isToday && nowMins >= axisStart && nowMins <= axisEnd;
    const nowLine = showNow
      ? `<div class="wi-now-line" style="left:${pct(nowMins)}"><span class="wi-now-label">Now</span></div>`
      : '';

    const rows = entries.map(e => {
      const st = toMins(e.start), en = toMins(e.end);
      const barLeft  = pct(st);
      const barWidth = ((en - st) / axisDur * 100).toFixed(3) + '%';

      const isActive   = isToday && st <= nowMins && en > nowMins;
      const isPast     = isToday && en <= nowMins;
      const barClass   = e.isMe      ? 'wi-bar wi-bar-me'
                       : !isToday    ? 'wi-bar wi-bar-future'
                       : isActive    ? 'wi-bar wi-bar-active'
                       : isPast      ? 'wi-bar wi-bar-past'
                       :               'wi-bar wi-bar-upcoming';

      return `
        <div class="wi-tl-row">
          <div class="wi-tl-name${e.isMe ? ' me' : ''}" title="${e.name}">${e.name}</div>
          <div class="wi-tl-track">
            ${gridLines}
            ${nowLine}
            <div class="${barClass}" style="left:${barLeft};width:${barWidth}" title="${e.name}: ${e.start}–${e.end}">
              <span>${e.start}–${e.end}</span>
            </div>
          </div>
        </div>`;
    }).join('');

    wrap.innerHTML = `
      <div class="wi-timeline">
        <div class="wi-tl-axis">
          <div class="wi-name-col"></div>
          <div class="wi-hours-strip">${hourTicks}</div>
        </div>
        ${rows}
      </div>`;
  },
};
