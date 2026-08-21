/* ─── ⏳ Countdown Board (V3.0) ────────────────────────────────────────────
   Every "how long until…" on one board, each ticking live. The server sends an
   ISO target per entry; the client owns the clock from there, so this is one
   request on open regardless of how many countdowns are on screen.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('countdowns', '⏳ Countdown Board', {
  data: null,
  timer: null,

  async init() {
    document.getElementById('view-countdowns').innerHTML = V3.loading('Setting the timers…');
    await this.load();
  },

  destroy() {
    clearInterval(this.timer);
    this.timer = null;
  },

  async load() {
    try {
      this.data = await V3.api.countdowns();
      this.render();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), 1000);
      this.tick();
    } catch (e) {
      document.getElementById('view-countdowns').innerHTML = V3.error(e);
    }
  },

  CATEGORIES: {
    work:      { label: '💼 Work',       order: 0 },
    money:     { label: '💷 Money',      order: 1 },
    rest:      { label: '🌴 Time off',   order: 2 },
    milestone: { label: '🎊 Milestones', order: 3 },
  },

  tick() {
    const now = Date.now();
    for (const c of this.data.countdowns) {
      const el = document.getElementById('cd_' + c.key);
      if (!el) continue;
      const ms = new Date(c.target).getTime() - now;
      const p = V3.countdownParts(ms);

      el.textContent = ms <= 0
        ? 'Now'
        : p.days > 0
          ? `${p.days}d ${p.clock}`
          : p.clock;

      const card = el.closest('.v3-countdown');
      if (card) {
        // Under a day left reads as "imminent"; anything past reads as done.
        card.classList.toggle('imminent', ms > 0 && p.days === 0);
        card.classList.toggle('past', ms <= 0);
      }
    }
  },

  render() {
    const el = document.getElementById('view-countdowns');
    const items = this.data.countdowns;

    if (!items.length) {
      el.innerHTML = V3.empty('⏳', 'Nothing to count down to',
        'Add some shifts, leave or colleague birthdays and they will appear here.');
      return;
    }

    // Group by category, in a fixed order, so the board reads consistently.
    const groups = Object.entries(this.CATEGORIES)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, meta]) => ({ key, meta, items: items.filter(i => i.category === key) }))
      .filter(g => g.items.length);

    el.innerHTML = `
      <p class="v3-intro">
        Everything the app knows a date for, ticking live. Nothing to set up — it reads your
        shifts, payslip dates, booked leave, the gov.uk bank holiday list and colleague birthdays.
      </p>

      ${groups.map(g => `
        <div class="v3-section-title">${g.meta.label}</div>
        <div class="v3-grid">
          ${g.items.map(c => `
            <div class="v3-countdown">
              <div class="v3-countdown-icon">${c.icon}</div>
              <div style="flex:1;min-width:0">
                <div class="v3-countdown-title">${esc(c.title)}</div>
                <div class="v3-countdown-clock" id="cd_${esc(c.key)}">—</div>
                <div class="v3-countdown-detail">
                  ${fmtDate(c.date)}${c.time ? ' at ' + c.time : ''} · ${V3.relativeDays(c.days_away)}
                  ${c.detail ? `<br>${esc(c.detail)}` : ''}
                  ${c.value ? `<br><strong>${esc(c.value)}</strong>` : ''}
                </div>
              </div>
            </div>`).join('')}
        </div>`).join('')}
    `;
  },
});
