/* ─── ⏰ Overtime Tracker (V3.0) ───────────────────────────────────────────
   Hours beyond contract, week by week, and what share of your pay they are.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('overtime', '⏰ Overtime Tracker', {
  year: getCurrentYear(),

  async init() {
    document.getElementById('view-overtime').innerHTML = V3.loading('Counting the extra hours…');
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.overtime(this.year));
    } catch (e) {
      document.getElementById('view-overtime').innerHTML = V3.error(e);
    }
  },

  render(d) {
    const el = document.getElementById('view-overtime');
    const picker = V3.yearPicker('otYear', this.year, true);

    if (!d.totals || !d.totals.weeks_counted) {
      el.innerHTML = picker + V3.empty('⏰', 'No complete weeks in this period',
        'Pick another year, or come back once a full week has passed.');
      document.getElementById('otYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
      return;
    }

    const t = d.totals;

    el.innerHTML = `
      ${V3.backButton()}
      ${picker}

      <div class="v3-hero" style="background:linear-gradient(135deg,#10B981,#065F46)">
        <div class="v3-hero-label">EXTRA HOURS WORKED</div>
        <div class="v3-hero-value">+${t.extra_hours}h</div>
        <div class="v3-hero-sub">
          beyond your contract, across ${t.weeks_over} week${t.weeks_over === 1 ? '' : 's'} —
          worth <strong>${fmtCurrency(t.extra_value)}</strong>, or ${t.extra_share_pct}% of everything you earned.
          ${t.extra_as_shifts ? ` That is roughly ${t.extra_as_shifts} extra shifts.` : ''}
        </div>
        <div class="v3-hero-bar"><span style="width:${t.over_pct}%"></span></div>
        <div class="v3-hero-sub" style="margin-top:8px">
          You went over contract in ${t.over_pct}% of judged weeks (${t.weeks_over} of ${t.weeks_counted}).
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Extra hours', '+' + t.extra_hours + 'h', `${t.weeks_over} weeks over`, 'success')}
        ${V3.tile('Short hours', t.short_hours > 0 ? '−' + t.short_hours + 'h' : '0h',
          `${t.weeks_under} weeks under`, t.short_hours > 0 ? 'danger' : '')}
        ${V3.tile('Net', (t.net_hours >= 0 ? '+' : '') + t.net_hours + 'h', 'The two cancelled out')}
        ${V3.tile('Average week', t.avg_week + 'h', `contracted ${t.avg_contracted}h`)}
      </div>

      ${t.weeks_on_leave || t.weeks_with_some_leave ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-body" style="display:flex;align-items:center;gap:12px">
            <div style="font-size:24px">🏖️</div>
            <div class="v3-muted" style="font-size:13px">
              Booked leave lowers the target for that week, so a holiday doesn't count against you.
              ${t.weeks_on_leave ? `<strong>${t.weeks_on_leave}</strong> week${t.weeks_on_leave === 1 ? ' was' : 's were'} full leave and are left out entirely` : ''}${t.weeks_on_leave && t.weeks_with_some_leave ? '; ' : ''}${t.weeks_with_some_leave ? `<strong>${t.weeks_with_some_leave}</strong> had part of the week booked off` : ''}.
            </div>
          </div>
        </div>` : ''}

      <div class="card" style="margin-bottom:18px">
        <div class="card-header"><h2>📊 Hours over contract, by month</h2></div>
        <div class="card-body">
          ${V3.chart(d.by_month.map(m => ({
            label: V3.shortMonth(m.month),
            value: Math.abs(m.extra),
            title: `${m.month}: ${m.extra > 0 ? '+' : ''}${m.extra}h vs contract (${m.hours}h worked, ${m.contracted}h contracted)`,
            over: m.extra >= 0,
          })), pt => (pt.over ? 'success' : 'danger'))}
          <div class="v3-note">
            Green months went over contract, red fell short. Bar height is the size of the gap
            either way, so a tall red bar is a quiet month, not a busy one.
          </div>
        </div>
      </div>

      ${d.biggest_week ? `
        <div class="card" style="margin-bottom:18px">
          <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
            <div>
              <strong>🏆 Your biggest week over contract</strong>
              <div class="v3-muted" style="margin-top:4px">
                Week of ${fmtDate(d.biggest_week.week)} — ${d.biggest_week.hours}h against a
                ${d.biggest_week.contracted}h contract, across ${d.biggest_week.shifts} shifts.
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:26px;font-weight:800;color:var(--success)">+${d.biggest_week.extra}h</div>
              <div class="v3-muted">${fmtCurrency(d.biggest_week.extra_value)} extra</div>
            </div>
          </div>
        </div>` : ''}

      <div class="card">
        <div class="card-header"><h2>📅 Week by week</h2></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrapper">
            <table>
              <thead><tr><th>Week</th><th>Shifts</th><th>Hours</th><th>Target</th><th>Difference</th><th>Extra worth</th></tr></thead>
              <tbody>
                ${d.weeks.slice().reverse().slice(0, 60).map(w => {
                  const skipped = w.partial || w.full_leave;
                  return `
                  <tr${skipped ? ' style="opacity:0.55"' : ''}>
                    <td>
                      <span class="shift-date">${fmtDate(w.week)}</span>
                      ${w.partial ? '<br><span class="shift-day">in progress</span>'
                        : w.full_leave ? '<br><span class="shift-day">🏖️ on leave</span>' : ''}
                    </td>
                    <td>${w.shifts}</td>
                    <td>${w.hours}h</td>
                    <td>
                      ${w.target}h
                      ${w.leave_hours > 0 && !w.full_leave
                        ? `<br><span class="shift-day">${w.contracted}h − ${w.leave_hours}h leave</span>` : ''}
                    </td>
                    <td class="${skipped ? '' : w.extra > 0 ? 'diff-pos' : w.extra < 0 ? 'diff-neg' : ''}">
                      ${skipped ? '—' : `${w.extra > 0 ? '+' : ''}${w.extra}h`}
                    </td>
                    <td>${!skipped && w.extra > 0 ? fmtCurrency(w.extra_value) : '—'}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="v3-note">
        The headline is the extra hours themselves, not extra minus short. Netting them off would
        read as "you barely went over" when you might have worked ${t.extra_hours}h extra
        <em>and</em> taken a holiday — two separate facts that shouldn't cancel each other out.
        The net is in the tiles above if you want it.
        <br><br>
        <strong>Leave hours count towards your contract for that week</strong> — a day's holiday is
        a day you were paid for, not a day you came up short. That is shown here by taking the leave
        off the <strong>target</strong> rather than adding it to your hours, which comes to the same
        thing and behaves properly when a week's leave (5 × ${d.hours_per_day || 7.4}h) is worth more
        than a ${t.avg_contracted}h contract. Weeks entirely covered by leave, and the current
        part-worked week, are greyed out and left out of every total.
        <br><br>
        Only leave <em>booked in the app</em> can be allowed for. A genuinely quiet week with no
        leave entry against it will still show as short.
        <br><br>
        Additional hours are paid at your normal rate rather than a premium, so this tracks
        <em>how much of your pay depends on shifts you were never contracted to do</em> rather than
        overtime uplift.
      </div>
    `;

    document.getElementById('otYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
  },
});
