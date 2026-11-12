/* ─── Quick search + phone tab bar ──────────────────────────────────────────
   The app has ~70 pages and most sit behind a hub page or a collapsed sidebar
   group. Quick search is the one place that reaches all of them: the 🔎 button
   in the topbar, Ctrl/⌘+K, or "/" opens a palette that filters every page by
   name (plus a few actions) and remembers the ones you opened last.

   The tab bar is the phone's bottom row: the four pages used every day, and
   the full menu.

   In the core bundle so both work before the rest of the app's code arrives;
   the page list itself is built after App.loadRest(), since V3/V5 pages only
   register their titles once that code has run.
   ───────────────────────────────────────────────────────────────────────── */
const QuickSearch = {
  RECENT_KEY: 'qsRecent',
  RECENT_MAX: 6,
  // Extra words a page should be found by, beyond its own title.
  ALIASES: {
    leave: 'holiday annual sick time off absence',
    payslips: 'pay wages salary payslip p60',
    clock: 'punch nfc clocking time',
    'whos-in': 'store today working staff',
    people: 'colleagues team staff working with',
    'manage-people': 'colleagues staff roles contract',
    'team-calendar': 'rota team schedule',
    'team-upload': 'screenshot rota import photo',
    import: 'rotageek upload screenshot csv xlsx',
    export: 'download backup csv pdf ics',
    settings: 'preferences options google calendar pay rate backup restore',
    notifications: 'ntfy alerts reminders push',
    audit: 'history changes log',
    key: 'legend colours colors help',
    changelog: 'whats new version updates',
    reports: 'charts totals year month',
    insights: 'patterns analysis breaks stats',
    weather: 'forecast rain commute',
    'tax-check': 'paye ni national insurance',
    'money-clock': 'live earnings ticker payday',
    'leave-planner': 'holiday plan',
    'commute-cost': 'mileage fuel petrol driving',
    'v5-privacy': 'tracking data delete',
  },
  _items: [],
  _shown: [],
  _active: 0,

  init() {
    this.overlay = document.getElementById('qsOverlay');
    this.input = document.getElementById('qsInput');
    this.list = document.getElementById('qsList');
    if (!this.overlay) return;

    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    const kbd = document.querySelector('.topbar-search-kbd');
    if (kbd) kbd.textContent = mac ? '⌘K' : 'Ctrl K';

    document.getElementById('topbarSearch')?.addEventListener('click', () => this.open());
    this.overlay.addEventListener('mousedown', e => { if (e.target === this.overlay) this.close(); });
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', e => this._onKey(e));
    this.list.addEventListener('click', e => {
      const row = e.target.closest('[data-qs]');
      if (row) this.run(Number(row.dataset.qs));
    });
    this.list.addEventListener('mousemove', e => {
      const row = e.target.closest('[data-qs]');
      if (row && Number(row.dataset.qs) !== this._active) this._setActive(Number(row.dataset.qs), false);
    });

    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.isOpen() ? this.close() : this.open();
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !this.isOpen() && !Modal.isOpen()) {
        e.preventDefault();
        this.open();
      } else if (e.key === 'Escape' && this.isOpen()) {
        e.preventDefault();   // app.js's Esc handler skips prevented events
        this.close();
      }
    });

    this._initTabbar();
  },

  isOpen() { return !this.overlay.classList.contains('hidden'); },

  async open() {
    this._returnFocus = document.activeElement;
    this.overlay.classList.remove('hidden');
    this.input.value = '';
    this._build();
    this.render();
    this.input.focus();
    // V3/V5 pages register their titles in the second bundle — add them once
    // it's in, without making the palette wait for it.
    try {
      await App.loadRest();
      if (this.isOpen()) { this._build(); this.render(); }
    } catch (e) { /* offline: the core pages are still listed */ }
  },

  close() {
    this.overlay.classList.add('hidden');
    const el = this._returnFocus;
    if (el && el.isConnected && el.focus) el.focus({ preventScroll: true });
  },

  _build() {
    const titles = App.titles();
    const split = t => {
      // "🏠 Dashboard" → icon + name; a title with no leading emoji gets a dot.
      const m = /^([^\w\s]+)\s+(.*)$/u.exec(t);
      return m ? { icon: m[1], name: m[2] } : { icon: '•', name: t };
    };
    const group = v =>
      (typeof V3 !== 'undefined' && V3.views[v] && v !== 'v3-hub') ? 'V3'
      : (typeof V5 !== 'undefined' && V5.views[v] && v !== 'v5-hub') ? 'V5'
      : App.V2_VIEWS.includes(v) ? 'V2' : '';
    const pages = Object.keys(titles)
      .filter(v => document.getElementById('view-' + v))
      .map(v => ({ ...split(titles[v]), view: v, tag: group(v), words: this.ALIASES[v] || '' }));

    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const hidden = document.documentElement.hasAttribute('data-hide-money');
    const actions = [
      { icon: '➕', name: 'Add a shift', tag: 'Action', words: 'new create', run: async () => { await App.navigate('shifts'); ShiftsView.openAddModal(); } },
      { icon: dark ? '☀️' : '🌙', name: dark ? 'Switch to light mode' : 'Switch to dark mode', tag: 'Action', words: 'theme dark light night', run: () => document.getElementById('darkModeToggle').click() },
      { icon: hidden ? '👁️' : '🙈', name: hidden ? 'Show money amounts' : 'Hide money amounts', tag: 'Action', words: 'blur privacy pay', run: () => document.getElementById('hideMoneyToggle').click() },
    ];
    this._items = [...pages, ...actions];
  },

  _recent() {
    try { return JSON.parse(localStorage.getItem(this.RECENT_KEY) || '[]'); } catch (e) { return []; }
  },

  // Called on every navigation (see the app:navigate listener below).
  noteVisit(view) {
    if (view === 'dashboard') return;
    try {
      const next = [view, ...this._recent().filter(v => v !== view)].slice(0, this.RECENT_MAX);
      localStorage.setItem(this.RECENT_KEY, JSON.stringify(next));
    } catch (e) { /* private mode — recents just don't persist */ }
  },

  _score(item, q) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.split(/[\s/&-]+/).some(w => w.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if ((item.words + ' ' + (item.view || '')).toLowerCase().includes(q)) return 3;
    // every typed word appears somewhere
    const hay = name + ' ' + item.words;
    return q.split(/\s+/).every(w => hay.includes(w)) ? 4 : -1;
  },

  render() {
    const q = this.input.value.trim().toLowerCase();
    let shown;
    let heading = '';
    if (!q) {
      const recent = this._recent().map(v => this._items.find(i => i.view === v)).filter(Boolean);
      const rest = this._items.filter(i => !recent.includes(i));
      shown = [...recent, ...rest];
      this._recentCount = recent.length;
    } else {
      shown = this._items
        .map((item, i) => ({ item, i, s: this._score(item, q) }))
        .filter(x => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .map(x => x.item);
      this._recentCount = 0;
    }
    this._shown = shown;
    this._active = 0;

    if (!shown.length) {
      this.list.innerHTML = `<div class="qs-empty">Nothing matches “${esc(this.input.value.trim())}”</div>`;
      return;
    }
    this.list.innerHTML = shown.map((item, i) => {
      if (!q && this._recentCount && i === 0) heading = '<div class="qs-heading">Recent</div>';
      else if (!q && i === this._recentCount) heading = '<div class="qs-heading">Everything</div>';
      else heading = '';
      return `${heading}<div class="qs-item${i === 0 ? ' active' : ''}" role="option" data-qs="${i}">
        <span class="qs-icon" aria-hidden="true">${esc(item.icon)}</span>
        <span class="qs-name">${esc(item.name)}</span>
        ${item.tag ? `<span class="qs-tag">${esc(item.tag)}</span>` : ''}
      </div>`;
    }).join('');
  },

  _setActive(i, scroll = true) {
    const rows = this.list.querySelectorAll('[data-qs]');
    if (!rows.length) return;
    this._active = (i + rows.length) % rows.length;
    rows.forEach((r, n) => r.classList.toggle('active', n === this._active));
    if (scroll) rows[this._active].scrollIntoView({ block: 'nearest' });
  },

  _onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this._setActive(this._active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this._setActive(this._active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.run(this._active); }
  },

  run(i) {
    const item = this._shown[i];
    if (!item) return;
    this._returnFocus = null;
    this.close();
    if (item.run) Promise.resolve(item.run()).catch(e => showToast(e.message, 'error'));
    else App.navigate(item.view);
  },

  // ── Phone tab bar ──
  _initTabbar() {
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const btn = e.target.closest('.tabbar-btn');
      if (!btn) return;
      if (btn.dataset.action === 'menu') document.getElementById('topbarMenuBtn').click();
      else App.navigate(btn.dataset.view);
    });
    document.addEventListener('app:navigate', e => this._syncTabbar(e.detail.view));
  },

  _syncTabbar(view) {
    let matched = false;
    document.querySelectorAll('#tabbar .tabbar-btn[data-view]').forEach(b => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      if (on) { b.setAttribute('aria-current', 'page'); matched = true; } else b.removeAttribute('aria-current');
    });
    // Anywhere else in the app counts as "somewhere in the menu".
    document.querySelector('#tabbar .tabbar-btn[data-action="menu"]')?.classList.toggle('active', !matched);
  },
};

document.addEventListener('app:navigate', e => QuickSearch.noteVisit(e.detail.view));
document.addEventListener('DOMContentLoaded', () => QuickSearch.init());
