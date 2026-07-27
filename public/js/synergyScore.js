/* ─── Synergy Score View (V2.0 Phase 2.2) ───────────────────────────────────
   Shows, for any date, how the shift roster stacks up: a 0-100% "synergy
   score" derived from colleagues' synergy_rating (set in Manage People),
   automated team highlights (efficiency crew / keyholder gaps), and any
   private notes attached to colleagues working that day.
   ───────────────────────────────────────────────────────────────────────── */

const SynergyView = {
  _date: null,

  async init() {
    if (!this._date) this._date = _fmtDateDashSynergy(new Date());
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-synergy');
    el.innerHTML = `
      <div style="max-width:720px">
        <div class="card" style="padding:16px 20px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="synPrevDay">← Prev</button>
            <input type="date" id="synDateInput" class="form-control" style="max-width:170px" />
            <button class="btn btn-ghost btn-sm" id="synNextDay">Next →</button>
            <button class="btn btn-ghost btn-sm" id="synToday">Today</button>
          </div>
        </div>

        <div id="synScoreCard"></div>
        <div id="synHighlights"></div>
        <div id="synTeamList"></div>
        <div id="synReminders"></div>
      </div>
    `;

    document.getElementById('synDateInput').value = this._date;
    document.getElementById('synDateInput').addEventListener('change', e => {
      this._date = e.target.value;
      this.load();
    });
    document.getElementById('synPrevDay').addEventListener('click', () => this._shiftDay(-1));
    document.getElementById('synNextDay').addEventListener('click', () => this._shiftDay(1));
    document.getElementById('synToday').addEventListener('click', () => {
      this._date = _fmtDateDashSynergy(new Date());
      document.getElementById('synDateInput').value = this._date;
      this.load();
    });
  },

  _shiftDay(delta) {
    const d = new Date(this._date + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    this._date = _fmtDateDashSynergy(d);
    document.getElementById('synDateInput').value = this._date;
    this.load();
  },

  async load() {
    const scoreEl = document.getElementById('synScoreCard');
    scoreEl.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
    let data;
    try {
      data = await API.getSynergyScore(this._date);
    } catch (e) {
      scoreEl.innerHTML = `<p style="color:var(--danger)">Could not load: ${esc(e.message)}</p>`;
      document.getElementById('synHighlights').innerHTML = '';
      document.getElementById('synTeamList').innerHTML = '';
      document.getElementById('synReminders').innerHTML = '';
      return;
    }
    this.renderScoreCard(data);
    this.renderHighlights(data.highlights);
    this.renderTeamList(data.team, data.your_shift);
    this.renderReminders(data.team);
  },

  renderScoreCard(data) {
    const el = document.getElementById('synScoreCard');
    const dayLabel = new Date(this._date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    if (!data.your_shift) {
      el.innerHTML = `
        <div class="card" style="padding:20px;margin-bottom:16px">
          <h3 style="font-size:15px;margin-bottom:6px">${esc(dayLabel)}</h3>
          <p style="color:var(--text-muted);font-size:13.5px">You're not scheduled to work this day — no synergy score to show.</p>
        </div>`;
      return;
    }

    if (data.synergy_score == null) {
      el.innerHTML = `
        <div class="card" style="padding:20px;margin-bottom:16px">
          <h3 style="font-size:15px;margin-bottom:6px">${esc(dayLabel)}</h3>
          <p style="font-size:13.5px;color:var(--text-muted)">
            Shift: <strong>${data.your_shift.start_time} – ${data.your_shift.end_time}</strong>
          </p>
          <p style="color:var(--text-muted);font-size:13.5px;margin-top:8px">
            No colleagues recorded working at least half of your shift yet — score unavailable.
          </p>
        </div>`;
      return;
    }

    const score = data.synergy_score;
    const barColor = score >= 65 ? 'var(--success, #10b981)' : score >= 45 ? '#f59e0b' : 'var(--danger, #ef4444)';

    el.innerHTML = `
      <div class="card" style="padding:20px;margin-bottom:16px">
        <h3 style="font-size:15px;margin-bottom:2px">${esc(dayLabel)}</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
          Your shift: <strong>${data.your_shift.start_time} – ${data.your_shift.end_time}</strong>
        </p>
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
          <span style="font-size:32px;font-weight:700">${score}%</span>
          <span style="font-size:15px;color:var(--text-muted)">${esc(data.rating_label || '')}</span>
        </div>
        <div style="background:var(--bg);border-radius:20px;height:10px;overflow:hidden">
          <div style="width:${score}%;height:100%;background:${barColor};transition:width .3s"></div>
        </div>
      </div>`;
  },

  renderHighlights(highlights) {
    const el = document.getElementById('synHighlights');
    if (!highlights || !highlights.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Team Highlights</h4>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${highlights.map(h => `
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;
              color:${h.type === 'warning' ? '#b45309' : 'var(--success, #10b981)'}">
              <span>${h.type === 'warning' ? '⚠️' : '✅'}</span>
              <span>${esc(h.text)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  },

  renderTeamList(team, yourShift) {
    const el = document.getElementById('synTeamList');
    if (!yourShift) { el.innerHTML = ''; return; }
    if (!team || !team.length) {
      el.innerHTML = `<div class="card" style="padding:16px 20px;margin-bottom:16px">
        <p style="color:var(--text-muted);font-size:13px">No colleague shifts recorded for this day.</p>
      </div>`;
      return;
    }
    const synergyIcons = { '-2': '❄️❄️ Difficult', '-1': '❄️ Avoid', '0': '· Neutral', '1': '⭐ Good', '2': '⭐⭐ Dream' };
    const sorted = [...team].sort((a, b) => b.overlap_pct - a.overlap_pct);
    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Roster</h4>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${sorted.map(t => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;
              padding:8px 10px;border:1px solid var(--border);border-radius:8px;
              ${t.counted ? '' : 'opacity:0.6'}">
              <div>
                <strong style="font-size:13.5px">${esc(t.name)}</strong>
                <span style="font-size:12px;color:var(--text-muted)"> · ${t.start_time}–${t.end_time} · ${t.overlap_pct}% overlap</span>
                ${t.tags.length ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
                  ${t.tags.map(tag => `<span style="font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 8px;color:var(--text-muted)">${esc(tag)}</span>`).join('')}
                </div>` : ''}
              </div>
              <span style="font-size:12px;white-space:nowrap;color:var(--text-muted)">${synergyIcons[String(t.synergy_rating)] || ''}</span>
            </div>`).join('')}
        </div>
        <p style="font-size:11.5px;color:var(--text-muted);margin-top:10px">
          Faded rows overlap less than 50% of your shift and aren't counted in the score.
        </p>
      </div>`;
  },

  renderReminders(team) {
    const el = document.getElementById('synReminders');
    const withNotes = (team || []).filter(t => t.notes && t.notes.trim());
    if (!withNotes.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card" style="padding:16px 20px;margin-bottom:16px">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Contextual Reminders</h4>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${withNotes.map(t => `
            <div style="font-size:13px;padding:8px 10px;background:var(--bg);border-radius:8px">
              <strong>${esc(t.name)}:</strong> ${esc(t.notes)}
            </div>`).join('')}
        </div>
      </div>`;
  },
};

function _fmtDateDashSynergy(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
