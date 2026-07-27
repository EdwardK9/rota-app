/* ─── Leave Tracker View ─────────────────────────────────────────────────── */

const LeaveView = {
  entries:  [],
  settings: {},
  bankHols: new Set(),
  lyYear:   null,
  lyStart:  '',
  lyEnd:    '',

  async init() {
    try {
      this.settings = await API.getSettings();
    } catch(e) {
      this.settings = {};
    }
    this._setDefaultYear(); // always recalculate so settings changes take effect
    this.render();
    await this.load();
  },

  // ── Leave year window ──────────────────────────────────────────────────────
  _setDefaultYear() {
    const leaveYearStart = this.settings.leave_year_start || '04-01';
    const [lm, ld] = leaveYearStart.split('-').map(Number);
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), lm - 1, ld);
    this.lyYear = now >= cutoff ? now.getFullYear() : now.getFullYear() - 1;
  },

  _updateWindow() {
    const lys = this.settings.leave_year_start || '04-01';
    this.lyStart = `${this.lyYear}-${lys}`;
    this.lyEnd   = `${this.lyYear + 1}-${lys}`;
  },

  // ── Entitlement in hours ───────────────────────────────────────────────────
  // Uses the new `annual_leave_hours` setting if set; otherwise falls back to
  // `annual_leave_entitlement` (days) × `hours_per_day`.
  _entitlementHours() {
    const perYearKey = `leave_entitlement_${this.lyYear}`;
    const hpd = parseFloat(this.settings.hours_per_day || 7.4);

    // Per-year override (hours-based key takes priority, then legacy days key)
    const perYearHrs  = parseFloat(this.settings[`leave_hours_${this.lyYear}`]);
    const perYearDays = parseFloat(this.settings[perYearKey]);
    if (!isNaN(perYearHrs) && perYearHrs > 0)  return perYearHrs;
    if (!isNaN(perYearDays) && perYearDays > 0) return round2(perYearDays * hpd);

    // No per-year key set — return 0 (user should set via Set Entitlement button)
    return 0;
  },

  _hpd() {
    return parseFloat(this.settings.hours_per_day || 7.4);
  },

  // ── Render shell ──────────────────────────────────────────────────────────
  render() {
    const el = document.getElementById('view-leave');
    el.innerHTML = `
      <div class="toolbar">
        <div class="month-nav" style="gap:8px;align-items:center">
          <label style="margin:0;font-weight:500;font-size:13px">Leave year:</label>
          <button class="btn btn-ghost btn-sm" id="lyPrev">&#8249;</button>
          <span id="lyLabel" style="min-width:70px;text-align:center;font-weight:600"></span>
          <button class="btn btn-ghost btn-sm" id="lyNext">&#8250;</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-ghost btn-sm" id="setEntitlementBtn" title="Set holiday entitlement for this year">🎯 Set Entitlement</button>
          <button class="btn btn-primary" id="addLeaveBtn">+ Log Leave</button>
        </div>
      </div>

      <div class="stats-grid" id="leaveStats"></div>

      <div class="card" style="margin-bottom:24px">
        <div class="card-body" id="leaveProgressBody"></div>
      </div>

      <div class="report-section">
        <h3 id="leaveTableTitle">Leave Entries</h3>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Hours</th>
                <th>Type</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="leaveTbody">
              <tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('addLeaveBtn').addEventListener('click', () => this.openAddModal());
    document.getElementById('setEntitlementBtn').addEventListener('click', () => this.openEntitlementModal());
    document.getElementById('lyPrev').addEventListener('click', () => { this.lyYear--; this._updateWindow(); this._refreshYear(); });
    document.getElementById('lyNext').addEventListener('click', () => { this.lyYear++; this._updateWindow(); this._refreshYear(); });
  },

  _refreshYear() {
    const lys = this.settings.leave_year_start || '04-01';
    const isCalendarYear = lys === '01-01';
    const label = isCalendarYear
      ? String(this.lyYear)
      : `${this.lyYear}/${String(this.lyYear + 1).slice(-2)}`;
    document.getElementById('lyLabel').textContent = label;
    this._renderFromEntries();
  },

  // ── Data load ─────────────────────────────────────────────────────────────
  async load() {
    try {
      this._updateWindow();
      [this.entries, this.bankHols] = await Promise.all([
        API.getLeave(),
        BankHols.load().catch(() => new Set()),
      ]);
      this._refreshYear();
    } catch(e) {
      showToast('Failed to load leave data: ' + e.message, 'error');
    }
  },

  // ── Render from cached entries ─────────────────────────────────────────────
  _renderFromEntries() {
    const yearEntries = this.entries.filter(
      e => e.start_date >= this.lyStart && e.start_date < this.lyEnd
    );

    const entitlement = this._entitlementHours();
    const hoursField  = e => e.hours_taken ?? e.days_taken ?? 0;   // compat shim

    const usedAnnual = yearEntries
      .filter(e => e.leave_type === 'annual')
      .reduce((s, e) => s + hoursField(e), 0);
    const usedOther  = yearEntries
      .filter(e => e.leave_type !== 'annual')
      .reduce((s, e) => s + hoursField(e), 0);
    const remaining  = round2(entitlement - usedAnnual);

    this.renderStats(entitlement, usedAnnual, usedOther, remaining);
    this.renderProgress(entitlement, usedAnnual, remaining);
    this.renderTable(yearEntries, hoursField);

    document.getElementById('leaveTableTitle').textContent =
      `Leave Entries — ${this.lyYear}/${this.lyYear + 1}`;
  },

  renderStats(entitlement, used, other, remaining) {
    const fmt = h => `${round2(h)}h`;
    document.getElementById('leaveStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Leave Year</div>
        <div class="stat-value" style="font-size:1rem">${this.lyYear}/${String(this.lyYear + 1).slice(-2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Entitlement</div>
        <div class="stat-value">${fmt(entitlement)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Used (annual)</div>
        <div class="stat-value warning">${fmt(used)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Remaining</div>
        <div class="stat-value ${remaining < (this._hpd() * 5) ? 'diff-neg' : 'success'}">${fmt(remaining)}</div>
      </div>
      ${other > 0 ? `
      <div class="stat-card">
        <div class="stat-label">Other leave</div>
        <div class="stat-value">${fmt(other)}</div>
      </div>` : ''}
    `;
  },

  renderProgress(entitlement, used, remaining) {
    const pct    = entitlement > 0 ? Math.min(100, (used / entitlement) * 100) : 0;
    const colour = pct < 30 ? 'var(--danger)' : pct < 65 ? 'var(--warning)' : 'var(--success)';
    document.getElementById('leaveProgressBody').innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">
        <span style="color:var(--text-muted)">Leave used</span>
        <span><strong>${round2(used)}h</strong> of <strong>${round2(entitlement)}h</strong> (${Math.round(pct)}%)</span>
      </div>
      <div class="leave-progress-track">
        <div class="leave-progress-bar" style="width:${pct}%;background:${colour}"></div>
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-muted)">${round2(remaining)}h remaining</div>
    `;
  },

  renderTable(yearEntries, hoursField) {
    hoursField = hoursField || (e => e.hours_taken ?? e.days_taken ?? 0);
    const tbody = document.getElementById('leaveTbody');
    if (!yearEntries.length) {
      tbody.innerHTML = `<tr><td colspan="5">
        <div class="empty-state">
          <div class="empty-state-icon">🏖️</div>
          <div class="empty-state-text">No leave recorded for ${this.lyYear}/${this.lyYear + 1}</div>
          <div class="empty-state-sub">Click "+ Log Leave" to add an entry</div>
        </div>
      </td></tr>`;
      return;
    }

    const sorted = [...yearEntries].sort((a, b) => b.start_date.localeCompare(a.start_date));
    const TYPES  = { annual: 'Annual', day_off: 'Day Off', sick: 'Sick', unpaid: 'Unpaid', other: 'Other' };

    tbody.innerHTML = sorted.map(e => {
      const hrs        = hoursField(e);
      const isSingle   = e.start_date === e.end_date;
      const dateLabel  = isSingle
        ? fmtDate(e.start_date)
        : `${fmtDate(e.start_date)} – ${fmtDate(e.end_date)}`;
      return `
        <tr data-id="${e.id}">
          <td>${dateLabel}</td>
          <td><strong>${round2(hrs)}h</strong></td>
          <td><span class="badge badge-${e.leave_type === 'annual' ? 'primary' : e.leave_type === 'day_off' ? 'success' : e.leave_type === 'sick' ? 'warning' : 'default'}">${TYPES[e.leave_type] || e.leave_type}</span></td>
          <td style="color:var(--text-muted)">${esc(e.notes || '—')}</td>
          <td class="actions">
            <button class="btn-icon edit-leave-btn"   title="Edit"   data-id="${e.id}">✏️</button>
            <button class="btn-icon danger delete-leave-btn" title="Delete" data-id="${e.id}">🗑️</button>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.edit-leave-btn').forEach(btn =>
      btn.addEventListener('click', () => this.openEditModal(+btn.dataset.id))
    );
    tbody.querySelectorAll('.delete-leave-btn').forEach(btn =>
      btn.addEventListener('click', () => this.deleteEntry(+btn.dataset.id))
    );
  },

  // ── Entitlement modal ─────────────────────────────────────────────────────
  openEntitlementModal() {
    const current = this._entitlementHours();
    const hpd     = this._hpd();
    Modal.open(`Set Entitlement — ${this.lyYear}/${this.lyYear + 1}`, `
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Enter your total holiday entitlement for this leave year in hours.
        Leave year: ${this.lyStart} → ${this.lyEnd}.
      </p>
      <div class="form-group">
        <label>Entitlement (hours) *</label>
        <input type="number" id="entHours" step="0.5" min="0" value="${current}" placeholder="e.g. 168" />
        <div class="form-hint" id="entDaysHint">${current ? `≈ ${round2(current / hpd)} days at ${hpd}h/day` : ''}</div>
      </div>
      <div class="form-group">
        <label>Hours per working day</label>
        <input type="number" id="entHpd" step="0.25" min="1" max="12" value="${hpd}" />
        <div class="form-hint">Used to auto-fill full-day leave hours</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="entSaveBtn">Save</button>
      </div>
    `);

    const updateHint = () => {
      const h   = parseFloat(document.getElementById('entHours').value);
      const hpd = parseFloat(document.getElementById('entHpd').value) || 7.4;
      document.getElementById('entDaysHint').textContent =
        h > 0 ? `≈ ${round2(h / hpd)} days at ${hpd}h/day` : '';
    };
    document.getElementById('entHours').addEventListener('input', updateHint);
    document.getElementById('entHpd').addEventListener('input', updateHint);

    document.getElementById('entSaveBtn').addEventListener('click', async () => {
      const hrs = parseFloat(document.getElementById('entHours').value);
      const hpd = parseFloat(document.getElementById('entHpd').value) || 7.4;
      if (isNaN(hrs) || hrs <= 0) { showToast('Enter a valid entitlement in hours', 'error'); return; }
      try {
        this.settings = await API.saveSettings({
          [`leave_hours_${this.lyYear}`]: String(hrs),
          hours_per_day: String(hpd),
        });
        Modal.close();
        showToast(`Entitlement set to ${hrs}h for ${this.lyYear}/${this.lyYear + 1} ✓`, 'success');
        this._renderFromEntries();
      } catch(e) { showToast(e.message, 'error'); }
    });
  },

  // ── Leave form ────────────────────────────────────────────────────────────
  leaveFormHtml(e = {}) {
    const isEdit   = !!e.id;
    const multiDay = isEdit && e.start_date !== e.end_date;
    const hrs      = e.hours_taken ?? e.days_taken ?? '';

    return `
      <div class="form-group">
        <label>${multiDay ? 'From date' : 'Date'} *</label>
        <input type="date" id="lfStart" value="${esc(e.start_date || '')}" />
      </div>

      <!-- Multi-day toggle -->
      <div class="form-group" style="margin-bottom:10px">
        <label class="toggle-label" style="font-size:13.5px">
          <input type="checkbox" id="lfMultiDay" style="width:16px;height:16px;accent-color:var(--primary);" ${multiDay ? 'checked' : ''} />
          <span>Multiple days</span>
        </label>
      </div>

      <div id="lfEndWrap" style="${multiDay ? '' : 'display:none'}">
        <div class="form-group">
          <label>To date *</label>
          <input type="date" id="lfEnd" value="${esc(e.end_date || e.start_date || '')}" />
        </div>
      </div>

      <div class="form-group" id="lfHoursWrap">
        <label>Hours taken *</label>
        <input type="number" id="lfHours" step="0.25" min="0.25" value="${hrs}" placeholder="Check your rota for the shift hours" />
        <div class="form-hint">Enter the hours shown on your rota for the day(s) off.</div>
      </div>

      <div class="form-group">
        <label>Leave type</label>
        <select id="lfType">
          <option value="annual"  ${e.leave_type === 'annual'  || !e.leave_type ? 'selected' : ''}>Annual leave</option>
          <option value="day_off" ${e.leave_type === 'day_off' ? 'selected' : ''}>Day off (swap — doesn't use allowance)</option>
          <option value="sick"    ${e.leave_type === 'sick'    ? 'selected' : ''}>Sick leave</option>
          <option value="unpaid"  ${e.leave_type === 'unpaid'  ? 'selected' : ''}>Unpaid leave</option>
          <option value="other"   ${e.leave_type === 'other'   ? 'selected' : ''}>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="lfNotes" rows="2">${esc(e.notes || '')}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()" tabindex="-1">Cancel</button>
        <button class="btn btn-primary" id="lfSaveBtn">Save</button>
      </div>`;
  },

  openAddModal() {
    Modal.open('Log Leave', this.leaveFormHtml({}));
    this.wireLeaveForm(null);
  },

  openEditModal(id) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    Modal.open('Edit Leave', this.leaveFormHtml(entry));
    this.wireLeaveForm(id);
  },

  wireLeaveForm(editId) {
    const isMultiDay = () => document.getElementById('lfMultiDay').checked;
    const getStart   = () => document.getElementById('lfStart').value;

    // ── Hours field visibility based on leave type ────────────────────────────
    const updateHoursVisibility = () => {
      const isDayOff = document.getElementById('lfType').value === 'day_off';
      document.getElementById('lfHoursWrap').style.display = isDayOff ? 'none' : '';
    };
    document.getElementById('lfType').addEventListener('change', updateHoursVisibility);
    updateHoursVisibility(); // set initial state

    // ── Multi-day toggle ──────────────────────────────────────────────────────
    document.getElementById('lfMultiDay').addEventListener('change', () => {
      const multi = isMultiDay();
      document.getElementById('lfEndWrap').style.display = multi ? '' : 'none';
      const lbl = document.getElementById('lfStart')?.closest('.form-group')?.querySelector('label');
      if (lbl) lbl.textContent = multi ? 'From date *' : 'Date *';
    });

    // Keep end date ≥ start date
    document.getElementById('lfStart').addEventListener('change', () => {
      const endEl = document.getElementById('lfEnd');
      if (endEl && endEl.value && endEl.value < getStart()) endEl.value = getStart();
    });

    document.getElementById('lfSaveBtn').addEventListener('click', () => this.saveLeaveForm(editId));
  },

  async saveLeaveForm(editId) {
    const start_date  = document.getElementById('lfStart').value;
    const end_date    = document.getElementById('lfMultiDay').checked
      ? (document.getElementById('lfEnd').value || start_date)
      : start_date;
    const leave_type  = document.getElementById('lfType').value;
    const hours_taken = leave_type === 'day_off' ? 0 : parseFloat(document.getElementById('lfHours').value);
    const notes       = document.getElementById('lfNotes').value.trim() || null;

    if (!start_date) { showToast('Date is required', 'error'); return; }
    if (leave_type !== 'day_off' && (isNaN(hours_taken) || hours_taken <= 0)) {
      showToast('Hours taken is required', 'error'); return;
    }

    try {
      if (editId) {
        await API.updateLeave(editId, { start_date, end_date, hours_taken, leave_type, notes });
        showToast('Leave entry updated');
      } else {
        await API.createLeave({ start_date, end_date, hours_taken, leave_type, notes });
        showToast('Leave logged ✓', 'success');
      }
      Modal.close();
      await this.load();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteEntry(id) {
    if (!confirmAction('Delete this leave entry?')) return;
    try {
      await API.deleteLeave(id);
      showToast('Leave entry deleted');
      await this.load();
    } catch(e) { showToast(e.message, 'error'); }
  },
};
