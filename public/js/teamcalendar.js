/* ─── Team Calendar View ───────────────────────────────────────────────────── */

const TeamCalendarView = {
  activeTab: 'week',          // 'week' | 'person'
  _currentWeek: null,         // YYYY-MM-DD (any date in the week — we send Monday)
  _selectedId: null,
  _personFrom: null,
  _personTo: null,

  async init() {
    if (!this._currentWeek) {
      const now = new Date();
      this._currentWeek = this._mondayOf(now);
    }
    if (!this._personFrom)  this._personFrom  = this._currentWeek;
    if (!this._personTo) {
      const d = new Date(this._currentWeek + 'T00:00:00');
      d.setDate(d.getDate() + 27);
      this._personTo = this._localDateStr(d);
    }
    this.render();
    await this.loadActiveTab();

    // Re-render the week view when crossing the mobile/desktop breakpoint
    if (!this._resizeBound) {
      this._resizeBound = true;
      let rt;
      window.addEventListener('resize', () => {
        clearTimeout(rt);
        rt = setTimeout(() => {
          if (this.activeTab === 'week' && this._lastWeekData &&
              this._isMobile() !== this._lastRenderMobile) {
            this._renderWeekGrid(this._lastWeekData);
          }
        }, 200);
      });
    }
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mondayOf(date) {
    const d = new Date(date);
    const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    d.setDate(d.getDate() - dow);
    return this._localDateStr(d);
  },

  _localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  _addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return this._localDateStr(d);
  },

  _fmtDay(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  },

  _fmtWeekRange(monday) {
    const sunday = this._addDays(monday, 6);
    const from = new Date(monday + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const to   = new Date(sunday + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${from} – ${to}`;
  },

  _toMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; },

  // Use the readable day-stacked layout on phones AND on narrow desktop windows
  // (≤900px) — the 9-column week table is unreadable below this, so a half-screen
  // browser window now reflows to cards instead of a cramped horizontal scroll.
  _isMobile() { return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches; },

  _breakMins(s, e) {
    const gross = this._toMins(e) - this._toMins(s);
    if (gross < 270) return 0;   // < 4h 30m → no break
    if (gross <= 360) return 15; // 4h 30m – 6h → 15 min
    return 30;                   // > 6h → 30 min
  },

  _fmtMins(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  },

  _fmtDuration(s, e) {
    const gross = this._toMins(e) - this._toMins(s);
    if (gross <= 0) return '';
    const brk = this._breakMins(s, e);
    const net = gross - brk;
    const netStr = this._fmtMins(net);
    return brk > 0 ? `${netStr} <span style="opacity:0.7;font-size:10px">🍵${brk}m</span>` : netStr;
  },

  // ── Coverage gap detection ────────────────────────────────────────────────

  // Closing times vary by day of week and period
  _getCloseTime(dateStr) {
    const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun, 6=Sat
    if (dow === 6) return '18:15'; // Saturday
    if (dow === 0) return '16:15'; // Sunday
    // Weekday: closing time changed Feb 2026
    return dateStr >= '2026-02-01' ? '19:15' : '20:00';
  },

  // Scan every 15-min slot from open to closing time.
  // Returns array of gap objects: { fromMins, toMins, minCount }
  // where minCount is the minimum staff count seen in that gap (0 = nobody, 1 = understaffed).
  _computeDayCoverage(dateStr, allShifts) {
    const dow  = new Date(dateStr + 'T12:00:00').getDay(); // 0=Sun
    const OPEN = dow === 0 ? 8 * 60 + 45 : 6 * 60 + 45; // 08:45 Sun, 06:45 otherwise
    const CLOSE = this._toMins(this._getCloseTime(dateStr));
    const SLOT  = 15;

    const gaps = [];
    let gapStart = null, gapMin = null;

    for (let t = OPEN; t < CLOSE; t += SLOT) {
      let count = 0;
      for (const s of allShifts) {
        if (s.shift_type === 'leave') continue;
        if (s.shift_type === 'all_day') { count++; continue; }
        const st = this._toMins(s.start_time), en = this._toMins(s.end_time);
        if (st <= t && t < en) count++;
      }

      if (count < 2) {
        if (gapStart === null) { gapStart = t; gapMin = count; }
        else if (count < gapMin) gapMin = count;
      } else {
        if (gapStart !== null) { gaps.push({ fromMins: gapStart, toMins: t, minCount: gapMin }); gapStart = null; }
      }
    }
    if (gapStart !== null) gaps.push({ fromMins: gapStart, toMins: CLOSE, minCount: gapMin });
    return gaps;
  },

  _minsToTime(m) {
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  },

  // ── Shell ──────────────────────────────────────────────────────────────────

  render() {
    document.getElementById('view-team-calendar').innerHTML = `
      <div class="import-tabs" style="margin-bottom:0">
        <button class="import-tab ${this.activeTab==='week'?'active':''}"   data-tc="week">📅 Week View</button>
        <button class="import-tab ${this.activeTab==='person'?'active':''}" data-tc="person">👤 Person View</button>
      </div>
      <div id="tcTabContent" style="border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius) var(--radius);padding:16px;min-height:300px"></div>

      <!-- Add Shift Modal -->
      <div id="tcAddModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:var(--card-bg);border-radius:12px;padding:24px;width:340px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,0.3)">
          <h3 style="margin-bottom:16px;font-size:16px">Add Shift / Leave</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div>
              <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Person</label>
              <select id="tcAddColleague" class="form-control"></select>
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Date</label>
              <input type="date" id="tcAddDate" class="form-control" />
            </div>
            <div>
              <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Type</label>
              <select id="tcAddType" class="form-control">
                <option value="shift">Shift</option>
                <option value="leave">Annual Leave</option>
                <option value="all_day">All Day</option>
              </select>
            </div>
            <div id="tcAddTimesRow" style="display:flex;gap:8px">
              <div style="flex:1">
                <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Start</label>
                <input type="time" id="tcAddStart" class="form-control" value="09:00" />
              </div>
              <div style="flex:1">
                <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">End</label>
                <input type="time" id="tcAddEnd" class="form-control" value="17:00" />
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:18px">
            <button class="btn btn-primary" id="tcAddSaveBtn" style="flex:1">Save</button>
            <button class="btn btn-ghost" id="tcAddCancelBtn">Cancel</button>
          </div>
        </div>
      </div>

    `;

    document.querySelectorAll('.import-tab[data-tc]').forEach(btn =>
      btn.addEventListener('click', async () => {
        this.activeTab = btn.dataset.tc;
        document.querySelectorAll('.import-tab[data-tc]').forEach(b =>
          b.classList.toggle('active', b.dataset.tc === this.activeTab));
        await this.loadActiveTab();
      })
    );

    // Modal type toggle — hide times for leave/all_day
    document.getElementById('tcAddType').addEventListener('change', () => {
      const t = document.getElementById('tcAddType').value;
      document.getElementById('tcAddTimesRow').style.display = t === 'shift' ? 'flex' : 'none';
    });
    document.getElementById('tcAddCancelBtn').addEventListener('click', () => this._closeAddModal());
    document.getElementById('tcAddModal').addEventListener('click', e => {
      if (e.target === document.getElementById('tcAddModal')) this._closeAddModal();
    });
    document.getElementById('tcAddSaveBtn').addEventListener('click', () => this._saveNewShift());

  },

  async loadActiveTab() {
    if (this.activeTab === 'week')   await this.loadWeek();
    else                             await this.loadPerson();
  },

  // ── Add Shift Modal helpers ────────────────────────────────────────────────

  _openAddModal(prefillDate, prefillColleagueId) {
    // Populate colleagues
    const sel = document.getElementById('tcAddColleague');
    const cols = this._cachedColleagues || [];
    sel.innerHTML = cols.map(c =>
      `<option value="${c.id}" ${String(c.id)===String(prefillColleagueId)?'selected':''}>${c.name}</option>`
    ).join('');
    if (prefillDate) document.getElementById('tcAddDate').value = prefillDate;
    document.getElementById('tcAddType').value = 'shift';
    document.getElementById('tcAddTimesRow').style.display = 'flex';
    document.getElementById('tcAddStart').value = '09:00';
    document.getElementById('tcAddEnd').value   = '17:00';
    const modal = document.getElementById('tcAddModal');
    modal.style.display = 'flex';
  },

  _closeAddModal() {
    document.getElementById('tcAddModal').style.display = 'none';
  },

  async _saveNewShift() {
    const colleague_id = document.getElementById('tcAddColleague').value;
    const date         = document.getElementById('tcAddDate').value;
    const shift_type   = document.getElementById('tcAddType').value;
    const start_time   = document.getElementById('tcAddStart').value || null;
    const end_time     = document.getElementById('tcAddEnd').value   || null;
    if (!colleague_id || !date) return showToast('Select a person and date', 'error');
    if (shift_type === 'shift' && (!start_time || !end_time)) return showToast('Enter start and end times', 'error');
    try {
      await API.addColleagueShift({ colleague_id, date, shift_type, start_time, end_time });
      this._closeAddModal();
      showToast('Shift added');
      await this.loadActiveTab();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async _exportAllCSV() {
    try {
      const { shifts, colleagues } = await API.getAllColleagueShifts();
      const nameById = {};
      for (const c of (colleagues || [])) nameById[c.id] = c.name;
      const rows = [['name', 'date', 'start_time', 'end_time', 'type']];
      for (const s of (shifts || [])) {
        const name  = nameById[s.colleague_id] || s.colleague_id;
        const start = s.shift_type === 'shift' ? (s.start_time || '') : '';
        const end   = s.shift_type === 'shift' ? (s.end_time   || '') : '';
        rows.push([name, s.date, start, end, s.shift_type || 'shift']);
      }
      const csv  = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = 'team-schedule-all-time.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { showToast('Export failed: ' + e.message, 'error'); }
  },

  async _deleteShift(id) {
    if (!confirm('Delete this shift entry?')) return;
    try {
      await API.deleteColleagueShift(id);
      showToast('Deleted');
      await this.loadActiveTab();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },


  async _bulkDeleteSelected() {
    const checked = [...document.querySelectorAll('.tc-shift-cb:checked')];
    if (!checked.length) return showToast('No shifts selected', 'error');
    if (!confirm(`Delete ${checked.length} selected shift${checked.length !== 1 ? 's' : ''}?`)) return;
    const ids = checked.map(cb => parseInt(cb.dataset.id, 10));
    try {
      const { deleted } = await API.bulkDeleteColleagueShifts(ids);
      showToast(`Deleted ${deleted} shift${deleted !== 1 ? 's' : ''}`);
      await this.loadActiveTab();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  _onBulkCbChange() {
    const all = document.querySelectorAll('.tc-shift-cb');
    const checked = [...all].filter(cb => cb.checked);
    const bar = document.getElementById('tcBulkBar');
    const count = document.getElementById('tcBulkCount');
    if (bar) bar.style.display = checked.length ? 'flex' : 'none';
    if (count) count.textContent = `${checked.length} shift${checked.length !== 1 ? 's' : ''} selected`;
  },

  _clearBulkSelection() {
    document.querySelectorAll('.tc-shift-cb').forEach(cb => { cb.checked = false; });
    const bar = document.getElementById('tcBulkBar');
    if (bar) bar.style.display = 'none';
  },

  async _deleteMonth(ids, label) {
    if (!ids.length) return showToast('No shifts to delete', 'error');
    if (!confirm(`Delete all ${ids.length} shift${ids.length !== 1 ? 's' : ''} in ${label}?`)) return;
    try {
      const { deleted } = await API.bulkDeleteColleagueShifts(ids);
      showToast(`Deleted ${deleted} shift${deleted !== 1 ? 's' : ''}`);
      await this.loadActiveTab();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async _deleteAllShiftsForMonth(month) {
    const label = new Date(month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!confirm(`Delete ALL imported shifts for ALL colleagues in ${label}?`)) return;
    try {
      const { deleted } = await API.deleteAllShiftsByMonth(month);
      showToast(`Deleted ${deleted} shift${deleted !== 1 ? 's' : ''} for ${label}`);
      await this.loadWeek();
    } catch (e) { showToast(e.message, 'error'); }
  },

  async _deleteAllShiftsEver() {
    if (!confirm('Delete ALL imported shifts for ALL colleagues? This cannot be undone.')) return;
    try {
      const { deleted } = await API.deleteAllColleagueShiftsEver();
      showToast(`Deleted ${deleted} shift${deleted !== 1 ? 's' : ''}`);
      await this.loadWeek();
    } catch (e) { showToast(e.message, 'error'); }
  },

  async _deleteColleagueMonth(colleagueId, name, month) {
    const label = new Date(month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!confirm(`Delete all shifts for ${name} in ${label}?`)) return;
    try {
      await API.deleteColleagueShiftsByMonth(colleagueId, month);
      showToast(`Deleted ${name}'s shifts for ${label}`);
      await this.loadWeek();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async _deleteAllForColleague(colleagueId, name) {
    if (!confirm(`Delete ALL imported shifts for ${name}? This cannot be undone.`)) return;
    try {
      await API.deleteAllColleagueShifts(colleagueId);
      showToast(`Deleted all shifts for ${name}`);
      await this.loadWeek();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async _clearColleagueWeek(colleagueId, week) {
    const name = (this._cachedColleagues || []).find(c => c.id === colleagueId)?.name || 'this person';
    if (!confirm(`Delete all shifts for ${name} in this week?`)) return;
    // Collect IDs from the rendered data
    const data = this._lastWeekData;
    if (!data) return;
    const days = Array.from({ length: 7 }, (_, i) => this._addDays(week, i));
    const shifts = (data.colShifts || []).filter(s => s.colleague_id === colleagueId && days.includes(s.date));
    if (!shifts.length) return showToast('No shifts to delete', 'error');
    try {
      const { deleted } = await API.bulkDeleteColleagueShifts(shifts.map(s => s.id));
      showToast(`Deleted ${deleted} shift${deleted !== 1 ? 's' : ''}`);
      await this.loadWeek();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  // ── Week View ──────────────────────────────────────────────────────────────

  async loadWeek() {
    const wrap = document.getElementById('tcTabContent');
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="tcPrevYear"  title="Back 1 year">&#171; Year</button>
        <button class="btn btn-ghost btn-sm" id="tcPrevMonth" title="Back 1 month">&#8592; Month</button>
        <button class="btn btn-ghost btn-sm" id="tcPrevWeek"  title="Back 1 week">&#8592; Week</button>
        <strong id="tcWeekLabel" style="min-width:200px;text-align:center;font-size:13px">${this._fmtWeekRange(this._currentWeek)}</strong>
        <button class="btn btn-ghost btn-sm" id="tcNextWeek"  title="Forward 1 week">Week &#8594;</button>
        <button class="btn btn-ghost btn-sm" id="tcNextMonth" title="Forward 1 month">Month &#8594;</button>
        <button class="btn btn-ghost btn-sm" id="tcNextYear"  title="Forward 1 year">Year &#187;</button>
        <button class="btn btn-ghost btn-sm" id="tcThisWeek">Today</button>
        <button class="btn btn-primary btn-sm" id="tcWkAddBtn" style="margin-left:auto">+ Add Shift</button>
        <button class="btn btn-ghost btn-sm" id="tcWkExportCSV">⬇ Export All CSV</button>
        <button class="btn btn-ghost btn-sm" id="tcWkDelMonth" style="color:var(--danger)">🗑 Month</button>
        <button class="btn btn-ghost btn-sm" id="tcWkDelAll" style="color:var(--danger)">🗑 All</button>
        <button class="btn btn-ghost btn-sm" id="tcWkRefresh">↻</button>
      </div>
      <div id="tcWeekGrid" style="overflow-x:auto"><p style="color:var(--text-muted)">Loading…</p></div>
    `;

    const jumpMonths = n => {
      const d = new Date(this._currentWeek + 'T00:00:00');
      d.setMonth(d.getMonth() + n);
      this._currentWeek = this._mondayOf(d);
      this.loadWeek();
    };
    document.getElementById('tcPrevYear') .addEventListener('click', () => jumpMonths(-12));
    document.getElementById('tcPrevMonth').addEventListener('click', () => jumpMonths(-1));
    document.getElementById('tcPrevWeek') .addEventListener('click', () => { this._currentWeek = this._addDays(this._currentWeek, -7);  this.loadWeek(); });
    document.getElementById('tcNextWeek') .addEventListener('click', () => { this._currentWeek = this._addDays(this._currentWeek,  7);  this.loadWeek(); });
    document.getElementById('tcNextMonth').addEventListener('click', () => jumpMonths(1));
    document.getElementById('tcNextYear') .addEventListener('click', () => jumpMonths(12));
    document.getElementById('tcThisWeek').addEventListener('click', () => {
      const now = new Date();
      this._currentWeek = this._mondayOf(now);
      this.loadWeek();
    });
    document.getElementById('tcWkRefresh').addEventListener('click', () => this.loadWeek());
    document.getElementById('tcWkExportCSV').addEventListener('click', () => this._exportAllCSV());
    document.getElementById('tcWkDelMonth').addEventListener('click', () => this._deleteAllShiftsForMonth(this._currentWeek.slice(0, 7)));
    document.getElementById('tcWkDelAll').addEventListener('click', () => this._deleteAllShiftsEver());
    document.getElementById('tcWkAddBtn').addEventListener('click', () => {
      this._openAddModal(this._currentWeek, this._cachedColleagues && this._cachedColleagues[0] && this._cachedColleagues[0].id);
    });

    try {
      const data = await API.getTeamWeek(this._currentWeek);
      // Cache for add modal and bulk delete
      this._cachedColleagues = data.colleagues || [];
      this._lastWeekData = data;
      this._renderWeekGrid(data);
    } catch (e) {
      document.getElementById('tcWeekGrid').innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  _renderWeekGrid(data) {
    const { from, myName, myShifts, colleagues, colShifts } = data;
    const grid = document.getElementById('tcWeekGrid');
    if (!grid) return;

    // Build 7-day array: Mon … Sun
    const days = Array.from({ length: 7 }, (_, i) => this._addDays(from, i));
    const today = this._localDateStr(new Date());

    // Shift palette — cycle through a set of colours for colleagues
    const COLOURS = [
      '#3B82F6','#10B981','#8B5CF6','#F59E0B','#EF4444',
      '#06B6D4','#EC4899','#84CC16','#F97316','#6366F1'
    ];

    // Build row data: me first, then colleagues alphabetically
    const rows = [];

    // — My row —
    const myDayMap = {};
    for (const s of myShifts) {
      if (!myDayMap[s.date]) myDayMap[s.date] = [];
      myDayMap[s.date].push(s);
    }
    rows.push({ label: myName + ' ★', colour: '#1B2A4A', isMe: true, dayMap: myDayMap, contractHours: data.myContractHours || 0 });

    // — Colleague rows —
    colleagues.forEach((c, ci) => {
      const dayMap = {};
      for (const s of colShifts.filter(x => x.colleague_id === c.id)) {
        if (!dayMap[s.date]) dayMap[s.date] = [];
        dayMap[s.date].push(s);
      }
      rows.push({ label: c.name, colour: COLOURS[ci % COLOURS.length], isMe: false, id: c.id, dayMap, contractHours: c.contract_hours || 0 });
    });

    // ── Coverage gap detection ──
    // Combine my shifts + all colleague shifts per day, then scan for < 2 person slots
    const allShiftsByDay = {};
    for (const d of days) allShiftsByDay[d] = [];
    for (const s of myShifts)  { if (allShiftsByDay[s.date]) allShiftsByDay[s.date].push(s); }
    for (const s of colShifts) { if (allShiftsByDay[s.date]) allShiftsByDay[s.date].push(s); }
    const coverageByDay = {};
    for (const d of days) coverageByDay[d] = this._computeDayCoverage(d, allShiftsByDay[d]);

    // ── Column headers ──
    const headerCells = days.map(d => {
      const isToday = d === today;
      const gaps = coverageByDay[d] || [];
      const hasEmpty = gaps.some(g => g.minCount === 0);
      const hasLow   = gaps.length > 0 && !hasEmpty;
      const badge = hasEmpty
        ? `<div title="Nobody scheduled during part of trading hours" style="display:inline-block;background:#EF4444;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;margin-top:3px">🚫 gap</div>`
        : hasLow
        ? `<div title="Only 1 person scheduled during part of trading hours" style="display:inline-block;background:#F59E0B;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;margin-top:3px">⚠ low</div>`
        : '';
      return `<th style="
        padding:8px 6px;text-align:center;font-size:12px;font-weight:600;
        background:${isToday ? 'var(--primary)' : 'var(--bg)'};
        color:${isToday ? 'var(--primary-text)' : 'var(--text-muted)'};
        border-bottom:2px solid ${hasEmpty ? '#EF4444' : hasLow ? '#F59E0B' : 'var(--border)'};white-space:nowrap">
        ${this._fmtDay(d)}${badge}
      </th>`;
    }).join('');

    // ── Data rows ──
    const dataRows = rows.map(row => {
      const cells = days.map(d => {
        const shifts = row.dayMap[d] || [];
        const addBtn = row.isMe ? '' :
          `<button onclick="TeamCalendarView._openAddModal('${d}',${row.id})"
            style="display:block;width:100%;background:none;border:1px dashed var(--border);border-radius:6px;
            color:var(--text-muted);font-size:11px;padding:3px;cursor:pointer;margin-top:${shifts.length?'4px':'0'}"
            title="Add shift">+ add</button>`;
        if (!shifts.length) {
          return `<td style="border:1px solid var(--border);padding:5px;background:var(--bg);min-height:50px;vertical-align:top">${addBtn}</td>`;
        }
        const blocks = shifts.map(s => {
          const delBtn = row.isMe ? '' :
            `<button onclick="TeamCalendarView._deleteShift(${s.id})"
              style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.25);
              border:none;color:#fff;border-radius:50%;width:16px;height:16px;
              font-size:10px;line-height:1;cursor:pointer;padding:0"
              title="Delete">×</button>`;
          const editBtn = row.isMe ? '' :
            `<button onclick="TeamCalendarView._openEditShiftModal(${s.id},'${s.start_time}','${s.end_time}','${s.shift_type||'shift'}')"
              style="position:absolute;top:2px;right:20px;background:rgba(0,0,0,0.25);
              border:none;color:#fff;border-radius:50%;width:16px;height:16px;
              font-size:10px;line-height:1;cursor:pointer;padding:0"
              title="Edit">✎</button>`;
          if (s.shift_type === 'leave') {
            return `<div style="position:relative;background:#10B981;color:#fff;border-radius:6px;
              padding:5px 7px;margin-bottom:3px;font-size:11px;line-height:1.3;font-weight:600">
              🌴 Annual Leave${delBtn}</div>`;
          }
          if (s.shift_type === 'all_day') {
            return `<div style="position:relative;background:#F59E0B;color:#fff;border-radius:6px;
              padding:5px 7px;margin-bottom:3px;font-size:11px;line-height:1.3;font-weight:600">
              🏪 All Day${delBtn}</div>`;
          }
          return `<div style="position:relative;background:${row.colour};color:#fff;border-radius:6px;
            padding:5px 7px;margin-bottom:3px;font-size:11px;line-height:1.3">
            <div style="font-weight:700;padding-right:36px">${s.start_time} – ${s.end_time}</div>
            <div style="opacity:0.85">${this._fmtDuration(s.start_time, s.end_time)}</div>
            ${editBtn}${delBtn}</div>`;
        }).join('');
        return `<td style="border:1px solid var(--border);padding:5px;vertical-align:top">${blocks}${addBtn}</td>`;
      }).join('');

      const nameBg = row.isMe ? 'var(--sidebar-bg)' : 'var(--bg)';
      const nameFg = row.isMe ? '#fff' : 'var(--text)';
      const totalMins = Object.values(row.dayMap).flat().reduce((acc, s) => {
        if (s.shift_type === 'leave' || s.shift_type === 'all_day') return acc;
        const gross = this._toMins(s.end_time) - this._toMins(s.start_time);
        if (gross <= 0) return acc;
        return acc + gross - this._breakMins(s.start_time, s.end_time);
      }, 0);
      const totalH = Math.floor(totalMins / 60);
      const totalM = totalMins % 60;
      const totalStr = totalMins > 0 ? `${totalH}h${totalM ? ' ' + totalM + 'm' : ''}` : '0h';

      // Contract hours cell
      let contractCell = `<td style="border:1px solid var(--border);padding:6px 8px;text-align:center;white-space:nowrap;vertical-align:middle"></td>`;
      if (row.contractHours > 0 || !row.isMe) {
        const contract = row.contractHours || 0;
        const diff = totalMins / 60 - contract;
        const diffStr = diff === 0 ? 'on contract'
          : diff > 0 ? `+${diff.toFixed(1).replace(/\.0$/,'')}h over`
          : `${diff.toFixed(1).replace(/\.0$/,'')}h under`;
        const diffCol = diff > 0 ? '#10B981' : diff < 0 ? '#EF4444' : 'var(--text-muted)';
        contractCell = `
          <td style="border:1px solid var(--border);padding:6px 8px;text-align:center;white-space:nowrap;vertical-align:middle">
            <div style="font-size:12px;font-weight:600">${totalStr}</div>
            ${contract > 0 ? `<div style="font-size:10px;color:var(--text-muted)">${contract}h contract</div>
            <div style="font-size:10px;color:${diffCol};font-weight:600">${diffStr}</div>` : ''}
          </td>`;
      }

      return `
        <tr>
          <td style="
            padding:8px 10px;background:${nameBg};color:${nameFg};
            font-weight:${row.isMe?700:500};font-size:13px;
            white-space:nowrap;border:1px solid var(--border);
            position:sticky;left:0;z-index:2">
            ${row.label}
            ${!row.isMe ? `<div style="display:flex;gap:3px;margin-top:4px;flex-wrap:wrap">
              <button onclick="TeamCalendarView._clearColleagueWeek(${row.id},'${this._currentWeek}')"
                style="background:none;border:1px solid var(--border);border-radius:4px;
                color:var(--text-muted);font-size:10px;padding:1px 5px;cursor:pointer;white-space:nowrap"
                title="Delete all shifts for this person this week">clear week</button>
              <button onclick="TeamCalendarView._deleteColleagueMonth(${row.id},'${row.label}','${this._currentWeek.slice(0,7)}')"
                style="background:none;border:1px solid var(--border);border-radius:4px;
                color:var(--text-muted);font-size:10px;padding:1px 5px;cursor:pointer;white-space:nowrap"
                title="Delete all shifts for this person this month">del month</button>
              <button onclick="TeamCalendarView._deleteAllForColleague(${row.id},'${row.label}')"
                style="background:none;border:1px solid var(--border);border-radius:4px;
                color:var(--text-muted);font-size:10px;padding:1px 5px;cursor:pointer;white-space:nowrap"
                title="Delete ALL shifts ever for this person">delete all</button>
            </div>` : ''}
          </td>
          ${contractCell}
          ${cells}
        </tr>`;
    }).join('');

    if (!colleagues.length) {
      grid.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:24px">
        Add colleagues in the <strong>Leaderboard</strong> tab, then import a Team screenshot to populate the grid.
      </p>`;
      return;
    }

    // ── Coverage summary panel ──
    const gapDays = days.filter(d => (coverageByDay[d] || []).length > 0);
    let coveragePanel = '';
    if (gapDays.length) {
      const fmtDay = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const rows = gapDays.map(d => {
        const gaps = coverageByDay[d];
        const hasEmpty = gaps.some(g => g.minCount === 0);
        const icon = hasEmpty ? '🚫' : '⚠️';
        const colour = hasEmpty ? '#EF4444' : '#F59E0B';
        const gapList = gaps.map(g => {
          const label = g.minCount === 0 ? 'nobody' : '1 person';
          return `<span style="display:inline-block;background:${colour}22;border:1px solid ${colour}55;
            border-radius:4px;padding:1px 6px;font-size:11px;margin-right:4px;white-space:nowrap">
            ${this._minsToTime(g.fromMins)}–${this._minsToTime(g.toMins)}
            <span style="color:${colour};font-weight:600">${label}</span>
          </span>`;
        }).join('');
        return `<div style="display:flex;align-items:flex-start;gap:10px;padding:7px 0;
          border-bottom:1px solid var(--border);flex-wrap:wrap">
          <span style="font-size:13px;white-space:nowrap;min-width:90px;font-weight:600">${icon} ${fmtDay(d)}</span>
          <div>${gapList}</div>
        </div>`;
      }).join('');
      coveragePanel = `
        <div style="margin-top:16px;padding:14px 16px;background:var(--bg);border-radius:10px;
          border:1px solid var(--border)">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px">
            Coverage gaps
            <span style="font-size:11px;font-weight:400;color:var(--text-muted)">
              trading hours (Sun from 08:45, other days from 06:45) · fewer than 2 people
            </span>
          </div>
          ${rows}
        </div>`;
    }

    this._lastRenderMobile = this._isMobile();
    if (this._lastRenderMobile) {
      this._renderWeekStacked({ grid, days, rows, coverageByDay, today, coveragePanel });
      return;
    }

    grid.innerHTML = `
      <table class="tc-week-table" style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr>
            <th style="position:sticky;left:0;z-index:3;background:var(--bg);padding:8px 10px;
              border-bottom:2px solid var(--border);text-align:left">Person</th>
            <th style="background:var(--bg);padding:8px 6px;border-bottom:2px solid var(--border);
              text-align:center;font-size:12px;color:var(--text-muted)">Hours</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>${dataRows}</tbody>
      </table>
      ${coveragePanel}`;
  },

  // ── Week View — mobile day-stacked layout ───────────────────────────────────
  _renderWeekStacked({ grid, days, rows, coverageByDay, today, coveragePanel }) {
    const firstColId = (this._cachedColleagues && this._cachedColleagues[0] && this._cachedColleagues[0].id) || null;

    const dayBlocks = days.map(d => {
      const isToday  = d === today;
      const gaps     = coverageByDay[d] || [];
      const hasEmpty = gaps.some(g => g.minCount === 0);
      const hasLow   = gaps.length > 0 && !hasEmpty;
      const badge = hasEmpty
        ? `<span style="background:#EF4444;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 7px">🚫 gap</span>`
        : hasLow
        ? `<span style="background:#F59E0B;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 7px">⚠ low</span>`
        : '';

      const peopleRows = rows.map(row => {
        const shifts = row.dayMap[d] || [];
        if (!shifts.length) return '';
        return shifts.map(s => {
          let label;
          if (s.shift_type === 'leave')        label = '🌴 Annual Leave';
          else if (s.shift_type === 'all_day') label = '🏪 All Day';
          else label = `<strong>${s.start_time}–${s.end_time}</strong> <span style="opacity:.7;font-size:11px">${this._fmtDuration(s.start_time, s.end_time)}</span>`;
          const editDel = row.isMe ? '' :
            `<span style="margin-left:auto;display:inline-flex;gap:6px;flex-shrink:0">
               <button onclick="TeamCalendarView._openEditShiftModal(${s.id},'${s.start_time}','${s.end_time}','${s.shift_type||'shift'}')"
                 style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);font-size:13px;padding:2px 8px;cursor:pointer">✎</button>
               <button onclick="TeamCalendarView._deleteShift(${s.id})"
                 style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--danger);font-size:13px;padding:2px 8px;cursor:pointer">×</button>
             </span>`;
          return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--border)">
                    <span style="width:10px;height:10px;border-radius:50%;background:${row.colour};flex-shrink:0"></span>
                    <span style="font-weight:${row.isMe?700:500};font-size:13px">${row.label.replace(' ★','')}${row.isMe?' ★':''}</span>
                    <span style="font-size:13px">${label}</span>
                    ${editDel}
                  </div>`;
        }).join('');
      }).filter(Boolean).join('');

      const addBtn = `<button onclick="TeamCalendarView._openAddModal('${d}',${firstColId})"
        style="margin-top:8px;width:100%;background:none;border:1px dashed var(--border);border-radius:8px;
        color:var(--text-muted);font-size:13px;padding:9px;cursor:pointer">+ add shift</button>`;

      return `
        <div style="border:1px solid ${hasEmpty?'#EF4444':hasLow?'#F59E0B':'var(--border)'};border-radius:10px;margin-bottom:10px;overflow:hidden">
          <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;
                      background:${isToday?'var(--primary)':'var(--bg)'};
                      color:${isToday?'var(--primary-text)':'var(--text)'};font-weight:700;font-size:13px">
            ${this._fmtDay(d)} ${badge}
          </div>
          <div style="padding:2px 12px 12px">
            ${peopleRows || '<div style="padding:8px 0;color:var(--text-muted);font-size:13px">No one scheduled</div>'}
            ${addBtn}
          </div>
        </div>`;
    }).join('');

    grid.innerHTML = dayBlocks + (coveragePanel || '');
  },

  // ── Person View ────────────────────────────────────────────────────────────

  async loadPerson() {
    const wrap = document.getElementById('tcTabContent');
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        <select id="tcColleagueSelect" style="min-width:160px">
          <option value="">— Select a person —</option>
        </select>
        <input type="date" id="tcFrom" value="${this._personFrom}" style="width:140px" />
        <span style="color:var(--text-muted)">to</span>
        <input type="date" id="tcTo" value="${this._personTo}" style="width:140px" />
        <button class="btn btn-primary" id="tcLoadBtn">Load</button>
        <button class="btn btn-ghost" id="tcPersonAddBtn" style="margin-left:auto">+ Add Shift</button>
      </div>
      <div id="tcWeeklyWrap"></div>
      <div id="tcShiftListWrap"></div>
    `;

    document.getElementById('tcLoadBtn').addEventListener('click', async () => {
      this._selectedId  = document.getElementById('tcColleagueSelect').value || null;
      let from = document.getElementById('tcFrom').value;
      let to   = document.getElementById('tcTo').value;
      // Cap range to 120 days to prevent the grid going off-screen
      if (from && to) {
        const fromMs = new Date(from + 'T00:00:00').getTime();
        const toMs   = new Date(to   + 'T00:00:00').getTime();
        if ((toMs - fromMs) / 86400000 > 120) {
          const capped = new Date(fromMs + 120 * 86400000);
          to = this._localDateStr(capped);
          document.getElementById('tcTo').value = to;
          showToast('Date range capped at 120 days', 'warning');
        }
      }
      this._personFrom  = from;
      this._personTo    = to;
      await this._fetchPerson();
    });

    document.getElementById('tcPersonAddBtn').addEventListener('click', () => {
      this._openAddModal(this._personFrom, this._selectedId);
    });

    await this._fetchPerson();
  },

  async _fetchPerson() {
    try {
      const params = {};
      if (this._selectedId) params.colleagueId = this._selectedId;
      if (this._personFrom) params.from = this._personFrom;
      if (this._personTo)   params.to   = this._personTo;
      if (this._importSource && this._importSource !== 'all') params.importSource = this._importSource;

      const { colleagues, shifts, weeklyHours } = await API.getTeamCalendar(params);
      // Cache for the add modal
      this._cachedColleagues = colleagues;

      // Populate select
      const sel = document.getElementById('tcColleagueSelect');
      if (sel) {
        const cur = this._selectedId;
        const active = colleagues.filter(c => !c.left_date);
        const past   = colleagues.filter(c =>  c.left_date);
        sel.innerHTML = '<option value="">— Select a person —</option>' +
          active.map(c => `<option value="${c.id}" ${String(c.id)===String(cur)?'selected':''}>${c.name}</option>`).join('') +
          (past.length ? `<optgroup label="Past employees">${past.map(c => `<option value="${c.id}" ${String(c.id)===String(cur)?'selected':''}>${c.name} (left)</option>`).join('')}</optgroup>` : '');
      }

      const weekly = document.getElementById('tcWeeklyWrap');
      const list   = document.getElementById('tcShiftListWrap');
      if (!this._selectedId) {
        if (weekly) weekly.innerHTML = '';
        if (list)   list.innerHTML   = '<p style="color:var(--text-muted)">Select a person to view their schedule.</p>';
        return;
      }
      if (!shifts.length) {
        if (weekly) weekly.innerHTML = '';
        if (list)   list.innerHTML   = '<p style="color:var(--text-muted)">No shifts found in this date range.</p>';
        return;
      }
      if (weeklyHours.length && weekly) this._renderWeeklyBars(weeklyHours, weekly);
      if (list) this._renderShiftList(shifts, list);
    } catch (e) {
      const list = document.getElementById('tcShiftListWrap');
      if (list) list.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`;
    }
  },

  _renderWeeklyBars(weeklyHours, wrap) {
    const maxH = Math.max(...weeklyHours.map(w => w.hours), 1);
    const bars = weeklyHours.map(w => {
      const pct = (w.hours / maxH * 100).toFixed(1);
      const label = new Date(w.week + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' });
      return `
        <div style="display:flex;flex-direction:column;align-items:center;min-width:44px">
          <span style="font-size:11px;color:var(--text-muted);margin-bottom:2px">${w.hours}h</span>
          <div style="width:36px;background:var(--border);border-radius:4px 4px 0 0;height:60px;display:flex;align-items:flex-end;overflow:hidden">
            <div style="width:100%;background:var(--primary);height:${pct}%;border-radius:4px 4px 0 0"></div>
          </div>
          <span style="font-size:10px;color:var(--text-muted);margin-top:3px;text-align:center">${label}</span>
        </div>`;
    }).join('');
    wrap.innerHTML = `
      <div class="card" style="padding:16px;margin-bottom:12px">
        <h3 style="font-size:14px;margin-bottom:12px;font-weight:600">Weekly Hours</h3>
        <div style="display:flex;gap:6px;align-items:flex-end;overflow-x:auto;padding-bottom:4px">${bars}</div>
      </div>`;
  },

  _renderShiftList(shifts, wrap) {
    const fmtMonth = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month:'long', year:'numeric' });
    const fmtDate  = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
    const fmtDateShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' });
    const calcH = s => {
      const gross = this._toMins(s.end_time) - this._toMins(s.start_time);
      if (gross <= 0) return '';
      const brk = this._breakMins(s.start_time, s.end_time);
      const net = gross - brk;
      const h = Math.floor(net/60), m = net%60;
      const netStr = m ? h + 'h ' + m + 'm' : h + 'h';
      return brk > 0 ? netStr + ' <span style="color:var(--text-muted);font-size:12px">🍵' + brk + 'm</span>' : netStr;
    };
    const daysBetween = (a, b) => {
      const msA = new Date(a + 'T00:00:00').getTime(), msB = new Date(b + 'T00:00:00').getTime();
      return Math.round((msB - msA) / 86400000);
    };

    // Merge consecutive leave days within the sorted shifts array
    const mergeLeave = arr => {
      const out = [];
      let i = 0;
      while (i < arr.length) {
        const s = arr[i];
        if (s.shift_type === 'leave') {
          let j = i + 1;
          while (j < arr.length && arr[j].shift_type === 'leave' && daysBetween(arr[j-1].date, arr[j].date) === 1) j++;
          // Keep individual IDs for deletion (first in run)
          out.push({ ...s, _leaveEnd: arr[j-1].date, _leaveCount: j - i, _leaveIds: arr.slice(i, j).map(x => x.id) });
          i = j;
        } else {
          out.push(s);
          i++;
        }
      }
      return out;
    };

    const byMonth = {};
    for (const s of shifts) {
      const m = s.date.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(s);
    }

    // Bulk-action bar (rendered before month cards)
    const bulkBar = `
      <div id="tcBulkBar" style="display:none;align-items:center;gap:10px;padding:10px 12px;
        background:var(--primary);border-radius:8px;margin-bottom:12px;color:var(--primary-text)">
        <span id="tcBulkCount" style="font-size:13px;font-weight:600"></span>
        <button onclick="TeamCalendarView._bulkDeleteSelected()" class="btn btn-ghost"
          style="background:rgba(255,255,255,0.15);color:var(--primary-text);font-size:12px;padding:4px 10px">
          🗑 Delete selected
        </button>
        <button onclick="TeamCalendarView._clearBulkSelection()" class="btn btn-ghost"
          style="background:none;color:var(--primary-text);font-size:12px;padding:4px 8px;margin-left:auto">
          ✕ Clear selection
        </button>
      </div>`;

    wrap.innerHTML = bulkBar + Object.entries(byMonth).sort().map(([month, mShifts]) => {
      const totalMins = mShifts.reduce((a, s) => { const g = this._toMins(s.end_time)-this._toMins(s.start_time); return g > 0 ? a + g - this._breakMins(s.start_time, s.end_time) : a; }, 0);
      const th = Math.floor(totalMins/60), tm = totalMins%60;
      const merged = mergeLeave(mShifts);
      const rows = merged.map(s => {
        const delCell = (id, extraIds) => {
          const allIds = extraIds ? [...new Set([id, ...extraIds])] : [id];
          return `<td style="padding:8px 6px;text-align:right;white-space:nowrap">
            <input type="checkbox" class="tc-shift-cb" data-id="${allIds[0]}"
              style="margin-right:6px;cursor:pointer;accent-color:var(--primary)"
              onchange="TeamCalendarView._onBulkCbChange()" />
            <button onclick="TeamCalendarView._deleteShift(${id})"
              style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px"
              title="Delete">×</button>
          </td>`;
        };

        if (s.shift_type === 'leave') {
          const label = s._leaveCount > 1
            ? '🌴 Annual Leave: ' + fmtDateShort(s.date) + ' – ' + fmtDateShort(s._leaveEnd) + ' (' + s._leaveCount + ' days)'
            : '🌴 Annual Leave';
          return '<tr style="border-bottom:1px solid var(--border)">' +
            '<td style="padding:8px 12px;white-space:nowrap">' + (s._leaveCount > 1 ? '' : fmtDate(s.date)) + '</td>' +
            '<td style="padding:8px 12px;color:#10B981;font-size:13px;font-weight:600" colspan="' + (s._leaveCount > 1 ? '2' : '1') + '">' + label + '</td>' +
            (s._leaveCount > 1 ? '' : '<td style="padding:8px 12px"></td>') +
            delCell(s._leaveIds ? s._leaveIds[0] : s.id, s._leaveIds) +
            '</tr>';
        }
        return '<tr style="border-bottom:1px solid var(--border)">' +
          '<td style="padding:8px 12px;white-space:nowrap">' + fmtDate(s.date) + '</td>' +
          '<td style="padding:8px 12px;color:var(--text-muted);font-size:13px">' + s.start_time + ' - ' + s.end_time + '</td>' +
          '<td style="padding:8px 12px;font-weight:500;text-align:right">' + calcH(s) + '</td>' +
          delCell(s.id) +
          '</tr>';
      }).join('');
      const shiftCount = mShifts.filter(s => s.shift_type !== 'leave').length;
      const monthIds = mShifts.map(s => s.id).filter(Boolean);
      const monthIdsJson = JSON.stringify(monthIds);
      return '<div class="card" style="margin-bottom:12px;overflow:hidden">' +
        '<div style="padding:12px 16px;background:var(--sidebar-bg);display:flex;justify-content:space-between;align-items:center">' +
          '<span style="color:#fff;font-weight:600">' + fmtMonth(month) + '</span>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="color:rgba(255,255,255,0.6);font-size:13px">' + shiftCount + ' shift' + (shiftCount !== 1 ? 's' : '') + (totalMins > 0 ? ' \xb7 ' + th + 'h' + (tm ? ' ' + tm + 'm' : '') : '') + '</span>' +
            '<button onclick="TeamCalendarView._deleteMonth(' + monthIdsJson + ',\'' + fmtMonth(month) + '\')"' +
              ' style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);' +
              'border-radius:5px;color:rgba(255,255,255,0.75);font-size:11px;padding:2px 8px;cursor:pointer"' +
              ' title="Delete all shifts in this month">\u{1F5D1}\u{FE0F} Delete month</button>' +
          '</div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>' + rows + '</tbody></table>' +
      '</div>';
    }).join('');
  },

  _openEditShiftModal(id, startTime, endTime, shiftType) {
    const typeOpts = ['shift','leave','all_day'].map(t =>
      `<option value="${t}" ${shiftType===t?'selected':''}>${t==='shift'?'Shift':t==='leave'?'Annual Leave':'All Day'}</option>`
    ).join('');
    const html = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Type</label>
          <select id="tcEditType" class="form-control">${typeOpts}</select>
        </div>
        <div id="tcEditTimesRow" style="display:${shiftType!=='shift'?'none':'flex'};gap:8px">
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">Start</label>
            <input type="time" id="tcEditStart" class="form-control" value="${startTime}" />
          </div>
          <div style="flex:1">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:3px">End</label>
            <input type="time" id="tcEditEnd" class="form-control" value="${endTime}" />
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:18px">
        <button class="btn btn-primary" id="tcEditSaveBtn" style="flex:1">Save</button>
        <button class="btn btn-ghost" id="tcEditCancelBtn">Cancel</button>
      </div>`;
    Modal.open('Edit Shift', html);
    document.getElementById('tcEditType').addEventListener('change', () => {
      document.getElementById('tcEditTimesRow').style.display =
        document.getElementById('tcEditType').value === 'shift' ? 'flex' : 'none';
    });
    document.getElementById('tcEditCancelBtn').addEventListener('click', () => Modal.close());
    document.getElementById('tcEditSaveBtn').addEventListener('click', async () => {
      const shift_type = document.getElementById('tcEditType').value;
      const start_time = document.getElementById('tcEditStart').value || null;
      const end_time   = document.getElementById('tcEditEnd').value   || null;
      if (shift_type === 'shift' && (!start_time || !end_time))
        return showToast('Enter start and end times', 'error');
      try {
        await API.updateColleagueShift(id, { shift_type, start_time, end_time });
        Modal.close();
        showToast('Shift updated');
        await this.loadActiveTab();
      } catch (e) { showToast(e.message, 'error'); }
    });
  },
};
