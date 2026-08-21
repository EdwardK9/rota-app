/* ─── 💸 Money Clock (V3.0) ────────────────────────────────────────────────
   A live earnings counter. The server hands over the current shift's window
   and a pence-per-second rate, then the ticker runs entirely client-side —
   one API call on open, one repaint a second, no polling.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('money-clock', '💸 Money Clock', {
  data: null,
  timer: null,
  loadedAt: 0,

  async init() {
    document.getElementById('view-money-clock').innerHTML = V3.loading('Winding up the clock…');
    await this.load();
  },

  /** Called by the router when navigating away — without this the ticker keeps
   *  running for the rest of the session. */
  destroy() {
    clearInterval(this.timer);
    this.timer = null;
  },

  async load() {
    try {
      this.data = await V3.api.moneyClock();
      this.loadedAt = Date.now();
      this.render();
      this.startTicking();
    } catch (e) {
      document.getElementById('view-money-clock').innerHTML = V3.error(e);
    }
  },

  startTicking() {
    clearInterval(this.timer);
    if (!this.data) return;
    // Only worth ticking while a shift is actually running; otherwise the page
    // is static and a timer would just burn battery.
    if (!this.data.live) return;
    this.timer = setInterval(() => this.tick(), 1000);
  },

  /** Seconds elapsed since the payload was fetched — the ticker extrapolates
   *  forward from the server's snapshot rather than trusting the client clock
   *  to agree with it. */
  _elapsedSinceLoad() {
    return (Date.now() - this.loadedAt) / 1000;
  },

  tick() {
    const d = this.data;
    const live = d.live;
    const earned = Math.min(live.shift_pay, live.earned_so_far + live.pay_per_second * this._elapsedSinceLoad());
    const elapsedMins = live.elapsed_mins + this._elapsedSinceLoad() / 60;
    const remaining = Math.max(0, live.total_mins - elapsedMins);
    const pctDone = Math.min(100, (elapsedMins / live.total_mins) * 100);

    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('mcLiveEarned', fmtCurrency(earned));
    set('mcLiveRemaining', this._hm(remaining));
    set('mcLiveElapsed', this._hm(elapsedMins));
    const bar = document.getElementById('mcLiveBar');
    if (bar) bar.style.width = pctDone.toFixed(2) + '%';

    // Every total that contains today's shift ticks along with it. The server
    // counts an in-progress shift at its FULL value, so swap that out for what
    // has actually been earned so far — otherwise the headline would say £25
    // while "today" already claimed the whole £60.
    const accrued = earned - live.shift_pay;                  // negative until the shift ends
    const hoursAccrued = (live.paid_hours * (Math.min(1, elapsedMins / live.total_mins))) - live.paid_hours;

    set('mcToday',    fmtCurrency(d.totals.today + accrued));
    set('mcWeek',     fmtCurrency(d.totals.week + accrued));
    set('mcMonth',    fmtCurrency(d.totals.month + accrued));
    set('mcYear',     fmtCurrency(d.totals.year + accrued));
    set('mcLifetime', fmtCurrency(d.totals.lifetime + accrued));
    set('mcLifetimeHours', (Math.round((d.totals.lifetime_hours + hoursAccrued) * 100) / 100).toFixed(2) + 'h');
    set('mcAccrued',  fmtCurrency(d.payday.accrued_since_last + accrued));

    const perShift = d.totals.lifetime_shifts
      ? (d.totals.lifetime + accrued) / d.totals.lifetime_shifts : 0;
    set('mcPerShift', fmtCurrency(perShift));

    // Shift finished while the page was open — refresh so the totals catch up.
    if (remaining <= 0) { this.destroy(); this.load(); }
  },

  /** Value as it should read right now: mid-shift the server's totals overstate
   *  today's shift, so the first paint matches what the ticker will show. */
  _now(total) {
    const live = this.data.live;
    if (!live) return total;
    return total - live.shift_pay + live.earned_so_far;
  },

  /** Same idea for hours: an in-progress shift only counts pro-rata. */
  _nowHours(total) {
    const live = this.data.live;
    if (!live || !live.total_mins) return total;
    const done = Math.min(1, live.elapsed_mins / live.total_mins);
    return total - live.paid_hours + (live.paid_hours * done);
  },

  _hm(mins) {
    const total = Math.max(0, Math.round(mins));
    return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-money-clock');

    const hero = d.live ? `
      <div class="v3-hero" style="background:linear-gradient(135deg,#10B981,#065F46)">
        <div class="v3-hero-label">ON SHIFT · ${d.live.start_time}–${d.live.end_time}${d.live.is_bank_holiday ? ' · BANK HOLIDAY (2×)' : ''}</div>
        <div class="v3-hero-value" id="mcLiveEarned">${fmtCurrency(d.live.earned_so_far)}</div>
        <div class="v3-hero-sub">
          earned so far of ${fmtCurrency(d.live.shift_pay)} ·
          <span id="mcLiveElapsed">${this._hm(d.live.elapsed_mins)}</span> in,
          <span id="mcLiveRemaining">${this._hm(d.live.remaining_mins)}</span> to go
        </div>
        <div class="v3-hero-bar"><span id="mcLiveBar" style="width:${d.live.progress_pct}%"></span></div>
      </div>`
    : `
      <div class="v3-hero" style="background:linear-gradient(135deg,#3B82F6,#1B2A4A)">
        <div class="v3-hero-label">NOT ON SHIFT</div>
        <div class="v3-hero-value">${fmtCurrency(d.totals.today)}</div>
        <div class="v3-hero-sub">
          earned today${d.next_shift
            ? ` · next shift ${fmtDate(d.next_shift.date)} at ${d.next_shift.start_time} (${V3.relativeDays(d.next_shift.days_away)}), worth ${fmtCurrency(d.next_shift.pay)}`
            : ' · nothing scheduled yet'}
        </div>
      </div>`;

    const payday = d.payday;
    const paydayPct = payday.days_away >= 0 ? Math.max(0, 100 - (payday.days_away / 31) * 100) : 100;

    el.innerHTML = `
      ${hero}

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Today',      `<span id="mcToday">${fmtCurrency(this._now(d.totals.today))}</span>`)}
        ${V3.tile('This week',  `<span id="mcWeek">${fmtCurrency(this._now(d.totals.week))}</span>`)}
        ${V3.tile('This month', `<span id="mcMonth">${fmtCurrency(this._now(d.totals.month))}</span>`)}
        ${V3.tile('This year',  `<span id="mcYear">${fmtCurrency(this._now(d.totals.year))}</span>`)}
        ${V3.tile('Current rate', d.current_rate ? fmtCurrency(d.current_rate) + '/hr' : '—',
          d.live ? `+${fmtCurrency(d.live.pay_per_second * 60)}/min right now` : '')}
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>💷 Next payday</h2></div>
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <div>
                <div style="font-size:32px;font-weight:800">${payday.days_away === 0 ? 'Today' : payday.days_away}</div>
                <div class="v3-muted">${payday.days_away === 0 ? 'money lands today' : payday.days_away === 1 ? 'day to go' : 'days to go'}</div>
              </div>
              <div style="text-align:right">
                <div style="font-weight:700">${fmtDate(payday.date)}</div>
                <div class="v3-muted">usually the ${payday.day_of_month}${this._ord(payday.day_of_month)}</div>
              </div>
            </div>
            ${V3.bar(paydayPct, 'success')}
            <div style="margin-top:14px;display:flex;justify-content:space-between;font-size:13px">
              <span class="v3-muted">
                Earned since last payday (${fmtDate(payday.last_payday)})
                ${payday.accrued_shifts ? `<br><span style="font-size:11.5px">${payday.accrued_shifts} shift${payday.accrued_shifts === 1 ? '' : 's'} from ${fmtDate(payday.accrued_from)}</span>` : ''}
              </span>
              <strong id="mcAccrued">${fmtCurrency(this._now(payday.accrued_since_last))}</strong>
            </div>
            ${payday.last_net != null ? `
              <div style="margin-top:6px;display:flex;justify-content:space-between;font-size:13px">
                <span class="v3-muted">Last payslip (${fmtMonth(payday.last_month)})</span>
                <strong>${fmtCurrency(payday.last_net)} net</strong>
              </div>` : ''}
            <div class="v3-note">
              The payday date is worked out from the dates on your logged payslips, pulled back to
              the Friday when it would otherwise land on a weekend. Amounts here are gross shift pay,
              before tax and NI.
              <br><br>
              "Earned since last payday" is a rough guide, not what this payslip will say — monthly
              payroll cuts off before payday, so the most recent shifts usually land on the month after.
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>🏛️ Since day one</h2></div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
              <div>
                <div class="v3-tile-label">Total earned</div>
                <div style="font-size:26px;font-weight:800;color:var(--success)"
                     id="mcLifetime">${fmtCurrency(this._now(d.totals.lifetime))}</div>
              </div>
              <div>
                <div class="v3-tile-label">Total hours</div>
                <div style="font-size:26px;font-weight:800" id="mcLifetimeHours">${this._nowHours(d.totals.lifetime_hours).toFixed(2)}h</div>
              </div>
              <div>
                <div class="v3-tile-label">Shifts logged</div>
                <div style="font-size:20px;font-weight:700">${d.totals.lifetime_shifts}</div>
              </div>
              <div>
                <div class="v3-tile-label">Average per shift</div>
                <div style="font-size:20px;font-weight:700" id="mcPerShift">
                  ${d.totals.lifetime_shifts ? fmtCurrency(this._now(d.totals.lifetime) / d.totals.lifetime_shifts) : '—'}
                </div>
              </div>
            </div>
            <div class="v3-note">
              Every figure on this page comes from your logged shifts, priced at the rate that
              applied on the day — so a rate rise partway through a year is already accounted for.
            </div>
          </div>
        </div>
      </div>
    `;
  },

  _ord(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  },
});
