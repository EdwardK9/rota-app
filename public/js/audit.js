/* ─── Audit Log View ─────────────────────────────────────────────────────── */

const AuditView = {
  page: 0,
  pageSize: 50,
  filterDays: 90,
  filterAction: '',
  filterSearch: '',
  filterFrom: '',
  filterTo: '',
  filterFlagged: false,

  async init() {
    this.render();
    await this.loadStats();
    await this.loadLog();
  },

  render() {
    document.getElementById('view-audit').innerHTML = `
      <div style="max-width:960px">

        <div id="auditStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px"></div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><h2>Change Frequency (last 12 months)</h2></div>
          <div class="card-body" id="auditChart" style="overflow-x:auto"></div>
        </div>

        <div class="card">
          <div class="card-header" style="flex-wrap:wrap;gap:8px">
            <h2>Audit Log</h2>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:auto;align-items:center">
              <input type="search" id="auditSearch" class="form-input" placeholder="Search notes / text…" style="width:190px" />
              <select id="auditFilterAction" class="form-select" style="width:160px">
                <option value="">All actions</option>
                <option value="time_changed">⏱ Shift time changed (any source)</option>
                <option value="created">Created</option>
                <option value="updated">Updated</option>
                <option value="deleted">Deleted</option>
                <option value="sync_created">Sync – new</option>
                <option value="sync_changed">Sync – changed</option>
                <option value="sync_missing">Sync – missing</option>
              </select>
              <select id="auditFilterDays" class="form-select" style="width:140px">
                <option value="30">Last 30 days</option>
                <option value="90" selected>Last 90 days</option>
                <option value="180">Last 6 months</option>
                <option value="365">Last year</option>
                <option value="">All time</option>
              </select>
              <button class="btn btn-secondary btn-sm" id="auditRefresh">Refresh</button>
            </div>
          </div>

          <div class="card-body" style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <label style="display:block;font-size:.75rem;color:var(--text-muted);margin-bottom:3px">From date</label>
              <input type="date" id="auditFrom" class="form-input" style="width:160px" />
            </div>
            <div>
              <label style="display:block;font-size:.75rem;color:var(--text-muted);margin-bottom:3px">To date</label>
              <input type="date" id="auditTo" class="form-input" style="width:160px" />
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;cursor:pointer;padding-bottom:6px">
              <input type="checkbox" id="auditFlagged" /> Only “wasn’t told”
            </label>
            <button class="btn btn-ghost btn-sm" id="auditClearDates" style="margin-bottom:2px">Clear dates</button>
          </div>

          <div class="card-body" style="padding:0">
            <div id="auditLogBody" style="overflow-x:auto">
              <p style="padding:16px;color:var(--text-muted)">Loading…</p>
            </div>
            <div id="auditPager" style="display:flex;gap:8px;padding:12px 16px;align-items:center;border-top:1px solid var(--border)"></div>
          </div>
        </div>

      </div>
    `;

    document.getElementById('auditFilterAction').value = this.filterAction;
    document.getElementById('auditFilterDays').value   = String(this.filterDays);
    document.getElementById('auditSearch').value        = this.filterSearch;
    document.getElementById('auditFrom').value          = this.filterFrom;
    document.getElementById('auditTo').value            = this.filterTo;
    document.getElementById('auditFlagged').checked     = this.filterFlagged;

    document.getElementById('auditFilterAction').addEventListener('change', e => {
      this.filterAction = e.target.value; this.page = 0; this.loadLog();
    });
    document.getElementById('auditFilterDays').addEventListener('change', e => {
      this.filterDays = e.target.value; this.page = 0; this.loadLog();
    });
    document.getElementById('auditFrom').addEventListener('change', e => {
      this.filterFrom = e.target.value; this.page = 0; this.loadLog();
    });
    document.getElementById('auditTo').addEventListener('change', e => {
      this.filterTo = e.target.value; this.page = 0; this.loadLog();
    });
    document.getElementById('auditFlagged').addEventListener('change', e => {
      this.filterFlagged = e.target.checked; this.page = 0; this.loadLog();
    });
    document.getElementById('auditClearDates').addEventListener('click', () => {
      this.filterFrom = ''; this.filterTo = '';
      document.getElementById('auditFrom').value = '';
      document.getElementById('auditTo').value = '';
      this.page = 0; this.loadLog();
    });

    // Search — debounce typing
    let searchTimer;
    document.getElementById('auditSearch').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.filterSearch = e.target.value.trim(); this.page = 0; this.loadLog();
      }, 300);
    });

    document.getElementById('auditRefresh').addEventListener('click', () => {
      this.loadStats(); this.loadLog();
    });
  },

  async loadStats() {
    try {
      const resp = await fetch('/api/audit/stats');
      if (!resp.ok || !resp.headers.get('content-type')?.includes('application/json')) return;
      const data = await resp.json();

      const actionLabels = {
        created: 'Added manually', updated: 'Edited manually',
        deleted: 'Deleted manually', sync_created: 'Sync – new shift',
        sync_changed: 'Sync – changed', sync_missing: 'Sync – missing',
        manual_sync: 'Manual sync',
      };
      const actionColors = {
        sync_changed: 'var(--warning, #f59e0b)', sync_missing: 'var(--danger, #ef4444)',
        sync_created: 'var(--success, #10b981)', updated: 'var(--info, #3b82f6)',
        created: 'var(--success, #10b981)',       deleted: 'var(--danger, #ef4444)',
      };

      const total = data.byAction.reduce((s, r) => s + r.count, 0);
      const isActive = a => this.filterAction === a;
      document.getElementById('auditStats').innerHTML = `
        <div class="card audit-stat-box${isActive('') ? ' audit-stat-active' : ''}" data-stat-action="" style="padding:16px;text-align:center;cursor:pointer;user-select:none">
          <div style="font-size:2rem;font-weight:700">${total}</div>
          <div style="color:var(--text-muted);font-size:.85rem">Total events</div>
        </div>
        ${data.byAction.map(r => `
          <div class="card audit-stat-box${isActive(r.action) ? ' audit-stat-active' : ''}" data-stat-action="${r.action}" style="padding:16px;text-align:center;border-left:3px solid ${actionColors[r.action] || 'var(--primary)'};cursor:pointer;user-select:none">
            <div style="font-size:2rem;font-weight:700">${r.count}</div>
            <div style="color:var(--text-muted);font-size:.85rem">${actionLabels[r.action] || r.action}</div>
          </div>
        `).join('')}
      `;

      // Click a box to filter the log to just that event type (click again to clear)
      document.getElementById('auditStats').querySelectorAll('[data-stat-action]').forEach(box => {
        box.addEventListener('click', () => {
          const action = box.getAttribute('data-stat-action');
          this.filterAction = (this.filterAction === action) ? '' : action;
          document.getElementById('auditFilterAction').value = this.filterAction;
          this.page = 0;
          this.loadStats();
          this.loadLog();
        });
      });

      const chartEl = document.getElementById('auditChart');
      if (!data.byMonth.length) { chartEl.innerHTML = '<p style="color:var(--text-muted)">No change data yet.</p>'; return; }
      const max = Math.max(...data.byMonth.map(r => r.count), 1);
      chartEl.innerHTML = `
        <div style="display:flex;align-items:flex-end;gap:6px;height:80px;padding:8px 0">
          ${data.byMonth.slice().reverse().map(r => `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:32px">
              <div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:${Math.max(4, Math.round(r.count/max*60))}px" title="${r.count} changes"></div>
              <div style="font-size:.7rem;color:var(--text-muted);white-space:nowrap">${r.month.slice(5)}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch(e) { console.error('audit stats error', e); }
  },

  async loadLog() {
    const body = document.getElementById('auditLogBody');
    body.innerHTML = '<p style="padding:16px;color:var(--text-muted)">Loading…</p>';

    const params = new URLSearchParams({ limit: this.pageSize, offset: this.page * this.pageSize });
    // Date range takes precedence over the "last N days" preset
    if (this.filterFrom || this.filterTo) {
      if (this.filterFrom) params.set('from', this.filterFrom);
      if (this.filterTo)   params.set('to',   this.filterTo);
    } else if (this.filterDays) {
      params.set('days', this.filterDays);
    }
    if (this.filterAction)  params.set('action', this.filterAction);
    if (this.filterSearch)  params.set('search', this.filterSearch);
    if (this.filterFlagged) params.set('flagged', '1');

    try {
      const resp = await fetch(`/api/audit?${params}`);
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${resp.status}`);
      }
      const data = await resp.json();

      if (!data.rows.length) {
        body.innerHTML = '<p style="padding:16px;color:var(--text-muted)">No audit events found.</p>';
        document.getElementById('auditPager').innerHTML = '';
        return;
      }

      const actionBadge = {
        created:      '<span class="badge badge-success">Created</span>',
        updated:      '<span class="badge badge-info">Updated</span>',
        deleted:      '<span class="badge badge-danger">Deleted</span>',
        sync_created: '<span class="badge badge-success">Sync new</span>',
        sync_changed: '<span class="badge badge-warning">Sync changed</span>',
        sync_missing: '<span class="badge badge-danger">Sync missing</span>',
      };

      const esc = v => String(v ?? '').replace(/[&<>"']/g, c => (
        { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
      ));

      const formatChange = row => {
        try {
          const oldV = row.old_values ? JSON.parse(row.old_values) : null;
          const newV = row.new_values ? JSON.parse(row.new_values) : null;
          if ((row.action === 'sync_changed' || row.action === 'updated') && oldV && newV) {
            const parts = [];
            if (oldV.start_time !== newV.start_time || oldV.end_time !== newV.end_time)
              parts.push(`${oldV.start_time}–${oldV.end_time} → ${newV.start_time}–${newV.end_time}`);
            if (row.changed_fields) {
              const fields = JSON.parse(row.changed_fields);
              fields.filter(f => f !== 'start_time' && f !== 'end_time').forEach(f =>
                parts.push(`${f}: ${oldV[f]} → ${newV[f]}`)
              );
            }
            return parts.join(', ') || '—';
          }
          if (newV?.date) return `${newV.date} ${newV.start_time||''}–${newV.end_time||''}`;
          if (oldV?.date) return `${oldV.date} ${oldV.start_time||''}–${oldV.end_time||''}`;
          return '—';
        } catch { return '—'; }
      };

      const shiftDate = row => {
        if (row.shift_date) return row.shift_date;
        try {
          const v = row.new_values ? JSON.parse(row.new_values) : row.old_values ? JSON.parse(row.old_values) : null;
          return v?.date || '—';
        } catch { return '—'; }
      };

      body.innerHTML = `
        <table class="data-table" style="width:100%">
          <thead><tr>
            <th>When</th><th>Shift date</th><th>Action</th><th>Detail</th>
            <th style="min-width:230px">My note / told?</th><th>Source</th>
          </tr></thead>
          <tbody>
            ${data.rows.map(r => `
              <tr${r.not_notified ? ' style="background:rgba(239,68,68,.08)"' : ''}>
                <td style="white-space:nowrap;font-size:.85rem">${new Date(r.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                <td>${r.shift_exists
                    ? `<a href="#" data-goto-shift="${r.shift_id}" data-goto-date="${r.shift_date}" style="color:var(--primary-text);text-decoration:underline">${shiftDate(r)}</a>`
                    : `<span title="${r.shift_id ? 'That shift no longer exists (deleted)' : 'No shift linked to this event'}" style="color:var(--text-muted)">${shiftDate(r)}${r.shift_id ? ' 🚫' : ''}</span>`
                  }</td>
                <td>${actionBadge[r.action] || `<span class="badge">${r.action}</span>`}</td>
                <td style="font-size:.85rem">${formatChange(r)}${r.note ? `<br><span style="color:var(--text-muted);font-size:.75rem">${esc(r.note)}</span>` : ''}</td>
                <td>
                  <label style="display:flex;align-items:center;gap:5px;font-size:.75rem;margin-bottom:5px;cursor:pointer;color:${r.not_notified ? 'var(--danger)' : 'var(--text-muted)'}">
                    <input type="checkbox" data-audit-flag="${r.id}" ${r.not_notified ? 'checked' : ''} /> Wasn’t told
                  </label>
                  <input type="text" class="form-input" data-audit-note="${r.id}" value="${esc(r.user_note || '')}"
                    placeholder="Add a note…" style="width:100%;font-size:.8rem;padding:4px 6px" />
                </td>
                <td style="font-size:.75rem;color:var(--text-muted)">${esc(r.source||'')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      // Click a shift date to jump to that shift in the Shifts tab
      body.querySelectorAll('[data-goto-shift]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          App.goToShift(parseInt(a.getAttribute('data-goto-shift'), 10), a.getAttribute('data-goto-date'));
        });
      });

      // Wire up note + flag editing
      body.querySelectorAll('[data-audit-flag]').forEach(cb => {
        cb.addEventListener('change', () =>
          this.saveEntry(cb.getAttribute('data-audit-flag'), { not_notified: cb.checked }, cb));
      });
      body.querySelectorAll('[data-audit-note]').forEach(inp => {
        const save = () => this.saveEntry(inp.getAttribute('data-audit-note'), { user_note: inp.value }, inp);
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      });

      const totalPages = Math.ceil(data.total / this.pageSize);
      const pager = document.getElementById('auditPager');
      if (totalPages <= 1) { pager.innerHTML = `<span style="color:var(--text-muted);font-size:.85rem">${data.total} events</span>`; return; }
      pager.innerHTML = `
        <button class="btn btn-secondary btn-sm" id="auditPrev" ${this.page===0?'disabled':''}>← Prev</button>
        <span style="color:var(--text-muted);font-size:.85rem">Page ${this.page+1} / ${totalPages} &nbsp;(${data.total} events)</span>
        <button class="btn btn-secondary btn-sm" id="auditNext" ${this.page>=totalPages-1?'disabled':''}>Next →</button>
      `;
      document.getElementById('auditPrev')?.addEventListener('click', () => { this.page--; this.loadLog(); });
      document.getElementById('auditNext')?.addEventListener('click', () => { this.page++; this.loadLog(); });
    } catch(e) {
      body.innerHTML = `<p style="padding:16px;color:var(--danger)">Error loading audit log: ${e.message}</p>`;
    }
  },

  async saveEntry(id, patch, el) {
    try {
      const resp = await fetch(`/api/audit/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      // Update the row highlight when the flag changes
      if ('not_notified' in patch && el) {
        const tr = el.closest('tr');
        if (tr) tr.style.background = patch.not_notified ? 'rgba(239,68,68,.08)' : '';
        const lbl = el.closest('label');
        if (lbl) lbl.style.color = patch.not_notified ? 'var(--danger)' : 'var(--text-muted)';
      }
      if (el) { // brief visual confirmation
        const prev = el.style.outline;
        el.style.outline = '2px solid var(--success, #10b981)';
        setTimeout(() => { el.style.outline = prev; }, 600);
      }
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
  },
};
