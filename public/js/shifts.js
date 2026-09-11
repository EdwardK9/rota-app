/* ─── Shifts View ─────────────────────────────────────────────────────────── */

const ShiftsView = {
  currentMonth: getCurrentMonth(),
  shifts: [],
  bankHols: new Set(),
  settings: {},
  payRates: [],

  async init(settings) {
    this.settings = settings || {};
    this.render();
    await this.loadShifts();
  },

  render() {
    const el = document.getElementById('view-shifts');
    el.innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="shiftPrevMonth">&#8249;</button>
          <span id="shiftMonthPicker" class="my-picker">${monthYearPickerHTML(this.currentMonth, 'shift')}</span>
          <button class="btn btn-ghost btn-sm" id="shiftNextMonth">&#8250;</button>
          <button class="btn btn-ghost btn-sm" id="shiftToday">Today</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-primary" id="addShiftBtn">+ Add Shift</button>
        </div>
      </div>

      <div class="stats-grid" id="shiftStats"></div>

      <div id="shiftContractStrip"></div>

      <div id="bulkBar" class="bulk-bar hidden">
        <span id="bulkCount">0 selected</span>
        <button class="btn btn-success btn-sm" id="bulkCompleteBtn">✓ Complete</button>
        <button class="btn btn-success btn-sm" id="bulkCompleteBreakUsedBtn">✓ Complete (Break Used)</button>
        <button class="btn btn-success btn-sm" id="bulkCompleteNoBreakBtn">✓ Complete (No Break)</button>
        <button class="btn btn-warning btn-sm" id="bulkUncompleteBtn">↩ Incomplete</button>
        <span class="bulk-mileage-group">
          <input type="number" id="bulkMileageInput" step="0.1" min="0" placeholder="Miles" style="width:80px;" />
          <button class="btn btn-ghost btn-sm" id="bulkMileageBtn">Set Mileage</button>
        </span>
        <button class="btn btn-ghost btn-sm" id="bulkClearBtn">Clear</button>
      </div>

      <div class="table-wrapper">
        <table id="shiftsTable">
          <thead>
            <tr>
              <th style="width:36px;"><input type="checkbox" id="selectAllShifts" title="Select all" class="shift-cb-large" /></th>
              <th style="width:32px;"></th>
              <th>Date</th>
              <th>Start</th>
              <th>End</th>
              <th>Break</th>
              <th>Used</th>
              <th title="Payable hours = Total minus scheduled break (always deducted, break is unpaid)" style="color:var(--success)">Paid Hrs ✓</th>
              <th>Pay</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="shiftsTbody">
            <tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-muted)">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('shiftMonthPicker').addEventListener('change', () => {
      const v = readMonthYearPicker('shift');
      if (v) { this.currentMonth = v; this.loadShifts(); }
    });

    document.getElementById('shiftPrevMonth').addEventListener('click', () => this.changeMonth(-1));
    document.getElementById('shiftNextMonth').addEventListener('click', () => this.changeMonth(1));
    document.getElementById('shiftToday').addEventListener('click', () => {
      this.currentMonth = getCurrentMonth();
      this._refreshPicker();
      this.loadShifts();
    });
    document.getElementById('addShiftBtn').addEventListener('click', () => this.openAddModal());

    document.getElementById('selectAllShifts').addEventListener('change', e => {
      document.querySelectorAll('.shift-row-cb').forEach(cb => { cb.checked = e.target.checked; });
      this.updateBulkBar();
    });

    document.getElementById('bulkCompleteBtn').addEventListener('click', () => this.bulkComplete());
    document.getElementById('bulkCompleteBreakUsedBtn').addEventListener('click', () => this.bulkComplete('full'));
    document.getElementById('bulkCompleteNoBreakBtn').addEventListener('click', () => this.bulkComplete('none'));
    document.getElementById('bulkUncompleteBtn').addEventListener('click', () => this.bulkUncomplete());
    document.getElementById('bulkMileageBtn').addEventListener('click', () => this.bulkUpdateMileage());
    document.getElementById('bulkClearBtn').addEventListener('click', () => {
      document.querySelectorAll('.shift-row-cb').forEach(cb => { cb.checked = false; });
      document.getElementById('selectAllShifts').checked = false;
      this.updateBulkBar();
    });
  },

  // Jump to a specific shift — used by the Audit Log's "click through" links.
  // Switches to the month containing the shift's date (if not already showing),
  // then scrolls to and briefly highlights its row.
  async gotoShift(shiftId, date) {
    const month = (date || '').slice(0, 7);
    if (month && month !== this.currentMonth) {
      this.currentMonth = month;
      this._refreshPicker();
      await this.loadShifts();
    }
    const row = document.querySelector(`tr[data-id="${shiftId}"]`);
    if (!row) { showToast('Could not find that shift', 'error'); return; }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prevOutline = row.style.outline;
    row.style.outline = '2px solid var(--primary)';
    row.style.outlineOffset = '-2px';
    setTimeout(() => { row.style.outline = prevOutline; }, 2000);
  },

  changeMonth(dir) {
    const [y, m] = this.currentMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    this.currentMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    this._refreshPicker();
    this.loadShifts();
  },

  _refreshPicker() {
    const p = document.getElementById('shiftMonthPicker');
    if (p) p.innerHTML = monthYearPickerHTML(this.currentMonth, 'shift');
  },

  async loadShifts() {
    try {
      // Also load adjacent month shifts so cross-month weeks show complete data
      const [y, m] = this.currentMonth.split('-').map(Number);
      const nextMonth = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
      const prevMonth = m === 1  ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;

      // Determine if first day is not Monday (week starts in prev month)
      const firstDow = new Date(y, m-1, 1).getDay(); // 0=Sun
      const firstIsMonday = firstDow === 1;
      // Determine if last day is not Sunday (week continues into next month)
      const lastDay = new Date(y, m, 0);
      const lastDow = lastDay.getDay();
      const lastIsSunday = lastDow === 0;

      // Date range for leave entries: cover the full window including adjacent months
      const leaveFrom = firstIsMonday
        ? `${y}-${String(m).padStart(2,'0')}-01`
        : `${prevMonth}-01`;
      const [py2, pm2] = nextMonth.split('-').map(Number);
      const leaveTo = lastIsSunday
        ? `${y}-${String(m).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`
        : `${nextMonth}-${String(new Date(py2, pm2, 0).getDate()).padStart(2,'0')}`;

      const [mainShifts, prevShifts, nextShifts, bankHols, payRates, leaveEntries] = await Promise.all([
        API.getShifts({ month: this.currentMonth }),
        !firstIsMonday ? API.getShifts({ month: prevMonth }).catch(() => []) : Promise.resolve([]),
        !lastIsSunday  ? API.getShifts({ month: nextMonth }).catch(() => []) : Promise.resolve([]),
        BankHols.forMonth(this.currentMonth).catch(() => new Set()),
        this.payRates.length ? Promise.resolve(this.payRates) : API.getPayRates().catch(() => []),
        API.getLeave({ from: leaveFrom, to: leaveTo }).catch(() => [])
      ]);

      // Merge: include adjacent-month shifts only if they share a week with the current month
      const currentMonthStart = `${y}-${String(m).padStart(2,'0')}-01`;
      const currentMonthEnd   = `${y}-${String(m).padStart(2,'0')}-${String(lastDay.getDate()).padStart(2,'0')}`;

      const getWeekStartStr = (dateStr) => {
        const d = new Date(dateStr + 'T00:00:00');
        const dow = d.getDay();
        const diff = dow === 0 ? -6 : 1 - dow;
        const mon = new Date(d); mon.setDate(d.getDate() + diff);
        return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
      };

      // Collect week starts that exist in the current month's shifts
      const weekStarts = new Set(mainShifts.map(s => getWeekStartStr(s.date)));

      // Include adjacent shifts only if their week overlaps with current month's weeks
      const adjShifts = [...prevShifts, ...nextShifts].filter(s => weekStarts.has(getWeekStartStr(s.date)));
      // Don't duplicate: exclude any adjacent shifts whose date is already in main shifts
      const mainDates = new Set(mainShifts.map(s => s.date));
      const dedupedAdj = adjShifts.filter(s => !mainDates.has(s.date));

      // Expand leave entries into individual working-day rows
      const hpdSetting = (this.settings && this.settings.hours_per_day) ? parseFloat(this.settings.hours_per_day) : 7.4;
      const leaveRows = [];
      for (const entry of leaveEntries) {
        const fullStart = new Date(entry.start_date + 'T00:00:00');
        const fullEnd   = new Date(entry.end_date   + 'T00:00:00');
        // Screwfix trades 7 days a week and this rota rotates across all of them,
        // so there's no such thing as an inherently "non-working" day here — every
        // calendar day the leave entry covers could have been a rostered shift.
        // The hours entered for the leave period are spread evenly across every
        // day it covers, weekend included, rather than only Mon–Fri.
        const totalDays = Math.round((fullEnd - fullStart) / 86400000) + 1;
        if (totalDays <= 0) continue;
        const totalHours = entry.hours_taken != null ? entry.hours_taken : (entry.days_taken * hpdSetting);
        const hoursPerDay = totalHours / totalDays;

        const cur = new Date(fullStart);
        while (cur <= fullEnd) {
          const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
          // Only include dates in the current month (not adjacent months)
          if (dateStr >= currentMonthStart && dateStr <= currentMonthEnd) {
            leaveRows.push({
              date: dateStr,
              _isLeave: true,
              _leaveType: entry.leave_type || 'annual',
              _leaveHours: hoursPerDay,
              _leaveEntryId: entry.id,
            });
          }
          cur.setDate(cur.getDate() + 1);
        }
      }

      // Merge leave rows with shifts (deduplicate by date — if a shift already exists on a leave date, skip the leave row)
      const allShiftDates = new Set([...mainShifts, ...dedupedAdj].map(s => s.date));
      const dedupedLeave = leaveRows.filter(l => !allShiftDates.has(l.date));

      this.shifts = [...mainShifts, ...dedupedAdj, ...dedupedLeave].sort((a, b) => a.date.localeCompare(b.date));
      this.bankHols = bankHols;
      this.payRates = payRates;
      this.renderStats();
      this.renderTable();
    } catch (e) {
      showToast('Failed to load shifts: ' + e.message, 'error');
    }
  },

  // The weekly contract in force for a given week — a week is contracted as a
  // whole week, whichever months its days land in.
  contractedHoursForWeek(weekStart) {
    if (!this.payRates.length) return null;
    const rate = [...this.payRates]
      .filter(r => r.effective_date <= weekStart)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
    return rate?.contracted_hours_per_week || null;
  },

  weekStartOf(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay();                      // 0=Sun
    const mon = new Date(d);
    mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
  },

  // Mon-start weeks covering everything currently loaded, each with its own
  // contract and totals. Single source for the contract strip and the table's
  // week headers — they showed different figures for the same week before, and
  // the top-of-page summary could not be reconciled against the rows below it.
  weekSummaries() {
    const order = [];
    const map = new Map();
    for (const s of this.shifts) {
      const wk = this.weekStartOf(s.date);
      if (!map.has(wk)) { map.set(wk, []); order.push(wk); }
      map.get(wk).push(s);
    }
    // hours_paid always has the full scheduled break deducted (breaks are never
    // paid), so it is the contract-facing figure — not hours_worked, which keeps
    // the time back when a break is worked through.
    const paidOf = s => s.hours_paid != null ? s.hours_paid : (s.hours_worked || 0);
    return order.map(wk => {
      const all   = map.get(wk);
      const real  = all.filter(s => !s._isLeave);
      const leave = all.filter(s => s._isLeave).reduce((n, s) => n + (s._leaveHours || 0), 0);
      const scheduled = real.reduce((n, s) => n + paidOf(s), 0) + leave;
      const contracted = this.contractedHoursForWeek(wk);
      return {
        weekStart: wk,
        shifts: all,
        real,
        leaveHours: leave,
        worked: real.filter(s => s.completed).reduce((n, s) => n + paidOf(s), 0),
        sick: real.filter(s => s.absence_type === 'sick').reduce((n, s) => n + paidOf(s), 0),
        scheduled,
        contracted,
        overUnder: contracted !== null ? scheduled - contracted : null
      };
    });
  },

  renderStats() {
    // this.shifts also carries a few days spilling into the adjacent month, kept
    // only so a week straddling the 1st can render as one row in the table below.
    // Stats must stay to the calendar month or they silently over/under-count
    // against a Contracted figure that's strictly this month.
    const inMonth = s => s.date.startsWith(this.currentMonth);
    const realShifts = this.shifts.filter(s => !s._isLeave && inMonth(s));
    const leaveHours = this.shifts.filter(s => s._isLeave && inMonth(s)).reduce((sum, s) => sum + (s._leaveHours || 0), 0);
    const completed = realShifts.filter(s => s.completed);
    // Month totals include ALL shifts (worked + not yet worked); "so far" = completed only
    // hours_paid (falls back to hours_worked) — same basis as the Monthly Reports tab —
    // plus leave, which counts towards the contract.
    const monthHours = realShifts.reduce((sum, s) => sum + (s.hours_paid != null ? s.hours_paid : (s.hours_worked || 0)), 0) + leaveHours;
    const monthPay   = realShifts.reduce((sum, s) => sum + (s.calculated_pay || 0), 0);
    const totalDist  = realShifts.reduce((sum, s) => sum + (s.distance_miles || 0), 0);
    const workedHours = completed.reduce((sum, s) => sum + (s.hours_paid != null ? s.hours_paid : (s.hours_worked || 0)), 0);
    const workedPay   = completed.reduce((sum, s) => sum + (s.calculated_pay || 0), 0);
    // Rostered, paid, counts towards contract — but not worked, so it stays out
    // of "Worked So Far" (an absence is never completed) and gets its own card.
    const sickShifts = realShifts.filter(s => s.absence_type === 'sick');
    const sickHours  = sickShifts.reduce((sum, s) => sum + (s.hours_paid != null ? s.hours_paid : (s.hours_worked || 0)), 0);

    // Overtime — hours over contract, summed across the whole Mon–Sun weeks
    // shown below (same basis as the Contract strip, not the calendar month).
    const contractWeeks = this.weekSummaries().filter(w => w.contracted !== null && w.real.length);
    const overtimeHours = contractWeeks.reduce((sum, w) => sum + Math.max(0, w.overUnder || 0), 0);

    // Break stats — across all shifts (scheduled); taken from completed shifts only
    const shiftsWithBreak     = realShifts.filter(s => (s.break_scheduled_minutes || 0) > 0);
    const totalBreakSched     = realShifts.reduce((sum, s) => sum + (s.break_scheduled_minutes || 0), 0);
    const totalBreakTaken     = completed.reduce((sum, s) => s.break_taken === 'none' ? sum : sum + (s.break_taken_minutes || 0), 0);
    const totalBreakScheduledCompleted = completed.reduce((sum, s) => sum + (s.break_scheduled_minutes || 0), 0);
    const totalBreakUnused    = Math.max(0, totalBreakScheduledCompleted - totalBreakTaken);

    // Pay equivalent of unused breaks (per-shift hourly rate × unused minutes)
    const breakUnusedPay = completed.reduce((sum, s) => {
      if (!s.hourly_rate) return sum;
      const sched = s.break_scheduled_minutes || 0;
      const taken = s.break_taken === 'none' ? 0
        : s.break_taken === 'partial' ? (s.break_taken_minutes || 0)
        : sched;
      const unused = Math.max(0, sched - taken);
      return sum + (unused / 60) * s.hourly_rate;
    }, 0);

    const fmtMins = (m) => m >= 60
      ? `${Math.floor(m / 60)}h ${m % 60 > 0 ? (m % 60) + 'm' : ''}`.trim()
      : `${m}m`;

    this.renderContractStrip();

    document.getElementById('shiftStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Shifts</div>
        <div class="stat-value">${realShifts.length}</div>
        <div class="stat-hint">All shifts dated this month</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value success">${completed.length}</div>
        <div class="stat-hint">Of the above, marked done</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Hours (Month)</div>
        <div class="stat-value">${fmtHours(monthHours)}</div>
        <div class="stat-hint">Paid hours for every shift this month (done or not) + leave</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Worked So Far</div>
        <div class="stat-value" style="color:var(--text-muted)">${fmtHours(workedHours)}</div>
        <div class="stat-hint">Paid hours, completed shifts only</div>
      </div>
      ${sickHours > 0 ? `
      <div class="stat-card">
        <div class="stat-label">Off Sick</div>
        <div class="stat-value warning">${fmtHours(sickHours)}</div>
        <div class="stat-hint">${sickShifts.length} shift${sickShifts.length === 1 ? '' : 's'} — counts towards contract, not towards hours worked</div>
      </div>` : ''}
      <div class="stat-card">
        <div class="stat-label">Est. Pay (Month)</div>
        <div class="stat-value">${fmtCurrency(monthPay)}</div>
        <div class="stat-hint">Every shift this month (done or not)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pay So Far</div>
        <div class="stat-value" style="color:var(--text-muted)">${fmtCurrency(workedPay)}</div>
        <div class="stat-hint">Completed shifts only</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Overtime</div>
        <div class="stat-value ${overtimeHours > 0 ? 'success' : ''}">${fmtHours(overtimeHours)}</div>
        <div class="stat-hint">Hours over contract, whole weeks shown below</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Distance</div>
        <div class="stat-value">${fmtMiles(totalDist)}</div>
        <div class="stat-hint">Every shift this month (done or not)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Breaks (count)</div>
        <div class="stat-value">${shiftsWithBreak.length}</div>
        <div class="stat-hint">Shifts this month with a scheduled break</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Break Scheduled</div>
        <div class="stat-value">${fmtMins(totalBreakSched)}</div>
        <div class="stat-hint">Total scheduled, every shift this month</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Break Taken</div>
        <div class="stat-value warning">${fmtMins(totalBreakTaken)}</div>
        <div class="stat-hint">Completed shifts only</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Break Unused</div>
        <div class="stat-value ${totalBreakUnused > 0 ? 'success' : ''}">${fmtMins(totalBreakUnused)}</div>
        <div class="stat-hint">Scheduled minus taken, completed shifts</div>
      </div>
      ${breakUnusedPay > 0 ? `
      <div class="stat-card">
        <div class="stat-label">Unused Break Pay</div>
        <div class="stat-value success">${fmtCurrency(breakUnusedPay)}</div>
        <div class="stat-hint">Unused break time &times; each shift's hourly rate</div>
      </div>` : ''}
    `;
  },

  // Contract tracking, on the weeks shown in the table below rather than on the
  // calendar month. The contract is weekly, and a month boundary falls mid-week:
  // September 2026 ended on a Wednesday with 20 of that week's 23 hours landing
  // in October, so the month read 1.92h under while all five weeks were on or
  // over contract. Both figures were right and reconciling them by hand was
  // guesswork. The month-vs-payroll comparison lives in Payslips → Hours vs
  // Contract, which is where a payslip is there to check it against.
  renderContractStrip() {
    const el = document.getElementById('shiftContractStrip');
    if (!el) return;

    const weeks = this.weekSummaries().filter(w => w.contracted !== null && w.real.length);
    if (!weeks.length) { el.innerHTML = ''; return; }

    const scheduled  = weeks.reduce((n, w) => n + w.scheduled, 0);
    const contracted = weeks.reduce((n, w) => n + w.contracted, 0);
    const diff       = scheduled - contracted;
    const onContract = Math.abs(diff) < 0.005;

    const fmtShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const lastEnd = new Date(weeks[weeks.length - 1].weekStart + 'T00:00:00');
    lastEnd.setDate(lastEnd.getDate() + 6);
    const span = `${fmtShort(weeks[0].weekStart)} – ${fmtShort(`${lastEnd.getFullYear()}-${String(lastEnd.getMonth()+1).padStart(2,'0')}-${String(lastEnd.getDate()).padStart(2,'0')}`)}`;

    const colour = onContract ? 'var(--text-muted)' : diff > 0 ? 'var(--success)' : 'var(--danger)';
    const verdict = onContract
      ? 'on contract'
      : `${fmtHours(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'}`;

    el.innerHTML = `
      <div class="contract-strip">
        <div class="contract-strip-row">
          <span class="contract-strip-title">Contract</span>
          <span class="contract-strip-span">${weeks.length} week${weeks.length === 1 ? '' : 's'} below · ${span}</span>
          <span class="contract-strip-sum">
            <strong>${fmtHours(scheduled)}</strong> scheduled
            vs <strong>${fmtHours(contracted)}</strong> contracted
            <strong style="color:${colour}">${onContract ? 'on contract' : `${diff > 0 ? '+' : '&minus;'}${fmtHours(Math.abs(diff))}`}</strong>
          </span>
        </div>
        <div class="contract-strip-note">
          Whole Mon–Sun weeks, not split at a month boundary — so this adds up to the week rows below, and
          <strong>${verdict}</strong> is across those weeks, not across ${fmtMonth(this.currentMonth)}.
          For the month-vs-payslip figure, see <strong>Payslips → Hours vs Contract</strong>.
        </div>
      </div>`;
  },

  renderTable() {
    const tbody = document.getElementById('shiftsTbody');
    if (!this.shifts.length) {
      tbody.innerHTML = `
        <tr><td colspan="11">
          <div class="empty-state">
            <div class="empty-state-icon">📅</div>
            <div class="empty-state-text">No shifts this month</div>
            <div class="empty-state-sub">Add a shift to get started</div>
          </div>
        </td></tr>`;
      return;
    }

    // Same week totals the contract strip above is built from — see weekSummaries()
    const weeks = this.weekSummaries();

    // ── Render helper for a single shift row ──────────────────────────────────
    const shiftRow = (s) => {
      const sched = s.break_scheduled_minutes || 0;
      const breakChip = `<span class="break-chip break-full">${sched}m</span>`;
      const breakUsedChip = !sched
        ? `<span style="color:var(--text-muted)">—</span>`
        : !s.completed
        ? `<span style="color:var(--text-muted)">—</span>`
        : s.break_taken === 'none'
        ? `<span class="break-chip break-none" title="Break not taken">0m</span>`
        : s.break_taken === 'partial'
        ? `<span class="break-chip break-partial" title="Partial break taken">${s.break_taken_minutes}m</span>`
        : `<span class="break-chip break-full" title="Full break taken">${sched}m</span>`;

      const isBankHol = s.is_bank_holiday || this.bankHols.has(s.date);
      const payCell = isBankHol
        ? `<span class="bh-pay" title="Bank Holiday 2× rate">${fmtCurrency(s.calculated_pay)} <span class="bh-badge" style="font-size:10px;vertical-align:middle;">2×</span></span>`
        : fmtCurrency(s.calculated_pay);
      // An absence isn't "not done yet" — it's settled, just not worked. Own
      // marker so it can't be mistaken for a shift still waiting to be ticked.
      const isSick = s.absence_type === 'sick';
      const statusCell = isSick
        ? `<span class="sick-badge" title="Off sick — counts towards contract, not towards hours worked">🤒</span>`
        : `<button class="complete-btn ${s.completed ? 'done' : ''}" title="${s.completed ? 'Mark incomplete' : 'Mark complete'}" data-id="${s.id}">
             ${s.completed ? '✓' : ''}
           </button>`;
      return `
        <tr class="${s.completed ? 'completed-row' : ''}${isBankHol ? ' bh-row' : ''}${isSick ? ' sick-row' : ''}" data-id="${s.id}">
          <td style="width:36px">
            <input type="checkbox" class="shift-row-cb shift-cb-large" data-id="${s.id}" />
          </td>
          <td>${statusCell}</td>
          <td>
            <div class="shift-date">${fmtDate(s.date)}${isBankHol ? ' <span class="bh-badge" title="Bank Holiday">BH</span>' : ''}${isSick ? ' <span class="sick-tag">SICK</span>' : ''}</div>
            <div class="shift-day">${fmtDayShort(s.date)}</div>
          </td>
          <td class="shift-time">${s.start_time}</td>
          <td class="shift-time">${s.end_time}</td>
          <td>${breakChip}</td>
          <td>${breakUsedChip}</td>
          <td>${fmtHours(s.hours_paid != null ? s.hours_paid : s.hours_worked)}</td>
          <td class="shift-pay">${payCell}</td>
          <td class="shift-notes-cell" style="text-align:center">
            ${s.notes
              ? `<span class="notes-tick" title="${esc(s.notes)}">✓</span>`
              : `<span class="notes-cross">✗</span>`
            }
          </td>
          <td class="actions">
            <button class="btn-icon edit-shift-btn" title="Edit" data-id="${s.id}">✏️</button>
            <button class="btn-icon danger delete-shift-btn" title="Delete" data-id="${s.id}">🗑️</button>
          </td>
        </tr>`;
    };

    // ── Render helper for a leave row ─────────────────────────────────────────
    const leaveRow = (l) => {
      const leaveLabel = l._leaveType === 'annual' ? 'Annual Leave' : (l._leaveType || 'Leave');
      const detail = `${leaveLabel} &nbsp;·&nbsp; ${fmtHours(l._leaveHours)} paid hrs`;
      return `
        <tr class="leave-row" style="background:rgba(40,167,69,0.07);border-left:3px solid var(--success);" data-leave-id="${l._leaveEntryId}">
          <td></td>
          <td style="text-align:center;font-size:16px">🏖️</td>
          <td>
            <div class="shift-date">${fmtDate(l.date)}</div>
            <div class="shift-day">${fmtDayShort(l.date)}</div>
          </td>
          <td colspan="6" style="color:var(--success);font-style:italic;font-size:13px">
            ${detail}
          </td>
          <td></td>
        </tr>`;
    };

    // ── Build the full table HTML with week grouping ──────────────────────────
    let html = '';
    const fmtShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    for (const w of weeks) {
      const wk = w.weekStart;
      const weekShifts  = w.shifts;
      const sunDate     = new Date(wk + 'T00:00:00');
      sunDate.setDate(sunDate.getDate() + 6);
      const sunStr = `${sunDate.getFullYear()}-${String(sunDate.getMonth()+1).padStart(2,'0')}-${String(sunDate.getDate()).padStart(2,'0')}`;
      const wkLabel     = `${fmtShort(wk)} – ${fmtShort(sunStr)}`;

      const weekLeaveHours = w.leaveHours;
      const weekWorked     = w.worked;
      const weekScheduled  = w.scheduled;
      const contracted     = w.contracted;
      const overUnder      = w.overUnder;
      const hasCompleted   = w.real.some(s => s.completed);

      const overUnderHtml = overUnder !== null
        ? ` <span style="font-weight:700;color:${overUnder >= 0 ? 'var(--success)' : 'var(--danger)'};">${overUnder >= 0 ? '+' : '-'}${fmtHours(Math.abs(overUnder))}</span>`
        : '';
      const contractedHtml = contracted !== null
        ? `<span style="color:var(--text-muted);margin-left:4px" title="This week's own Mon–Sun contract. These weeks are what the Contract summary above totals.">contracted ${fmtHours(contracted)}${overUnderHtml}</span>`
        : '';

      const leaveHtml = weekLeaveHours > 0
        ? ` · <span style="color:var(--success)">🏖️ ${fmtHours(weekLeaveHours)} leave</span>`
        : '';
      const sickHtml = w.sick > 0
        ? ` · <span style="color:var(--warning)" title="Rostered but not worked — still counts towards contract">🤒 ${fmtHours(w.sick)} sick</span>`
        : '';
      html += `<tr class="week-group-row" style="background:var(--bg)">
        <td colspan="11" style="padding:5px 14px;border-top:2px solid var(--border);border-bottom:1px solid var(--border);">
          <span style="font-weight:600;color:var(--text-muted);font-size:12px">Week&nbsp;${wkLabel}</span>
          <span style="margin-left:16px;font-size:12px;color:var(--text)">
            ${hasCompleted ? `<strong>${fmtHours(weekWorked)}</strong> worked · ` : ''}
            <strong style="color:var(--primary)">${fmtHours(weekScheduled)}</strong> scheduled
            ${leaveHtml}
            ${sickHtml}
            ${contractedHtml}
          </span>
        </td>
      </tr>`;

      html += weekShifts.map(s => s._isLeave ? leaveRow(s) : shiftRow(s)).join('');
    }

    tbody.innerHTML = html;

    // Wire up events
    tbody.querySelectorAll('.complete-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.toggleComplete(+btn.dataset.id);
      })
    );
    tbody.querySelectorAll('.edit-shift-btn').forEach(btn =>
      btn.addEventListener('click', () => this.openEditModal(+btn.dataset.id))
    );
    tbody.querySelectorAll('.delete-shift-btn').forEach(btn =>
      btn.addEventListener('click', () => this.deleteShift(+btn.dataset.id))
    );
    tbody.querySelectorAll('.shift-row-cb').forEach(cb =>
      cb.addEventListener('change', () => this.updateBulkBar())
    );
  },

  updateBulkBar() {
    const checked = document.querySelectorAll('.shift-row-cb:checked');
    const bar = document.getElementById('bulkBar');
    const count = document.getElementById('bulkCount');
    if (!bar) return;
    if (checked.length > 0) {
      bar.classList.remove('hidden');
      count.textContent = `${checked.length} selected`;
    } else {
      bar.classList.add('hidden');
    }
  },

  async bulkComplete(breakMode) {
    // breakMode: undefined = keep existing, 'full' = break used, 'none' = no break
    const checked = [...document.querySelectorAll('.shift-row-cb:checked')];
    const ids = checked.map(cb => +cb.dataset.id);
    if (!ids.length) return;

    const incomplete = this.shifts.filter(s => ids.includes(s.id) && !s.completed);
    if (!incomplete.length) { showToast('All selected shifts are already complete', 'warning'); return; }

    // Build break override payload
    let breakOverride;
    if (breakMode === 'full') {
      // Each shift uses its own scheduled minutes — pass per-shift would need individual calls,
      // so we send break_taken='full' and let the server use each shift's break_scheduled_minutes
      breakOverride = { break_taken: 'full' };
    } else if (breakMode === 'none') {
      breakOverride = { break_taken: 'none', break_taken_minutes: 0 };
    }

    const label = breakMode === 'full' ? ' (break used)' : breakMode === 'none' ? ' (no break)' : '';
    try {
      const result = await API.bulkCompleteShifts(incomplete.map(s => s.id), true, breakOverride);
      showToast(`${result.updated} shift${result.updated !== 1 ? 's' : ''} marked complete${label} 🎉`, 'success');
      document.getElementById('selectAllShifts').checked = false;
      await this.loadShifts();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async bulkUncomplete() {
    const checked = [...document.querySelectorAll('.shift-row-cb:checked')];
    const ids = checked.map(cb => +cb.dataset.id);
    if (!ids.length) return;

    // Only mark completed ones as incomplete
    const completed = this.shifts.filter(s => ids.includes(s.id) && s.completed);
    if (!completed.length) { showToast('None of the selected shifts are completed', 'warning'); return; }

    try {
      const result = await API.bulkCompleteShifts(completed.map(s => s.id), false);
      showToast(`${result.updated} shift${result.updated !== 1 ? 's' : ''} marked incomplete`, 'success');
      document.getElementById('selectAllShifts').checked = false;
      await this.loadShifts();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async bulkUpdateMileage() {
    const checked = [...document.querySelectorAll('.shift-row-cb:checked')];
    const ids = checked.map(cb => +cb.dataset.id);
    if (!ids.length) return;
    const milesInput = document.getElementById('bulkMileageInput');
    const miles = parseFloat(milesInput.value);
    if (isNaN(miles) || miles < 0) { showToast('Enter a valid mileage', 'warning'); return; }
    try {
      const result = await API.patch('/api/shifts/bulk-mileage', { ids, distance_miles: miles });
      showToast(`Mileage updated for ${result.updated} shift${result.updated !== 1 ? 's' : ''}`, 'success');
      milesInput.value = '';
      document.getElementById('selectAllShifts').checked = false;
      await this.loadShifts();
    } catch(e) { showToast(e.message, 'error'); }
  },

  async toggleComplete(id) {
    const shift = this.shifts.find(s => s.id === id);
    if (!shift) return;

    if (!shift.completed) {
      // Always open the modal so screenshot upload is available
      this.openCompleteModal(shift);
    } else {
      try {
        await API.completeShift(id, { completed: false });
        showToast('Shift marked as upcoming');
        await this.loadShifts();
      } catch(e) { showToast(e.message, 'error'); }
    }
  },

  openCompleteModal(shift) {
    const hasBreak = !!shift.break_scheduled_minutes;
    const breakSection = hasBreak ? `
      <div class="form-group">
        <label>Did you take your break? (Scheduled: ${shift.break_scheduled_minutes} min)</label>
        <div class="radio-group" id="breakRadios">
          <label class="radio-label">
            <input type="radio" name="break_taken" value="full" ${shift.break_taken !== 'partial' && shift.break_taken !== 'none' ? 'checked' : ''} />
            Full break (${shift.break_scheduled_minutes}m)
          </label>
          <label class="radio-label">
            <input type="radio" name="break_taken" value="partial" ${shift.break_taken === 'partial' ? 'checked' : ''} />
            Partial break
          </label>
          <label class="radio-label">
            <input type="radio" name="break_taken" value="none" ${shift.break_taken === 'none' ? 'checked' : ''} />
            No break
          </label>
        </div>
      </div>
      <div class="form-group" id="partialGroup" style="display:${shift.break_taken === 'partial' ? 'block' : 'none'}">
        <label>How many minutes did you take?</label>
        <input type="number" id="partialMins" min="0" max="${shift.break_scheduled_minutes}" value="${shift.break_taken === 'partial' ? shift.break_taken_minutes : 15}" />
      </div>` : '';

    const html = `
      <p style="margin-bottom:16px;color:var(--text-muted)">
        <strong>${fmtDate(shift.date)}</strong> &nbsp;${shift.start_time} – ${shift.end_time}
      </p>
      ${breakSection}
      <div class="form-group">
        <label>Notes (optional)</label>
        <textarea id="completeNotes" rows="2">${esc(shift.notes || '')}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        <button class="btn btn-success" id="confirmCompleteBtn">✓ Mark Complete</button>
      </div>`;

    Modal.open('Complete Shift', html);

    // Show/hide partial input
    document.querySelectorAll('input[name="break_taken"]').forEach(r => {
      r.addEventListener('change', () => {
        document.getElementById('partialGroup').style.display =
          r.value === 'partial' ? 'block' : 'none';
      });
    });

    document.getElementById('confirmCompleteBtn').addEventListener('click', async () => {
      const break_taken = hasBreak
        ? document.querySelector('input[name="break_taken"]:checked').value
        : 'none';
      const break_taken_minutes = !hasBreak ? 0
        : break_taken === 'partial' ? parseInt(document.getElementById('partialMins').value, 10)
        : break_taken === 'none'    ? 0
        : shift.break_scheduled_minutes;
      const notes = document.getElementById('completeNotes').value.trim() || null;

      try {
        await API.completeShift(shift.id, { completed: true, break_taken, break_taken_minutes, notes });
        Modal.close();
        showToast('Shift completed! 🎉', 'success');
        await this.loadShifts();
      } catch(e) { showToast(e.message, 'error'); }
    });
  },

  // prefillDate — optional YYYY-MM-DD to pre-fill the date field
  async openAddModal(prefillDate) {
    const defaultDist  = this.settings.default_distance_miles || 3.6;
    const _n = new Date();
    const date = prefillDate || `${_n.getFullYear()}-${String(_n.getMonth()+1).padStart(2,'0')}-${String(_n.getDate()).padStart(2,'0')}`;
    const s = { date, start_time: '08:00', end_time: '14:00',
      break_scheduled_minutes: 0, break_taken: 'full', distance_miles: defaultDist };

    let colleagues = [], workingWith = [];
    try { colleagues = await API.getColleagues(); } catch(_) {}

    Modal.open('Add Shift', this.shiftFormHtml(s, colleagues, workingWith));
    this.wireShiftForm(null, colleagues);
  },

  // idOrShift — accepts either a numeric id (looks up in this.shifts) or a full shift object
  // (useful when called from CalendarView which has its own shift list)
  async openEditModal(idOrShift) {
    const shift = typeof idOrShift === 'object'
      ? idOrShift
      : this.shifts.find(s => s.id === idOrShift);
    if (!shift) return;

    let colleagues = [], workingWith = [];
    try {
      [colleagues, workingWith] = await Promise.all([
        API.getColleagues(),
        API.getWorkingWith(shift.date, shift.start_time, shift.end_time).catch(() => []),
      ]);
    } catch(_) {}

    Modal.open('Edit Shift', this.shiftFormHtml(shift, colleagues, workingWith));
    this.wireShiftForm(shift.id, colleagues);
  },

  shiftFormHtml(s, colleagues = [], workingWith = []) {
    const isBH = s.is_bank_holiday ? 'checked' : '';
    const breakMins = s.break_scheduled_minutes ?? 30;
    const breakPreset = [0, 15, 30].includes(breakMins) ? String(breakMins) : 'custom';
    const customVal  = breakPreset === 'custom' ? breakMins : '';

    return `
      <div class="form-group">
        <label>Date *</label>
        <input type="date" id="sfDate" value="${esc(s.date || '')}" />
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Start Time *</label>
          <input type="time" id="sfStart" value="${esc(s.start_time || '')}" />
        </div>
        <div class="form-group">
          <label>End Time *</label>
          <input type="time" id="sfEnd" value="${esc(s.end_time || '')}" />
        </div>
      </div>
      <div class="form-group">
        <label>Scheduled Break</label>
        <div class="break-btn-group" id="sfBreakGroup">
          <label class="break-btn-label ${breakPreset === '0'      ? 'active' : ''}">
            <input type="radio" name="sfBreakPreset" value="0"      ${breakPreset === '0'      ? 'checked' : ''} /> 0 min
          </label>
          <label class="break-btn-label ${breakPreset === '15'     ? 'active' : ''}">
            <input type="radio" name="sfBreakPreset" value="15"     ${breakPreset === '15'     ? 'checked' : ''} /> 15 min
          </label>
          <label class="break-btn-label ${breakPreset === '30'     ? 'active' : ''}">
            <input type="radio" name="sfBreakPreset" value="30"     ${breakPreset === '30'     ? 'checked' : ''} /> 30 min
          </label>
          <label class="break-btn-label ${breakPreset === 'custom' ? 'active' : ''}">
            <input type="radio" name="sfBreakPreset" value="custom" ${breakPreset === 'custom' ? 'checked' : ''} /> Custom
          </label>
        </div>
        <div id="sfBreakCustomWrap" style="margin-top:8px;${breakPreset === 'custom' ? '' : 'display:none'}">
          <input type="number" id="sfBreakCustom" min="0" placeholder="Enter minutes" value="${customVal}" style="max-width:160px;" />
        </div>
        <!-- hidden field always holds the resolved value for calcPreview -->
        <input type="hidden" id="sfBreakSched" value="${breakMins}" />
        <label style="display:flex;align-items:flex-start;gap:8px;margin-top:10px;font-weight:400;cursor:pointer">
          <input type="checkbox" id="sfBreakLocked" ${s.break_locked ? 'checked' : ''} style="margin-top:2px" />
          <span>
            Keep this break exactly as set
            <span style="display:block;font-size:11px;color:var(--text-muted);line-height:1.4">
              Stops Recalculate All, the break audit and the Rotageek sync putting it back to the
              standard break for these hours. Tick it when the break was genuinely changed — a
              manager dropping it so you finish earlier.
            </span>
          </span>
        </label>
      </div>
      <div class="form-group">
        <label>Not worked</label>
        <select id="sfAbsence">
          <option value=""     ${!s.absence_type              ? 'selected' : ''}>Worked as normal</option>
          <option value="sick" ${s.absence_type === 'sick'    ? 'selected' : ''}>Off sick</option>
        </select>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.4">
          A sick day still counts towards your contract — payroll docks the basic and hands it back
          as company sick pay, so you're paid either way — but it doesn't count as hours worked.
          Marking one clears its completed tick, since it wasn't worked.
        </div>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <textarea id="sfNotes" rows="2">${esc(s.notes || '')}</textarea>
      </div>
      ${(() => {
        if (!colleagues.length) return '';
        // workingWith contains colleagues whose rota overlaps this shift (from DB)
        const wwIds = new Set((workingWith || []).map(c => c.id));
        const hasRota = workingWith && workingWith.length > 0;
        if (hasRota) {
          // Read-only: show who is on-shift from team rota
          return `<div class="form-group">
            <label>Working with <span style="color:var(--text-muted);font-size:12px">(from team rota)</span></label>
            <div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0">
              ${workingWith.map(c => `<span class="badge badge-info" style="padding:4px 8px">${esc(c.name)}</span>`).join('')}
            </div>
          </div>`;
        } else {
          // Manual picker: checkboxes
          return `<div class="form-group">
            <label>Working with <span style="color:var(--text-muted);font-size:12px">(select manually)</span></label>
            <div id="sfColleagueList" style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0">
              ${colleagues.map(c => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;
                  padding:3px 8px;border:1px solid var(--border);border-radius:20px;white-space:nowrap">
                <input type="checkbox" class="sf-colleague-cb" data-id="${c.id}" style="accent-color:var(--primary)" />
                ${esc(c.name)}
              </label>`).join('')}
            </div>
          </div>`;
        }
      })()}
      <div id="sfPreview" style="background:var(--bg);padding:12px;border-radius:8px;margin-bottom:8px;font-size:13px;color:var(--text-muted);">
        Total: <strong id="sfTotalHrsPreview">—</strong> &nbsp;|&nbsp;
        Worked: <strong id="sfHrsPreview">—</strong> &nbsp;|&nbsp;
        Pay: <strong id="sfPayPreview">—</strong>
      </div>
      <details class="shift-extras" style="margin-bottom:12px;">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);user-select:none;">More options ▸</summary>
        <div style="padding-top:12px;">
          <div class="form-group">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="sfBankHol" ${isBH} style="width:16px;height:16px;accent-color:var(--primary);" />
              <span>Bank Holiday <span class="bh-badge" style="font-size:11px">BH</span> &nbsp;(2× pay rate)</span>
            </label>
            <div id="sfBankHolHint" style="font-size:12px;color:var(--text-muted);margin-top:4px;${isBH ? '' : 'display:none'}">
              ℹ️ Pay will be calculated at double the standard hourly rate.
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Distance (miles)</label>
              <input type="number" id="sfDist" step="0.1" value="${s.distance_miles ?? 3.6}" tabindex="-1" />
            </div>
            ${s.id ? `
            <div class="form-group">
              <label>Break Taken</label>
              <select id="sfBreakTaken" tabindex="-1">
                <option value="full"    ${s.break_taken === 'full'    || !s.break_taken ? 'selected' : ''}>Full break</option>
                <option value="partial" ${s.break_taken === 'partial' ? 'selected' : ''}>Partial break</option>
                <option value="none"    ${s.break_taken === 'none'    ? 'selected' : ''}>No break</option>
              </select>
            </div>` : '<div class="form-group"><input type="hidden" id="sfBreakTaken" value="full" /></div>'}
          </div>
          <div class="form-group" id="sfPartialGroup" style="display:${s.break_taken === 'partial' ? 'block' : 'none'}">
            <label>Partial Break (minutes taken)</label>
            <input type="number" id="sfPartialMins" min="0" value="${s.break_taken === 'partial' ? s.break_taken_minutes : 15}" tabindex="-1" />
          </div>
        </div>
      </details>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()" tabindex="-1">Cancel</button>
        <button class="btn btn-primary" id="sfSaveBtn">Save Shift</button>
      </div>`;
  },

  wireShiftForm(editId, colleagues = []) {
    // ── Break preset radio group ──────────────────────────────────────────────
    const resolveBreak = () => {
      const preset = document.querySelector('input[name="sfBreakPreset"]:checked')?.value;
      const val = preset === 'custom'
        ? (parseInt(document.getElementById('sfBreakCustom').value, 10) || 0)
        : parseInt(preset, 10);
      document.getElementById('sfBreakSched').value = val;
      return val;
    };

    // Track whether user has manually chosen a break so auto-select doesn't override
    const breakGroup = document.getElementById('sfBreakGroup');
    // For edits, trust the saved DB value — don't auto-override on modal open
    if (editId) breakGroup.dataset.manuallySet = '1';
    const setBreakPreset = (value, manual = false) => {
      if (manual) breakGroup.dataset.manuallySet = '1';
      const radio = document.querySelector(`input[name="sfBreakPreset"][value="${value}"]`);
      if (!radio) return;
      radio.checked = true;
      document.getElementById('sfBreakCustomWrap').style.display = value === 'custom' ? '' : 'none';
      document.querySelectorAll('.break-btn-label').forEach(l => {
        l.classList.toggle('active', l.querySelector('input').checked);
      });
      resolveBreak();
    };

    document.querySelectorAll('input[name="sfBreakPreset"]').forEach(radio => {
      radio.addEventListener('change', () => {
        setBreakPreset(radio.value, true);
        if (radio.value === 'custom') document.getElementById('sfBreakCustom').focus();
        calcPreview();
      });
    });

    document.getElementById('sfBreakCustom')?.addEventListener('input', () => {
      resolveBreak();
      calcPreview();
    });

    // ── Live preview + auto-select break ─────────────────────────────────────
    const calcPreview = () => {
      const start = document.getElementById('sfStart').value;
      const end   = document.getElementById('sfEnd').value;

      if (start && end) {
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        let totalMins = (eh * 60 + em) - (sh * 60 + sm);
        if (totalMins < 0) totalMins += 1440;
        const totalHrs = totalMins / 60;

        // Auto-select break based on shift length and age (only if not manually overridden)
        // Checks user_dob from settings to determine under/over 18 at shift date.
        // Break increases only when the shift EXCEEDS each boundary (strict >):
        // Over 18:  ≤4h30 → 0 | over 4h30–6h → 15 | over 6h–8h → 30 | over 8h → 45
        // Under 18: ≤4h30 → 0 | over 4h30 → 30
        if (!breakGroup.dataset.manuallySet) {
          const dob = (ShiftsView.settings || {}).user_dob || '';
          const shiftDateStr = document.getElementById('sfDate')?.value || '';
          let isUnder18 = false;
          if (dob && shiftDateStr) {
            const dobDate   = new Date(dob + 'T00:00:00');
            const shiftDate = new Date(shiftDateStr + 'T00:00:00');
            let age = shiftDate.getFullYear() - dobDate.getFullYear();
            const mDiff = shiftDate.getMonth() - dobDate.getMonth();
            if (mDiff < 0 || (mDiff === 0 && shiftDate.getDate() < dobDate.getDate())) age--;
            isUnder18 = age < 18;
          }
          // Must match autoBreakMinutes() in db.js, which is canonical: the
          // 4h30 step is inclusive, the 6h and 8h steps are not.
          const T430 = 4 * 60 + 30; // 270 min
          if (isUnder18) {
            setBreakPreset(totalMins >= T430 ? '30' : '0');
          } else if (totalMins > 8 * 60) {
            // over 8h → 45 min unpaid (use custom field)
            setBreakPreset('custom');
            document.getElementById('sfBreakCustom').value = '45';
            resolveBreak();
          } else if (totalMins > 6 * 60) {
            setBreakPreset('30');
          } else if (totalMins >= T430) {
            setBreakPreset('15');
          } else {
            setBreakPreset('0');
          }
        }

        const breakMins = resolveBreak();
        const workedHrs = Math.max(0, (totalMins - breakMins) / 60);
        document.getElementById('sfTotalHrsPreview').textContent = totalHrs.toFixed(2) + 'h';
        document.getElementById('sfHrsPreview').textContent      = workedHrs.toFixed(2) + 'h';
        document.getElementById('sfPayPreview').textContent      = '(saved on submit)';
      }
    };

    // ── Bank holiday auto-detect ──────────────────────────────────────────────
    const updateBHFromDate = async (date) => {
      if (!date) return;
      try {
        const bhSet = await BankHols.forMonth(date.slice(0, 7)).catch(() => new Set());
        const cbEl  = document.getElementById('sfBankHol');
        const hint  = document.getElementById('sfBankHolHint');
        if (!cbEl) return;
        // Always respect manual override — only auto-set if user hasn't touched the checkbox
        if (!cbEl.dataset.manuallySet) {
          cbEl.checked = bhSet.has(date);
          if (hint) hint.style.display = bhSet.has(date) ? '' : 'none';
        }
      } catch (_) { /* ignore */ }
    };

    const sfDateEl = document.getElementById('sfDate');
    if (sfDateEl) {
      sfDateEl.addEventListener('change', e => {
        const cbEl = document.getElementById('sfBankHol');
        if (cbEl) delete cbEl.dataset.manuallySet;
        updateBHFromDate(e.target.value);
      });
      // For new shifts, auto-detect on load. For edits, trust the saved DB value.
      if (sfDateEl.value && !editId) updateBHFromDate(sfDateEl.value);
    }

    const bhCb = document.getElementById('sfBankHol');
    if (bhCb) {
      bhCb.addEventListener('change', e => {
        e.target.dataset.manuallySet = '1';
        const hint = document.getElementById('sfBankHolHint');
        if (hint) hint.style.display = e.target.checked ? '' : 'none';
      });
    }

    document.getElementById('sfBreakTaken')?.addEventListener('change', e => {
      document.getElementById('sfPartialGroup').style.display =
        e.target.value === 'partial' ? 'block' : 'none';
    });

    ['sfStart', 'sfEnd'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', calcPreview);
    });

    // Initial preview on modal open
    calcPreview();

    // Wire save button
    document.getElementById('sfSaveBtn')?.addEventListener('click', () => this.saveShift(editId));
  },

  async saveShift(editId) {
    const date       = document.getElementById('sfDate')?.value?.trim();
    const start_time = document.getElementById('sfStart')?.value?.trim();
    const end_time   = document.getElementById('sfEnd')?.value?.trim();
    if (!date || !start_time || !end_time) {
      showToast('Date, start time and end time are required', 'warning');
      return;
    }

    const break_scheduled_minutes = parseInt(document.getElementById('sfBreakSched')?.value || 30, 10);
    const break_taken        = document.getElementById('sfBreakTaken')?.value || 'full';
    const break_taken_minutes = break_taken === 'partial'
      ? parseInt(document.getElementById('sfPartialMins')?.value || 0, 10)
      : undefined;
    const distMilesRaw    = parseFloat(document.getElementById('sfDist')?.value);
    const distance_miles  = isNaN(distMilesRaw) ? 3.6 : distMilesRaw;
    const notes           = document.getElementById('sfNotes')?.value?.trim() || null;
    const is_bank_holiday = document.getElementById('sfBankHol')?.checked ? 1 : 0;
    const break_locked    = document.getElementById('sfBreakLocked')?.checked ? 1 : 0;
    const absence_type    = document.getElementById('sfAbsence')?.value || null;

    const body = { date, start_time, end_time, break_scheduled_minutes, break_taken,
                   distance_miles, notes, is_bank_holiday, break_locked, absence_type };
    if (break_taken_minutes !== undefined) body.break_taken_minutes = break_taken_minutes;

    try {
      let saved;
      if (editId) {
        saved = await API.put(`/api/shifts/${editId}`, body);
      } else {
        saved = await API.post('/api/shifts', body);
      }

      // Save manually-selected colleague associations
      const checkedCols = [...document.querySelectorAll('.sf-colleague-cb:checked')]
        .map(cb => parseInt(cb.dataset.id, 10));
      if (checkedCols.length) {
        await API.post('/api/shift-colleagues', { shift_id: saved.id, colleague_ids: checkedCols });
      }

      Modal.close();
      showToast(editId ? 'Shift updated' : 'Shift added', 'success');
      if (typeof this._postSaveHook === 'function') {
        await this._postSaveHook();
      } else {
        await this.loadShifts();
      }
    } catch(e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  },

  async deleteShift(id) {
    if (!confirm('Delete this shift?')) return;
    try {
      await API.delete(`/api/shifts/${id}`);
      Modal.close();
      showToast('Shift deleted', 'success');
      if (typeof this._postSaveHook === 'function') {
        await this._postSaveHook();
      } else {
        await this.loadShifts();
      }
    } catch(e) {
      showToast('Failed to delete: ' + e.message, 'error');
    }
  },
};
