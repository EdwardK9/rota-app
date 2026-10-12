/* ─── 😤 Annoying Shifts (V3.0) ────────────────────────────────────────────
   How many of your shifts were the awkward kind: under 3 hours, stranded in the
   middle of the day, short evenings, split days and quick turnarounds.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('annoying-shifts', '😤 Annoying Shifts', {
  year: getCurrentYear(),
  filter: 'all',

  async init() {
    document.getElementById('view-annoying-shifts').innerHTML = V3.loading('Counting the grievances…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.annoyingShifts(this.year);
      this.render();
    } catch (e) {
      document.getElementById('view-annoying-shifts').innerHTML = V3.error(e);
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-annoying-shifts');
    const picker = V3.yearPicker('asYear', this.year, true);
    const wirePicker = () =>
      document.getElementById('asYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });

    if (!d.shift_count) {
      el.innerHTML = picker + V3.empty('😤', 'No shifts for this period', 'Pick another year.');
      wirePicker();
      return;
    }

    const labels = Object.fromEntries(d.categories.map(c => [c.key, `${c.icon} ${c.label}`]));
    if (this.filter !== 'all' && !labels[this.filter]) this.filter = 'all';

    el.innerHTML = `
      ${V3.backButton()}
      ${picker}

      <div class="v3-hero" style="background:linear-gradient(135deg,#F97316,#7F1D1D)">
        <div class="v3-hero-label">ANNOYING SHIFTS</div>
        <div class="v3-hero-value">${d.annoying_total} <span style="font-size:.5em;opacity:.8">of ${d.shift_count}</span></div>
        <div class="v3-hero-sub">
          ${d.annoying_pct}% of your shifts were awkward in at least one way. Each shift is only
          counted once here, even if it ticks several boxes below.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${d.categories.map(c => V3.tile(`${c.icon} ${c.label}`, c.count, `${c.pct}% of shifts`)).join('')}
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>📆 By month</h2></div>
          <div class="card-body">
            ${V3.chart(d.by_month.map(m => ({
              label: V3.shortMonth(m.month), value: m.annoying,
              title: `${m.month}: ${m.annoying} annoying of ${m.shifts} shifts`,
            })), () => 'warning')}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>📅 By day of the week</h2></div>
          <div class="card-body">
            ${V3.chart(d.by_dow.map(x => ({
              label: x.short, value: x.annoying,
              title: `${x.day}: ${x.annoying} annoying of ${x.shifts} shifts`,
            })), () => 'danger')}
          </div>
        </div>
      </div>

      <div class="v3-section-title">🔎 The shifts behind the numbers</div>
      <div class="toolbar">
        <select id="asFilter" style="width:auto">
          <option value="all">All annoying shifts</option>
          ${d.categories.map(c => `<option value="${c.key}" ${this.filter === c.key ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}
        </select>
      </div>
      <div class="card"><div class="card-body" style="padding:0">
        <div class="table-wrapper"><table>
          <thead><tr><th>Date</th><th>Shift</th><th>Paid</th><th>Why</th></tr></thead>
          <tbody id="asRows">${this.rows(labels)}</tbody>
        </table></div>
      </div></div>

      <div class="v3-note">
        ${d.categories.map(c => `<strong>${c.icon} ${esc(c.label)}:</strong> ${esc(c.desc)}`).join('<br>')}
        <br><br>Showing the most recent 40 matching shifts. Hours are paid hours (break deducted).
      </div>
    `;

    wirePicker();
    document.getElementById('asFilter').addEventListener('change', e => {
      this.filter = e.target.value;
      document.getElementById('asRows').innerHTML = this.rows(labels);
    });
  },

  rows(labels) {
    const list = this.data.recent.filter(s => this.filter === 'all' || s.tags.includes(this.filter));
    if (!list.length) return '<tr><td colspan="4" class="v3-muted">None in this period 🎉</td></tr>';
    return list.map(s => `
      <tr>
        <td><span class="shift-date">${fmtDate(s.date)}</span><br><span class="shift-day">${fmtDayShort(s.date)}</span></td>
        <td class="shift-time">${s.start_time}–${s.end_time}</td>
        <td>${s.hours}h</td>
        <td>${s.tags.map(t => `<span class="badge badge-muted">${esc(labels[t])}</span>`).join(' ')}</td>
      </tr>`).join('');
  },
});
