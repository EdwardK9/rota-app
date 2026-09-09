/* ─── 📍 Clock Map (V5.0) ──────────────────────────────────────────────────
   Where you were when you clocked in and out.

   A real Leaflet/OpenStreetMap tile map, lazy-loaded (see loadLeafletLib in
   utils.js) so it costs nothing on any page that isn't this one. Sat alongside
   the plain-metres scatter below it rather than replacing it — the map gives
   street context, the scatter gives an exact "how far and which direction"
   reading that doesn't depend on eyeballing a zoom level. Every point still
   links out to Google Maps too, for anyone who wants street view or directions.

   Earlier reasoning against embedding a map (dropped after reconsidering with
   the app's actual precedent): this page already sends every fix to Google
   Maps via the "Map ↗" link, and SheetJS is already lazy-loaded the same way
   for Import — so "no third-party JS" wasn't a real constraint this page was
   actually holding to, and OSM's tile requests are no more revealing than the
   Google Maps link already is.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-locations', '📍 Clock Map', {
  data: null,
  kind: 'all',

  async init() {
    const el = document.getElementById('view-v5-locations');
    el.innerHTML = V5.loading('Plotting your clock-ins…');
    try {
      this.data = await V5.api.locations(V5.days, this.kind);
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  destroy() {
    if (this._map) { this._map.remove(); this._map = null; }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-v5-locations');
    const t = d.totals;

    const header = `
      ${V5.backButton()}
      <div class="toolbar">
        <div class="month-nav">
          <label style="margin-bottom:0;margin-right:4px;font-weight:500">Period:</label>
          <select id="v5LocDays" style="width:auto">
            ${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year'], ['all', 'All time']]
              .map(([v, l]) => `<option value="${v}" ${String(v) === String(V5.days) ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <label style="margin:0 4px 0 12px;font-weight:500">Show:</label>
          <select id="v5LocKind" style="width:auto">
            ${[['all', 'Everything'], ['clock_in', 'Clock-ins'], ['clock_out', 'Clock-outs'], ['app_open', 'App opens']]
              .map(([v, l]) => `<option value="${v}" ${v === this.kind ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>`;

    if (!d.enabled) {
      el.innerHTML = `${header}
        <div class="v5-banner v5-banner-off">
          📍 <strong>Location tracking is switched off.</strong> It is off by default — nothing has been
          recorded and nothing will be until you turn it on.
        </div>
        ${V5.empty('📍', 'No location data',
                   'Turn location tracking on in Data & Privacy (or Settings) to start pinning clock-ins to a place.')}
        <div style="text-align:center">
          <button class="btn btn-primary" onclick="App.navigate('v5-privacy')">🔒 Open Data &amp; Privacy</button>
        </div>`;
      this._wire();
      return;
    }

    if (!t.points) {
      el.innerHTML = `${header}
        ${V5.empty('📍', 'Nothing recorded in this period',
                   'A fix is taken when you clock in or out — and only then, unless you have also switched on location at app open.')}`;
      this._wire();
      return;
    }

    el.innerHTML = `
      ${header}

      ${!d.work_configured ? `
        <div class="v5-banner">
          🏪 <strong>No work postcode set.</strong> Fixes are being recorded, but without the store's
          location nothing can be measured against it. Add your work postcode under
          <a href="#" onclick="App.navigate('settings');return false">Settings → Commute</a>.
        </div>` : ''}

      <div class="v3-hero" style="background:linear-gradient(135deg,#10B981,#065F46)">
        <div class="v3-hero-label">CLOCKED IN AT WORK</div>
        <div class="v3-hero-value">${d.work_configured ? V5.pct(t.at_work_pct) : '—'}</div>
        <div class="v3-hero-sub">
          ${t.clock_points} clock fix${t.clock_points === 1 ? '' : 'es'} recorded across ${t.dates_covered} days.
          ${t.away_from_work ? `${t.away_from_work} of them were somewhere other than the store.` : 'All of them at the store.'}
          Typical accuracy ${t.median_accuracy_m != null ? `±${t.median_accuracy_m} m` : 'unknown'}.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm">
        ${V5.tile('Fixes recorded', t.points, `${t.clock_points} at clock in/out`)}
        ${V5.tile('At the store', t.at_work, `${t.at_work_pct}% of clock fixes`, V5.pctClass(t.at_work_pct))}
        ${V5.tile('Elsewhere', t.away_from_work, 'clocked somewhere else')}
        ${V5.tile('Accuracy', t.median_accuracy_m != null ? `±${t.median_accuracy_m}<span class="v5-of"> m</span>` : '—', 'median fix accuracy')}
      </div>

      ${d.work_configured ? `
        <div class="v3-section-title">🗺️ Map</div>
        <div class="card"><div class="card-body">
          <div id="v5LeafletMap" class="v5-leaflet-map"></div>
          <p class="v3-note">The pin is the store. Tap a point for what it was and when.</p>
        </div></div>` : ''}

      ${this._plot(d)}

      <div class="v3-section-title">🏷️ Where you clock from</div>
      <div class="card"><div class="card-body">
        ${V5.ranked(d.by_place.map(p => ({ icon: p.icon, label: p.name, value: p.count, display: String(p.count) })))}
        <p class="v3-note">Places are matched by distance when this page loads, so renaming a place — or
        widening its radius — relabels everything already recorded.</p>
      </div></div>

      ${d.away_points.length ? `
        <div class="v3-section-title">🚩 Clocked from somewhere else</div>
        <div class="card"><div class="card-body">
          <div class="table-wrapper"><table>
            <thead><tr><th>Date</th><th>Time</th><th>What</th><th>Distance</th><th>Place</th><th></th></tr></thead>
            <tbody>${d.away_points.map(p => `
              <tr>
                <td>${esc(p.dow)} ${esc(fmtDayMonth(p.date))}</td>
                <td>${esc(p.time)}</td>
                <td>${esc(this._kindLabel(p.kind))}</td>
                <td class="v5-bad">${esc(V5.metres(p.distance_from_work_m))}</td>
                <td>${p.place ? `${p.place_icon} ${esc(p.place)}` : '<span class="v3-muted">Unknown</span>'}</td>
                <td><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Map ↗</a></td>
              </tr>`).join('')}</tbody>
          </table></div>
          <p class="v3-note">A fix counts as "elsewhere" only when the distance exceeds the accuracy of the
          reading, so a vague indoor fix doesn't get flagged as clocking in from home.</p>
        </div></div>` : ''}

      <div class="v3-section-title">📌 Saved places</div>
      <div class="card">
        <div class="card-header"><h2>Places</h2>
          <button class="btn btn-primary btn-sm" id="v5AddPlaceBtn">+ Add place</button>
        </div>
        <div class="card-body">
          <div class="table-wrapper"><table>
            <thead><tr><th>Place</th><th>Coordinates</th><th>Radius</th><th>Fixes</th><th>Source</th><th></th></tr></thead>
            <tbody>${d.places.map(p => `
              <tr>
                <td>${p.icon} ${esc(p.name)}</td>
                <td class="v3-muted" style="font-family:monospace;font-size:12px">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</td>
                <td>${p.radius_m} m</td>
                <td>${p.hits}</td>
                <td class="v3-muted">${p.source === 'commute' ? 'From your commute postcode' : 'Saved here'}</td>
                <td>${p.id ? `<button class="btn btn-ghost btn-sm" data-del-place="${p.id}">Delete</button>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>
          <p class="v3-note">Home and Work come free from the commute postcodes you have already set.
          Add your own for anywhere else worth naming.</p>
        </div>
      </div>

      <div class="v3-section-title">🗒️ All fixes</div>
      <div class="card"><div class="card-body">
        <div class="table-wrapper"><table>
          <thead><tr><th>Date</th><th>Time</th><th>What</th><th>Place</th><th>From work</th><th>Accuracy</th><th></th></tr></thead>
          <tbody>${d.points.map(p => `
            <tr>
              <td>${esc(p.dow)} ${esc(fmtDayMonth(p.date))}</td>
              <td>${esc(p.time)}</td>
              <td>${esc(this._kindLabel(p.kind))}</td>
              <td>${p.place ? `${p.place_icon} ${esc(p.place)}` : '<span class="v3-muted">—</span>'}</td>
              <td class="${p.at_work === false ? 'v5-bad' : ''}">${esc(V5.metres(p.distance_from_work_m))}</td>
              <td class="v3-muted">${p.accuracy_m != null ? `±${p.accuracy_m} m` : '—'}</td>
              <td><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Map ↗</a></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div></div>
    `;

    this._wire();
    if (d.work_configured) this._initMap(d);
  },

  _kindLabel(kind) {
    return { clock_in: '🕐 Clock in', clock_out: '🕔 Clock out', app_open: '📱 App open', manual: '📍 Manual' }[kind] || kind;
  },

  /** Builds the real Leaflet map into #v5LeafletMap. Loaded on demand — see
   *  loadLeafletLib in utils.js — so this is the only view that pays for it. */
  async _initMap(d) {
    const el = document.getElementById('v5LeafletMap');
    if (!el) return;   // navigated away before the library finished loading
    try {
      await loadLeafletLib();
    } catch (e) {
      el.innerHTML = `<p class="v3-error" style="padding:12px">Couldn't load the map: ${esc(e.message)}</p>`;
      return;
    }
    if (!document.getElementById('v5LeafletMap')) return;   // still gone by the time L is ready

    if (this._map) { this._map.remove(); this._map = null; }

    const colour = { clock_in: '#10B981', clock_out: '#6366F1', app_open: '#F59E0B', manual: '#94A3B8' };
    const work = d.work;
    const map = L.map(el, { scrollWheelZoom: false }).setView([work.lat, work.lon], 15);
    this._map = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    L.marker([work.lat, work.lon], {
      title: 'The store',
    }).addTo(map).bindPopup('🏪 The store');

    for (const p of d.places) {
      L.circle([p.lat, p.lon], { radius: p.radius_m, color: '#94A3B8', weight: 1, fillOpacity: 0.05 }).addTo(map);
    }

    const bounds = [[work.lat, work.lon]];
    for (const p of d.points) {
      if (p.lat == null || p.lon == null) continue;
      bounds.push([p.lat, p.lon]);
      L.circleMarker([p.lat, p.lon], {
        radius: 6, color: colour[p.kind] || '#94A3B8', fillColor: colour[p.kind] || '#94A3B8', fillOpacity: 0.75, weight: 1,
      }).addTo(map).bindPopup(
        `${esc(this._kindLabel(p.kind))}<br>${esc(p.dow)} ${esc(fmtDayMonth(p.date))} ${esc(p.time)}` +
        `<br>${esc(V5.metres(p.distance_from_work_m))} from the store` +
        `<br><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`
      );
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
  },

  /** A scatter of every GPS fix relative to the store, with the axes in metres.
   *  Deliberately not a tile map — it needs no tiles, no key and no network, and
   *  it shows the one thing that matters: the cluster at work, and the outliers.
   *  (Renamed the section from "Fixes relative to the store" — "fix" is GPS
   *  jargon for a single location reading, but read cold it sounds like a list
   *  of bug fixes. See the module comment for why this stays a plain scatter
   *  rather than becoming a real tile map.) */
  _plot(d) {
    if (!d.work_configured || !d.points.length) return '';
    const work = d.work;
    // Local flat-earth projection — over a commute-sized area the error is far
    // smaller than a GPS fix's own accuracy.
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((work.lat * Math.PI) / 180);
    const pts = d.points.map(p => ({
      ...p,
      x: (p.lon - work.lon) * mPerDegLon,
      y: (p.lat - work.lat) * mPerDegLat,
    }));
    const extent = Math.max(120, ...pts.map(p => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 1.15;
    const size = 320, half = size / 2;
    const sx = p => half + (p.x / extent) * half;
    const sy = p => half - (p.y / extent) * half;

    const colour = { clock_in: '#10B981', clock_out: '#6366F1', app_open: '#F59E0B', manual: '#94A3B8' };

    return `
      <div class="v3-section-title">🗺️ Distance from the store</div>
      <div class="card"><div class="card-body">
        <div class="v5-plot-wrap">
          <svg viewBox="0 0 ${size} ${size}" class="v5-plot" role="img"
               aria-label="Scatter of recorded clock-in/out positions, plotted by distance and direction from the store">
            <circle cx="${half}" cy="${half}" r="${(250 / extent) * half}" class="v5-plot-ring" />
            <circle cx="${half}" cy="${half}" r="${(1000 / extent) * half}" class="v5-plot-ring" />
            <line x1="${half}" y1="0" x2="${half}" y2="${size}" class="v5-plot-axis" />
            <line x1="0" y1="${half}" x2="${size}" y2="${half}" class="v5-plot-axis" />
            ${pts.map(p => `
              <circle cx="${sx(p).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="4"
                      fill="${colour[p.kind] || '#94A3B8'}" fill-opacity="0.7">
                <title>${esc(`${p.date} ${p.time} — ${this._kindLabel(p.kind)}, ${V5.metres(p.distance_from_work_m)} from work`)}</title>
              </circle>`).join('')}
            <text x="${half + 4}" y="12" class="v5-plot-label">N</text>
          </svg>
        </div>
        <div class="v3-chips" style="justify-content:center">
          <span class="v3-chip"><span class="v5-dot" style="background:#10B981"></span> Clock in</span>
          <span class="v3-chip"><span class="v5-dot" style="background:#6366F1"></span> Clock out</span>
          <span class="v3-chip"><span class="v5-dot" style="background:#F59E0B"></span> App open</span>
        </div>
        <p class="v3-note">The store is the centre; the rings are 250 m and 1 km. The plot spans about
        ${Math.round(extent)} m in each direction. Hover a point for the detail.</p>
      </div></div>`;
  },

  _wire() {
    document.getElementById('v5LocDays')?.addEventListener('change', e => {
      V5.days = e.target.value;
      this.init();
    });
    document.getElementById('v5LocKind')?.addEventListener('change', e => {
      this.kind = e.target.value;
      this.init();
    });
    document.getElementById('v5AddPlaceBtn')?.addEventListener('click', () => this.openAddPlace());
    document.querySelectorAll('[data-del-place]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirmAction('Delete this place? Fixes stay, they just lose the label.')) return;
        try {
          await V5.api.deletePlace(b.dataset.delPlace);
          showToast('Place deleted', 'success');
          this.init();
        } catch (e) { showToast(e.message, 'error'); }
      });
    });
  },

  openAddPlace() {
    Modal.open('Add a place', `
      <div class="form-group">
        <label>Name</label>
        <input type="text" id="v5PlaceName" placeholder="e.g. Mum's, the gym, the depot" />
      </div>
      <div class="form-row">
        <div class="form-group"><label>Icon</label>
          <input type="text" id="v5PlaceIcon" maxlength="4" value="📍" style="width:80px" /></div>
        <div class="form-group"><label>Radius (metres)</label>
          <input type="number" id="v5PlaceRadius" value="200" min="20" max="20000" />
          <div class="form-hint">How close a fix has to be to count as here.</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Latitude</label><input type="number" step="any" id="v5PlaceLat" /></div>
        <div class="form-group"><label>Longitude</label><input type="number" step="any" id="v5PlaceLon" /></div>
      </div>
      <button class="btn btn-secondary btn-sm" id="v5PlaceHereBtn">📍 Use where I am now</button>
      <span id="v5PlaceHereStatus" style="font-size:13px;color:var(--text-muted);margin-left:8px"></span>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn btn-primary" id="v5PlaceSaveBtn">Save place</button>
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>
    `);

    document.getElementById('v5PlaceHereBtn').addEventListener('click', () => {
      const status = document.getElementById('v5PlaceHereStatus');
      if (!navigator.geolocation) { status.textContent = 'This browser has no location support.'; return; }
      status.textContent = 'Asking…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          document.getElementById('v5PlaceLat').value = pos.coords.latitude.toFixed(6);
          document.getElementById('v5PlaceLon').value = pos.coords.longitude.toFixed(6);
          status.textContent = `Got it (±${Math.round(pos.coords.accuracy)} m)`;
        },
        err => { status.textContent = 'Could not get a fix: ' + err.message; },
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });

    document.getElementById('v5PlaceSaveBtn').addEventListener('click', async () => {
      const body = {
        name: document.getElementById('v5PlaceName').value.trim(),
        icon: document.getElementById('v5PlaceIcon').value.trim() || '📍',
        lat: document.getElementById('v5PlaceLat').value,
        lon: document.getElementById('v5PlaceLon').value,
        radius_m: document.getElementById('v5PlaceRadius').value,
      };
      if (!body.name || body.lat === '' || body.lon === '') {
        showToast('Name and coordinates are required', 'error');
        return;
      }
      try {
        await V5.api.createPlace(body);
        Modal.close();
        showToast('Place saved', 'success');
        this.init();
      } catch (e) { showToast(e.message, 'error'); }
    });
  },
});
