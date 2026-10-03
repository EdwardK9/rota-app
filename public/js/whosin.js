/* ─── Who's In Store View ───────────────────────────────────────────────────
   One column that reads top to bottom on any screen:
     1. the day, with ‹ › to move between days
     2. a summary line (in now · working today · next in · last out)
     3. right now: who's in (with how far through their shift they are), who's
        still due in today, who's gone home — or, on any other day, who opens
        and who closes
     4. the day at a glance: one row per person, bars coloured by status, a
        "now" line, and an "in store" row showing how many people are in at
        each point of the day.
   Everything is sized to the screen — no fixed-height panels and no minimum
   width, so nothing scrolls sideways (the old timeline was forced to 500px
   and spilled a sliver of horizontal scroll at the bottom of a tall panel).
   ───────────────────────────────────────────────────────────────────────── */

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
    this._refreshInterval = setInterval(() => this._load(true), 60_000);
  },

  destroy() {
    clearInterval(this._refreshInterval);
    clearInterval(this._clockInterval);
    this._refreshInterval = null;
    this._clockInterval = null;
  },

  _render() {
    document.getElementById('view-whos-in').innerHTML = `
      <div class="wi">
        <div class="wi-head">
          <button class="wi-nav" id="wiPrevBtn" title="Previous day" aria-label="Previous day">‹</button>
          <div class="wi-date">
            <div class="wi-date-rel" id="wiDayRel">Loading…</div>
            <div class="wi-date-full" id="wiDayFull"></div>
          </div>
          <button class="wi-nav" id="wiNextBtn" title="Next day" aria-label="Next day">›</button>
          <button class="wi-today" id="wiTodayBtn" hidden>Back to today</button>
          <div class="wi-spacer"></div>
          <div class="wi-clock" id="wiClock"></div>
          <button class="wi-nav" id="wiRefreshBtn" title="Refresh" aria-label="Refresh">↻</button>
        </div>
        <div class="wi-summary" id="wiSummary"></div>
        <div id="wiNow"></div>
        <section class="wi-box">
          <div class="wi-box-head">
            <h3 class="wi-box-title">Day at a glance</h3>
            <div class="wi-legend" id="wiLegend"></div>
          </div>
          <div id="wiTimeline"><div class="wi-empty">Loading…</div></div>
        </section>
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
      el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    this._clockInterval = setInterval(tick, 15_000);
  },

  /** quiet: the once-a-minute refresh. If that fails (bad signal), keep what's
   *  on screen rather than replacing it with an error. */
  async _load(quiet = false) {
    try {
      const data = await API.getWhosIn(this._viewDate);
      this._lastData = data;
      const people = this._people(data);
      this._renderHead(data);
      this._renderSummary(data, people);
      this._renderNow(data, people);
      this._renderTimeline(data, people);
      const todayBtn = document.getElementById('wiTodayBtn');
      if (todayBtn) todayBtn.hidden = !this._viewDate || data.date === data.today;
    } catch (e) {
      if (quiet && this._lastData) return;
      const el = document.getElementById('wiNow');
      if (el) el.innerHTML = `<div class="wi-empty" style="color:var(--danger)">Couldn't load: ${esc(e.message)}</div>`;
    }
  },

  // ── Data ─────────────────────────────────────────────────────────────────

  _mins(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return h * 60 + m;
  },

  _fmtDur(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`;
  },

  /** One entry per person (me included) with all their shifts that day, and —
   *  when viewing today — where they are: 'in', 'later' or 'done'. */
  _people(data) {
    const myShifts = data.myShifts || (data.myShift ? [data.myShift] : []);
    const now = data.isToday ? this._mins(data.currentTime) : null;
    const list = [];
    const span = s => {
      const start = this._mins(s.start);
      let end = this._mins(s.end);
      if (end <= start) end += 1440;   // past midnight
      return { start, end, startStr: s.start, endStr: s.end };
    };
    if (myShifts.length) list.push({ name: data.myName || 'Me', isMe: true, spans: myShifts.map(span) });
    const byName = new Map();
    for (const s of data.teamShifts || []) {
      let p = byName.get(s.name);
      if (!p) { p = { name: s.name, isMe: false, spans: [] }; byName.set(s.name, p); list.push(p); }
      p.spans.push(span(s));
    }
    for (const p of list) {
      p.spans.sort((a, b) => a.start - b.start);
      p.first = p.spans[0].start;
      p.last = Math.max(...p.spans.map(s => s.end));
      if (now !== null) {
        p.current = p.spans.find(s => s.start <= now && s.end > now) || null;
        p.next = p.spans.find(s => s.start > now) || null;
        p.status = p.current ? 'in' : p.next ? 'later' : 'done';
      }
    }
    // You first, then in order of arrival
    list.sort((a, b) => (b.isMe - a.isMe) || (a.first - b.first) || a.name.localeCompare(b.name));
    return list;
  },

  /** How many people are in at each slot of the axis. */
  _coverage(people, from, to, step) {
    const slots = [];
    for (let t = from; t < to; t += step) {
      const mid = t + step / 2;
      const names = people.filter(p => p.spans.some(s => s.start <= mid && s.end > mid)).map(p => p.name);
      slots.push({ start: t, end: t + step, count: names.length, names });
    }
    return slots;
  },

  _hhmm(mins) {
    const m = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  },

  // ── Header & summary ───────────────────────────────────────────────────────

  _dayLabelFor(dateStr, todayStr) {
    if (dateStr === todayStr) return 'Today';
    const d = new Date(dateStr + 'T12:00:00');
    const diffDays = Math.round((d - new Date(todayStr + 'T12:00:00')) / 86400000);
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long' });
  },

  _renderHead(data) {
    const rel = document.getElementById('wiDayRel');
    const full = document.getElementById('wiDayFull');
    if (!rel || !full) return;
    rel.textContent = this._dayLabelFor(data.date, data.today);
    full.textContent = new Date(data.date + 'T12:00:00')
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    document.getElementById('wiClock').style.visibility = data.isToday ? '' : 'hidden';
  },

  _renderSummary(data, people) {
    const el = document.getElementById('wiSummary');
    if (!el) return;
    if (!people.length) { el.innerHTML = ''; return; }
    const chip = (icon, text, tone = '') => `<span class="wi-chip ${tone}"><span aria-hidden="true">${icon}</span> ${text}</span>`;
    const first = Math.min(...people.map(p => p.first));
    const last = Math.max(...people.map(p => p.last));
    const chips = [];
    if (data.isToday) {
      const inNow = people.filter(p => p.status === 'in').length;
      chips.push(chip('🟢', `<strong>${inNow}</strong> in now`, inNow ? 'wi-chip-in' : ''));
      chips.push(chip('👥', `<strong>${people.length}</strong> working today`));
      const now = this._mins(data.currentTime);
      const upcoming = people.filter(p => p.next).sort((a, b) => a.next.start - b.next.start);
      if (upcoming.length) {
        const n = upcoming[0];
        chips.push(chip('⏭️', `Next in: <strong>${esc(n.isMe ? 'You' : n.name)}</strong> at ${n.next.startStr} <span class="wi-muted">(in ${this._fmtDur(n.next.start - now)})</span>`));
      }
      chips.push(chip('🔒', `Last out ${this._hhmm(last)}`));
    } else {
      chips.push(chip('👥', `<strong>${people.length}</strong> working`));
      chips.push(chip('🔓', `First in ${this._hhmm(first)}`));
      chips.push(chip('🔒', `Last out ${this._hhmm(last)}`));
    }
    // Busiest stretch — the most people in at once
    const slots = this._coverage(people, Math.floor(first / 30) * 30, Math.ceil(last / 30) * 30, 30);
    const peak = Math.max(...slots.map(s => s.count));
    if (peak > 1) {
      const i = slots.findIndex(s => s.count === peak);
      let j = i;
      while (j + 1 < slots.length && slots[j + 1].count === peak) j++;
      chips.push(chip('📈', `Busiest ${this._hhmm(slots[i].start)}–${this._hhmm(slots[j].end)} <span class="wi-muted">(${peak} in)</span>`));
    }
    el.innerHTML = chips.join('');
  },

  // ── Right now (today) / openers & closers (other days) ─────────────────────

  _avatar(p) {
    return `<span class="wi-avatar${p.isMe ? ' wi-avatar-me' : ''}" aria-hidden="true">${esc((p.name || '?').charAt(0).toUpperCase())}</span>`;
  },

  _renderNow(data, people) {
    const el = document.getElementById('wiNow');
    if (!el) return;
    if (!people.length) {
      el.innerHTML = `
        <section class="wi-box"><div class="wi-empty">
          No team shifts for this day yet.<br>
          <button class="dash-link" onclick="App.navigate('team-upload')">Import the team rota →</button>
        </div></section>`;
      return;
    }
    const spanText = sp => `${sp.startStr}–${sp.endStr}`;
    const allSpans = p => p.spans.map(spanText).join(', ');
    const nameOf = p => p.isMe ? `${esc(p.name)} <span class="wi-you">you</span>` : esc(p.name);

    if (data.isToday) {
      const now = this._mins(data.currentTime);
      const inNow = people.filter(p => p.status === 'in');
      const later = people.filter(p => p.status === 'later').sort((a, b) => a.next.start - b.next.start);
      const done = people.filter(p => p.status === 'done');

      const inCards = inNow.map(p => {
        const s = p.current;
        const pct = Math.round(Math.min(100, Math.max(0, (now - s.start) / (s.end - s.start) * 100)));
        return `
          <div class="wi-person${p.isMe ? ' wi-person-me' : ''}">
            ${this._avatar(p)}
            <div class="wi-person-main">
              <div class="wi-person-top">
                <span class="wi-person-name">${nameOf(p)}</span>
                <span class="wi-person-left">${this._fmtDur(s.end - now)} left</span>
              </div>
              <div class="wi-progress" role="img" aria-label="${pct}% through their shift"><span style="width:${pct}%"></span></div>
              <div class="wi-person-sub">${spanText(s)}${p.spans.length > 1 ? ` <span class="wi-muted">· also ${p.spans.filter(x => x !== s).map(spanText).join(', ')}</span>` : ''}</div>
            </div>
          </div>`;
      }).join('');

      const laterRows = later.map(p => `
        <li class="wi-line${p.isMe ? ' wi-line-me' : ''}">
          <span class="wi-line-time">${p.next.startStr}</span>
          <span class="wi-line-name">${nameOf(p)}</span>
          <span class="wi-line-sub">until ${p.next.endStr} · in ${this._fmtDur(p.next.start - now)}</span>
        </li>`).join('');

      const doneChips = done.map(p => `<span class="wi-done" title="${esc(p.name)}: ${allSpans(p)}">${esc(p.isMe ? 'You' : p.name)} <span class="wi-muted">${allSpans(p)}</span></span>`).join('');

      el.innerHTML = `
        <section class="wi-box">
          <h3 class="wi-box-title">In store now <span class="wi-count">${inNow.length}</span></h3>
          ${inCards ? `<div class="wi-people">${inCards}</div>` : `<div class="wi-empty">Nobody's in right now.</div>`}
        </section>
        ${laterRows ? `
          <section class="wi-box">
            <h3 class="wi-box-title">Still to come in today <span class="wi-count">${later.length}</span></h3>
            <ul class="wi-lines">${laterRows}</ul>
          </section>` : ''}
        ${doneChips ? `
          <section class="wi-box wi-box-quiet">
            <h3 class="wi-box-title">Gone home <span class="wi-count">${done.length}</span></h3>
            <div class="wi-dones">${doneChips}</div>
          </section>` : ''}`;
      return;
    }

    // Any other day: who opens up and who closes
    const first = Math.min(...people.map(p => p.first));
    const last = Math.max(...people.map(p => p.last));
    const openers = people.filter(p => p.first <= first + 30);
    const closers = people.filter(p => p.last >= last - 30).sort((a, b) => b.last - a.last);
    const line = (p, when) => `
      <li class="wi-line${p.isMe ? ' wi-line-me' : ''}">
        <span class="wi-line-time">${when}</span>
        <span class="wi-line-name">${nameOf(p)}</span>
        <span class="wi-line-sub">${allSpans(p)}</span>
      </li>`;
    el.innerHTML = `
      <div class="wi-pair">
        <section class="wi-box">
          <h3 class="wi-box-title">Opening</h3>
          <ul class="wi-lines">${openers.map(p => line(p, this._hhmm(p.first))).join('')}</ul>
        </section>
        <section class="wi-box">
          <h3 class="wi-box-title">Closing</h3>
          <ul class="wi-lines">${closers.map(p => line(p, this._hhmm(p.last))).join('')}</ul>
        </section>
      </div>`;
  },

  // ── Day at a glance ────────────────────────────────────────────────────────

  _renderTimeline(data, people) {
    const wrap = document.getElementById('wiTimeline');
    const legend = document.getElementById('wiLegend');
    if (!wrap) return;
    const box = wrap.closest('.wi-box');
    if (box) box.hidden = !people.length;   // the "no shifts" card above already says so
    if (!people.length) {
      wrap.innerHTML = '';
      if (legend) legend.innerHTML = '';
      return;
    }

    const from = Math.floor(Math.min(...people.map(p => p.first)) / 60) * 60;
    const to = Math.ceil(Math.max(...people.map(p => p.last)) / 60) * 60;
    const dur = Math.max(60, to - from);
    const pct = m => ((m - from) / dur * 100).toFixed(3) + '%';
    const now = data.isToday ? this._mins(data.currentTime) : null;
    const showNow = now !== null && now >= from && now <= to;

    const hours = [];
    for (let m = from; m <= to; m += 60) hours.push(m);
    // Hour labels the red "now" label would sit on top of are left out. The
    // track's width in pixels decides how close is too close (it's the full
    // width on a phone, the width minus the name column on a wider screen).
    const phone = window.matchMedia('(max-width: 640px)').matches;
    const trackPx = Math.max(200, (wrap.clientWidth || 600) - (phone ? 0 : 162));
    const nearNow = m => showNow && Math.abs(m - now) / dur * trackPx < 46;
    // Every hour on a wide screen; every other one on a phone (CSS hides .wi-odd)
    const axis = hours.map((m, i) => nearNow(m) ? '' : `
      <span class="wi-tick${i % 2 ? ' wi-odd' : ''}${i === 0 ? ' wi-tick-first' : ''}${i === hours.length - 1 ? ' wi-tick-last' : ''}" style="left:${pct(m)}">${this._hhmm(m)}</span>`).join('');
    const grid = hours.map(m => `<span class="wi-grid" style="left:${pct(m)}"></span>`).join('');
    const nowLine = showNow ? `<span class="wi-now" style="left:${pct(now)}"></span>` : '';

    const statusOf = (p, sp) => {
      if (p.isMe) return 'me';
      if (now === null) return 'day';
      if (sp.start <= now && sp.end > now) return 'in';
      return sp.end <= now ? 'done' : 'later';
    };
    const rows = people.map(p => {
      const bars = p.spans.map(sp => {
        const w = (sp.end - sp.start) / dur * 100;
        const st = statusOf(p, sp);
        const pastMe = p.isMe && now !== null && sp.end <= now ? ' wi-bar-past' : '';
        return `<span class="wi-bar wi-bar-${st}${pastMe}" style="left:${pct(sp.start)};width:${w.toFixed(3)}%"
          title="${esc(p.name)}: ${sp.startStr}–${sp.endStr}">${w >= 14 ? `<span class="wi-bar-text">${sp.startStr}–${sp.endStr}</span>` : ''}</span>`;
      }).join('');
      return `
        <div class="wi-row${p.isMe ? ' wi-row-me' : ''}${p.status === 'done' ? ' wi-row-done' : ''}">
          <div class="wi-row-name" title="${esc(p.name)}">
            <span class="wi-row-who">${esc(p.name)}</span>
            <span class="wi-row-time">${p.spans.map(s => `${s.startStr}–${s.endStr}`).join(', ')}</span>
          </div>
          <div class="wi-track">${grid}${nowLine}${bars}</div>
        </div>`;
    }).join('');

    // "In store" — how many people are in, in 15-minute steps
    const slots = this._coverage(people, from, to, 15);
    const peak = Math.max(1, ...slots.map(s => s.count));
    const firstIn = Math.min(...people.map(p => p.first));
    const lastOut = Math.max(...people.map(p => p.last));
    const cov = slots.map(s => {
      // Nobody in before the first person arrives or after the last one
      // leaves is just the shop being shut — only a gap in between is a gap.
      if (s.count === 0 && (s.end <= firstIn || s.start >= lastOut)) return '';
      const tone = s.count === 0 ? 'c0' : s.count === 1 ? 'c1' : s.count === 2 ? 'c2' : 'c3';
      const showNum = s.start % 60 === 0 || slots.length <= 24;
      return `<span class="wi-cov wi-${tone}" style="left:${pct(s.start)};width:${(15 / dur * 100).toFixed(3)}%;--h:${Math.max(18, s.count / peak * 100).toFixed(0)}%"
        title="${this._hhmm(s.start)}–${this._hhmm(s.end)}: ${s.count ? s.count + ' in' : 'nobody in'}${s.names.length ? ' — ' + esc(s.names.join(', ')) : ''}">${showNum && s.count ? `<span class="wi-cov-n">${s.count}</span>` : ''}</span>`;
    }).join('');

    wrap.innerHTML = `
      <div class="wi-tl">
        <div class="wi-row wi-axis-row">
          <div class="wi-row-name"></div>
          <div class="wi-axis">${axis}${showNow ? `<span class="wi-now-label" style="left:${pct(now)}">${data.currentTime}</span>` : ''}</div>
        </div>
        ${rows}
        <div class="wi-row wi-cov-row">
          <div class="wi-row-name"><span class="wi-row-who">In store</span><span class="wi-row-time">how many in</span></div>
          <div class="wi-track wi-cov-track">${grid}${nowLine}${cov}</div>
        </div>
        <div class="wi-row wi-cov-key-row">
          <div class="wi-row-name"></div>
          <div class="wi-legend" id="wiCovKey"></div>
        </div>
      </div>`;

    if (legend) {
      const item = (cls, label) => `<span class="wi-key"><span class="wi-key-sw ${cls}"></span>${label}</span>`;
      legend.innerHTML = (data.isToday
        ? item('wi-bar-in', 'In now') + item('wi-bar-later', 'Later') + item('wi-bar-done', 'Gone home')
        : item('wi-bar-day', 'Shift')) + item('wi-bar-me', 'You')
        + (showNow ? `<span class="wi-key"><span class="wi-key-now"></span>Now</span>` : '');
      const covKey = document.getElementById('wiCovKey');
      if (covKey) covKey.innerHTML = item('wi-c1', '1 in') + item('wi-c2', '2 in') + item('wi-c3', '3+ in')
        + (slots.some(s => s.count === 0 && s.end > firstIn && s.start < lastOut) ? item('wi-c0', 'Nobody in') : '');
    }
  },
};
