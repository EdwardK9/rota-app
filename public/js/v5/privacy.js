/* ─── 🔒 Data & Privacy (V5.0) ─────────────────────────────────────────────
   The switches, the row counts, and the delete buttons.

   The row counts matter as much as the switches: "location is off" is a claim,
   and this page is where it can be checked. Everything here writes through the
   same settings the server reads on every ingest, so flipping a switch takes
   effect on the very next event rather than the next page load.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-privacy', '🔒 Data & Privacy', {
  data: null,

  async init() {
    const el = document.getElementById('view-v5-privacy');
    el.innerHTML = V5.loading('Checking what has been stored…');
    try {
      this.data = await V5.api.privacy();
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  render() {
    const d = this.data;
    const s = d.settings;
    const st = d.stored;
    const el = document.getElementById('view-v5-privacy');

    const toggle = (id, on, label, hint, disabled) => `
      <label class="v5-switch-row${disabled ? ' v5-switch-disabled' : ''}">
        <input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="v5-switch-body">
          <span class="v5-switch-label">${label}</span>
          <span class="v5-switch-hint">${hint}</span>
        </span>
      </label>`;

    el.innerHTML = `
      ${V5.backButton()}

      <p class="v3-intro">
        V5 records how you use this app. All of it is written to your own SQLite database on your own
        server, and none of it is sent anywhere else — but it is still more than the rest of the app
        collects, so the switches for it live here, with the counts to check them against.
      </p>

      <div class="card"><div class="card-header"><h2>Switches</h2></div><div class="card-body">
        ${toggle('v5SwAnalytics', s.analytics_enabled, 'Usage analytics',
                 'App opens, session length, and which screens you open for how long. Turning this off stops <em>all</em> recording, location included.')}
        ${toggle('v5SwLocation', s.location_enabled, 'Location tracking',
                 'Takes a GPS fix when you clock in and when you clock out — nothing in between. Off by default.',
                 !s.analytics_enabled)}
        ${toggle('v5SwLocationOpen', s.location_on_open, 'Location when the app opens',
                 'Also take a fix every time you open the app. Far more data, and rarely worth it — leave this off unless you have a reason.',
                 !s.analytics_enabled || !s.location_enabled)}

        <div class="form-group" style="max-width:260px;margin-top:18px">
          <label>Keep data for</label>
          <select id="v5Retention">
            ${[[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [0, 'Forever']]
              .map(([v, l]) => `<option value="${v}" ${Number(s.retention_days) === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <div class="form-hint">Anything older is deleted automatically, checked at most once an hour.</div>
        </div>

        <button class="btn btn-primary" id="v5SavePrivacy" style="margin-top:8px">Save</button>
        <span id="v5PrivacyStatus" style="font-size:13px;color:var(--text-muted);margin-left:10px"></span>
      </div></div>

      <div class="v3-section-title">📦 What is stored right now</div>
      <div class="v3-grid v3-grid-sm">
        ${V5.tile('Sessions', st.sessions.rows, st.sessions.first ? `${esc(st.sessions.first)} → ${esc(st.sessions.last)}` : 'none')}
        ${V5.tile('Events', st.events.rows, st.events.first ? `${esc(st.events.first)} → ${esc(st.events.last)}` : 'none')}
        ${V5.tile('Location fixes', st.locations.rows,
                  st.locations.rows ? `${esc(st.locations.first)} → ${esc(st.locations.last)}` : 'none recorded',
                  st.locations.rows ? '' : 'v5-good')}
        ${V5.tile('Saved places', st.places.rows, 'named locations')}
      </div>

      <div class="v3-section-title">📋 What each switch covers</div>
      <div class="card"><div class="card-body">
        <div class="table-wrapper"><table class="v5-table-prose">
          <thead><tr><th>What is recorded</th><th>When</th><th>Switched off by</th></tr></thead>
          <tbody>${d.collected.map(c => `
            <tr><td>${esc(c.what)}</td><td>${esc(c.when)}</td><td>${esc(c.off_switch)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="v3-note">${esc(d.note)}</p>
      </div></div>

      <div class="v3-section-title">🗑️ Delete what has been collected</div>
      <div class="card"><div class="card-body">
        <p class="v3-muted" style="margin-bottom:14px">
          This is real deletion — the rows go. Your shifts, clock entries and everything else in the
          app are untouched; V5 has never written to those tables.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary" data-wipe="locations">Delete location fixes (${st.locations.rows})</button>
          <button class="btn btn-secondary" data-wipe="events">Delete screen events (${st.events.rows})</button>
          <button class="btn btn-secondary" data-wipe="sessions">Delete sessions (${st.sessions.rows})</button>
          <button class="btn btn-danger" data-wipe="all">Delete everything V5 has recorded</button>
        </div>
        <p class="v3-note">Saved places are kept by "delete everything" — they are settings you typed,
        not something that was recorded about you. Delete them individually on the Clock Map.</p>
      </div></div>
    `;

    this._wire();
  },

  _wire() {
    // The dependent switches grey out immediately rather than only after a save,
    // so the relationship between them is visible while you're deciding.
    const analytics = document.getElementById('v5SwAnalytics');
    const location = document.getElementById('v5SwLocation');
    const onOpen = document.getElementById('v5SwLocationOpen');
    const sync = () => {
      location.disabled = !analytics.checked;
      onOpen.disabled = !analytics.checked || !location.checked;
      location.closest('.v5-switch-row').classList.toggle('v5-switch-disabled', location.disabled);
      onOpen.closest('.v5-switch-row').classList.toggle('v5-switch-disabled', onOpen.disabled);
    };
    analytics.addEventListener('change', sync);
    location.addEventListener('change', sync);

    document.getElementById('v5SavePrivacy').addEventListener('click', async () => {
      const status = document.getElementById('v5PrivacyStatus');
      status.textContent = 'Saving…';
      try {
        const res = await V5.api.savePrivacy({
          analytics_enabled: analytics.checked,
          location_enabled: location.checked && analytics.checked,
          location_on_open: onOpen.checked && location.checked && analytics.checked,
          retention_days: document.getElementById('v5Retention').value,
        });
        this.data = { ...this.data, ...res };
        // Tell the running tracker straight away — otherwise it would keep
        // asking for GPS (or keep not asking) until the page is reloaded.
        if (typeof V5Tracker !== 'undefined') {
          V5Tracker.setConfig({
            analytics: res.settings.analytics_enabled,
            location: res.settings.location_enabled,
            locationOnOpen: res.settings.location_on_open,
          });
        }
        status.textContent = '✓ Saved';
        showToast('Privacy settings saved', 'success');
        this.render();
      } catch (e) {
        status.textContent = '';
        showToast(e.message, 'error');
      }
    });

    document.querySelectorAll('[data-wipe]').forEach(b => {
      b.addEventListener('click', async () => {
        const scope = b.dataset.wipe;
        const what = scope === 'all' ? 'everything V5 has recorded' : `all ${scope}`;
        if (!confirmAction(`Delete ${what}? This cannot be undone.`)) return;
        try {
          const res = await V5.api.wipe(scope);
          this.data = { ...this.data, stored: res.stored };
          showToast('Deleted', 'success');
          this.render();
        } catch (e) { showToast(e.message, 'error'); }
      });
    });
  },
});
