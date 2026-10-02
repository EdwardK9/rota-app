// Clock in / out — the buttons on the Dashboard and Clock In/Out page, the
// NFC tag URL, and the replay of anything the phone queued with no signal.
// Split out of server.js; mounted there with app.use(createClockRouter(...)).
const express = require('express');
const { db, calcHoursWorked } = require('./db');

// Server-local date/time helpers (the process runs in Europe/London) — also
// used throughout server.js, which imports them from here.
function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function localTimeStr() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function _timeToMins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function createClockRouter({ resolveBreakMinutes, logAudit, webhooksRouter, gcal }) {
  const router = express.Router();

  // On split-shift days (more than one shift scheduled the same date), matching a clock
  // event against whichever shift is "first" by start_time picks the wrong shift for the
  // second half of the day, producing a bogus large diff. Instead pick the shift whose
  // given field (start_time or end_time) is closest to the actual clock time.
  function _nearestShiftByField(shiftsForDate, field, targetTime) {
    if (!shiftsForDate || !shiftsForDate.length || !targetTime) return null;
    const targetMins = _timeToMins(targetTime);
    return shiftsForDate.reduce((best, s) =>
      Math.abs(_timeToMins(s[field]) - targetMins) < Math.abs(_timeToMins(best[field]) - targetMins) ? s : best
    );
  }

  // GET /api/clock/today
  router.get('/api/clock/today', (req, res) => {
    const today = localDateStr();
    const entries = db.prepare('SELECT * FROM clock_entries WHERE date = ? ORDER BY id ASC').all(today);
    // `entry` is the OPEN entry (clocked in, not yet out), if any — what the Clock
    // In/Out button acts on. A split-shift day can be between shifts (nothing
    // open) while still having earlier entries, so `lastEntry` carries the most
    // recent one regardless of state, for "last clocked out at..." display.
    const entry = entries.find(e => e.clocked_in && !e.clocked_out) || null;
    const lastEntry = entries.length ? entries[entries.length - 1] : null;
    const dayShifts = db.prepare(
      "SELECT id, start_time, end_time, break_scheduled_minutes, completed FROM shifts WHERE date = ? AND absence_type IS NULL ORDER BY start_time ASC"
    ).all(today);
    const nowMins = _timeToMins(localTimeStr());
    // `shift` is the one the Clock In/Out buttons measure against and complete.
    // "Nearest to now" is wrong on a split day: finishing shift 1 a few minutes
    // before shift 2 starts made shift 2 the nearest, so clock-out marked the
    // NEXT shift complete. Prefer shifts still to be worked, and when clocked in,
    // the one that was started (start nearest the clock-in time).
    const pending = dayShifts.filter(s => !s.completed);
    const pool = pending.length ? pending : dayShifts;
    const nearest = (list, dist) => list.reduce((best, s) => dist(s) < dist(best) ? s : best);
    let shift = null;
    if (pool.length) {
      shift = entry && entry.clocked_in
        ? nearest(pool, s => Math.abs(_timeToMins(s.start_time) - _timeToMins(entry.clocked_in)))
        : nearest(pool, s => Math.min(Math.abs(_timeToMins(s.start_time) - nowMins), Math.abs(_timeToMins(s.end_time) - nowMins)));
    }
    res.json({ today, entries, entry, lastEntry, shift, shifts: dayShifts });
  });

  // GET /api/clock/history
  router.get('/api/clock/history', (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  || '30', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const rows = db.prepare(`
      SELECT * FROM clock_entries ORDER BY date DESC LIMIT ? OFFSET ?
    `).all(limit, offset);

    const dates = [...new Set(rows.map(r => r.date))];
    const shiftsByDate = {};
    if (dates.length) {
      const placeholders = dates.map(() => '?').join(',');
      const allShifts = db.prepare(
        `SELECT date, start_time, end_time FROM shifts WHERE date IN (${placeholders}) ORDER BY start_time ASC`
      ).all(...dates);
      for (const s of allShifts) (shiftsByDate[s.date] ||= []).push(s);
    }
    const entries = rows.map(r => {
      const dayShifts = shiftsByDate[r.date] || [];
      const inShift  = _nearestShiftByField(dayShifts, 'start_time', r.clocked_in)  || dayShifts[0] || null;
      const outShift = _nearestShiftByField(dayShifts, 'end_time',   r.clocked_out) || dayShifts[0] || null;
      return { ...r, sched_start: inShift?.start_time || null, sched_end: outShift?.end_time || null };
    });
    res.json({ entries });
  });

  // Clock requests can be replayed: the app queues a clock in/out on the phone when
  // there's no signal and re-sends it later, and a request that DID arrive but whose
  // response was lost to bad signal gets sent again. Each queued request carries a
  // client_id; the first response is stored against it and simply returned again
  // for any repeat, so a retry can't clock out twice or complete a second shift.
  db.exec(`CREATE TABLE IF NOT EXISTS clock_requests (
    client_id TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.prepare("DELETE FROM clock_requests WHERE created_at < datetime('now', '-30 days')").run();

  function _clockIdempotent(req, res, handler) {
    const cid = typeof req.body.client_id === 'string' && req.body.client_id.slice(0, 64);
    if (cid) {
      const prior = db.prepare('SELECT response FROM clock_requests WHERE client_id = ?').get(cid);
      if (prior) return res.json({ ...JSON.parse(prior.response), replayed: true });
    }
    const result = handler();
    if (cid) db.prepare('INSERT OR IGNORE INTO clock_requests (client_id, response) VALUES (?, ?)').run(cid, JSON.stringify(result));
    res.json(result);
  }

  const _isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const _isTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  function _clockDateTime(req, res) {
    const { date, time } = req.body;
    if (date !== undefined && date !== null && !_isDate(date)) { res.status(400).json({ error: 'date must be YYYY-MM-DD' }); return null; }
    if (time !== undefined && time !== null && !_isTime(time)) { res.status(400).json({ error: 'time must be HH:MM' }); return null; }
    return { date: date || localDateStr(), time: time || localTimeStr() };
  }

  // POST /api/clock/in — a split-shift day means "clock in" doesn't always mean
  // "there's nothing today yet": if the previous shift was already clocked out,
  // this starts a new entry rather than overwriting it. Only reuses an existing
  // row if one's already open (clocked in, not out), which just means re-recording
  // the time rather than accidentally spawning a duplicate open shift.
  router.post('/api/clock/in', (req, res) => {
    const dt = _clockDateTime(req, res);
    if (!dt) return;
    _clockIdempotent(req, res, () => _clockIn(dt.date, dt.time, req.body.note || null));
  });
  function _clockIn(date, time, note) {
    const openEntry = db.prepare(
      'SELECT * FROM clock_entries WHERE date = ? AND clocked_in IS NOT NULL AND clocked_out IS NULL ORDER BY id DESC LIMIT 1'
    ).get(date);
    let id;
    if (openEntry) {
      db.prepare('UPDATE clock_entries SET clocked_in = ?, note = COALESCE(?, note) WHERE id = ?').run(time, note, openEntry.id);
      id = openEntry.id;
    } else {
      id = db.prepare('INSERT INTO clock_entries (date, clocked_in, note) VALUES (?, ?, ?)').run(date, time, note).lastInsertRowid;
    }
    return db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(id);
  }

  // Clocking out is what "I've finished that shift" means, but marking the shift
  // itself complete used to happen only in the browser, after the clock-out call
  // came back — behind a break-length modal. Dismiss that modal, lose signal, lock
  // the phone, or close the tab, and the clock entry saved while the shift stayed
  // open, which is exactly the "I clocked out and it didn't mark it done" case.
  // So the server does it too: assume no break was taken (the safer default —
  // it under-pays hours_worked rather than over-crediting a break nobody had),
  // and let the client's follow-up PATCH correct it if a break was actually taken.
  // Never touches an already-completed shift.
  function _autoCompleteShiftForClockOut(date, clockOutTime, clockedInTime) {
    // Only ever a candidate if it isn't already done. On a split-shift day the
    // nearest shift by end time is often the morning one you already completed,
    // and picking it would mean the afternoon shift you just clocked out of stays
    // open — the exact thing this is here to prevent.
    const dayShifts = db.prepare(
      `SELECT * FROM shifts WHERE date = ? AND (completed IS NULL OR completed = 0)
         AND absence_type IS NULL ORDER BY start_time ASC`
    ).all(date);
    if (!dayShifts.length) return null;

    // Which shift did this clock-out finish? The one that was started: start time
    // nearest the clock-in. Matching on end time alone breaks when someone works
    // well past a shift's end (extra hours added mid-shift) and the clock-out
    // lands closer to a LATER shift's end than to the one they actually worked.
    const shift = (clockedInTime && _nearestShiftByField(dayShifts, 'start_time', clockedInTime))
      || _nearestShiftByField(dayShifts, 'end_time', clockOutTime) || dayShifts[0];
    if (!shift) return null;

    const actualBreak     = resolveBreakMinutes('none', shift.break_scheduled_minutes, shift.break_taken_minutes);
    const hours_worked    = calcHoursWorked(shift.start_time, shift.end_time, actualBreak);
    const hours_paid      = calcHoursWorked(shift.start_time, shift.end_time, shift.break_scheduled_minutes);
    const effectiveRate   = shift.hourly_rate ? shift.hourly_rate * (shift.is_bank_holiday ? 2 : 1) : null;
    const calculated_pay  = effectiveRate ? Math.round(hours_paid * effectiveRate * 100) / 100 : null;

    db.prepare(`
      UPDATE shifts SET completed=1, break_taken=?, break_taken_minutes=?,
        hours_worked=?, hours_paid=?, calculated_pay=?, updated_at=datetime('now')
      WHERE id=?
    `).run('none', actualBreak, hours_worked, hours_paid, calculated_pay, shift.id);

    const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
    logAudit({
      shift_id: updated.id,
      action: 'completed',
      changed_fields: ['completed', 'break_taken', 'break_taken_minutes'],
      old_values: { completed: shift.completed, break_taken: shift.break_taken, break_taken_minutes: shift.break_taken_minutes },
      new_values: { completed: 1, break_taken: 'none', break_taken_minutes: actualBreak },
      source: 'clock-out',
    });
    gcal.safeUpsert(updated);
    return updated;
  }

  // POST /api/clock/out — closes whichever entry is currently open for the day.
  // Falls back to the most recent entry (re-clock-out) if nothing's open, and to
  // a brand new out-only row if there's no entry at all yet — same defensive
  // fallbacks the old single-row version had, just no longer keyed by date alone.
  router.post('/api/clock/out', (req, res) => {
    const dt = _clockDateTime(req, res);
    if (!dt) return;
    _clockIdempotent(req, res, () => _clockOut(dt.date, dt.time, req.body.note || null));
  });
  function _clockOut(date, time, note) {
    const openEntry = db.prepare(
      'SELECT * FROM clock_entries WHERE date = ? AND clocked_in IS NOT NULL AND clocked_out IS NULL ORDER BY id DESC LIMIT 1'
    ).get(date);
    let id;
    if (openEntry) {
      id = openEntry.id;
    } else {
      const last = db.prepare('SELECT * FROM clock_entries WHERE date = ? ORDER BY id DESC LIMIT 1').get(date);
      id = last ? last.id : db.prepare('INSERT INTO clock_entries (date) VALUES (?)').run(date).lastInsertRowid;
    }
    db.prepare('UPDATE clock_entries SET clocked_out = ?, note = COALESCE(?, note) WHERE id = ?').run(time, note, id);
    let completedShift = null;
    try {
      completedShift = _autoCompleteShiftForClockOut(date, time, openEntry ? openEntry.clocked_in : null);
    } catch (e) {
      // Clocking out must still succeed even if completing the shift can't.
      console.error('[Clock] auto-complete on clock-out failed:', e.message);
    }
    webhooksRouter.fireShiftEndedWebhook({ end_time: time }).catch(() => {});
    const entry = db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(id);
    return { ...entry, completed_shift: completedShift };
  }

  // PATCH /api/clock/:id
  router.patch('/api/clock/:id', (req, res) => {
    const { clocked_in, clocked_out, note } = req.body;
    const entry = db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    db.prepare(`
      UPDATE clock_entries SET
        clocked_in  = COALESCE(?, clocked_in),
        clocked_out = COALESCE(?, clocked_out),
        note        = COALESCE(?, note)
      WHERE id = ?
    `).run(
      clocked_in  !== undefined ? clocked_in  : null,
      clocked_out !== undefined ? clocked_out : null,
      note        !== undefined ? note        : null,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM clock_entries WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/clock/:id
  router.delete('/api/clock/:id', (req, res) => {
    db.prepare('DELETE FROM clock_entries WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // GET /api/clock/analytics
  router.get('/api/clock/analytics', (req, res) => {
    const entries = db.prepare(`
      SELECT * FROM clock_entries
      WHERE clocked_in IS NOT NULL AND clocked_out IS NOT NULL
      ORDER BY date ASC
    `).all();

    const dates = [...new Set(entries.map(e => e.date))];
    const shiftsByDate = {};
    if (dates.length) {
      const placeholders = dates.map(() => '?').join(',');
      const allShifts = db.prepare(
        `SELECT date, start_time, end_time FROM shifts WHERE date IN (${placeholders})`
      ).all(...dates);
      for (const s of allShifts) (shiftsByDate[s.date] ||= []).push(s);
    }
    // Match clock-in against whichever shift's start_time it's closest to, and clock-out
    // against whichever shift's end_time it's closest to — independently, since a split
    // shift day means the "first" shift by start_time isn't necessarily the right one for
    // an evening clock-out. Fixes both false early/late flags and inflated extra-time totals.
    const rows = entries.map(e => {
      const dayShifts = shiftsByDate[e.date] || [];
      const inShift  = _nearestShiftByField(dayShifts, 'start_time', e.clocked_in);
      const outShift = _nearestShiftByField(dayShifts, 'end_time',   e.clocked_out);
      return { ...e, sched_start: inShift?.start_time || null, sched_end: outShift?.end_time || null };
    });

    // Clock-in:  Early = >5 min before start | On Time = 0–5 min before | Late = any minute after
    // Clock-out: Early = any minute before end | On Time = 0–5 min after | Late = >5 min after

    let inTotal = 0,  inCount = 0,  inEarly = 0,  inLate = 0,  inOnTime = 0;
    let outTotal = 0, outCount = 0, outEarly = 0, outLate = 0, outOnTime = 0;
    let hoursWorkedTotal = 0, hoursSchedTotal = 0, hoursCount = 0;
    // Total "extra" time actually spent at work outside the scheduled shift window —
    // time clocked in before the scheduled start, plus time clocked out after the
    // scheduled end. Unlike avgOvertime (an average difference), this is a running
    // total of unpaid-schedule minutes, so early-in and late-out both add to it
    // (they never cancel each other out).
    let extraBeforeTotal = 0, extraAfterTotal = 0, extraCount = 0;

    rows.forEach(r => {
      // Arrival diff
      if (r.sched_start && r.clocked_in) {
        const [sh, sm] = r.sched_start.split(':').map(Number);
        const [ch, cm] = r.clocked_in.split(':').map(Number);
        const diff = (ch * 60 + cm) - (sh * 60 + sm);
        inTotal += diff; inCount++;
        if (diff < -5) inEarly++;       // >5 min before start
        else if (diff > 0) inLate++;    // any minute past start
        else inOnTime++;                 // 0–5 min before start
        if (diff < 0) extraBeforeTotal += -diff; // minutes clocked in before scheduled start
      }
      // Departure diff
      if (r.sched_end && r.clocked_out) {
        const [sh, sm] = r.sched_end.split(':').map(Number);
        const [ch, cm] = r.clocked_out.split(':').map(Number);
        const diff = (ch * 60 + cm) - (sh * 60 + sm);
        outTotal += diff; outCount++;
        if (diff < 0) outEarly++;       // left before end
        else if (diff > 5) outLate++;   // >5 min after end
        else outOnTime++;                // 0–5 min after end
        if (diff > 0) extraAfterTotal += diff; // minutes clocked out after scheduled end
      }
      if ((r.sched_start && r.clocked_in) || (r.sched_end && r.clocked_out)) extraCount++;
      // Hours worked vs scheduled
      if (r.clocked_in && r.clocked_out && r.sched_start && r.sched_end) {
        const [ci_h, ci_m] = r.clocked_in.split(':').map(Number);
        const [co_h, co_m] = r.clocked_out.split(':').map(Number);
        const [ss_h, ss_m] = r.sched_start.split(':').map(Number);
        const [se_h, se_m] = r.sched_end.split(':').map(Number);
        hoursWorkedTotal += (co_h * 60 + co_m) - (ci_h * 60 + ci_m);
        hoursSchedTotal  += (se_h * 60 + se_m) - (ss_h * 60 + ss_m);
        hoursCount++;
      }
    });

    res.json({
      entries: rows,
      stats: {
        // Arrival
        count: inCount,
        avgDiffMins: inCount ? Math.round(inTotal / inCount) : 0,
        earlyCount: inEarly, onTimeCount: inOnTime, lateCount: inLate,
        // Departure
        outCount,
        avgOutDiffMins: outCount ? Math.round(outTotal / outCount) : 0,
        earlyOutCount: outEarly, onTimeOutCount: outOnTime, lateOutCount: outLate,
        // Hours
        hoursCount,
        avgWorkedMins: hoursCount ? Math.round(hoursWorkedTotal / hoursCount) : 0,
        avgSchedMins:  hoursCount ? Math.round(hoursSchedTotal  / hoursCount) : 0,
        // Total extra time (early-in + late-out minutes, summed rather than averaged)
        extraCount,
        totalExtraBeforeMins: extraBeforeTotal,
        totalExtraAfterMins:  extraAfterTotal,
        totalExtraMins: extraBeforeTotal + extraAfterTotal,
      },
    });
  });

  // -----------------------------------------
  // NFC / QUICK-TAP CLOCK IN-OUT
  // -----------------------------------------
  // A plain GET page (not /api/...) designed to be written to an NFC tag — tapping
  // your phone on the tag opens this URL directly with no app needed. Each tap
  // toggles against whatever's currently open: nothing open -> clock in (starting
  // a new entry, so a second/third shift on the same day just works), something
  // open -> clock out. Protected by a token from Settings, since this is an
  // unauthenticated GET with a side effect and phones will happily open it in
  // the background.
  function nfcTapPage(title, body, color = '#2e9e5b') {
    return `<!doctype html>
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1420;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
    .card{max-width:340px}
    h1{font-size:22px;margin:0 0 10px;color:${color}}
    p{color:#9aa4b8;font-size:14px;line-height:1.5}
    a{color:#5b9dff}
  </style></head>
  <body><div class="card"><h1>${title}</h1><p>${body}</p><p><a href="/">Open Rota App</a></p></div></body></html>`;
  }

  // NFC tags routinely get read more than once per physical tap (the phone's NFC
  // radio re-discovers the same NDEF record if the tag lingers in range a moment
  // too long), and a link opened in a browser can get silently re-fetched by link
  // preview/prefetch behaviour. Since this route toggles state, a duplicate GET
  // a heartbeat after the first would immediately undo it (clock out, then right
  // back in again for an "unscheduled" shift nobody worked). Debouncing repeat
  // hits for a few seconds absorbs that without getting in the way of someone
  // deliberately tapping again later to start a new shift.
  let _lastClockTapResult = null;
  const NFC_TAP_DEBOUNCE_MS = 6000;

  function _clockTap(today, time) {
    const openEntry = db.prepare(
      'SELECT * FROM clock_entries WHERE date = ? AND clocked_in IS NOT NULL AND clocked_out IS NULL ORDER BY id DESC LIMIT 1'
    ).get(today);

    let title, body;
    if (!openEntry) {
      db.prepare('INSERT INTO clock_entries (date, clocked_in) VALUES (?, ?)').run(today, time);
      title = '✅ Clocked in';
      body  = `Recorded at ${time}.`;
    } else {
      db.prepare('UPDATE clock_entries SET clocked_out = ? WHERE id = ?').run(time, openEntry.id);
      let completedShift = null;
      try {
        completedShift = _autoCompleteShiftForClockOut(today, time, openEntry.clocked_in);
      } catch (e) {
        console.error('[Clock] auto-complete on NFC clock-out failed:', e.message);
      }
      // There's no way to prompt for a reason from a tag tap, so a late finish at
      // least gets flagged on the entry rather than silently recorded — same as a
      // manager would want to know if asked "why does this say you left late?".
      if (completedShift && completedShift.end_time) {
        const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        if (toMins(time) - toMins(completedShift.end_time) > 5) {
          db.prepare('UPDATE clock_entries SET note = COALESCE(note, ?) WHERE id = ?')
            .run('Stayed late — no reason given (clocked out via NFC tap)', openEntry.id);
        }
      }
      webhooksRouter.fireShiftEndedWebhook({ end_time: time }).catch(() => {});
      title = '👋 Clocked out';
      body  = `Recorded at ${time}. Assumed no break was taken — open the app to correct that if you had one.`;
    }
    return { title, body, action: openEntry ? 'out' : 'in', time };
  }

  // POST /api/clock/tap — the same toggle as an NFC tap, at a given date/time. The
  // service worker uses this to replay a tap that happened with no signal: it
  // can't know offline whether you were clocked in, so it records "a tap at 07:58"
  // and the server applies it against whatever state it has when the tap arrives.
  router.post('/api/clock/tap', (req, res) => {
    const dt = _clockDateTime(req, res);
    if (!dt) return;
    _clockIdempotent(req, res, () => _clockTap(dt.date, dt.time));
  });

  router.get('/clock-tap', (req, res) => {
    // This route toggles clock state, so the response must never be served from
    // cache — a cached "Clocked in" page from this morning would prevent the
    // evening clock-out tap from ever reaching the server.
    res.set('Cache-Control', 'no-store');

    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'nfc_clock_token'").get();
    const configuredToken = tokenRow && tokenRow.value && tokenRow.value.trim();
    if (!configuredToken) {
      return res.send(nfcTapPage('Not set up yet', 'No NFC clock-in token is configured. Set one up in Settings → NFC Clock In/Out first.', '#e5a13c'));
    }
    if (!req.query.token || req.query.token !== configuredToken) {
      return res.status(403).send(nfcTapPage('Not authorised', "This link's token doesn't match what's configured in Settings.", '#e5573c'));
    }

    const now = Date.now();
    if (_lastClockTapResult && now - _lastClockTapResult.at < NFC_TAP_DEBOUNCE_MS) {
      return res.send(nfcTapPage(_lastClockTapResult.title, _lastClockTapResult.body));
    }

    const { title, body } = _clockTap(localDateStr(), localTimeStr());
    _lastClockTapResult = { at: now, title, body };
    res.send(nfcTapPage(title, body));
  });

  return router;
}

module.exports = { createClockRouter, localDateStr, localTimeStr, _timeToMins };
