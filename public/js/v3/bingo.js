/* ─── 🎲 Rota Bingo (V3.0) ─────────────────────────────────────────────────
   A 5×5 card for the week that ticks itself. Week navigation matches the rest
   of the app (Monday-anchored), and the card for a given week never changes.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('bingo', '🎲 Rota Bingo', {
  week: null,   // null = current week

  async init() {
    document.getElementById('view-bingo').innerHTML = V3.loading('Dealing the card…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.bingo(this.week));
    } catch (e) {
      document.getElementById('view-bingo').innerHTML = V3.error(e);
    }
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
      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="bgPrev">‹ Week</button>
          <input type="date" id="bgWeek" value="${d.week.monday}" style="width:auto" />
          <button class="btn btn-ghost btn-sm" id="bgNext">Week ›</button>
          <button class="btn btn-ghost btn-sm" id="bgThis">This week</button>
        </div>
      </div>

      <div class="v3-hero" style="background:${banner.grad}">
        <div class="v3-hero-label">${banner.label}</div>
        <div class="v3-hero-value">${d.ticked} / ${d.total}</div>
        <div class="v3-hero-sub">
          ${esc(banner.text)}<br>
          Week of ${fmtDate(d.week.monday)} — ${s.days_worked} days worked, ${s.hours}h,
          ${fmtCurrency(s.pay)}${s.contracted ? ` against a ${s.contracted}h contract` : ''}.
        </div>
        <div class="v3-hero-bar"><span style="width:${(d.ticked / d.total) * 100}%"></span></div>
      </div>

      <div class="v3-bingo">
        ${d.cells.map(c => `
          <div class="v3-bingo-cell${c.ticked ? ' ticked' : ''}${c.winning ? ' winning' : ''}${c.free ? ' free' : ''}"
               title="${esc(c.text)}${c.ticked ? ' ✓' : ''}">
            <div class="icon">${c.icon}</div>
            <div class="text">${esc(c.text)}</div>
          </div>`).join('')}
      </div>

      <div class="v3-note">
        The card is dealt from the week's own date, so it's the same 24 squares every time you
        look at that week — no re-rolling until you get an easy one. Squares tick automatically
        from your shifts, breaks, clock-ins, colleagues and leave.
      </div>
    `;

    const go = monday => { this.week = monday; this.load(); };
    document.getElementById('bgWeek').addEventListener('change', e => go(e.target.value));
    document.getElementById('bgPrev').addEventListener('click', () => go(this._shift(d.week.monday, -7)));
    document.getElementById('bgNext').addEventListener('click', () => go(this._shift(d.week.monday, 7)));
    document.getElementById('bgThis').addEventListener('click', () => { this.week = null; this.load(); });
  },

  _shift(dateStr, days) {
    const [y, m, dd] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, dd);
    dt.setDate(dt.getDate() + days);
    return fmtLocalDate(dt);
  },
});
