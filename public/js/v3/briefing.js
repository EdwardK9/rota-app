/* ─── 🎒 Shift Briefing (V3.0) ─────────────────────────────────────────────
   The night-before view: everything about your next shift in one place.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('briefing', '🎒 Shift Briefing', {
  date: null,

  async init() {
    document.getElementById('view-briefing').innerHTML = V3.loading('Packing your bag…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.briefing(this.date));
    } catch (e) {
      document.getElementById('view-briefing').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-briefing');

    if (!d.shift) {
      el.innerHTML = V3.empty('🎒', 'No upcoming shift',
        'Once something is on the rota, this fills in with everything you need to know about it.');
      return;
    }

    const s = d.shift;
    const when = s.is_today ? 'TODAY' : s.days_away === 1 ? 'TOMORROW' : `IN ${s.days_away} DAYS`;
    const gradient = s.is_bank_holiday ? 'linear-gradient(135deg,#F59E0B,#92400E)'
      : s.is_today ? 'linear-gradient(135deg,#10B981,#065F46)'
      : 'linear-gradient(135deg,#3B82F6,#1B2A4A)';

    // Flags worth knowing before you turn up
    const flags = [];
    if (s.is_bank_holiday) flags.push(['🎆', 'Bank holiday — double pay', 'badge-warning']);
    if (s.opening)         flags.push(['🌅', 'You are opening', 'badge-info']);
    if (s.closing)         flags.push(['🌙', 'You are closing', 'badge-info']);
    // Delivery: say when it lands, and whether you're still on when it does —
    // a delivery you finish before isn't the same warning as one you unload.
    const del = d.delivery || { is_delivery_day: d.delivery_day, time: null, on_shift: false };
    if (del.is_delivery_day) {
      const missedBy = del.time && del.time > s.end_time ? 'after you finish'
        : del.time && del.time < s.start_time ? 'before you start' : 'outside your shift';
      const label = del.time
        ? (del.on_shift ? `Delivery ${del.time} — you're on` : `Delivery day — ${del.time}, ${missedBy}`)
        : 'Delivery day';
      flags.push(['📦', label, del.on_shift ? 'badge-warning' : 'badge-info']);
    }
    if (d.crew_summary.alone) flags.push(['🧍', 'Nobody else rostered', 'badge-danger']);
    if (d.turnaround && d.turnaround.clopening) flags.push(['🔄', 'Close then open', 'badge-danger']);
    else if (d.turnaround && d.turnaround.tight) flags.push(['⚠️', `Only ${d.turnaround.hours}h since your last shift`, 'badge-warning']);

    el.innerHTML = `
      ${V3.backButton()}
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Shift on:</label>
          <input type="date" id="brDate" value="${s.date}" style="width:auto" />
          <button class="btn btn-ghost btn-sm" id="brNext">Next shift</button>
        </div>
      </div>

      <div class="v3-hero" style="background:${gradient}">
        <div class="v3-hero-label">${when} · ${esc(s.day_name).toUpperCase()}</div>
        <div class="v3-hero-value">${s.start_time} – ${s.end_time}</div>
        <div class="v3-hero-sub">
          ${s.length_label} on site · ${s.hours}h paid · ${s.break_minutes} min break ·
          worth <strong>${fmtCurrency(s.pay)}</strong>${s.rate ? ` at ${fmtCurrency(s.rate)}/hr` : ''}
        </div>
      </div>

      ${flags.length ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
          ${flags.map(([icon, text, cls]) => `<span class="badge ${cls}">${icon} ${esc(text)}</span>`).join('')}
        </div>` : ''}

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>👥 Who's on with you</h2></div>
          <div class="card-body" style="padding:${d.crew.length ? '0' : '20px'}">
            ${d.crew.length ? d.crew.map(c => `
              <div class="v3-record">
                <div class="v3-record-icon">${c.synergy_rating > 0 ? '💚' : c.synergy_rating < 0 ? '💢' : '👤'}</div>
                <div class="v3-record-body">
                  <div class="v3-record-value" style="font-size:15px">${esc(c.name)}</div>
                  <div class="v3-record-title">${c.start_time}–${c.end_time}${
                    c.job_tier && c.job_tier !== 'assistant' ? ' · ' + esc(({bm:'Branch Manager',am:'Assistant Manager',duty:'Duty Manager'})[c.job_tier] || c.job_tier) : ''}</div>
                </div>
                <div class="v3-record-meta">
                  <div><strong>${Math.round(c.overlap_mins / 60 * 10) / 10}h</strong></div>
                  <div>together</div>
                </div>
              </div>`).join('')
              : '<p class="v3-muted">Nobody else is rostered to overlap this shift.</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>📋 What to expect</h2></div>
          <div class="card-body">
            <div class="v3-grid v3-grid-sm" style="margin-bottom:16px">
              ${V3.tile('This week', `${d.week.hours}h`,
                d.week.contracted ? `contracted ${d.week.contracted}h` : `${d.week.shifts} shifts`)}
              ${V3.tile('Crew', d.crew_summary.count, d.crew_summary.full_shift + ' all shift')}
              ${d.turnaround ? V3.tile('Turnaround', d.turnaround.hours + 'h', 'since last shift',
                d.turnaround.tight ? 'danger' : '') : ''}
              ${d.commute.miles ? V3.tile('Commute', d.commute.miles + ' mi',
                '~' + fmtCurrency(d.commute.fuel_cost) + ' fuel') : ''}
            </div>

            <div class="v3-section-title" style="margin-top:0">🔁 This slot, historically</div>
            <p style="font-size:13px;margin-bottom:8px">${esc(d.history.note)}</p>
            ${d.history.times_worked ? `
              <div style="font-size:13px;line-height:1.9;color:var(--text-muted)">
                ${d.history.avg_clock_in_diff != null ? `
                  <div>⏰ You normally clock in
                    <strong style="color:var(--text)">${Math.abs(d.history.avg_clock_in_diff)} min
                    ${d.history.avg_clock_in_diff >= 0 ? 'early' : 'late'}</strong> for it.</div>` : ''}
                ${d.history.break_skip_rate != null ? `
                  <div>☕ You skip or cut your break
                    <strong style="color:var(--text)">${d.history.break_skip_rate}%</strong> of the time on this slot.</div>` : ''}
              </div>` : ''}

            ${s.notes ? `<div class="v3-note">📝 ${esc(s.notes)}</div>` : ''}
            ${d.crew_summary.difficult.length ? `
              <div class="v3-note">💢 Rostered with ${d.crew_summary.difficult.map(esc).join(', ')},
              who you have marked as difficult to work with.</div>` : ''}
          </div>
        </div>
      </div>
    `;

    document.getElementById('brDate').addEventListener('change', e => { this.date = e.target.value; this.load(); });
    document.getElementById('brNext').addEventListener('click', () => { this.date = null; this.load(); });
  },
});
