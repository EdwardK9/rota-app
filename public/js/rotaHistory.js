/* ─── Past Rota ───────────────────────────────────────────────────────────────
   What the rota looked like on any past date, and what changed since, when, and
   where the change came from — for your own shifts and the team's.

   Data: GET /api/rota-history/week?start=…   every version of every shift that week
         GET /api/rota-history/log?days=…     a readable list of changes
   Each "version" says when it was added (from) and when it was changed or removed
   (to), so every view below is just a different question put to the same list:

     Changes   what is different now vs how each person was first rostered
     As at     the rota as it stood at the end of a chosen day
     Original  each person's week as first added
     Now       the rota today, with a tag on anything that was added or changed late
     Log       the changes, newest first

   Everything lives on one object: the app bundles every page script into a single
   shared scope, so a stray top-level helper here could clash with another file.
   ───────────────────────────────────────────────────────────────────────── */

const RotaHistoryView = {
  mode: 'changes',
  scope: 'all',
  weekStart: null,
  asAt: null,
  logDays: 30,
  logMinor: false,
  data: null,

  MODES: [
    ['changes',  'Changes'],
    ['asat',     'As at a date'],
    ['original', 'Original'],
    ['now',      'Now'],
    ['log',      'Log'],
  ],

  // ── dates (all local; the server sends UTC instants) ──────────────────────
  pad(n) { return String(n).padStart(2, '0'); },
  localDate(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; },
  today() { return this.localDate(new Date()); },
  addDays(ds, n) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return this.localDate(d); },
  mondayOf(ds) {
    const d = new Date(ds + 'T00:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return this.localDate(d);
  },
  endOfDay(ds) { return new Date(ds + 'T23:59:59.999').getTime(); },
  dayOf(iso) { return this.localDate(new Date(iso)); },
  fmtDay(ds) {
    return new Date(ds + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  },
  fmtShort(ds) {
    return new Date(ds + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  },
  fmtAt(iso) {
    return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  range(v) { return `${v.start_time}–${v.end_time}`; },
  hrs(n) { return (Math.round(n * 100) / 100) + 'h'; },
  signed(n) { const r = Math.round(n * 100) / 100; return (r > 0 ? '+' : '') + r + 'h'; },

  // ── shell ─────────────────────────────────────────────────────────────────
  async init() {
    if (!this.weekStart) this.weekStart = this.mondayOf(this.today());
    if (!this.asAt) this.asAt = this.addDays(this.today(), -14);
    this.renderShell();
    await this.load();
  },

  renderShell() {
    const scopes = [['all', 'Everyone'], ['me', 'Just me'], ['team', 'Team only']];
    document.getElementById('view-rota-history').innerHTML = `
      <div class="rh">
        <div class="card" style="margin-bottom:14px">
          <div class="card-body rh-controls">
            <div class="rh-tabs" id="rhTabs">
              ${this.MODES.map(([k, l]) => `<button type="button" class="rh-tab${this.mode === k ? ' active' : ''}" data-mode="${k}">${l}</button>`).join('')}
            </div>
            <div class="rh-tabs" id="rhScope">
              ${scopes.map(([k, l]) => `<button type="button" class="rh-tab rh-tab-sm${this.scope === k ? ' active' : ''}" data-scope="${k}">${l}</button>`).join('')}
            </div>
          </div>
          <div class="card-body rh-controls" id="rhSub" style="border-top:1px solid var(--border)"></div>
        </div>
        <div id="rhInfo"></div>
        <div id="rhBody"><p class="rh-muted" style="padding:16px">Loading…</p></div>
      </div>`;

    document.getElementById('rhTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (b) this.setMode(b.dataset.mode);
    });
    document.getElementById('rhScope').addEventListener('click', e => {
      const b = e.target.closest('[data-scope]');
      if (!b || b.dataset.scope === this.scope) return;
      this.scope = b.dataset.scope;
      document.querySelectorAll('#rhScope .rh-tab').forEach(x => x.classList.toggle('active', x.dataset.scope === this.scope));
      this.load();
    });
    this.renderSub();
  },

  setMode(mode) {
    const wasLog = this.mode === 'log';
    this.mode = mode;
    document.querySelectorAll('#rhTabs .rh-tab').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
    this.renderSub();
    if (wasLog !== (mode === 'log')) this.load(); else this.render();
  },

  /** The row under the tabs: week picker, or the log's filters. */
  renderSub() {
    const el = document.getElementById('rhSub');
    if (this.mode === 'log') {
      el.innerHTML = `
        <label class="rh-field">Show the last
          <select id="rhLogDays" class="form-select" style="width:auto">
            ${[[14, '2 weeks'], [30, 'month'], [90, '3 months'], [365, 'year'], [3650, 'all time']]
              .map(([d, l]) => `<option value="${d}"${+this.logDays === d ? ' selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <label class="rh-field"><input type="checkbox" id="rhLogMinor"${this.logMinor ? ' checked' : ''}> Include minor edits (clock-outs and the like)</label>`;
      document.getElementById('rhLogDays').addEventListener('change', e => { this.logDays = +e.target.value; this.load(); });
      document.getElementById('rhLogMinor').addEventListener('change', e => { this.logMinor = e.target.checked; this.load(); });
      return;
    }
    const asAt = this.mode === 'asat' ? `
      <span class="rh-sep"></span>
      <label class="rh-field">As at the end of
        <input type="date" id="rhAsAt" class="form-input" value="${this.asAt}" max="${this.today()}" style="width:auto"></label>
      ${[['1 week ago', 7], ['2 weeks ago', 14], ['1 month ago', 30]]
        .map(([l, n]) => `<button type="button" class="btn btn-secondary btn-sm" data-ago="${n}">${l}</button>`).join('')}` : '';
    el.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" id="rhPrev" aria-label="Previous week">◀</button>
      <strong id="rhWeekLabel" style="min-width:150px;text-align:center"></strong>
      <button type="button" class="btn btn-secondary btn-sm" id="rhNext" aria-label="Next week">▶</button>
      <button type="button" class="btn btn-ghost btn-sm" id="rhThisWeek">This week</button>
      <input type="date" id="rhJump" class="form-input" style="width:auto" aria-label="Jump to the week containing…" value="${this.weekStart}">
      ${asAt}`;
    const go = ws => { this.weekStart = ws; this.load(); };
    document.getElementById('rhPrev').addEventListener('click', () => go(this.addDays(this.weekStart, -7)));
    document.getElementById('rhNext').addEventListener('click', () => go(this.addDays(this.weekStart, 7)));
    document.getElementById('rhThisWeek').addEventListener('click', () => go(this.mondayOf(this.today())));
    document.getElementById('rhJump').addEventListener('change', e => { if (e.target.value) go(this.mondayOf(e.target.value)); });
    const a = document.getElementById('rhAsAt');
    if (a) a.addEventListener('change', e => { if (e.target.value) { this.asAt = e.target.value; this.render(); } });
    el.querySelectorAll('[data-ago]').forEach(b => b.addEventListener('click', () => {
      this.asAt = this.addDays(this.today(), -(+b.dataset.ago));
      document.getElementById('rhAsAt').value = this.asAt;
      this.render();
    }));
    this.updateWeekLabel();
  },

  updateWeekLabel() {
    const l = document.getElementById('rhWeekLabel');
    if (l) l.textContent = `${this.fmtShort(this.weekStart)} – ${this.fmtShort(this.addDays(this.weekStart, 6))} ${this.weekStart.slice(0, 4)}`;
    const j = document.getElementById('rhJump');
    if (j) j.value = this.weekStart;
  },

  // ── data ──────────────────────────────────────────────────────────────────
  async load() {
    const body = document.getElementById('rhBody');
    body.innerHTML = '<p class="rh-muted" style="padding:16px">Loading…</p>';
    this.updateWeekLabel();
    const token = this.loadToken = (this.loadToken || 0) + 1;       // clicking ▶ quickly must not let an older reply win
    try {
      const url = this.mode === 'log'
        ? `/api/rota-history/log?days=${this.logDays}&scope=${this.scope}&minor=${this.logMinor ? 1 : 0}`
        : `/api/rota-history/week?start=${this.weekStart}&scope=${this.scope}`;
      const resp = await fetch(url);
      const data = await resp.json().catch(() => ({}));
      if (token !== this.loadToken) return;
      if (!resp.ok) throw new Error(data.error || `Server returned ${resp.status}`);
      this.data = data;
      this.render();
    } catch (e) {
      if (token !== this.loadToken) return;
      body.innerHTML = `<p style="padding:16px;color:var(--danger)">Couldn't load the history: ${esc(e.message)}</p>`;
    }
  },

  render() {
    if (!this.data) return;
    if (this.mode === 'log') return this.renderLog();
    this.renderWeek();
  },

  // ── week views ────────────────────────────────────────────────────────────
  alive(v, t) { return Date.parse(v.from) <= t && (!v.to || Date.parse(v.to) > t); },

  /** The day most of the week was added — "main added 1 Nov". */
  mainDay(versions) {
    const n = {};
    for (const v of versions) if (v.from_op !== 'update' && v.from) { const d = this.dayOf(v.from); n[d] = (n[d] || 0) + 1; }
    return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b))[0] || null;
  },

  /** When each person's week was first on the rota: the end of the first day anything of theirs was added. */
  originalAt(versions) {
    const first = {};
    for (const v of versions) {
      const t = Date.parse(v.from);
      if (!(v.person in first) || t < first[v.person]) first[v.person] = t;
    }
    const out = {};
    for (const p in first) out[p] = this.endOfDay(this.localDate(new Date(first[p])));
    return out;
  },

  /**
   * The importer records an edited team shift as "delete the old row, insert a new one",
   * so a shift that was swapped for another on the same person and day, in the same
   * action, is a change — not a removal plus an unrelated addition.
   */
  pairReplacements(versions) {
    const by = new Map(), of = new Map();
    for (const v of versions) {
      if (v.to_op !== 'delete') continue;
      const r = versions.find(o => o.id !== v.id && !of.has(o.id) && o.from_op !== 'update' && o.person === v.person
        && o.date === v.date && Math.abs(Date.parse(o.from) - Date.parse(v.to)) <= 120000);
      if (r) { by.set(v.id, r); of.set(r.id, v); }
    }
    return { by, of };
  },

  changedText(v) {
    const p = v.prev, day = this.fmtShort(this.dayOf(v.from));
    if (!p) return `changed ${day}`;
    const bits = [];
    if (p.date !== v.date) bits.push(`was ${this.fmtDay(p.date)}`);
    if (p.start_time !== v.start_time || p.end_time !== v.end_time) bits.push(`was ${this.range(p)}`);
    else if (p.hours !== v.hours) bits.push(`${this.hrs(p.hours)} → ${this.hrs(v.hours)}`);
    return `changed ${day}` + (bits.length ? ' · ' + bits.join(', ') : '');
  },

  renderWeek() {
    const d = this.data, mode = this.mode, now = Date.parse(d.now);
    const main = this.mainDay(d.versions);
    const orig = this.originalAt(d.versions);
    const asAtT = Math.min(this.endOfDay(this.asAt), now);
    const thenT = p => mode === 'asat' ? asAtT : orig[p];     // "then" for the hours column and summary

    // Which versions to draw, with the tags that explain them
    this.rep = this.pairReplacements(d.versions);
    const shown = [];
    for (const v of d.versions) {
      const tags = [];
      const addedDay = v.from_op !== 'update' ? this.dayOf(v.from) : null;
      const replacedBy = v.to_op === 'delete' ? this.rep.by.get(v.id) : null;     // swapped for another shift, not just removed
      const replaces = this.rep.of.get(v.id);
      let status = 'plain';

      if (mode === 'changes' || mode === 'now') {
        if (v.to && (mode === 'now' || v.to_op === 'update')) continue;    // gone / replaced by a newer version
        if (replacedBy) continue;                                          // drawn as the replacement's "changed"
        if (v.to_op === 'delete') { status = 'removed'; tags.push({ k: 'removed', t: `removed ${this.fmtShort(this.dayOf(v.to))}` }); }
        else if (v.from_op === 'update') { status = 'changed'; tags.push({ k: 'changed', t: this.changedText(v) }); }
        else if (replaces) { status = 'changed'; tags.push({ k: 'changed', t: this.changedText({ ...v, prev: replaces }) }); }
        if (addedDay && addedDay !== main && !replaces) tags.unshift({ k: 'added', t: `added ${this.fmtShort(addedDay)}` });
      } else {
        const t = mode === 'asat' ? asAtT : orig[v.person];
        if (!this.alive(v, t)) continue;
        if (addedDay && addedDay !== main) tags.push({ k: 'added', t: `added ${this.fmtShort(addedDay)}` });
        if (v.from_op === 'update') tags.push({ k: 'changed', t: this.changedText(v) });
        const nx = replacedBy || (v.to_op === 'update' ? v.next : null);
        if (v.to_op === 'delete' && !replacedBy) { status = 'removed'; tags.push({ k: 'removed', t: `later removed ${this.fmtShort(this.dayOf(v.to))}` }); }
        else if (v.to_op) {
          status = 'changed';
          const day = this.fmtShort(this.dayOf(v.to));
          let text = `later changed ${day}`;
          if (nx) {
            const sameShift = nx.date === v.date && nx.start_time === v.start_time && nx.end_time === v.end_time;
            text = sameShift
              ? `later ${this.hrs(v.hours)} → ${this.hrs(nx.hours)} · ${day}`                       // break / pay changed
              : `later ${nx.date !== v.date ? this.fmtDay(nx.date) + ' ' : ''}${this.range(nx)} · ${day}`;
          }
          tags.push({ k: 'changed', t: text });
        }
      }
      shown.push({ v, status, tags });
    }

    // Hours per person: now vs then
    const hours = {};
    const add = (p, k, h) => { (hours[p] ||= { now: 0, then: 0 })[k] += h; };
    for (const v of d.versions) {
      if (!v.to) add(v.person, 'now', v.hours);
      if (mode !== 'now' && this.alive(v, thenT(v.person))) add(v.person, 'then', v.hours);
    }

    // What changed since "then"
    const since = mode === 'now' ? null : this.sinceCounts(d.versions, thenT);

    // Banner: main date + summary
    const accuracy = this.accuracyNote(d);
    const info = document.getElementById('rhInfo');
    const sinceLabel = mode === 'asat' ? 'Since then' : 'Since first added';
    const sinceNone = since && !(since.added || since.removed || since.changed);
    info.innerHTML = `
      <div class="rh-info">
        <div>
          ${main ? `<strong>Main rota added ${this.fmtDay(main)}</strong>` : '<strong>Nothing on the rota this week</strong>'}
          ${main && mode === 'asat' ? ` · showing the rota as it stood at the end of <strong>${this.fmtDay(this.asAt)}</strong>` : ''}
          ${main && mode === 'original' ? ' · showing each person’s week as first added' : ''}
          ${main && mode === 'changes' ? ' · tags show what happened to each shift and when' : ''}
        </div>
        ${since && main ? `<div class="rh-summary">
            ${sinceLabel}:
            ${sinceNone ? 'no changes' : `
              <span class="rh-pill rh-pill-added">+${since.added} added</span>
              <span class="rh-pill rh-pill-removed">−${since.removed} removed</span>
              <span class="rh-pill rh-pill-changed">~${since.changed} changed</span>`}
          </div>` : ''}
        ${accuracy ? `<details class="rh-acc"><summary>How accurate is this?</summary>${accuracy}</details>` : ''}
      </div>`;

    // Grid
    const days = Array.from({ length: 7 }, (_, i) => this.addDays(d.start, i));
    const today = this.today();
    const people = d.people.filter(p => shown.some(s => s.v.person === p.key));
    const body = document.getElementById('rhBody');
    if (!people.length) {
      body.innerHTML = `<div class="card"><div class="card-body rh-muted" style="text-align:center;padding:32px">
        ${mode === 'asat' && d.versions.length
          ? `Nothing was on the rota for this week at the end of ${esc(this.fmtDay(this.asAt))}.`
          : 'No shifts recorded for this week.'}</div></div>`;
      return;
    }
    const cell = (p, day) => {
      const items = shown.filter(s => s.v.person === p.key && s.v.date === day);
      return items.map(s => this.chip(s)).join('');
    };
    body.innerHTML = `
      <div class="card"><div class="rh-scroll"><table class="rh-grid">
        <thead><tr><th class="rh-person"></th>
          ${days.map(day => `<th class="${day === today ? 'rh-today' : ''}">${esc(this.fmtDay(day))}</th>`).join('')}
          <th class="rh-hours">Hours</th></tr></thead>
        <tbody>${people.map(p => `
          <tr><td class="rh-person">${esc(p.name)}</td>
            ${days.map(day => `<td class="${day === today ? 'rh-today' : ''}">${cell(p, day)}</td>`).join('')}
            <td class="rh-hours">${this.hoursCell(hours[p.key] || { now: 0, then: 0 }, mode)}</td></tr>`).join('')}
        </tbody></table></div></div>
      <p class="rh-muted" style="margin:8px 4px">Click a shift for the full story — when it was added, changed or removed, and by what.</p>`;
    body.querySelectorAll('.rh-chip').forEach(c => {
      c.addEventListener('click', () => this.openStory(c.dataset.id));
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openStory(c.dataset.id); } });
    });
  },

  hoursCell(h, mode) {
    const now = this.hrs(h.now);
    if (mode === 'now') return `<strong>${now}</strong>`;
    const diff = h.now - h.then;
    if (Math.abs(diff) < 0.005) return `<strong>${now}</strong><div class="rh-muted">same as then</div>`;
    return `<strong>${now}</strong><div class="rh-muted">was ${this.hrs(h.then)}</div>
      <div class="rh-delta ${diff > 0 ? 'rh-up' : 'rh-down'}">${this.signed(diff)}</div>`;
  },

  /** Added / removed / changed between "then" and now. A removed + added on the same person and day is one change. */
  sinceCounts(versions, thenT) {
    const then = new Map(), now = new Map();                        // row -> version
    for (const v of versions) {
      if (this.alive(v, thenT(v.person))) then.set(v.row, v);
      if (!v.to) now.set(v.row, v);
    }
    let changed = 0;
    const gone = [], fresh = [];
    for (const [row, v] of then) {
      if (!now.has(row)) gone.push(v);
      else if (now.get(row).id !== v.id) changed++;
    }
    for (const [row, v] of now) if (!then.has(row)) fresh.push(v);
    // pair a removal with an addition on the same person + day: that's an edit
    for (const g of gone.slice()) {
      const i = fresh.findIndex(f => f.person === g.person && f.date === g.date);
      if (i >= 0) { fresh.splice(i, 1); gone.splice(gone.indexOf(g), 1); changed++; }
    }
    return { added: fresh.length, removed: gone.length, changed };
  },

  chip(s) {
    const v = s.v;
    const leave = v.shift_type === 'leave' ? 'Leave' : v.shift_type === 'all_day' ? 'All day' : null;
    const title = leave || this.range(v);
    const extra = [v.absence_type ? v.absence_type : null, v.store ? `@ ${v.store}` : null].filter(Boolean).join(' · ');
    return `
      <div class="rh-chip rh-${s.status}" tabindex="0" role="button" data-id="${esc(v.id)}">
        <div class="rh-time">${esc(title)}${v.hours && v.person === 'me' ? ` <span class="rh-h">${this.hrs(v.hours)}</span>` : ''}</div>
        ${extra ? `<div class="rh-extra">${esc(extra)}</div>` : ''}
        ${s.tags.map(t => `<div class="rh-tag rh-tag-${t.k}">${esc(t.t)}</div>`).join('')}
      </div>`;
  },

  /** The full story of one shift, in a dialog: when it was added, every change, and its removal. */
  openStory(id) {
    const v = this.data.versions.find(x => x.id === id);
    if (!v) return;
    const rowChain = x => this.data.versions.filter(o => o.row === x.row).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    let chain = rowChain(v);
    // A shift that replaced another carries that one's history with it
    for (let r = this.rep && this.rep.of.get(chain[0].id); r; r = this.rep.of.get(r.id)) chain = [...rowChain(r), ...chain];
    const by = (label, note) => (label ? ` — ${esc(label)}` : '') + (note ? `<div class="rh-muted">${esc(note)}</div>` : '');
    const what = x => (x.shift_type === 'leave' ? 'Leave' : x.shift_type === 'all_day' ? 'All day' : this.range(x));
    const row = (ic, cl, html) => `<div class="rh-logrow"><span class="rh-logicon ${cl}">${ic}</span><div class="rh-logmain">${html}</div></div>`;

    let html = '';
    chain.forEach((x, i) => {
      const replaced = i > 0 && chain[i - 1].to_op === 'delete';         // swapped in for the previous shift
      if (i === 0 && x.from_op === 'legacy') {
        html += row('➕', 'rh-up', `Added <b>${esc(this.fmtAt(x.from))}</b> <span class="rh-muted">(the day it was first saved — what happened before the history began isn't known)</span>`);
      } else if (i === 0 && x.from_op === 'insert') {
        html += row('➕', 'rh-up', `Added <b>${esc(this.fmtAt(x.from))}</b>${by(x.from_label, x.from_note)}`);
      } else {
        const p = x.from_op === 'update' ? x.prev : (replaced ? chain[i - 1] : null);
        const diff = p ? `<div>${esc((p.date !== x.date ? this.fmtDay(p.date) + ' ' : '') + what(p))} <span class="rh-muted">${this.hrs(p.hours)}</span> → ${esc((p.date !== x.date ? this.fmtDay(x.date) + ' ' : '') + what(x))} <span class="rh-muted">${this.hrs(x.hours)}</span></div>` : '';
        html += row('✏️', 'rh-mid', `Changed <b>${esc(this.fmtAt(x.from))}</b>${by(x.from_label, x.from_note)}${diff}`);
      }
    });
    const last = chain[chain.length - 1];
    if (last.to_op === 'delete') {
      html += row('➖', 'rh-down', `Removed <b>${esc(this.fmtAt(last.to))}</b>${by(last.to_label, last.to_note)}`);
    } else if (!last.to) {
      html += row('✔', 'rh-up', `On the rota now: <b>${esc(what(last))}</b>${last.hours ? ` <span class="rh-muted">${this.hrs(last.hours)}${last.break_min != null && last.person === 'me' ? `, ${last.break_min}m break` : ''}</span>` : ''}`);
    }
    Modal.open(`${v.name} — ${this.fmtDay(v.date)}`, `<div class="rh-story">${html}</div>`);
  },

  accuracyNote(d) {
    const parts = [];
    if (d.scope !== 'team') {
      parts.push(d.started.own
        ? `<b>Your shifts:</b> changes are known from ${esc(this.fmtShort(this.dayOf(d.started.own)))} (from the audit log, then recorded live). A shift older than that shows when it was first saved, but not what happened to it before.`
        : '<b>Your shifts:</b> recorded from now on.');
    }
    if (d.scope !== 'me') {
      parts.push(`<b>The team:</b> there was no history before ${d.started.team ? esc(this.fmtShort(this.dayOf(d.started.team))) : 'this feature arrived'}, so earlier shifts show the day they were added but a shift that was removed or changed before then can’t be shown. From then on every change is recorded.`);
    }
    return parts.map(p => `<p>${p}</p>`).join('');
  },

  // ── log ───────────────────────────────────────────────────────────────────
  renderLog() {
    const d = this.data, body = document.getElementById('rhBody');
    document.getElementById('rhInfo').innerHTML = '';
    if (!d.items.length) {
      body.innerHTML = `<div class="card"><div class="card-body rh-muted" style="text-align:center;padding:32px">
        Nothing has changed in this period.</div></div>`;
      return;
    }
    const icon = { added: ['➕', 'rh-up'], removed: ['➖', 'rh-down'], changed: ['✏️', 'rh-mid'], detail: ['•', 'rh-muted'] };
    const what = i => {
      const o = i.old, n = i.new;
      const sh = x => (x.shift_type === 'leave' ? 'Leave' : x.shift_type === 'all_day' ? 'All day' : this.range(x));
      if (i.kind === 'added')   return `Added <b>${esc(this.fmtDay(n.date))}</b> ${esc(sh(n))}`;
      if (i.kind === 'removed') return `Removed <b>${esc(this.fmtDay(o.date))}</b> ${esc(sh(o))}`;
      if (i.kind === 'changed') {
        const sameTimes = o.date === n.date && sh(o) === sh(n);
        if (sameTimes) {                                  // same shift, paid differently
          const bits = [];
          if (o.break_min !== n.break_min && n.break_min != null) bits.push(`break ${o.break_min ?? '?'}m → ${n.break_min}m`);
          bits.push(`${this.hrs(o.hours)} → ${this.hrs(n.hours)} paid`);
          return `Changed <b>${esc(this.fmtDay(n.date))}</b> ${esc(sh(n))} — ${esc(bits.join(', '))}`;
        }
        const od = o.date !== n.date ? this.fmtDay(o.date) + ' ' : '';
        const nd = o.date !== n.date ? this.fmtDay(n.date) + ' ' : '';
        return `Changed <b>${esc(this.fmtDay(n.date))}</b>: ${esc(od + sh(o))} → ${esc(nd + sh(n))}`;
      }
      const bits = [];
      if (o.break_min !== n.break_min && n.break_min != null) bits.push(`break ${o.break_min ?? '?'}m → ${n.break_min}m`);
      if (o.hours !== n.hours) bits.push(`${this.hrs(o.hours)} → ${this.hrs(n.hours)}`);
      return `Edited <b>${esc(this.fmtDay(n.date))}</b> ${esc(sh(n))}${bits.length ? ' — ' + esc(bits.join(', ')) : ''}`;
    };
    let lastDay = null, html = '';
    for (const i of d.items) {
      const day = this.dayOf(i.at);
      if (day !== lastDay) { html += `<div class="rh-logday">${esc(new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>`; lastDay = day; }
      const [ic, cl] = icon[i.kind] || icon.detail;
      html += `
        <div class="rh-logrow">
          <span class="rh-logicon ${cl}">${ic}</span>
          <div class="rh-logmain">
            <div><b>${esc(i.name)}</b> — ${what(i)}</div>
            <div class="rh-muted">${esc(new Date(i.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))} · ${esc(i.label)}${i.note ? ' · ' + esc(i.note) : ''}</div>
          </div>
          ${i.week ? `<button type="button" class="btn btn-ghost btn-sm" data-week="${esc(i.week)}">View week</button>` : ''}
        </div>`;
    }
    body.innerHTML = `
      <div class="card"><div class="card-body" style="padding:6px 16px">${html}</div></div>
      ${d.total > d.items.length ? `<p class="rh-muted" style="margin:8px 4px">Showing the newest ${d.items.length} of ${d.total}. Pick a shorter period to see the rest.</p>` : ''}`;
    body.querySelectorAll('[data-week]').forEach(b => b.addEventListener('click', () => {
      this.weekStart = this.mondayOf(b.dataset.week);
      this.mode = 'changes';
      this.renderShell();
      this.load();
    }));
  },
};
