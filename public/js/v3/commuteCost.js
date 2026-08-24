/* ─── ⛽ Commute Cost (V3.0) ───────────────────────────────────────────────
   What driving to work costs. The car settings live in this view rather than
   the main Settings screen, so the whole feature stays self-contained.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('commute-cost', '⛽ Commute Cost', {
  year: getCurrentYear(),
  data: null,

  async init() {
    document.getElementById('view-commute-cost').innerHTML = V3.loading('Checking the fuel gauge…');
    await this.load();
  },

  async load() {
    try {
      this.data = await V3.api.commuteCost(this.year);
      this.render();
    } catch (e) {
      document.getElementById('view-commute-cost').innerHTML = V3.error(e);
    }
  },

  async saveSettings() {
    const read = id => parseFloat(document.getElementById(id).value);
    const fuelType = document.getElementById('ccFuelType').value === 'electric' ? 'electric' : 'petrol';
    const payload = {
      fuel_type: fuelType,
      mpg: read('ccMpg'),
      fuel_price_ppl: read('ccPrice'),
      miles_per_kwh: read('ccMilesPerKwh'),
      elec_price_per_kwh: read('ccKwhPrice'),
      parking_per_shift: read('ccParking'),
      wear_per_mile: read('ccWear'),
    };
    if (fuelType === 'petrol' && (!payload.mpg || payload.mpg <= 0)) return showToast('MPG must be greater than zero', 'warning');
    if (fuelType === 'electric' && (!payload.miles_per_kwh || payload.miles_per_kwh <= 0)) return showToast('Miles/kWh must be greater than zero', 'warning');

    try {
      await V3.api.saveCommuteSettings(payload);
      showToast('Car settings saved', 'success');
      await this.load();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  render() {
    const d = this.data;
    const el = document.getElementById('view-commute-cost');
    const s = d.settings;

    if (!d.shifts) {
      el.innerHTML = V3.yearPicker('ccYear', this.year, true) +
        V3.empty('⛽', 'No completed shifts for this period', 'Pick another year to see the damage.');
      document.getElementById('ccYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
      return;
    }

    el.innerHTML = `
      ${V3.backButton()}
      ${V3.yearPicker('ccYear', this.year, true)}

      <div class="v3-hero" style="background:linear-gradient(135deg,#EF4444,#7F1D1D)">
        <div class="v3-hero-label">COST OF GETTING TO WORK</div>
        <div class="v3-hero-value">${fmtCurrency(d.cost.total)}</div>
        <div class="v3-hero-sub">
          across ${d.total_miles} miles and ${d.shifts} shifts — that's
          <strong>${d.impact.minutes_per_shift} minutes of every shift</strong> worked purely to cover the journey,
          or ${d.impact.pct_of_pay}% of your pay.
        </div>
      </div>

      <div class="v3-grid v3-grid-sm" style="margin-bottom:18px">
        ${V3.tile('Per shift',   fmtCurrency(d.cost.per_shift), 'Round trip')}
        ${V3.tile('Per mile',    fmtCurrency(d.cost.per_mile), 'Fuel + wear')}
        ${s.fuel_type === 'electric'
          ? V3.tile('Electricity used', d.cost.kwh_used + ' kWh', 'At the wall')
          : V3.tile('Fuel burned', d.cost.litres_burned + ' L', `~${d.cost.tank_fills} tank fills`)}
        ${V3.tile('Real hourly rate', fmtCurrency(d.impact.net_hourly),
                  `${fmtCurrency(d.impact.gross_hourly)} before travel`, 'warning')}
      </div>

      <div class="v3-grid v3-grid-lg">
        <div class="card">
          <div class="card-header"><h2>🧾 The breakdown</h2></div>
          <div class="card-body">
            <div style="display:flex;justify-content:space-between;padding:7px 0"><span>${s.fuel_type === 'electric' ? '🔌 Electricity' : '⛽ Fuel'}</span><strong>${fmtCurrency(d.cost.fuel)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:7px 0"><span>🔧 Wear &amp; tear</span><strong>${fmtCurrency(d.cost.wear)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:7px 0"><span>🅿️ Parking</span><strong>${fmtCurrency(d.cost.parking)}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:10px 0 0;border-top:1px solid var(--border);margin-top:6px">
              <strong>Total</strong><strong style="color:var(--danger)">${fmtCurrency(d.cost.total)}</strong>
            </div>

            <div class="v3-section-title">😬 Put another way</div>
            <ul style="font-size:13px;line-height:1.9;padding-left:20px;color:var(--text-muted)">
              <li>You worked roughly <strong style="color:var(--text)">${d.impact.shifts_worked_for_free} whole shifts</strong> just to pay for the driving.</li>
              <li>Your ${fmtCurrency(d.impact.gross_hourly)}/hr is really <strong style="color:var(--text)">${fmtCurrency(d.impact.net_hourly)}/hr</strong> once the car is paid for.</li>
              <li>At HMRC's ${(d.hmrc.rate_per_mile * 100).toFixed(0)}p/mile these miles would be worth <strong style="color:var(--text)">${fmtCurrency(d.hmrc.would_reimburse)}</strong>.</li>
            </ul>
            <div class="v3-note">${esc(d.hmrc.note)} Distances come from each shift's mileage field, doubled for the return leg.</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2>🚗 Your car</h2></div>
          <div class="card-body">
            <div class="form-row">
              <div class="form-group">
                <label>Fuel type</label>
                <select id="ccFuelType">
                  <option value="petrol" ${s.fuel_type !== 'electric' ? 'selected' : ''}>⛽ Petrol / diesel</option>
                  <option value="electric" ${s.fuel_type === 'electric' ? 'selected' : ''}>🔌 Electric</option>
                </select>
              </div>
            </div>
            <div id="ccPetrolFields" style="${s.fuel_type === 'electric' ? 'display:none' : ''}">
              <div class="form-row">
                <div class="form-group">
                  <label>Fuel economy (MPG)</label>
                  <input type="number" id="ccMpg" step="0.1" min="1" value="${s.mpg}" />
                </div>
                <div class="form-group">
                  <label>Fuel price (pence/litre)</label>
                  <input type="number" id="ccPrice" step="0.1" min="0" value="${s.fuel_price_ppl}" />
                </div>
              </div>
            </div>
            <div id="ccElectricFields" style="${s.fuel_type === 'electric' ? '' : 'display:none'}">
              <div class="form-row">
                <div class="form-group">
                  <label>Efficiency (miles/kWh)</label>
                  <input type="number" id="ccMilesPerKwh" step="0.1" min="0.1" value="${s.miles_per_kwh}" />
                </div>
                <div class="form-group">
                  <label>Electricity price (pence/kWh)</label>
                  <input type="number" id="ccKwhPrice" step="0.1" min="0" value="${s.elec_price_per_kwh}" />
                </div>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>Parking per shift (£)</label>
                <input type="number" id="ccParking" step="0.01" min="0" value="${s.parking_per_shift}" />
              </div>
              <div class="form-group">
                <label>Wear per mile (£)</label>
                <input type="number" id="ccWear" step="0.01" min="0" value="${s.wear_per_mile}" />
                <div class="form-hint">Tyres, servicing, depreciation.</div>
              </div>
            </div>
            <button class="btn btn-primary" id="ccSave">Save &amp; recalculate</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <div class="card-header"><h2>📆 Month by month</h2></div>
        <div class="card-body">
          ${V3.chart(d.monthly.map(m => ({
            label: V3.shortMonth(m.month),
            value: m.cost,
            title: `${m.month}: ${fmtCurrency(m.cost)} across ${m.miles} miles (${m.pct_of_pay}% of pay)`,
            heavy: m.pct_of_pay > d.impact.pct_of_pay,
          })), pt => (pt.heavy ? 'danger' : 'warning'))}
          <div class="v3-note">Red months cost you a bigger share of your pay than your overall average of ${d.impact.pct_of_pay}%.</div>
        </div>
      </div>
    `;

    document.getElementById('ccYear').addEventListener('change', e => { this.year = e.target.value; this.load(); });
    document.getElementById('ccSave').addEventListener('click', () => this.saveSettings());
    document.getElementById('ccFuelType').addEventListener('change', e => {
      const isElectric = e.target.value === 'electric';
      document.getElementById('ccPetrolFields').style.display = isElectric ? 'none' : '';
      document.getElementById('ccElectricFields').style.display = isElectric ? '' : 'none';
    });
  },
});
