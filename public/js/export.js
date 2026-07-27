/* ─── Export View ──────────────────────────────────────────────────────────── */

const ExportView = {
  shifts: [],

  async init() {
    this.render();
    this.wire();
  },

  render() {
    const el = document.getElementById('view-export');

    // Build week options (Mon–Sun) for the last 12 weeks + next 4
    const weekOpts = this._buildWeekOptions();
    // Build month options for last 24 months
    const monthOpts = this._buildMonthOptions();

    el.innerHTML = `
      <div style="max-width:680px;margin:0 auto;padding:8px 0;">
        <div class="card" style="margin-bottom:20px;padding:16px;">
          <h3 style="margin-bottom:6px;">\ud83d\udcf2 Live calendar subscription</h3>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:10px;">
            Subscribe once and your phone calendar stays up to date automatically \u2014 no re-exporting.
            On iPhone: Settings \u2192 Calendar \u2192 Accounts \u2192 Add Subscribed Calendar. On Google Calendar: Other calendars \u2192 From URL.
          </p>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <code id="icalUrl" style="background:var(--bg);padding:8px 10px;border-radius:6px;font-size:13px;word-break:break-all;">${window.location.origin}/calendar.ics</code>
            <button class="btn btn-secondary" id="copyIcalUrl" style="min-height:36px;">Copy</button>
          </div>
        </div>

        <h2 style="margin-bottom:4px;">Export to Calendar</h2>
        <p style="color:var(--text-muted);font-size:14px;margin-bottom:20px;">
          Export your shifts as an ICS file you can import into Google Calendar, Outlook, Apple Calendar, or any other calendar app.
        </p>

        <!-- Mode selector -->
        <div class="form-group">
          <label>Date range</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <label class="export-mode-label"><input type="radio" name="exportMode" value="week" checked /> Specific weeks</label>
            <label class="export-mode-label"><input type="radio" name="exportMode" value="month" /> Specific months</label>
            <label class="export-mode-label"><input type="radio" name="exportMode" value="custom" /> Custom date range</label>
            <label class="export-mode-label"><input type="radio" name="exportMode" value="all" /> All shifts</label>
          </div>
        </div>

        <!-- Week picker -->
        <div id="exportWeekPicker" class="form-group">
          <label>Select weeks</label>
          <select id="exportWeekSelect" multiple size="8" style="width:100%;max-width:400px;font-family:monospace;font-size:13px;">
            ${weekOpts}
          </select>
          <small style="color:var(--text-muted);">Ctrl/Cmd+click to select multiple weeks</small>
        </div>

        <!-- Month picker -->
        <div id="exportMonthPicker" class="form-group hidden">
          <label>Select months</label>
          <select id="exportMonthSelect" multiple size="8" style="width:100%;max-width:400px;font-size:13px;">
            ${monthOpts}
          </select>
          <small style="color:var(--text-muted);">Ctrl/Cmd+click to select multiple months</small>
        </div>

        <!-- Custom date range -->
        <div id="exportCustomPicker" class="form-group hidden">
          <div class="form-row">
            <div class="form-group">
              <label>From date</label>
              <input type="date" id="exportFrom" />
            </div>
            <div class="form-group">
              <label>To date</label>
              <input type="date" id="exportTo" />
            </div>
          </div>
        </div>

        <!-- Options -->
        <div class="form-group" style="margin-top:8px;">
          <label>Include</label>
          <div style="display:flex;gap:16px;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;">
              <input type="checkbox" id="exportIncCompleted" checked /> Completed shifts
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;">
              <input type="checkbox" id="exportIncScheduled" checked /> Scheduled (upcoming) shifts
            </label>
          </div>
        </div>

        <!-- Summary -->
        <div id="exportSummary" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin:16px 0;font-size:14px;color:var(--text-muted);">
          Select a date range above, then click Export.
        </div>

        <button class="btn btn-primary" id="exportBtn" style="min-width:160px;">
          📤 Export ICS
        </button>

        <!-- V2.0 Phase 6: Data Exports -->
        <div class="card" style="margin-top:28px;padding:16px 20px">
          <h3 style="margin-bottom:6px;font-size:15px">📊 Team Analytics CSV</h3>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
            Flat CSV of every colleague shift in a date range — date, name, times, hours, hourly rate,
            shift cost, and any fatigue flags. Good for an Excel pivot table.
          </p>
          <div class="form-row">
            <div class="form-group">
              <label>From</label>
              <input type="date" id="csvFrom" class="form-control" />
            </div>
            <div class="form-group">
              <label>To</label>
              <input type="date" id="csvTo" class="form-control" />
            </div>
          </div>
          <button class="btn btn-primary" id="csvDownloadBtn">⬇️ Download CSV</button>
        </div>

        <div class="card" style="margin-top:16px;padding:16px 20px">
          <h3 style="margin-bottom:6px;font-size:15px">🗒️ Daily Shift Brief PDF</h3>
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
            Single-page printable summary for one day: hourly headcount, shift schedule, keyholders and weather.
          </p>
          <div class="form-group" style="max-width:200px;margin-bottom:12px">
            <label>Date</label>
            <input type="date" id="pdfDate" class="form-control" />
          </div>
          <button class="btn btn-primary" id="pdfDownloadBtn">⬇️ Download PDF</button>
          <span id="pdfStatus" style="font-size:13px;color:var(--text-muted);margin-left:10px"></span>
        </div>
      </div>
    `;
  },

  wire() {
    const copyBtn = document.getElementById('copyIcalUrl');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById('icalUrl').textContent);
        showToast('Subscription URL copied');
      } catch(_) {
        showToast('Could not copy — long-press the URL to copy it', 'error');
      }
    });

    // Show/hide pickers based on mode
    document.querySelectorAll('input[name="exportMode"]').forEach(radio => {
      radio.addEventListener('change', () => this._updatePickerVisibility());
    });

    // Live summary on selection change
    document.getElementById('exportWeekSelect').addEventListener('change', () => this._updateSummary());
    document.getElementById('exportMonthSelect').addEventListener('change', () => this._updateSummary());
    document.getElementById('exportFrom').addEventListener('change', () => this._updateSummary());
    document.getElementById('exportTo').addEventListener('change', () => this._updateSummary());
    document.getElementById('exportIncCompleted').addEventListener('change', () => this._updateSummary());
    document.getElementById('exportIncScheduled').addEventListener('change', () => this._updateSummary());

    document.getElementById('exportBtn').addEventListener('click', () => this._doExport());
    this._updateSummary();

    // V2.0 Phase 6 — Data Exports
    const today = new Date();
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    const fmtD = d => d.toISOString().slice(0, 10);
    document.getElementById('csvFrom').value = fmtD(weekAgo);
    document.getElementById('csvTo').value = fmtD(today);
    document.getElementById('pdfDate').value = fmtD(today);

    document.getElementById('csvDownloadBtn').addEventListener('click', () => this._downloadCsv());
    document.getElementById('pdfDownloadBtn').addEventListener('click', () => this._downloadPdf());
  },

  _downloadCsv() {
    const from = document.getElementById('csvFrom').value;
    const to = document.getElementById('csvTo').value;
    if (!from || !to) { showToast('Pick both dates first', 'warning'); return; }
    if (from > to) { showToast('"From" must be before "To"', 'warning'); return; }
    window.location.href = `/api/v1/export/team-analytics.csv?${new URLSearchParams({ from, to })}`;
  },

  async _downloadPdf() {
    const date = document.getElementById('pdfDate').value;
    if (!date) { showToast('Pick a date first', 'warning'); return; }
    const status = document.getElementById('pdfStatus');
    status.textContent = 'Generating…';
    try {
      const resp = await fetch(`/api/v1/export/daily-brief.pdf?${new URLSearchParams({ date })}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        throw new Error(err?.error || `Server returned ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `daily-brief_${date}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      status.textContent = '';
    } catch (e) {
      status.textContent = '';
      showToast('PDF export failed: ' + e.message, 'error');
    }
  },

  _updatePickerVisibility() {
    const mode = this._mode();
    document.getElementById('exportWeekPicker').classList.toggle('hidden', mode !== 'week');
    document.getElementById('exportMonthPicker').classList.toggle('hidden', mode !== 'month');
    document.getElementById('exportCustomPicker').classList.toggle('hidden', mode !== 'custom');
    this._updateSummary();
  },

  _mode() {
    return document.querySelector('input[name="exportMode"]:checked')?.value || 'week';
  },

  // Returns { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } | null
  _getDateRange() {
    const mode = this._mode();
    if (mode === 'all') return { from: '2000-01-01', to: '2099-12-31' };

    if (mode === 'week') {
      const selected = [...document.getElementById('exportWeekSelect').selectedOptions].map(o => o.value);
      if (!selected.length) return null;
      // Each value is "YYYY-MM-DD" (Monday of that week). Range = min to min+6
      const dates = selected.map(s => s.split('_')[0]).sort();
      const from = dates[0];
      // To = last selected Monday + 6 days (Sunday)
      const lastMon = dates[dates.length - 1];
      const toDate = new Date(lastMon);
      toDate.setDate(toDate.getDate() + 6);
      return { from, to: toDate.toISOString().slice(0, 10) };
    }

    if (mode === 'month') {
      const selected = [...document.getElementById('exportMonthSelect').selectedOptions].map(o => o.value).sort();
      if (!selected.length) return null;
      const from = selected[0] + '-01';
      const lastMonth = selected[selected.length - 1];
      const [y, m] = lastMonth.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      return { from, to: `${lastMonth}-${String(lastDay).padStart(2, '0')}` };
    }

    if (mode === 'custom') {
      const from = document.getElementById('exportFrom').value;
      const to   = document.getElementById('exportTo').value;
      if (!from || !to) return null;
      if (from > to) return null;
      return { from, to };
    }
    return null;
  },

  async _fetchShiftsForRange(from, to) {
    try {
      const shifts = await API.getShifts({ from, to });
      return Array.isArray(shifts) ? shifts : [];
    } catch(e) {
      return [];
    }
  },

  _filterByCompleted(shifts) {
    const incComp = document.getElementById('exportIncCompleted').checked;
    const incSched = document.getElementById('exportIncScheduled').checked;
    return shifts.filter(s => s.completed ? incComp : incSched);
  },

  async _updateSummary() {
    const range = this._getDateRange();
    const summaryEl = document.getElementById('exportSummary');
    if (!range) {
      summaryEl.textContent = 'Select a date range above, then click Export.';
      return;
    }
    summaryEl.textContent = 'Counting shifts…';
    const shifts = await this._fetchShiftsForRange(range.from, range.to);
    const filtered = this._filterByCompleted(shifts);
    const fmtDate = d => {
      const [y, m, day] = d.split('-');
      return `${day}/${m}/${y}`;
    };
    summaryEl.innerHTML = `<strong>${filtered.length}</strong> shift${filtered.length !== 1 ? 's' : ''} in range
      <span style="color:var(--text)">${fmtDate(range.from)} – ${fmtDate(range.to)}</span>
      ${filtered.length === 0 ? '<br><em style="color:var(--warning)">No shifts to export — adjust your selection.</em>' : ''}`;
  },

  async _doExport() {
    const range = this._getDateRange();
    if (!range) { showToast('Select a valid date range first', 'warning'); return; }

    const btn = document.getElementById('exportBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    try {
      const shifts = await this._fetchShiftsForRange(range.from, range.to);
      const filtered = this._filterByCompleted(shifts);

      if (!filtered.length) {
        showToast('No shifts in selected range', 'warning');
        return;
      }

      const ics = this._generateICS(filtered);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shifts_${range.from}_to_${range.to}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast(`Exported ${filtered.length} shift${filtered.length !== 1 ? 's' : ''} 🎉`, 'success');
    } catch(e) {
      showToast('Export failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📤 Export ICS';
    }
  },

  _generateICS(shifts) {
    const now = new Date();
    const stamp = this._fmtICSDateUTC(now);

    const vtimezone = [
      'BEGIN:VTIMEZONE',
      'TZID:Europe/London',
      'BEGIN:STANDARD',
      'DTSTART:19701025T020000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0000',
      'TZNAME:GMT',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700329T010000',
      'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
      'TZOFFSETFROM:+0000',
      'TZOFFSETTO:+0100',
      'TZNAME:BST',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ].join('\r\n');

    const events = shifts.map(s => {
      const uid = `shift-${s.id}@rota-tracker`;
      const [y, mo, d] = s.date.split('-').map(Number);
      const [sh, sm] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);

      const dtStart = this._fmtICSDateTimeLocal(y, mo, d, sh, sm);
      // Handle midnight crossover
      let endDay = d, endMon = mo, endYr = y;
      if (eh < sh || (eh === sh && em < sm)) {
        const next = new Date(y, mo - 1, d + 1);
        endYr = next.getFullYear(); endMon = next.getMonth() + 1; endDay = next.getDate();
      }
      const dtEnd = this._fmtICSDateTimeLocal(endYr, endMon, endDay, eh, em);

      // Per request: keep calendar events clean — no pay/hours/notes in the description.
      const summary = (s.is_bank_holiday ? '[BH] Screwfix Shift' : 'Screwfix Shift')
        .replace(/,/g, '\\,').replace(/;/g, '\\;');

      const lines = [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Europe/London:${dtStart}`,
        `DTEND;TZID=Europe/London:${dtEnd}`,
        `SUMMARY:${summary}`,
        s.completed ? 'STATUS:CONFIRMED' : 'STATUS:TENTATIVE',
        'END:VEVENT',
      ];
      return lines.map(l => this._foldLine(l)).join('\r\n');
    });

    const calLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Rota Tracker//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Screwfix Shifts',
      'X-WR-TIMEZONE:Europe/London',
      vtimezone,
      ...events,
      'END:VCALENDAR',
    ];
    return calLines.join('\r\n');
  },

  // Fold a single line at 75 octets per RFC 5545
  _foldLine(line) {
    if (line.length <= 75) return line;
    let result = '';
    let pos = 0;
    while (pos < line.length) {
      if (pos === 0) {
        result += line.slice(0, 75);
        pos = 75;
      } else {
        result += '\r\n ' + line.slice(pos, pos + 74);
        pos += 74;
      }
    }
    return result;
  },

  _fmtICSDateUTC(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
  },

  _fmtICSDateTimeLocal(y, mo, d, h, m) {
    const pad = n => String(n).padStart(2, '0');
    return `${y}${pad(mo)}${pad(d)}T${pad(h)}${pad(m)}00`;
  },

  _buildWeekOptions() {
    const opts = [];
    // Start from 12 weeks ago, go to 4 weeks from now
    const today = new Date();
    // Find last Monday
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() + 1 - 12 * 7); // 12 weeks back
    if (today.getDay() === 0) start.setDate(start.getDate() - 7);

    for (let i = 0; i < 17; i++) {
      const mon = new Date(start);
      mon.setDate(start.getDate() + i * 7);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);

      const monStr = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
      const fmtD = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      const label = `${fmtD(mon)} – ${fmtD(sun)}`;

      // Pre-select current week
      const isCurrentWeek = today >= mon && today <= sun;
      opts.push(`<option value="${monStr}" ${isCurrentWeek ? 'selected' : ''}>${label}</option>`);
    }
    return opts.join('\n');
  },

  _buildMonthOptions() {
    const opts = [];
    const today = new Date();
    for (let i = 23; i >= -2; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleString('default', { month: 'long', year: 'numeric' });
      const isCurrent = i === 0;
      opts.push(`<option value="${y}-${m}" ${isCurrent ? 'selected' : ''}>${label}</option>`);
    }
    return opts.join('\n');
  },
};
