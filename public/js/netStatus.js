/* ─── Connection status + offline sync ──────────────────────────────────────
   A slim bar under the top bar that only appears when it has something to say:
     📴 No signal — showing saved info from 07:52
     ⏳ 1 clock-in waiting to send  [Send now]
   API.request reports every answer / failure here; the service worker marks
   answers it served from its saved copy with an X-Offline-Cache header.
   Also owns sending the offline clock queue (ClockQueue) whenever the
   connection looks like it's back.
   ───────────────────────────────────────────────────────────────────────── */

const NetStatus = {
  offline: false,
  savedAt: null,     // ISO time of the saved copy currently on screen, if any
  pending: [],
  _timer: null,

  init() {
    window.addEventListener('online',  () => this.sync());
    window.addEventListener('offline', () => { this.offline = true; this.render(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sync();
    });
    if ('serviceWorker' in navigator) {
      // updateViaCache:'none' — the worker imports clockQueue.js, and assets are
      // cached as immutable, so without this an update to the import could be
      // missed when checking for a new worker.
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
      // The worker sends queued items too (e.g. an NFC tap while offline); it
      // tells open pages so the bar and the visible view catch up.
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data && e.data.type === 'clock-queue-sent') this._afterSend(e.data.sent || []);
      });
    }
    if (navigator.onLine === false) this.offline = true;
    this.sync();
  },

  /** A request got no answer at all. */
  failed() {
    if (!this.offline) { this.offline = true; this.render(); }
  },

  /** A request got an answer — live, or (if savedAt is set) the saved copy. */
  answered(savedAt) {
    const wasOffline = this.offline;
    this.offline = !!savedAt;
    this.savedAt = savedAt || null;
    this.render();
    if (wasOffline && !this.offline) this.sync();
  },

  async refreshPending() {
    this.pending = typeof ClockQueue !== 'undefined' ? await ClockQueue.all() : [];
    this.render();
    // While anything's waiting, keep trying every 30s in case no 'online'
    // event ever fires (weak signal rarely flips navigator.onLine).
    clearInterval(this._timer);
    this._timer = this.pending.length ? setInterval(() => this.sync(), 30000) : null;
  },

  async sync() {
    if (typeof ClockQueue === 'undefined') return;
    await this.refreshPending();
    if (!this.pending.length) return;
    let result;
    try { result = await ClockQueue.flush(); } catch (e) { return; }
    for (const f of result.failed) {
      showToast(`Couldn't record your ${this._label(f.item)} from ${f.item.time}: ${f.error}`, 'error');
    }
    this._afterSend(result.sent);
  },

  _afterSend(sent) {
    this.refreshPending();
    if (!sent.length) return;
    this.offline = false;
    const what = sent.map(s => `${this._label(s.item)} ${s.item.time}`).join(', ');
    showToast(`✓ Sent: ${what}`, 'success');
    // Re-draw whichever clock-aware screen is open so it shows the real state.
    if (typeof App !== 'undefined' && ['dashboard', 'clock'].includes(App.currentView)) {
      App.navigate(App.currentView);
    }
  },

  _label(item) {
    return item.kind === 'in' ? 'clock-in' : item.kind === 'out' ? 'clock-out' : 'tag tap';
  },

  _fmtSaved() {
    if (!this.savedAt) return '';
    const d = new Date(this.savedAt);
    if (isNaN(d)) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  },

  render() {
    let el = document.getElementById('netStatus');
    if (!el) {
      const topbar = document.querySelector('.topbar');
      if (!topbar) return;
      el = document.createElement('div');
      el.id = 'netStatus';
      el.className = 'net-status';
      el.setAttribute('role', 'status');
      topbar.insertAdjacentElement('afterend', el);
    }
    const parts = [];
    if (this.offline) {
      const saved = this._fmtSaved();
      parts.push(`<span>📴 No signal${saved ? ` — showing saved info from ${saved}` : ''}</span>`);
    }
    if (this.pending.length) {
      const n = this.pending.length;
      const kinds = [...new Set(this.pending.map(i => this._label(i)))];
      const noun = kinds.length === 1 ? kinds[0] : 'clock action';
      parts.push(`<span>⏳ ${n} ${noun}${n === 1 ? '' : 's'} waiting to send</span>
        <button type="button" class="net-status-btn" onclick="NetStatus.sync()">Send now</button>`);
    }
    el.innerHTML = parts.join('<span class="net-status-sep">·</span>');
    el.classList.toggle('show', parts.length > 0);
    el.classList.toggle('net-status-pending', !this.offline && this.pending.length > 0);
    document.body.classList.toggle('has-net-status', parts.length > 0);
    // The bar wraps to two lines on a narrow phone; the content offset follows its real height.
    document.documentElement.style.setProperty('--net-status-h', (parts.length ? el.offsetHeight : 0) + 'px');
  },
};

document.addEventListener('DOMContentLoaded', () => NetStatus.init());
