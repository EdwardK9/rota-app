/* ─── 🎲 Rota Bingo (V3.0) ─────────────────────────────────────────────────
   A 5×5 card for the week that ticks itself. Week navigation matches the rest
   of the app (Monday-anchored), and the card for a given week never changes.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('bingo', '🎲 Rota Bingo', {
  week: null,   // null = current week
  board: 'week', // 'week' | 'all-time'
  person: 'me',
  people: null,

  async init() {
    document.getElementById('view-bingo').innerHTML = V3.loading('Dealing the card…');
    try {
      this.people = (await V3.api.dnaPeople()).people;
    } catch (_) {
      this.people = [{ id: 'me', name: 'You' }];
    }
    await this.load();
  },

  async load() {
    try {
      if (this.board === 'all-time') {
        this.renderAllTime(await V3.api.bingoAllTime());
      } else {
        this.render(await V3.api.bingo(this.week, this.person));
      }
    } catch (e) {
      document.getElementById('view-bingo').innerHTML = V3.error(e);
    }
  },

  _personPicker() {
    return `<div class="month-nav">
      <label style="margin-bottom:0;margin-right:4px;font-weight:500">Employee:</label>
      <select id="bgPerson" style="width:auto">
        ${(this.people || []).map(p => `
          <option value="${esc(p.id)}" ${p.id === this.person ? 'selected' : ''}>
            ${esc(p.name)}${p.left ? ' (left)' : ''}
          </option>`).join('')}
      </select>
    </div>`;
  },

  showAllTime() {
    this.board = 'all-time';
    document.getElementById('view-bingo').innerHTML = V3.loading('Adding up every week…');
    this.load();
  },

  showWeek() {
    this.board = 'week';
    document.getElementById('view-bingo').innerHTML = V3.loading('Dealing the card…');
    this.load();
  },

  renderAllTime(d) {
    const el = document.getElementById('view-bingo');
    const max = Math.max(1, ...d.squares.map(sq => sq.times));

    el.innerHTML = `
      ${V3.backButton()}
      <div class="toolbar">
        <button class="btn btn-ghost btn-sm" id="bgBackToWeek">‹ Back to this week</button>
      </div>

      <div class="v3-hero" style="background:linear-gradient(135deg,#F59E0B,#B45309)">
        <div class="v3-hero-label">OVERALL BOARD</div>
        <div class="v3-hero-value">${d.total_weeks} week${d.total_weeks === 1 ? '' : 's'}</div>
        <div class="v3-hero-sub">
          Every square in the pool, tallied against every completed week — not just the 24 that
          happened to get dealt onto any one card.
        </div>
      </div>

      <div class="card">
        <div class="card-body" style="padding:0">
          ${d.squares.map(sq => `
            <div class="v3-record">
              <div class="v3-record-icon">${sq.icon}</div>
              <div class="v3-record-body" style="min-width:0">
                <div class="v3-record-title">${esc(sq.text)}</div>
                <div style="margin-top:6px">${V3.bar((sq.times / max) * 100)}</div>
              </div>
              <div class="v3-record-meta">
                <div>${sq.times}×</div>
                <div>${sq.pct}%</div>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="v3-note">
        Percentage is out of ${d.total_weeks} completed week${d.total_weeks === 1 ? '' : 's'} of history
        — the current week doesn't count yet, since it hasn't happened.
      </div>
    `;

    document.getElementById('bgBackToWeek').addEventListener('click', () => this.showWeek());
  },

  render(d) {
    const el = document.getElementById('view-bingo');
    const s = d.summary;

    let banner = '';
    if (d.full_house) {
      banner = { grad: 'linear-gradient(135deg,#F59E0B,#B45309)', label: '🎉 FULL HOUSE',
                 text: 'Every square on the card. That was a week and a half.' };
    } else if (d.lines_complete > 0) {
      banner = { grad: 'linear-gradient(135deg,#10B981,#065F46)', label: `🎯 BINGO ×${d.lines_complete}`,
                 text: `${d.lines_complete} complete line${d.lines_complete === 1 ? '' : 's'} — highlighted in yellow below.` };
    } else {
      banner = { grad: 'linear-gradient(135deg,#3B82F6,#1B2A4A)', label: 'NO LINES YET',
                 text: 'Squares tick themselves as the week actually happens.' };
    }

    el.innerHTML = `
      ${V3.backButton()}
      <div class="toolbar" style="flex-wrap:wrap;row-gap:8px">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="bgPrev">‹ Week</button>
          <input type="date" id="bgWeek" value="${d.week.monday}" style="width:auto" />
          <button class="btn btn-ghost btn-sm" id="bgNext">Week ›</button>
          <button class="btn btn-ghost btn-sm" id="bgThis">This week</button>
        </div>
        ${this._personPicker()}
        <button class="btn btn-ghost btn-sm" id="bgAllTime">🏆 Overall board</button>
      </div>

      ${d.limited ? `
        <div class="v3-note" style="margin-bottom:16px">
          ℹ️ ${esc(d.person_name)} only has rostered shift times tracked here — the greyed-out squares
          need breaks, clock-ins, pay or leave data this app doesn't have for colleagues, so they can
          never tick on their card.
        </div>` : ''}

      <div class="v3-hero" style="background:${banner.grad}">
        <div class="v3-hero-label">${banner.label}</div>
        <div class="v3-hero-value">${d.ticked} / ${d.total}</div>
        <div class="v3-hero-sub">
          ${esc(banner.text)}<br>
          Week of ${fmtDate(d.week.monday)} — ${s.days_worked} days worked, ${s.hours}h${d.limited ? '' : `,
          ${fmtCurrency(s.pay)}${s.contracted ? ` against a ${s.contracted}h contract` : ''}`}.
        </div>
        <div class="v3-hero-bar"><span style="width:${(d.ticked / d.total) * 100}%"></span></div>
      </div>

      <div class="v3-bingo">
        ${d.cells.map(c => `
          <div class="v3-bingo-cell${c.ticked ? ' ticked' : ''}${c.winning ? ' winning' : ''}${c.free ? ' free' : ''}${c.colleague_blind ? ' v3-bingo-blind' : ''}"
               title="${esc(c.text)}${c.ticked ? ' ✓' : ''}${c.colleague_blind ? ' — not tracked for colleagues' : ''}">
            <div class="icon">${c.icon}</div>
            <div class="text">${esc(c.text)}</div>
          </div>`).join('')}
      </div>

      <div class="v3-note">
        The card is dealt from the week's own date, so it's the same 24 squares every time you
        look at that week — no re-rolling until you get an easy one. Squares tick automatically
        from ${d.limited ? "this person's rostered shifts" : 'your shifts, breaks, clock-ins, colleagues and leave'}.
      </div>
    `;

    const go = monday => { this.week = monday; this.load(); };
    document.getElementById('bgWeek').addEventListener('change', e => go(e.target.value));
    document.getElementById('bgPrev').addEventListener('click', () => go(this._shift(d.week.monday, -7)));
    document.getElementById('bgNext').addEventListener('click', () => go(this._shift(d.week.monday, 7)));
    document.getElementById('bgThis').addEventListener('click', () => { this.week = null; this.load(); });
    document.getElementById('bgAllTime').addEventListener('click', () => this.showAllTime());
    document.getElementById('bgPerson').addEventListener('change', e => { this.person = e.target.value; this.load(); });
  },

  _shift(dateStr, days) {
    const [y, m, dd] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, dd);
    dt.setDate(dt.getDate() + days);
    return fmtLocalDate(dt);
  },
});
