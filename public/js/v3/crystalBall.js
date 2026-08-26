/* ─── 🔮 Rota Crystal Ball (V3.0) ──────────────────────────────────────────
   A projected week for dates the published rota hasn't reached. Every figure is
   shown with the confidence behind it, and the view leads with how often the
   model has actually been right — an unmarked guess would be worse than no
   guess at all.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('crystal-ball', '🔮 Rota Crystal Ball', {
  week: null,
  data: null,

  async init() {
    document.getElementById('view-crystal-ball').innerHTML = V3.loading('Consulting two years of rota…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.crystalBall(this.week);
      this.week = this.data.week ? this.data.week.start : null;
      this.render();
    } catch (e) {
      document.getElementById('view-crystal-ball').innerHTML = V3.error(e);
    }
  },

  shiftWeek(delta) {
    const [y, m, d] = this.week.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta * 7);
    this.week = fmtLocalDate(dt);
    this.load();
  },

  shortDate(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${d} ${MONTHS_SHORT[m - 1]}`;
  },

  HALF: { morning: 'A morning', afternoon: 'An afternoon', mixed: 'Could be either half' },

  /** One day of the projected week. The shape of the day (on or off, morning or
   *  afternoon) is the part the model is actually good at, so it leads; the
   *  exact times follow as a hint, because they're the part it gets wrong most. */
  day(d, published) {
    const on = d.predicted_working;
    const cls = on ? 'warning' : 'success';
    const verdict = published
      ? (d.actual ? `Actually ${d.actual.start_time}–${d.actual.end_time}` : 'Actually off')
      : (on ? (this.HALF[d.half] || 'Probably on') : 'Probably off');

    return `<div class="card">
      <div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div>
            <strong>${esc(d.day)}</strong>
            <span class="v3-muted">${esc(this.shortDate(d.date))}</span>
          </div>
          ${d.is_bank_holiday ? '<span class="badge badge-info">Bank hol</span>' : ''}
          ${published && d.hit != null
            ? (d.hit ? '<span class="badge badge-success">✓ called it</span>'
                     : '<span class="badge badge-danger">✗ missed</span>')
            : ''}
        </div>

        <div class="v3-tile-value" style="margin-top:8px">${d.probability}%</div>
        <div class="v3-tile-sub">
          chance of a shift · ${d.worked} of the last ${d.sample} ${esc(d.day)}s${
            d.worked_last_week != null ? `, ${d.worked_last_week ? 'and you were on last week' : 'and you were off last week'}` : ''}
        </div>
        ${V3.bar(d.probability, cls)}

        <div style="margin-top:10px;font-size:13px">${esc(verdict)}</div>
        ${on && d.likely_start
          ? `<div class="v3-tile-sub">Usually ${esc(d.likely_start)}–${esc(d.likely_end)}${
              d.likely_hours != null ? `, about ${d.likely_hours}h` : ''}</div>` : ''}

        ${(d.base_probability >= 50) !== on && d.worked_last_week != null ? `
          <div class="v3-chips">
            <span class="v3-chip plain">
              ${d.base_probability}% on the usual pattern — ${on ? 'nudged on' : 'nudged off'}
              because you were ${d.worked_last_week ? 'on' : 'off'} last week
            </span>
          </div>` : ''}

        ${on && d.alternatives.length ? `
          <div class="v3-chips">
            ${d.alternatives.map(a =>
              `<span class="v3-chip plain">or ${esc(a.start_time)}–${esc(a.end_time)} ×${a.count}</span>`).join('')}
          </div>` : ''}
      </div>
    </div>`;
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-crystal-ball');

    if (!d.enough_history) {
      el.innerHTML = V3.backButton() + V3.empty('🔮', 'Not enough history yet',
        `A pattern needs something to work from — there are ${d.shift_count} shifts logged so far, and this wants at least 20.`);
      return;
    }

    const w = d.week, sum = d.week_summary, acc = d.accuracy;
    const contract = sum.contracted_hours;

    el.innerHTML = `
      ${V3.backButton()}

      <div class="toolbar">
        <div class="month-nav">
          <button class="btn btn-ghost btn-sm" id="cbPrev">←</button>
          <strong style="padding:0 8px">
            Week of ${esc(this.shortDate(w.start))} – ${esc(this.shortDate(w.end))}
          </strong>
          <button class="btn btn-ghost btn-sm" id="cbNext">→</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="cbJump">Jump to first unpublished week</button>
      </div>

      <div class="v3-hero" style="background:${d.published
        ? 'linear-gradient(135deg,#64748B,#1E293B)'
        : 'linear-gradient(135deg,#8B5CF6,#4C1D95)'}">
        <div class="v3-hero-label">${d.published ? 'PUBLISHED WEEK — SCORED AGAINST THE PREDICTION' : 'PROJECTED WEEK'}</div>
        <div class="v3-hero-value">${sum.expected_hours}h</div>
        <div class="v3-hero-sub">
          across about <strong>${sum.expected_days}</strong> days${sum.expected_pay ? `, worth roughly <strong>${fmtCurrency(sum.expected_pay)}</strong>` : ''}.
          ${contract ? `Your contract is ${contract}h, so this is
            ${sum.vs_contract > 0 ? `${sum.vs_contract}h above it` : sum.vs_contract < 0 ? `${Math.abs(sum.vs_contract)}h below it` : 'right on it'}.` : ''}
          ${d.published
            ? `This week is already on the rota: ${sum.actual_days} shifts, ${sum.actual_hours}h — ${sum.hits} of 7 days called correctly.`
            : `The rota only runs to ${esc(this.shortDate(d.rota_horizon))}, so none of this is confirmed.`}
        </div>
      </div>

      ${acc ? `
        <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
          ${V3.tile('On or off', acc.day_accuracy_pct + '%',
                    `Backtested on ${acc.days_tested} real days`,
                    acc.beats_baseline ? 'success' : 'danger')}
          ${V3.tile('Beats guessing by', (acc.day_accuracy_pct - acc.baseline_pct) + ' pts',
                    `${acc.baseline_pct}% is what saying "working" every day scores`,
                    acc.beats_baseline ? 'success' : 'danger')}
          ${V3.tile('Morning or afternoon', acc.morning_afternoon_pct == null ? '—' : acc.morning_afternoon_pct + '%',
                    `Right half of the day, on ${acc.start_time_sample} shifts`)}
          ${V3.tile('Exact start time', acc.start_time_accuracy_pct == null ? '—' : acc.start_time_accuracy_pct + '%',
                    'Within an hour — the weakest part, treat times as a hint',
                    'danger')}
        </div>
        ${!acc.beats_baseline ? `
          <div class="v3-note">
            Right now this model is no better than assuming you're working every day
            (${acc.baseline_pct}%). Your rota has been unusually changeable — take the whole
            page with a pinch of salt until it settles.
          </div>` : ''}` : ''}

      <div class="v3-section-title">📆 ${d.published ? 'Prediction vs what was published' : 'The week as predicted'}</div>
      <div class="v3-grid v3-grid-sm">
        ${d.days.map(day => this.day(day, d.published)).join('')}
      </div>

      <div class="v3-grid v3-grid-lg" style="margin-top:20px">
        <div class="card">
          <div class="card-header"><h2>📊 Your weekday pattern</h2></div>
          <div class="card-body">
            ${V3.chart(d.model.weekday.map(m => ({
              label: m.short,
              value: m.probability,
              title: `${m.day}: ${m.probability}% (${m.worked} of ${m.sample}), usually from ${m.likely_start || '—'}`,
            })), m => (m.value >= 50 ? 'warning' : 'success'))}
            <div class="v3-note">
              Built from the last ${d.model.prob_window_weeks} weeks only, with the most recent half
              counting double — longer windows measurably did worse, because an old pattern is a
              different pattern rather than more evidence for this one. That is then pulled
              ${Math.round(d.model.persistence_weight * 100)}% of the way towards whatever you
              actually worked in the week of ${esc(this.shortDate(d.model.last_week || d.rota_horizon))}.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>🕐 Usual times, by day</h2></div>
          <div class="card-body" style="padding:0">
            <div class="table-wrapper"><table>
              <thead><tr><th>Day</th><th>Chance</th><th>Usual start</th><th>Typical</th></tr></thead>
              <tbody>${d.model.weekday.map(m => `
                <tr>
                  <td>${esc(m.day)}</td>
                  <td>${m.probability}%</td>
                  <td class="shift-time">${esc(m.likely_start || '—')}</td>
                  <td>${m.avg_hours != null ? m.avg_hours + 'h' : '—'}</td>
                </tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>
      </div>

      <div class="v3-note">
        This is a pattern, not a rota. It can't know about a holiday somebody else booked, a quiet
        January or a week you asked to change — it only knows what you have usually done. Treat a
        high percentage as "expect it", anything near 50% as a genuine unknown, and the times as
        the roughest part of all: it gets the right half of the day about
        ${acc && acc.morning_afternoon_pct != null ? acc.morning_afternoon_pct + '%' : 'half'} of the
        time and the exact start far less often than that.
      </div>
    `;

    document.getElementById('cbPrev').addEventListener('click', () => this.shiftWeek(-1));
    document.getElementById('cbNext').addEventListener('click', () => this.shiftWeek(1));
    document.getElementById('cbJump').addEventListener('click', () => {
      this.week = d.next_unpublished_week;
      this.load();
    });
  },
});
