/* Thin wrapper around fetch for the REST API */

const API = {
  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      let msg = err?.error;
      if (!msg) {
        msg = (res.status === 502 || res.status === 503 || res.status === 504)
          ? 'The request timed out. This usually happens with a very large date range — try a smaller range and try again.'
          : (res.statusText || `HTTP ${res.status}`);
      }
      throw new Error(msg);
    }
    return res.json();
  },

  get:    (path)        => API.request('GET',    path),
  post:   (path, body)  => API.request('POST',   path, body),
  put:    (path, body)  => API.request('PUT',    path, body),
  patch:  (path, body)  => API.request('PATCH',  path, body),
  delete: (path)        => API.request('DELETE', path),

  // Shifts
  getShifts:     (params = {}) => API.get('/api/shifts?' + new URLSearchParams(params)),
  getShift:      (id)          => API.get(`/api/shifts/${id}`),
  createShift:   (data)        => API.post('/api/shifts', data),
  updateShift:   (id, data)    => API.put(`/api/shifts/${id}`, data),
  completeShift: (id, data)    => API.patch(`/api/shifts/${id}/complete`, data),
  deleteShift:   (id)          => API.delete(`/api/shifts/${id}`),

  // Payslips
  getPayslips:   (params = {}) => API.get('/api/payslips?' + new URLSearchParams(params)),
  getPayslip:    (id)          => API.get(`/api/payslips/${id}`),
  createPayslip: (data)        => API.post('/api/payslips', data),
  updatePayslip: (id, data)    => API.put(`/api/payslips/${id}`, data),
  deletePayslip: (id)          => API.delete(`/api/payslips/${id}`),

  // Pay rates
  getPayRates:   ()         => API.get('/api/pay-rates'),
  createPayRate: (data)     => API.post('/api/pay-rates', data),
  updatePayRate: (id, data) => API.put(`/api/pay-rates/${id}`, data),
  deletePayRate: (id)       => API.delete(`/api/pay-rates/${id}`),

  // Settings
  getSettings:  ()     => API.get('/api/settings'),
  saveSettings: (data) => API.post('/api/settings', data),

  // Commute & weather (V2.0 Phase 2.1)
  geocodePostcode:    (postcode) => API.post('/api/commute/geocode', { postcode }),
  getCommuteWeather:  (date, start, end) => API.get(`/api/commute/weather?${new URLSearchParams({ date, start, end })}`),
  getForecast:        (days) => API.get(`/api/commute/forecast${days ? '?days=' + days : ''}`),

  // Streaks & Badges (V2.0)
  getStreaks:         () => API.get('/api/streaks'),

  // Rota Wrapped (V2.0)
  getWrapped:         (year) => API.get(`/api/wrapped${year ? '?year=' + year : ''}`),

  // Synergy score (V2.0 Phase 2.2)
  getSynergyScore:    (date) => API.get(`/api/working-with/synergy-score/${date}`),

  // Team Pay & Analytics (V2.0 Phase 3)
  getTeamMetrics:     (week) => API.get(`/api/team-metrics?${new URLSearchParams({ week })}`),

  // Clopening & Fatigue Audit (V2.0 Phase 4.1)
  getFatigueAudit:    (week) => API.get(`/api/fatigue-audit?${new URLSearchParams({ week })}`),

  // Homelab & Smart Home Webhooks (V2.0 Phase 5)
  getWebhookConfig:   ()     => API.get('/api/webhooks/config'),
  saveWebhookConfig:  (data) => API.post('/api/webhooks/config', data),
  testWebhook:        ()     => API.post('/api/webhooks/test', {}),
  getWebhookLog:      ()     => API.get('/api/webhooks/log'),

  bulkCompleteShifts: (ids, completed = true, breakOverride) =>
    API.patch('/api/shifts/bulk-complete', { ids, completed, ...breakOverride }),

  // Reports
  getReportSummary: (params = {}) => API.get('/api/reports/summary?' + new URLSearchParams(params)),
  getMonthlyReport: (params = {}) => API.get('/api/reports/monthly?' + new URLSearchParams(params)),
  getWeeklyReport:   (params = {}) => API.get('/api/reports/weekly?' + new URLSearchParams(params)),
  getYearlyReport:   ()             => API.get('/api/reports/yearly'),
  getInsightsReport: (params = {}) => API.get('/api/reports/insights?' + new URLSearchParams(params)),
  getShiftHeatmap:   (year)         => API.get('/api/insights/heatmap?year=' + year),

  // Leave
  getLeave:    (params = {}) => API.get('/api/leave?' + new URLSearchParams(params)),
  getBestLeaveDays: (days) => API.get('/api/leave/best-days' + (days ? '?days=' + days : '')),
  createLeave: (data)        => API.post('/api/leave', data),
  updateLeave: (id, data)    => API.put(`/api/leave/${id}`, data),
  deleteLeave: (id)          => API.delete(`/api/leave/${id}`),

  // Import — CSV
  importPreview:  (csv, headerRow = 0, endRow = null) => API.post('/api/import/preview', { csv, headerRow, endRow }),
  importShifts:   (csv, mapping, headerRow = 0) => API.post('/api/import/shifts', { csv, mapping, headerRow }),
  importPayslips: (csv, mapping, headerRow = 0) => API.post('/api/import/payslips', { csv, mapping, headerRow }),

  // Import — ICS / iCalendar
  icsPreview: (ics)                    => API.post('/api/import/ics-preview', { ics }),
  icsImport:  (ics, breakMinutes = 30) => API.post('/api/import/ics-shifts',  { ics, breakMinutes }),

  // Calendar notes
  getCalendarNotes:    (params = {}) => API.get('/api/calendar-notes?' + new URLSearchParams(params)),
  saveCalendarNote:    (data)        => API.post('/api/calendar-notes', data),
  deleteCalendarNote:  (id)          => API.delete(`/api/calendar-notes/${id}`),

  // Backup & restore
  getBackup:   ()     => API.get('/api/backup'),
  postRestore: (data) => API.post('/api/restore', data),

  // Working-with — colleagues
  getColleagues:      ()       => API.get('/api/colleagues'),
  addColleague:       (name)   => API.post('/api/colleagues', { name }),
  updateColleague:    (id, d)  => API.put(`/api/colleagues/${id}`, d),
  reorderColleagues:  (items)  => API.patch('/api/colleagues/reorder', items),
  getColleagueBirthdays: ()    => API.get('/api/colleagues/birthdays'),
  deleteColleague:    (id)     => API.delete(`/api/colleagues/${id}`),
  mergeColleague:     (srcId, dstId) => API.post(`/api/colleagues/${srcId}/merge-into/${dstId}`, {}),

  // Working-with — data
  getLeaderboard:   ()             => API.get('/api/working-with/leaderboard'),
  importColleagueJson: (data, overrides=[]) => API.post('/api/colleagues/import-json', { schedule_data: data, overrides }),
  getPeople:        ()             => API.get('/api/working-with/people'),
  getNextWith:      (id, limit=5)  => API.get(`/api/working-with/next/${id}?limit=${limit}`),
  getTeamCalendar:  (params={})    => API.get('/api/working-with/team-calendar?' + new URLSearchParams(params)),
  getTeamWeek:      (week, source) => API.get('/api/working-with/team-week?' + new URLSearchParams({ ...(week ? { week } : {}), ...(source && source !== 'all' ? { importSource: source } : {}) })),
  compareSources:   (from, to)     => API.get(`/api/working-with/compare-sources?from=${from}&to=${to}`),

  // Working-with — screenshot import (multipart, not JSON)
  importScreenshot: (file) => {
    const fd = new FormData();
    fd.append('screenshot', file);
    return fetch('/api/colleagues/import-screenshot', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },

  // Working-with — Gemini AI screenshot import (multipart, not JSON)
  importScreenshotGemini: (file) => {
    const fd = new FormData();
    fd.append('screenshot', file);
    return fetch('/api/colleagues/import-screenshot-gemini', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },

  // Working-with — Gemini AI screenshot read-only extract (returns { date_range, schedule }
  // JSON, same shape as pasting AI output manually — no DB writes)
  extractScreenshotGemini: (file) => {
    const fd = new FormData();
    fd.append('screenshot', file);
    return fetch('/api/colleagues/gemini-extract', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },

  // Payslips — Gemini AI photo import (returns field data matching the payslip form, no DB writes)
  extractPayslipPhoto: (file) => {
    const fd = new FormData();
    fd.append('photo', file);
    return fetch('/api/payslips/import-photo', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },

  // Working-with — Ollama: list installed models
  getOllamaModels: (source) => API.get(`/api/colleagues/ollama-models?source=${source || 'server'}`),

  // Working-with — LM Studio: list loaded models
  getLmStudioModels: () => API.get('/api/colleagues/lmstudio-models'),

  // Working-with — Gemini: list models available to the saved API key
  getGeminiModels: () => API.get('/api/colleagues/gemini-models'),

  // OCR job queue — list all jobs (enriched with files, no blobs)
  listOllamaJobs: () => API.get('/api/ocr-jobs'),

  // OCR job queue (background Ollama processing)
  submitOllamaJob: (files, source, dateOverride) => {
    const fd = new FormData();
    for (const f of files) fd.append('screenshots', f);
    fd.append('source', source || 'server');
    if (dateOverride) fd.append('date_override', dateOverride);
    return fetch('/api/ocr-jobs', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },
  getOllamaJob:          (jobId) => API.get(`/api/ocr-jobs/${jobId}`),
  deleteOllamaJob:       (jobId) => API.delete(`/api/ocr-jobs/${jobId}`),
  cancelOllamaJob:       (jobId) => API.patch(`/api/ocr-jobs/${jobId}/cancel`, {}),
  clearOllamaJobConflicts: (jobId) => API.patch(`/api/ocr-jobs/${jobId}/clear-conflicts`),

  // Working-with — Ollama local/remote AI screenshot import
  importScreenshotOllama: (file, source) => {
    const fd = new FormData();
    fd.append('screenshot', file);
    fd.append('source', source || 'server');
    return fetch('/api/colleagues/import-screenshot-ollama', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },

  // Working-with — manual colleague-shift CRUD
  addColleagueShift:    (data)     => API.post('/api/colleague-shifts', data),
  updateColleagueShift: (id, data)  => API.put(`/api/colleague-shifts/${id}`, data),
  getAllColleagueShifts: ()          => API.get('/api/colleague-shifts/all'),
  getWhosIn:            (date)      => API.get(date ? `/api/whos-in?date=${date}` : '/api/whos-in'),
  deleteColleagueShift:      (id)   => API.delete(`/api/colleague-shifts/${id}`),
  bulkDeleteColleagueShifts:  (ids)        => API.post('/api/colleague-shifts/bulk-delete', { ids }),
  deleteAllColleagueShifts:    (colleagueId)         => API.delete(`/api/colleague-shifts/by-colleague/${colleagueId}`),
  deleteColleagueShiftsByMonth: (colleagueId, month) => API.delete(`/api/colleague-shifts/by-colleague/${colleagueId}/month/${month}`),
  deleteAllShiftsByMonth:       (month)               => API.delete(`/api/colleague-shifts/by-month/${month}`),
  deleteAllColleagueShiftsEver:   ()                    => API.delete('/api/colleague-shifts/all'),
  resolveConflicts:               (data)                => API.post('/api/colleague-shifts/resolve-conflicts', data),

  // Shift working-with overlay (manual picker in shift form)
  getWorkingWith:      (date, start_time, end_time) =>
    API.get('/api/working-with/' + date + '?' + new URLSearchParams({ start_time, end_time })),
  saveShiftColleagues: (data) => API.post('/api/shift-colleagues', data),

  // Team Rota import (name-based bulk import into colleague_shifts)
  teamShiftsImport: (shifts, overwrite = false) => API.post('/api/team-shifts/import', { shifts, overwrite }),

  // Rotageek API proxy
  rotageekAuth:        (data)         => API.post('/api/rotageek/auth', data),
  rotageekSaveToken:   (data)         => API.post('/api/rotageek/save-token', data),
  rotageekSaveSession: (data)         => API.post('/api/rotageek/save-session', data),
  rotageekStatus:      ()             => API.get('/api/rotageek/status'),
  rotageekFetch:       (path, params) => API.post('/api/rotageek/fetch', { path, params }),
  rotageekImport:      (data)         => API.post('/api/rotageek/import-schedule', data),
  rotageekProbeTeam:   (data)         => API.post('/api/rotageek/probe-team', data),
  rotageekGraphqlSync: (data)         => API.post('/api/rotageek/graphql-sync', data),
  rotageekDiffAll:     (data)         => API.post('/api/rotageek/diff-all', data || {}),
  rotageekSyncAll:     (data)         => API.post('/api/rotageek/sync-all', data || {}),
  rotageekApplyDiffs:  (diffs)         => API.post('/api/rotageek/apply-diffs', { diffs }),
  rotageekDisconnect:  ()             => API.delete('/api/rotageek/disconnect'),
  breakAudit:          ()             => API.get('/api/shifts/break-audit'),
  breakAuditApply:     (ids)          => API.post('/api/shifts/break-audit/apply', { ids }),

  // Photo Library
  getPhotoFolders:      ()              => API.get('/api/photo-library/folders'),
  createPhotoFolder:    (name)          => API.post('/api/photo-library/folders', { name }),
  renamePhotoFolder:    (id, name)      => API.patch(`/api/photo-library/folders/${id}`, { name }),
  deletePhotoFolder:    (id)            => API.delete(`/api/photo-library/folders/${id}`),
  getPhotoFiles:        (folderId)      => API.get(`/api/photo-library/folders/${folderId}/files`),
  deletePhotoFile:      (id)            => API.delete(`/api/photo-library/files/${id}`),
  uploadPhotoFile:      (folderId, file) => {
    const fd = new FormData();
    fd.append('photo', file);
    return fetch(`/api/photo-library/folders/${folderId}/files`, { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },
  getPhotoFileUrl:      (id)            => `/api/photo-library/files/${id}/data`,

  submitOllamaJobAsync: (files, source, dateOverride) => {
    const fd = new FormData();
    for (const f of files) fd.append('screenshots', f);
    if (source)       fd.append('source', source);
    if (dateOverride) fd.append('dateOverride', dateOverride);
    return fetch('/api/ocr-jobs', { method: 'POST', body: fd })
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error))));
  },
};
