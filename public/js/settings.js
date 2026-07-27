/* ─── Settings View ───────────────────────────────────────────────────────── */

const SettingsView = {
  payRates: [],
  settings: {},

  async init() {
    this.render();
    await this.load();
  },

  render() {
    const el = document.getElementById('view-settings');
    el.innerHTML = `
      <div style="max-width:680px">

        <!-- General Settings -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>General</h2></div>
            <div class="card-body">
              <div class="form-row">
                <div class="form-group">
                  <label>Default Distance (miles per shift)</label>
                  <input type="number" id="setDefaultDist" step="0.1" placeholder="3.6" />
                  <div class="form-hint">Used when adding new shifts. Can override per shift.</div>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Your Name</label>
                  <input type="text" id="setName" placeholder="Ed Kay" />
                </div>
                <div class="form-group">
                  <label>Employer</label>
                  <input type="text" id="setEmployer" placeholder="Screwfix" />
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Leave Year Start (MM-DD)</label>
                  <input type="text" id="setLeaveYearStart" placeholder="04-01" pattern="\d{2}-\d{2}" />
                  <div class="form-hint">When your leave year resets, e.g. 04-01 for 1 April.</div>
                </div>
                <div class="form-group">
                  <label>Job Start Date</label>
                  <input type="date" id="setJobStartDate" />
                  <div class="form-hint">Used to calculate employment milestones.</div>
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Date of Birth</label>
                  <input type="date" id="setUserDob" />
                  <div class="form-hint">Used to apply the correct break entitlement (under/over 18 rules).</div>
                </div>
              </div>
              <button class="btn btn-primary" id="saveGeneralBtn">Save</button>
            </div>
          </div>
        </div>

        <!-- Clock In/Out Thresholds -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>Clock In / Out</h2></div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
                Controls when a clock-in or clock-out counts as "early", "on time", or "late" in analytics — and when a reason prompt appears.
              </p>
              <h4 style="font-size:13px;font-weight:600;margin:4px 0 8px">🕐 Clock In</h4>
              <div class="form-row">
                <div class="form-group">
                  <label>Early threshold (minutes)</label>
                  <input type="number" id="setClockInEarly" min="0" max="60" placeholder="1" />
                  <div class="form-hint">Clocking in more than this many minutes before your start = Early. Default: 1</div>
                </div>
                <div class="form-group">
                  <label>Late threshold (minutes)</label>
                  <input type="number" id="setClockInLate" min="0" max="60" placeholder="5" />
                  <div class="form-hint">Clocking in more than this many minutes after your start = Late (triggers a reason prompt). Default: 5</div>
                </div>
              </div>
              <h4 style="font-size:13px;font-weight:600;margin:16px 0 8px">🕔 Clock Out</h4>
              <div class="form-row">
                <div class="form-group">
                  <label>Early threshold (minutes)</label>
                  <input type="number" id="setClockOutEarly" min="0" max="60" placeholder="1" />
                  <div class="form-hint">Clocking out more than this many minutes before your end = Early (triggers a reason prompt). Default: 1</div>
                </div>
                <div class="form-group">
                  <label>Late threshold (minutes)</label>
                  <input type="number" id="setClockOutLate" min="0" max="60" placeholder="5" />
                  <div class="form-hint">Clocking out more than this many minutes after your end = Late. Default: 5</div>
                </div>
              </div>
              <button class="btn btn-primary" id="saveClockThresholdsBtn">Save</button>
            </div>
          </div>
        </div>

        <!-- Delivery Schedules -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header">
              <h2>Delivery Schedules</h2>
              <button class="btn btn-primary btn-sm" id="addDelivSchedBtn">+ Add Schedule</button>
            </div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
                Track which days deliveries happen and when that changed. Insights uses the schedule active at the time of each shift.
              </p>
              <div id="delivSchedBody"><p style="color:var(--text-muted)">Loading…</p></div>
            </div>
          </div>
        </div>

        <!-- Job Milestones -->
        <div class="settings-section" id="milestonesSection" style="display:none">
          <div class="card">
            <div class="card-header"><h2>Employment Milestones</h2></div>
            <div class="card-body" id="milestonesBody"></div>
          </div>
        </div>

        <!-- Pay Rates -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header">
              <h2>Pay Rates</h2>
              <button class="btn btn-primary btn-sm" id="addPayRateBtn">+ Add Rate</button>
            </div>
            <div class="card-body" id="payRatesBody">
              <p style="color:var(--text-muted)">Loading…</p>
            </div>
          </div>
        </div>

        <!-- Backup & Restore -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>Backup &amp; Restore</h2></div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
                Download a full JSON backup of all your data (shifts, payslips, pay rates, leave, settings, calendar notes). You can restore from a backup to roll back to a saved state.
              </p>

              <!-- Download backup -->
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
                <button class="btn btn-primary" id="backupDownloadBtn">⬇️ Download Backup</button>
                <span id="backupStatus" style="font-size:13px;color:var(--text-muted)"></span>
              </div>

              <!-- Restore from file -->
              <div style="border-top:1px solid var(--border);padding-top:16px">
                <p style="font-size:13px;font-weight:600;margin-bottom:8px">Restore from backup</p>
                <p style="color:var(--danger);font-size:12px;margin-bottom:12px">
                  ⚠️ <strong>Warning:</strong> Restoring will replace ALL existing data with the contents of the backup file. This cannot be undone.
                </p>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                  <label class="btn btn-ghost" style="cursor:pointer;margin:0">
                    📁 Choose backup file
                    <input type="file" id="restoreFileInput" accept=".json" style="display:none" />
                  </label>
                  <span id="restoreFileName" style="font-size:13px;color:var(--text-muted)">No file selected</span>
                  <button class="btn btn-ghost danger" id="restoreBtn" style="display:none">↩ Restore Now</button>
                </div>
                <div id="restorePreview" style="margin-top:12px;display:none"></div>
              </div>

              <!-- Automatic backups -->
              <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:16px">
                <p style="font-size:13px;font-weight:600;margin-bottom:8px">Automatic backups</p>
                <p style="color:var(--text-muted);font-size:12.5px;margin-bottom:12px">
                  The server saves a copy of the whole database every night (after 3am) into
                  <code>data/backups</code>, keeping the last 14. Nothing to configure.
                </p>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
                  <button class="btn btn-ghost" id="dbBackupRunBtn">💾 Back up now</button>
                  <span id="dbBackupStatus" style="font-size:13px;color:var(--text-muted)"></span>
                </div>
                <div id="dbBackupList" style="font-size:13px;color:var(--text-muted)">Loading…</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Data Tools -->
        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>Data Tools</h2></div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
                Recalculate hours worked and pay for all existing shifts. Fixes shifts saved with incorrect break deductions,
                and also flags (and pays double for) any shift that fell on a UK bank holiday but was never marked as one —
                this can happen for shifts synced from Rotageek, since that flag isn't always set automatically.
              </p>
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <button class="btn btn-primary" id="recalcShiftsBtn">↻ Recalculate All Shifts</button>
                <span id="recalcStatus" style="font-size:13px;color:var(--text-muted)"></span>
              </div>
            </div>
          </div>
        </div>

<!-- Google Calendar Sync -->

        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>Google Calendar Sync</h2></div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">
                Automatically add, update and remove calendar events when shifts change.
                You'll need a Google Cloud OAuth client — see <code>GOOGLE_CALENDAR_SETUP.md</code> for the one-time setup.
              </p>

              <div id="gcalStatusBadge" style="margin-bottom:14px;font-size:14px"></div>

              <div class="form-group" style="margin-bottom:12px">
                <label>Client ID</label>
                <input type="text" id="gcalClientId" placeholder="xxxxxxxx.apps.googleusercontent.com" />
              </div>
              <div class="form-group" style="margin-bottom:12px">
                <label>Client secret</label>
                <input type="password" id="gcalClientSecret" placeholder="Leave blank to keep the saved secret" autocomplete="new-password" />
                <div class="form-hint">Only re-enter this if you're changing it. It's never shown back to you.</div>
              </div>
              <div class="form-group" style="margin-bottom:12px">
                <label>Authorised redirect URI</label>
                <input type="text" id="gcalRedirect" placeholder="https://your-domain/api/google/callback" />
                <div class="form-hint">Must exactly match the redirect URI in your Google Cloud OAuth client.</div>
                <div id="gcalRedirectWarn" style="display:none;font-size:12px;color:var(--danger);margin-top:5px"></div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Calendar</label>
                  <div style="display:flex;gap:6px">
                    <select id="gcalCalSelect" class="form-select" style="flex:1">
                      <option value="primary">Primary calendar</option>
                    </select>
                    <button class="btn btn-ghost btn-sm" id="gcalCalRefresh" title="Refresh calendar list">&#8635;</button>
                  </div>
                  <div class="form-hint">Which calendar shifts go on. <a href="#" id="gcalCalManualToggle">Enter ID manually</a></div>
                  <input type="text" id="gcalCalId" placeholder="primary" style="display:none;margin-top:6px" />
                </div>
                <div class="form-group">
                  <label>Event title</label>
                  <input type="text" id="gcalEventTitle" placeholder="Screwfix Shift" />
                  <div class="form-hint">All shift events use this title, with no description.</div>
                </div>
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label>Auto-sync frequency</label>
                  <select id="gcalAutoFreq" class="form-select">
                    <option value="0">Off — only when shifts change</option>
                    <option value="15">Every 15 minutes</option>
                    <option value="30">Every 30 minutes</option>
                    <option value="60">Every hour</option>
                    <option value="360">Every 6 hours</option>
                    <option value="1440">Once a day</option>
                  </select>
                  <div class="form-hint">A periodic safety-net re-sync of upcoming shifts. Shift edits always sync instantly regardless.</div>
                </div>
              </div>

              <label style="display:flex;align-items:center;gap:8px;margin:8px 0 16px;cursor:pointer">
                <input type="checkbox" id="gcalEnabled" /> Auto-sync shift changes to Google Calendar
              </label>

              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <button class="btn btn-secondary" id="gcalSaveBtn">Save settings</button>
                <button class="btn btn-primary" id="gcalConnectBtn">Connect Google account</button>
                <button class="btn btn-ghost" id="gcalDisconnectBtn" style="color:var(--danger)">Disconnect</button>
              </div>

              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px">
                <button class="btn btn-ghost" id="gcalSyncAllBtn">Sync future shifts</button>
                <button class="btn btn-ghost" id="gcalSyncPastBtn">Sync ALL (incl. past)</button>
                <button class="btn btn-ghost" id="gcalReconcileBtn" title="Re-sync shifts and remove stray events left on the wrong day">&#129529; Clean up calendar</button>
                <span id="gcalActionStatus" style="font-size:13px;color:var(--text-muted)"></span>
              </div>

              <div style="margin-top:18px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                  <strong style="font-size:13px">Recent calendar activity</strong>
                  <button class="btn btn-ghost btn-sm" id="gcalLogRefresh" title="Refresh">&#8635;</button>
                </div>
                <div id="gcalSyncLog" style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px">
                  <p style="padding:12px;color:var(--text-muted);font-size:13px;margin:0">No activity yet.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

<!-- Rotageek API -->

        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>Rotageek API</h2></div>
            <div class="card-body">
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">
                For when official Rotageek API access becomes available — save your credentials here
                and they'll be used by the Rotageek sync features. Nothing breaks if it's left empty.
              </p>

              <div id="rgStatusBadge" style="margin-bottom:14px;font-size:14px"></div>

              <div class="form-row" style="align-items:flex-end">
                <div class="form-group" style="max-width:420px">
                  <label>API base URL</label>
                  <input type="text" id="rgBaseUrl" placeholder="https://publicapi.rotageek.com" />
                  <div class="form-hint">The Rotageek public API root, or your tenant URL (e.g. https://screwfix.rotageek.com).</div>
                </div>
                <div class="form-group" style="max-width:420px">
                  <label>API key / Bearer token</label>
                  <input type="password" id="rgApiKey" placeholder="Paste your API key or token" autocomplete="off" />
                  <div class="form-hint">Stored on your server only — never sent anywhere except Rotageek.</div>
                </div>
              </div>

              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <button class="btn btn-primary" id="rgSaveBtn">Save</button>
                <button class="btn btn-secondary" id="rgTestBtn">Test connection</button>
                <button class="btn btn-ghost" id="setRgDisconnectBtn" style="color:var(--danger)">Clear credentials</button>
                <span id="rgActionStatus" style="font-size:13px;color:var(--text-muted)"></span>
              </div>
            </div>
          </div>
        </div>

<!-- About -->

        <div class="settings-section">
          <div class="card">
            <div class="card-header"><h2>About</h2></div>
            <div class="card-body" style="color:var(--text-muted);font-size:13.5px">
              <p><strong>Screwfix Rota Tracker</strong> — self-hosted shift &amp; pay tracking</p>
              <p style="margin-top:6px">Data stored in SQLite at <code>/app/data/rota.db</code> inside the container.</p>
              <p style="margin-top:6px">Back up the Docker volume <code>rota-data</code> to keep your data safe.</p>
            </div>
          </div>
        </div>

      </div>
    `;

    document.getElementById('saveGeneralBtn').addEventListener('click', () => this.saveGeneral());
    document.getElementById('addPayRateBtn').addEventListener('click', () => this.openAddRateModal());

    // Backup
    document.getElementById('backupDownloadBtn').addEventListener('click', () => this.downloadBackup());
    document.getElementById('dbBackupRunBtn')?.addEventListener('click', () => this.runDbBackup());

    // Restore — file picker
    document.getElementById('restoreFileInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      document.getElementById('restoreFileName').textContent = file.name;
      this.loadRestoreFile(file);
    });

    document.getElementById('restoreBtn').addEventListener('click', () => this.doRestore());
    document.getElementById('recalcShiftsBtn').addEventListener('click', () => this.recalcShifts());
    document.getElementById('saveClockThresholdsBtn').addEventListener('click', () => this.saveClockThresholds());

    // Google Calendar
    document.getElementById('gcalRedirect')?.addEventListener('input', () => this._checkRedirect());
    document.getElementById('gcalSaveBtn')?.addEventListener('click', () => this.saveGoogleConfig());
    document.getElementById('gcalConnectBtn')?.addEventListener('click', () => this.connectGoogle());
    document.getElementById('gcalDisconnectBtn')?.addEventListener('click', () => this.disconnectGoogle());
    document.getElementById('gcalSyncAllBtn')?.addEventListener('click', () => this.syncAllGoogle(true));
    document.getElementById('gcalSyncPastBtn')?.addEventListener('click', () => this.syncAllGoogle(false));
    document.getElementById('gcalReconcileBtn')?.addEventListener('click', () => this.reconcileGoogle());
    document.getElementById('gcalCalRefresh')?.addEventListener('click', () => this._loadCalendars(true));
    document.getElementById('gcalLogRefresh')?.addEventListener('click', () => this._renderSyncLog());
    document.getElementById('gcalCalManualToggle')?.addEventListener('click', (e) => {
      e.preventDefault();
      const box = document.getElementById('gcalCalId');
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });

    // Rotageek API
    document.getElementById('rgSaveBtn')?.addEventListener('click', () => this.saveRotageek());
    document.getElementById('rgTestBtn')?.addEventListener('click', () => this.testRotageek());
    document.getElementById('setRgDisconnectBtn')?.addEventListener('click', () => this.disconnectRotageek());

  },

  async load() {
    try {
      [this.payRates, this.settings, this.delivSchedList] = await Promise.all([
        API.getPayRates(),
        API.getSettings(),
        API.get('/api/delivery-schedules'),
      ]);
    } catch(e) {
      showToast('Failed to load settings: ' + e.message, 'error');
      return;
    }
    try {
      this.populateGeneral();
      this.populateClockThresholds();
      this.renderPayRates();
      this.renderMilestones();
      this.renderDelivSchedules();
    } catch(e) {
      console.warn('Settings render error:', e);
    }
    document.getElementById('addDelivSchedBtn')?.addEventListener('click', () => this.addDelivSchedule());

    this.renderGoogleCalendar();
    this.renderRotageekStatus();
    this.renderDbBackups();
    // Show a toast if we just came back from the Google OAuth flow
    const qp = new URLSearchParams(location.search);
    if (qp.get('gcal') === 'connected') { this._toast('Google Calendar connected', 'success'); this._clearGcalQuery(); }
    else if (qp.get('gcal') === 'error') { this._toast('Google connection failed: ' + (qp.get('msg') || 'unknown error'), 'error'); this._clearGcalQuery(); }
  },

  _toast(msg, type) {
    if (typeof showToast === 'function') showToast(msg, type);
    else { const el = document.getElementById('gcalActionStatus'); if (el) el.textContent = msg; else alert(msg); }
  },

  // ── Automatic DB backups ──────────────────────────────────────────────────

  async renderDbBackups() {
    const el = document.getElementById('dbBackupList');
    if (!el) return;
    try {
      const data = await API.get('/api/db-backups');
      if (!data.backups.length) {
        el.innerHTML = 'No automatic backups yet — the first runs tonight after 3am, or click "Back up now".';
        return;
      }
      el.innerHTML = data.backups.map(b => {
        const mb = (b.size / 1048576).toFixed(1);
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
          <span>${esc(b.file)} <span style="color:var(--text-muted)">· ${mb} MB</span></span>
          <a class="btn btn-ghost btn-sm" href="/api/db-backups/${encodeURIComponent(b.file)}" download>⬇️</a>
        </div>`;
      }).join('');
    } catch (_) {
      el.innerHTML = 'Backup list unavailable (server needs the latest deploy).';
    }
  },

  async runDbBackup() {
    const status = document.getElementById('dbBackupStatus');
    if (status) status.textContent = 'Backing up…';
    try {
      const r = await API.post('/api/db-backups/run', {});
      if (status) status.textContent = `✓ Saved ${r.file}`;
      this.renderDbBackups();
    } catch (e) {
      if (status) status.textContent = 'Backup failed: ' + e.message;
    }
  },

  // ── Rotageek API ──────────────────────────────────────────────────────────

  async renderRotageekStatus() {
    const badge = document.getElementById('rgStatusBadge');
    if (!badge) return;
    try {
      const st = await API.get('/api/rotageek/status');
      const urlEl = document.getElementById('rgBaseUrl');
      if (urlEl && !urlEl.value) urlEl.value = st.base_url || '';
      const keyEl = document.getElementById('rgApiKey');
      if (keyEl && st.token) keyEl.placeholder = '••••••••••••••••••• (saved)';
      badge.innerHTML = st.connected
        ? `<span style="color:var(--success,#2e9e5b)">● Credentials saved</span>
           <span style="color:var(--text-muted);font-size:12.5px"> — ${esc(st.auth_mode || 'token')} auth · ${esc(st.base_url || '')}</span>`
        : `<span style="color:var(--text-muted)">○ No credentials saved yet</span>`;
    } catch (_) {
      badge.innerHTML = `<span style="color:var(--text-muted)">Status unavailable</span>`;
    }
  },

  async saveRotageek() {
    const base_url = document.getElementById('rgBaseUrl')?.value.trim();
    const token    = document.getElementById('rgApiKey')?.value.trim();
    const status   = document.getElementById('rgActionStatus');
    if (!token) { this._toast('Enter an API key or token first', 'warning'); return; }
    try {
      await API.post('/api/rotageek/save-token', { token, base_url: base_url || undefined });
      const keyEl = document.getElementById('rgApiKey');
      if (keyEl) { keyEl.value = ''; keyEl.placeholder = '••••••••••••••••••• (saved)'; }
      if (status) status.textContent = '';
      this._toast('Rotageek credentials saved', 'success');
      this.renderRotageekStatus();
    } catch (e) {
      this._toast('Save failed: ' + e.message, 'error');
    }
  },

  async testRotageek() {
    const status = document.getElementById('rgActionStatus');
    if (status) status.textContent = 'Testing…';
    try {
      const st = await API.get('/api/rotageek/status');
      if (!st.connected) {
        if (status) status.textContent = 'No credentials saved — save a key first.';
        return;
      }
      // Light round-trip through the server-side proxy to see if Rotageek responds
      await API.post('/api/rotageek/fetch', { path: '/api/me' });
      if (status) status.textContent = '✓ Rotageek responded — connection looks good.';
    } catch (e) {
      if (status) status.textContent = 'Rotageek not reachable with these credentials yet (' + e.message + '). Expected until API access is granted.';
    }
  },

  async disconnectRotageek() {
    if (!confirm('Clear the saved Rotageek credentials?')) return;
    try {
      await API.delete('/api/rotageek/disconnect');
      const keyEl = document.getElementById('rgApiKey');
      if (keyEl) { keyEl.value = ''; keyEl.placeholder = 'Paste your API key or token'; }
      this._toast('Rotageek credentials cleared', 'success');
      this.renderRotageekStatus();
    } catch (e) {
      this._toast('Failed: ' + e.message, 'error');
    }
  },

  _clearGcalQuery() {
    try { history.replaceState(null, '', location.pathname + '#settings'); } catch (_) {}
  },

  async renderGoogleCalendar() {
    let st;
    try { st = await (await fetch('/api/google/status')).json(); } catch (e) { return; }
    this._gcalStatus = st;

    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('gcalClientId',    st.clientId    || '');
    setVal('gcalRedirect',    st.redirectUri || (location.origin + '/api/google/callback'));
    this._checkRedirect();
    setVal('gcalCalId',       st.calendarId  || 'primary');
    setVal('gcalEventTitle',  st.eventTitle  || 'Screwfix Shift');
    const freq = document.getElementById('gcalAutoFreq'); if (freq) freq.value = String(st.autosyncInterval || 0);
    const en = document.getElementById('gcalEnabled'); if (en) en.checked = !!st.enabled;
    // Make sure the saved calendar shows in the dropdown even before the list loads
    this._ensureCalOption(st.calendarId || 'primary');
    if (st.connected) this._loadCalendars();
    this._renderSyncLog();

    const badge = document.getElementById('gcalStatusBadge');
    if (badge) {
      let html;
      if (!st.available) {
        html = '<span style="color:var(--danger)">⚠ The googleapis package isn\'t installed yet — run <code>npm install</code> and restart the server.</span>';
      } else if (st.needsReconnect) {
        html = '<div style="padding:10px 12px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:6px">' +
          '<strong style="color:var(--danger)">⚠ Reconnect needed</strong>' +
          '<div style="font-size:12.5px;color:var(--text-muted);margin-top:4px">' +
          'Google access expired or was revoked (<code>invalid_grant</code>) — this happens automatically ' +
          'after about 7 days while the app is in "Testing" mode in Google Cloud Console. Click ' +
          '“Reconnect Google account” below to restore the link.</div></div>';
      } else if (st.connected) {
        html = '<span style="color:var(--success, #10b981)">● Connected to Google</span>' +
               (st.enabled ? '' : ' <span style="color:var(--text-muted)">(auto-sync is off)</span>');
      } else if (st.hasCredentials) {
        html = '<span style="color:var(--warning, #f59e0b)">● Credentials saved — click “Connect Google account” to authorise.</span>';
      } else {
        html = '<span style="color:var(--text-muted)">● Not set up. Enter your OAuth credentials below, save, then connect.</span>';
      }
      badge.innerHTML = html;
    }

    const connectBtn = document.getElementById('gcalConnectBtn');
    if (connectBtn) connectBtn.textContent = st.connected ? 'Reconnect Google account' : 'Connect Google account';
    const disc = document.getElementById('gcalDisconnectBtn');
    if (disc) disc.style.display = st.connected ? '' : 'none';
    ['gcalSyncAllBtn','gcalSyncPastBtn','gcalReconcileBtn'].forEach(id => {
      const b = document.getElementById(id); if (b) b.style.display = st.connected ? '' : 'none';
    });
  },

  // Google rejects OAuth redirects to private IPs / plain http. Warn the user.
  _checkRedirect() {
    const inp  = document.getElementById('gcalRedirect');
    const warn = document.getElementById('gcalRedirectWarn');
    if (!inp || !warn) return;
    const url = inp.value.trim();
    let msg = '';
    if (url) {
      const isHttps   = /^https:\/\//i.test(url);
      const isLocal   = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url);
      const isPrivate = /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url) ||
                        /^https?:\/\/[^/]*\.local(:|\/)/i.test(url);
      if (isPrivate) {
        msg = '⚠ Google won\'t allow a private/LAN address here. Use your public https:// Cloudflare domain (open the app on that address, then Save).';
      } else if (!isHttps && !isLocal) {
        msg = '⚠ Google requires https for this (or http://localhost). Use your public https:// Cloudflare domain.';
      }
    }
    warn.style.display = msg ? 'block' : 'none';
    warn.textContent = msg;
  },

  _selectedCalendarId() {
    const box = document.getElementById('gcalCalId');
    if (box && box.style.display !== 'none' && box.value.trim()) return box.value.trim();
    const sel = document.getElementById('gcalCalSelect');
    return (sel && sel.value) || 'primary';
  },

  _ensureCalOption(id) {
    const sel = document.getElementById('gcalCalSelect');
    if (!sel || !id) return;
    if (![...sel.options].some(o => o.value === id)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = id === 'primary' ? 'Primary calendar' : id;
      sel.appendChild(o);
    }
    sel.value = id;
  },

  async _loadCalendars(force) {
    const sel = document.getElementById('gcalCalSelect');
    if (!sel) return;
    if (this._calsLoaded && !force) return;
    try {
      const resp = await fetch('/api/google/calendars');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || ('Server returned ' + resp.status));
      const current = this._selectedCalendarId();
      sel.innerHTML = (data.calendars || []).map(c =>
        `<option value="${c.id}">${c.summary}${c.primary ? ' (primary)' : ''}</option>`
      ).join('') || '<option value="primary">Primary calendar</option>';
      this._ensureCalOption(current);
      this._calsLoaded = true;
      if (force) this._toast('Calendar list refreshed', 'success');
    } catch (e) {
      if (force) this._toast('Could not load calendars: ' + e.message, 'error');
    }
  },

  _gcalPayload() {
    const v = id => document.getElementById(id)?.value ?? '';
    const payload = {
      client_id:    v('gcalClientId').trim(),
      redirect_uri: v('gcalRedirect').trim(),
      calendar_id:  this._selectedCalendarId(),
      event_title:  v('gcalEventTitle').trim() || 'Screwfix Shift',
      autosync_interval: parseInt(v('gcalAutoFreq'), 10) || 0,
      enabled:      document.getElementById('gcalEnabled')?.checked || false,
    };
    const secret = v('gcalClientSecret').trim();
    if (secret) payload.client_secret = secret;   // only send if changed
    return payload;
  },

  async saveGoogleConfig(silent) {
    try {
      const resp = await fetch('/api/google/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._gcalPayload()),
      });
      if (!resp.ok) throw new Error('Server returned ' + resp.status);
      const secretEl = document.getElementById('gcalClientSecret'); if (secretEl) secretEl.value = '';
      await this.renderGoogleCalendar();
      if (!silent) this._toast('Google Calendar settings saved', 'success');
      return true;
    } catch (e) {
      this._toast('Could not save: ' + e.message, 'error');
      return false;
    }
  },

  async connectGoogle() {
    // Save credentials first so the server can build the OAuth client, then redirect
    const ok = await this.saveGoogleConfig(true);
    if (!ok) return;
    if (!document.getElementById('gcalClientId')?.value.trim()) {
      this._toast('Enter your Client ID first', 'error'); return;
    }
    window.location.href = '/api/google/auth';
  },

  async disconnectGoogle() {
    if (!confirm('Disconnect Google Calendar? Existing events stay, but shifts will stop syncing.')) return;
    try {
      await fetch('/api/google/disconnect', { method: 'POST' });
      await this.renderGoogleCalendar();
      this._toast('Disconnected from Google', 'success');
    } catch (e) { this._toast('Error: ' + e.message, 'error'); }
  },

  async syncAllGoogle(futureOnly) {
    if (futureOnly === undefined) futureOnly = true;
    const scope = futureOnly ? 'upcoming' : 'all';
    await this._runGcalJob({
      url: '/api/google/sync-all',
      body: { futureOnly: futureOnly },
      label: 'Syncing ' + scope + ' shifts',
      doneMsg: d => `Synced ${d.synced} of ${d.total} ${scope} shift${d.total === 1 ? '' : 's'}` + (d.failed ? `, ${d.failed} failed (rate-limited — try again to finish)` : ''),
    });
  },

  async reconcileGoogle() {
    if (!confirm('Clean up calendar?\n\nThis re-syncs every shift to the correct day, then DELETES any "' +
                 (document.getElementById('gcalEventTitle')?.value.trim() || 'Screwfix Shift') +
                 '" events that no longer match a shift (e.g. stuck on the wrong day). Your other calendar events are untouched.\n\nThis can take a minute or two for lots of shifts — watch the activity list below.')) return;
    await this._runGcalJob({
      url: '/api/google/reconcile',
      body: { futureOnly: false },
      label: 'Cleaning up',
      doneMsg: d => d.skippedCleanup
        ? `Re-synced ${d.synced}, but ${d.failed} shift(s) were rate-limited so no deletions were made. Run “Clean up” again in a minute to finish safely.`
        : `Re-synced ${d.synced}, removed ${d.deleted} stray event${d.deleted === 1 ? '' : 's'}` + (d.failed ? `, ${d.failed} failed` : ''),
    });
  },

  // Shared runner: fires a long sync/cleanup job and shows live progress by
  // polling the sync log (which the server writes to as it processes each item).
  async _runGcalJob({ url, body, label, doneMsg }) {
    const statusEl = document.getElementById('gcalActionStatus');
    const btns = ['gcalSyncAllBtn', 'gcalSyncPastBtn', 'gcalReconcileBtn']
      .map(id => document.getElementById(id)).filter(Boolean);
    btns.forEach(b => b.disabled = true);

    // Baseline log count so we can show "N events processed"
    let baseTotal = 0;
    try { baseTotal = (await (await fetch('/api/google/sync-log?limit=1')).json()).total || 0; } catch (_) {}

    let polling = true;
    const dots = ['', '.', '..', '...'];
    let tickN = 0;
    const poll = async () => {
      if (!polling) return;
      try {
        const d = await (await fetch('/api/google/sync-log?limit=100')).json();
        this._paintSyncLog(d);
        const delta = Math.max(0, (d.total || 0) - baseTotal);
        if (statusEl) statusEl.textContent = `${label}${dots[tickN++ % 4]} ${delta} processed`;
      } catch (_) {}
      if (polling) this._gcalPollTimer = setTimeout(poll, 1000);
    };
    poll();

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      polling = false; clearTimeout(this._gcalPollTimer);
      if (!resp.ok) throw new Error(data.error || ('Server returned ' + resp.status));
      await this._renderSyncLog();
      const msg = doneMsg(data);
      if (statusEl) statusEl.textContent = msg;
      this._toast(msg, (data.failed || data.skippedCleanup) ? 'error' : 'success');
    } catch (e) {
      polling = false; clearTimeout(this._gcalPollTimer);
      if (statusEl) statusEl.textContent = '';
      this._toast((label || 'Job') + ' failed: ' + e.message, 'error');
    } finally {
      btns.forEach(b => b.disabled = false);
    }
  },

  async _renderSyncLog() {
    const wrap = document.getElementById('gcalSyncLog');
    if (!wrap) return;
    try {
      const resp = await fetch('/api/google/sync-log?limit=100');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || ('Server returned ' + resp.status));
      this._paintSyncLog(data);
    } catch (e) {
      wrap.innerHTML = `<p style="padding:12px;color:var(--danger);font-size:13px;margin:0">${e.message}</p>`;
    }
  },

  _paintSyncLog(data) {
    const wrap = document.getElementById('gcalSyncLog');
    if (!wrap) return;
    if (!data || !data.rows || !data.rows.length) {
      wrap.innerHTML = '<p style="padding:12px;color:var(--text-muted);font-size:13px;margin:0">No activity yet.</p>';
      return;
    }
    const badge = a => ({
      created: '<span class="badge badge-success">created</span>',
      updated: '<span class="badge badge-info">updated</span>',
      deleted: '<span class="badge badge-danger">deleted</span>',
      error:   '<span class="badge badge-warning">error</span>',
    }[a] || `<span class="badge">${a}</span>`);
    wrap.innerHTML = `
      <table class="data-table" style="width:100%;font-size:12px">
        <tbody>
          ${data.rows.map(r => `
            <tr>
              <td style="white-space:nowrap;color:var(--text-muted)">${new Date(r.created_at + 'Z').toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
              <td>${badge(r.action)}</td>
              <td style="white-space:nowrap">${r.shift_date || ''}</td>
              <td style="color:${r.status === 'error' ? 'var(--danger)' : 'var(--text-muted)'}">${r.detail || (r.shift_id ? 'shift #' + r.shift_id : '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  },

  populateGeneral() {
    document.getElementById('setDefaultDist').value      = this.settings.default_distance_miles    || '3.6';
    document.getElementById('setName').value              = this.settings.employee_name             || '';
    document.getElementById('setEmployer').value          = this.settings.employer                  || '';
    document.getElementById('setLeaveYearStart').value    = this.settings.leave_year_start           || '04-01';
    const jsdEl = document.getElementById('setJobStartDate');
    if (jsdEl) jsdEl.value = this.settings.job_start_date || '';
    const dobEl = document.getElementById('setUserDob');
    if (dobEl) dobEl.value = this.settings.user_dob || '';
  },

  populateClockThresholds() {
    const oldEarly = this.settings.clock_early_threshold ?? 5;
    const oldLate  = this.settings.clock_late_threshold  ?? 5;
    document.getElementById('setClockInEarly').value  = this.settings.clock_in_early_threshold  ?? oldEarly;
    document.getElementById('setClockInLate').value   = this.settings.clock_in_late_threshold   ?? oldLate;
    document.getElementById('setClockOutEarly').value = this.settings.clock_out_early_threshold ?? oldEarly;
    document.getElementById('setClockOutLate').value  = this.settings.clock_out_late_threshold  ?? oldLate;
  },

  renderDelivSchedules() {
    const el = document.getElementById('delivSchedBody');
    if (!el) return;
    const list = this.delivSchedList || [];
    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    if (!list.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No delivery schedules yet. Add one to track delivery days.</p>';
      return;
    }
    const sorted = [...list].sort((a,b) => b.effective_from.localeCompare(a.effective_from));
    el.innerHTML = `
      <table class="data-table" style="width:100%">
        <thead><tr><th>From</th><th>Days</th><th></th></tr></thead>
        <tbody>
          ${sorted.map(s => {
            const dayLabels = s.days.split(',').map(d => DOW_NAMES[+d.trim()] || d).join(', ');
            return `<tr>
              <td>${s.effective_from}</td>
              <td>${dayLabels}</td>
              <td style="text-align:right">
                <button class="btn btn-ghost btn-sm" onclick="SettingsView.editDelivSchedule(${s.id}, '${s.effective_from}', '${s.days}')">Edit</button>
                <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="SettingsView.deleteDelivSchedule(${s.id})">Delete</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  },

  _delivScheduleModal(id, effective_from, days) {
    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const daySet = new Set((days || '').split(',').map(d => d.trim()));
    const existing = document.getElementById('delivSchedModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'delivSchedModal';
    modal.style.cssText = [
      'position:fixed','inset:0','background:rgba(0,0,0,0.5)',
      'z-index:9999','display:flex','align-items:center','justify-content:center',
      'padding:16px','box-sizing:border-box'
    ].join(';');
    modal.innerHTML = `
      <div style="background:var(--card-bg);border-radius:12px;padding:24px;
                  width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.35);
                  color:var(--text);font-family:inherit">
        <h3 style="margin:0 0 18px;font-size:15px;font-weight:600;color:var(--text)">
          ${id ? 'Edit' : 'Add'} Delivery Schedule
        </h3>

        <div style="margin-bottom:14px">
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:5px">
            Effective from
          </label>
          <input type="date" id="dsFrm" value="${effective_from || ''}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
                   background:var(--bg);color:var(--text);font-size:13px;box-sizing:border-box" />
        </div>

        <div style="margin-bottom:20px">
          <label style="display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">
            Delivery days
          </label>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
            ${DOW_NAMES.map((name, i) => `
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;
                            font-size:13px;color:var(--text);padding:4px 2px">
                <input type="checkbox" class="dsDow" value="${i}"
                  ${daySet.has(String(i)) ? 'checked' : ''}
                  style="width:14px;height:14px;cursor:pointer;accent-color:var(--primary)" />
                ${name}
              </label>
            `).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost" onclick="document.getElementById('delivSchedModal').remove()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="SettingsView._saveDelivSchedule(${id || 'null'})">
            Save
          </button>
        </div>
      </div>
    `;
    // Close on backdrop click
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  },

  addDelivSchedule() {
    this._delivScheduleModal(null, '', '');
  },

  editDelivSchedule(id, effective_from, days) {
    this._delivScheduleModal(id, effective_from, days);
  },

  async _saveDelivSchedule(id) {
    const effective_from = document.getElementById('dsFrm').value;
    const days = [...document.querySelectorAll('.dsDow:checked')].map(c => c.value).join(',');
    if (!effective_from) { showToast('Please set a date', 'error'); return; }
    if (!days) { showToast('Please select at least one day', 'error'); return; }
    try {
      if (id) {
        await API.put(`/api/delivery-schedules/${id}`, { effective_from, days });
      } else {
        await API.post('/api/delivery-schedules', { effective_from, days });
      }
      document.getElementById('delivSchedModal')?.remove();
      this.delivSchedList = await API.get('/api/delivery-schedules');
      this.renderDelivSchedules();
      showToast('Delivery schedule saved', 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteDelivSchedule(id) {
    if (!confirm('Delete this delivery schedule?')) return;
    try {
      await API.delete(`/api/delivery-schedules/${id}`);
      this.delivSchedList = await API.get('/api/delivery-schedules');
      this.renderDelivSchedules();
      showToast('Deleted', 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  renderMilestones() {
    const section = document.getElementById('milestonesSection');
    const body    = document.getElementById('milestonesBody');
    if (!section || !body) return;
    const startStr = this.settings.job_start_date;
    if (!startStr) { section.style.display = 'none'; return; }
    const start = new Date(startStr + 'T00:00:00');
    const now   = new Date();
    if (isNaN(start.getTime())) { section.style.display = 'none'; return; }
    section.style.display = '';

    const diffDays = Math.floor((now - start) / 86400000);
    const diffMonths = Math.floor(diffDays / 30.44);
    const years  = Math.floor(diffMonths / 12);
    const months = diffMonths % 12;

    const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Next milestones: 6, 12, 18, 24, 36 months
    const milestones = [6, 12, 18, 24, 36, 48, 60];
    const nextRows = milestones.map(m => {
      const ms = new Date(start);
      ms.setMonth(ms.getMonth() + m);
      const diff = Math.ceil((ms - now) / 86400000);
      if (diff < -30) return null; // Skip if more than a month past
      const label = m % 12 === 0 ? `${m/12} year${m/12 > 1 ? 's' : ''}` : `${m} months`;
      const isFuture = diff > 0;
      return `<tr>
        <td>${label}</td>
        <td>${fmtDate(ms)}</td>
        <td style="color:${isFuture ? 'var(--text-muted)' : 'var(--success)'}">${isFuture ? `In ${diff} day${diff !== 1 ? 's' : ''}` : `${Math.abs(diff)} days ago`}</td>
      </tr>`;
    }).filter(Boolean).join('');

    body.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
        <div class="stat-card" style="min-width:140px">
          <div class="stat-label">Time employed</div>
          <div class="stat-value">${years > 0 ? `${years}y ` : ''}${months}m</div>
          <div style="font-size:11px;color:var(--text-muted)">${diffDays} days total</div>
        </div>
        <div class="stat-card" style="min-width:140px">
          <div class="stat-label">Start date</div>
          <div class="stat-value" style="font-size:16px">${fmtDate(start)}</div>
        </div>
      </div>
      ${nextRows ? `<h4 style="font-size:13px;color:var(--text-muted);font-weight:600;margin-bottom:8px">Milestones</h4>
      <div class="table-wrapper"><table>
        <thead><tr><th>Milestone</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>${nextRows}</tbody>
      </table></div>` : ''}
    `;
  },

  async saveClockThresholds() {
    try {
      await API.saveSettings({
        clock_in_early_threshold:  document.getElementById('setClockInEarly').value  || '5',
        clock_in_late_threshold:   document.getElementById('setClockInLate').value   || '5',
        clock_out_early_threshold: document.getElementById('setClockOutEarly').value || '5',
        clock_out_late_threshold:  document.getElementById('setClockOutLate').value  || '5',
        clock_early_threshold: document.getElementById('setClockInEarly').value || '5',
        clock_late_threshold:  document.getElementById('setClockInLate').value  || '5',
      });
      if (window.App) App.settings = await API.getSettings();
      this.settings = await API.getSettings();
      showToast('Clock thresholds saved', 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  async saveGeminiKey() {
    const key    = document.getElementById('setGeminiKey').value.trim();
    const model  = document.getElementById('setGeminiModel').value;
    const status = document.getElementById('geminiKeySavedStatus');
    try {
      const data = { gemini_model: model };
      if (key) data.gemini_api_key = key;
      await API.saveSettings(data);
      if (key) {
        document.getElementById('setGeminiKey').value = '';
        document.getElementById('setGeminiKey').placeholder = '••••••••••••••••••• (saved)';
      }
      status.textContent = '✓ Saved';
      showToast('Gemini settings saved', 'success');
      if (window.App) App.settings = await API.getSettings();
    } catch(e) {
      status.textContent = '';
      showToast('Failed to save: ' + e.message, 'error');
    }
  },

  async saveGeneral() {
    const data = {
      default_distance_miles:    document.getElementById('setDefaultDist').value,
      employee_name:             document.getElementById('setName').value,
      employer:                  document.getElementById('setEmployer').value,
      leave_year_start:          document.getElementById('setLeaveYearStart').value,
      job_start_date:            document.getElementById('setJobStartDate').value,
      user_dob:                  document.getElementById('setUserDob').value,
    };
    try {
      await API.saveSettings(data);
      showToast('Settings saved', 'success');
      // Update the app-level settings cache and re-render milestones
      if (window.App) App.settings = await API.getSettings();
      this.settings = await API.getSettings();
      this.renderMilestones();
    } catch(e) { showToast(e.message, 'error'); }
  },

  renderPayRates() {
    const el = document.getElementById('payRatesBody');
    if (!this.payRates.length) {
      el.innerHTML = '<p style="color:var(--text-muted)">No pay rates configured.</p>';
      return;
    }

    const sorted = [...this.payRates].sort((a,b) => b.effective_date.localeCompare(a.effective_date));

    el.innerHTML = sorted.map(r => `
      <div class="pay-rate-card">
        <div class="pay-rate-info">
          <div class="pay-rate-date">Effective from ${fmtDate(r.effective_date)}</div>
          <div class="pay-rate-details">£${Number(r.hourly_rate).toFixed(2)}/hr · ${r.contracted_hours_per_week}h/week contract</div>
          ${r.notes ? `<div class="pay-rate-sub">${esc(r.notes)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-icon edit-rate-btn" title="Edit" data-id="${r.id}">✏️</button>
          <button class="btn-icon danger delete-rate-btn" title="Delete" data-id="${r.id}">🗑️</button>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('.edit-rate-btn').forEach(btn =>
      btn.addEventListener('click', () => this.openEditRateModal(+btn.dataset.id))
    );
    el.querySelectorAll('.delete-rate-btn').forEach(btn =>
      btn.addEventListener('click', () => this.deleteRate(+btn.dataset.id))
    );
  },

  openAddRateModal() {
    Modal.open('Add Pay Rate', this.rateFormHtml({}));
    document.getElementById('rateSaveBtn').addEventListener('click', () => this.saveRateForm(null));
  },

  openEditRateModal(id) {
    const rate = this.payRates.find(r => r.id === id);
    if (!rate) return;
    Modal.open('Edit Pay Rate', this.rateFormHtml(rate));
    document.getElementById('rateSaveBtn').addEventListener('click', () => this.saveRateForm(id));
  },

  rateFormHtml(r = {}) {
    return `
      <div class="form-group">
        <label>Effective From *</label>
        <input type="date" id="rateDate" value="${esc(r.effective_date || '')}" />
        <div class="form-hint">The date this rate takes effect. Shifts on or after this date will use this rate.</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Hourly Rate (£) *</label>
          <input type="number" id="rateHourly" step="0.01" value="${r.hourly_rate || ''}" placeholder="e.g. 13.48" />
        </div>
        <div class="form-group">
          <label>Contracted Hours/Week *</label>
          <input type="number" id="rateContracted" step="0.5" value="${r.contracted_hours_per_week || ''}" placeholder="e.g. 20" />
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input type="text" id="rateNotes" value="${esc(r.notes || '')}" placeholder="e.g. April 2025 pay rise" />
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-primary" id="rateSaveBtn">Save Rate</button>
      </div>`;
  },

  async saveRateForm(editId) {
    const effective_date            = document.getElementById('rateDate').value;
    const hourly_rate               = parseFloat(document.getElementById('rateHourly').value);
    const contracted_hours_per_week = parseFloat(document.getElementById('rateContracted').value);
    const notes                     = document.getElementById('rateNotes').value.trim() || null;

    if (!effective_date || isNaN(hourly_rate) || isNaN(contracted_hours_per_week)) {
      showToast('All required fields must be filled', 'error'); return;
    }

    try {
      if (editId) {
        await API.updatePayRate(editId, { effective_date, hourly_rate, contracted_hours_per_week, notes });
        showToast('Pay rate updated');
      } else {
        await API.createPayRate({ effective_date, hourly_rate, contracted_hours_per_week, notes });
        showToast('Pay rate added', 'success');
      }
      Modal.close();
      await this.load();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async deleteRate(id) {
    if (!confirmAction('Delete this pay rate? Shifts already saved keep their stored rate.')) return;
    try {
      await API.deletePayRate(id);
      showToast('Pay rate deleted');
      await this.load();
    } catch(e) { showToast(e.message, 'error'); }
  },

  // ── Backup & Restore ────────────────────────────────────────────────────────

  async downloadBackup() {
    const statusEl = document.getElementById('backupStatus');
    try {
      statusEl.textContent = 'Preparing backup…';
      const data = await API.getBackup();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const _n = new Date();
      const date = `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;
      a.href     = url;
      a.download = `rota-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      statusEl.textContent = `✓ Backup downloaded (${date})`;
      showToast('Backup downloaded ✓', 'success');
    } catch(e) {
      statusEl.textContent = '';
      showToast('Backup failed: ' + e.message, 'error');
    }
  },

  _restorePayload: null,

  loadRestoreFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        this._restorePayload = data;

        const meta = data.meta || {};
        const counts = [
          ['shifts',    data.shifts?.length        || 0],
          ['payslips',  data.payslips?.length       || 0],
          ['pay rates', data.pay_rates?.length      || 0],
          ['leave',     data.leave_entries?.length  || 0],
          ['notes',     data.calendar_notes?.length || 0],
        ].map(([label, count]) => `<span class="badge badge-success">${count} ${label}</span>`).join(' ');

        const previewEl = document.getElementById('restorePreview');
        previewEl.style.display = 'block';
        previewEl.innerHTML = `
          <div style="padding:10px 12px;background:var(--bg);border-radius:8px;font-size:13px">
            <strong>Backup from:</strong> ${meta.exported_at ? new Date(meta.exported_at).toLocaleString() : 'unknown date'}
            <br /><strong>Contains:</strong> ${counts}
          </div>`;

        document.getElementById('restoreBtn').style.display = '';
      } catch(_) {
        showToast('Invalid backup file — must be a JSON file from this app', 'error');
        this._restorePayload = null;
        document.getElementById('restoreBtn').style.display = 'none';
        document.getElementById('restorePreview').style.display = 'none';
      }
    };
    reader.readAsText(file);
  },

  async recalcShifts() {
    const btn    = document.getElementById('recalcShiftsBtn');
    const status = document.getElementById('recalcStatus');
    btn.disabled = true;
    status.textContent = 'Recalculating…';
    try {
      const result = await API.post('/api/shifts/recalculate', {});
      const bhNote = result.bankHolidaysFixed ? ` (${result.bankHolidaysFixed} bank holiday shift${result.bankHolidaysFixed !== 1 ? 's' : ''} corrected to double pay)` : '';
      status.textContent = `✓ ${result.updated} shift${result.updated !== 1 ? 's' : ''} updated${bhNote}`;
      showToast(`Recalculated ${result.updated} shifts ✓${bhNote}`, 'success');
    } catch(e) {
      status.textContent = '';
      showToast('Recalculate failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  async doRestore() {
    if (!this._restorePayload) { showToast('No backup file loaded', 'error'); return; }
    if (!confirmAction('⚠️ This will REPLACE ALL your current data with the backup. Are you sure?')) return;
    try {
      const result = await API.postRestore(this._restorePayload);
      showToast(`Restore complete ✓ — ${result.message || 'data replaced'}`, 'success');
      this._restorePayload = null;
      document.getElementById('restoreFileName').textContent = 'No file selected';
      document.getElementById('restoreBtn').style.display = 'none';
      document.getElementById('restorePreview').style.display = 'none';
      document.getElementById('restoreFileInput').value = '';
      await this.load();
    } catch(e) { showToast('Restore failed: ' + e.message, 'error'); }
  },

};
