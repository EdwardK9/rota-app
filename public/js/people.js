/* ─── People View ──────────────────────────────────────────────────────────── */

const PeopleView = {
  _colleagues: [],
  _rows: [],

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-people').innerHTML = `
      <div class="toolbar">
        <span style="font-weight:600;color:var(--text-muted)">Upcoming shifts with your team</span>
        <div class="toolbar-right">
          <button class="btn btn-ghost" id="ppRefreshBtn">↻ Refresh</button>
        </div>
      </div>

      <!-- Name pills at top — click for modal -->
      <div id="ppPills" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px"></div>

      <!-- Main table -->
      <div id="ppTableWrap" style="overflow-x:auto">
        <p style="color:var(--text-muted)">Loading…</p>
      </div>
    `;

    document.getElementById('ppRefreshBtn').addEventListener('click', () => this.load());
  },

  async load() {
    try {
      const { colleagues, rows } = await API.getPeople();
      this._colleagues = colleagues;
      this._rows = rows;
      this.renderPills(colleagues);
      this.renderTable(colleagues, rows);
    } catch (e) {
      document.getElementById('ppTableWrap').innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  renderPills(colleagues) {
    const el = document.getElementById('ppPills');
    if (!el) return;
    if (!colleagues.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No colleagues yet — add them in the Leaderboard tab.</p>';
      return;
    }
    el.innerHTML = colleagues.map(c => `
      <button class="btn" style="border-radius:20px;padding:5px 14px;font-size:13px;background:var(--sidebar-bg);color:#fff"
        onclick="PeopleView.openModal(${c.id})">
        ${c.name.split(' ')[0]}
      </button>
    `).join('');
  },

  renderTable(colleagues, rows) {
    const wrap = document.getElementById('ppTableWrap');
    if (!wrap) return;

    if (!colleagues.length) {
      wrap.innerHTML = '<p style="color:var(--text-muted)">Add colleagues in the Leaderboard tab first.</p>';
      return;
    }
    if (!rows.length) {
      wrap.innerHTML = '<p style="color:var(--text-muted)">No upcoming shifts found.</p>';
      return;
    }

    const fmt = mins => {
      const h = Math.floor(mins / 60), m = mins % 60;
      return m ? `${h}h ${m}m` : `${h}h`;
    };

    const fmtDate = d => {
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
    };

    // Header row — date | my times | one col per colleague
    const headerCols = colleagues.map(c =>
      `<th style="min-width:100px;text-align:center;padding:8px 6px;white-space:nowrap;font-size:12px">${c.name.split(' ')[0]}</th>`
    ).join('');

    const dataRows = rows.map(({ shift, overlap }) => {
      const cols = colleagues.map(c => {
        const ov = overlap[c.id];
        if (!ov) return `<td style="text-align:center;color:var(--border)">—</td>`;
        return `
          <td style="text-align:center;padding:6px">
            <span style="display:block;font-weight:600;color:var(--primary-text);font-size:13px">${fmt(ov.mins)}</span>
            <span style="display:block;color:var(--text-muted);font-size:11px">${ov.start_time}–${ov.end_time}</span>
          </td>`;
      }).join('');

      return `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 10px;white-space:nowrap;font-weight:500">${fmtDate(shift.date)}</td>
          <td style="padding:8px 10px;white-space:nowrap;color:var(--text-muted);font-size:13px">${shift.start_time}–${shift.end_time}</td>
          ${cols}
        </tr>`;
    }).join('');

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="border-bottom:2px solid var(--border);background:var(--bg)">
            <th style="text-align:left;padding:8px 10px;white-space:nowrap">Date</th>
            <th style="text-align:left;padding:8px 10px;white-space:nowrap">My Shift</th>
            ${headerCols}
          </tr>
        </thead>
        <tbody>${dataRows}</tbody>
      </table>
    `;
  },

  async openModal(colleagueId) {
    const c = this._colleagues.find(x => x.id === colleagueId);
    if (!c) return;

    Modal.open(`Next shifts with ${c.name.split(' ')[0]}`, '<p style="color:var(--text-muted)">Loading…</p>');

    try {
      const { shifts } = await API.getNextWith(colleagueId, 8);

      if (!shifts.length) {
        document.getElementById('modalBody').innerHTML =
          `<p style="color:var(--text-muted)">No upcoming shared shifts found with ${c.name}.</p>`;
        return;
      }

      const fmt = mins => {
        const h = Math.floor(mins / 60), m = mins % 60;
        return m ? `${h}h ${m}m` : `${h}h`;
      };

      const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB',
        { weekday:'long', day:'numeric', month:'long' });

      const cards = shifts.map((s, i) => `
        <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px;${i===0?'border-color:var(--primary);background:rgba(255,214,0,0.06)':''}">
          ${i===0 ? '<div style="font-size:11px;font-weight:700;color:var(--primary-text);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Next up</div>' : ''}
          <div style="font-weight:600;margin-bottom:6px">${fmtDate(s.date)}</div>
          <div style="display:flex;gap:20px;font-size:13px;color:var(--text-muted)">
            <span>You: <strong style="color:var(--text)">${s.myStart}–${s.myEnd}</strong></span>
            <span>${c.name.split(' ')[0]}: <strong style="color:var(--text)">${s.theirStart}–${s.theirEnd}</strong></span>
            <span>Together: <strong style="color:var(--primary-text)">${fmt(s.overlapMins)}</strong></span>
          </div>
        </div>
      `).join('');

      document.getElementById('modalBody').innerHTML = cards;
    } catch (e) {
      document.getElementById('modalBody').innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },
};
