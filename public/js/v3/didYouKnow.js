/* ─── 🎲 Did You Know (V3.0) ───────────────────────────────────────────────
   A deck of oddities from your own data. Shows a few at a time with a shuffle,
   so it stays a "huh, really?" rather than a wall of statistics.
   ───────────────────────────────────────────────────────────────────────── */

V3.register('did-you-know', '🎲 Did You Know', {
  facts: [],
  page: 0,
  PER_PAGE: 4,
  aiState: 'idle',   // 'idle' | 'loading' | 'done' | 'error'
  aiFact: null,
  aiError: null,
  aiLoadingHint: '',

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

      <div class="card" style="margin-top:20px" id="dykAiCard"></div>
    `;

    document.getElementById('dykMore').addEventListener('click', () => {
      this.page += 1;
      this.render();
      document.getElementById('view-did-you-know').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    this.renderAiCard();
  },

  renderAiCard() {
    const card = document.getElementById('dykAiCard');
    if (!card) return;

    const body = {
      idle: `
        <div class="card-body" style="text-align:center;padding:24px">
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
            Everything above is a fixed formula. This one asks Gemini to find a fresh angle on the
            same kind of numbers — a different comparison every time you ask.
          </div>
          <button class="btn btn-primary" id="dykAiBtn">🤖 Ask Gemini for a fact</button>
        </div>`,
      loading: `
        <div class="card-body" style="text-align:center;padding:24px;color:var(--text-muted)">
          ${esc(this.aiLoadingHint || 'Thinking of something…')}
        </div>`,
      done: `
        <div class="card-header"><h2>🤖 AI Bonus Fact</h2></div>
        <div class="card-body">
          <div style="font-size:15px;font-weight:600;line-height:1.4">${esc(this.aiFact)}</div>
          <button class="btn btn-ghost btn-sm" id="dykAiBtn" style="margin-top:14px">🔄 Get another</button>
        </div>`,
      error: `
        <div class="card-body">
          <p style="color:var(--danger);font-size:13px">${esc(this.aiError)}</p>
          <button class="btn btn-ghost btn-sm" id="dykAiBtn">Try again</button>
        </div>`,
    }[this.aiState];

    card.innerHTML = body;
    document.getElementById('dykAiBtn')?.addEventListener('click', () => this.loadAiFact());
  },

  async loadAiFact() {
    this.aiState = 'loading';
    this.aiLoadingHint = '';
    this.renderAiCard();

    // The server retries against another model if the first one is overloaded
    // or unresponsive (up to ~10s per attempt) — worth saying so once it's
    // taking a moment, so a longer wait reads as "working on it" rather than
    // "stuck".
    const hintTimers = [
      setTimeout(() => { this.aiLoadingHint = 'Still thinking… the first model it tried may be busy.'; this.renderAiCard(); }, 6000),
      setTimeout(() => { this.aiLoadingHint = 'Trying another model — almost there.'; this.renderAiCard(); }, 16000),
    ];

    try {
      const d = await V3.api.didYouKnowAI();
      this.aiFact = d.fact;
      this.aiState = 'done';
    } catch (e) {
      this.aiError = e.message;
      this.aiState = 'error';
    }
    hintTimers.forEach(clearTimeout);
    this.renderAiCard();
  },
});
