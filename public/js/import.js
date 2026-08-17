/* ─── Import View ─────────────────────────────────────────────────────────── */

const ImportView = {
  // CSV / XLSX state
  csvText:        null,   // working CSV text used for preview (may be row-range trimmed)
  fullCsvText:    null,   // original full CSV text of first selected sheet (or uploaded CSV)
  xlsxWorkbook:   null,   // parsed XLSX workbook object (null for plain CSV imports)
  selectedSheets: [],     // names of sheets chosen in the picker
  endRow:         null,   // 1-indexed last row to include (null = no limit)
  headers:        [],
  sampleRows:     [],
  rawRows:        [],
  totalRows:      0,
  importType:     'shifts',
  headerRow:      0,

  // ICS state
  icsText:        null,
  icsShifts:      [],
  icsLeaveEntries:[],
  icsHasUtc:      false,
  icsBreakMins:   30,

  // Rotageek state
  rgConnected: false,
  rgBaseUrl:   '',
  rgPreviewShifts: [],


  // Active tab: 'csv' | 'ics' | 'rotageek'
  activeTab: 'rotageek',

  init() {
    this.render();
    this.switchTab('rotageek');
  },

  render() {
    const el = document.getElementById('view-import');
    el.innerHTML = `
      <div class="card" style="max-width:820px;margin:0 auto">
        <div class="card-header" style="padding-bottom:0">
          <h2 style="margin-bottom:12px">Import Data</h2>
          <!-- Source tabs -->
          <div class="import-tabs">
            <button class="import-tab active" data-tab="csv" id="tabCsv">
              📄 From CSV / Spreadsheet
            </button>
            <button class="import-tab" data-tab="ics" id="tabIcs">
              📅 From Calendar (ICS)
            </button>
            <button class="import-tab" data-tab="rotageek" id="tabRotageek">
              🔗 Rotageek Live
            </button>
          </div>
        </div>

        <div class="card-body">

          <!-- ════════════════════════════ CSV PANEL ════════════════════════════ -->
          <div id="panelCsv">
            <p style="color:var(--text-muted);margin-bottom:20px;font-size:13.5px">
              Upload an Excel (.xlsx) file directly, or a CSV export from your spreadsheet.
              If your Excel file has multiple sheets you can select which ones to import — they'll be combined automatically.
              You can also set the exact rows to import, cutting out any title rows at the top or summary rows at the bottom.
            </p>

            <div class="form-group">
              <label>What are you importing?</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" name="importType" value="shifts" checked /> Shifts
                </label>
                <label class="radio-label">
                  <input type="radio" name="importType" value="payslips" /> Payslips
                </label>
              </div>
            </div>

            <!-- Drop zone -->
            <div class="drop-zone" id="importDropZone">
              <div class="drop-zone-icon">📄</div>
              <div class="drop-zone-text">Drop your CSV or Excel file here</div>
              <div class="drop-zone-hint">or click to browse &nbsp;·&nbsp; .csv and .xlsx accepted</div>
              <input type="file" id="importFileInput" accept=".csv,.txt,.xlsx" style="display:none" />
            </div>

            <!-- Sheet picker (xlsx with multiple sheets) -->
            <div id="importSheetPicker" style="display:none;margin-top:20px">
              <div class="card" style="border-left:3px solid var(--primary)">
                <div class="card-body" style="padding:14px 16px">
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
                    <strong id="xlsxFileInfo" style="font-size:13.5px"></strong>
                    <button class="btn btn-ghost btn-sm" id="xlsxResetBtn">✕ Change file</button>
                  </div>
                  <label style="margin-bottom:10px;display:block;font-size:13.5px">
                    Select which sheets to import — all selected sheets will be combined into one import:
                  </label>
                  <div id="sheetCheckboxGroup" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px"></div>
                  <button class="btn btn-primary" id="xlsxContinueBtn">Continue with selected →</button>
                </div>
              </div>
            </div>

            <!-- Step 1: Raw preview + row range picker -->
            <div id="importStep1" style="display:none;margin-top:20px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
                <strong id="importFileInfo" style="font-size:13.5px"></strong>
                <button class="btn btn-ghost btn-sm" id="importResetBtn">✕ Change file</button>
              </div>

              <div class="card" style="margin-bottom:16px;border-left:3px solid var(--primary)">
                <div class="card-body" style="padding:14px 16px">
                  <div style="display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap">
                    <div>
                      <label style="margin-bottom:4px">Header row</label>
                      <div class="form-hint" style="margin-bottom:8px">Row with your column names</div>
                      <input type="number" id="headerRowInput" min="1" value="1" style="width:80px" />
                    </div>
                    <div>
                      <label style="margin-bottom:4px">Last data row <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
                      <div class="form-hint" style="margin-bottom:8px">Stop here — blank = all rows</div>
                      <input type="number" id="endRowInput" min="1" placeholder="e.g. 150" style="width:100px" />
                    </div>
                    <div style="display:flex;align-items:flex-end;padding-bottom:2px">
                      <button class="btn btn-ghost btn-sm" id="applyRowRangeBtn">Apply</button>
                    </div>
                    <div style="flex:1;min-width:180px;align-self:center">
                      <div class="form-hint">
                        💡 Check the preview below for row numbers. The ★ row is the header; the ⬇ row is the last included row.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">Raw file preview</h4>
              <div class="table-wrapper" id="importRawPreview" style="margin-bottom:20px;max-height:480px;overflow-y:auto"></div>

              <button class="btn btn-primary" id="proceedToMappingBtn">Next: Map Columns →</button>
            </div>

            <!-- Step 2: Column mapping -->
            <div id="importStep2" style="display:none;margin-top:20px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                <h3 style="font-size:14px;font-weight:600">Map columns</h3>
                <button class="btn btn-ghost btn-sm" id="backToStep1Btn">← Back</button>
              </div>
              <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
                Match each field to a column from your file. Leave as "Skip" if not present.
                Headers detected from row <strong id="detectedHeaderRow"></strong>.
              </p>
              <table class="mapping-table" id="importMappingTable"></table>

              <div style="margin-top:12px">
                <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">Data preview (first 3 data rows)</h4>
                <div class="table-wrapper" id="importPreviewTable"></div>
              </div>

              <div style="margin-top:20px;display:flex;gap:10px">
                <button class="btn btn-primary" id="importRunBtn">⬆ Import Data</button>
                <button class="btn btn-ghost" id="importCancelBtn">Cancel</button>
              </div>
            </div>

            <div id="importResultSection" style="display:none;margin-top:20px"></div>
          </div>

          <!-- ════════════════════════════ ICS PANEL ════════════════════════════ -->
          <div id="panelIcs" style="display:none">
            <p style="color:var(--text-muted);margin-bottom:20px;font-size:13.5px">
              Export your rota from Rotageek (or any calendar app) as an <strong>.ics</strong> file, then upload it here.
              Each calendar event becomes a shift — the event title is saved as the shift note.
            </p>

            <!-- ICS drop zone -->
            <div class="drop-zone" id="icsDropZone">
              <div class="drop-zone-icon">📅</div>
              <div class="drop-zone-text">Drop your .ics calendar file here</div>
              <div class="drop-zone-hint">or click to browse</div>
              <input type="file" id="icsFileInput" accept=".ics,.ical" style="display:none" />
            </div>

            <!-- ICS preview -->
            <div id="icsStep1" style="display:none;margin-top:20px">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
                <strong id="icsFileInfo" style="font-size:13.5px"></strong>
                <button class="btn btn-ghost btn-sm" id="icsResetBtn">✕ Change file</button>
              </div>

              <!-- UTC warning -->
              <div id="icsUtcWarning" style="display:none;margin-bottom:12px">
                <div class="card card-body" style="border-left:4px solid var(--warning);padding:12px 14px;font-size:13px">
                  ⚠️ <strong>UTC times detected.</strong> Your calendar file uses UTC times. If you're in the UK during summer (BST, April–October),
                  these may be 1 hour behind local time. Please check the preview below before importing.
                </div>
              </div>

              <!-- Break info -->
              <div class="card" style="margin-bottom:16px;border-left:3px solid var(--primary)">
                <div class="card-body" style="padding:12px 16px;font-size:13px;color:var(--text-muted)">
                  🕐 <strong style="color:var(--text)">Breaks are auto-calculated</strong> per shift:
                  under 4h 30m = no break &nbsp;·&nbsp; 4h 30m – 6h = 15 min &nbsp;·&nbsp; over 6h = 30 min.
                  You can edit individual shifts afterwards if needed.
                </div>
              </div>

              <!-- Preview table -->
              <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">
                Detected shifts — <span id="icsShiftCount" style="color:var(--primary)">0</span> events
              </h4>
              <div class="table-wrapper" id="icsPreviewTable" style="max-height:360px;overflow-y:auto;margin-bottom:20px"></div>

              <div style="display:flex;gap:10px">
                <button class="btn btn-primary" id="icsImportBtn">⬆ Import Shifts</button>
                <button class="btn btn-ghost" id="icsCancelBtn">Cancel</button>
              </div>
            </div>

            <div id="icsResultSection" style="display:none;margin-top:20px"></div>
          </div>

          <!-- ═══════════════════════ ROTAGEEK LIVE PANEL ═══════════════════════ -->
          <div id="panelRotageek" style="display:none">

            <!-- Status banner -->
            <div id="rgStatusBanner" style="margin-bottom:16px"></div>

            <!-- ── Not connected: login flow ─────────────────────────────── -->
            <div id="rgLoginForm">

              <!-- Heads-up: sessions don't stay alive, this is expected -->
              <div class="card" style="margin-bottom:16px;border-left:3px solid var(--warning, #f59e0b)">
                <div class="card-body" style="padding:14px 16px">
                  <h4 style="font-size:14px;margin-bottom:6px">⚠️ Rotageek sessions expire — this is normal</h4>
                  <p style="font-size:12.5px;color:var(--text-muted);margin:0;line-height:1.7">
                    Rotageek doesn't give this app a permanent connection, so the cookie + CSRF token below
                    will need to be re-pasted every so often (Rotageek can log you out server-side at any time).
                    The steps below are the reliable way to reconnect — they take under a minute and work every time.
                  </p>
                </div>
              </div>

              <div class="card" style="margin-bottom:16px;border-left:3px solid var(--primary)">
                <div class="card-body" style="padding:16px">
                  <h4 style="font-size:14px;margin-bottom:4px">Connect to Rotageek</h4>
                  <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">
                    Follow these 5 steps. Screenshots not required — just copy exactly what's described.
                  </p>

                  <!-- Step 1: open Rotageek -->
                  <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                    <div class="rg-step-num">1</div>
                    <div style="flex:1;min-width:220px">
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">Log in to Rotageek</div>
                      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px">
                        Opens in a new tab. Log in as normal, including the Microsoft Authenticator step if it asks.
                      </div>
                      <button class="btn btn-primary btn-sm" id="rgOpenLoginBtn">
                        Open Rotageek login ↗
                      </button>
                    </div>
                  </div>

                  <!-- Step 2: open dev tools -->
                  <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                    <div class="rg-step-num">2</div>
                    <div style="flex:1;min-width:220px">
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">
                        Open your browser's Developer Tools
                      </div>
                      <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7">
                        On the Rotageek tab, press <kbd>F12</kbd> (on Mac: <kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>I</kbd>).
                        A panel opens — click the <strong>Network</strong> tab along its top.
                      </div>
                    </div>
                  </div>

                  <!-- Step 3: find the request -->
                  <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                    <div class="rg-step-num">3</div>
                    <div style="flex:1;min-width:220px">
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">Find a Rotageek request</div>
                      <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7">
                        In the Network tab's filter/search box, type <code>graphql</code>. Then refresh the
                        Rotageek page (<kbd>F5</kbd>) so requests appear in the list. Click on any request
                        named like <code>graphql-userschedules</code> or just <code>graphql</code>.
                      </div>
                    </div>
                  </div>

                  <!-- Step 4: copy headers -->
                  <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                    <div class="rg-step-num">4</div>
                    <div style="flex:1;min-width:220px">
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">Copy two header values</div>
                      <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7;margin-bottom:6px">
                        With that request selected, open its <strong>Headers</strong> tab and scroll to
                        <strong>Request Headers</strong>. Copy the full value of:
                      </div>
                      <ul style="font-size:12.5px;color:var(--text-muted);margin:0 0 0 18px;line-height:1.9">
                        <li><code>cookie</code> — click the value, select all of it, copy (it's normal for this to be very long)</li>
                        <li><code>requestverificationtoken</code> — copy this one too (much shorter)</li>
                      </ul>
                    </div>
                  </div>

                  <!-- Step 5: paste + save -->
                  <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div class="rg-step-num">5</div>
                    <div style="flex:1;min-width:220px">
                      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Paste both values below and save</div>
                      <div class="form-group">
                        <label>Cookie</label>
                        <textarea id="rgCookieInput" rows="3"
                          placeholder="Paste the full cookie header value…"
                          style="font-family:monospace;font-size:11px;width:100%"></textarea>
                      </div>
                      <div class="form-group">
                        <label>CSRF Token <span style="font-weight:400;color:var(--text-muted)">(requestverificationtoken)</span></label>
                        <input type="text" id="rgCsrfInput" placeholder="Paste the CSRF token…"
                          style="font-family:monospace;font-size:11px;width:100%" />
                      </div>
                      <button class="btn btn-primary" id="rgSaveSessionBtn">Save Session</button>
                      <span id="rgSessionStatus" style="font-size:13px;color:var(--text-muted);margin-left:10px"></span>
                    </div>
                  </div>
                </div>
              </div>

              <details style="margin-top:4px">
                <summary style="cursor:pointer;font-size:12.5px;color:var(--text-muted)">
                  Alternative: auto-capture bookmarklet (quicker when it works, but often doesn't — use the steps above if unsure)
                </summary>
                <div style="margin-top:12px;padding:2px 2px 4px">
                  <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.7">
                    Same idea as above, but a bookmark captures the cookie + token for you instead of copy-pasting.
                    It relies on the browser allowing the bookmarklet to read cookies, which isn't always reliable —
                    if it doesn't say "session saved", just use the manual steps above instead.
                  </p>
                  <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;flex-wrap:wrap">
                    <div class="rg-step-num">1</div>
                    <div>
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">
                        Drag this button to your bookmarks bar (first time only)
                      </div>
                      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px">
                        Or right-click it and choose "Bookmark this link".
                      </div>
                      <a id="rgSaveSessionBmLink" href="#"
                         class="btn" style="background:var(--success);color:#fff;cursor:grab;
                                            user-select:none;white-space:nowrap;border:none;display:inline-block"
                         draggable="true"
                         onclick="showToast('Drag this to your bookmarks bar, then click it on the Rotageek page.','info');return false;">
                        Save Session to Rota App
                      </a>
                    </div>
                  </div>
                  <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div class="rg-step-num">2</div>
                    <div>
                      <div style="font-size:13px;font-weight:600;margin-bottom:4px">
                        While on the Rotageek page, click the bookmark
                      </div>
                      <div style="font-size:12.5px;color:var(--text-muted)">
                        A message will confirm the session was saved. Come back here and the page will show you're connected.
                      </div>
                    </div>
                  </div>
                </div>
              </details>

            </div><!-- /rgLoginForm -->

            <!-- ── Connected via session: auto-sync ───────────────────────── -->
            <div id="rgAutoSyncSection" style="display:none;margin-bottom:16px">
              <div class="card" style="border-left:3px solid var(--primary)">
                <div class="card-body" style="padding:16px">
                  <h4 style="font-size:14px;margin-bottom:6px">Sync my shifts</h4>
                  <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
                    Fetches your shifts directly from Rotageek and imports them.
                    Safe to run repeatedly — already-imported shifts are skipped, changes are detected.
                  </p>
                  <div class="form-row" style="margin-bottom:12px">
                    <div class="form-group">
                      <label>From</label>
                      <input type="date" id="rgSyncFrom" />
                    </div>
                    <div class="form-group">
                      <label>To</label>
                      <input type="date" id="rgSyncTo" />
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn-primary" id="rgAutoSyncBtn">Sync Now</button>
                    <button class="btn btn-ghost danger" id="rgAutoSyncDisconnectBtn">Disconnect</button>
                  </div>
                  <div id="rgAutoSyncResult" style="display:none;margin-top:12px"></div>

                  <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
                  <h4 style="font-size:14px;margin-bottom:6px">Full history check</h4>
                  <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
                    Compares your entire saved history against Rotageek (job start → +60 days) and lists every difference.
                    <strong>Compare</strong> only reports differences and changes nothing; <strong>Sync all time</strong> then applies the safe ones.
                  </p>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn-ghost" id="rgDiffAllBtn">🔍 Compare all time</button>
                    <button class="btn btn-primary" id="rgSyncAllBtn">↻ Sync all time</button>
                  </div>
                  <div id="rgDiffAllResult" style="display:none;margin-top:12px"></div>
                </div>
              </div>
            </div>

            <!-- Break Audit section -->
            <div id="rgBreakAuditSection" style="margin-bottom:16px">
              <div class="card">
                <div class="card-body" style="padding:16px">
                  <h4 style="font-size:14px;margin-bottom:6px">🔍 Break Audit</h4>
                  <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
                    Shows completed shifts where the <strong>scheduled</strong> break doesn't match what the break policy
                    would calculate for that shift length — useful for spotting shifts imported with the wrong break
                    before the sync fix. This never looks at or changes what break you actually took (full/partial/none)
                    — that's your real recorded attendance, not something to "correct".
                  </p>
                  <button class="btn btn-ghost" id="rgBreakAuditBtn">🔍 Check past shifts</button>
                  <div id="rgBreakAuditResult" style="margin-top:12px"></div>
                </div>
              </div>
            </div>

            <!-- ── Legacy fetch section (token auth — kept for compatibility) ─ -->
            <div id="rgFetchSection" style="display:none">
              <div class="card" style="margin-bottom:16px">
                <div class="card-body" style="padding:16px">
                  <h4 style="font-size:14px;margin-bottom:12px">Fetch schedule (token auth)</h4>
                  <div class="form-row">
                    <div class="form-group">
                      <label>API endpoint path</label>
                      <input type="text" id="rgEndpoint" placeholder="/api/v1/schedules" />
                    </div>
                    <div class="form-group">
                      <label>From date</label>
                      <input type="date" id="rgFrom" />
                    </div>
                    <div class="form-group">
                      <label>To date</label>
                      <input type="date" id="rgTo" />
                    </div>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn-primary" id="rgFetchBtn">Fetch</button>
                    <button class="btn btn-ghost danger" id="impRgDisconnectBtn">Disconnect</button>
                  </div>
                  <span id="rgFetchStatus" style="font-size:13px;color:var(--text-muted);margin-left:10px;display:block;margin-top:8px"></span>
                </div>
              </div>
              <div id="rgRawSection" style="display:none;margin-bottom:16px">
                <details>
                  <summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">Raw API response</summary>
                  <pre id="rgRawJson" style="font-size:11px;max-height:200px;overflow:auto;background:var(--bg);padding:10px;border-radius:6px;margin-top:8px;white-space:pre-wrap;word-break:break-all"></pre>
                </details>
              </div>
            </div>

            <!-- Preview table (shared — shown by both scraper and API methods) -->
            <div id="rgPreviewSection" style="display:none">
              <h4 style="font-size:13px;font-weight:600;margin-bottom:8px">
                Parsed shifts — <span id="rgShiftCount" style="color:var(--primary)">0</span> found
              </h4>
              <div class="table-wrapper" style="max-height:360px;overflow-y:auto;margin-bottom:16px">
                <table id="rgPreviewTable">
                  <thead><tr><th>Date</th><th>Start</th><th>End</th><th>Break</th><th>Notes</th></tr></thead>
                  <tbody id="rgPreviewBody"></tbody>
                </table>
              </div>
              <div style="display:flex;gap:10px">
                <button class="btn btn-primary" id="rgImportBtn">⬆ Import Shifts</button>
              </div>
            </div>
            <div id="rgImportResult" style="display:none;margin-top:16px"></div>
          </div>
            <div id="ssImagePreview" style="display:none;margin-top:12px;text-align:center">
              <img id="ssThumb" style="max-height:200px;max-width:100%;border-radius:6px;border:1px solid var(--border)" />
              <div style="margin-top:8px">
                <button class="btn btn-primary" id="ssScanBtn">🔍 Scan Image</button>
              </div>
            </div>
            <div id="ssScanStatus" style="display:none;margin-top:16px;text-align:center;color:var(--text-muted);font-size:13px">
              <span style="display:inline-block;animation:spin 1s linear infinite;margin-right:6px">⏳</span> Running OCR, this may take a moment…
            </div>
            <div id="ssResults" style="display:none;margin-top:20px">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
                <label style="font-size:13.5px;font-weight:500;white-space:nowrap">Filter by name:</label>
                <input type="text" id="ssNameFilter" placeholder="e.g. Edward Kay" style="flex:1;min-width:160px;max-width:300px" />
                <button class="btn btn-sm btn-secondary" id="ssClearFilter">Show all</button>
              </div>
              <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">
                <span id="ssMatchCount"></span>
                <label style="margin-left:16px;cursor:pointer">
                  <input type="checkbox" id="ssSelectAll" style="margin-right:4px" />Select all visible
                </label>
              </div>
              <div style="overflow-x:auto">
                <table style="width:100%;font-size:13px;border-collapse:collapse">
                  <thead>
                    <tr style="background:var(--bg-secondary)">
                      <th style="padding:6px 8px;text-align:left;width:32px"></th>
                      <th style="padding:6px 8px;text-align:left">Name</th>
                      <th style="padding:6px 8px;text-align:left">Date</th>
                      <th style="padding:6px 8px;text-align:left">Start</th>
                      <th style="padding:6px 8px;text-align:left">End</th>
                    </tr>
                  </thead>
                  <tbody id="ssShiftBody"></tbody>
                </table>
              </div>
              <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <button class="btn btn-primary" id="ssImportBtn">⬆ Import Selected</button>
                <span id="ssImportStatus" style="font-size:13px;color:var(--text-muted)"></span>
              </div>
              <div id="ssImportResult" style="display:none;margin-top:12px"></div>
              <details style="margin-top:16px">
                <summary style="font-size:12px;color:var(--text-muted);cursor:pointer">Raw OCR text (for debugging)</summary>
                <pre id="ssRawText" style="margin-top:8px;font-size:11px;white-space:pre-wrap;color:var(--text-muted);background:var(--bg-secondary);padding:10px;border-radius:4px;max-height:200px;overflow-y:auto"></pre>
              </details>
            </div>
            <div id="ssError" style="display:none;margin-top:16px"></div>
          </div>

        </div>

      </div>
    `;

    this.wireEvents();
  },

  // ─── Tab switching ──────────────────────────────────────────────────────────

  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.import-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('panelCsv').style.display        = tab === 'csv'        ? 'block' : 'none';
    document.getElementById('panelIcs').style.display        = tab === 'ics'        ? 'block' : 'none';
    document.getElementById('panelRotageek').style.display   = tab === 'rotageek'   ? 'block' : 'none';
    if (tab === 'rotageek') this.checkRotageekStatus();
  },

  // ─── Wire all events ────────────────────────────────────────────────────────

  wireEvents() {
    // Tab buttons
    document.querySelectorAll('.import-tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Import type radio
    document.querySelectorAll('input[name="importType"]').forEach(r => {
      r.addEventListener('change', e => { this.importType = e.target.value; });
    });

    // Drop zone
    const dropZone  = document.getElementById('importDropZone');
    const fileInput = document.getElementById('importFileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.name.match(/\.xlsx$/i)) this.loadXlsxFile(f);
      else this.loadCsvFile(f);
    });
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (f.name.match(/\.xlsx$/i)) this.loadXlsxFile(f);
      else this.loadCsvFile(f);
    });

    // ICS drop zone
    const icsDropZone  = document.getElementById('icsDropZone');
    const icsFileInput = document.getElementById('icsFileInput');

    icsDropZone.addEventListener('click', () => icsFileInput.click());
    icsFileInput.addEventListener('change', e => {
      if (e.target.files[0]) this.loadIcsFile(e.target.files[0]);
    });
    icsDropZone.addEventListener('dragover',  e => { e.preventDefault(); icsDropZone.classList.add('dragover'); });
    icsDropZone.addEventListener('dragleave', () => icsDropZone.classList.remove('dragover'));
    icsDropZone.addEventListener('drop', e => {
      e.preventDefault(); icsDropZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) this.loadIcsFile(e.dataTransfer.files[0]);
    });

    // Rotageek events
    document.getElementById('rgOpenLoginBtn')?.addEventListener('click', () => {
      window.open('https://screwfix.rotageek.com', '_blank');
    });
    document.getElementById('rgSaveSessionBtn')?.addEventListener('click', () => this.rgSaveSession());
    document.getElementById('rgAutoSyncBtn')?.addEventListener('click', () => this.rgAutoSync());
    document.getElementById('rgDiffAllBtn')?.addEventListener('click', () => this.rgDiffAll(false));
    document.getElementById('rgSyncAllBtn')?.addEventListener('click', () => this.rgDiffAll(true));
    document.getElementById('rgAutoSyncDisconnectBtn')?.addEventListener('click', () => this.rgDisconnect());
    document.getElementById('rgBreakAuditBtn')?.addEventListener('click', () => this.rgBreakAudit());
    document.getElementById('rgFetchBtn')?.addEventListener('click', () => this.rgFetch());
    document.getElementById('rgImportBtn')?.addEventListener('click', () => this.rgImport());
    document.getElementById('impRgDisconnectBtn')?.addEventListener('click', () => this.rgDisconnect());
    document.getElementById('rgParseJsonBtn')?.addEventListener('click', () => this.rgPasteJson());

    // Set bookmarklet hrefs
    this.rgSetBookmarklet();
    this.rgSetSessionBookmarklet();

    // Set team bookmarklets
    this.teamSetScraperBookmarklet();
    this.teamSetGqlBookmarklet();
  },

  // ─── XLSX flow ──────────────────────────────────────────────────────────────

  async loadXlsxFile(file) {
    if (typeof XLSX === 'undefined') {
      showToast('Loading Excel support…', '');
      try {
        await loadXlsxLib();
      } catch (e) {
        showToast('Failed to load Excel support — check your connection and try again.', 'error');
        return;
      }
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data     = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheets   = workbook.SheetNames;

        if (sheets.length === 1) {
          // Single sheet — skip picker entirely
          this.proceedWithSheets(workbook, [sheets[0]], file.name);
        } else {
          this.showSheetPicker(workbook, file);
        }
      } catch(err) {
        showToast('Failed to read Excel file: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  },

  showSheetPicker(workbook, file) {
    document.getElementById('importDropZone').style.display    = 'none';
    document.getElementById('importSheetPicker').style.display = 'block';
    document.getElementById('xlsxFileInfo').textContent =
      `${file.name} — ${workbook.SheetNames.length} sheets found`;

    const group = document.getElementById('sheetCheckboxGroup');
    group.innerHTML = workbook.SheetNames.map((name, i) =>
      `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;padding:3px 0">
        <input type="checkbox" data-sheet="${esc(name)}" ${i === 0 ? 'checked' : ''} style="width:15px;height:15px;flex-shrink:0" />
        📋 ${esc(name)}
      </label>`
    ).join('');

    document.getElementById('xlsxContinueBtn').onclick = () => {
      const selected = [...group.querySelectorAll('input[type=checkbox]:checked')]
        .map(cb => cb.dataset.sheet);
      if (!selected.length) {
        showToast('Please select at least one sheet to import', 'warning');
        return;
      }
      this.proceedWithSheets(workbook, selected, file.name);
    };

    document.getElementById('xlsxResetBtn').onclick = () => this.resetCsv();
  },

  // Convert a single sheet to CSV using formatted cell values (raw: false) so that
  // times like 11:00:00 come through as text strings rather than decimal fractions.
  // dateNF forces date cells to ISO format (2026-05-28) regardless of the cell's
  // own number format, avoiding locale/format ambiguity on the server side.
  sheetToCsv(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
    return rows.map(row =>
      row.map(cell => {
        const s = String(cell == null ? '' : cell);
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\n');
  },

  proceedWithSheets(workbook, sheetNames, fileName) {
    this.xlsxWorkbook   = workbook;
    this.selectedSheets = sheetNames;

    // Convert first selected sheet to CSV for the preview display
    const firstCsv = this.sheetToCsv(workbook.Sheets[sheetNames[0]]);

    const label = sheetNames.length === 1
      ? `${fileName}  ·  ${sheetNames[0]}`
      : `${fileName}  ·  ${sheetNames.length} sheets selected`;

    document.getElementById('importSheetPicker').style.display = 'none';
    this.initStep1(firstCsv, label);
  },

  // ─── CSV flow ───────────────────────────────────────────────────────────────

  loadCsvFile(file) {
    if (!file.name.match(/\.(csv|txt)$/i)) {
      showToast('Please upload a CSV or Excel (.xlsx) file', 'error'); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      this.xlsxWorkbook   = null;
      this.selectedSheets = [];
      this.initStep1(e.target.result, file.name);
    };
    reader.readAsText(file);
  },

  // ─── Shared Step 1 init ─────────────────────────────────────────────────────

  async initStep1(csvText, displayName) {
    this.fullCsvText = csvText;
    this.csvText     = csvText;
    this.endRow      = null;
    this.headerRow   = 0;

    document.getElementById('headerRowInput').value = 1;
    document.getElementById('endRowInput').value    = '';

    await this.fetchPreview();

    document.getElementById('importFileInfo').textContent =
      `${displayName} — ${this.totalRows} data rows`;
    document.getElementById('importDropZone').style.display      = 'none';
    document.getElementById('importSheetPicker').style.display   = 'none';
    document.getElementById('importStep1').style.display         = 'block';
    document.getElementById('importStep2').style.display         = 'none';
    document.getElementById('importResultSection').style.display = 'none';

    // Apply button: read both inputs, rebuild working CSV, re-preview
    document.getElementById('applyRowRangeBtn').onclick = async () => {
      const hVal = parseInt(document.getElementById('headerRowInput').value, 10);
      const eVal = parseInt(document.getElementById('endRowInput').value, 10);
      this.headerRow = Math.max(0, (isNaN(hVal) ? 1 : hVal) - 1);
      this.endRow    = (!isNaN(eVal) && eVal >= 1) ? eVal : null;
      this.csvText   = this.applyRowRange(this.fullCsvText);
      await this.fetchPreview();
      // Update the info line with new row count
      const info = document.getElementById('importFileInfo');
      if (info) {
        let suffix = `${this.totalRows} data rows`;
        if (this.endRow) suffix += ` (rows ${this.headerRow + 1}–${this.endRow})`;
        info.textContent = info.textContent.replace(/ — .+$/, ` — ${suffix}`);
      }
    };

    document.getElementById('proceedToMappingBtn').onclick = () => this.showMapping();
    document.getElementById('importResetBtn').onclick      = () => this.resetCsv();
  },

  // ─── Preview ────────────────────────────────────────────────────────────────

  async fetchPreview() {
    try {
      const preview = await API.importPreview(this.csvText, this.headerRow, this.endRow);
      this.headers    = preview.headers;
      this.sampleRows = preview.sample;
      this.rawRows    = preview.rawRows || [];
      this.totalRows  = preview.totalRows;
      this.renderRawPreview();
      // After rendering, scroll so the ⬇ end-row marker is visible
      if (this.endRow) {
        requestAnimationFrame(() => {
          const wrapper = document.getElementById('importRawPreview');
          const endTr   = wrapper && wrapper.querySelector(`tr[data-rownum="${this.endRow}"]`);
          if (endTr) endTr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
    } catch(err) { showToast('Failed to parse file: ' + err.message, 'error'); }
  },

  renderRawPreview() {
    const el = document.getElementById('importRawPreview');
    if (!el || !this.rawRows.length) return;

    const maxCols = Math.max(...this.rawRows.map(r => r.cells.length));

    el.innerHTML = `<table>
      <thead>
        <tr>
          <th style="background:#1B2A4A;color:#fff;width:50px">Row</th>
          ${Array.from({length: maxCols}, (_,i) => `<th>Col ${i+1}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${this.rawRows.map(r => {
          const isHeader = r.rowNum === this.headerRow + 1;
          const isEnd    = this.endRow != null && r.rowNum === this.endRow;
          let rowStyle = '';
          if (isHeader) rowStyle = 'background:rgba(255,214,0,0.15);font-weight:600';
          if (isEnd)    rowStyle += ';border-bottom:2px solid var(--danger)';
          return `<tr data-rownum="${r.rowNum}" style="${rowStyle}">
            <td style="text-align:center;font-size:11px;color:var(--text-muted);${isHeader ? 'color:var(--primary-text);font-weight:700' : ''}">
              ${r.rowNum}${isHeader ? ' ★' : ''}${isEnd ? ' ⬇' : ''}
            </td>
            ${Array.from({length: maxCols}, (_,i) =>
              `<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.cells[i]||'')}">${esc(r.cells[i] || '')}</td>`
            ).join('')}
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  },

  // ─── Row range helpers ───────────────────────────────────────────────────────

  // Trim full CSV text to endRow (1-indexed). Used for plain CSV files and preview.
  applyRowRange(text) {
    if (!text || !this.endRow) return text;
    return text.split(/\r?\n/).slice(0, this.endRow).join('\n');
  },

  // Build the final CSV to send to the server for import.
  // For xlsx multi-sheet: combine all selected sheets, skipping the header row
  // from sheets 2+ so we don't import duplicate column-name rows as data.
  buildImportCsv() {
    if (!this.xlsxWorkbook || this.selectedSheets.length === 0) {
      // Plain CSV: just apply row range to the original full text
      return this.applyRowRange(this.fullCsvText);
    }

    if (this.selectedSheets.length === 1) {
      // Single sheet selected: same as plain CSV path
      return this.applyRowRange(this.fullCsvText);
    }

    // Multiple sheets: combine
    const allRows = [];
    for (let i = 0; i < this.selectedSheets.length; i++) {
      const sheet = this.xlsxWorkbook.Sheets[this.selectedSheets[i]];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, dateNF: 'yyyy-mm-dd' });

      const startIdx = this.headerRow;
      const endIdx   = this.endRow ? this.endRow - 1 : rows.length - 1;

      if (i === 0) {
        allRows.push(...rows.slice(startIdx, endIdx + 1));
      } else {
        allRows.push(...rows.slice(startIdx + 1, endIdx + 1));
      }
    }

    return allRows.map(row =>
      row.map(cell => {
        const s = String(cell == null ? '' : cell);
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\n');
  },

  // ─── Column mapping (Step 2) ─────────────────────────────────────────────────

  getFieldsForType() {
    if (this.importType === 'shifts') {
      return [
        { key: 'date',            label: 'Date *',                required: true },
        { key: 'start_time',      label: 'Start Time *',          required: true },
        { key: 'end_time',        label: 'End Time *',            required: true },
        { key: 'break_minutes',   label: 'Break (minutes)' },
        { key: 'distance_miles',         label: 'Distance — miles there' },
        { key: 'distance_miles_return',  label: 'Distance — miles back (optional)' },
        { key: 'completed',       label: 'Completed (true/1)' },
        { key: 'notes',           label: 'Notes' },
      ];
    } else {
      return [
        { key: 'month',                 label: 'Month *',               required: true },
        { key: 'payment_date',          label: 'Payment Date' },
        { key: 'basic_pay',             label: 'Basic Salary' },
        { key: 'arrears_pay',           label: 'Arrears Pay' },
        { key: 'additional_hours_qty',  label: 'Addt Hours (qty)' },
        { key: 'additional_hours_pay',  label: 'Addt Hours (pay)' },
        { key: 'total_gross',           label: 'Total Gross' },
        { key: 'total_deductions',      label: 'Total Deductions' },
        { key: 'net_payment',           label: 'Net Payment' },
        { key: 'tax_paid',              label: 'Tax Paid' },
        { key: 'ni_employee',           label: 'NI Employee' },
        { key: 'gross_ytd',             label: 'Gross YTD' },
        { key: 'notes',                 label: 'Notes' },
      ];
    }
  },

  guessColumn(fieldKey, headers) {
    const guesses = {
      date:                 ['date','day','shift date','work date'],
      start_time:           ['start','start time','time start','from','begin'],
      end_time:             ['end','end time','time end','to','finish'],
      break_minutes:        ['break','break mins','break minutes','rest'],
      distance_miles:         ['miles there','distance there','miles out','dist there','distance','miles','dist'],
      distance_miles_return:  ['miles back','distance back','miles return','return miles','dist back','return dist'],
      completed:            ['completed','done','worked'],
      notes:                ['notes','note','comment'],
      month:                ['month','pay month','pay period'],
      payment_date:         ['payment date','pay date','paid','date paid'],
      basic_pay:            ['basic','basic salary','basic pay','base pay'],
      arrears_pay:          ['arrears','arrears pay','prev month'],
      additional_hours_qty: ['addt hours','extra hours','additional qty','extra qty'],
      additional_hours_pay: ['addt pay','extra pay','additional pay'],
      total_gross:          ['gross','total gross','gross pay','total pay'],
      total_deductions:     ['deductions','total deductions'],
      net_payment:          ['net','net payment','net pay','paid','actual paid'],
      tax_paid:             ['tax','tax paid'],
      ni_employee:          ['ni','ni employee','national insurance'],
      gross_ytd:            ['gross ytd','ytd gross','year to date gross'],
    };
    const keywords = guesses[fieldKey] || [fieldKey];
    for (const h of headers) {
      const hl = h.toLowerCase().trim();
      for (const kw of keywords) {
        if (hl.includes(kw)) return h;
      }
    }
    return '';
  },

  showMapping() {
    document.getElementById('importStep1').style.display = 'none';
    document.getElementById('importStep2').style.display = 'block';
    document.getElementById('detectedHeaderRow').textContent = this.headerRow + 1;

    const fields = this.getFieldsForType();
    const table  = document.getElementById('importMappingTable');

    table.innerHTML = fields.map(f => {
      const guess = this.guessColumn(f.key, this.headers);
      return `
        <tr>
          <td>${f.label}</td>
          <td>
            <select class="map-select" data-field="${f.key}" style="width:100%">
              <option value="">— Skip —</option>
              ${this.headers.map(h => `<option value="${esc(h)}" ${h === guess ? 'selected' : ''}>${esc(h)}</option>`).join('')}
            </select>
          </td>
        </tr>`;
    }).join('');

    const previewEl = document.getElementById('importPreviewTable');
    if (this.sampleRows.length && this.headers.length) {
      previewEl.innerHTML = `<table>
        <thead><tr>${this.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>
          ${this.sampleRows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>`;
    } else {
      previewEl.innerHTML = '<p style="padding:12px;color:var(--text-muted)">No data rows detected with this header row setting.</p>';
    }

    document.getElementById('backToStep1Btn').onclick  = () => {
      document.getElementById('importStep2').style.display = 'none';
      document.getElementById('importStep1').style.display = 'block';
    };
    document.getElementById('importCancelBtn').onclick = () => this.resetCsv();
    document.getElementById('importRunBtn').onclick    = () => this.runCsvImport();
  },

  getMapping() {
    const mapping = {};
    document.querySelectorAll('.map-select').forEach(sel => {
      if (sel.value) mapping[sel.dataset.field] = sel.value;
    });
    return mapping;
  },

  async runCsvImport() {
    const mapping  = this.getMapping();
    const required = this.importType === 'shifts' ? ['date', 'start_time', 'end_time'] : ['month'];

    for (const r of required) {
      if (!mapping[r]) {
        showToast(`Please map the required field: ${r}`, 'warning'); return;
      }
    }

    const resultEl = document.getElementById('importResultSection');
    resultEl.innerHTML = '<p style="color:var(--text-muted)">Importing…</p>';
    resultEl.style.display = 'block';

    try {
      // Build the final combined + row-ranged CSV
      const csvToImport = this.buildImportCsv();

      // When combining multiple sheets the combined CSV always starts at row 0
      // (header is the very first row), so pass headerRow=0 to the server.
      const serverHeaderRow = (this.selectedSheets.length > 1) ? 0 : this.headerRow;

      const result = this.importType === 'shifts'
        ? await API.importShifts(csvToImport, mapping, serverHeaderRow)
        : await API.importPayslips(csvToImport, mapping, serverHeaderRow);

      resultEl.innerHTML = this.resultHtml(result);
      showToast(`${result.imported} records imported!`, 'success');
      document.getElementById('importStep2').style.display = 'none';
    } catch(e) {
      resultEl.innerHTML = `<div class="card card-body" style="border-left:4px solid var(--danger);color:var(--danger)">
        Import failed: ${esc(e.message)}
      </div>`;
      showToast('Import failed: ' + e.message, 'error');
    }
  },

  resetCsv() {
    this.csvText        = null;
    this.fullCsvText    = null;
    this.xlsxWorkbook   = null;
    this.selectedSheets = [];
    this.endRow         = null;
    this.headers        = [];
    this.sampleRows     = [];
    this.rawRows        = [];
    this.headerRow      = 0;
    document.getElementById('importDropZone').style.display      = 'block';
    document.getElementById('importSheetPicker').style.display   = 'none';
    document.getElementById('importStep1').style.display         = 'none';
    document.getElementById('importStep2').style.display         = 'none';
    document.getElementById('importResultSection').style.display = 'none';
    document.getElementById('importFileInput').value = '';
  },

  // ─── ICS flow ───────────────────────────────────────────────────────────────

  loadIcsFile(file) {
    if (!file.name.match(/\.(ics|ical)$/i)) {
      showToast('Please upload a .ics calendar file', 'error'); return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      this.icsText = e.target.result;
      await this.fetchIcsPreview(file.name);
    };
    reader.readAsText(file);
  },

  async fetchIcsPreview(fileName) {
    try {
      const preview = await API.icsPreview(this.icsText);
      this.icsShifts      = preview.shifts       || [];
      this.icsLeaveEntries= preview.leaveEntries || [];
      this.icsHasUtc      = preview.hasUtc       || false;

      document.getElementById('icsDropZone').style.display    = 'none';
      document.getElementById('icsStep1').style.display       = 'block';
      document.getElementById('icsResultSection').style.display = 'none';

      const parts = [];
      if (this.icsShifts.length)       parts.push(`${this.icsShifts.length} shift event${this.icsShifts.length !== 1 ? 's' : ''}`);
      if (this.icsLeaveEntries.length) parts.push(`${this.icsLeaveEntries.length} all-day (leave) event${this.icsLeaveEntries.length !== 1 ? 's' : ''}`);
      document.getElementById('icsFileInfo').textContent = `${fileName} — ${parts.join(', ') || 'no events'} detected`;
      document.getElementById('icsShiftCount').textContent = this.icsShifts.length;
      document.getElementById('icsUtcWarning').style.display = this.icsHasUtc ? 'block' : 'none';

      this.renderIcsPreview();

      document.getElementById('icsResetBtn').onclick   = () => this.resetIcs();
      document.getElementById('icsCancelBtn').onclick  = () => this.resetIcs();
      document.getElementById('icsImportBtn').onclick  = () => this.runIcsImport();
    } catch(err) {
      showToast('Failed to parse calendar file: ' + err.message, 'error');
    }
  },

  renderIcsPreview() {
    const el = document.getElementById('icsPreviewTable');
    if (!el) return;

    if (!this.icsShifts.length && !this.icsLeaveEntries.length) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted)">
        No events found in this calendar file. Make sure it's the right file and try again.
      </div>`;
      return;
    }

    let html = '';

    if (this.icsShifts.length) {
      html += `<p style="font-weight:600;margin-bottom:8px;font-size:13px">
        📋 Shift events (${this.icsShifts.length}) — will be imported as shifts
      </p>
      <div class="table-wrapper" style="margin-bottom:16px"><table>
        <thead><tr>
          <th>Date</th><th>Start</th><th>End</th><th>Duration</th><th>Break</th><th>Event title</th>
        </tr></thead>
        <tbody>
          ${this.icsShifts.map(s => {
            const dur = s.start_time && s.end_time ? calcDuration(s.start_time, s.end_time) : '—';
            const brk = s.break_minutes > 0
              ? `<span style="color:var(--warning);font-weight:600">${s.break_minutes}m</span>`
              : `<span style="color:var(--text-muted)">none</span>`;
            return `<tr>
              <td><strong>${fmtDateShort(s.date)}</strong></td>
              <td>${s.start_time || '—'}</td><td>${s.end_time || '—'}</td>
              <td style="color:var(--text-muted)">${dur}</td><td>${brk}</td>
              <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.summary)}">${esc(s.summary) || '<span style="color:var(--text-muted)">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;
    }

    if (this.icsLeaveEntries.length) {
      html += `<p style="font-weight:600;margin-bottom:8px;font-size:13px">
        🏖️ All-day events (${this.icsLeaveEntries.length}) — will be imported as <strong>annual leave entries</strong>
      </p>
      <div class="table-wrapper"><table>
        <thead><tr>
          <th>From</th><th>To</th><th>Days (weekdays)</th><th>Event title</th>
        </tr></thead>
        <tbody>
          ${this.icsLeaveEntries.map(e => `<tr>
            <td><strong>${fmtDateShort(e.start_date)}</strong></td>
            <td>${fmtDateShort(e.end_date)}</td>
            <td><strong>${e.days_taken}</strong></td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.summary)}">${esc(e.summary) || '<span style="color:var(--text-muted)">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
    }

    el.innerHTML = html;
  },

  async runIcsImport() {
    const resultEl = document.getElementById('icsResultSection');
    resultEl.innerHTML = '<p style="color:var(--text-muted)">Importing…</p>';
    resultEl.style.display = 'block';

    try {
      const result = await API.icsImport(this.icsText, this.icsBreakMins);
      const msg = [
        result.imported      ? `${result.imported} shift${result.imported !== 1 ? 's' : ''}` : '',
        result.leaveImported ? `${result.leaveImported} leave entr${result.leaveImported !== 1 ? 'ies' : 'y'}` : '',
      ].filter(Boolean).join(' + ') || '0 records';
      resultEl.innerHTML = this.resultHtml({ ...result, importedLabel: msg });
      showToast(`${msg} imported!`, 'success');
      document.getElementById('icsStep1').style.display = 'none';
    } catch(e) {
      resultEl.innerHTML = `<div class="card card-body" style="border-left:4px solid var(--danger);color:var(--danger)">
        Import failed: ${esc(e.message)}
      </div>`;
      showToast('Import failed: ' + e.message, 'error');
    }
  },

  resetIcs() {
    this.icsText        = null;
    this.icsShifts      = [];
    this.icsLeaveEntries= [];
    document.getElementById('icsDropZone').style.display      = 'block';
    document.getElementById('icsStep1').style.display         = 'none';
    document.getElementById('icsResultSection').style.display = 'none';
    document.getElementById('icsFileInput').value             = '';
  },

  // ─── Rotageek Live ──────────────────────────────────────────────────────────

  async checkRotageekStatus() {
    try {
      const s = await API.rotageekStatus();
      this.rgConnected = s.connected;
      this.rgBaseUrl   = s.base_url || '';
      this.renderRgStatus(s);
    } catch(_) {
      this.rgConnected = false;
      this.renderRgStatus({});
    }
  },

  decodeJwtExpiry(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      if (!payload.exp) return null;
      return new Date(payload.exp * 1000);
    } catch(_) { return null; }
  },

  renderRgStatus(s) {
    const banner      = document.getElementById('rgStatusBanner');
    const fetchSec    = document.getElementById('rgFetchSection');
    const autoSyncSec = document.getElementById('rgAutoSyncSection');
    const login       = document.getElementById('rgLoginForm');
    if (!banner) return;
    if (s.connected) {
      const isSession = s.auth_mode === 'session';
      let expiryHtml = '';
      if (s.token && !isSession) {
        const exp = this.decodeJwtExpiry(s.token);
        if (exp) {
          const now  = new Date();
          const diff = exp - now;
          const expired = diff < 0;
          const days  = Math.floor(Math.abs(diff) / 86400000);
          const hours = Math.floor((Math.abs(diff) % 86400000) / 3600000);
          const label = expired
            ? `<span style="color:var(--danger)">⚠️ Token expired ${days}d ago — re-paste below</span>`
            : days > 0
              ? `<span style="color:var(--success)">expires in ${days}d ${hours}h</span>`
              : `<span style="color:var(--warning)">expires in ${hours}h</span>`;
          expiryHtml = `&nbsp;·&nbsp; ${label}`;
        }
      }
      const modeLabel = isSession ? '🍪 Session auth' : '🔑 Token auth';
      if (s.session_expired) {
        banner.innerHTML = `<div class="card card-body" style="border-left:4px solid var(--warning);padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ⚠️ <strong>Session expired</strong> — ${esc(s.base_url || '')} &nbsp;·&nbsp; ${modeLabel} &nbsp;·&nbsp; <span style="color:var(--warning)">Re-run the bookmarklet to reconnect</span>
        </div>`;
      } else {
        banner.innerHTML = `<div class="card card-body" style="border-left:4px solid var(--success);padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ✅ <strong>Connected</strong> — ${esc(s.base_url || '')} &nbsp;·&nbsp; ${modeLabel}${expiryHtml}
        </div>`;
      }
      // Session auth → show auto-sync; token auth → show fetch
      if (autoSyncSec) autoSyncSec.style.display = isSession ? 'block' : 'none';
      if (fetchSec)    fetchSec.style.display    = isSession ? 'none'  : 'block';
      if (login)       login.style.display       = 'none';
      // Pre-fill auto-sync dates: -7 days → +60 days
      if (isSession) {
        const now  = new Date();
        const from = new Date(now); from.setDate(now.getDate() - 7);
        const to   = new Date(now); to.setDate(now.getDate() + 60);
        const localStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const sf = document.getElementById('rgSyncFrom');
        const st = document.getElementById('rgSyncTo');
        if (sf && !sf.value) sf.value = localStr(from);
        if (st && !st.value) st.value = localStr(to);
      }
    } else {
      banner.innerHTML = s.session_stale
        ? `<div class="card card-body" style="border-left:4px solid var(--warning);padding:10px 14px;font-size:13px">
            ⚠️ <strong>Session no longer saved</strong> — it's been over 30 minutes since it was last saved, so it's treated as stale.
            Re-paste your cookie + CSRF token below to reconnect.
          </div>`
        : `<div class="card card-body" style="border-left:4px solid var(--warning);padding:10px 14px;font-size:13px">
            Not connected — log in to Rotageek and click the <strong>Save Session to Rota App</strong> bookmark, or paste your session below.
          </div>`;
      if (autoSyncSec) autoSyncSec.style.display = 'none';
      if (fetchSec)    fetchSec.style.display    = 'none';
      if (login)       login.style.display       = 'block';
    }
  },

  async rgSaveSession() {
    const cookie   = document.getElementById('rgCookieInput').value.trim();
    const csrf     = document.getElementById('rgCsrfInput').value.trim();
    const statusEl = document.getElementById('rgSessionStatus');
    if (!cookie || !csrf) { showToast('Paste both cookie and CSRF token', 'warning'); return; }
    try {
      await API.rotageekSaveSession({ cookie, csrf_token: csrf, base_url: 'https://screwfix.rotageek.com' });
      statusEl.textContent = '✓ Session saved';
      statusEl.style.color = 'var(--success)';
      showToast('Session saved — use 🔄 Sync Now to import shifts', 'success');
      document.getElementById('rgCookieInput').value = '';
      document.getElementById('rgCsrfInput').value   = '';
      await this.checkRotageekStatus();
    } catch(e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }
  },

  async rgAutoSync() {
    const from     = document.getElementById('rgSyncFrom').value;
    const to       = document.getElementById('rgSyncTo').value;
    const btn      = document.getElementById('rgAutoSyncBtn');
    const resultEl = document.getElementById('rgAutoSyncResult');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    resultEl.style.display = 'none';
    try {
      const result = await API.rotageekGraphqlSync({ from, to });
      resultEl.style.display = 'block';
      if (result.error) {
        resultEl.innerHTML = `<div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">
          ✗ ${esc(result.error)}${result.error.includes('expired') ? ' — use the bookmarklet or paste fresh session values below.' : ''}
        </div>`;
        showToast('Sync failed', 'error');
      } else if (result.imported > 0 || result.changed > 0) {
        const parts = [];
        if (result.imported > 0) parts.push(`${result.imported} new shift${result.imported !== 1 ? 's' : ''} added`);
        if (result.changed  > 0) parts.push(`${result.changed} shift${result.changed !== 1 ? 's' : ''} updated`);
        const changeRows = (result.changeDetails || []).map(c => {
          if (c.type === 'removed') return `<div style="margin-top:4px;font-size:12px;color:var(--danger)">✗ ${esc(c.date)}: ${esc(c.old_start)}–${esc(c.old_end)} removed</div>`;
          return `<div style="margin-top:4px;font-size:12px;color:var(--text-muted)">${esc(c.date)}: ${esc(c.old_start)}–${esc(c.old_end)} → ${esc(c.new_start)}–${esc(c.new_end)}</div>`;
        }).join('');
        resultEl.innerHTML = `<div style="padding:10px;background:rgba(34,197,94,.1);border-left:4px solid var(--success);border-radius:4px;font-size:13px">
          <strong style="color:var(--success)">✓ ${parts.join(' · ')}</strong>
          ${result.skipped ? `<span style="color:var(--text-muted)"> · ${result.skipped} unchanged</span>` : ''}
          ${changeRows}
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px">${esc(result.from || from)} → ${esc(result.to || to)}</div>
        </div>`;
        showToast(parts.join(', ') + ' ✓', 'success');
      } else {
        resultEl.innerHTML = `<div style="padding:10px;background:var(--bg);border-left:4px solid var(--border);border-radius:4px;font-size:13px;color:var(--text-muted)">
          Already up to date — ${result.skipped || 0} shift${(result.skipped || 0) !== 1 ? 's' : ''} checked, none changed
        </div>`;
        showToast('Already up to date', 'info');
      }
    } catch(e) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `<div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">
        ✗ ${esc(e.message)}
      </div>`;
      showToast('Sync failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Sync Now';
    }
  },

  async rgDiffAll(apply) {
    const diffBtn = document.getElementById('rgDiffAllBtn');
    const syncBtn = document.getElementById('rgSyncAllBtn');
    const resultEl = document.getElementById('rgDiffAllResult');
    const activeBtn = apply ? syncBtn : diffBtn;
    const origLabel = activeBtn.textContent;
    [diffBtn, syncBtn].forEach(b => b && (b.disabled = true));
    activeBtn.textContent = apply ? 'Syncing…' : 'Comparing…';
    resultEl.style.display = 'none';
    try {
      const result = apply ? await API.rotageekSyncAll({}) : await API.rotageekDiffAll({});
      resultEl.style.display = 'block';
      if (result.error) {
        resultEl.innerHTML = `<div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">✗ ${esc(result.error)}</div>`;
        showToast('Comparison failed', 'error');
        return;
      }
      const diffs = result.diffs || [];
      const labelFor = { new:'New', changed:'Time changed', changed_completed:'Time changed (completed)', break:'Break differs', removed:'Removed', missing:'Missing from Rotageek' };
      const colorFor = { new:'var(--success)', changed:'var(--info)', changed_completed:'var(--info)', break:'#ec4899', removed:'var(--danger)', missing:'var(--text-muted)' };
      const counts = diffs.reduce((a,d)=>{a[d.type]=(a[d.type]||0)+1;return a;},{});
      if (!diffs.length) {
        resultEl.innerHTML = `<div style="padding:10px;background:var(--bg);border-left:4px solid var(--success);border-radius:4px;font-size:13px;color:var(--text-muted)">
          ✓ No differences found across ${esc(result.from)} → ${esc(result.to)} (${result.total || 0} Rotageek shifts checked)</div>`;
        showToast('No differences found', 'success');
        return;
      }
      const summary = Object.keys(counts).map(k => `<span style="color:${colorFor[k]};font-weight:600">${counts[k]} ${labelFor[k]||k}</span>`).join(' · ');
      diffs.sort((a,b)=> (a.date||'').localeCompare(b.date||''));

      if (apply) {
        // "Sync all time" — applied everything safe already; show a plain summary
        const rowHtml = (d) => {
          const c = colorFor[d.type] || 'var(--text-muted)';
          return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px">
            <span style="min-width:88px;color:var(--text-muted)">${esc(d.date)}</span>
            <span style="min-width:104px;color:${c};font-weight:600">${labelFor[d.type] || d.type}</span>
            <span>${this._diffDetail(d)}</span></div>`;
        };
        resultEl.innerHTML = `<div style="padding:10px;background:var(--bg);border-left:4px solid var(--primary);border-radius:4px">
          <div style="font-size:13px;margin-bottom:8px">✓ Applied where safe — ${summary}</div>
          <div style="max-height:340px;overflow:auto">${diffs.map(rowHtml).join('')}</div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:8px">${esc(result.from)} → ${esc(result.to)} · completed shifts were not auto-changed</div>
        </div>`;
        showToast('Full sync applied', 'success');
        return;
      }

      // Compare mode — selectable list with checkboxes + "Apply selected"
      this._lastDiffs = diffs;
      // Sensible defaults: pre-tick everything except destructive "missing" deletes
      const defaultChecked = (d) => d.type !== 'missing';
      const rowHtml = (d, i) => {
        const c = colorFor[d.type] || 'var(--text-muted)';
        const note = d.type === 'missing' ? ' <span style="color:var(--danger)">(would delete)</span>'
                   : d.completed ? ' <span style="color:var(--text-muted)">(completed)</span>' : '';
        return `<tr>
          <td style="width:34px;text-align:center;padding:6px 4px">
            <input type="checkbox" class="rg-diff-cb" data-idx="${i}" ${defaultChecked(d) ? 'checked' : ''} style="accent-color:var(--primary)" />
          </td>
          <td style="white-space:nowrap;color:var(--text-muted);padding:6px 8px">${esc(d.date)}</td>
          <td style="white-space:nowrap;color:${c};font-weight:600;padding:6px 8px">${labelFor[d.type] || d.type}</td>
          <td style="padding:6px 8px">${this._diffDetail(d)}${note}</td>
        </tr>`;
      };
      resultEl.innerHTML = `<div style="padding:10px;background:var(--bg);border-left:4px solid var(--primary);border-radius:4px">
        <div style="font-size:13px;margin-bottom:6px">${summary}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:12px">
          <button class="btn btn-ghost btn-sm" id="rgDiffSelAll">Select all</button>
          <button class="btn btn-ghost btn-sm" id="rgDiffSelNone">Select none</button>
          ${Object.keys(counts).map(k => `<button class="btn btn-ghost btn-sm rg-diff-type-toggle" data-type="${k}" style="color:${colorFor[k]}">Toggle ${labelFor[k]||k}</button>`).join('')}
        </div>
        <div style="max-height:360px;overflow:auto">
          <table class="rg-diff-table" style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border)">
              <th style="width:34px;padding:4px"></th><th style="padding:4px 8px">Date</th><th style="padding:4px 8px">Change</th><th style="padding:4px 8px">Detail</th>
            </tr></thead>
            <tbody>${diffs.map(rowHtml).join('')}</tbody>
          </table>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn-primary" id="rgApplySelectedBtn">✓ Apply selected (<span id="rgDiffSelCount">0</span>)</button>
          <span style="font-size:11.5px;color:var(--text-muted)">${esc(result.from)} → ${esc(result.to)} · selected completed shifts WILL be updated</span>
        </div>
      </div>`;

      const updateCount = () => {
        const n = resultEl.querySelectorAll('.rg-diff-cb:checked').length;
        const el = document.getElementById('rgDiffSelCount'); if (el) el.textContent = n;
      };
      resultEl.querySelectorAll('.rg-diff-cb').forEach(cb => cb.addEventListener('change', updateCount));
      document.getElementById('rgDiffSelAll').addEventListener('click', () => { resultEl.querySelectorAll('.rg-diff-cb').forEach(cb => cb.checked = true); updateCount(); });
      document.getElementById('rgDiffSelNone').addEventListener('click', () => { resultEl.querySelectorAll('.rg-diff-cb').forEach(cb => cb.checked = false); updateCount(); });
      resultEl.querySelectorAll('.rg-diff-type-toggle').forEach(btn => btn.addEventListener('click', () => {
        const t = btn.dataset.type;
        const rows = [...resultEl.querySelectorAll('.rg-diff-cb')].filter(cb => this._lastDiffs[+cb.dataset.idx].type === t);
        const allOn = rows.every(cb => cb.checked);
        rows.forEach(cb => cb.checked = !allOn);
        updateCount();
      }));
      document.getElementById('rgApplySelectedBtn').addEventListener('click', () => this.rgApplySelected());
      updateCount();
      showToast(`${diffs.length} difference${diffs.length!==1?'s':''} found`, 'info');
    } catch(e) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `<div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">✗ ${esc(e.message)}</div>`;
      showToast('Failed: ' + e.message, 'error');
    } finally {
      [diffBtn, syncBtn].forEach(b => b && (b.disabled = false));
      activeBtn.textContent = origLabel;
    }
  },

  _diffDetail(d) {
    if (d.type === 'new')      return `${esc(d.start)}–${esc(d.end)} (break ${d.break}m)`;
    if (d.type === 'changed' || d.type === 'changed_completed')
      return `${esc(d.old_start)}–${esc(d.old_end)} → ${esc(d.new_start)}–${esc(d.new_end)}${d.new_break != null ? ` (break ${d.new_break}m)` : ''}`;
    if (d.type === 'break')    return `${esc(d.start)}–${esc(d.end)}: break ${d.old_break}m → ${d.new_break}m`;
    if (d.type === 'removed')  return `${esc(d.old_start)}–${esc(d.old_end)} no longer on rota`;
    if (d.type === 'missing')  return `${esc(d.old_start)}–${esc(d.old_end)} not returned by Rotageek`;
    return '';
  },

  async rgApplySelected() {
    const resultEl = document.getElementById('rgDiffAllResult');
    const btn = document.getElementById('rgApplySelectedBtn');
    const chosen = [...resultEl.querySelectorAll('.rg-diff-cb:checked')]
      .map(cb => (this._lastDiffs || [])[+cb.dataset.idx])
      .filter(Boolean);
    if (!chosen.length) { showToast('Nothing selected', 'warning'); return; }
    if (!confirm(`Apply ${chosen.length} selected change${chosen.length!==1?'s':''}? This updates your saved shifts (including any selected completed ones).`)) return;
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const res = await API.rotageekApplyDiffs(chosen);
      if (res.error) { showToast('Apply failed: ' + res.error, 'error'); return; }
      showToast(`Applied ${res.applied} change${res.applied!==1?'s':''}${res.skipped ? ` · ${res.skipped} skipped` : ''}`, 'success');
      // Refresh the comparison so the list reflects what's left
      await this.rgDiffAll(false);
    } catch(e) {
      showToast('Apply failed: ' + e.message, 'error');
    } finally {
      if (document.body.contains(btn)) { btn.disabled = false; }
    }
  },

  async rgBreakAudit() {
    const btn      = document.getElementById('rgBreakAuditBtn');
    const resultEl = document.getElementById('rgBreakAuditResult');
    btn.disabled   = true;
    btn.textContent = 'Checking…';
    resultEl.innerHTML = '';

    try {
      const rows = await API.breakAudit();

      if (!rows.length) {
        resultEl.innerHTML = `<div style="padding:10px;background:rgba(34,197,94,.1);border-left:4px solid var(--success);border-radius:4px;font-size:13px">
          ✓ All completed shifts have the expected break — nothing to fix.
        </div>`;
        return;
      }

      const fmtH = h => h === 0 ? '—' : (h > 0 ? `+${h}h` : `${h}h`);
      const fmtMin = m => m === 0 ? 'None' : `${m} min`;
      const dayName = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      const takenLabel = r => r.break_taken === 'none' ? 'None (worked through)'
        : r.break_taken === 'partial' ? `Partial, ${r.break_taken_minutes}m`
        : `Full, ${r.break_taken_minutes}m`;

      const tableRows = rows.map(r => `
        <tr>
          <td><input type="checkbox" class="audit-chk" data-id="${r.id}" checked /></td>
          <td>${esc(r.date)}</td>
          <td>${dayName(r.date)}</td>
          <td>${esc(r.start_time)}–${esc(r.end_time)}</td>
          <td style="color:var(--danger)">${fmtMin(r.stored_break)}</td>
          <td style="color:var(--success)">${fmtMin(r.expected_break)}</td>
          <td style="color:var(--text-muted)" title="Not affected by this correction">${esc(takenLabel(r))}</td>
          <td>${r.stored_hours.toFixed(2)}h</td>
          <td>${r.corrected_hours.toFixed(2)}h</td>
          <td style="color:${r.diff_hours >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600">${r.diff_hours >= 0 ? '+' : ''}${r.diff_hours.toFixed(2)}h</td>
        </tr>`).join('');

      resultEl.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">
          ${rows.length} shift${rows.length !== 1 ? 's' : ''} where the <strong>scheduled</strong> break doesn't match policy for the shift length.
          This only corrects the scheduled break (and the pay hours that come from it) — it never changes what break you actually took.
          Tick the ones you want to correct.
        </div>
        <div class="table-wrapper" style="max-height:400px;overflow-y:auto;margin-bottom:12px">
          <table style="font-size:12.5px">
            <thead>
              <tr>
                <th><input type="checkbox" id="auditChkAll" checked title="Select all" /></th>
                <th>Date</th><th>Day</th><th>Shift</th>
                <th>Scheduled break (stored)</th><th>Scheduled break (expected)</th>
                <th>Break actually taken</th>
                <th>Paid hrs (stored)</th><th>Paid hrs (corrected)</th><th>Diff</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" id="rgBreakAuditApplyBtn">✓ Apply selected corrections</button>
          <span id="rgBreakAuditApplyStatus" style="font-size:12.5px;color:var(--text-muted)"></span>
        </div>
        <div id="rgBreakAuditApplyResult" style="margin-top:10px"></div>`;

      // Select-all toggle
      document.getElementById('auditChkAll').addEventListener('change', e => {
        document.querySelectorAll('.audit-chk').forEach(c => c.checked = e.target.checked);
      });

      // Apply button
      document.getElementById('rgBreakAuditApplyBtn').addEventListener('click', async () => {
        const ids = [...document.querySelectorAll('.audit-chk:checked')].map(c => Number(c.dataset.id));
        if (!ids.length) { showToast('No shifts selected', 'info'); return; }
        const applyBtn = document.getElementById('rgBreakAuditApplyBtn');
        const statusEl = document.getElementById('rgBreakAuditApplyStatus');
        applyBtn.disabled = true;
        statusEl.textContent = `Applying ${ids.length} correction${ids.length !== 1 ? 's' : ''}…`;
        try {
          const result = await API.breakAuditApply(ids);
          document.getElementById('rgBreakAuditApplyResult').innerHTML = `
            <div style="padding:10px;background:rgba(34,197,94,.1);border-left:4px solid var(--success);border-radius:4px;font-size:13px">
              ✓ ${result.updated} shift${result.updated !== 1 ? 's' : ''} corrected — reload the Weekly Report to see updated hours.
            </div>`;
          statusEl.textContent = '';
          showToast(`${result.updated} break${result.updated !== 1 ? 's' : ''} corrected ✓`, 'success');
        } catch(e) {
          document.getElementById('rgBreakAuditApplyResult').innerHTML = `
            <div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">
              ✗ ${esc(e.message)}
            </div>`;
          applyBtn.disabled = false;
          statusEl.textContent = '';
        }
      });

    } catch(e) {
      resultEl.innerHTML = `<div style="padding:10px;background:rgba(239,68,68,.1);border-left:4px solid var(--danger);border-radius:4px;font-size:13px;color:var(--danger)">
        ✗ ${esc(e.message)}
      </div>`;
    } finally {
      btn.disabled    = false;
      btn.textContent = '🔍 Check past shifts';
    }
  },

  async rgFetch() {
    const endpoint = document.getElementById('rgEndpoint').value.trim() || '/api/v1/schedules';
    const from     = document.getElementById('rgFrom').value;
    const to       = document.getElementById('rgTo').value;
    const status   = document.getElementById('rgFetchStatus');
    const btn      = document.getElementById('rgFetchBtn');

    const params = {};
    if (from) params.from = from;
    if (to)   params.to   = to;

    btn.disabled = true; status.textContent = 'Fetching…';
    document.getElementById('rgRawSection').style.display     = 'none';
    document.getElementById('rgPreviewSection').style.display = 'none';
    document.getElementById('rgImportResult').style.display   = 'none';
    document.getElementById('rgJsonStatus') && (document.getElementById('rgJsonStatus').textContent = '');

    try {
      const data = await API.rotageekFetch(endpoint, params);
      document.getElementById('rgRawJson').textContent = JSON.stringify(data, null, 2);
      document.getElementById('rgRawSection').style.display = 'block';

      const shifts = this.rgParseSchedule(data);
      this.rgPreviewShifts = shifts;
      this.rgRenderPreview(shifts);
      status.textContent = shifts.length ? `${shifts.length} shifts parsed` : 'No shifts parsed — check raw response';
    } catch(e) {
      status.textContent = 'Error: ' + e.message;
      showToast('Fetch failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  rgParseSchedule(data) {
    let items = [];
    if (Array.isArray(data))              items = data;
    else if (Array.isArray(data.shifts))  items = data.shifts;
    else if (Array.isArray(data.events))  items = data.events;
    else if (Array.isArray(data.schedules)) items = data.schedules;
    else if (data.data && Array.isArray(data.data)) items = data.data;

    const shifts = [];
    for (const item of items) {
      const date       = item.date || item.shift_date || item.start_date ||
                         (item.start_time && item.start_time.slice(0, 10)) || null;
      const startRaw   = item.start_time || item.start || item.starts_at || item.from || null;
      const endRaw     = item.end_time   || item.end   || item.ends_at   || item.to   || null;

      if (!date || !startRaw || !endRaw) continue;

      const toTime = v => {
        if (!v) return null;
        const m = String(v).match(/(\d{2}:\d{2})/);
        return m ? m[1] : null;
      };
      const start_time = toTime(startRaw);
      const end_time   = toTime(endRaw);
      if (!start_time || !end_time) continue;

      shifts.push({
        date:         typeof date === 'string' ? date.slice(0, 10) : date,
        start_time,
        end_time,
        break_minutes: item.break_minutes || item.break_duration || 0,
        notes:         item.name || item.title || item.role || item.position || item.notes || null,
      });
    }
    shifts.sort((a, b) => a.date.localeCompare(b.date));
    return shifts;
  },

  rgRenderPreview(shifts) {
    const section = document.getElementById('rgPreviewSection');
    const tbody   = document.getElementById('rgPreviewBody');
    document.getElementById('rgShiftCount').textContent = shifts.length;
    if (!shifts.length) { section.style.display = 'none'; return; }
    tbody.innerHTML = shifts.map(s => `<tr>
      <td>${fmtDateShort(s.date)}</td>
      <td>${s.start_time}</td>
      <td>${s.end_time}</td>
      <td>${s.break_minutes ? s.break_minutes + ' min' : '—'}</td>
      <td>${esc(s.notes || '—')}</td>
    </tr>`).join('');
    section.style.display = 'block';
  },

  async rgImport() {
    const btn = document.getElementById('rgImportBtn');
    btn.disabled = true;
    try {
      const result = await API.rotageekImport({ shifts: this.rgPreviewShifts });
      document.getElementById('rgImportResult').innerHTML = this.resultHtml(result);
      document.getElementById('rgImportResult').style.display = 'block';
      document.getElementById('rgPreviewSection').style.display = 'none';
      showToast(`Imported ${result.imported} shifts`, 'success');
    } catch(e) {
      showToast('Import failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  async rgDisconnect() {
    try {
      await API.rotageekDisconnect();
      this.rgConnected = false;
      this.rgPreviewShifts = [];
      document.getElementById('rgFetchSection').style.display    = 'none';
      document.getElementById('rgLoginForm').style.display       = 'block';
      document.getElementById('rgPreviewSection').style.display  = 'none';
      document.getElementById('rgImportResult').style.display    = 'none';
      document.getElementById('rgRawSection').style.display      = 'none';
      document.getElementById('rgStatusBanner').innerHTML = `<div class="card card-body" style="border-left:4px solid var(--warning);padding:10px 14px;font-size:13px">
        ⚠️ Disconnected — use one of the options below to reconnect.
      </div>`;
      const cookieEl = document.getElementById('rgCookieInput');   if (cookieEl) cookieEl.value = '';
      const csrfEl   = document.getElementById('rgCsrfInput');     if (csrfEl)   csrfEl.value = '';
      const sessEl   = document.getElementById('rgSessionStatus'); if (sessEl)   sessEl.textContent = '';
      showToast('Disconnected from Rotageek', 'success');
    } catch(e) {
      showToast('Failed to disconnect: ' + e.message, 'error');
    }
  },

  // ─── Rotageek Page Scraper bookmarklet ──────────────────────────────────────

  rgGetBookmarkletFn() {
    return function() {
      if (!/rotageek\.com/i.test(location.hostname)) {
        alert('Run this on screwfix.rotageek.com/schedule');
        return;
      }
      var urlMatch = location.pathname.match(/\/schedule\/(\d{4})\/(\w+)/i);
      if (!urlMatch) {
        alert('Navigate to: screwfix.rotageek.com/schedule/2026/June');
        return;
      }
      var yr = parseInt(urlMatch[1]);
      var mns = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      var mn = mns.indexOf(urlMatch[2].toLowerCase());
      if (mn === -1) { alert('Unknown month: ' + urlMatch[2]); return; }

      var prevYr = mn===0?yr-1:yr, prevMn = mn===0?11:mn-1;
      var nextYr = mn===11?yr+1:yr, nextMn = mn===11?0:mn+1;
      function pad(n) { return String(n).padStart(2,'0'); }
      function makeDate(y,m0,d) { return y+'-'+pad(m0+1)+'-'+pad(d); }

      var allItems = [...document.querySelectorAll('.schedule__item')];
      var dayItems = allItems.filter(function(item) {
        return /^\d{1,2}$/.test(item.innerText.trim().split('\n')[0]);
      });

      if (!dayItems.length) {
        alert('No schedule items found.\nMake sure you are on the schedule page.');
        return;
      }

      var seenCurrent = false, seenCurrentEnd = false;
      var assigned = dayItems.map(function(item) {
        var isPast = item.className.indexOf('--past') !== -1;
        var day = parseInt(item.innerText.trim().split('\n')[0]);
        if (!isPast) seenCurrent = true;
        if (seenCurrent && isPast) seenCurrentEnd = true;
        var dateStr = (isPast && !seenCurrent) ? makeDate(prevYr, prevMn, day) :
                      (isPast && seenCurrentEnd) ? makeDate(nextYr, nextMn, day) :
                      makeDate(yr, mn, day);
        return { item: item, date: dateStr };
      });

      var shifts = [];
      assigned.forEach(function(d) {
        var shiftEls = [...d.item.querySelectorAll('.shift--approved')];
        shiftEls.forEach(function(shift) {
          var mainGroup = shift.querySelector('.shift__group:not(.shift__group--task)');
          if (!mainGroup) return;
          var timeEls = [...mainGroup.querySelectorAll('.shift__row--time .shift__value')];
          if (timeEls.length < 2) return;
          var start = timeEls[0].innerText.trim();
          var end   = timeEls[1].innerText.trim();
          if (!start || !end) return;
          var brk = (mainGroup.innerText || '').match(/(\d+)m\s+unpaid/i);
          var bm  = brk ? parseInt(brk[1]) : 0;
          var tasks = [...shift.querySelectorAll('.shift__group--task')].map(function(g) {
            var lbl = g.querySelector('.shift__item:last-child .shift__value');
            return lbl ? lbl.innerText.trim() : '';
          }).filter(Boolean).join(', ');
          shifts.push({ date: d.date, start_time: start, end_time: end, break_minutes: bm, notes: tasks || null });
        });
      });

      shifts.sort(function(a,b) { return a.date < b.date ? -1 : 1; });

      if (!shifts.length) {
        alert('No approved shifts found!\n\nTips:\n• Make sure your shifts are visible on screen\n• URL should be: screwfix.rotageek.com/schedule/2026/June');
        return;
      }

      var json = JSON.stringify(shifts);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(
          function() { alert('✅ Copied ' + shifts.length + ' shift' + (shifts.length!==1?'s':'') + ' to clipboard!\n\nNow paste in: Rota App → Import → Rotageek Live'); },
          function() { prompt('Copy all (Ctrl+A, Ctrl+C):', json); }
        );
      } else {
        prompt('Copy all (Ctrl+A, Ctrl+C):', json);
      }
    };
  },

  rgSetBookmarklet() {
    const link = document.getElementById('rgBookmarkletLink');
    if (!link) return;
    try {
      const fn = this.rgGetBookmarkletFn();
      link.href = 'javascript:(' + encodeURIComponent(fn.toString()) + ')();';
    } catch(e) {
      console.warn('Could not set bookmarklet href:', e);
    }
  },

  rgSetSessionBookmarklet() {
    const link = document.getElementById('rgSaveSessionBmLink');
    if (!link) return;
    const appOrigin = location.origin; // e.g. http://192.168.1.100:3000
    // Use window.open (navigation) instead of fetch — avoids HTTPS→HTTP mixed-content block.
    // Data is base64-encoded JSON passed as a query param to a GET endpoint.
    const code = [
      '(function(){',
      '  var cookie=document.cookie;',
      '  if(!cookie){alert("No cookies found. Make sure you are on the Rotageek site and logged in.");return;}',
      '  var csrf="";',
      '  cookie.split(";").forEach(function(c){',
      '    var p=c.trim().split("=");',
      '    var k=p[0].toLowerCase().replace(/-/g,"");',
      '    if(k==="requestverificationtoken"||k.indexOf("antiforgery")>=0)',
      '      csrf=p.slice(1).join("=");',
      '  });',
      '  var m=document.querySelector("meta[name=\"csrf-token\"],meta[name=\"requestverificationtoken\"]");',
      '  if(m&&!csrf) csrf=m.content||"";',
      '  var data=btoa(JSON.stringify({cookie:cookie,csrf_token:csrf,base_url:location.origin}));',
      '  window.open("' + appOrigin + '/api/rotageek/save-session-bm?data="+encodeURIComponent(data),"_blank");',
      '})()',
    ].join('');
    link.href = 'javascript:' + code;
  },

  rgPasteJson() {
    const jsonStr = (document.getElementById('rgScrapedJson')?.value || '').trim();
    const status  = document.getElementById('rgJsonStatus');
    if (!jsonStr) { showToast('Paste the JSON copied by the bookmarklet first', 'warning'); return; }
    try {
      const shifts = this.rgParseBookmarkletJson(jsonStr);
      if (!shifts.length) {
        if (status) status.textContent = 'No valid shifts found in JSON';
        showToast('No valid shifts in the pasted JSON', 'warning');
        return;
      }
      this.rgPreviewShifts = shifts;
      this.rgRenderPreview(shifts);
      if (status) status.textContent = `${shifts.length} shifts ready`;
      document.getElementById('rgPreviewSection')?.scrollIntoView({ behavior: 'smooth' });
      showToast(`${shifts.length} shifts parsed — review and import below`, 'success');
    } catch(e) {
      if (status) status.textContent = 'Error: ' + e.message;
      showToast('Parse error: ' + e.message, 'error');
    }
  },

  rgParseBookmarkletJson(jsonStr) {
    let data;
    try { data = JSON.parse(jsonStr); }
    catch(e) { throw new Error('Invalid JSON — ' + e.message); }
    if (!Array.isArray(data)) throw new Error('Expected a JSON array (the bookmarklet should produce [ … ])');
    const shifts = [];
    for (const item of data) {
      if (!item.date || !item.start_time || !item.end_time) continue;
      shifts.push({
        date:          item.date,
        start_time:    item.start_time,
        end_time:      item.end_time,
        break_minutes: item.break_minutes || 0,
        notes:         item.notes || null,
      });
    }
    shifts.sort((a, b) => a.date.localeCompare(b.date));
    return shifts;
  },

  // --- Shared helpers -------------------------------------------------------

  resultHtml(result) {
    const label = result.importedLabel || `${result.imported} records`;
    return `
      <div class="card card-body" style="border-left:4px solid var(--success)">
        <h3 style="margin-bottom:8px;color:var(--success)">Import complete</h3>
        <p><strong>${label}</strong> imported</p>
        <p style="color:var(--text-muted)">${result.skipped || 0} rows skipped</p>
        ${result.errors && result.errors.length ? `
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:13px;color:var(--warning)">${result.errors.length} row errors (click to expand)</summary>
            <ul style="margin-top:6px;font-size:12px;color:var(--text-muted)">
              ${result.errors.map(e => `<li>${esc(e)}</li>`).join('')}
            </ul>
          </details>` : ''}
      </div>`;
  },
  // Team bookmarklet stubs — elements removed, kept to avoid wireEvents errors
  teamSetScraperBookmarklet() {},
  teamSetGqlBookmarklet() {},

};
