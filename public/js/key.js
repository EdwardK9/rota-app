/* ─── Key / Legend View ───────────────────────────────────────────────────────
   A single reference page explaining every colour, badge and symbol used across
   the app, each shown next to a live example of the real thing.
──────────────────────────────────────────────────────────────────────────────*/

const KeyView = {
  async init() {
    this.render();
  },

  // One legend row: a live example swatch on the left, explanation on the right
  _row(example, title, desc) {
    return `
      <div class="key-row">
        <div class="key-example">${example}</div>
        <div class="key-text">
          <div class="key-title">${title}</div>
          <div class="key-desc">${desc}</div>
        </div>
      </div>`;
  },

  _section(heading, rows) {
    return `
      <div class="card key-card">
        <div class="card-header"><h2>${heading}</h2></div>
        <div class="card-body">${rows.join('')}</div>
      </div>`;
  },

  render() {
    const el = document.getElementById('view-key');

    // ── Calendar tab ──
    const calendar = [
      this._row(
        `<div class="cal-shift-block cal-shift-done" style="width:120px"><div class="cal-shift-times">06:45 – 14:45</div><div class="cal-shift-meta"><span>8h</span><span class="cal-shift-pay">£80</span></div></div>`,
        'Green shift — completed',
        'A shift you have already worked (marked complete). The cell also gets a green top border.'),
      this._row(
        `<div class="cal-shift-block cal-shift-upcoming" style="width:120px"><div class="cal-shift-times">06:45 – 14:45</div><div class="cal-shift-meta"><span>8h</span></div></div>`,
        'Blue shift — upcoming',
        'A scheduled shift you have not worked yet. The cell gets a blue top border.'),
      this._row(
        `<div style="background:#10B981;color:#fff;border-radius:5px;padding:4px 6px;font-size:11px;font-weight:600;display:inline-block">🌴 Annual Leave</div>`,
        'Green — annual leave',
        'A booked annual-leave day.'),
      this._row(
        `<span class="cal-bh-badge">BH</span>`,
        'BH badge — bank holiday',
        'Bank holiday. The day number turns red and the shift is paid at 2× the standard rate.'),
      this._row(
        `<div class="cal-note-chip" style="background:rgba(236,72,153,0.15);color:#ec4899;border-color:rgba(236,72,153,0.3);display:inline-block">🎂 Alex</div>`,
        'Pink chip — birthday',
        "A colleague's birthday on that day."),
      this._row(
        `<div class="cal-note-chip" style="display:inline-block">📝 Pick up parcel…</div>`,
        'Note chip',
        'A personal note attached to that day. Click it to edit.'),
      this._row(
        `<span class="cal-wt-chip cal-wt-worked">38h</span>
         <span class="cal-wt-chip cal-wt-sched">40h</span>
         <span class="cal-wt-chip cal-wt-break">🍵 1.5h</span>
         <span class="cal-wt-chip cal-wt-leave">🌴 7.4h</span>`,
        'Week hours column (right edge)',
        'Per-week totals: <strong style="color:var(--success)">green</strong> = paid hours worked (scheduled break deducted), <strong style="color:var(--info)">blue</strong> = scheduled paid hours incl. upcoming (only shown when it differs from worked), <strong style="color:var(--warning)">amber 🍵</strong> = unused break (break time you worked through — paid extra, not counted as worked hours), <strong style="color:#ec4899">pink 🌴</strong> = annual-leave hours.'),
    ];

    // ── Shifts tab ──
    const shifts = [
      this._row(`<span class="break-chip break-full">30m</span>`, 'Green break chip — full break',
        'The full scheduled break was taken (or is scheduled).'),
      this._row(`<span class="break-chip break-partial">15m</span>`, 'Amber break chip — partial break',
        'Only part of the scheduled break was taken.'),
      this._row(`<span class="break-chip break-none">0m</span>`, 'Red break chip — no break',
        'No break was taken. Unused paid break can become extra pay.'),
      this._row(`<span style="color:var(--success);font-weight:600">Paid Hrs ✓</span>`, 'Paid Hrs',
        'Payable hours = total time minus the scheduled (unpaid) break — what you actually get paid for.'),
    ];

    // ── Dashboard ──
    const dashboard = [
      this._row(`<span class="dash-status dash-status-live">● ON SHIFT</span>`, 'On shift',
        'Shown on the next-shift card while you are clocked in and the shift is in progress.'),
      this._row(`<div class="dash-countdown dash-countdown-over" style="width:200px">🔴 Still clocked in · 12m 3s on shift</div>`,
        'Red count-up timer',
        'Your shift has ended but you have not clocked out yet — the timer counts up in red until you do.'),
      this._row(`<div class="dash-pay-counter" style="width:200px">💷 £24.60 <span class="dash-pay-note">earned so far</span></div>`,
        'Live pay counter',
        'Sits below the shift timer while a shift is in progress, ticking up towards the full shift pay. Pauses during your (assumed mid-shift) unpaid break.'),
      this._row(`<div class="dash-pay-counter" style="width:200px">☕ £24.60 <span class="dash-pay-note">earned so far · paused for unpaid break</span></div>`,
        'Pay counter — paused',
        'The counter has stopped because you are assumed to be on your unpaid break right now.'),
      this._row(`<span class="dash-colleague-chip">Wayne</span>`, 'Colleague chip',
        'Someone rostered on the same shift as you. Click the "Working with" section on the hero card or a Coming Up row to see everyone\'s times.'),
      this._row(`<span class="dash-colleague-chip dash-colleague-chip-crossover">🔄 Janice</span>`, 'Amber chip — crossover',
        "A handover: this colleague finishes up to 15 min before your shift starts, or starts up to 15 min after yours ends (no real overlap)."),
    ];

    // ── Clock In / Out ──
    const clock = [
      this._row(`<span style="color:var(--success);font-weight:600">on time</span>`, 'Green — on time / early',
        'You clocked in/out within the leeway window (or early).'),
      this._row(`<span style="color:var(--danger);font-weight:600">7 min late</span>`, 'Red — late',
        'You clocked in/out outside the leeway window — you may be asked for a reason.'),
      this._row(`<span style="font-size:12px;color:var(--text-muted)">🎯 Start 06:45 · 5 min leeway</span>`, 'Target time',
        'Your scheduled start/end time and the on-time leeway, shown under each clock.'),
    ];

    // ── Team Calendar ──
    const team = [
      this._row(`<div style="background:#3B82F6;color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;display:inline-block">06:45 – 14:45</div>`,
        'Coloured shift blocks',
        'Each person is given their own colour so you can scan the grid quickly. Your own row is highlighted.'),
      this._row(`<div style="background:#10B981;color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;font-weight:600;display:inline-block">🌴 Annual Leave</div>`,
        'Green — annual leave', "A colleague's annual-leave day."),
      this._row(`<div style="background:#F59E0B;color:#fff;border-radius:6px;padding:4px 7px;font-size:11px;font-weight:600;display:inline-block">🏪 All Day</div>`,
        'Amber — all day', 'An all-day / open availability entry.'),
      this._row(`<span style="background:#EF4444;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px">🚫 gap</span>`,
        'Red — coverage gap', 'Nobody is scheduled during part of trading hours that day.'),
      this._row(`<span style="background:#F59E0B;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px">⚠ low</span>`,
        'Amber — low cover', 'Only one person is scheduled during part of trading hours.'),
    ];

    // ── Reports ──
    const reports = [
      this._row(`<span class="diff-pos">+£4.20</span>`, 'Green difference', 'Actual pay is higher than the shift estimate.'),
      this._row(`<span class="diff-neg">-£4.20</span>`, 'Red difference', 'Actual pay is lower than the shift estimate.'),
    ];

    // ── Audit log ──
    const audit = [
      this._row(`<div style="background:rgba(239,68,68,.08);padding:6px 10px;border-radius:4px;font-size:12px">Break corrected · <span style="color:var(--danger)">Wasn't told ✓</span></div>`,
        'Red-tinted row — "wasn\'t told"',
        'You\'ve flagged this change as one nobody told you about at the time.'),
      this._row(`<div class="card audit-stat-active" style="padding:8px 14px;text-align:center;font-size:12px;display:inline-block">Break corrected<br><strong>7</strong></div>`,
        'Clickable stat box (active)',
        'Click any stat box at the top of the Audit page to filter the log to that action type; click again to clear.'),
    ];

    el.innerHTML = `
      <div class="page-header"><h1>🔑 Key</h1>
        <p style="color:var(--text-muted);margin-top:4px">What every colour, badge and symbol across the app means.</p>
      </div>
      ${this._section('📅 Calendar', calendar)}
      ${this._section('📋 Shifts', shifts)}
      ${this._section('🏠 Dashboard', dashboard)}
      ${this._section('🕐 Clock In / Out', clock)}
      ${this._section('🗓️ Team Calendar', team)}
      ${this._section('📊 Reports', reports)}
      ${this._section('🔍 Audit Log', audit)}
    `;
  },
};
