/* ─── Leaderboard View ─────────────────────────────────────────────────────── */

const LeaderboardView = {
  activeTab: 'shifts',

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-leaderboard').innerHTML = `
      <div class="toolbar" style="flex-wrap:wrap;gap:8px">
        <span style="font-weight:600;color:var(--text-muted)">Who have you worked with most?</span>
        <div class="toolbar-right">
          <button class="btn btn-ghost" id="lbRefreshBtn">↻ Refresh</button>
          <button class="btn btn-primary" id="lbManageBtn">Manage People</button>
        </div>
      </div>

      <!-- Manage colleagues panel (hidden by default) -->
      <div id="lbManagePanel" class="card" style="display:none;margin-bottom:16px;padding:16px">

        <h3 style="margin-bottom:12px;font-size:15px">Add Person</h3>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <input id="lbNewName" class="form-control" placeholder="Full name e.g. Nikki Houghton" style="flex:1" />
          <button class="btn btn-primary" id="lbAddBtn">Add</button>
        </div>

        <h3 style="margin-bottom:10px;font-size:15px">People <span style="font-size:12px;color:var(--text-muted);font-weight:400">— drag ↕ to reorder, click ✏️ to edit</span></h3>
        <div id="lbColleagueList" style="margin-bottom:16px"></div>

        <hr style="margin:16px 0;border-color:var(--border)"/>
        <p style="font-size:13px;color:var(--text-muted)">
          To import Team screenshots, use the
          <a href="#" onclick="App.switchView('team-upload');return false" style="color:var(--primary-text)">📸 Team Upload</a>
          tab in the sidebar.
        </p>
      </div>

      <!-- Edit colleague modal (inline) -->
      <div id="lbEditPanel" class="card" style="display:none;margin-bottom:16px;padding:16px;border:2px solid var(--primary)">
        <h3 style="margin-bottom:14px;font-size:15px">Edit Person</h3>
        <input type="hidden" id="lbEditId" />
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
            <input id="lbEditName" class="form-control" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Birthday</label>
            <input id="lbEditBirthday" class="form-control" type="date" />
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:-6px 0 14px">
          Contract hours are edited in Manage People, where changes can be dated.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="lbEditSave">Save</button>
          <button class="btn btn-ghost" id="lbEditCancel">Cancel</button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="import-tabs" style="margin-bottom:0;flex-wrap:wrap">
        <button class="import-tab ${this.activeTab==='shifts'?'active':''}" data-lb="shifts">📅 Most Shifts Together</button>
        <button class="import-tab ${this.activeTab==='hours'?'active':''}"  data-lb="hours">⏱️ Most Hours Together</button>
        <button class="import-tab ${this.activeTab==='totalShifts'?'active':''}" data-lb="totalShifts">🏬 Most Shifts (Everyone)</button>
        <button class="import-tab ${this.activeTab==='totalHours'?'active':''}"  data-lb="totalHours">🏬 Most Hours (Everyone)</button>
      </div>
      <div id="lbContent" style="border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius) var(--radius);padding:20px"></div>
    `;

    document.getElementById('lbRefreshBtn').addEventListener('click', () => this.load());
    document.getElementById('lbManageBtn').addEventListener('click', () => {
      const p = document.getElementById('lbManagePanel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('lbAddBtn').addEventListener('click', () => this.addColleague());
    document.getElementById('lbNewName').addEventListener('keydown', e => { if (e.key === 'Enter') this.addColleague(); });
    document.getElementById('lbEditSave').addEventListener('click', () => this.saveEdit());
    document.getElementById('lbEditCancel').addEventListener('click', () => {
      document.getElementById('lbEditPanel').style.display = 'none';
    });

    document.querySelectorAll('.import-tab[data-lb]').forEach(btn =>
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset.lb;
        document.querySelectorAll('.import-tab[data-lb]').forEach(b => b.classList.toggle('active', b.dataset.lb === this.activeTab));
        this.renderTable(this._data);
      })
    );
  },

  async load() {
    const content = document.getElementById('lbContent');
    if (!content) return;
    content.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
    try {
      const [data, colleagues] = await Promise.all([API.getLeaderboard(), API.getColleagues()]);
      this._data = data;
      this.renderColleagueList(colleagues);
      this.renderTable(data);
    } catch (e) {
      content.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  renderColleagueList(colleagues) {
    const el = document.getElementById('lbColleagueList');
    if (!el) return;
    if (!colleagues.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No colleagues added yet.</p>';
      return;
    }
    this._colleagues = colleagues;
    el.innerHTML = colleagues.map((c, i) => {
      const bday = c.birthday ? ` 🎂 ${c.birthday.slice(8)}/${c.birthday.slice(5,7)}` : '';
      const hrs  = c.contract_hours ? ` · ${c.contract_hours}h/wk` : '';
      return `
        <div data-id="${c.id}" draggable="true" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:var(--card-bg);user-select:none;-webkit-user-select:none">
          <span style="cursor:grab;color:var(--text-muted);font-size:16px;user-select:none" class="lb-drag-handle">⠿</span>
          <div style="flex:1;font-size:13px">
            <strong>${c.name}</strong>
            <span style="color:var(--text-muted)">${bday}${hrs}</span>
          </div>
          <button onclick="LeaderboardView.openEdit(${c.id})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 6px" title="Edit">✏️</button>
          <button onclick="LeaderboardView.moveUp(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px" ${i===0?'disabled':''} title="Move up">▲</button>
          <button onclick="LeaderboardView.moveDown(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px" ${i===colleagues.length-1?'disabled':''} title="Move down">▼</button>
          <button onclick="LeaderboardView.deleteColleague(${c.id},'${c.name.replace(/'/g,"\\'")}')"
            style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:16px;line-height:1;padding:2px 4px" title="Remove">&times;</button>
        </div>`;
    }).join('');

    // Wire up HTML5 drag-and-drop
    let dragSrcId = null;
    el.querySelectorAll('[data-id][draggable]').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragSrcId = row.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSrcId);
        setTimeout(() => { row.style.opacity = '0.4'; }, 0);
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '';
        el.querySelectorAll('[data-id]').forEach(r => { r.style.outline = ''; });
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (row.dataset.id !== dragSrcId) row.style.outline = '2px solid var(--primary)';
      });
      row.addEventListener('dragleave', () => { row.style.outline = ''; });
      row.addEventListener('drop', async e => {
        e.preventDefault();
        row.style.outline = '';
        const srcId = parseInt(dragSrcId, 10);
        const dstId = parseInt(row.dataset.id, 10);
        if (srcId === dstId) return;
        const cols = [...this._colleagues];
        const srcIdx = cols.findIndex(c => c.id === srcId);
        const dstIdx = cols.findIndex(c => c.id === dstId);
        const [moved] = cols.splice(srcIdx, 1);
        cols.splice(dstIdx, 0, moved);
        await this._saveOrder(cols);
      });
    });
  },

  openEdit(id) {
    const c = (this._colleagues || []).find(x => x.id === id);
    if (!c) return;
    document.getElementById('lbEditId').value       = c.id;
    document.getElementById('lbEditName').value     = c.name;
    document.getElementById('lbEditBirthday').value = c.birthday || '';
    document.getElementById('lbEditPanel').style.display = 'block';
    document.getElementById('lbEditPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  async saveEdit() {
    const id   = document.getElementById('lbEditId').value;
        const name = document.getElementById('lbEditName').value.trim();
    const birthday = document.getElementById('lbEditBirthday').value || null;
    if (!name) return showToast('Name cannot be empty', 'error');
    try {
      await API.updateColleague(id, { name, birthday });
      document.getElementById('lbEditPanel').style.display = 'none';
      await this.load();
      showToast('Saved');
    } catch(e) { showToast(e.message, 'error'); }
  },

  async moveUp(index) {
    const cols = this._colleagues || [];
    if (index <= 0) return;
    [cols[index - 1], cols[index]] = [cols[index], cols[index - 1]];
    await this._saveOrder(cols);
  },

  async moveDown(index) {
    const cols = this._colleagues || [];
    if (index >= cols.length - 1) return;
    [cols[index], cols[index + 1]] = [cols[index + 1], cols[index]];
    await this._saveOrder(cols);
  },

  async _saveOrder(cols) {
    const items = cols.map((c, i) => ({ id: c.id, sort_order: i }));
    await API.reorderColleagues(items);
    await this.load();
  },

  renderTable(data) {
    const el = document.getElementById('lbContent');
    if (!el || !data) return;
    const list = this.activeTab === 'shifts' ? data.byShifts
      : this.activeTab === 'hours' ? data.byHours
      : this.activeTab === 'totalShifts' ? data.byTotalShifts
      : data.byTotalHours;

    if (!list.length) {
      el.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px">
        No colleagues added yet — add your colleagues and import a Team screenshot to get started.
      </p>`;
      return;
    }

    // Everyone shows up, including people with 0 shared shifts so far —
    // active colleagues first (already sorted by the server), departed ones after.
    const withShifts  = list.filter(r => !r.left_date);
    const leftWithShifts = list.filter(r => r.left_date);

    const fmt = mins => {
      const h = Math.floor(mins / 60), m = mins % 60;
      return m ? h + 'h ' + m + 'm' : h + 'h';
    };

    // Use top of combined list for percentage bar scaling
    const topVal = list[0];

    const isTotalMode = this.activeTab === 'totalShifts' || this.activeTab === 'totalHours';
    const isShiftsMode = this.activeTab === 'shifts' || this.activeTab === 'totalShifts';
    const valOf = r => isShiftsMode
      ? (isTotalMode ? r.totalShifts : r.shiftsTogether)
      : (isTotalMode ? r.totalMinutes : r.minutesTogether);

    const renderRows = (entries, startRank) => entries.map((r, i) => {
      const rank = startRank + i;
      const medal = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '#' + (rank + 1);
      const pct = !topVal ? 0 : (valOf(r) / (valOf(topVal) || 1) * 100);
      const val = isShiftsMode
        ? valOf(r) + ' shift' + (valOf(r) !== 1 ? 's' : '')
        : fmt(valOf(r));
      const leftBadge = r.left_date
        ? '<span style="font-size:11px;color:var(--text-muted);background:var(--border);border-radius:4px;padding:1px 5px;margin-left:6px">left</span>'
        : '';
      return '<tr style="' + (r.left_date ? 'opacity:0.7' : '') + '">' +
        '<td style="width:40px;text-align:center;font-size:18px">' + medal + '</td>' +
        '<td style="font-weight:500">' + r.name + leftBadge + '</td>' +
        '<td style="text-align:right;font-weight:700;color:var(--primary-text)">' + val + '</td>' +
        '<td style="width:120px;padding-left:12px">' +
          '<div style="background:var(--border);border-radius:4px;height:8px;overflow:hidden">' +
            '<div style="background:var(--primary);width:' + pct + '%;height:100%;border-radius:4px"></div>' +
          '</div></td></tr>';
    }).join('');

    // Rank across everyone (active first, then departed)
    const allWithShifts = [...withShifts, ...leftWithShifts];
    const rows = renderRows(allWithShifts, 0);

    el.innerHTML = '<table style="width:100%;border-collapse:collapse"><tbody>' + rows + '</tbody></table>';
  },

  async addColleague() {
    const input = document.getElementById('lbNewName');
    const name = input.value.trim();
    if (!name) return;
    try {
      await API.addColleague(name);
      input.value = '';
      await this.load();
      showToast('Added ' + name);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async deleteColleague(id, name) {
    if (!confirm('Remove ' + name + '? This will also delete all their imported shifts.')) return;
    try {
      await API.deleteColleague(id);
      await this.load();
      showToast('Removed ' + name);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

};