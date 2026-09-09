/* ─── 🔁 Check Habits (V5.0) ───────────────────────────────────────────────
   Your rota-checking behaviour measured against the real rota: how far ahead
   you look, whether you check the night before, whether you look on days off,
   and whether checking on the morning actually changes when you clock in.
   ───────────────────────────────────────────────────────────────────────── */

V5.register('v5-habits', '🔁 Check Habits', {
  data: null,

  async init() {
    const el = document.getElementById('view-v5-habits');
    el.innerHTML = V5.loading('Comparing your checking against your rota…');
    try {
      this.data = await V5.api.habits(V5.days);
      this.render();
    } catch (e) {
      el.innerHTML = V5.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-v5-habits');
    const t = d.totals;

    if (!t.checks) {
      el.innerHTML = `${V5.backButton()}${V5.daysPicker('v5HabitsDays', V5.days)}
        ${V5.empty('🔁', 'No rota checks recorded in this period',
                   'This counts visits to the Dashboard, Shifts, Calendar, Clock and team views.')}`;
      this._wire();
      return;
    }

    const c = d.coverage;
    const pun = d.punctuality;
    const cmp = pun.after_checking && pun.without_checking
      ? pun.after_checking.median_mins - pun.without_checking.median_mins
      : null;

    el.innerHTML = `
      ${V5.backButton()}
      ${V5.daysPicker('v5HabitsDays', V5.days)}

      <div class="v3-hero" style="background:linear-gradient(135deg,#F59E0B,#92400E)">
        <div class="v3-hero-label">YOUR CHECKING HABIT</div>
        <div class="v3-hero-value" style="font-size:30px">${esc(d.habit.label)}</div>
        <div class="v3-hero-sub">
          ${t.checks} rota check${t.checks === 1 ? '' : 's'} over ${t.days_in_window} days
          (${t.checks_per_day} a day), typically looking
          ${d.habit.median_lead_days != null ? `<strong>${d.habit.median_lead_days} day${d.habit.median_lead_days === 1 ? '' : 's'}</strong> ahead` : 'ahead'}.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm">
        ${V5.tile('Checks a day', t.checks_per_day, `on ${t.check_day_pct}% of days`)}
        ${V5.tile('Looking ahead', d.habit.median_lead_days != null ? `${d.habit.median_lead_days}<span class="v5-of"> d</span>` : '—',
                  'median gap to your next shift')}
        ${V5.tile('Night-before checks', V5.pct(c.checked_day_before_pct),
                  `${c.checked_day_before} of ${c.shifts} shifts`, V5.pctClass(c.checked_day_before_pct))}
        ${V5.tile('Morning-of checks', V5.pct(c.checked_morning_of_pct),
                  `${c.checked_morning_of} of ${c.shifts} shifts`, V5.pctClass(c.checked_morning_of_pct))}
        ${V5.tile('Walked in blind', c.unchecked,
                  `${c.unchecked_pct}% of shifts, no check in the week before`, V5.pctClass(c.unchecked_pct, true))}
        ${V5.tile('Run-up checks', d.habit.avg_checks_in_run_up, 'days checked in the 7 before a shift')}
      </div>

      <div class="v3-section-title">🔭 How far ahead you look</div>
      <div class="card"><div class="card-body">
        ${V5.ranked(d.lead_time.buckets.map(b => ({
          label: b.label, value: b.count, display: `${b.count} (${b.pct}%)`,
        })))}
        <p class="v3-note">Every rota check measured against the next shift on the rota at the time.
        Checks with no shift ahead of them are left out rather than counted as looking infinitely far.</p>
      </div></div>

      <div class="v3-grid v3-grid-lg">
        <div class="card"><div class="card-header"><h2>🛌 Days off</h2></div><div class="card-body">
          <div class="v3-grid v3-grid-sm">
            ${V5.tile('On work days', V5.pct(d.days_off.work_day_check_pct),
                      `${d.days_off.checked_work_days} of ${d.days_off.work_days} days`)}
            ${V5.tile('On days off', V5.pct(d.days_off.off_day_check_pct),
                      `${d.days_off.checked_off_days} of ${d.days_off.off_days} days`)}
          </div>
          <p class="v3-note">
            ${d.days_off.off_day_check_pct > d.days_off.work_day_check_pct
              ? 'You check more on your days off than on the days you work — planning, rather than reacting.'
              : 'You check mostly on the days you are actually working.'}
          </p>
        </div></div>

        <div class="card"><div class="card-header"><h2>⏰ Does checking change anything?</h2></div><div class="card-body">
          ${pun.after_checking && pun.without_checking ? `
            <div class="v3-grid v3-grid-sm">
              ${V5.tile('Checked that morning',
                        `${pun.after_checking.median_mins > 0 ? '+' : ''}${pun.after_checking.median_mins}<span class="v5-of"> min</span>`,
                        `${pun.after_checking.shifts} shifts · ${pun.after_checking.early_pct}% on time or early`)}
              ${V5.tile('Did not check',
                        `${pun.without_checking.median_mins > 0 ? '+' : ''}${pun.without_checking.median_mins}<span class="v5-of"> min</span>`,
                        `${pun.without_checking.shifts} shifts · ${pun.without_checking.early_pct}% on time or early`)}
            </div>
            <p class="v3-note">
              Median clock-in relative to your scheduled start; negative is early.
              ${cmp != null && Math.abs(cmp) >= 2
                ? `On mornings you checked you clocked in about <strong>${Math.abs(cmp)} minutes ${cmp < 0 ? 'earlier' : 'later'}</strong>.`
                : 'Barely any difference between the two.'}
              Correlation, not cause — a morning you check is often a morning you were already up early.
            </p>` : `<p class="v3-muted">Not enough clocked shifts in this period to compare.</p>`}
        </div></div>
      </div>

      <div class="v3-section-title">🕐 When you check</div>
      <div class="card"><div class="card-body">
        ${V5.chart(d.by_hour.map(h => ({
          label: h.hour % 3 === 0 ? String(h.hour) : '', value: h.checks,
          title: `${h.label} — ${h.checks} check${h.checks === 1 ? '' : 's'} (${h.on_shift_day} on a shift day)`,
        })))}
      </div></div>

      <div class="v3-section-title">📅 Which day of the week</div>
      <div class="card"><div class="card-body">
        ${V5.ranked(d.by_dow.map(x => ({ label: x.day, value: x.checks, display: String(x.checks) })))}
      </div></div>

      <div class="v3-section-title">🗓️ Shift by shift</div>
      <div class="card"><div class="card-body">
        <div class="table-wrapper"><table>
          <thead><tr><th>Shift</th><th>Time</th><th>Night before</th><th>Morning of</th><th>Lead</th><th>Run-up</th><th>Clocked in</th></tr></thead>
          <tbody>${d.recent_shifts.map(s => `
            <tr>
              <td>${esc(s.dow)} ${esc(fmtDayMonth(s.date))}</td>
              <td>${esc(s.start_time)}–${esc(s.end_time)}</td>
              <td>${s.checked_day_before ? '<span class="v5-good">✓</span>' : '<span class="v3-muted">—</span>'}</td>
              <td>${s.checked_morning_of ? `<span class="v5-good">✓ ${esc(s.first_morning_check)}</span>` : '<span class="v3-muted">—</span>'}</td>
              <td>${s.lead_mins != null ? `${s.lead_mins} min` : '<span class="v3-muted">—</span>'}</td>
              <td>${s.checks_in_run_up}</td>
              <td>${esc(s.clocked_in || '—')}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        <p class="v3-note">"Lead" is how long before your start time you first opened the app that morning.</p>
      </div></div>
    `;

    this._wire();
  },

  _wire() {
    document.getElementById('v5HabitsDays')?.addEventListener('change', e => {
      V5.days = e.target.value;
      this.init();
    });
  },
});
