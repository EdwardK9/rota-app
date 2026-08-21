/* ─── 🧬 Shift DNA (V3.0) ──────────────────────────────────────────────────
   Your rota as a personality profile: an archetype, six scored traits, and the
   supporting patterns (day spread, signature start times, hours on the clock).
   ───────────────────────────────────────────────────────────────────────── */

V3.register('shift-dna', '🧬 Shift DNA', {
  year: getCurrentYear(),
  person: 'me',
  people: null,

  async init() {
    document.getElementById('view-shift-dna').innerHTML = V3.loading('Sequencing the rota…');
    try {
      this.people = (await V3.api.dnaPeople()).people;
    } catch (_) {
      this.people = [{ id: 'me', name: 'You' }];   // colleague list is a bonus, not a blocker
    }
    await this.load();
  },

  async load() {
    try {
      this.render(await V3.api.shiftDna(this.year, this.person));
    } catch (e) {
      document.getElementById('view-shift-dna').innerHTML = V3.error(e);
    }
  },

  _toolbar() {
    const years = getYears();
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Person:</label>
        <select id="dnaPerson" style="width:auto">
          ${(this.people || []).map(p => `
            <option value="${esc(p.id)}" ${p.id === this.person ? 'selected' : ''}>
              ${esc(p.name)}${p.left ? ' (left)' : ''}${p.shift_count ? ` — ${p.shift_count} shifts` : ''}
            </option>`).join('')}
        </select>
      </div>
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Year:</label>
        <select id="dnaYear" style="width:auto">
          <option value="all" ${this.year === 'all' ? 'selected' : ''}>All time</option>
          ${years.map(y => `<option value="${y}" ${String(y) === String(this.year) ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  _wire() {
    const y = document.getElementById('dnaYear');
    if (y) y.addEventListener('change', e => { this.year = e.target.value; this.load(); });
    const p = document.getElementById('dnaPerson');
    if (p) p.addEventListener('change', e => { this.person = e.target.value; this.load(); });
  },

  render(d) {
    const el = document.getElementById('view-shift-dna');
    const picker = this._toolbar();

    if (!d.shift_count) {
      el.innerHTML = picker + V3.empty('🧬', 'No shifts for this period',
        'Pick another year or another person.');
      this._wire();
      return;
    }

    const a = d.archetype;
    const p = d.patterns;
    const maxHour = Math.max(...p.hour_histogram.map(x => x.count), 1);

    el.innerHTML = `
      ${picker}

      <div class="v3-hero" style="background:linear-gradient(135deg,#EC4899,#831843)">
        <div class="v3-hero-label">
          ${d.person === 'me' || !d.person_name
            ? 'SHIFT ARCHETYPE'
            : esc(String(d.person_name).toUpperCase()) + "'S SHIFT ARCHETYPE"}
          · ${d.shift_count} SHIFTS
        </div>
        <div class="v3-hero-value">${a.icon} ${esc(a.name)}</div>
        <div class="v3-hero-sub">
          ${esc(a.blurb)}
          ${a.based_on.length ? `<br><br>Based on the strongest traits: ${a.based_on.map(esc).join(' + ')}.` : ''}
        </div>
      </div>

      ${d.hours_basis === 'rostered' ? `
        <div class="v3-note" style="margin-bottom:16px">
          ℹ️ Colleague shifts don't carry break information, so hours here are the full rostered
          span. Your own profile uses paid hours (break deducted), which makes Endurance read
          slightly higher for colleagues than a like-for-like comparison would.
        </div>` : ''}

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>🧬 Trait profile</h2></div>
          <div class="card-body">
            ${d.traits.map(t => `
              <div class="v3-trait" title="${esc(t.desc)}">
                <div class="v3-trait-head">
                  <span>${t.icon} ${esc(t.label)}</span>
                  <span class="v3-trait-score">${t.score}</span>
                </div>
                ${V3.bar(t.score, t.score >= 70 ? 'success' : t.score >= 40 ? '' : 'info')}
              </div>`).join('')}
            <div class="v3-note">
              Every trait is a plain measurement of that person's own shifts, not a judgement —
              high "Variety" just means start times move around, which is usually the rota's
              doing rather than a choice.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>📊 The pattern behind it</h2></div>
          <div class="card-body">
            <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
              ${V3.tile('Average start', p.avg_start)}
              ${V3.tile('Average length', p.avg_length_hours + 'h')}
              ${V3.tile('Start spread', '±' + p.start_spread_mins + ' min')}
              ${V3.tile('Colleagues/shift', p.avg_colleagues)}
            </div>

            <div class="v3-section-title" style="margin-top:0">📅 Shifts by day</div>
            ${V3.chart(p.by_dow.map(x => ({ label: x.short, value: x.count, title: `${x.day}: ${x.count} shifts` })))}

            <div class="v3-section-title">🕐 Hours usually on the clock</div>
            <div class="v3-hours">
              ${p.hour_histogram.map(h => `
                <div class="v3-hour-col" title="${h.hour}:00 — on shift ${h.count} time${h.count === 1 ? '' : 's'}">
                  <div class="v3-hour-bar" style="height:${(h.count / maxHour) * 100}%"></div>
                </div>`).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:4px">
              <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
            </div>

            <div class="v3-section-title">🔂 Signature start times</div>
            ${p.top_start_times.map(t => `
              <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">
                <span>${t.time}</span>
                <span class="v3-muted">${t.count} shifts · ${t.pct}%</span>
              </div>`).join('')}

            ${p.busiest_shift ? `<div class="v3-note">
              Busiest day was ${fmtDate(p.busiest_shift.date)}, with ${p.busiest_shift.crew}
              other people on shift at the same time.
            </div>` : ''}
          </div>
        </div>
      </div>
    `;

    this._wire();
  },
});
