/* ─── Streaks & Badges View (V2.0) ─────────────────────────────────────────
   Three streaks derived from data the app already tracks — no new inputs
   needed. "Current" is the active run up to your most recent qualifying
   entry; "Best ever" is the longest run on record; badges unlock at
   milestone thresholds of the best-ever value.
   ───────────────────────────────────────────────────────────────────────── */

const StreaksView = {
  data: null,

  STREAK_DEFS: [
    {
      key: 'breakStreak', icon: '☕', title: 'Break Streak',
      unit: 'shift', unitPlural: 'shifts',
      blurb: "Completed shifts in a row where you didn't skip your break.",
      tiers: [5, 15, 30, 60],
    },
    {
      key: 'punctualStreak', icon: '⏰', title: 'Punctual Streak',
      unit: 'day', unitPlural: 'days',
      blurb: 'Clock-ins in a row at or before your shift start time (5 min grace).',
      tiers: [5, 15, 30, 60],
    },
    {
      key: 'contractStreak', icon: '📈', title: 'On-Contract Streak',
      unit: 'month', unitPlural: 'months',
      blurb: 'Completed calendar months in a row where logged hours met or beat your contract.',
      tiers: [2, 4, 8, 12],
    },
  ],

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-streaks').innerHTML = `
      <div id="streaksContent">
        <div style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</div>
      </div>
    `;
  },

  async load() {
    const el = document.getElementById('streaksContent');
    try {
      this.data = await API.getStreaks();
      this.renderCards();
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);padding:20px">Failed to load streaks: ${esc(e.message)}</p>`;
    }
  },

  _badgeRow(longest, tiers) {
    return `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      ${tiers.map(t => {
        const unlocked = longest >= t;
        return `<span style="
          font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;
          background:${unlocked ? 'var(--primary)' : 'var(--bg)'};
          color:${unlocked ? 'var(--primary-text)' : 'var(--text-muted)'};
          border:1px solid ${unlocked ? 'var(--primary)' : 'var(--border)'};
          opacity:${unlocked ? '1' : '0.6'}"
          title="${unlocked ? 'Unlocked' : 'Locked'} — reach ${t} to ${unlocked ? 'have unlocked' : 'unlock'} this badge">
          ${unlocked ? '🏅' : '🔒'} ${t}
        </span>`;
      }).join('')}
    </div>`;
  },

  renderCards() {
    const el = document.getElementById('streaksContent');
    const cards = this.STREAK_DEFS.map(def => {
      const s = this.data[def.key] || { current: 0, longest: 0 };
      const unit = n => n === 1 ? def.unit : def.unitPlural;
      return `
        <div class="card">
          <div class="card-body">
            <div style="font-size:32px;line-height:1">${def.icon}</div>
            <div style="font-weight:700;font-size:15px;margin:6px 0 4px">${def.title}</div>
            <div style="font-size:12px;color:var(--text-muted);min-height:34px">${def.blurb}</div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
              <div>
                <div style="font-size:26px;font-weight:800;color:var(--primary)">${s.current}</div>
                <div style="font-size:11px;color:var(--text-muted)">current ${unit(s.current)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:18px;font-weight:700">${s.longest}</div>
                <div style="font-size:11px;color:var(--text-muted)">best ever</div>
              </div>
            </div>
            ${this._badgeRow(s.longest, def.tiers)}
          </div>
        </div>`;
    }).join('');

    el.innerHTML = `
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;max-width:640px">
        Streaks are worked out automatically from your logged shifts and clock-ins — nothing to set up.
        Badges unlock permanently once your best-ever run reaches each milestone, even if the current streak later resets.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
        ${cards}
      </div>
    `;
  },
};
