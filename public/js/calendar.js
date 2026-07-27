/* ─── Calendar View ─────────────────────────────────────────────────────────── */

const CalendarView = {
  currentMonth: getCurrentMonth(),
  shifts: [],
  bankHols: new Set(),
  settings: {},
  notes: {}, // date string → note object

  async init(settings) {
    this.settings = settings || {};
    this.render();
    await this.loadShifts();
  },

  render() {
    const el = document.getElementById('view-calendar');
    el.innerHTML = `
      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="calPrevMonth">&#8249;</button>
          <span id="calMonthPicker" class="my-picker">${monthYearPickerHTML(this.currentMonth, 'cal')}</span>
          <button class="btn btn-ghost btn-sm" id="calNextMonth">&#8250;</button>
          <button class="btn btn-ghost btn-sm" id="calToday">Today</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-primary" id="calAddShiftBtn">+ Add Shift</button>
        </div>
      </div>

      <div class="stats-grid" id="calStats"></div>

      <div class="card" style="overflow:hidden">
        <div class="cal-grid" id="calGrid"></div>
      </div>
    `;

    document.getElementById('calMonthPicker').addEventListener('change', () => {
      const v = readMonthYearPicker('cal');
      if (v) { this.currentMonth = v; this.loadShifts(); }
    });
    document.getElementById('calPrevMonth').addEventListener('click', () => this.changeMonth(-1));
    document.getElementById('calNextMonth').addEventListener('click', () => this.changeMonth(1));
    document.getElementById('calToday').addEventListener('click', () => {
      this.currentMonth = getCurrentMonth();
      this._refreshPicker();
      this.loadShifts();
    });
    document.getElementById('calAddShiftBtn').addEventListener('click', () => this.openAdd());
  },

  changeMonth(dir) {
    const [y, m] = this.currentMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    this.currentMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    this._refreshPicker();
    this.loadShifts();
  },

  _refreshPicker() {
    const p = document.getElementById('calMonthPicker');
    if (p) p.innerHTML = monthYearPickerHTML(this.currentMonth, 'cal');
  },

  async loadShifts() {
    try {
      const [y, m] = this.currentMonth.split('-').map(Number);
      const firstDay = `${y}-${String(m).padStart(2,'0')}-01`;
      const lastDayDate = new Date(y, m, 0);
      const lastDay  = `${y}-${String(m).padStart(2,'0')}-${String(lastDayDate.getDate()).padStart(2,'0')}`;

      // Adjacent months for complete cross-month week totals
      const prevMonthStr = m === 1  ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;
      const nextMonthStr = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
      const firstDow = new Date(y, m - 1, 1).getDay();
      const firstIsMonday = firstDow === 1;
      const lastIsSunday  = lastDayDate.getDay() === 0;

      const [shifts, prevShifts, nextShifts, bankHols, notesArr, birthdaysArr, leaveEntries] = await Promise.all([
        API.getShifts({ month: this.currentMonth }),
        !firstIsMonday ? API.getShifts({ month: prevMonthStr }).catch(() => []) : Promise.resolve([]),
        !lastIsSunday  ? API.getShifts({ month: nextMonthStr }).catch(() => []) : Promise.resolve([]),
        BankHols.forMonth(this.currentMonth).catch(() => new Set()),
        API.getCalendarNotes({ month: this.currentMonth }).catch(() => []),
        API.getColleagueBirthdays().catch(() => []),
        API.getLeave({ from: firstDay, to: lastDay }).catch(() => [])
      ]);

      // Helper: get Monday of week for a date string
      const getWeekMon = (dateStr) => {
        const d = new Date(dateStr + 'T00:00:00');
        const dow = d.getDay();
        d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      };
      // Include adjacent shifts only if their week overlaps with current month's weeks
      const mainWeeks = new Set(shifts.map(s => getWeekMon(s.date)));
      const mainDates = new Set(shifts.map(s => s.date));
      const adjShifts = [...prevShifts, ...nextShifts]
        .filter(s => mainWeeks.has(getWeekMon(s.date)) && !mainDates.has(s.date));
      // Store adjacent shifts separately so they don't appear as calendar cells
      this.adjShifts = adjShifts;
      this.shifts   = shifts;
      this.bankHols = bankHols;
      // Build date→note map
      this.notes = {};
      notesArr.forEach(n => { this.notes[n.date] = n; });
      // Build MM-DD → [names] birthday map
      this.birthdays = {};
      birthdaysArr.forEach(b => {
        if (!b.birthday) return;
        const mmdd = b.birthday.slice(5); // MM-DD
        if (mmdd.startsWith(String(m).padStart(2,'0') + '-')) {
          const dateStr = `${y}-${mmdd}`;
          if (!this.birthdays[dateStr]) this.birthdays[dateStr] = [];
          this.birthdays[dateStr].push(b.name.split(' ')[0]);
        }
      });
      // Expand leave entries into individual dates, and distribute each entry's
      // recorded hours_taken (what the Leave section shows) evenly across the days
      // it covers — so the weekly leave total always matches the booked hours.
      this.leaveDates = new Set();
      this.leaveHoursByDate = {};
      for (const le of leaveEntries) {
        const start = new Date(le.start_date + 'T00:00:00');
        const end   = new Date(le.end_date   + 'T00:00:00');
        const numDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
        const totalHrs = le.hours_taken != null ? le.hours_taken : (le.days_taken || 0);
        const perDay = totalHrs / numDays;
        const cur = new Date(start);
        while (cur <= end) {
          const d = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
          if (d >= firstDay && d <= lastDay) {
            this.leaveDates.add(d);
            if (perDay) this.leaveHoursByDate[d] = (this.leaveHoursByDate[d] || 0) + perDay;
          }
          cur.setDate(cur.getDate() + 1);
        }
      }
      this.renderStats();
      this.renderGrid();
    } catch(e) {
      showToast('Failed to load shifts: ' + e.message, 'error');
    }
  },

  renderStats() {
    const completed = this.shifts.filter(s => s.completed);
    const totalHours = completed.reduce((sum, s) => sum + (s.hours_worked || 0), 0);
    const totalPay   = completed.reduce((sum, s) => sum + (s.calculated_pay || 0), 0);
    const totalDist  = completed.reduce((sum, s) => sum + (s.distance_miles || 0), 0);
    const upcoming   = this.shifts.filter(s => !s.completed);
    const noteCount  = Object.keys(this.notes).length;

    document.getElementById('calStats').innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Shifts</div>
        <div class="stat-value">${this.shifts.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value success">${completed.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Upcoming</div>
        <div class="stat-value">${upcoming.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Hours Worked</div>
        <div class="stat-value">${fmtHours(totalHours)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Est. Pay</div>
        <div class="stat-value">${fmtCurrency(totalPay)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Distance</div>
        <div class="stat-value">${fmtMiles(totalDist)}</div>
      </div>
      ${noteCount ? `<div class="stat-card">
        <div class="stat-label">Notes</div>
        <div class="stat-value">${noteCount}</div>
      </div>` : ''}
    `;
  },

  _syncWeekTotalHeights() {
    const grid = document.getElementById('calGrid');
    if (!grid) return;
    const cells  = grid.querySelectorAll('.cal-cell');
    const totals = grid.querySelectorAll('.cal-week-total');
    totals.forEach((bar, wkIdx) => {
      const firstCell = cells[wkIdx * 7];
      if (firstCell) {
        bar.style.height    = firstCell.offsetHeight + 'px';
        bar.style.minHeight = 'unset';
      }
    });
  },

  _bindResizeSync() {
    if (this._resizeSyncBound) return;
    this._resizeSyncBound = true;
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => this._syncWeekTotalHeights(), 150);
    });
  },

  renderGrid() {
    const grid = document.getElementById('calGrid');
    const [y, m] = this.currentMonth.split('-').map(Number);

    // Build a map of date string → shift
    const shiftMap = {};
    this.shifts.forEach(s => { shiftMap[s.date] = s; });

    // Day headers — Monday first
    const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const headerHtml = dayNames.map(d =>
      `<div class="cal-header-cell${d === 'Sat' || d === 'Sun' ? ' cal-weekend-hdr' : ''}">${d}</div>`
    ).join('');

    // First day of month (0=Sun…6=Sat) → shift to Mon-first (0=Mon…6=Sun)
    const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
    const startOffset = (firstDow + 6) % 7;           // Mon-first offset
    const daysInMonth = new Date(y, m, 0).getDate();
    const _today = new Date();
    const today = `${_today.getFullYear()}-${String(_today.getMonth()+1).padStart(2,'0')}-${String(_today.getDate()).padStart(2,'0')}`;

    let cellsHtml = '';

    // Leading empty cells
    for (let i = 0; i < startOffset; i++) {
      cellsHtml += '<div class="cal-cell cal-cell-empty"></div>';
    }

    // Day cells
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const shift   = shiftMap[dateStr];
      const note    = this.notes[dateStr];
      const bdayPeople = (this.birthdays || {})[dateStr] || [];
      const dow     = (startOffset + day - 1) % 7; // 5=Sat,6=Sun
      const isWknd  = dow === 5 || dow === 6;
      const isToday = dateStr === today;

      const isBankHol = this.bankHols.has(dateStr);
      const isLeave   = (this.leaveDates || new Set()).has(dateStr);

      let cellClass = 'cal-cell';
      if (isWknd)        cellClass += ' cal-cell-weekend';
      if (isToday)       cellClass += ' cal-cell-today';
      if (isBankHol)     cellClass += ' cal-cell-bankhol';
      if (isLeave)       cellClass += ' cal-cell-leave';
      if (shift)         cellClass += shift.completed ? ' cal-cell-worked' : ' cal-cell-upcoming';

      let innerHtml = `<div class="cal-day-num${isToday ? ' cal-today-num' : ''}">
        ${day}${isBankHol ? ' <span class="cal-bh-badge" title="Bank Holiday">BH</span>' : ''}
      </div>`;

      if (shift) {
        const payStr   = shift.calculated_pay ? fmtCurrency(shift.calculated_pay) : '';
        const hoursStr = shift.hours_worked    ? fmtHours(shift.hours_worked) : '';
        innerHtml += `
          <div class="cal-shift-block ${shift.completed ? 'cal-shift-done' : 'cal-shift-upcoming'}">
            <div class="cal-shift-times">${shift.start_time} – ${shift.end_time}</div>
            <div class="cal-shift-meta">
              ${hoursStr ? `<span>${hoursStr}</span>` : ''}
              ${payStr   ? `<span class="cal-shift-pay">${payStr}</span>` : ''}
            </div>
          </div>`;
      }

      // Leave block
      if (isLeave) {
        innerHtml += `<div style="background:#10B981;color:#fff;border-radius:5px;padding:4px 6px;font-size:11px;font-weight:600;margin-top:4px;line-height:1.2">🌴 Annual Leave</div>`;
      }

      // Birthday chip
      if (bdayPeople.length) {
        innerHtml += `<div class="cal-note-chip" title="${bdayPeople.join(', ')}" style="background:rgba(236,72,153,0.15);color:#ec4899;border-color:rgba(236,72,153,0.3)">🎂 ${bdayPeople.join(', ')}</div>`;
      }

      // Note chip
      if (note) {
        const preview = note.note.length > 30 ? note.note.slice(0, 30) + '…' : note.note;
        innerHtml += `<div class="cal-note-chip" title="${esc(note.note)}">📝 ${esc(preview)}</div>`;
      }

      cellsHtml += `
        <div class="${cellClass}" data-date="${dateStr}" data-shift-id="${shift ? shift.id : ''}">
          ${innerHtml}
        </div>`;
    }

    // Trailing empty cells to complete the last row
    const totalCells = startOffset + daysInMonth;
    const remainder  = totalCells % 7;
    if (remainder > 0) {
      for (let i = 0; i < 7 - remainder; i++) {
        cellsHtml += '<div class="cal-cell cal-cell-empty"></div>';
      }
    }

    // ── Per-week total hours sidebar ───────────────────────────────────────────
    const weekTotals = {}; // weekIndex → { worked, scheduled }
    // Helper: week index by Monday-of-week matching the grid rows
    const getWkIdx = (dateStr) => {
      const d = new Date(dateStr + 'T00:00:00');
      const dow = d.getDay();
      const monDate = new Date(d);
      monDate.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
      // Find which grid row this Monday falls in
      const monDay = monDate.getFullYear() === y && monDate.getMonth() + 1 === m
        ? monDate.getDate()
        : null;
      // For adjacent-month shifts, find the corresponding in-month day on the same row
      if (monDay !== null) {
        return Math.floor((startOffset + monDay - 1) / 7);
      }
      // Shift is in adjacent month — map via any in-month day of the same week
      const sunDate = new Date(monDate); sunDate.setDate(monDate.getDate() + 6);
      // Find the first day of this week that's in the current month
      for (let i = 0; i < 7; i++) {
        const t = new Date(monDate); t.setDate(monDate.getDate() + i);
        if (t.getFullYear() === y && t.getMonth() + 1 === m) {
          return Math.floor((startOffset + t.getDate() - 1) / 7);
        }
      }
      return -1;
    };

    // Accumulate all shifts including adjacent-month ones for accurate week totals
    [...this.shifts, ...(this.adjShifts || [])].forEach(s => {
      const wkIdx = getWkIdx(s.date);
      if (wkIdx < 0) return;
      if (!weekTotals[wkIdx]) weekTotals[wkIdx] = { worked: 0, scheduled: 0, unusedBreak: 0 };
      const [sh, sm] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);
      let totalMins = (eh * 60 + em) - (sh * 60 + sm);
      if (totalMins < 0) totalMins += 1440;
      // "Scheduled" = paid hours (scheduled break deducted), matching the Shifts tab —
      // not gross time at work. Falls back to gross-minus-break if hours_paid is missing.
      const schedPaid = (s.hours_paid != null)
        ? s.hours_paid
        : Math.max(0, (totalMins - (s.break_scheduled_minutes || 0)) / 60);
      weekTotals[wkIdx].scheduled += schedPaid;
      if (s.completed) {
        // "Worked" = paid hours (scheduled break always deducted) so it matches the
        // scheduled figure for a normally-worked week.
        weekTotals[wkIdx].worked += schedPaid;
        // Break time worked through (scheduled break minus break actually taken) is a
        // separate stat — it's the unused-break time, not extra worked hours.
        const hw = s.hours_worked != null ? s.hours_worked : schedPaid;
        weekTotals[wkIdx].unusedBreak += Math.max(0, hw - schedPaid);
      }
    });
    // Annual-leave hours per week — summed from each leave entry's recorded hours
    // (distributed per day above), so the pink total matches the Leave section.
    const leaveHoursByWeek = {};
    Object.entries(this.leaveHoursByDate || {}).forEach(([ds, hrs]) => {
      const wkIdx = getWkIdx(ds);
      if (wkIdx < 0) return;
      leaveHoursByWeek[wkIdx] = (leaveHoursByWeek[wkIdx] || 0) + hrs;
    });

    const numWeeks = Math.ceil((startOffset + daysInMonth) / 7);
    let weekBarsHtml = '';
    for (let wk = 0; wk < numWeeks; wk++) {
      const wt = weekTotals[wk];
      const leaveHrs = leaveHoursByWeek[wk] || 0;
      if (!wt && leaveHrs <= 0) { weekBarsHtml += '<div class="cal-week-total"></div>'; continue; }
      const workedStr    = wt && wt.worked    > 0 ? fmtHours(wt.worked)    : null;
      const schedStr     = wt && wt.scheduled > 0 ? fmtHours(wt.scheduled) : null;
      const showSched    = schedStr && Math.abs(wt.scheduled - wt.worked) > 0.05;
      const unusedStr    = wt && wt.unusedBreak > 0.01 ? fmtHours(wt.unusedBreak) : null;
      const leaveStr     = leaveHrs > 0 ? fmtHours(leaveHrs) : null;
      weekBarsHtml += `<div class="cal-week-total">
        ${workedStr ? `<span class="cal-wt-chip cal-wt-worked" title="Paid hours worked this week (scheduled break deducted)">${workedStr}</span>` : ''}
        ${showSched ? `<span class="cal-wt-chip cal-wt-sched" title="Scheduled paid hours (incl. upcoming)">${schedStr}</span>` : ''}
        ${unusedStr ? `<span class="cal-wt-chip cal-wt-break" title="Unused break — break time you worked through (paid extra, not counted as worked hours)">🍵 ${unusedStr}</span>` : ''}
        ${leaveStr  ? `<span class="cal-wt-chip cal-wt-leave" title="Annual leave hours this week">🌴 ${leaveStr}</span>` : ''}
      </div>`;
    }

    grid.innerHTML = `
      <div class="cal-day-headers">${headerHtml}</div>
      <div class="cal-cells-wrap">
        <div class="cal-cells">${cellsHtml}</div>
        <div class="cal-week-totals">${weekBarsHtml}</div>
      </div>
    `;

    // Sync week-total bar heights to match actual grid row heights.
    // Re-runs on browser resize so the right-hand totals column stays aligned
    // (cells reflow to new heights when the window width changes).
    requestAnimationFrame(() => this._syncWeekTotalHeights());
    this._bindResizeSync();

    // Click handler — open shift edit, note modal, or choice modal
    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
      cell.addEventListener('click', e => {
        // Ignore clicks on the note chip itself — handle separately below
        if (e.target.closest('.cal-note-chip')) return;
        const shiftId = parseInt(cell.dataset.shiftId, 10);
        const date    = cell.dataset.date;
        const note    = this.notes[date];
        if (shiftId) {
          const shift = this.shifts.find(s => s.id === shiftId);
          if (shift) this.openEdit(shift);
        } else {
          // Empty day — offer choice if there's already a note, otherwise show choice picker
          this.openDayChoice(date, note || null);
        }
      });

      // Note chip click — open note editor
      const chip = cell.querySelector('.cal-note-chip');
      if (chip) {
        chip.addEventListener('click', e => {
          e.stopPropagation();
          const date = cell.dataset.date;
          this.openNoteModal(date, this.notes[date] || null);
        });
      }
    });
  },

  // ─── Day choice modal (empty day) ────────────────────────────────────────────

  openDayChoice(date, existingNote) {
    const noteSection = existingNote
      ? `<div style="margin-bottom:12px;padding:10px;background:var(--bg);border-radius:8px;font-size:13px;">
           <strong>📝 Note:</strong> ${esc(existingNote.note)}
         </div>`
      : '';

    const html = `
      <p style="color:var(--text-muted);margin-bottom:16px">${fmtDate(date)}</p>
      ${noteSection}
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button class="btn btn-primary" id="choiceAddShift">📅 Add Shift</button>
        <button class="btn btn-ghost" id="choiceAddNote">${existingNote ? '✏️ Edit Note' : '📝 Add Note'}</button>
        ${existingNote ? `<button class="btn btn-ghost danger" id="choiceDeleteNote">🗑️ Delete Note</button>` : ''}
      </div>
      <div class="modal-footer" style="margin-top:12px">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
      </div>`;

    Modal.open(existingNote ? 'Day Options' : 'Add to Day', html);

    document.getElementById('choiceAddShift').addEventListener('click', () => {
      Modal.close();
      this.openAdd(date);
    });

    document.getElementById('choiceAddNote').addEventListener('click', () => {
      Modal.close();
      this.openNoteModal(date, existingNote);
    });

    const delBtn = document.getElementById('choiceDeleteNote');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirmAction('Delete this note?')) return;
        try {
          await API.deleteCalendarNote(existingNote.id);
          Modal.close();
          showToast('Note deleted');
          await this.loadShifts();
        } catch(e) { showToast(e.message, 'error'); }
      });
    }
  },

  // ─── Note edit modal ─────────────────────────────────────────────────────────

  openNoteModal(date, existingNote) {
    const html = `
      <p style="color:var(--text-muted);margin-bottom:12px">${fmtDate(date)}</p>
      <div class="form-group">
        <label>Note</label>
        <textarea id="calNoteText" rows="4" placeholder="Enter a note for this day…">${esc(existingNote ? existingNote.note : '')}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="Modal.close()">Cancel</button>
        ${existingNote ? `<button class="btn btn-ghost danger" id="calNoteDeleteBtn">Delete</button>` : ''}
        <button class="btn btn-primary" id="calNoteSaveBtn">Save Note</button>
      </div>`;

    Modal.open(existingNote ? 'Edit Note' : 'Add Note', html);

    document.getElementById('calNoteSaveBtn').addEventListener('click', async () => {
      const text = document.getElementById('calNoteText').value.trim();
      if (!text) { showToast('Note cannot be empty', 'warning'); return; }
      try {
        await API.saveCalendarNote({ date, note: text });
        Modal.close();
        showToast(existingNote ? 'Note updated' : 'Note saved', 'success');
        await this.loadShifts();
      } catch(e) { showToast(e.message, 'error'); }
    });

    const delBtn = document.getElementById('calNoteDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirmAction('Delete this note?')) return;
        try {
          await API.deleteCalendarNote(existingNote.id);
          Modal.close();
          showToast('Note deleted');
          await this.loadShifts();
        } catch(e) { showToast(e.message, 'error'); }
      });
    }
  },

  // ─── Modal helpers ───────────────────────────────────────────────────────────

  openAdd(prefillDate) {
    ShiftsView.settings = this.settings;
    ShiftsView._postSaveHook = async () => { await this.loadShifts(); };
    ShiftsView.openAddModal(prefillDate);
  },

  openEdit(shift) {
    ShiftsView.settings = this.settings;
    ShiftsView._postSaveHook = async () => { await this.loadShifts(); };
    ShiftsView.openEditModal(shift);
  },
};
