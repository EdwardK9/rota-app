/* ─── Team Upload View ──────────────────────────────────────────────────────
   Two tabs:
     • Get Prompt  — copyable AI prompt for extracting Rotageek screenshots
     • JSON Import — paste / upload the resulting JSON to import colleague shifts
   ────────────────────────────────────────────────────────────────────────── */

const TeamUploadView = {
  _jsonFiles: null,

  init() {
    this.render();
    this._wireTabs();
    this._initJsonPanel();
    this._initAutoAiPanel();
  },

  render() {
    document.getElementById('view-team-upload').innerHTML = `

      <div class="card" style="max-width:760px;margin:0 auto 20px">
        <div class="card-header" style="padding-bottom:0">
          <h2 style="margin-bottom:12px">Team Rota Import</h2>
          <div class="import-tabs">
            <button class="import-tab active" data-mode="auto-ai" id="tabAutoAi">
              \u{1F916} Auto Import (AI)
            </button>
            <button class="import-tab" data-mode="prompt" id="tabPrompt">
              \u{1F4DD} Get Prompt
            </button>
            <button class="import-tab" data-mode="json-import" id="tabJsonImport">
              \u{1F4CB} JSON Import
            </button>
          </div>
        </div>

        <div class="card-body">

          <!-- AUTO IMPORT (AI) PANEL -->
          <div id="panelAutoAi">
            <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:16px">
              Drop one or more team schedule screenshots below and each is read automatically
              with Gemini — no need to paste them into an AI chat yourself. Needs a Gemini API
              key set in
              <a href="#" onclick="App.navigate('settings');return false" style="color:var(--primary-text)">Settings → AI Screenshot Import</a>.
            </p>

            <div class="drop-zone" id="tuAutoDropZone" style="margin-bottom:14px">
              <div class="drop-zone-icon">\u{1F4F7}</div>
              <div class="drop-zone-text">Drop screenshots here</div>
              <div class="drop-zone-hint">or click to browse &nbsp;\u{00B7}&nbsp; multiple images accepted (one week per screenshot)</div>
              <input type="file" id="tuAutoFileInput" accept="image/*" multiple style="display:none" />
            </div>

            <div id="tuAutoStatus" style="font-size:13px;color:var(--text-muted);min-height:18px"></div>
          </div>

          <!-- PROMPT PANEL -->
          <div id="panelPrompt" style="display:none">
            <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:16px">
              Take a screenshot of the Rotageek team schedule, then paste it into
              <strong>Claude</strong> or <strong>ChatGPT</strong> along with the prompt below.
              Copy the JSON it returns, then switch to the <strong>JSON Import</strong> tab.
            </p>
            <div style="position:relative">
              <button class="btn btn-ghost btn-sm" id="copyPromptBtn"
                style="position:absolute;top:8px;right:8px;z-index:1">\u{1F4CB} Copy</button>
              <textarea id="promptText" class="form-control" rows="18" readonly
                style="font-family:monospace;font-size:11.5px;resize:vertical;padding-right:80px"
              ></textarea>
            </div>
            <p style="color:var(--text-muted);font-size:12px;margin-top:10px">
              \u{1F4A1} Works best with Claude or GPT-4o. For long schedules, take multiple shorter
              screenshots and import each one separately.
            </p>
          </div>

          <!-- JSON IMPORT PANEL -->
          <div id="panelJsonImport" style="display:none">
            <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:16px">
              Paste or upload the JSON returned by the AI.
              Colleagues must already exist in your
              <a href="#" onclick="App.navigate('people');return false" style="color:var(--primary-text)">People</a>
              list to be matched.
            </p>

            <div class="drop-zone" id="tuJsonDropZone" style="margin-bottom:14px">
              <div class="drop-zone-icon">\u{1F4CB}</div>
              <div class="drop-zone-text">Drop a JSON file here</div>
              <div class="drop-zone-hint">or click to browse &nbsp;\u{00B7}&nbsp; .json, .csv or .docx accepted</div>
              <input type="file" id="tuJsonFileInput"
                accept=".json,.csv,.docx,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple style="display:none" />
            </div>

            <p style="font-size:12px;color:var(--text-muted);text-align:center;margin:0 0 8px">or paste JSON directly</p>
            <textarea id="tuJsonPaste" class="form-control" rows="6"
              placeholder='{ "date_range": "Mar 17 - Mar 23, 2026", "schedule": [...] }'
              style="font-family:monospace;font-size:12px;margin-bottom:14px;resize:vertical"></textarea>

            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-ghost" id="tuJsonPreviewBtn">\u{1F441} Preview</button>
              <button class="btn btn-primary" id="tuJsonImportBtn" disabled>Import</button>
              <span id="tuJsonStatus" style="font-size:13px;color:var(--text-muted)"></span>
            </div>

            <div id="tuJsonPreview" style="margin-top:16px;display:none">
              <div class="table-wrapper" style="max-height:340px;overflow-y:auto">
                <table id="tuJsonPreviewTable"
                  style="width:100%;font-size:13px;border-collapse:collapse"></table>
              </div>
            </div>
          </div>

        </div>
      </div>
    `;

    const PROMPT = `You are reading a Rotageek team schedule from a mobile app screenshot. The image shows shifts listed vertically, grouped under day headings.

IMAGE STRUCTURE:
1. Week header near the top — e.g. "Feb 23, 2026 – Mar 1, 2026"
2. A vertical list of shift entries. Each entry shows a person's name and their time range.
3. The day changes are indicated by a day label that appears on the LEFT SIDE of the FIRST entry for each new day — e.g. "Wed" above "04" to the left of the first person listed on Wednesday. Subsequent entries for the same day have no day label — they just show the person's name and time, separated from the previous entry by a faint grey line.

HOW TO IDENTIFY WHICH DAY EACH ENTRY BELONGS TO:
- When you see a day label on the left (e.g. "Wed" + "04"), that marks the start of a new day. The person shown to the right of that label is the FIRST entry for that day.
- Every entry that follows, until the next day label appears on the left, belongs to the same day.
- The day label only appears once per day, next to the first person for that day.

YOUR TASK:
Work through the image top to bottom. Track which day you are in by watching for day labels on the left. Assign each entry to the current day until a new day label appears.

OUTPUT — return ONLY valid JSON, no markdown, no explanation:
{
  "date_range": "<week header as shown, e.g. 23 - Mar 01, 2026>",
  "schedule": [
    {
      "date": "<day heading as shown, e.g. Mon 23>",
      "shifts": [
        { "name": "Full Name As Written", "time": "HH:MM - HH:MM", "type": "label as shown", "store": "location text if shown, else omit" }
      ]
    }
  ]
}

RULES — follow exactly:
1. Copy the week header verbatim into "date_range"
2. Copy each day heading verbatim into "date" — e.g. "Mon 23", "Sun 01"
3. A shift belongs to a day ONLY if the employee name appears directly under that day's heading
4. Each day section ends the moment the next day heading starts
5. Copy all names and times exactly as written — never rephrase or correct
6. If a person appears under multiple different day headings, include them separately under each one
7. If you cannot clearly read a name or time, OMIT that entry — never guess
8. "Annual Leave" / "Absence": use type "leave", omit the time field
9. "All day" entries: use type "all_day", omit the time field
10. The "schedule" array must contain EXACTLY the 7 days (Monday through Sunday) named in "date_range" — never more, never fewer. If the image shows an extra day belonging to the following week (e.g. a second/next Monday appearing after Sunday), do NOT include it in "schedule"
11. Some entries show a small line below the time, often next to a pin/map-marker icon, naming a different store or branch (e.g. "Southampton - Bitterne") — this means that shift is at a DIFFERENT location than the rest of the schedule. If you see this, copy it verbatim into a "store" field on that shift. If there is no such line, OMIT the "store" field entirely for that shift — do NOT invent one
12. Return ONLY the JSON — no surrounding text`;

    document.getElementById('promptText').value = PROMPT;
    document.getElementById('copyPromptBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(PROMPT).then(() => {
        const btn = document.getElementById('copyPromptBtn');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
  },

  _wireTabs() {
    document.querySelectorAll('.import-tab[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => this._switchMode(btn.dataset.mode));
    });
  },

  _switchMode(mode) {
    document.querySelectorAll('.import-tab[data-mode]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === mode)
    );
    document.getElementById('panelAutoAi').style.display     = mode === 'auto-ai'     ? 'block' : 'none';
    document.getElementById('panelPrompt').style.display     = mode === 'prompt'      ? 'block' : 'none';
    document.getElementById('panelJsonImport').style.display = mode === 'json-import' ? 'block' : 'none';
  },

  _initJsonPanel() {
    // Avoid double-wiring if panel already set up
    if (document.getElementById('tuJsonDropZone').__wired) return;
    document.getElementById('tuJsonDropZone').__wired = true;
    this._jsonFiles = null;

    const dropZone  = document.getElementById('tuJsonDropZone');
    const fileInput = document.getElementById('tuJsonFileInput');
    const paste     = document.getElementById('tuJsonPaste');
    const previewBtn = document.getElementById('tuJsonPreviewBtn');
    const importBtn  = document.getElementById('tuJsonImportBtn');

    // Click drop zone → open file picker
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      const files = [...e.dataTransfer.files];
      if (files.length) this._loadJsonFiles(files);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) this._loadJsonFiles([...fileInput.files]);
    });

    previewBtn.addEventListener('click', () => this._previewAllJson());
    importBtn.addEventListener('click', () => this._importJson());
  },

  _initAutoAiPanel() {
    if (document.getElementById('tuAutoDropZone').__wired) return;
    document.getElementById('tuAutoDropZone').__wired = true;

    const dropZone  = document.getElementById('tuAutoDropZone');
    const fileInput = document.getElementById('tuAutoFileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.style.borderColor = '';
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) this._autoImportScreenshots(files);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) this._autoImportScreenshots([...fileInput.files]);
      fileInput.value = '';
    });
  },

  // Read one or more screenshots with Gemini, one at a time (so status can show
  // progress), then feed all of them into the exact same preview/import/
  // conflict-resolution pipeline used for manually pasted JSON — no separate
  // code path to maintain, and it already supports multiple weeks at once.
  async _autoImportScreenshots(files) {
    const status = document.getElementById('tuAutoStatus');
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      status.style.color = 'var(--text-muted)';
      status.textContent = files.length > 1
        ? `Reading screenshot ${i + 1} of ${files.length} with Gemini…`
        : 'Reading screenshot with Gemini…';
      try {
        const result = await API.extractScreenshotGemini(files[i]);
        results.push({ file: files[i].name, data: result.data });
      } catch (e) {
        errors.push(`${files[i].name}: ${e.message}`);
      }
    }

    if (!results.length) {
      status.textContent = '✗ ' + (errors[0] || 'Failed to read screenshot(s)');
      status.style.color = 'var(--danger)';
      return;
    }

    status.textContent = errors.length
      ? `✓ Read ${results.length} of ${files.length} — ${errors.length} failed (${errors.join('; ')}) — switching to preview…`
      : '✓ Read successfully — switching to preview…';
    status.style.color = errors.length ? 'var(--warning)' : 'var(--success)';

    this._jsonFiles = results;
    document.getElementById('tuJsonPaste').value = JSON.stringify(results[0].data, null, 2);
    this._switchMode('json-import');
    this._previewAllJson();
  },

  // Parse a CSV exported from the team calendar back into grouped JSON
  _parseCsvToScheduleJson(csvText) {
    const parseRow = line => {
      const vals = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
        else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
        else cur += ch;
      }
      vals.push(cur);
      return vals;
    };

    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const header = parseRow(lines[0]).map(h => h.toLowerCase());
    const col = name => header.indexOf(name);
    const iName = col('name'), iDate = col('date'), iStart = col('start_time'), iEnd = col('end_time'), iType = col('type');
    if (iName < 0 || iDate < 0) throw new Error('CSV must have "name" and "date" columns');

    const dateMap = new Map();
    for (let i = 1; i < lines.length; i++) {
      const r = parseRow(lines[i]);
      const name = r[iName]?.trim();
      const date = r[iDate]?.trim(); // YYYY-MM-DD
      if (!name || !date) continue;
      const start = iStart >= 0 ? r[iStart]?.trim() : '';
      const end   = iEnd   >= 0 ? r[iEnd]?.trim()   : '';
      const type  = iType  >= 0 ? r[iType]?.trim()  : 'shift';
      if (!dateMap.has(date)) dateMap.set(date, []);
      const shiftObj = { name };
      if (type === 'shift' && start && end) shiftObj.time = `${start} - ${end}`;
      else shiftObj.type = type || 'shift';
      dateMap.get(date).push(shiftObj);
    }
    if (!dateMap.size) throw new Error('No valid rows in CSV');

    const DAY   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sorted = [...dateMap.keys()].sort();
    const schedule = sorted.map(d => {
      const dt = new Date(d + 'T12:00:00');
      return { date: `${DAY[dt.getDay()]} ${String(dt.getDate()).padStart(2,'0')}`, shifts: dateMap.get(d) };
    });
    const f = new Date(sorted[0] + 'T12:00:00');
    const l = new Date(sorted[sorted.length - 1] + 'T12:00:00');
    const date_range = `${MONTH[f.getMonth()]} ${f.getDate()}, ${f.getFullYear()} - ${MONTH[l.getMonth()]} ${l.getDate()}, ${l.getFullYear()}`;
    return { date_range, schedule };
  },

  async _loadJsonFiles(files) {
    const status = document.getElementById('tuJsonStatus');
    status.style.color = 'var(--text-muted)';
    status.textContent = `Reading ${files.length} file${files.length !== 1 ? 's' : ''}…`;

    const results = [];
    for (const file of files) {
      try {
        let parsed;
        if (file.name.toLowerCase().endsWith('.docx')) {
          const text = await this._extractJsonFromDocx(file);
          parsed = JSON.parse(text.trim().slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        } else if (file.name.toLowerCase().endsWith('.csv')) {
          const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          parsed = this._parseCsvToScheduleJson(text);
        } else {
          const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
          });
          parsed = JSON.parse(text.trim().slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        }
        results.push({ file: file.name, data: parsed });
      } catch(e) {
        results.push({ file: file.name, error: e.message });
      }
    }

    this._jsonFiles = results;

    // Show preview of all loaded files
    const ok    = results.filter(r => !r.error);
    const errs  = results.filter(r =>  r.error);
    let summary = ok.length + ' file' + (ok.length !== 1 ? 's' : '') + ' ready';
    if (errs.length) summary += ', ' + errs.length + ' failed: ' + errs.map(e => e.file).join(', ');
    status.textContent = summary;

    // Populate textarea with first file for inspection, then run preview
    if (ok.length) {
      document.getElementById('tuJsonPaste').value = JSON.stringify(ok[0].data, null, 2);
    }
    this._previewAllJson();
  },

  async _extractJsonFromDocx(file) {
    // Dynamically load JSZip from CDN if not already present
    if (!window.JSZip) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load JSZip'));
        document.head.appendChild(s);
      });
    }

    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) throw new Error('Not a valid .docx file (missing word/document.xml)');

    const xml = await xmlFile.async('string');

    // Strip all XML tags
    let text = xml.replace(/<[^>]+>/g, ' ');

    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Decode HTML entities
    const entities = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'" };
    text = text.replace(/&[a-z]+;/gi, m => entities[m] || m);
    text = text.replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code)));

    // Find the JSON object (starts with { ends with })
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in document');

    return text.slice(start, end + 1);
  },

  _previewJson() { this._previewAllJson(); },

  // ── Client-side date helpers (mirror the server logic for preview) ──────────

  _resolveWeekDates(dateRange) {
    if (!dateRange) return null;
    const SHORT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const m = dateRange.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})\s*$/);
    if (!m) return null;
    const monIdx = SHORT_MONTHS.indexOf(m[1].toLowerCase().substring(0, 3));
    if (monIdx === -1) return null;
    const end = new Date(parseInt(m[3]), monIdx, parseInt(m[2]));
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(end.getDate() - i);
      dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    return dates;
  },

  _resolveDayDate(dayStr, weekDates) {
    if (!weekDates || !dayStr) return null;
    const m = dayStr.match(/(\d{1,2})\s*$/);
    if (!m) return null;
    const dayNum = parseInt(m[1], 10);
    return weekDates.find(d => parseInt(d.slice(8), 10) === dayNum) || null;
  },

  _previewAllJson() {
    const status    = document.getElementById('tuJsonStatus');
    const preview   = document.getElementById('tuJsonPreview');
    const table     = document.getElementById('tuJsonPreviewTable');
    const importBtn = document.getElementById('tuJsonImportBtn');

    // Build dataset: use _jsonFiles if loaded via file picker, else parse textarea
    let files = this._jsonFiles && this._jsonFiles.length
      ? this._jsonFiles.filter(f => !f.error)
      : null;

    if (!files) {
      try {
        const data = JSON.parse(document.getElementById('tuJsonPaste').value.trim());
        files = [{ file: 'pasted', data }];
      } catch(e) {
        status.textContent = '✗ Invalid JSON: ' + e.message;
        status.style.color = 'var(--danger)';
        preview.style.display = 'none';
        importBtn.disabled = true;
        return;
      }
    }

    if (!files.length) {
      status.textContent = '✗ No valid files to preview';
      status.style.color = 'var(--danger)';
      importBtn.disabled = true;
      return;
    }

    // Build preview table across all files
    let rows = '';
    let totalShifts = 0, totalDays = 0, totalWarnings = 0;

    for (const { file, data } of files) {
      if (!data.schedule) continue;
      totalDays += data.schedule.length;

      const weekDates = this._resolveWeekDates(data.date_range);

      rows += `<tr><td colspan="5" style="padding:6px 8px;font-weight:600;color:var(--primary-text);background:var(--bg);font-size:12px">${esc(data.date_range || file)}</td></tr>`;

      for (const day of data.schedule) {
        const resolvedDate = this._resolveDayDate(day.date, weekDates);

        if (!resolvedDate) {
          totalWarnings++;
          rows += `<tr><td colspan="5" style="padding:3px 8px;color:var(--warning);font-size:12px">
            ⚠️ Could not resolve date for "${esc(day.date)}" — ${(day.shifts||[]).length} shifts skipped
          </td></tr>`;
          continue;
        }

        for (const shift of (day.shifts || [])) {
          totalShifts++;

          const typeLower = (shift.type || '').toLowerCase().trim();
          const isLeave = typeLower === 'leave' || typeLower === 'annual leave' || typeLower === 'al'
            || typeLower.includes('leave') || typeLower.includes('absent') || typeLower === 'holiday';
          const isAllDay = typeLower === 'all_day' || typeLower === 'all day';

          let timeDisplay, typeBadge, rowStyle = '';
          if (isLeave) {
            timeDisplay = '🌴 Leave';
            typeBadge   = '';
            rowStyle    = 'background:rgba(16,185,129,0.08);';
          } else if (isAllDay) {
            timeDisplay = '🏪 All Day';
            typeBadge   = '';
            rowStyle    = 'background:rgba(99,102,241,0.08);';
          } else {
            timeDisplay = shift.time || '';
            typeBadge   = shift.type ? `<span style="font-size:10px;color:var(--text-muted)">${esc(shift.type)}</span>` : '';
          }

          const storeBadge = shift.store
            ? `<span style="font-size:10px;background:rgba(245,158,11,0.15);color:#b45309;border-radius:10px;padding:1px 7px;white-space:nowrap">📍 ${esc(shift.store)}</span>`
            : '';
          if (shift.store) rowStyle = 'background:rgba(245,158,11,0.06);';

          rows += `<tr style="${rowStyle}">
            <td style="padding:3px 8px;color:var(--text-muted);font-size:11px">${resolvedDate}</td>
            <td style="padding:3px 8px;font-weight:500">${esc(shift.name || '')}</td>
            <td style="padding:3px 8px">${esc(timeDisplay)}</td>
            <td style="padding:3px 8px">${typeBadge}</td>
            <td style="padding:3px 8px">${storeBadge}</td>
          </tr>`;
        }
      }
    }

    table.innerHTML = `
      <thead><tr style="border-bottom:2px solid var(--border)">
        <th style="padding:4px 8px;text-align:left;color:var(--text-muted)">Date</th>
        <th style="padding:4px 8px;text-align:left;color:var(--text-muted)">Name</th>
        <th style="padding:4px 8px;text-align:left;color:var(--text-muted)">Time</th>
        <th style="padding:4px 8px;text-align:left;color:var(--text-muted)">Type</th>
        <th style="padding:4px 8px;text-align:left;color:var(--text-muted)">Store</th>
      </tr></thead>
      <tbody>${rows}</tbody>`;

    let statusText = `${files.length} week${files.length !== 1 ? 's' : ''} · ${totalDays} days · ${totalShifts} shifts`;
    if (totalWarnings > 0) statusText += ` · ⚠️ ${totalWarnings} issue${totalWarnings !== 1 ? 's' : ''} — highlighted below`;
    status.textContent = statusText;
    status.style.color = totalWarnings > 0 ? 'var(--warning)' : 'var(--text-muted)';
    preview.style.display = 'block';
    importBtn.disabled = false;
  },

  async _importJson(overridesByFile = []) {
    const status    = document.getElementById('tuJsonStatus');
    const importBtn = document.getElementById('tuJsonImportBtn');

    // Build list of datasets to import
    let files = this._jsonFiles && this._jsonFiles.filter(f => !f.error);
    if (!files || !files.length) {
      try {
        const data = JSON.parse(document.getElementById('tuJsonPaste').value.trim());
        files = [{ file: 'pasted', data }];
      } catch(e) {
        showToast('No valid JSON to import', 'error'); return;
      }
    }

    importBtn.disabled = true;
    status.style.color = 'var(--text-muted)';

    let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;
    const allWarnings = [], allUnknown = new Set(), allConflicts = [];
    // allConflicts entries include {fileIdx} so we can resolve per-file later

    for (let i = 0; i < files.length; i++) {
      status.textContent = `Importing week ${i + 1} of ${files.length}…`;
      const overrides = overridesByFile[i] || [];
      try {
        const result = await API.importColleagueJson(files[i].data, overrides);
        totalInserted += result.inserted || 0;
        totalUpdated  += result.updated  || 0;
        totalSkipped  += result.skipped  || 0;
        (result.warnings     || []).forEach(w => allWarnings.push(w));
        (result.unknownNames || []).forEach(n => allUnknown.add(n));
        (result.conflicts    || []).forEach(c => allConflicts.push({ ...c, fileIdx: i }));
      } catch(e) {
        showToast('Failed on ' + files[i].file + ': ' + e.message, 'error');
      }
    }

    // Store the files reference for use in conflict resolution
    this._importFiles = files;

    // Build result summary
    let msg = `✓ ${totalInserted} inserted`;
    if (totalUpdated)  msg += ` · ${totalUpdated} updated`;
    msg += ` · ${totalSkipped} skipped`;
    if (allUnknown.size) msg += ` · ${allUnknown.size} unknown`;
    status.textContent = msg;
    status.style.color = (totalInserted + totalUpdated) > 0 ? 'var(--success)' : 'var(--text-muted)';

    const preview = document.getElementById('tuJsonPreview');
    let extraHtml = '';

    // Show warnings / unknown names
    if (allWarnings.length || allUnknown.size) {
      extraHtml += `<div style="margin-top:10px;padding:10px 12px;border-left:3px solid var(--warning);background:rgba(245,158,11,0.08);border-radius:4px;font-size:12px">`;
      if (allWarnings.length) {
        extraHtml += `<div style="font-weight:600;margin-bottom:6px">⚠️ ${allWarnings.length} issue${allWarnings.length !== 1 ? 's' : ''} during import:</div>`;
        extraHtml += allWarnings.map(w => `<div style="color:var(--text-muted);margin-bottom:3px">• ${esc(w)}</div>`).join('');
      }
      if (allUnknown.size) {
        extraHtml += `<div style="font-weight:600;margin-top:${allWarnings.length ? '8px' : '0'};margin-bottom:4px">Unknown names (not in People list):</div>`;
        extraHtml += `<div style="color:var(--text-muted)">${[...allUnknown].map(n => esc(n)).join(', ')}</div>`;
      }
      extraHtml += `</div>`;
    }

    // Show conflict resolution panel if there are conflicts
    if (allConflicts.length) {
      const fmtTime = (st, et, type) => {
        if (type === 'leave')   return '🌴 Leave';
        if (type === 'all_day') return '🏪 All Day';
        return `${st} – ${et}`;
      };
      extraHtml += `
        <div id="tuJsonConflicts" style="margin-top:12px;border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:12px">
          <div style="padding:8px 12px;background:rgba(245,158,11,0.1);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
            <span style="font-weight:600">⚡ ${allConflicts.length} conflict${allConflicts.length !== 1 ? 's' : ''} — existing shifts differ from incoming data</span>
            <span style="color:var(--text-muted);font-size:11px">Check the ones you want to overwrite</span>
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">
              <th style="padding:5px 8px;text-align:left;font-weight:500">Use incoming</th>
              <th style="padding:5px 8px;text-align:left;font-weight:500">Person</th>
              <th style="padding:5px 8px;text-align:left;font-weight:500">Date</th>
              <th style="padding:5px 8px;text-align:left;font-weight:500">Existing</th>
              <th style="padding:5px 8px;text-align:left;font-weight:500">Incoming</th>
            </tr></thead>
            <tbody>
              ${allConflicts.map((c, idx) => `
                <tr style="border-bottom:1px solid var(--border)" data-conflict-idx="${idx}">
                  <td style="padding:5px 8px;text-align:center">
                    <input type="checkbox" class="conflict-cb" data-idx="${idx}"
                      data-colleague-id="${c.colleague_id}" data-date="${c.date}"
                      data-start-time="${c.start_time}" data-file-idx="${c.fileIdx}">
                  </td>
                  <td style="padding:5px 8px;font-weight:500">${esc(c.name)}</td>
                  <td style="padding:5px 8px;color:var(--text-muted)">${c.date}</td>
                  <td style="padding:5px 8px;color:var(--text-muted)">${esc(fmtTime(c.start_time, c.existing.end_time, c.existing.shift_type))}</td>
                  <td style="padding:5px 8px;color:var(--success)">${esc(fmtTime(c.start_time, c.incoming.end_time, c.incoming.shift_type))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <div style="padding:8px 12px;display:flex;gap:8px;align-items:center;border-top:1px solid var(--border)">
            <button id="tuConflictSelectAll" class="btn btn-sm btn-ghost" style="font-size:11px">Select all</button>
            <button id="tuConflictApplyBtn" class="btn btn-sm btn-primary" disabled>Apply overrides</button>
            <span id="tuConflictCount" style="font-size:11px;color:var(--text-muted)">0 selected</span>
          </div>
        </div>`;
    }

    if (extraHtml) {
      // Replace any existing post-import extras
      const existing = preview.querySelector('#tuJsonPostImport');
      if (existing) existing.remove();
      const div = document.createElement('div');
      div.id = 'tuJsonPostImport';
      div.innerHTML = extraHtml;
      preview.appendChild(div);
      preview.style.display = 'block';

      // Wire up conflict panel controls
      if (allConflicts.length) {
        const applyBtn    = div.querySelector('#tuConflictApplyBtn');
        const selectAll   = div.querySelector('#tuConflictSelectAll');
        const countLabel  = div.querySelector('#tuConflictCount');

        const updateCount = () => {
          const n = div.querySelectorAll('.conflict-cb:checked').length;
          countLabel.textContent = n + ' selected';
          applyBtn.disabled = n === 0;
        };

        div.querySelectorAll('.conflict-cb').forEach(cb => cb.addEventListener('change', updateCount));

        selectAll.addEventListener('click', () => {
          const cbs = div.querySelectorAll('.conflict-cb');
          const allChecked = [...cbs].every(cb => cb.checked);
          cbs.forEach(cb => { cb.checked = !allChecked; });
          selectAll.textContent = allChecked ? 'Select all' : 'Deselect all';
          updateCount();
        });

        applyBtn.addEventListener('click', async () => {
          // Build per-file override arrays
          const byFile = [];
          div.querySelectorAll('.conflict-cb:checked').forEach(cb => {
            const fi = parseInt(cb.dataset.fileIdx);
            if (!byFile[fi]) byFile[fi] = [];
            byFile[fi].push({
              colleague_id: parseInt(cb.dataset.colleagueId),
              date:         cb.dataset.date,
              start_time:   cb.dataset.startTime
            });
          });
          div.remove(); // clear panel before re-import
          await this._importJson(byFile);
        });
      }
    }

    showToast(
      (totalInserted + totalUpdated) + ' shift' + ((totalInserted + totalUpdated) !== 1 ? 's' : '') + ' imported',
      (totalInserted + totalUpdated) > 0 ? 'success' : 'info'
    );
    importBtn.disabled = false;
  }
};
