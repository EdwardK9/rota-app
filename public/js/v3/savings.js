/* ─── 🐖 Savings & Share Plans (V3.0) ─────────────────────────────────────
   Name your own tracker (a Sharesave, a Christmas club, a holiday pot), give it
   a monthly payment and a length, and it works out progress and the payout.
   Mark it as a share plan and add the option price to see how many shares the
   pot buys and what they are worth at today's price.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('savings', '🐖 Savings & Share Plans', {
  plans: [],
  editingId: null,

  async init() {
    this.editingId = null;
    this.render();
    await this.load();
  },

  render() {
    const today = fmtLocalDate(new Date());
    document.getElementById('view-savings').innerHTML = `
      ${V3.backButton()}
      <p class="v3-intro">
        Track anything you pay into every month towards a payout &mdash; a Sharesave, a Christmas club, a
        holiday pot. Call it what you like, say how much and for how long, and this works out how far in
        you are and what you'll get. Share plans also work out how many shares the pot buys.
      </p>

      <div class="card" style="max-width:680px;margin-bottom:20px">
        <div class="card-header"><h2 id="svFormTitle">➕ New tracker</h2></div>
        <div class="card-body">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="svName" placeholder="e.g. Screwfix Sharesave 2026, Christmas club" maxlength="80" />
          </div>
          <div class="form-row-3">
            <div class="form-group">
              <label>Type</label>
              <select id="svKind">
                <option value="savings">🐖 Savings pot</option>
                <option value="shares">📈 Share plan</option>
              </select>
            </div>
            <div class="form-group">
              <label>Monthly payment (£)</label>
              <input type="number" id="svMonthly" step="0.01" min="0.01" placeholder="50" />
            </div>
            <div class="form-group">
              <label>Length (months)</label>
              <input type="number" id="svDuration" step="1" min="1" max="600" placeholder="36" list="svDurations" />
              <datalist id="svDurations"><option value="12"><option value="24"><option value="36"><option value="60"></datalist>
            </div>
          </div>
          <div class="form-row-3">
            <div class="form-group">
              <label>First payment</label>
              <input type="date" id="svStart" value="${today}" />
            </div>
            <div class="form-group">
              <label>Bonus at the end (£) <span class="v3-muted">optional</span></label>
              <input type="number" id="svBonus" step="0.01" min="0" placeholder="0" />
            </div>
            <div class="form-group">
              <label>Payments so far come from</label>
              <select id="svMode">
                <option value="schedule">The schedule (one a month)</option>
                <option value="payslips">My payslips (Sharesave line)</option>
                <option value="manual">A number I enter</option>
              </select>
            </div>
          </div>
          <div class="form-group" id="svManualWrap" style="display:none">
            <label>Payments made so far</label>
            <input type="number" id="svManual" step="1" min="0" placeholder="0" style="max-width:160px" />
          </div>

          <div id="svSharesWrap" style="display:none">
            <div class="form-row-3">
              <div class="form-group">
                <label>Option price (£ per share)</label>
                <input type="number" id="svOption" step="0.0001" min="0" placeholder="e.g. 1.24" />
                <div class="form-hint">The fixed price you can buy shares at when the plan ends.</div>
              </div>
              <div class="form-group">
                <label>Share price now (£) <span class="v3-muted">optional</span></label>
                <input type="number" id="svCurrent" step="0.0001" min="0" placeholder="e.g. 1.80" />
                <div class="form-hint">Update it whenever you like to see what the shares are worth.</div>
              </div>
              <div class="form-group"></div>
            </div>
          </div>

          <div class="form-group">
            <label>Notes <span class="v3-muted">optional</span></label>
            <input type="text" id="svNotes" maxlength="200" />
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="svSaveBtn">Add tracker</button>
            <button class="btn btn-ghost" id="svCancelBtn" style="display:none">Cancel edit</button>
          </div>
        </div>
      </div>

      <div id="svList">${V3.loading()}</div>
    `;

    const syncFormVisibility = () => {
      document.getElementById('svSharesWrap').style.display = document.getElementById('svKind').value === 'shares' ? '' : 'none';
      document.getElementById('svManualWrap').style.display = document.getElementById('svMode').value === 'manual' ? '' : 'none';
    };
    document.getElementById('svKind').addEventListener('change', syncFormVisibility);
    document.getElementById('svMode').addEventListener('change', syncFormVisibility);
    document.getElementById('svSaveBtn').addEventListener('click', () => this.save());
    document.getElementById('svCancelBtn').addEventListener('click', () => { this.editingId = null; this.render(); this.renderList(); });
  },

  async load() {
    try {
      const res = await V3.api.savings();
      this.plans = res.plans;
      this.renderList();
    } catch (e) {
      document.getElementById('svList').innerHTML = V3.error(e);
    }
  },

  _val(id) { return document.getElementById(id).value; },

  async save() {
    const kind = this._val('svKind');
    const body = {
      name: this._val('svName').trim(),
      kind,
      monthly_amount: this._val('svMonthly'),
      duration_months: this._val('svDuration'),
      start_date: this._val('svStart'),
      bonus: this._val('svBonus'),
      count_mode: this._val('svMode'),
      manual_paid_months: this._val('svManual'),
      option_price: kind === 'shares' ? this._val('svOption') : null,
      current_price: kind === 'shares' ? this._val('svCurrent') : null,
      notes: this._val('svNotes'),
    };
    try {
      if (this.editingId) await V3.api.updateSaving(this.editingId, body);
      else await V3.api.createSaving(body);
      showToast(this.editingId ? 'Tracker updated' : 'Tracker added', 'success');
      this.editingId = null;
      this.render();
      await this.load();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  edit(id) {
    const p = this.plans.find(x => x.id === id);
    if (!p) return;
    this.editingId = id;
    const set = (el, v) => { document.getElementById(el).value = v == null ? '' : v; };
    set('svName', p.name); set('svKind', p.kind); set('svMonthly', p.monthly_amount);
    set('svDuration', p.duration_months); set('svStart', p.start_date); set('svBonus', p.bonus || '');
    set('svMode', p.count_mode); set('svManual', p.manual_paid_months);
    set('svOption', p.option_price); set('svCurrent', p.current_price); set('svNotes', p.notes);
    document.getElementById('svKind').dispatchEvent(new Event('change'));
    document.getElementById('svFormTitle').textContent = '✏️ Edit tracker';
    document.getElementById('svSaveBtn').textContent = 'Save changes';
    document.getElementById('svCancelBtn').style.display = '';
    document.getElementById('view-savings').scrollIntoView({ behavior: 'smooth' });
  },

  async remove(id, name) {
    if (!confirmAction(`Delete "${name}"?`)) return;
    try {
      await V3.api.deleteSaving(id);
      showToast('Tracker deleted', 'success');
      await this.load();
    } catch (e) { showToast(e.message, 'error'); }
  },

  async updatePrice(id) {
    const p = this.plans.find(x => x.id === id);
    if (!p) return;
    const raw = prompt(`Share price now for "${p.name}" (£ per share):`, p.current_price || '');
    if (raw === null) return;
    const price = parseFloat(raw);
    if (!(price > 0)) return showToast('Enter a price above zero', 'warning');
    try {
      await V3.api.updateSaving(id, { current_price: price });
      showToast('Share price updated', 'success');
      await this.load();
    } catch (e) { showToast(e.message, 'error'); }
  },

  renderList() {
    const el = document.getElementById('svList');
    if (!el) return;
    if (!this.plans.length) {
      el.innerHTML = V3.empty('🐖', 'No trackers yet', 'Add one above — a Sharesave, a Christmas club, anything you pay into monthly.');
      return;
    }
    el.innerHTML = `<div class="v3-grid v3-grid-lg">${this.plans.map(p => this.card(p)).join('')}</div>`;
    el.querySelectorAll('[data-sv-edit]').forEach(b => b.addEventListener('click', () => this.edit(Number(b.dataset.svEdit))));
    el.querySelectorAll('[data-sv-price]').forEach(b => b.addEventListener('click', () => this.updatePrice(Number(b.dataset.svPrice))));
    el.querySelectorAll('[data-sv-del]').forEach(b => b.addEventListener('click', () => this.remove(Number(b.dataset.svDel), b.dataset.svName)));
  },

  card(p) {
    const s = p.shares;
    const icon = p.kind === 'shares' ? '📈' : '🐖';
    const basis = { schedule: 'on schedule', payslips: 'from your payslips', manual: 'as entered' }[p.basis];

    let status;
    if (p.matured) status = `<span style="color:var(--success)">🎉 Matured ${fmtDate(p.maturity_date)}</span>`;
    else if (!p.started) status = `<span class="v3-muted">Starts ${fmtDate(p.start_date)}</span>`;
    else status = `<span class="v3-muted">${p.remaining_months} payment${p.remaining_months !== 1 ? 's' : ''} to go · pays out ${fmtDate(p.maturity_date)} (${V3.relativeDays(p.days_to_maturity)})</span>`;

    const shareBlock = s ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13px">📈 Shares</strong>
          <button class="btn btn-ghost btn-sm" data-sv-price="${p.id}">Update share price</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px">
          <div><span class="v3-muted">Option price</span><br><strong>${fmtCurrency(s.option_price)}</strong></div>
          <div><span class="v3-muted">Share price now</span><br><strong>${s.current_price != null ? fmtCurrency(s.current_price) : '—'}</strong>
            ${s.discount_pct != null ? `<span class="${s.in_the_money ? 'diff-pos' : 'diff-neg'}" style="font-size:11px"> ${s.discount_pct >= 0 ? '' : '−'}${Math.abs(s.discount_pct)}% ${s.discount_pct >= 0 ? 'below market' : 'above market'}</span>` : ''}</div>
          <div><span class="v3-muted">Shares your savings buy today</span><br><strong>${s.shares_now}</strong></div>
          <div><span class="v3-muted">Shares at the end</span><br><strong>${s.shares_at_maturity}</strong>
            ${s.cash_left_at_maturity > 0 ? `<span class="v3-muted" style="font-size:11px"> + ${fmtCurrency(s.cash_left_at_maturity)} cash</span>` : ''}</div>
          ${s.value_at_maturity != null ? `
          <div><span class="v3-muted">Worth at today's price</span><br><strong>${fmtCurrency(s.value_at_maturity)}</strong></div>
          <div><span class="v3-muted">${s.gain_at_maturity >= 0 ? 'Better than the cash by' : 'Worse than the cash by'}</span><br>
            <strong class="${s.gain_at_maturity >= 0 ? 'diff-pos' : 'diff-neg'}">${s.gain_at_maturity >= 0 ? '+' : '−'}${fmtCurrency(Math.abs(s.gain_at_maturity))}</strong></div>` : ''}
        </div>
        ${s.in_the_money === false ? `<div class="v3-muted" style="font-size:12px;margin-top:8px">Shares are currently below your option price, so taking the cash would be the better choice.</div>` : ''}
        ${s.current_price == null ? `<div class="v3-muted" style="font-size:12px;margin-top:8px">Add today's share price to see what they're worth.</div>` : ''}
      </div>` : '';

    return `
      <div class="card">
        <div class="card-body">
          <div class="v3-goal-head">
            <div>
              <div style="font-weight:700;font-size:15px">${icon} ${esc(p.name)}</div>
              <div class="v3-muted">${fmtCurrency(p.monthly_amount)}/month · ${p.duration_months} months · from ${fmtDate(p.start_date)}</div>
            </div>
            <div style="display:flex;gap:2px">
              <button class="btn-icon" data-sv-edit="${p.id}" title="Edit">✏️</button>
              <button class="btn-icon danger" data-sv-del="${p.id}" data-sv-name="${esc(p.name)}" title="Delete">&times;</button>
            </div>
          </div>

          <div class="v3-goal-figures">
            <div class="v3-goal-progress ${p.complete ? 'stat-value success' : ''}">${fmtCurrency(p.saved)}</div>
            <div class="v3-muted">of ${fmtCurrency(p.target)} · ${p.progress_pct}% · ${p.paid_months}/${p.duration_months} payments (${basis})</div>
          </div>
          ${V3.bar(p.progress_pct, p.complete ? 'success' : '')}

          <div style="margin-top:10px;font-size:12.5px">${status}</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;font-size:12.5px">
            <div><span class="v3-muted">Still to save</span><br><strong>${fmtCurrency(p.remaining)}</strong></div>
            <div><span class="v3-muted">Pays out</span><br><strong>${fmtCurrency(p.maturity_value)}</strong>${p.bonus > 0 ? `<span class="v3-muted" style="font-size:11px"> incl. ${fmtCurrency(p.bonus)} bonus</span>` : ''}</div>
            <div><span class="v3-muted">Next payment</span><br><strong>${p.next_payment ? fmtDate(p.next_payment) : '—'}</strong></div>
            <div><span class="v3-muted">Matures</span><br><strong>${fmtDate(p.maturity_date)}</strong></div>
          </div>
          ${p.notes ? `<div class="v3-muted" style="font-size:12px;margin-top:10px">📝 ${esc(p.notes)}</div>` : ''}
          ${shareBlock}
        </div>
      </div>`;
  },
});
