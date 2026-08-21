/* ─── 🎯 Goal Tracker (V3.0) ───────────────────────────────────────────────
   Create money/hours/shifts targets and track them against real shifts. Each
   card shows where you are, whether the deadline is realistic, and whether the
   rota you already have booked will carry you over the line.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('goals', '🎯 Goal Tracker', {
  goals: [],

  TYPES: {
    money:  { icon: '💷', label: 'Money',  unit: 'money', noun: 'earned' },
    hours:  { icon: '⏱️', label: 'Hours',  unit: 'hours', noun: 'worked' },
    shifts: { icon: '📋', label: 'Shifts', unit: 'count', noun: 'completed' },
  },

  async init() {
    this.render();
    await this.load();
  },

  fmt(type, value) {
    if (type === 'money') return fmtCurrency(value);
    if (type === 'hours') return `${Number(value).toFixed(1)}h`;
    return String(Math.round(value));
  },

  render() {
    const today = fmtLocalDate(new Date());
    document.getElementById('view-goals').innerHTML = `
      ${V3.backButton()}
      <p class="v3-intro">
        Set a target and this tracks it against your actual shifts — how far in you are, how fast
        you're going, and whether the rota you've already got booked gets you there in time.
      </p>

      <div class="card" style="max-width:640px;margin-bottom:20px">
        <div class="card-header"><h2>➕ New goal</h2></div>
        <div class="card-body">
          <div class="form-group">
            <label>What are you saving for?</label>
            <input type="text" id="goalTitle" placeholder="e.g. New bike, Christmas fund, 200 hours this year" maxlength="80" />
          </div>
          <div class="form-row-3">
            <div class="form-group">
              <label>Type</label>
              <select id="goalType">
                ${Object.entries(this.TYPES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Target</label>
              <input type="number" id="goalTarget" step="0.1" min="0.1" placeholder="600" />
            </div>
            <div class="form-group">
              <label>Counting from</label>
              <input type="date" id="goalStart" value="${today}" />
            </div>
          </div>
          <div class="form-group">
            <label>Deadline <span class="v3-muted">(optional)</span></label>
            <input type="date" id="goalDeadline" />
            <div class="form-hint">Leave blank for an open-ended goal — you'll still get a projected finish date.</div>
          </div>
          <button class="btn btn-primary" id="goalAddBtn">Add goal</button>
        </div>
      </div>

      <div id="goalList">${V3.loading()}</div>
    `;

    document.getElementById('goalAddBtn').addEventListener('click', () => this.create());
  },

  async load() {
    try {
      const res = await V3.api.goals();
      this.goals = res.goals;
      this.renderList();
    } catch (e) {
      document.getElementById('goalList').innerHTML = V3.error(e);
    }
  },

  async create() {
    const title = document.getElementById('goalTitle').value.trim();
    const goal_type = document.getElementById('goalType').value;
    const target = parseFloat(document.getElementById('goalTarget').value);
    const start_date = document.getElementById('goalStart').value;
    const target_date = document.getElementById('goalDeadline').value || null;

    if (!title) return showToast('Give the goal a name first', 'warning');
    if (!target || target <= 0) return showToast('Enter a target greater than zero', 'warning');

    try {
      await V3.api.createGoal({ title, goal_type, target, start_date, target_date });
      document.getElementById('goalTitle').value = '';
      document.getElementById('goalTarget').value = '';
      document.getElementById('goalDeadline').value = '';
      showToast('Goal added', 'success');
      await this.load();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  async remove(id, title) {
    if (!confirmAction(`Delete the goal "${title}"?`)) return;
    try {
      await V3.api.deleteGoal(id);
      showToast('Goal deleted', 'success');
      await this.load();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  renderList() {
    const el = document.getElementById('goalList');
    if (!this.goals.length) {
      el.innerHTML = V3.empty('🎯', 'No goals yet', 'Add one above and it will start tracking straight away.');
      return;
    }

    el.innerHTML = `<div class="v3-grid v3-grid-lg">${this.goals.map(g => this.card(g)).join('')}</div>`;

    el.querySelectorAll('[data-delete-goal]').forEach(btn => {
      btn.addEventListener('click', () =>
        this.remove(btn.dataset.deleteGoal, btn.dataset.goalTitle));
    });
  },

  card(g) {
    const meta = this.TYPES[g.goal_type] || this.TYPES.money;
    const done = g.complete;

    // Status line: complete > covered by booked shifts > on/behind schedule.
    let status, statusClass;
    if (done) {
      status = '🎉 Target reached';
      statusClass = 'success';
    } else if (g.covered_by_scheduled) {
      status = `✅ Your booked shifts cover the remaining ${this.fmt(g.goal_type, g.remaining)}`;
      statusClass = 'success';
    } else if (g.on_track === true) {
      status = '👍 On track for the deadline';
      statusClass = 'success';
    } else if (g.on_track === false) {
      status = `⚠️ Behind schedule — ${g.expected_pct}% expected by now`;
      statusClass = 'warning';
    } else {
      status = g.projected_date ? `📈 On this pace you'll get there ${fmtDate(g.projected_date)}` : '📊 Not enough progress to project yet';
      statusClass = '';
    }

    return `
      <div class="card">
        <div class="card-body">
          <div class="v3-goal-head">
            <div>
              <div style="font-weight:700;font-size:15px">${meta.icon} ${esc(g.title)}</div>
              <div class="v3-muted">
                ${this.fmt(g.goal_type, g.target)} ${meta.noun} since ${fmtDate(g.start_date)}
                ${g.target_date ? ` · due ${fmtDate(g.target_date)}` : ''}
              </div>
            </div>
            <button class="btn-icon danger" data-delete-goal="${g.id}" data-goal-title="${esc(g.title)}" title="Delete goal">&times;</button>
          </div>

          <div class="v3-goal-figures">
            <div class="v3-goal-progress ${done ? 'stat-value success' : ''}">${this.fmt(g.goal_type, g.progress)}</div>
            <div class="v3-muted">of ${this.fmt(g.goal_type, g.target)} · ${g.progress_pct}%</div>
          </div>
          ${V3.bar(g.progress_pct, done ? 'success' : g.on_track === false ? 'warning' : '')}

          <div style="margin-top:12px;font-size:12.5px;font-weight:600;color:${
            statusClass === 'success' ? 'var(--success)'
            : statusClass === 'warning' ? 'var(--warning)'
            : 'var(--text-muted)'}">
            ${status}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;font-size:12.5px">
            <div><span class="v3-muted">Remaining</span><br><strong>${this.fmt(g.goal_type, g.remaining)}</strong></div>
            <div><span class="v3-muted">Shifts needed</span><br><strong>${g.shifts_needed || '—'}</strong></div>
            <div><span class="v3-muted">Per shift so far</span><br><strong>${this.fmt(g.goal_type, g.per_shift)}</strong></div>
            <div><span class="v3-muted">${g.days_left != null ? 'Days left' : 'Days running'}</span><br>
                 <strong>${g.days_left != null ? g.days_left : g.days_elapsed}</strong></div>
          </div>
        </div>
      </div>`;
  },
});
