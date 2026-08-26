/* ─── 🔁 Cover Finder (V3.0) ───────────────────────────────────────────────
   Pick one of your upcoming shifts and see who could plausibly take it, in the
   order worth asking. Every score shows its reasoning, because a number on its
   own is no use when you're the one who has to go and ask.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('cover-finder', '🔁 Cover Finder', {
  date: null,
  data: null,
  showAll: false,

  async init() {
    document.getElementById('view-cover-finder').innerHTML = V3.loading('Working out who could take it…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.coverFinder(this.date);
      this.render();
    } catch (e) {
      document.getElementById('view-cover-finder').innerHTML = V3.error(e);
    }
  },

  tier(t) {
    if (!t) return '';
    return t.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  },

  shortDate(dateStr) {
    const [, m, d] = dateStr.split('-').map(Number);
    return `${fmtDayShort(dateStr)} ${d} ${MONTHS_SHORT[m - 1]}`;
  },

  STATUS: {
    working:     { badge: 'badge-warning', label: 'Already on that day' },
    leave:       { badge: 'badge-info',    label: 'On leave' },
    other_store: { badge: 'badge-muted',   label: 'At another store' },
    free:        { badge: 'badge-success', label: 'Free' },
  },

  person(c) {
    const status = this.STATUS[c.status] || {};
    const meta = [];
    if (c.slot_matches) meta.push(`Worked this slot ${c.slot_matches}×`);
    if (c.headroom != null) {
      meta.push(c.headroom >= 0 ? `${c.headroom}h under contract` : `${Math.abs(c.headroom)}h over contract`);
    }
    if (c.days_since_seen != null) meta.push(`Last on ${V3.relativeDays(-c.days_since_seen)}`);
    if (c.shifts_together) meta.push(`${c.shifts_together} shifts with you`);

    return `<div class="v3-person">
      <div class="v3-person-score ${c.grade || ''}">${c.score == null ? '—' : c.score}</div>
      <div class="v3-person-body">
        <div class="v3-person-name">
          ${esc(c.name)}
          ${c.job_tier ? `<span class="badge badge-muted" style="margin-left:6px">${esc(this.tier(c.job_tier))}</span>` : ''}
          ${c.status !== 'free' ? `<span class="badge ${status.badge}" style="margin-left:6px">${esc(status.label)}</span>` : ''}
        </div>
        <div class="v3-person-meta">${meta.map(esc).join(' · ') || 'No history on record'}</div>
        ${c.their_shift && c.status !== 'free' ? `
          <div class="v3-person-meta">
            ${c.their_shift.shift_type === 'shift'
              ? `On ${esc(c.their_shift.start_time)}–${esc(c.their_shift.end_time)}${c.their_shift.store ? ' at ' + esc(c.their_shift.store) : ''}`
              : 'Booked off that day'}
          </div>` : ''}
        ${(c.reasons.length || c.flags.length) ? `
          <div class="v3-chips">
            ${c.reasons.map(r => `<span class="v3-chip">${esc(r)}</span>`).join('')}
            ${c.flags.map(f => `<span class="v3-chip flag">${esc(f)}</span>`).join('')}
          </div>` : ''}
      </div>
    </div>`;
  },

  toolbar() {
    const shifts = this.data.my_shifts;
    return `<div class="toolbar">
      <div class="month-nav">
        <label style="margin-bottom:0;margin-right:4px;font-weight:500">Shift to cover:</label>
        <select id="cfShift" style="width:auto">
          ${shifts.map(s => `<option value="${s.date}" ${s.selected ? 'selected' : ''}>
            ${esc(this.shortDate(s.date))} · ${esc(s.start_time)}–${esc(s.end_time)} (${s.hours}h)
          </option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-cover-finder');

    if (!d.shift) {
      el.innerHTML = V3.backButton() + V3.empty('🔁', 'No upcoming shifts',
        'Once there is something on your rota, this will tell you who could take it.');
      return;
    }

    const s = d.shift;
    const strong = d.available.filter(c => c.grade === 'strong');
    const shown = this.showAll ? d.available : d.available.filter(c => c.grade !== 'long-shot');
    const hidden = d.available.length - shown.length;
    const top = d.available[0];

    el.innerHTML = `
      ${V3.backButton()}
      ${this.toolbar()}

      <div class="v3-hero" style="background:linear-gradient(135deg,#6366F1,#312E81)">
        <div class="v3-hero-label">COVER FOR ${esc(s.day.toUpperCase())} ${s.date.slice(8, 10)} ${esc(MONTHS_SHORT[Number(s.date.slice(5, 7)) - 1].toUpperCase())}</div>
        <div class="v3-hero-value">${strong.length || d.counts.free}</div>
        <div class="v3-hero-sub">
          ${strong.length
            ? `${strong.length} strong candidate${strong.length === 1 ? '' : 's'} for your
               ${esc(s.start_time)}–${esc(s.end_time)} (${s.hours}h, ${fmtCurrency(s.pay)}).
               ${d.counts.free} of the team are free that day.`
            : `${d.counts.free} of the team are free that day, but none of them are an obvious fit for
               ${esc(s.start_time)}–${esc(s.end_time)}. The list below is still in best-first order.`}
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Free that day', d.counts.free, `of ${d.counts.team} on the rota`, 'success')}
        ${V3.tile('Already working', d.counts.working, 'Can\'t double up')}
        ${V3.tile('On leave', d.counts.on_leave, 'Booked off')}
        ${V3.tile('Best match', top ? esc(top.name) : '—',
                  top ? `Scores ${top.score}/100` : 'Nobody available')}
      </div>

      <div class="v3-section-title">🙋 Worth asking${hidden > 0 && !this.showAll ? ` (${shown.length} of ${d.available.length})` : ''}</div>
      <div class="card"><div class="card-body" style="padding:0">
        ${shown.length ? shown.map(c => this.person(c)).join('')
          : `<div style="padding:20px">${V3.empty('🤷', 'Nobody free that day')}</div>`}
      </div></div>
      ${hidden > 0 ? `
        <button class="btn btn-ghost btn-sm" id="cfMore" style="margin-top:10px">
          ${this.showAll ? 'Hide long shots' : `Show ${hidden} long shot${hidden === 1 ? '' : 's'}`}
        </button>` : ''}

      ${d.swaps.length ? `
        <div class="v3-section-title">🔄 Shifts you could offer in exchange</div>
        <div class="v3-muted" style="margin-bottom:10px">
          Theirs, on days you're currently free — so you can offer a swap rather than ask a favour.
        </div>
        <div class="card"><div class="card-body" style="padding:0">
          <div class="table-wrapper"><table>
            <thead><tr><th>Who</th><th>Date</th><th>Their shift</th><th>Hours</th><th>vs yours</th></tr></thead>
            <tbody>${d.swaps.map(sw => `
              <tr>
                <td>${esc(sw.name)} <span class="v3-muted">(${sw.cover_score})</span></td>
                <td><span class="shift-date">${fmtDate(sw.date)}</span><br><span class="shift-day">${esc(sw.day.slice(0, 3))}</span></td>
                <td class="shift-time">${esc(sw.start_time)}–${esc(sw.end_time)}</td>
                <td>${sw.hours}h</td>
                <td class="${diffClass(sw.hours_delta)}">${sw.hours_delta > 0 ? '+' : ''}${sw.hours_delta}h</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div></div>` : ''}

      ${d.unavailable.length ? `
        <div class="v3-section-title">🚫 Not available that day</div>
        <div class="card"><div class="card-body" style="padding:0">
          ${d.unavailable.map(c => this.person(c)).join('')}
        </div></div>` : ''}

      <div class="v3-note">
        Scoring weighs whether they already work this slot, whether they work this time of day at all,
        how much room they have left under their contract that week, and how recently they've been on
        the rota. It knows nothing about childcare, second jobs or whether they like you — it just
        puts the plausible names at the top so you're not guessing.
      </div>
    `;

    const sel = document.getElementById('cfShift');
    if (sel) sel.addEventListener('change', e => { this.date = e.target.value; this.load(); });
    const more = document.getElementById('cfMore');
    if (more) more.addEventListener('click', () => { this.showAll = !this.showAll; this.render(); });
  },
});
