/* ─── Manage People View ────────────────────────────────────────────────────── */

const ManagePeopleView = {
  _colleagues: [],

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-manage-people').innerHTML = `
      <div class="card" style="max-width:640px;padding:20px;margin-bottom:16px">
        <h3 style="margin-bottom:12px;font-size:15px">Add Person</h3>
        <div style="display:flex;gap:8px">
          <input id="mpNewName" class="form-control" placeholder="Full name e.g. Nikki Houghton" style="flex:1" />
          <button class="btn btn-primary" id="mpAddBtn">Add</button>
        </div>
      </div>

      <div class="card" style="max-width:640px;padding:20px">
        <h3 style="margin-bottom:4px;font-size:15px">People
          <span style="font-size:12px;color:var(--text-muted);font-weight:400"> — drag ↕ to reorder · ✏️ to edit</span>
        </h3>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
          Set a <strong>Left date</strong> to exclude someone from future screenshot imports without deleting their history.
        </p>
        <div id="mpColleagueList"></div>
      </div>

      <!-- Merge modal -->
      <div id="mpMergeModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);
        z-index:1000;overflow-y:auto;padding:24px 16px">
        <div style="background:var(--card-bg);border-radius:12px;max-width:440px;margin:40px auto;
          box-shadow:0 8px 40px rgba(0,0,0,0.4);padding:24px">
          <h3 style="margin-bottom:6px;font-size:15px">🔀 Merge person</h3>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:18px">
            All shifts for <strong id="mpMergeSrcName"></strong> will be moved to the person below,
            then <strong id="mpMergeSrcName2"></strong> will be deleted.
          </p>
          <div style="margin-bottom:16px">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px">Merge into</label>
            <select id="mpMergeTargetSel" style="width:100%">
              <option value="">— pick a person —</option>
            </select>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="mpMergeConfirmBtn" disabled>Merge</button>
            <button class="btn btn-ghost" id="mpMergeCancelBtn">Cancel</button>
          </div>
          <div id="mpMergeResult" style="margin-top:12px;font-size:13px"></div>
        </div>
      </div>

      <!-- Edit panel -->
      <div id="mpEditPanel" class="card" style="display:none;max-width:640px;margin-top:16px;padding:20px;border:2px solid var(--primary)">
        <h3 style="margin-bottom:14px;font-size:15px">Edit Person</h3>
        <input type="hidden" id="mpEditId" />
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Name</label>
            <input id="mpEditName" class="form-control" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Birthday</label>
            <input id="mpEditBirthday" class="form-control" type="date" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Contract Hours / week</label>
            <input id="mpEditContract" class="form-control" type="number" min="0" max="60" step="0.25" placeholder="e.g. 20" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Start date <span style="color:var(--text-muted);font-weight:400">(no matching before this)</span></label>
            <input id="mpEditStartDate" class="form-control" type="date" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Left date <span style="color:var(--text-muted);font-weight:400">(stops import matching)</span></label>
            <input id="mpEditLeftDate" class="form-control" type="date" />
          </div>
        </div>

        <h4 style="margin:4px 0 10px;font-size:13px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:14px">💷 Pay Profile</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Pay type</label>
            <select id="mpEditPayType" class="form-control">
              <option value="hourly">Hourly</option>
              <option value="salaried">Salaried</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Job tier</label>
            <select id="mpEditJobTier" class="form-control">
              <option value="floor_staff">Floor Staff</option>
              <option value="supervisor">Supervisor</option>
              <option value="management">Management</option>
            </select>
            <div class="form-hint">Used to group the Team Metrics pay distribution chart.</div>
          </div>
          <div id="mpEditHourlyRateWrap">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Hourly rate (£)</label>
            <input id="mpEditHourlyRate" class="form-control" type="number" min="0" step="0.01" placeholder="e.g. 12.50" />
          </div>
          <div id="mpEditSalaryWrap" style="display:none">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Annual salary (£)</label>
            <input id="mpEditSalary" class="form-control" type="number" min="0" step="1" placeholder="e.g. 28000" />
          </div>
          <div id="mpEditNominalHoursWrap" style="display:none">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Nominal weekly hours</label>
            <input id="mpEditNominalHours" class="form-control" type="number" min="0" max="60" step="0.25" placeholder="e.g. 37.5" />
          </div>
        </div>
        <p id="mpEditEffectiveRate" style="font-size:12px;color:var(--text-muted);margin:-6px 0 14px"></p>

        <h4 style="margin:4px 0 10px;font-size:13px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:14px">🤝 Synergy & Notes</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Tags <span style="font-weight:400">(comma-separated)</span></label>
            <input id="mpEditTags" class="form-control" placeholder="e.g. Fast on Tills, Closing Pro" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Synergy rating</label>
            <select id="mpEditSynergy" class="form-control">
              <option value="-2">-2 · Difficult / Draining</option>
              <option value="-1">-1 · Prefer to avoid</option>
              <option value="0">0 · Neutral</option>
              <option value="1">+1 · Good to work with</option>
              <option value="2">+2 · Dream teammate</option>
            </select>
          </div>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Private notes</label>
          <textarea id="mpEditNotes" class="form-control" rows="2" placeholder="e.g. Next shift together: ask about inventory handover"></textarea>
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="mpEditSave">Save</button>
          <button class="btn btn-ghost" id="mpEditCancel">Cancel</button>
        </div>
      </div>
    `;

    document.getElementById('mpAddBtn').addEventListener('click', () => this.addColleague());
    document.getElementById('mpNewName').addEventListener('keydown', e => { if (e.key === 'Enter') this.addColleague(); });
    document.getElementById('mpEditSave').addEventListener('click', () => this.saveEdit());
    document.getElementById('mpEditCancel').addEventListener('click', () => {
      document.getElementById('mpEditPanel').style.display = 'none';
    });
    document.getElementById('mpMergeCancelBtn').addEventListener('click', () => this.closeMergeModal());
    document.getElementById('mpMergeTargetSel').addEventListener('change', e => {
      document.getElementById('mpMergeConfirmBtn').disabled = !e.target.value;
    });
    document.getElementById('mpMergeConfirmBtn').addEventListener('click', () => this.confirmMerge());
    document.getElementById('mpMergeModal').addEventListener('click', e => {
      if (e.target === document.getElementById('mpMergeModal')) this.closeMergeModal();
    });

    document.getElementById('mpEditPayType').addEventListener('change', () => this._syncPayTypeFields());
    ['mpEditHourlyRate', 'mpEditSalary', 'mpEditNominalHours'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => this._updateEffectiveRatePreview());
    });
  },

  /** Show hourly-rate field or salary+nominal-hours fields depending on pay type,
   *  and refresh the effective-rate preview line underneath. */
  _syncPayTypeFields() {
    const isSalaried = document.getElementById('mpEditPayType').value === 'salaried';
    document.getElementById('mpEditHourlyRateWrap').style.display    = isSalaried ? 'none'  : 'block';
    document.getElementById('mpEditSalaryWrap').style.display        = isSalaried ? 'block' : 'none';
    document.getElementById('mpEditNominalHoursWrap').style.display  = isSalaried ? 'block' : 'none';
    this._updateEffectiveRatePreview();
  },

  _updateEffectiveRatePreview() {
    const isSalaried = document.getElementById('mpEditPayType').value === 'salaried';
    const el = document.getElementById('mpEditEffectiveRate');
    if (!isSalaried) { el.textContent = ''; return; }
    const salary = parseFloat(document.getElementById('mpEditSalary').value);
    const hours  = parseFloat(document.getElementById('mpEditNominalHours').value);
    if (salary > 0 && hours > 0) {
      const rate = Math.round((salary / (52 * hours)) * 100) / 100;
      el.textContent = `Effective hourly rate: £${rate.toFixed(2)}/hr (£${salary} ÷ (52 × ${hours}h))`;
    } else {
      el.textContent = 'Enter salary and nominal weekly hours to see the effective hourly rate.';
    }
  },

  async load() {
    try {
      const colleagues = await API.get('/api/colleagues?include_left=1');
      this._colleagues = colleagues;
      this.renderList(colleagues);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  renderList(colleagues) {
    const el = document.getElementById('mpColleagueList');
    if (!el) return;
    if (!colleagues.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No colleagues added yet.</p>';
      return;
    }
    el.innerHTML = colleagues.map((c, i) => {
      const bday  = c.birthday    ? ` 🎂 ${c.birthday.slice(8)}/${c.birthday.slice(5,7)}` : '';
      const hrs   = c.contract_hours ? ` · ${c.contract_hours}h/wk` : '';
      const start = c.start_date  ? ` · <span style="color:var(--text-muted);font-size:11px">from ${c.start_date}</span>` : '';
      const left  = c.left_date   ? ` · <span style="color:var(--danger);font-size:11px">left ${c.left_date}</span>` : '';
      const rate  = c.effective_hourly_rate != null
        ? ` · <span style="color:var(--text-muted);font-size:11px">£${c.effective_hourly_rate.toFixed(2)}/hr${c.pay_type === 'salaried' ? ' (salaried)' : ''}</span>` : '';
      const synergyIcons = { '-2': '❄️❄️', '-1': '❄️', '0': '', '1': '⭐', '2': '⭐⭐' };
      const synergy = c.synergy_rating ? ` ${synergyIcons[String(c.synergy_rating)] || ''}` : '';
      return `
        <div data-id="${c.id}" draggable="true"
          style="display:flex;align-items:center;gap:8px;padding:8px 10px;
          border:1px solid var(--border);border-radius:8px;margin-bottom:6px;
          background:${c.left_date ? 'rgba(239,68,68,0.05)' : 'var(--card-bg)'};
          user-select:none;-webkit-user-select:none">
          <span style="cursor:grab;color:var(--text-muted);font-size:16px" class="mp-drag-handle">⠿</span>
          <div style="flex:1;font-size:13px">
            <strong style="color:${c.left_date ? 'var(--text-muted)' : 'var(--text)'}">${c.name}</strong>${synergy}${start}
            <span style="color:var(--text-muted)">${bday}${hrs}${rate}${left}</span>
          </div>
          <button onclick="ManagePeopleView.openEdit(${c.id})"
            style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 6px" title="Edit">✏️</button>
          <button onclick="ManagePeopleView.openMergeModal(${c.id})"
            style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 6px;color:var(--text-muted)" title="Merge into another person">🔀</button>
          <button onclick="ManagePeopleView.moveUp(${i})"
            style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px" ${i===0?'disabled':''}>▲</button>
          <button onclick="ManagePeopleView.moveDown(${i})"
            style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px"
            ${i===colleagues.length-1?'disabled':''}>▼</button>
          <button onclick="ManagePeopleView.deleteColleague(${c.id},'${c.name.replace(/'/g,"\\'")}')"
            style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:16px;padding:2px 4px"
            title="Remove">&times;</button>
        </div>`;
    }).join('');

    // Drag-and-drop reorder
    let dragSrcId = null;
    el.querySelectorAll('[data-id][draggable]').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragSrcId = row.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => { row.style.opacity = '0.4'; }, 0);
      });
      row.addEventListener('dragend', () => {
        row.style.opacity = '';
        el.querySelectorAll('[data-id]').forEach(r => { r.style.outline = ''; });
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        if (row.dataset.id !== dragSrcId) row.style.outline = '2px solid var(--primary)';
      });
      row.addEventListener('dragleave', () => { row.style.outline = ''; });
      row.addEventListener('drop', async e => {
        e.preventDefault();
        row.style.outline = '';
        const srcId = parseInt(dragSrcId, 10), dstId = parseInt(row.dataset.id, 10);
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
    const c = this._colleagues.find(x => x.id === id);
    if (!c) return;
    document.getElementById('mpEditId').value        = c.id;
    document.getElementById('mpEditName').value      = c.name;
    document.getElementById('mpEditStartDate').value = c.start_date || '';
    document.getElementById('mpEditBirthday').value  = c.birthday || '';
    document.getElementById('mpEditContract').value  = c.contract_hours || '';
    document.getElementById('mpEditLeftDate').value  = c.left_date || '';

    document.getElementById('mpEditPayType').value      = c.pay_type || 'hourly';
    document.getElementById('mpEditJobTier').value      = c.job_tier || 'floor_staff';
    document.getElementById('mpEditHourlyRate').value   = c.hourly_rate ?? '';
    document.getElementById('mpEditSalary').value       = c.annual_salary ?? '';
    document.getElementById('mpEditNominalHours').value = c.nominal_weekly_hours ?? '';
    document.getElementById('mpEditTags').value         = Array.isArray(c.tags) ? c.tags.join(', ') : '';
    document.getElementById('mpEditSynergy').value      = c.synergy_rating ?? 0;
    document.getElementById('mpEditNotes').value        = c.notes || '';
    this._syncPayTypeFields();

    document.getElementById('mpEditPanel').style.display = 'block';
    document.getElementById('mpEditPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  async saveEdit() {
    const id           = document.getElementById('mpEditId').value;
    const name         = document.getElementById('mpEditName').value.trim();
    const birthday     = document.getElementById('mpEditBirthday').value || null;
    const contract_hours = parseFloat(document.getElementById('mpEditContract').value) || 0;
    const start_date   = document.getElementById('mpEditStartDate').value || null;
    const left_date    = document.getElementById('mpEditLeftDate').value || null;

    const pay_type = document.getElementById('mpEditPayType').value;
    const job_tier = document.getElementById('mpEditJobTier').value;
    const hourly_rate = pay_type === 'hourly'
      ? (parseFloat(document.getElementById('mpEditHourlyRate').value) || null) : null;
    const annual_salary = pay_type === 'salaried'
      ? (parseFloat(document.getElementById('mpEditSalary').value) || null) : null;
    const nominal_weekly_hours = pay_type === 'salaried'
      ? (parseFloat(document.getElementById('mpEditNominalHours').value) || null) : null;
    const tags = document.getElementById('mpEditTags').value
      .split(',').map(t => t.trim()).filter(Boolean);
    const synergy_rating = parseInt(document.getElementById('mpEditSynergy').value, 10) || 0;
    const notes = document.getElementById('mpEditNotes').value.trim() || null;

    if (!name) return showToast('Name cannot be empty', 'error');
    try {
      await API.updateColleague(id, {
        name, birthday, contract_hours, start_date, left_date,
        pay_type, hourly_rate, annual_salary, nominal_weekly_hours,
        tags, synergy_rating, notes, job_tier,
      });
      document.getElementById('mpEditPanel').style.display = 'none';
      await this.load();
      showToast('Saved');
    } catch (e) { showToast(e.message, 'error'); }
  },

  async addColleague() {
    const input = document.getElementById('mpNewName');
    const name = input.value.trim();
    if (!name) return;
    try {
      await API.addColleague(name);
      input.value = '';
      await this.load();
      showToast('Added ' + name);
    } catch (e) { showToast(e.message, 'error'); }
  },

  async deleteColleague(id, name) {
    if (!confirm(`⚠️ PERMANENTLY DELETE "${name}"?\n\nThis will delete ALL their imported shifts and cannot be undone.\n\nTip: Use "Edit → Set a Left date" to hide them from imports without losing their data.`)) return;
    try {
      await API.deleteColleague(id);
      await this.load();
      showToast('Removed ' + name);
    } catch (e) { showToast(e.message, 'error'); }
  },

  async moveUp(index) {
    const cols = [...this._colleagues];
    if (index <= 0) return;
    [cols[index - 1], cols[index]] = [cols[index], cols[index - 1]];
    await this._saveOrder(cols);
  },

  async moveDown(index) {
    const cols = [...this._colleagues];
    if (index >= cols.length - 1) return;
    [cols[index], cols[index + 1]] = [cols[index + 1], cols[index]];
    await this._saveOrder(cols);
  },

  async _saveOrder(cols) {
    const items = cols.map((c, i) => ({ id: c.id, sort_order: i }));
    await API.reorderColleagues(items);
    await this.load();
  },

  // ─── Merge ──────────────────────────────────────────────────────────────────

  _mergeSourceId: null,

  openMergeModal(srcId) {
    this._mergeSourceId = srcId;
    const src = this._colleagues.find(c => c.id === srcId);
    if (!src) return;

    document.getElementById('mpMergeSrcName').textContent  = src.name;
    document.getElementById('mpMergeSrcName2').textContent = src.name;
    document.getElementById('mpMergeResult').textContent   = '';
    document.getElementById('mpMergeConfirmBtn').disabled  = true;

    const sel = document.getElementById('mpMergeTargetSel');
    sel.innerHTML = '<option value="">— pick a person —</option>' +
      this._colleagues
        .filter(c => c.id !== srcId)
        .map(c => `<option value="${c.id}">${esc(c.name)}</option>`)
        .join('');
    sel.value = '';

    document.getElementById('mpMergeModal').style.display = 'block';
  },

  closeMergeModal() {
    document.getElementById('mpMergeModal').style.display = 'none';
    this._mergeSourceId = null;
  },

  async confirmMerge() {
    const targetId = document.getElementById('mpMergeTargetSel').value;
    if (!targetId || !this._mergeSourceId) return;

    const src = this._colleagues.find(c => c.id === this._mergeSourceId);
    const dst = this._colleagues.find(c => c.id === parseInt(targetId));
    if (!confirm(`Merge "${src?.name}" into "${dst?.name}"?\n\nThis will move all their shifts to ${dst?.name} and delete ${src?.name}. This cannot be undone.`)) return;

    const btn = document.getElementById('mpMergeConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Merging…';

    try {
      const r = await API.mergeColleague(this._mergeSourceId, targetId);
      document.getElementById('mpMergeResult').innerHTML =
        `<span style="color:var(--success)">✓ Done — ${r.moved} shifts moved${r.dropped ? `, ${r.dropped} duplicates dropped` : ''}</span>`;
      btn.textContent = 'Merge';
      await this.load();
      setTimeout(() => this.closeMergeModal(), 1500);
      showToast(`Merged "${r.from}" into "${r.into}"`, 'success');
    } catch(e) {
      document.getElementById('mpMergeResult').innerHTML =
        `<span style="color:var(--danger)">✗ ${e.message}</span>`;
      btn.disabled = false;
      btn.textContent = 'Merge';
    }
  },
};
