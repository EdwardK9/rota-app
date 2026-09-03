/* ─── App Bootstrap & Router ──────────────────────────────────────────────── */

const App = {
  currentView: 'dashboard',
  settings: {},
  V2_VIEWS: ['synergy', 'team-metrics', 'fatigue-audit', 'shift-heatmap', 'weather', 'what-if', 'streaks', 'wrapped'],

  async start() {
    // Dark mode — restore saved preference
    if (localStorage.getItem('darkMode') === 'true') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    document.getElementById('darkModeToggle').addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
      localStorage.setItem('darkMode', !isDark);
      document.querySelector('#darkModeToggle .dark-mode-icon').textContent = isDark ? '🌙' : '☀️';
    });
    // Set correct icon on load
    if (localStorage.getItem('darkMode') === 'true') {
      document.querySelector('#darkModeToggle .dark-mode-icon').textContent = '☀️';
    }

    // Version readout — shows which deploy is actually running (non-blocking).
    // Clickable through to the changelog rather than adding it as its own
    // sidebar row — it's already always visible, so it doubles as the entry
    // point without costing any extra space.
    API.get('/api/version').then(v => {
      const el = document.getElementById('sidebarVersion');
      if (!el) return;
      el.textContent = 'v' + v.version + (v.commit ? ' · ' + v.commit : '');
      el.title = 'Server started ' + new Date(v.startedAt).toLocaleString('en-GB') + ' — click for what\'s new';
    }).catch(() => {});
    document.getElementById('sidebarVersion')?.addEventListener('click', () => this.navigate('changelog'));

    // Load settings first (needed by other views)
    try {
      this.settings = await API.getSettings();
    } catch(e) {
      console.warn('Could not load settings:', e.message);
    }

    // Sidebar mobile toggle
    const closeSidebar = () => {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarBackdrop').classList.remove('open');
    };
    const openSidebar = () => {
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('sidebarBackdrop').classList.add('open');
    };
    const toggleSidebar = () => {
      const isOpen = document.getElementById('sidebar').classList.contains('open');
      isOpen ? closeSidebar() : openSidebar();
    };

    document.getElementById('topbarMenuBtn').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);

    // Swipe gestures on mobile — swipe right from the left edge to open the
    // sidebar, swipe left anywhere to close it while it's open.
    (() => {
      const EDGE_ZONE = 24;   // px from the left edge a swipe must start in to open
      const THRESHOLD = 60;   // px of horizontal travel required to trigger
      let touchStartX = 0, touchStartY = 0, tracking = false;

      document.addEventListener('touchstart', e => {
        if (window.innerWidth > 768) return;
        const t = e.touches[0];
        const sidebarOpen = document.getElementById('sidebar').classList.contains('open');
        // Only start tracking if this could plausibly be a sidebar swipe:
        // either it begins near the left edge (to open), or the sidebar is
        // already open (to close it from a swipe anywhere).
        if (!sidebarOpen && t.clientX > EDGE_ZONE) { tracking = false; return; }
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        tracking = true;
      }, { passive: true });

      document.addEventListener('touchend', e => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;
        // Ignore mostly-vertical swipes (scrolling)
        if (Math.abs(dy) > Math.abs(dx)) return;
        const sidebarOpen = document.getElementById('sidebar').classList.contains('open');
        if (!sidebarOpen && dx > THRESHOLD) openSidebar();
        else if (sidebarOpen && dx < -THRESHOLD) closeSidebar();
      }, { passive: true });
    })();

    // Nav wiring, kept re-runnable: NavCustomise rebuilds the sidebar markup
    // whenever the layout is edited, which throws these listeners away with the
    // old DOM, so it calls back into this after every render.
    this._wireNav = () => {
      document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => {
          e.preventDefault();
          if (NavCustomise._editing) return;   // you're arranging the menu, not using it
          this.navigate(link.dataset.view);
          if (window.innerWidth <= 768) closeSidebar();
        });
      });

      // Collapsible nav groups — restore saved open/closed state, wire toggles
      const savedGroups = JSON.parse(localStorage.getItem('navGroups') || '{}');
      document.querySelectorAll('.nav-group').forEach(g => {
        const key = g.dataset.group;
        if (savedGroups[key]) g.classList.add('open');
        g.querySelector('.nav-group-header').addEventListener('click', () => {
          if (NavCustomise._editing) return;
          const open = g.classList.toggle('open');
          const s = JSON.parse(localStorage.getItem('navGroups') || '{}');
          s[key] = open;
          localStorage.setItem('navGroups', JSON.stringify(s));
        });
      });
    };

    // Renders the saved sidebar layout (or the default markup's own order) and
    // wires it up via _wireNav.
    NavCustomise.apply(this.settings);

    // Modal close
    document.getElementById('modalClose').addEventListener('click', () => Modal.close());
    document.getElementById('modalOverlay').addEventListener('click', e => {
      if (e.target === document.getElementById('modalOverlay')) Modal.close();
    });

    // Keep the visible view in sync with browser Back/Forward. Those buttons
    // change window.location.hash directly (no navigate() call), so without
    // this listener the URL updates but the on-screen view never does.
    window.addEventListener('hashchange', () => {
      const view = window.location.hash.replace('#', '') || 'dashboard';
      if (view !== this.currentView) this.navigate(view);
    });

    // Navigate to default view
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    this.navigate(hash);
  },

  async navigate(view) {
    // Stop the outgoing view's timers/polls before switching — without this they
    // keep running in the background for the rest of the session (accumulating one
    // more set of intervals every time that view is revisited).
    // V3 views register themselves, so the router looks them up rather than
    // naming each one — a new V3 feature needs no change here.
    const outgoingView = { dashboard: DashboardView, 'whos-in': WhosInView, clock: ClockInOutView,
      'team-upload': TeamUploadView, 'photo-library': PhotoLibrary }[this.currentView]
      || (typeof V3 !== 'undefined' ? V3.views[this.currentView] : null)
      || (typeof V5 !== 'undefined' ? V5.views[this.currentView] : null);
    outgoingView?.destroy?.();

    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.view === view);
    });

    // V3 features have no nav link of their own — they're reached through the
    // V3 hub — so keep that one entry highlighted while you're inside any of them.
    if (typeof V3 !== 'undefined' && V3.views[view]) {
      document.querySelector('.nav-link[data-view="v3-hub"]')?.classList.add('active');
    }

    // Same for V5.0 — its five views are all reached through the V5 hub.
    if (typeof V5 !== 'undefined' && V5.views[view]) {
      document.querySelector('.nav-link[data-view="v5-hub"]')?.classList.add('active');
    }

    // Same idea for V2.0 — those views aren't in a registry the way V3 is, so
    // the list here is just the fixed set of eight.
    if (this.V2_VIEWS.includes(view)) {
      document.querySelector('.nav-link[data-view="v2-hub"]')?.classList.add('active');
    }

    // Highlight + auto-expand the group containing the active view
    document.querySelectorAll('.nav-group').forEach(g => {
      const hasActive = !!g.querySelector('.nav-link.active');
      g.querySelector('.nav-group-header').classList.toggle('child-active', hasActive);
      if (hasActive && !g.classList.contains('open')) {
        g.classList.add('open');
        const s = JSON.parse(localStorage.getItem('navGroups') || '{}');
        s[g.dataset.group] = true;
        localStorage.setItem('navGroups', JSON.stringify(s));
      }
    });

    // Show target view
    const viewEl = document.getElementById(`view-${view}`);
    if (!viewEl) return;
    viewEl.classList.remove('hidden');

    // Update topbar title
    const titles = {
      dashboard: '🏠 Dashboard', shifts: 'Shifts', calendar: 'Calendar', payslips: 'Payslips',
      reports: 'Reports', import: 'Import Data', leave: 'Leave Tracker',
      notes: 'Notes', settings: 'Settings',
      leaderboard: '🏆 Leaderboard', 'team-metrics': '💷 Team Metrics', people: '👥 People', audit: '📋 Audit Log',
      notifications: '🔔 Notifications',
      'team-calendar': '🗓️ Team Calendar', 'v2-hub': '🚀 V2.0 Features', 'changelog': '📜 What\'s New', 'synergy': '🤝 Synergy Score', 'fatigue-audit': '🩺 Fatigue Audit', 'team-upload': '📸 Team Upload',
      'shift-heatmap': '🔥 Shift Heatmap', 'weather': '🌤️ Weather', 'what-if': '🧮 What If?',
      'streaks': '🏅 Streaks & Badges', 'wrapped': '🎁 Rota Wrapped',
      'manage-people': '👤 Manage People',
      'photo-library': '📷 Photo Library',
      'insights': '🔍 Insights',
      'whos-in': '🏪 Who\'s In Store',
      'clock': '🕐 Clock In/Out',
      'key': '🔑 Key'
    };
    // V3 views supply their own titles at registration time
    if (typeof V3 !== 'undefined') Object.assign(titles, V3.titles);
    if (typeof V5 !== 'undefined') Object.assign(titles, V5.titles);
    document.getElementById('topbarTitle').textContent = titles[view] || view;
    this.currentView = view;

    // Update URL hash
    window.location.hash = view;

    // Initialise view (re-init on each navigate to refresh data)
    try {
    switch(view) {
      case 'dashboard':     await DashboardView.init(this.settings); break;
      case 'shifts':        await ShiftsView.init(this.settings); break;
      case 'calendar':      await CalendarView.init(this.settings); break;
      case 'payslips':      await PayslipsView.init(); break;
      case 'reports':       await ReportsView.init(); break;
      case 'import':        ImportView.init(); break;
      case 'leave':         await LeaveView.init(); break;
      case 'export':        await ExportView.init(); break;
      case 'notes':         await NotesView.init(); break;
      case 'settings':      await SettingsView.init(); break;
      case 'leaderboard':   await LeaderboardView.init(); break;
      case 'what-if':        await WhatIfView.init(); break;
      case 'streaks':        await StreaksView.init(); break;
      case 'wrapped':        await WrappedView.init(); break;
      case 'team-metrics':  await TeamMetricsView.init(); break;
      case 'audit':         await AuditView.init(); break;
      case 'notifications':  await NotificationsView.init(); break;
      case 'people':        await PeopleView.init(); break;
      case 'team-calendar': await TeamCalendarView.init(); break;
      case 'v2-hub':        V2Hub.init(); break;
      case 'changelog':     await ChangelogView.init(); break;
      case 'synergy':       await SynergyView.init(); break;
      case 'fatigue-audit': await FatigueAuditView.init(); break;
      case 'shift-heatmap': await ShiftHeatmapView.init(); break;
      case 'weather':        await WeatherView.init(); break;
      case 'team-upload':    TeamUploadView.init(); break;
      case 'manage-people':  await ManagePeopleView.init(); break;
      case 'photo-library':  PhotoLibrary.render(); break;
      case 'insights':       await InsightsView.init(); break;
      case 'whos-in':       await WhosInView.init(); break;
      case 'clock':         await ClockInOutView.init(); break;
      case 'key':           await KeyView.init(); break;
      default:
        // V3.0 / V5.0 features — resolved from their registries rather than a
        // case each, so a new feature in either set needs no change here.
        if (typeof V3 !== 'undefined' && V3.views[view]) await V3.views[view].init();
        else if (typeof V5 !== 'undefined' && V5.views[view]) await V5.views[view].init();
        break;
    }
    } catch(navErr) {
      console.error('[navigate] error in view "' + view + '":', navErr);
      const errEl = document.getElementById('view-' + view);
      if (errEl) errEl.innerHTML = '<div style="padding:40px;color:red;font-family:monospace">View error: ' + navErr.message + '<br><pre>' + navErr.stack + '</pre></div>';
    }
  },

  // Allow other views to navigate programmatically
  switchView(view) { this.navigate(view); },

  // Jump to the Shifts tab and scroll to / highlight a specific shift, e.g. from
  // the Audit Log's "click through to the shift" links.
  async goToShift(shiftId, date) {
    await this.navigate('shifts');
    if (typeof ShiftsView !== 'undefined' && ShiftsView.gotoShift) {
      ShiftsView.gotoShift(shiftId, date);
    }
  },
};

// Start the app when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.start();
});
