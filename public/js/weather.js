/* ─── Weather View (V2.0) ──────────────────────────────────────────────────
   A fuller forecast than the per-shift badges on the dashboard — daily min/max,
   wind, sunrise/sunset, out to Open-Meteo's ~15 day horizon, for both your home
   and work locations (if both are set in Settings → Commute), with your logged
   shifts overlaid so it's obvious which days actually matter.
   ───────────────────────────────────────────────────────────────────────── */

const WeatherView = {
  data: null,

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-weather').innerHTML = `
      <div id="weatherContent">
        <div style="text-align:center;padding:40px;color:var(--text-muted)">Loading forecast…</div>
      </div>
    `;
  },

  async load() {
    const el = document.getElementById('weatherContent');
    try {
      this.data = await API.getForecast();
      if (!this.data.available) {
        el.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🌦️</div>
            <div class="empty-state-text">No home location set</div>
            <div class="empty-state-sub">
              Add a home postcode under
              <a href="#" onclick="App.navigate('settings');return false">Settings → Commute</a>
              to see a forecast here.
            </div>
          </div>`;
        return;
      }
      this.renderForecast();
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);padding:20px">Failed to load forecast: ${esc(e.message)}</p>`;
    }
  },

  _fmtDay(dateStr, isToday) {
    if (isToday) return 'Today';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  },

  _dayCard(d, todayStr) {
    const isToday = d.date === todayStr;
    const hasAlert = d.alerts && d.alerts.length;
    const shiftChips = (d.shifts || []).map(s =>
      `<span class="weather-shift-chip" title="You're working this day">🕐 ${s.start_time}–${s.end_time}</span>`
    ).join('');

    return `
      <div class="weather-day-card${isToday ? ' weather-day-today' : ''}${hasAlert ? ' weather-day-alert' : ''}">
        <div class="weather-day-label">${this._fmtDay(d.date, isToday)}</div>
        <div class="weather-day-icon">${d.icon}</div>
        <div class="weather-day-desc">${esc(d.label)}</div>
        <div class="weather-day-temps">
          <span class="weather-temp-max">${Math.round(d.tempMax)}°</span>
          <span class="weather-temp-min">${Math.round(d.tempMin)}°</span>
        </div>
        <div class="weather-day-meta">
          <span title="Chance of rain">☔ ${d.precipProbMax ?? '—'}%</span>
          <span title="Max wind speed">💨 ${d.windMax != null ? Math.round(d.windMax) + 'km/h' : '—'}</span>
        </div>
        <div class="weather-day-meta" style="opacity:.7">
          <span title="Sunrise">🌅 ${d.sunrise || '—'}</span>
          <span title="Sunset">🌇 ${d.sunset || '—'}</span>
        </div>
        ${hasAlert ? `<div class="weather-day-alerts">${d.alerts.map(a => `<span title="${esc(a.text)}">${a.icon}</span>`).join('')}</div>` : ''}
        ${shiftChips ? `<div class="weather-day-shifts">${shiftChips}</div>` : ''}
      </div>`;
  },

  _strip(title, days, todayStr) {
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><h2>${title}</h2></div>
        <div class="card-body">
          <div class="weather-strip">
            ${days.map(d => this._dayCard(d, todayStr)).join('')}
          </div>
        </div>
      </div>`;
  },

  renderForecast() {
    const el = document.getElementById('weatherContent');
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const { daily, workDaily, hasWork } = this.data;

    const upcomingAlerts = daily.filter(d => d.alerts && d.alerts.length && d.shifts && d.shifts.length);

    el.innerHTML = `
      ${upcomingAlerts.length ? `
        <div class="discrepancy-banner" style="margin-bottom:16px">
          <span class="discrepancy-banner-icon">⚠️</span>
          <div>
            <strong>Heads up</strong> —
            ${upcomingAlerts.map(d =>
              `${this._fmtDay(d.date, d.date === todayStr)}: ${d.alerts.map(a => a.text).join(', ')}`
            ).join('; ')}
          </div>
        </div>` : ''}
      ${this._strip('🏠 Home', daily, todayStr)}
      ${hasWork ? this._strip('🏪 Work', workDaily, todayStr) : `
        <p style="font-size:12px;color:var(--text-muted);text-align:center">
          Add a work postcode in <a href="#" onclick="App.navigate('settings');return false">Settings → Commute</a>
          to see the forecast at work too.
        </p>`}
    `;
  },
};
