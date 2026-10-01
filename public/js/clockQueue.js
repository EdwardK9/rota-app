/* ─── Offline clock queue ───────────────────────────────────────────────────
   Clocking in at work often happens with little or no signal. Rather than the
   button failing, a clock in/out (or an NFC tag tap) that can't reach the
   server is stored on the phone with the time it actually happened, and sent
   in order once there's signal again.

   Shared by the page and the service worker (importScripts), so it uses only
   IndexedDB + fetch — no DOM, no API object. Every queued item carries a
   client_id, and the server stores the first response against it, so re-sending
   something that did arrive (but whose reply got lost) is harmless.
   ───────────────────────────────────────────────────────────────────────── */

const ClockQueue = (() => {
  const DB_NAME = 'rota-offline';
  const STORE = 'clock';
  let _dbP = null;

  function db() {
    if (!_dbP) {
      _dbP = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { _dbP = null; reject(req.error); };
      });
    }
    return _dbP;
  }

  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  const pad = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const uuid = () => (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

  /** Everything still waiting to send, oldest first. */
  async function all() {
    try {
      const items = await tx('readonly', s => s.getAll());
      return (items || []).sort((a, b) => a.seq - b.seq);
    } catch (e) {
      return [];   // IndexedDB unavailable (private mode etc.) — nothing queued
    }
  }

  /** Queue a clock action. kind: 'in' | 'out' | 'tap'. Returns the stored item. */
  async function add(kind, extra = {}) {
    const now = new Date();
    const item = {
      id: uuid(),
      seq: now.getTime() + Math.random(),
      kind,
      date: extra.date || localDate(now),
      time: extra.time || localTime(now),
      note: extra.note || null,
      breakResult: extra.breakResult || null,   // {break_taken, break_taken_minutes} for 'out'
      createdAt: now.toISOString(),
    };
    await tx('readwrite', s => s.put(item));
    return item;
  }

  async function remove(id) {
    await tx('readwrite', s => s.delete(id));
  }

  async function update(item) {
    await tx('readwrite', s => s.put(item));
  }

  function post(path, body, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    return fetch(path, {
      method: path.includes('bulk-complete') ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      signal: ctrl ? ctrl.signal : undefined,
    }).finally(() => timer && clearTimeout(timer));
  }

  /** Send one item. Resolves to the server's JSON; rejects with
   *  err.network = true when it never got an answer (try again later). */
  async function send(item, timeoutMs = 10000) {
    let res;
    try {
      res = await post(`/api/clock/${item.kind}`, {
        date: item.date, time: item.time, note: item.note, client_id: item.id,
      }, timeoutMs);
    } catch (e) {
      const err = new Error('No connection');
      err.network = true;
      throw err;
    }
    // Behind Cloudflare Access an expired session redirects to a login page —
    // that's HTML, not our JSON, and is a "try again later" just like no signal.
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!isJson || res.status >= 500) {
      const err = new Error(isJson ? `Server error ${res.status}` : 'Not reachable (login or network page)');
      err.network = true;
      throw err;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // A clock-out queued with its break answer: apply it to the shift the
    // server just completed, exactly as the online flow does.
    if (item.kind === 'out' && item.breakResult && data.completed_shift && data.completed_shift.id) {
      try {
        await post('/api/shifts/bulk-complete', {
          ids: [data.completed_shift.id], completed: true, ...item.breakResult,
        }, timeoutMs);
      } catch (_) { /* the shift is still complete (no break); not worth re-queuing */ }
    }
    return data;
  }

  let _flushing = null;
  /** Send everything queued, in order. Stops at the first item that can't get
   *  through (so order is kept). Returns { sent: [...], failed: [...], left }. */
  function flush() {
    if (_flushing) return _flushing;
    const run = async () => {
      const sent = [], failed = [];
      for (const item of await all()) {
        try {
          const data = await send(item);
          await remove(item.id);
          sent.push({ item, data });
        } catch (e) {
          if (e.network) break;
          // The server understood it and said no (e.g. a bad time). Re-sending
          // will never work, so drop it rather than blocking everything behind it.
          await remove(item.id);
          failed.push({ item, error: e.message });
        }
      }
      return { sent, failed, left: (await all()).length };
    };
    // One flusher at a time across the page and the service worker, so two of
    // them can't interleave and send items out of order.
    const locked = (self.navigator && navigator.locks)
      ? navigator.locks.request('rota-clock-queue', run)
      : run();
    _flushing = locked.finally(() => { _flushing = null; });
    return _flushing;
  }

  /** Try to send right now; if there's no signal, queue it instead.
   *  Resolves to { queued: false, data } or { queued: true, item }. */
  async function submit(kind, extra = {}, timeoutMs = 10000) {
    // Anything already waiting must go first, or this one would jump the queue.
    const waiting = await all();
    if (waiting.length) await flush();
    if ((await all()).length) return { queued: true, item: await add(kind, extra) };

    const item = await add(kind, extra);
    // Phone already knows it has no connection — don't make you wait for a timeout.
    if (self.navigator && navigator.onLine === false) return { queued: true, item };
    try {
      const data = await send(item, timeoutMs);
      await remove(item.id);
      return { queued: false, data };
    } catch (e) {
      if (e.network) return { queued: true, item };
      await remove(item.id);
      throw e;
    }
  }

  /** Overlay what's still queued for `date` onto a /api/clock/today answer, so
   *  the screen shows "clocked in 07:58 (waiting to send)" rather than the
   *  server's older state. Entries made here carry pending: true. */
  function applyPending(clockToday, items, date) {
    const ct = { ...(clockToday || {}) };
    let entry = ct.entry || null, last = ct.lastEntry || null;
    for (const i of items.filter(x => x.date === date)) {
      const kind = i.kind === 'tap' ? (entry ? 'out' : 'in') : i.kind;
      if (kind === 'in') {
        entry = last = { clocked_in: i.time, clocked_out: null, pending: true };
      } else {
        last = { ...(entry || last || {}), clocked_out: i.time, pending: true };
        entry = null;
      }
    }
    ct.entry = entry;
    ct.lastEntry = last;
    return ct;
  }

  return { all, add, remove, update, send, flush, submit, applyPending };
})();

if (typeof self !== 'undefined') self.ClockQueue = ClockQueue;
