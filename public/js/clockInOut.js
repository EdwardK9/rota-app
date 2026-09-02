/* ─── Clock In / Out ─────────────────────────────────────────────────────── */

const ClockInOutView = {
  today: null,
  entry: null,
  shift: null,
  _ticker: null,

  async init() {
    this.render();
    await this.loadToday();
    await this.loadHistory();
    this.startTicker();
  },

  destroy() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = null;
  },

  render() {
    document.getElementById('view-clock').innerHTML = `
      <div style="max-width:720px">

        <!-- Today card -->
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><h2>Today</h2>
            <span id="ckTodayDate" style="font-size:13px;color:var(--text-muted)"></span>
          </div>
          <div class="card-body">
            <div id="ckTodaySchedule" style="font-size:13px;color:var(--text-muted);margin-bottom:16px"></div>

            <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-bottom:20px">
              <!-- Clock In -->
              <div style="flex:1;min-width:200px;text-align:center">
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Clocked In</div>
                <div id="ckInTime" style="font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;margin-bottom:2px">--:--</div>
                <div id="ckInTarget" style="font-size:12px;color:var(--text-muted);margin-bottom:10px"></div>
                <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                  <button class="btn btn-primary" id="ckInBtn" style="min-width:110px">Clock In</button>
                  <button class="btn btn-ghost btn-sm" id="ckEditInBtn" style="display:none">Edit</button>
                </div>
                <div id="ckInDiff" style="margin-top:8px;font-size:13px;font-weight:600"></div>
              </div>

              <div style="align-self:center;font-size:24px;color:var(--border)">→</div>

              <!-- Clock Out -->
              <div style="flex:1;min-width:200px;text-align:center">
                <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Clocked Out</div>
                <div id="ckOutTime" style="font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;margin-bottom:2px">--:--</div>
                <div id="ckOutTarget" style="font-size:12px;color:var(--text-muted);margin-bottom:10px"></div>
                <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                  <button class="btn btn-danger" id="ckOutBtn" style="min-width:110px">Clock Out</button>
                  <button class="btn btn-ghost btn-sm" id="ckEditOutBtn" style="display:none">Edit</button>
                </div>
                <div id="ckOutDiff" style="margin-top:8px;font-size:13px;font-weight:600"></div>
              </div>
            </div>

            <!-- Live elapsed -->
            <div id="ckElapsed" style="text-align:center;font-size:13px;color:var(--text-muted)"></div>
          </div>
        </div>

        <!-- Analytics summary -->
        <div class="card" style="margin-bottom:20px" id="ckAnalyticsCard" style="display:none">
          <div class="card-header"><h2>Punctuality</h2></div>
          <div class="card-body">
            <div id="ckAnalyticsBody"></div>
          </div>
        </div>

        <!-- History -->
        <div class="card">
          <div class="card-header"><h2>History</h2></div>
          <div class="card-body" style="padding:0">
            <div id="ckHistory"></div>
          </div>
        </div>

      </div>
    `;

    document.getElementById('ckInBtn').addEventListener('click',     () => this.clockIn());
    document.getElementById('ckOutBtn').addEventListener('click',    () => this.clockOut());
    document.getElementById('ckEditInBtn').addEventListener('click', () => this.editTime('in'));
    document.getElementById('ckEditOutBtn').addEventListener('click',() => this.editTime('out'));
  },

  async loadToday() {
    try {
      const data = await API.get('/api/clock/today');
      this.today = data.today;
      this.entry = data.entry;
      this.shift = data.shift;
      this.renderToday();
    } catch(e) { showToast('Failed to load clock data', 'error'); }
  },

  renderToday() {
    const d = new Date(this.today + 'T12:00:00');
    document.getElementById('ckTodayDate').textContent =
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    const schedEl = document.getElementById('ckTodaySchedule');
    if (this.shift) {
      schedEl.textContent = `Scheduled: ${this.shift.start_time} – ${this.shift.end_time}`;
    } else {
      schedEl.textContent = 'No shift scheduled today';
    }

    const inTime  = this.entry?.clocked_in  || null;
    const outTime = this.entry?.clocked_out || null;

    document.getElementById('ckInTime').textContent  = inTime  || '--:--';
    document.getElementById('ckOutTime').textContent = outTime || '--:--';

    // Scheduled target times + leeway window (per clock-in / clock-out thresholds)
    const inLeeway  = this._thr('in', 'late');
    const outLeeway = this._thr('out', 'late');
    const inTarget  = document.getElementById('ckInTarget');
    const outTarget = document.getElementById('ckOutTarget');
    if (inTarget)  inTarget.textContent  = this.shift ? `🎯 Start ${this.shift.start_time} · ${inLeeway} min leeway` : '';
    if (outTarget) outTarget.textContent = this.shift ? `🎯 End ${this.shift.end_time} · ${outLeeway} min leeway` : '';

    // In button state
    const inBtn  = document.getElementById('ckInBtn');
    const outBtn = document.getElementById('ckOutBtn');
    const editIn  = document.getElementById('ckEditInBtn');
    const editOut = document.getElementById('ckEditOutBtn');

    if (inTime) {
      inBtn.textContent = 'Re-clock In';
      inBtn.className = 'btn btn-ghost btn-sm';
      editIn.style.display = '';
    } else {
      inBtn.textContent = 'Clock In';
      inBtn.className = 'btn btn-primary';
      editIn.style.display = 'none';
    }

    if (outTime) {
      outBtn.textContent = 'Re-clock Out';
      outBtn.className = 'btn btn-ghost btn-sm';
      editOut.style.display = '';
    } else {
      outBtn.textContent = outTime ? 'Re-clock Out' : 'Clock Out';
      outBtn.className = 'btn btn-danger';
      editOut.style.display = outTime ? '' : 'none';
    }

    // Diff vs schedule
    this.renderDiff('ckInDiff',  inTime,  this.shift?.start_time, 'Arrived', false);
    this.renderDiff('ckOutDiff', outTime, this.shift?.end_time,   'Left',    true);

    this.renderElapsed(inTime, outTime);
  },

  // Read an early/late threshold (minutes) for clock 'in'/'out', with back-compat fallback.
  // Default grace window is ±5 min both directions when nothing's configured in Settings —
  // under-5 early or late shouldn't be treated as noteworthy enough to prompt for a reason.
  _thr(dir, kind) {
    const st = window.App?.settings || {};
    const v = st[`clock_${dir}_${kind}_threshold`]
      ?? st[`clock_${kind}_threshold`]
      ?? 5;
    return parseInt(v, 10) || 0;
  },

  renderDiff(elId, actual, scheduled, label, isClockOut = false) {
    const el = document.getElementById(elId);
    if (!actual || !scheduled) { el.textContent = ''; return; }
    const [ah, am] = actual.split(':').map(Number);
    const [sh, sm] = scheduled.split(':').map(Number);
    const diff = (ah * 60 + am) - (sh * 60 + sm);
    const dir = isClockOut ? 'out' : 'in';
    const earlyThr = this._thr(dir, 'early');
    const lateThr  = this._thr(dir, 'late');
    if (diff < -earlyThr)     el.innerHTML = `<span style="color:var(--text-muted)">${label} ${Math.abs(diff)} min early</span>`;
    else if (diff > lateThr)  el.innerHTML = `<span style="color:var(--danger)">${label} ${diff} min late</span>`;
    else                      el.innerHTML = `<span style="color:var(--success)">${label} on time</span>`;
  },

  renderElapsed(inTime, outTime) {
    const el = document.getElementById('ckElapsed');
    if (!inTime) { el.textContent = ''; return; }
    const [ih, im] = inTime.split(':').map(Number);
    const startMs = new Date();
    startMs.setHours(ih, im, 0, 0);

    const endMs = outTime ? (() => {
      const [oh, om] = outTime.split(':').map(Number);
      const d = new Date(); d.setHours(oh, om, 0, 0); return d;
    })() : null;

    if (endMs) {
      const mins = Math.floor((endMs - startMs) / 60000);
      const h = Math.floor(mins / 60), m = mins % 60;
      el.textContent = `Total time: ${h}h ${m}m`;
    } else {
      // Live countdown
      const update = () => {
        const now = new Date();
        const mins = Math.floor((now - startMs) / 60000);
        if (mins < 0) { el.textContent = ''; return; }
        const h = Math.floor(mins / 60), m = mins % 60;
        el.textContent = `Time elapsed: ${h}h ${m}m`;
      };
      update();
    }
  },

  startTicker() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = setInterval(() => {
      const inTime  = this.entry?.clocked_in  || null;
      const outTime = this.entry?.clocked_out || null;
      if (inTime && !outTime) this.renderElapsed(inTime, null);
    }, 60000);
  },

  _timeDiffMins(actualHHMM, scheduledHHMM) {
    if (!actualHHMM || !scheduledHHMM) return 0;
    const [ah, am] = actualHHMM.split(':').map(Number);
    const [sh, sm] = scheduledHHMM.split(':').map(Number);
    return (ah * 60 + am) - (sh * 60 + sm);
  },

  _promptReason(diff, isClockOut = false) {
    return new Promise(resolve => {
      const direction = diff > 0 ? 'late' : 'early';
      const absMins = Math.abs(diff);

      const lateInReasons   = ['🚌 Transport / traffic', '😴 Overslept', '🏥 Personal matter', '📋 Manager approved', '✏️ Other…'];
      const earlyInReasons  = ['⚡ Arrived early', '📋 Agreed with manager', '🏃 Beat the traffic', '✏️ Other…'];
      const lateOutReasons  = ['💼 Required to work', '🙋 Manager asked to stay', '🏪 Busy / couldn\'t leave', '📋 Manager approved', '✏️ Other…'];
      const earlyOutReasons = ['✅ Shift ended early', '📋 Manager agreed', '🏥 Personal matter', '✏️ Other…'];

      const reasons = isClockOut
        ? (diff > 0 ? lateOutReasons : earlyOutReasons)
        : (diff > 0 ? lateInReasons  : earlyInReasons);

      const opts = reasons.map((r, i) =>
        `<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
          <input type="radio" name="ckReason" value="${r}" style="accent-color:var(--primary)" ${i===0?'checked':''} />
          <span style="font-size:14px">${r}</span>
        </label>`
      ).join('');

      const html = `
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 14px">
          You're clocking ${direction} by <strong>${absMins} min</strong>. Please select a reason:
        </p>
        <div style="display:flex;flex-direction:column;gap:6px" id="ckReasonOpts">${opts}</div>
        <div id="ckOtherWrap" style="display:none;margin-top:10px">
          <input type="text" id="ckOtherText" class="form-control" placeholder="Describe reason…" maxlength="120" />
        </div>
        <div style="display:flex;gap:8px;margin-top:18px">
          <button class="btn btn-primary" id="ckReasonConfirm" style="flex:1">Confirm</button>
          <button class="btn btn-ghost" id="ckReasonSkip">Skip</button>
        </div>`;

      Modal.open('Reason for ' + direction, html);

      document.querySelectorAll('input[name="ckReason"]').forEach(r =>
        r.addEventListener('change', () => {
          const isOther = r.value.startsWith('✏️');
          document.getElementById('ckOtherWrap').style.display = isOther ? '' : 'none';
          if (isOther) document.getElementById('ckOtherText').focus();
        })
      );

      document.getElementById('ckReasonSkip').addEventListener('click', () => {
        Modal.close(); resolve(null);
      });
      document.getElementById('ckReasonConfirm').addEventListener('click', () => {
        const selected = document.querySelector('input[name="ckReason"]:checked')?.value || '';
        const note = selected.startsWith('✏️')
          ? (document.getElementById('ckOtherText').value.trim() || 'Other')
          : selected;
        Modal.close(); resolve(note);
      });
    });
  },

  async clockIn() {
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const diff = this._timeDiffMins(hhmm, this.shift?.start_time);
    // Prompt when outside the clock-in early/late window
    let note = null;
    if (diff > this._thr('in','late') || diff < -this._thr('in','early')) {
      note = await this._promptReason(diff, false);
    }
    try {
      this.entry = await API.post('/api/clock/in', { time: hhmm, note });
      this.renderToday();
      showToast('Clocked in ✓', 'success');
      await this.loadHistory();
    } catch(e) { showToast('Failed to clock in: ' + e.message, 'error'); }
  },

  async clockOut() {
    const now  = new Date();
    const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    const diff = this._timeDiffMins(hhmm, this.shift?.end_time);
    // Prompt when clocking out early or late beyond the configured leeway window.
    // Under-threshold either direction (5 min by default) is normal and shouldn't nag for a reason.
    let note = null;
    if (diff < -this._thr('out','early') || diff > this._thr('out','late')) {
      note = await this._promptReason(diff, true);
    }
    try {
      this.entry = await API.post('/api/clock/out', { time: hhmm, note });
      this.renderToday();
      showToast('Clocked out ✓', 'success');
      await this.loadHistory();
      await this.loadAnalytics();

    } catch(e) { showToast('Failed to clock out: ' + e.message, 'error'); return; }

    // If there's a linked shift, ask about the break and mark it complete — and say
    // so when that doesn't happen, rather than leaving the shift silently incomplete.
    if (!this.shift?.id) {
      showToast("No shift on today's rota to mark complete", 'warning');
      return;
    }
    const breakResult = await this._promptBreak(this.shift.break_scheduled_minutes || 30);
    if (breakResult === null) {
      showToast('Shift NOT marked complete (break question cancelled)', 'warning');
      return;
    }
    try {
      await API.patch('/api/shifts/bulk-complete', {
        ids: [this.shift.id],
        completed: true,
        break_taken: breakResult.break_taken,
        break_taken_minutes: breakResult.break_taken_minutes,
      });
      showToast('Shift marked complete ✓', 'success');
    } catch (e) {
      showToast('Marking the shift complete failed: ' + e.message, 'error');
    }
  },

  _promptBreak(scheduledMins) {
    return new Promise(resolve => {
      const schedLabel = scheduledMins ? `${scheduledMins} min` : 'none scheduled';
      const html = `
        <p style="color:var(--text-muted);font-size:13px;margin:0 0 16px">
          Scheduled break: <strong>${schedLabel}</strong>. How much break did you take?
        </p>
        <div style="display:flex;flex-direction:column;gap:8px" id="ckBreakOpts">
          ${scheduledMins ? `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="ckBreak" value="full" style="accent-color:var(--primary)" checked />
            <span style="font-size:14px">Full break (${scheduledMins} min)</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="ckBreak" value="partial" style="accent-color:var(--primary)" />
            <span style="font-size:14px">Shorter break…</span>
          </label>` : ''}
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
            <input type="radio" name="ckBreak" value="none" style="accent-color:var(--primary)" ${!scheduledMins ? 'checked' : ''} />
            <span style="font-size:14px">No break taken</span>
          </label>
        </div>
        <div id="ckPartialWrap" style="display:none;margin-top:10px">
          <label style="font-size:13px;color:var(--text-muted);margin-bottom:4px;display:block">Minutes taken:</label>
          <input type="number" id="ckPartialMins" class="form-control" min="1" max="${scheduledMins - 1 || 60}"
            value="${Math.floor(scheduledMins / 2) || 15}" style="width:120px" />
        </div>
        <div style="display:flex;gap:8px;margin-top:18px">
          <button class="btn btn-primary" id="ckBreakConfirm" style="flex:1">Confirm</button>
          <button class="btn btn-ghost" id="ckBreakSkip">Skip</button>
        </div>`;

      Modal.open('Break taken', html);

      document.querySelectorAll('input[name="ckBreak"]').forEach(r =>
        r.addEventListener('change', () => {
          document.getElementById('ckPartialWrap').style.display = r.value === 'partial' ? '' : 'none';
        })
      );

      document.getElementById('ckBreakSkip').addEventListener('click', () => {
        Modal.close(); resolve(null);
      });
      document.getElementById('ckBreakConfirm').addEventListener('click', () => {
        const selected = document.querySelector('input[name="ckBreak"]:checked')?.value || 'full';
        let break_taken = selected;
        let break_taken_minutes;
        if (selected === 'full') {
          break_taken_minutes = scheduledMins;
        } else if (selected === 'partial') {
          break_taken_minutes = parseInt(document.getElementById('ckPartialMins').value, 10) || Math.floor(scheduledMins / 2);
        } else {
          break_taken_minutes = 0;
        }
        Modal.close();
        resolve({ break_taken, break_taken_minutes });
      });
    });
  },

  async editTime(which) {
    const current = which === 'in' ? this.entry?.clocked_in : this.entry?.clocked_out;
    const newTime = prompt(`Enter ${which === 'in' ? 'clock-in' : 'clock-out'} time (HH:MM):`, current || '');
    if (!newTime || !/^\d{2}:\d{2}$/.test(newTime.trim())) return;
    try {
      const patch = which === 'in' ? { clocked_in: newTime.trim() } : { clocked_out: newTime.trim() };
      this.entry = await API.patch(`/api/clock/${this.entry.id}`, patch);
      this.renderToday();
      showToast('Updated ✓', 'success');
      await this.loadHistory();
    } catch(e) { showToast('Failed: ' + e.message, 'error'); }
  },

  async loadHistory() {
    try {
      const { entries } = await API.get('/api/clock/history?limit=60');
      this.renderHistory(entries);
    } catch(e) { /* silent */ }
    await this.loadAnalytics();
  },

  renderHistory(entries) {
    const el = document.getElementById('ckHistory');
    if (!entries.length) {
      el.innerHTML = '<p style="padding:20px;color:var(--text-muted)">No clock entries yet.</p>';
      return;
    }

    const rows = entries.map(e => {
      const d = new Date(e.date + 'T12:00:00');
      const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const isToday  = e.date === this.today;

      let inDiff = '', outDiff = '';
      if (e.clocked_in && e.sched_start) {
        const [ah, am] = e.clocked_in.split(':').map(Number);
        const [sh, sm] = e.sched_start.split(':').map(Number);
        const d = (ah * 60 + am) - (sh * 60 + sm);
        // In: Early >5min = success, On Time 0-5min before = success, Late any after = danger
        if (d > 0)       inDiff = `<span style="color:var(--danger);font-size:11px">(${d}m late)</span>`;
        else if (d < -5) inDiff = `<span style="color:var(--success);font-size:11px">(${Math.abs(d)}m early)</span>`;
        // else on time — no chip needed
      }
      if (e.clocked_out && e.sched_end) {
        const [ah, am] = e.clocked_out.split(':').map(Number);
        const [sh, sm] = e.sched_end.split(':').map(Number);
        const d = (ah * 60 + am) - (sh * 60 + sm);
        // Out: Early any before = muted, On Time 0-5min after = none, Late >5min after = danger
        if (d < 0)      outDiff = `<span style="color:var(--text-muted);font-size:11px">(${Math.abs(d)}m early)</span>`;
        else if (d > 5) outDiff = `<span style="color:var(--danger);font-size:11px">(${d}m late)</span>`;
        // else on time — no chip needed
      }

      let duration = '';
      if (e.clocked_in && e.clocked_out) {
        const [ih, im] = e.clocked_in.split(':').map(Number);
        const [oh, om] = e.clocked_out.split(':').map(Number);
        const mins = (oh * 60 + om) - (ih * 60 + im);
        if (mins > 0) {
          const h = Math.floor(mins / 60), m = mins % 60;
          duration = `<span style="color:var(--text-muted);font-size:11px">${h}h${m ? ' ' + m + 'm' : ''}</span>`;
        }
      }

      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;
             border-bottom:1px solid var(--border);flex-wrap:wrap;
             ${isToday ? 'background:var(--bg-hover)' : ''}">
          <div style="min-width:130px;font-size:13px;font-weight:${isToday ? '700' : '500'}">
            ${isToday ? '▶ ' : ''}${dayLabel}
          </div>
          <div style="flex:1;font-size:13px;min-width:120px">
            ${e.sched_start ? `<span style="color:var(--text-muted)">Sched: ${e.sched_start}–${e.sched_end || '?'}</span>` : '<span style="color:var(--text-muted)">No shift</span>'}
          </div>
          <div style="font-size:14px;min-width:110px">
            ${e.clocked_in
              ? `<strong>${e.clocked_in}</strong> ${inDiff}`
              : '<span style="color:var(--text-muted)">—</span>'}
          </div>
          <div style="font-size:14px;min-width:110px">
            ${e.clocked_out
              ? `<strong>${e.clocked_out}</strong> ${outDiff}`
              : '<span style="color:var(--text-muted)">—</span>'}
          </div>
          <div style="min-width:50px">${duration}</div>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)"
            onclick="ClockInOutView.deleteEntry(${e.id})">✕</button>
        </div>`;
    }).join('');

    el.innerHTML = `
      <div style="display:flex;gap:12px;padding:10px 16px;border-bottom:2px solid var(--border);
           font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted)">
        <div style="min-width:130px">Date</div>
        <div style="flex:1;min-width:120px">Scheduled</div>
        <div style="min-width:110px">Clocked In</div>
        <div style="min-width:110px">Clocked Out</div>
        <div style="min-width:50px">Duration</div>
        <div style="width:32px"></div>
      </div>
      ${rows}
    `;
  },

  _fmtDiff(mins) {
    if (mins === 0) return '<span style="color:var(--success)">On time</span>';
    const sign = mins > 0 ? '+' : '';
    const col  = mins > 0 ? 'var(--danger)' : 'var(--success)';
    const label = mins > 0 ? 'late' : 'early';
    return `<span style="color:${col}">${sign}${Math.abs(mins)} min ${label}</span>`;
  },

  _fmtHM(mins) {
    const h = Math.floor(Math.abs(mins) / 60);
    const m = Math.abs(mins) % 60;
    return h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}`.trim() : `${m}m`;
  },

  _punctBar(early, onTime, late) {
    const total = early + onTime + late || 1;
    const ep = Math.round(100 * early  / total);
    const op = Math.round(100 * onTime / total);
    const lp = 100 - ep - op;
    return `
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:8px 0 4px;gap:1px">
        ${ep ? `<div style="flex:${ep};background:var(--success);border-radius:4px 0 0 4px" title="Early ${ep}%"></div>` : ''}
        ${op ? `<div style="flex:${op};background:#3b82f6" title="On time ${op}%"></div>` : ''}
        ${lp > 0 ? `<div style="flex:${lp};background:var(--danger);border-radius:0 4px 4px 0" title="Late ${lp}%"></div>` : ''}
      </div>
      <div style="display:flex;gap:12px;font-size:11px;color:var(--text-muted)">
        <span><span style="color:var(--success)">●</span> Early ${ep}%</span>
        <span><span style="color:#3b82f6">●</span> On time ${op}%</span>
        <span><span style="color:var(--danger)">●</span> Late ${lp}%</span>
      </div>`;
  },

  async loadAnalytics() {
    try {
      const data = await API.get('/api/clock/analytics');
      const s = data.stats || {};
      if (!s.count && !s.outCount) {
        document.getElementById('ckAnalyticsCard').style.display = 'none';
        return;
      }
      document.getElementById('ckAnalyticsCard').style.display = '';

      const avgW = s.avgWorkedMins || 0;
      const avgSc = s.avgSchedMins || 0;
      const hoursDiff = avgW - avgSc;
      const hoursDiffColor = hoursDiff >= 0 ? 'var(--success)' : 'var(--danger)';

      document.getElementById('ckAnalyticsBody').innerHTML = `

        <!-- Arrivals -->
        <div style="margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
               color:var(--text-muted);margin-bottom:10px">🕐 Arrivals</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <div class="stat-card" style="min-width:130px">
              <div class="stat-label">Average</div>
              <div class="stat-value" style="font-size:20px">${this._fmtDiff(s.avgDiffMins || 0)}</div>
              <div style="font-size:11px;color:var(--text-muted)">vs scheduled start</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">Early</div>
              <div class="stat-value" style="color:var(--success)">${s.earlyCount || 0}</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">On time</div>
              <div class="stat-value">${s.onTimeCount || 0}</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">Late</div>
              <div class="stat-value" style="color:${(s.lateCount||0) > 0 ? 'var(--danger)' : 'var(--text)'}">
                ${s.lateCount || 0}
              </div>
            </div>
          </div>
          ${s.count ? this._punctBar(s.earlyCount, s.onTimeCount, s.lateCount) : ''}
        </div>

        <!-- Departures -->
        <div style="margin-bottom:20px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
               color:var(--text-muted);margin-bottom:10px">🕔 Departures</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
            <div class="stat-card" style="min-width:130px">
              <div class="stat-label">Average</div>
              <div class="stat-value" style="font-size:20px">${this._fmtDiff(s.avgOutDiffMins || 0)}</div>
              <div style="font-size:11px;color:var(--text-muted)">vs scheduled end</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">Early</div>
              <div class="stat-value" style="color:var(--success)">${s.earlyOutCount || 0}</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">On time</div>
              <div class="stat-value">${s.onTimeOutCount || 0}</div>
            </div>
            <div class="stat-card" style="min-width:90px;text-align:center">
              <div class="stat-label">Late</div>
              <div class="stat-value" style="color:${(s.lateOutCount||0) > 0 ? 'var(--danger)' : 'var(--text)'}">
                ${s.lateOutCount || 0}
              </div>
            </div>
          </div>
          ${s.outCount ? this._punctBar(s.earlyOutCount, s.onTimeOutCount, s.lateOutCount) : ''}
        </div>

        <!-- Hours -->
        ${s.hoursCount ? `
        <div style="border-top:1px solid var(--border);padding-top:16px">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
               color:var(--text-muted);margin-bottom:10px">⏱ Hours worked</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="stat-card" style="min-width:110px;text-align:center">
              <div class="stat-label">Avg worked</div>
              <div class="stat-value">${this._fmtHM(avgW)}</div>
            </div>
            <div class="stat-card" style="min-width:110px;text-align:center">
              <div class="stat-label">Avg scheduled</div>
              <div class="stat-value">${this._fmtHM(avgSc)}</div>
            </div>
            <div class="stat-card" style="min-width:110px;text-align:center">
              <div class="stat-label">Avg Overtime</div>
              <div class="stat-value" style="color:${hoursDiffColor}" title="Avg extra time physically at work vs scheduled shift length">
                ${hoursDiff >= 0 ? '+' : ''}${this._fmtHM(hoursDiff)}
              </div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px">clocked vs scheduled</div>
            </div>
            <div class="stat-card" style="min-width:110px;text-align:center">
              <div class="stat-label">Total Extra Time</div>
              <div class="stat-value" title="Sum of all time clocked in before your scheduled start plus all time clocked out after your scheduled end, across every shift">
                ${this._fmtHM(s.totalExtraMins || 0)}
              </div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px">
                ${this._fmtHM(s.totalExtraBeforeMins || 0)} early-in + ${this._fmtHM(s.totalExtraAfterMins || 0)} late-out
              </div>
            </div>
          </div>
        </div>` : ''}

        <div style="margin-top:14px;font-size:12px;color:var(--text-muted)">
          Based on ${Math.max(s.count||0, s.outCount||0)} shift${Math.max(s.count||0, s.outCount||0) !== 1 ? 's' : ''} with clock data.
        </div>
      `;
    } catch(e) { /* silent */ }
  },

  async deleteEntry(id) {
    if (!confirm('Delete this clock entry?')) return;
    try {
      await API.delete(`/api/clock/${id}`);
      if (this.entry?.id === id) { this.entry = null; this.renderToday(); }
      await this.loadHistory();
      showToast('Deleted', 'success');
    } catch(e) { showToast('Failed to delete', 'error'); }
  },
};
