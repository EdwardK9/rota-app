/* ─── Notifications & Auto-Sync View ─────────────────────────────────────── */

const NotificationsView = {

  _reminders: [],   // array of minute numbers (pre-shift reminders)

  async init() {
    this.render();
    await this.loadSettings();
  },

  render() {
    document.getElementById('view-notifications').innerHTML = `
      <div style="max-width:640px">
        <div class="card">
          <div class="card-header"><h2>Notifications &amp; Auto-Sync</h2></div>
          <div class="card-body">
            <p style="font-size:13.5px;color:var(--text-muted);margin-bottom:16px">
              Automatically pulls shifts from Rotageek and sends a phone notification
              if anything changed. Uses <a href="https://ntfy.sh" target="_blank">ntfy.sh</a> — free, open-source push.
              Install the <strong>ntfy</strong> app on your phone and subscribe to your topic.
            </p>

            <div class="form-row">
              <div class="form-group">
                <label>Rotageek Password (for auto re-auth)</label>
                <input type="password" id="nfRgPassword" placeholder="Stored securely in local DB" autocomplete="new-password" />
                <div class="form-hint">Lets the server log back in automatically if the session expires.</div>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="nfAutosyncEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Enable auto-sync
                </label>
                <select id="nfAutosyncInterval" class="form-select" style="width:160px">
                  <option value="0.25">Every 15 min</option>
                  <option value="0.5">Every 30 min</option>
                  <option value="1">Every hour</option>
                  <option value="4">Every 4 hours</option>
                  <option value="6">Every 6 hours</option>
                  <option value="12">Every 12 hours</option>
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label>ntfy Topic</label>
                <input type="text" id="nfNtfyTopic" placeholder="my-rota-alerts-abc123" />
                <div class="form-hint">Pick something unique — anyone who knows it can subscribe.</div>
              </div>
              <div class="form-group">
                <label>ntfy Server</label>
                <input type="text" id="nfNtfyServer" placeholder="https://ntfy.sh" />
                <div class="form-hint">Leave as https://ntfy.sh unless self-hosting.</div>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0">
                  <input type="checkbox" id="nfNtfyEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Enable notifications
                </label>
              </div>
              <div class="form-group">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0">
                  <input type="checkbox" id="nfDisconnectAlert" style="width:16px;height:16px;cursor:pointer" />
                  Alert when Rotageek session disconnects
                </label>
                <div class="form-hint">Disable to silence the "session expired" notification.</div>
              </div>
            </div>

            <!-- Shift reminders -->
            <div class="form-row" style="flex-direction:column;gap:8px;margin-top:8px">
              <label style="font-size:13px;font-weight:600;margin:0">Shift reminders</label>
              <div class="form-hint" style="margin-top:0">
                Send a notification this many minutes before each shift starts.
                Add as many as you like — 30, 60, 90 min or a custom value.
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
                <button class="btn btn-ghost btn-sm nfReminderPreset" data-mins="30">30 min</button>
                <button class="btn btn-ghost btn-sm nfReminderPreset" data-mins="60">1 hour</button>
                <button class="btn btn-ghost btn-sm nfReminderPreset" data-mins="90">90 min</button>
                <button class="btn btn-ghost btn-sm nfReminderPreset" data-mins="120">2 hours</button>
              </div>
              <div id="nfReminderChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px"></div>
              <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                <input type="number" id="nfAddReminderInput" class="form-select" style="width:100px"
                  min="1" max="1440" placeholder="mins" />
                <button class="btn btn-secondary btn-sm" id="nfAddReminderBtn">+ Add</button>
              </div>
            </div>

            <!-- Weekly team JSON upload reminder -->
            <div class="form-row" style="flex-direction:column;gap:8px;margin-top:8px">
              <label style="font-size:13px;font-weight:600;margin:0">📸 Weekly team JSON reminder</label>
              <div class="form-hint" style="margin-top:0">
                Every Monday, a reminder to upload last week's team schedule via Team Upload —
                the best way to keep everyone's Team Calendar up to date.
              </div>
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px">
                <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="nfJsonReminderEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Remind me
                </label>
                <input type="time" id="nfJsonReminderTime" class="form-select" style="width:130px" />
              </div>
            </div>

            <!-- Birthday reminder -->
            <div class="form-row" style="flex-direction:column;gap:8px;margin-top:8px">
              <label style="font-size:13px;font-weight:600;margin:0">🎂 Birthday reminders</label>
              <div class="form-hint" style="margin-top:0">
                A short notification on a colleague's birthday (set on their Manage People / Leaderboard entry).
              </div>
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px">
                <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="nfBirthdayEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Remind me
                </label>
                <input type="time" id="nfBirthdayTime" class="form-select" style="width:130px" />
              </div>
            </div>

            <!-- Arrival reminder -->
            <div class="form-row" style="flex-direction:column;gap:8px;margin-top:8px">
              <label style="font-size:13px;font-weight:600;margin:0">👋 Colleague arriving soon</label>
              <div class="form-hint" style="margin-top:0">
                A short notification shortly before a colleague's shift is due to start (based on Team Rota data). Kept brief so it fits on a watch.
              </div>
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px">
                <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="nfArrivalEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Remind me
                </label>
                <span style="font-size:13px;color:var(--text-muted)">min before</span>
                <input type="number" id="nfArrivalLeadMins" class="form-select" style="width:90px" min="1" max="120" />
              </div>
              <label style="margin:4px 0 0;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                <input type="checkbox" id="nfArrivalOnlyOnShift" style="width:16px;height:16px;cursor:pointer" />
                Only while I'm on shift
              </label>
              <div class="form-hint" style="margin-top:0">
                Only notify about colleagues whose start time falls within your own shift that day — no pings on days off or after you've left.
              </div>
            </div>

            <!-- Commute weather nudge -->
            <div class="form-row" style="flex-direction:column;gap:8px;margin-top:8px">
              <label style="font-size:13px;font-weight:600;margin:0">🌦️ Commute weather nudge</label>
              <div class="form-hint" style="margin-top:0">
                The evening before a shift, a heads-up if tomorrow's commute forecast has a frost or rain
                alert — same alert logic as the dashboard's weather badge, just pushed ahead of time instead
                of only showing up when you open the app.
              </div>
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px">
                <label style="margin:0;display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input type="checkbox" id="nfWeatherEnabled" style="width:16px;height:16px;cursor:pointer" />
                  Remind me at
                </label>
                <input type="time" id="nfWeatherTime" class="form-select" style="width:130px" />
              </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:16px">
              <button class="btn btn-primary" id="nfSaveBtn">Save</button>
              <button class="btn btn-secondary" id="nfTestBtn">Test notification</button>
              <button class="btn btn-secondary" id="nfTestReminderBtn">Test shift reminder</button>
              <button class="btn btn-secondary" id="nfTestJsonReminderBtn">Test JSON reminder</button>
              <button class="btn btn-secondary" id="nfTestBirthdayBtn">Test birthday</button>
              <button class="btn btn-secondary" id="nfTestArrivalBtn">Test arrival</button>
              <button class="btn btn-secondary" id="nfSyncNowBtn">Sync now</button>
            </div>

            <div id="nfStatus" style="margin-top:12px;font-size:13px;color:var(--text-muted)"></div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('nfSaveBtn').addEventListener('click',          () => this.saveSettings());
    document.getElementById('nfTestBtn').addEventListener('click',           () => this.testNtfy());
    document.getElementById('nfTestReminderBtn').addEventListener('click',   () => this.testReminder());
    document.getElementById('nfTestJsonReminderBtn').addEventListener('click', () => this.testJsonReminder());
    document.getElementById('nfTestBirthdayBtn').addEventListener('click',   () => this.testBirthday());
    document.getElementById('nfTestArrivalBtn').addEventListener('click',    () => this.testArrival());
    document.getElementById('nfSyncNowBtn').addEventListener('click',        () => this.runSyncNow());
    document.getElementById('nfAddReminderBtn').addEventListener('click', () => this.addReminder());
    document.getElementById('nfAddReminderInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.addReminder();
    });
    document.querySelectorAll('.nfReminderPreset').forEach(btn => {
      btn.addEventListener('click', () => this.addReminder(parseInt(btn.dataset.mins)));
    });
  },

  addReminder(mins) {
    const m = mins ?? parseInt(document.getElementById('nfAddReminderInput').value);
    if (!m || m < 1) return;
    if (!this._reminders.includes(m)) {
      this._reminders.push(m);
      this._reminders.sort((a, b) => a - b);
      this.renderReminderChips();
    }
    const el = document.getElementById('nfAddReminderInput');
    if (el) el.value = '';
  },

  removeReminder(m) {
    this._reminders = this._reminders.filter(x => x !== m);
    this.renderReminderChips();
  },

  renderReminderChips() {
    const container = document.getElementById('nfReminderChips');
    if (!container) return;
    if (!this._reminders.length) {
      container.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">None set.</span>';
      return;
    }
    container.innerHTML = this._reminders.map(m => {
      const label = m >= 60
        ? (m % 60 === 0 ? `${m/60}h` : `${Math.floor(m/60)}h ${m%60}m`)
        : `${m} min`;
      return `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--card-bg);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:13px">
        ${label}
        <button onclick="NotificationsView.removeReminder(${m})" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:15px;line-height:1;padding:0">×</button>
      </span>`;
    }).join('');
  },

  async loadSettings() {
    try {
      const s = await fetch('/api/rotageek/autosync-status').then(r => r.json());
      document.getElementById('nfAutosyncEnabled').checked    = !!s.enabled;
      document.getElementById('nfNtfyTopic').value            = s.ntfyTopic  || '';
      document.getElementById('nfNtfyServer').value           = s.ntfyServer || 'https://ntfy.sh';
      document.getElementById('nfNtfyEnabled').checked        = !!s.ntfyEnabled;
      document.getElementById('nfDisconnectAlert').checked    = s.ntfyDisconnectAlert !== false;
      const intEl = document.getElementById('nfAutosyncInterval');
      if (intEl) intEl.value = String(s.interval || 1);
      document.getElementById('nfJsonReminderEnabled').checked = !!s.ntfyJsonReminderEnabled;
      document.getElementById('nfJsonReminderTime').value      = s.ntfyJsonReminderTime || '08:00';
      document.getElementById('nfBirthdayEnabled').checked     = !!s.ntfyBirthdayEnabled;
      document.getElementById('nfBirthdayTime').value          = s.ntfyBirthdayTime || '08:00';
      document.getElementById('nfArrivalEnabled').checked      = !!s.ntfyArrivalEnabled;
      document.getElementById('nfArrivalLeadMins').value       = s.ntfyArrivalLeadMins || 10;
      document.getElementById('nfArrivalOnlyOnShift').checked  = s.ntfyArrivalOnlyOnShift !== false;
      document.getElementById('nfWeatherEnabled').checked      = !!s.ntfyWeatherEnabled;
      document.getElementById('nfWeatherTime').value           = s.ntfyWeatherTime || '19:00';
      this._reminders = s.ntfyShiftReminders
        ? s.ntfyShiftReminders.split(',').map(m => parseInt(m.trim())).filter(m => m > 0)
        : [];
      this.renderReminderChips();
      this.renderStatus(s);
    } catch(e) { /* silently skip */ }
  },

  renderStatus(s) {
    const el = document.getElementById('nfStatus');
    if (!el) return;
    const parts = [];
    if (s.running)    parts.push('⚡ Auto-sync is running');
    if (s.lastRun)    parts.push(`Last run: ${new Date(s.lastRun).toLocaleString('en-GB',{dateStyle:'short',timeStyle:'short'})}`);
    if (s.lastResult) {
      const r = s.lastResult;
      if (r.error) parts.push(`<span style="color:var(--danger)">Last error: ${r.error}</span>`);
      else         parts.push(`Last result: ${r.imported} new, ${r.changed} changed`);
    }
    el.innerHTML = parts.join(' &nbsp;·&nbsp; ') || 'Not run yet.';
  },

  async saveSettings() {
    const btn = document.getElementById('nfSaveBtn');
    btn.disabled = true;
    try {
      const password = document.getElementById('nfRgPassword').value.trim();
      await fetch('/api/rotageek/autosync-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled:              document.getElementById('nfAutosyncEnabled').checked,
          interval_hours:       parseFloat(document.getElementById('nfAutosyncInterval').value || '1'),
          ntfy_topic:           document.getElementById('nfNtfyTopic').value.trim(),
          ntfy_server:          document.getElementById('nfNtfyServer').value.trim() || 'https://ntfy.sh',
          ntfy_enabled:         document.getElementById('nfNtfyEnabled').checked,
          ntfy_shift_reminders: this._reminders.join(','),
          ntfy_disconnect_alert: document.getElementById('nfDisconnectAlert').checked,
          ntfy_json_reminder_enabled: document.getElementById('nfJsonReminderEnabled').checked,
          ntfy_json_reminder_time:    document.getElementById('nfJsonReminderTime').value || '08:00',
          ntfy_birthday_enabled: document.getElementById('nfBirthdayEnabled').checked,
          ntfy_birthday_time:    document.getElementById('nfBirthdayTime').value || '08:00',
          ntfy_arrival_enabled:  document.getElementById('nfArrivalEnabled').checked,
          ntfy_arrival_lead_mins: parseInt(document.getElementById('nfArrivalLeadMins').value, 10) || 10,
          ntfy_arrival_only_on_shift: document.getElementById('nfArrivalOnlyOnShift').checked,
          ntfy_weather_enabled: document.getElementById('nfWeatherEnabled').checked,
          ntfy_weather_time:    document.getElementById('nfWeatherTime').value || '19:00',
          password:             password || undefined,
        }),
      });
      showToast('Settings saved ✓', 'success');
      if (password) document.getElementById('nfRgPassword').value = '';
      await this.loadSettings();
    } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; }
  },

  async testNtfy() {
    const btn = document.getElementById('nfTestBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const topic  = document.getElementById('nfNtfyTopic').value.trim();
      const server = document.getElementById('nfNtfyServer').value.trim() || 'https://ntfy.sh';
      if (!topic) { showToast('Enter an ntfy topic name first', 'error'); return; }
      const r = await fetch('/api/rotageek/test-ntfy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, server }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) showToast('Test sent! Check your phone.', 'success');
      else      showToast('ntfy error: ' + (data.error || `HTTP ${r.status}`), 'error');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Test notification'; }
  },

  async testReminder() {
    const btn = document.getElementById('nfTestReminderBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/rotageek/test-reminder', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok) showToast('Test shift reminder sent! Check your phone.', 'success');
      else      showToast('Failed: ' + (data.error || `HTTP ${r.status}`), 'error');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Test shift reminder'; }
  },

  async testJsonReminder() {
    const btn = document.getElementById('nfTestJsonReminderBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/rotageek/test-json-reminder', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok) showToast('Test JSON reminder sent! Check your phone.', 'success');
      else      showToast('Failed: ' + (data.error || `HTTP ${r.status}`), 'error');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Test JSON reminder'; }
  },

  async testBirthday() {
    const btn = document.getElementById('nfTestBirthdayBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/rotageek/test-birthday-reminder', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok) showToast('Test birthday reminder sent! Check your phone.', 'success');
      else      showToast('Failed: ' + (data.error || `HTTP ${r.status}`), 'error');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Test birthday'; }
  },

  async testArrival() {
    const btn = document.getElementById('nfTestArrivalBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/rotageek/test-arrival-reminder', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok) showToast('Test arrival reminder sent! Check your phone.', 'success');
      else      showToast('Failed: ' + (data.error || `HTTP ${r.status}`), 'error');
    } catch(e) { showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Test arrival'; }
  },

  async runSyncNow() {
    const btn = document.getElementById('nfSyncNowBtn');
    const statusEl = document.getElementById('nfStatus');
    btn.disabled = true; btn.textContent = 'Syncing…';
    statusEl.textContent = 'Syncing with Rotageek…';
    try {
      const r = await fetch('/api/rotageek/autosync', { method: 'POST' }).then(r => r.json());
      if (r.error) {
        showToast('Sync error: ' + r.error, 'error');
        statusEl.innerHTML = `<span style="color:var(--danger)">${r.error}</span>`;
      } else {
        showToast(`Sync complete — ${r.imported} new, ${r.changed} changed`, 'success');
        await this.loadSettings();
      }
    } catch(e) { showToast('Sync failed: ' + e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Sync now'; }
  },
};
