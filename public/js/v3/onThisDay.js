/* ─── 📼 On This Day (V3.0) ────────────────────────────────────────────────
   Same date, previous years. A date picker lets you jump anywhere, but it
   opens on today, which is how it'll actually get used.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('on-this-day', '📼 On This Day', {
  date: fmtLocalDate(new Date()),
  matchMode: 'date',

  async init() {
    document.getElementById('view-on-this-day').innerHTML = V3.loading('Rewinding the tape…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.onThisDay(this.date, this.matchMode));
    } catch (e) {
      document.getElementById('view-on-this-day').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-on-this-day');

    const toolbar = `
      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="otdPrev">‹ Day</button>
          <input type="date" id="otdDate" value="${d.date}" style="width:auto" />
          <button class="btn btn-ghost btn-sm" id="otdNext">Day ›</button>
          <button class="btn btn-ghost btn-sm" id="otdToday">Today</button>
        </div>
        <div class="radio-group" id="otdMatch">
          <label class="radio-label" title="The exact same calendar date, whatever day of the week that was">
            <input type="radio" name="otdMatch" value="date" ${d.match_mode === 'date' ? 'checked' : ''}> Same date
          </label>
          <label class="radio-label" title="The nearest date with the same day of the week — closer to how a weekly rota repeats">
            <input type="radio" name="otdMatch" value="weekday" ${d.match_mode === 'weekday' ? 'checked' : ''}> Same weekday
          </label>
        </div>
      </div>`;

    const milestones = d.milestones.length ? `
      <div class="v3-grid" style="margin-bottom:18px">
        ${d.milestones.map(m => `
          <div class="v3-hero" style="background:linear-gradient(135deg,#F59E0B,#92400E);margin-bottom:0;padding:20px">
            <div class="v3-hero-label">${m.icon} ${esc(m.title).toUpperCase()}</div>
            <div class="v3-hero-sub" style="margin-top:6px">${esc(m.detail)}</div>
          </div>`).join('')}
      </div>` : '';

    const todayLine = d.today_shifts.length
      ? `<div class="card" style="margin-bottom:18px">
           <div class="card-header"><h2>📍 ${esc(d.day_name)} ${esc(d.pretty)} — this year</h2></div>
           <div class="card-body" style="padding:0">
             ${d.today_shifts.map(s => `
               <div class="v3-record">
                 <div class="v3-record-icon">${s.completed ? '✅' : '🕓'}</div>
                 <div class="v3-record-body">
                   <div class="v3-record-title">${s.completed ? 'Worked' : 'Scheduled'}</div>
                   <div class="v3-record-value">${s.start_time}–${s.end_time}</div>
                   <div class="v3-muted" style="font-size:12px;margin-top:2px">
                     ${s.crew.length ? '👥 With ' + s.crew.map(esc).join(', ') : '👤 On your own'}
                   </div>
                 </div>
                 <div class="v3-record-meta"><div>${s.hours}h</div><div>${fmtCurrency(s.pay)}</div></div>
               </div>`).join('')}
           </div>
         </div>`
      : '';

    const shiftEchoes = (d.shift_echoes || []).length ? `
      <div class="v3-section-title">🔁 Same shift, other years</div>
      ${d.shift_echoes.map(se => `
        <div class="card" style="margin-bottom:14px">
          <div class="card-header">
            <h2 style="font-size:14px">Today's ${se.shift.start_time}–${se.shift.end_time}
              — ${se.exact_count} exact match${se.exact_count === 1 ? '' : 'es'}${se.near_count ? `, ${se.near_count} within 30 min` : ''}</h2>
          </div>
          <div class="card-body" style="padding:0">
            ${se.echoes.map(e => `
              <div class="v3-record">
                <div class="v3-record-icon">${e.exact ? '🎯' : '🕰️'}</div>
                <div class="v3-record-body">
                  <div class="v3-record-title">${esc(e.day_name)} ${fmtDate(e.date)} · ${e.years_ago} year${e.years_ago === 1 ? '' : 's'} ago</div>
                  <div class="v3-record-value">${e.start_time}–${e.end_time}${e.exact ? '' :
                    ` <span class="v3-muted" style="font-weight:400">(${e.start_diff_mins}m / ${e.end_diff_mins}m off)</span>`}</div>
                </div>
                <div class="v3-record-meta"><div>${e.hours}h</div><div>${fmtCurrency(e.pay)}</div></div>
              </div>`).join('')}
          </div>
        </div>`).join('')}` : '';

    const flashbacks = d.flashbacks.length ? `
      <div class="v3-grid v3-grid-lg">
        ${d.flashbacks.map(f => `
          <div class="card">
            <div class="card-header">
              <h2>${f.years_ago} year${f.years_ago === 1 ? '' : 's'} ago — ${esc(f.day_name)} ${fmtDate(f.date)}</h2>
            </div>
            <div class="card-body">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
                <div style="font-size:20px;font-weight:700">${f.start_time}–${f.end_time}</div>
                <div style="text-align:right">
                  <div style="font-weight:700;color:var(--success)">${fmtCurrency(f.pay)}</div>
                  <div class="v3-muted">${f.hours}h${f.rate ? ` at ${fmtCurrency(f.rate)}/hr` : ''}</div>
                </div>
              </div>

              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
                ${f.is_bank_holiday ? '<span class="badge badge-warning">Bank holiday</span>' : ''}
                ${f.completed ? '<span class="badge badge-success">Completed</span>' : '<span class="badge badge-muted">Not completed</span>'}
                ${f.break_taken ? `<span class="break-chip break-${esc(f.break_taken)}">Break: ${esc(f.break_taken)}</span>` : ''}
                ${f.miles ? `<span class="badge badge-info">${fmtMiles(f.miles)} each way</span>` : ''}
              </div>

              ${f.clocked && f.clocked.in ? `
                <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px">
                  🕐 Clocked in ${f.clocked.in}${f.clocked.out ? `, out ${f.clocked.out}` : ''}
                </div>` : ''}

              ${f.crew.length ? `
                <div style="font-size:13px;margin-bottom:8px">
                  <span class="v3-muted">👥 Working with:</span> ${f.crew.map(esc).join(', ')}
                </div>`
                : '<div class="v3-muted" style="margin-bottom:8px">👤 On your own that day</div>'}

              ${f.note ? `<div class="v3-note">📝 ${esc(f.note)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`
      : V3.empty('📼', 'Nothing on this date in previous years',
          'Once you have a year or two of history, this fills up.');

    const pastLeave = d.past_leave.length ? `
      <div class="v3-section-title">🏖️ You were on leave</div>
      <div class="card"><div class="card-body" style="padding:0">
        ${d.past_leave.map(l => `
          <div class="v3-record">
            <div class="v3-record-icon">🏖️</div>
            <div class="v3-record-body">
              <div class="v3-record-title">${l.years_ago} year${l.years_ago === 1 ? '' : 's'} ago</div>
              <div class="v3-record-value">${esc(l.leave_type)} leave</div>
            </div>
            <div class="v3-record-meta">
              <div>${fmtDate(l.start_date)} → ${fmtDate(l.end_date)}</div>
              <div>${l.days_taken} days</div>
            </div>
          </div>`).join('')}
      </div></div>` : '';

    const summary = d.summary.years_with_data ? `
      <div class="v3-note">
        Across ${d.summary.years_with_data} previous year${d.summary.years_with_data === 1 ? '' : 's'},
        this date has cost you ${d.summary.total_hours} hours and earned you ${fmtCurrency(d.summary.total_pay)}.
      </div>` : '';

    el.innerHTML = V3.backButton() + toolbar + milestones + todayLine + shiftEchoes + flashbacks + pastLeave + summary;

    const go = date => { this.date = date; this.load(); };
    document.getElementById('otdDate').addEventListener('change', e => go(e.target.value));
    document.getElementById('otdPrev').addEventListener('click', () => go(this._shift(-1)));
    document.getElementById('otdNext').addEventListener('click', () => go(this._shift(1)));
    document.getElementById('otdToday').addEventListener('click', () => go(fmtLocalDate(new Date())));

    el.querySelectorAll('input[name="otdMatch"]').forEach(input => {
      input.addEventListener('change', e => {
        this.matchMode = e.target.value;
        document.getElementById('view-on-this-day').innerHTML = V3.loading();
        this.load();
      });
    });
  },

  _shift(days) {
    const [y, m, d] = this.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return fmtLocalDate(dt);
  },
});
