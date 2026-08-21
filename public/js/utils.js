/* Shared utility functions */

// Lazy-load the SheetJS (XLSX) library on demand instead of on every page load.
// It's a large (700KB+) library only needed by the Import view's .xlsx flow, so
// loading it unconditionally in index.html was adding real weight to every visit,
// especially on mobile. Cached so repeated calls after the first are instant.
let _xlsxLoadPromise = null;
function loadXlsxLib() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (_xlsxLoadPromise) return _xlsxLoadPromise;
  _xlsxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _xlsxLoadPromise = null; reject(new Error('Failed to load Excel support')); };
    document.head.appendChild(s);
  });
  return _xlsxLoadPromise;
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

function fmtDayShort(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()].slice(0, 3);
}

function fmtMonth(monthStr) {
  if (!monthStr) return '—';
  const [y, m] = monthStr.split('-').map(Number);
  return `${MONTHS[m-1]} ${y}`;
}

function fmtCurrency(val) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return '£' + Number(val).toFixed(2);
}

function fmtHours(val) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return Number(val).toFixed(2) + 'h';
}

function fmtMiles(val) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return Number(val).toFixed(1) + ' mi';
}

function diffClass(diff) {
  if (diff > 0.01) return 'diff-pos';
  if (diff < -0.01) return 'diff-neg';
  return '';
}

function getYears() {
  const current = new Date().getFullYear();
  const years = [];
  for (let y = current + 1; y >= 2024; y--) years.push(y);
  return years;
}

function getMonthOptions(selectedMonth) {
  const now = new Date();
  // Anchor the window on the month being viewed so the list never "runs out":
  // it re-generates centered on the selected month each time you navigate, and
  // always includes both the viewed month and the current month.
  let anchor = now;
  if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth)) {
    const [sy, sm] = selectedMonth.split('-').map(Number);
    anchor = new Date(sy, sm - 1, 1);
  }
  const start = new Date(Math.min(anchor.getTime(), now.getTime()));
  start.setMonth(start.getMonth() - 60);   // 5 years before the earlier of viewed/now
  const end = new Date(Math.max(anchor.getTime(), now.getTime()));
  end.setMonth(end.getMonth() + 60);       // 5 years after the later of viewed/now

  const options = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const val = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`;
    options.push({ val, label: `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}` });
    cur.setMonth(cur.getMonth() + 1);
  }
  // Guarantee the selected month is present even at the very edge
  if (selectedMonth && /^\d{4}-\d{2}$/.test(selectedMonth) && !options.some(o => o.val === selectedMonth)) {
    const [sy, sm] = selectedMonth.split('-').map(Number);
    options.push({ val: selectedMonth, label: `${MONTHS[sm-1]} ${sy}` });
  }
  const seen = new Set();
  const deduped = options.filter(o => { if (seen.has(o.val)) return false; seen.add(o.val); return true; });
  deduped.sort((a,b) => b.val.localeCompare(a.val));
  return deduped.map(o =>
    `<option value="${o.val}" ${o.val === selectedMonth ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

// Format a Date as a local YYYY-MM-DD string (no UTC/timezone shift)
function fmtLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function monthYearPickerHTML(selectedMonth, idPrefix) {
  const sel = /^\d{4}-\d{2}$/.test(selectedMonth || '') ? selectedMonth : getCurrentMonth();
  const [sy, sm] = sel.split('-').map(Number);
  const months = MONTHS.map((name, i) =>
    `<option value="${i+1}" ${i+1===sm ? 'selected' : ''}>${name}</option>`).join('');
  const now = new Date();
  const minY = Math.min(2024, sy);
  const maxY = Math.max(now.getFullYear() + 3, sy);
  let years = '';
  for (let y = maxY; y >= minY; y--) years += `<option value="${y}" ${y===sy ? 'selected' : ''}>${y}</option>`;
  return `<select id="${idPrefix}MonthSel" class="my-month-sel" aria-label="Month">${months}</select>` +
         `<select id="${idPrefix}YearSel" class="my-year-sel" aria-label="Year">${years}</select>`;
}

function readMonthYearPicker(idPrefix) {
  const m = document.getElementById(idPrefix + 'MonthSel')?.value;
  const y = document.getElementById(idPrefix + 'YearSel')?.value;
  if (!m || !y) return null;
  return `${y}-${String(parseInt(m,10)).padStart(2,'0')}`;
}

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function getCurrentYear() {
  return String(new Date().getFullYear());
}

// Modal helpers
const Modal = {
  open(title, bodyHtml) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalOverlay').classList.remove('hidden');
  },
  close() {
    document.getElementById('modalOverlay').classList.add('hidden');
    document.getElementById('modalBody').innerHTML = '';
  }
};

// Toast
let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// Confirm dialog using built-in confirm (good enough for local app)
function confirmAction(msg) {
  return window.confirm(msg);
}

// ─── Bank Holidays (UK Gov API) ────────────────────────────────────────────────
const BankHols = {
  _cache: null,
  _cacheTime: 0,
  CACHE_TTL: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  STORAGE_KEY: 'bankHolsCache',

  async load() {
    // Check in-memory cache first
    if (this._cache && (Date.now() - this._cacheTime < this.CACHE_TTL)) {
      return this._cache;
    }
    // Check localStorage cache
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.time && Date.now() - parsed.time < this.CACHE_TTL) {
          this._cache = new Set(parsed.dates);
          this._cacheTime = parsed.time;
          return this._cache;
        }
      }
    } catch (_) {}
    // Fetch from UK gov API — bounded so a slow/unresponsive gov.uk doesn't hang
    // whatever page is waiting on this (Shifts awaits it as part of its main
    // render). A healthy response is near-instant; 6s is already generous.
    try {
      const res = await fetch('https://www.gov.uk/bank-holidays.json', { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      const division = data['england-and-wales'] || data[Object.keys(data)[0]];
      const dates = (division.events || []).map(e => e.date);
      this._cache = new Set(dates);
      this._cacheTime = Date.now();
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({ dates, time: this._cacheTime }));
      return this._cache;
    } catch (_) {
      return new Set();
    }
  },

  // Returns a Set of bank holiday date strings for a given YYYY-MM month
  async forMonth(monthStr) {
    const hols = await this.load();
    const result = new Set();
    for (const d of hols) {
      if (d.startsWith(monthStr)) result.add(d);
    }
    return result;
  }
};

// Link back to the V2.0 hub, meant to sit at the top of every V2.0 feature
// page — same idea as V3.backButton() in v3core.js, just for the older set.
function v2BackButton() {
  return `<button class="btn btn-ghost btn-sm v3-back-btn" onclick="App.navigate('v2-hub')">← All V2.0 Features</button>`;
}

// Escape HTML
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
