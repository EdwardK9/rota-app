/* ─── Fatigue Audit View (V2.0 Phase 4.1) ───────────────────────────────────
   Clopening detector, consecutive-day streak tracker, and overtime alerts
   for the imported team calendar, with a Mon-Sun week picker.
   ───────────────────────────────────────────────────────────────────────── */

const FatigueAuditView = {
  _week: null,

  async init() {
    if (!this._week) this._week = _fmtDateDashFA(new Date());
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-fatigue-audit');
    el.innerHTML = `
      <div style="max-width:760px">
        <div class="card" style="padding:16px 20px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="faPrevWeek">← Prev week</button>
            <span id="faWeekLabel" style="font-weight:600;font-size:13.5px;min-width:220px"></span>
            <button class="btn btn-ghost btn-sm" id="faNextWeek">Next week →</button>
            <button class="btn btn-ghost btn-sm" id="faThisWeek">This week</button>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin-top:10px">
            Checks the imported team calendar for &lt;11h rest between shifts, 6+ consecutive working days,
            and hourly staff scheduled over their contracted hours.
          </p>
        </div>
        <div id="faSummary"></div>
        <div id="faList"></div>
      </div>
    `;
    document.getElementById('faPrevWeek').addEventListener('click', () => this._shiftWeek(-7));
    document.getElementById('faNextWeek').addEventListener('click', () => this._shiftWeek(7));
    document.getElementById('faThisWeek').addEventListener('click', () => {
      this._week = _fmtDateDashFA(new Date());
      this.load();
    });
  },

  _shiftWeek(deltaDays) {
    const d = new Date(this._week + 'T12:00:00');
    d.setDate(d.getDate() + deltaDays);
    this._week = _fmtDateDashFA(d);
    this.load();
  },

  async load() {
    document.getElementById('faList').innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
    let data;
    try {
      data = await API.getFatigueAudit(this._week);
    } catch (e) {
      document.getElementById('faList').innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(e.message)}</p>`;
      return;
    }
    this.renderWeekLabel(data.week);
    this.renderSummary(data.colleagues);
    this.renderList(data.colleagues);
  },

  renderWeekLabel(week) {
    const fmt = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    document.getElementById('faWeekLabel').textContent = `${fmt(week.from)} – ${fmt(week.to)}`;
  },

  renderSummary(colleagues) {
    const el = document.getElementById('faSummary');
    const totalFlags = colleagues.reduce((t, c) => t + c.flag_count, 0);
    const flaggedCount = colleagues.filter(c => c.flag_count > 0).length;
    if (!colleagues.length) { el.innerHTML = ''; return; }
    el.innerHTML = totalFlags === 0
      ? `<div class="card" style="padding:14px 18px;margin-bottom:16px;color:var(--success,#10b981)">✅ No schedule health issues found for this week.</div>`
      : `<div class="card" style="padding:14px 18px;margin-bottom:16px;color:#b45309">
           ⚠️ ${totalFlags} issue${totalFlags !== 1 ? 's' : ''} across ${flaggedCount} colleague${flaggedCount !== 1 ? 's' : ''}.
         </div>`;
  },

  renderList(colleagues) {
    const el = document.getElementById('faList');
    if (!colleagues.length) {
      el.innerHTML = `<div class="card" style="padding:16px 20px"><p style="color:var(--text-muted);font-size:13px">No active colleagues to audit.</p></div>`;
      return;
    }

    el.innerHTML = colleagues.map(c => {
      if (c.flag_count === 0) {
        return `
          <div class="card" style="padding:12px 18px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:13.5px">${esc(c.name)}</strong>
            <span style="font-size:12.5px;color:var(--success,#10b981)">✅ All clear</span>
          </div>`;
      }
      const rows = [];
      c.clopening.forEach(cl => rows.push(`
        <div style="font-size:13px;padding:6px 0;border-top:1px solid var(--border)">
          🔁 <strong>Clopening:</strong> worked until ${cl.previous.end_time} on ${esc(cl.previous.date)},
          back at ${cl.next.start_time} on ${esc(cl.next.date)} — only ${cl.rest_hours}h rest.
        </div>`));
      c.consecutive_streaks.forEach(s => rows.push(`
        <div style="font-size:13px;padding:6px 0;border-top:1px solid var(--border)">
          📅 <strong>${s.length} consecutive days:</strong> ${esc(s.start_date)} – ${esc(s.end_date)}.
        </div>`));
      if (c.overtime) rows.push(`
        <div style="font-size:13px;padding:6px 0;border-top:1px solid var(--border)">
          ⏱️ <strong>Overtime:</strong> ${c.overtime.scheduled_hours}h scheduled vs ${c.overtime.contract_hours}h contracted
          (+${c.overtime.overage}h over).
        </div>`);

      return `
        <div class="card" style="padding:12px 18px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong style="font-size:13.5px">${esc(c.name)}</strong>
            <span style="font-size:12px;color:#b45309">${c.flag_count} issue${c.flag_count !== 1 ? 's' : ''}</span>
          </div>
          ${rows.join('')}
        </div>`;
    }).join('');
  },
};

function _fmtDateDashFA(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
