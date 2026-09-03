/* ─── V5.0 usage tracker ───────────────────────────────────────────────────
   The collector behind every V5 page. It is the only V5 file that runs on every
   page load rather than only when a V5 view is open, so it is written to be
   cheap and to fail silently: analytics must never be the reason the app breaks.

   What it records:
     • one session per app open, with foreground time (not wall clock — a phone
       left locked with the tab open would otherwise report an eight-hour visit)
     • one row per view you open, with how long you stayed and what you came from
     • a GPS fix at clock-in/out, and optionally at app open, if — and only if —
       location has been switched on in Settings

   Two rules it sticks to:
     • the browser never decides what is *stored*; it only decides what to ask
       for. Location is gated here purely to avoid triggering the OS permission
       prompt when the feature is off — the server drops anything it shouldn't
       keep regardless of what arrives (see v5/ingest.js).
     • events are queued and flushed in batches (and on page hide, via
       sendBeacon), so navigating around the app doesn't fire a request per tap.
   ───────────────────────────────────────────────────────────────────────── */

const V5Tracker = {
  ENDPOINT: '/api/v5/ingest',
  SESSION_KEY: 'v5Session',
  IDLE_MS: 30 * 60 * 1000,     // a gap this long makes the next open a new session
  FLUSH_MS: 60 * 1000,
  GPS_TIMEOUT_MS: 12000,

  config: { analytics: true, location: false, locationOnOpen: false },
  sessionId: null,
  startedAt: 0,
  activeMs: 0,          // foreground milliseconds only
  viewCount: 0,
  entryView: null,
  currentView: null,
  _viewStarted: 0,
  _visibleSince: 0,
  _queue: [],
  _timer: null,
  _booted: false,

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  async start() {
    if (this._booted) return;
    this._booted = true;

    this._resumeOrCreateSession();
    this._visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;

    // The switches are read from the server rather than assumed, because the
    // page may have been served from cache with a stale idea of them, and
    // because asking for GPS when location is off would prompt for nothing.
    try {
      const p = await V5.api.privacy();
      this.config = {
        analytics: !!p.settings.analytics_enabled,
        location: !!p.settings.location_enabled,
        locationOnOpen: !!p.settings.location_on_open,
      };
    } catch (_) { /* keep the defaults — the server is the real gate anyway */ }

    if (!this.config.analytics) return;

    this.event({ type: 'app_open', detail: this._launchMode() });
    if (this.config.location && this.config.locationOnOpen) {
      this.captureLocation('app_open');
    }

    this._wireLifecycle();
    this._wireRouter();
    this._timer = setInterval(() => this.flush(), this.FLUSH_MS);
  },

  /** A reload within the same tab continues the session it interrupted, unless
   *  the app has been idle long enough that reopening it is genuinely a new
   *  visit. Without this every pull-to-refresh would look like another open. */
  _resumeOrCreateSession() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(this.SESSION_KEY) || 'null'); } catch (_) {}
    const fresh = saved && (Date.now() - (saved.lastSeen || 0)) < this.IDLE_MS;
    if (fresh) {
      this.sessionId = saved.id;
      this.startedAt = saved.startedAt;
      this.activeMs = saved.activeMs || 0;
      this.viewCount = saved.viewCount || 0;
      this.entryView = saved.entryView || null;
      return;
    }
    this.sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    this.startedAt = Date.now();
    this.activeMs = 0;
    this.viewCount = 0;
    this.entryView = null;
    this._persist();
  },

  _persist() {
    try {
      sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({
        id: this.sessionId, startedAt: this.startedAt, lastSeen: Date.now(),
        activeMs: this._activeMsNow(), viewCount: this.viewCount, entryView: this.entryView,
      }));
    } catch (_) {}
  },

  _launchMode() {
    return this._standalone() ? 'home-screen' : 'browser';
  },

  _standalone() {
    return !!(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone);
  },

  _platform() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows|Macintosh|Linux/i.test(ua)) return 'desktop';
    return 'other';
  },

  /* ── Foreground time ──────────────────────────────────────────────────── */

  _activeMsNow() {
    return this.activeMs + (this._visibleSince ? Date.now() - this._visibleSince : 0);
  },

  _wireLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // Bank the foreground time, close off the open view, and get everything
        // out now — on a phone this is usually the last code that runs.
        this.activeMs = this._activeMsNow();
        this._visibleSince = 0;
        this._closeCurrentView();
        this._persist();
        this.flush(true);
      } else {
        this._visibleSince = Date.now();
        // Coming back after a long absence is a new visit, not a continuation.
        let saved = null;
        try { saved = JSON.parse(sessionStorage.getItem(this.SESSION_KEY) || 'null'); } catch (_) {}
        if (saved && Date.now() - saved.lastSeen > this.IDLE_MS) {
          this._resumeOrCreateSession();
          this.event({ type: 'app_open', detail: 'resume' });
          if (this.config.location && this.config.locationOnOpen) this.captureLocation('app_open');
        }
        this._viewStarted = Date.now();
      }
    });

    window.addEventListener('pagehide', () => {
      this.activeMs = this._activeMsNow();
      this._visibleSince = 0;
      this._closeCurrentView();
      this._persist();
      this.flush(true);
    });
  },

  /* ── View tracking ────────────────────────────────────────────────────── */

  /** Wraps App.navigate rather than listening on hashchange: navigate() is the
   *  single funnel every route change goes through (nav clicks, hub cards,
   *  Back/Forward), so one wrapper catches all of them and nothing else in the
   *  app has to know the tracker exists. */
  _wireRouter() {
    if (typeof App === 'undefined' || App._v5Wrapped) return;
    const original = App.navigate.bind(App);
    App.navigate = async (view) => {
      this.viewChanged(view);
      return original(view);
    };
    App._v5Wrapped = true;
    // The first view is already on screen by the time this runs.
    this.viewChanged(App.currentView || (location.hash.replace('#', '') || 'dashboard'), true);
  },

  viewChanged(view, isFirst) {
    if (!this.config.analytics || !view) return;
    const from = this.currentView;
    if (from === view && !isFirst) return;
    this._closeCurrentView();
    this.currentView = view;
    this._viewStarted = Date.now();
    this.viewCount++;
    if (!this.entryView) this.entryView = view;
    this._pendingFrom = from;
    this._persist();
  },

  /** A view's row is written when you *leave* it, because that's when its dwell
   *  time is known. A view still open at flush time is reported with the time
   *  so far, so a session that ends without a clean exit still has one. */
  _closeCurrentView() {
    if (!this.currentView || !this._viewStarted) return;
    const duration = Date.now() - this._viewStarted;
    this.event({
      type: 'view', view: this.currentView, from_view: this._pendingFrom || null,
      duration_ms: Math.min(duration, 4 * 3600 * 1000),   // cap absurd values
    });
    this._viewStarted = 0;
    this._pendingFrom = null;
  },

  /* ── Events ───────────────────────────────────────────────────────────── */

  event(e) {
    if (!this.config.analytics) return;
    this._queue.push(e);
    if (this._queue.length >= 25) this.flush();
  },

  /** For anything worth counting that isn't a view — an import run, an export,
   *  a shift marked complete. Nothing calls this yet beyond the clock hooks;
   *  it's here so adding one later is a one-liner at the call site. */
  action(name, detail) {
    this.event({ type: 'action', view: this.currentView, detail: detail ? `${name}:${detail}` : name });
  },

  _payload(includeExit) {
    return {
      session_id: this.sessionId,
      session: {
        active_ms: this._activeMsNow(),
        view_count: this.viewCount,
        entry_view: this.entryView,
        exit_view: includeExit ? this.currentView : null,
        platform: this._platform(),
        standalone: this._standalone(),
        screen_w: window.screen?.width || null,
        screen_h: window.screen?.height || null,
        referrer: document.referrer || null,
      },
      events: this._queue.splice(0, this._queue.length),
    };
  },

  /** `beacon` uses sendBeacon, which survives the page being closed — the
   *  ordinary path uses fetch with keepalive so a failure can be seen in the
   *  console during development. */
  flush(beacon) {
    if (!this.config.analytics) { this._queue.length = 0; return; }
    const body = this._payload(!!beacon);
    if (!body.events.length && !beacon) {
      // Still worth a heartbeat: it keeps the session's length honest for a
      // long read on one screen, which produces no events at all.
      if (this._activeMsNow() - (this._lastHeartbeat || 0) < this.FLUSH_MS) return;
    }
    this._lastHeartbeat = this._activeMsNow();
    this._send(body, beacon);
  },

  _send(body, beacon) {
    try {
      const json = JSON.stringify(body);
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(this.ENDPOINT, new Blob([json], { type: 'application/json' }));
        return;
      }
      fetch(this.ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true,
      }).catch(() => {});
    } catch (_) { /* analytics never throws into the app */ }
  },

  /* ── Location ─────────────────────────────────────────────────────────── */

  /** Asks the browser for a fix and posts it with the given kind. Resolves to
   *  the position (or null) so a caller can show what was recorded, and never
   *  rejects — clocking in must not fail because GPS did. */
  captureLocation(kind) {
    return new Promise(resolve => {
      if (!this.config.analytics || !this.config.location || !navigator.geolocation) return resolve(null);
      if (kind === 'app_open' && !this.config.locationOnOpen) return resolve(null);

      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      // Belt and braces: some browsers never call either callback if the
      // permission prompt is dismissed rather than answered.
      setTimeout(() => done(null), this.GPS_TIMEOUT_MS + 1000);

      navigator.geolocation.getCurrentPosition(
        pos => {
          const c = pos.coords;
          this._send({
            session_id: this.sessionId,
            location: {
              kind,
              lat: c.latitude, lon: c.longitude,
              accuracy_m: c.accuracy, altitude_m: c.altitude, speed_ms: c.speed,
              source: c.accuracy != null && c.accuracy <= 50 ? 'gps' : 'network',
            },
            events: [],
          });
          done({ lat: c.latitude, lon: c.longitude, accuracy_m: c.accuracy });
        },
        () => done(null),   // refused, unavailable, or timed out — all the same here
        { enableHighAccuracy: true, timeout: this.GPS_TIMEOUT_MS, maximumAge: 60000 }
      );
    });
  },

  /** Called by the Clock In/Out view. Kept as its own name so the call site
   *  reads as what it is, and so the "is this on?" check lives here. */
  clockLocation(direction) {
    return this.captureLocation(direction === 'out' ? 'clock_out' : 'clock_in');
  },

  /** Settings flips the switches through this, so a change takes effect
   *  immediately rather than on the next page load. */
  setConfig(partial) {
    Object.assign(this.config, partial);
  },
};

// Deferred scripts run in order before DOMContentLoaded, and app.js is loaded
// after this file — so App exists by the time this listener fires, and wrapping
// navigate() here is safe. Started after App.start() has had a turn so the
// first view is already on screen.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => V5Tracker.start(), 0);
});
