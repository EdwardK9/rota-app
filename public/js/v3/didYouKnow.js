/* ─── 🎲 Did You Know (V3.0) ───────────────────────────────────────────────
   A deck of oddities from your own data. Shows a few at a time with a shuffle,
   so it stays a "huh, really?" rather than a wall of statistics.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('did-you-know', '🎲 Did You Know', {
  facts: [],
  page: 0,
  PER_PAGE: 4,

  GRADIENTS: [
    'linear-gradient(135deg,#3B82F6,#1B2A4A)',
    'linear-gradient(135deg,#10B981,#065F46)',
    'linear-gradient(135deg,#F59E0B,#92400E)',
    'linear-gradient(135deg,#EC4899,#831843)',
    'linear-gradient(135deg,#8B5CF6,#4C1D95)',
    'linear-gradient(135deg,#0EA5E9,#0C4A6E)',
  ],

  async init() {
    document.getElementById('view-did-you-know').innerHTML = V3.loading('Digging up something odd…');
    try {
      const d = await V3.api.didYouKnow();
      this.facts = d.facts;
      this.page = 0;
      this.render();
    } catch (e) {
      document.getElementById('view-did-you-know').innerHTML = V3.error(e);
    }
  },

  render() {
    const el = document.getElementById('view-did-you-know');

    if (!this.facts.length) {
      el.innerHTML = V3.empty('🎲', 'Nothing to tell you yet',
        'Log a few more shifts and the oddities start appearing.');
      return;
    }

    const pages = Math.ceil(this.facts.length / this.PER_PAGE);
    const start = (this.page % pages) * this.PER_PAGE;
    const slice = this.facts.slice(start, start + this.PER_PAGE);

    el.innerHTML = `
      ${V3.backButton()}
      <p class="v3-intro">
        Things your own data knows about you that no other view is ever going to mention.
        All of it is derived from your logged shifts, clock-ins and colleagues.
      </p>

      <div class="v3-grid v3-grid-lg">
        ${slice.map((f, i) => `
          <div class="v3-hero" style="background:${this.GRADIENTS[(start + i) % this.GRADIENTS.length]};margin-bottom:0">
            <div style="font-size:30px;line-height:1;margin-bottom:10px">${f.icon}</div>
            <div style="font-size:17px;font-weight:700;line-height:1.35">${esc(f.text)}</div>
            ${f.detail ? `<div class="v3-hero-sub" style="margin-top:10px">${esc(f.detail)}</div>` : ''}
          </div>`).join('')}
      </div>

      <div style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:20px">
        <button class="btn btn-primary" id="dykMore">🎲 Show me more</button>
        <span class="v3-muted">${start + 1}–${Math.min(start + this.PER_PAGE, this.facts.length)} of ${this.facts.length}</span>
      </div>
    `;

    document.getElementById('dykMore').addEventListener('click', () => {
      this.page += 1;
      this.render();
      document.getElementById('view-did-you-know').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  },
});
