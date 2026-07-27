/* ─── App Bootstrap & Router ──────────────────────────────────────────────── */

const App = {
  currentView: 'dashboard',
  settings: {},

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

    // Load settings first (needed by other views)
    try {
      this.settings = await API.getSettings();
    } catch(e) {
      console.warn('Could not load settings:', e.message);
    }

    // Wire navigation
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        this.navigate(link.dataset.view);
      });
    });

    // Collapsible nav groups — restore saved open/closed state, wire toggles
    const _savedGroups = JSON.parse(localStorage.getItem('navGroups') || '{}');
    document.querySelectorAll('.nav-group').forEach(g => {
      const key = g.dataset.group;
      if (_savedGroups[key]) g.classList.add('open');
      g.querySelector('.nav-group-header').addEventListener('click', () => {
        const open = g.classList.toggle('open');
        const s = JSON.parse(localStorage.getItem('navGroups') || '{}');
        s[key] = open;
        localStorage.setItem('navGroups', JSON.stringify(s));
        _syncGroupBadges();
      });
    });

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

    // Close sidebar on nav link tap on mobile
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar(); });
    });

    // Modal close
    document.getElementById('modalClose').addEventListener('click', () => Modal.close());
    document.getElementById('modalOverlay').addEventListener('click', e => {
      if (e.target === document.getElementById('modalOverlay')) Modal.close();
    });

    // Navigate to default view
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    this.navigate(hash);
  },

  async navigate(view) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.dataset.view === view);
    });

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
    if (typeof _syncGroupBadges === 'function') _syncGroupBadges();

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
      'team-calendar': '🗓️ Team Calendar', 'synergy': '🤝 Synergy Score', 'fatigue-audit': '🩺 Fatigue Audit', 'team-upload': '📸 Team Upload',
      'manage-people': '👤 Manage People', compare: '🔀 Compare Sources',
      'photo-library': '📷 Photo Library',
      'insights': '🔍 Insights',
      'whos-in': '🏪 Who\'s In Store',
      'clock': '🕐 Clock In/Out',
      'key': '🔑 Key'
    };
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
      case 'team-metrics':  await TeamMetricsView.init(); break;
      case 'audit':         await AuditView.init(); break;
      case 'notifications':  await NotificationsView.init(); break;
      case 'people':        await PeopleView.init(); break;
      case 'team-calendar': await TeamCalendarView.init(); break;
      case 'synergy':       await SynergyView.init(); break;
      case 'fatigue-audit': await FatigueAuditView.init(); break;
      case 'team-upload':    TeamUploadView.init(); break;
      case 'manage-people':  await ManagePeopleView.init(); break;
      case 'compare':        await CompareView.init(); break;
      case 'photo-library':  PhotoLibrary.render(); break;
      case 'insights':       await InsightsView.init(); break;
      case 'whos-in':       await WhosInView.init(); break;
      case 'clock':         await ClockInOutView.init(); break;
      case 'key':           await KeyView.init(); break;
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

// ─── Ollama queue badge ─────────────────────────────────────────────────────

let _ollamaActiveCount = 0;
function _syncGroupBadges() {
  const groupBadge = document.getElementById('ollamaQueueBadgeGroup');
  if (!groupBadge) return;
  const teamGroup = groupBadge.closest('.nav-group');
  const collapsed = teamGroup && !teamGroup.classList.contains('open');
  if (_ollamaActiveCount > 0 && collapsed) {
    groupBadge.textContent = _ollamaActiveCount;
    groupBadge.style.display = 'inline-flex';
  } else {
    groupBadge.style.display = 'none';
  }
}

function updateOllamaBadge(activeCount) {
  _ollamaActiveCount = activeCount;
  const badge = document.getElementById('ollamaQueueBadge');
  if (badge) {
    if (activeCount > 0) {
      badge.textContent = activeCount;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
  _syncGroupBadges();
}

// Background poller — keeps badge accurate even when not on the Team Upload page
async function _pollOllamaQueueBadge() {
  try {
    const { jobs } = await API.listOllamaJobs();
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'processing').length;
    updateOllamaBadge(active);
  } catch(_) {}
}

// Start the app when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.start();
  // Poll the badge every 8 seconds regardless of which view is open
  _pollOllamaQueueBadge();
  setInterval(_pollOllamaQueueBadge, 8000);
});
