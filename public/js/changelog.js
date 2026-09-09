/* ─── What's New (Changelog) ───────────────────────────────────────────────
   Read straight from git history server-side (see /api/changelog in
   server.js) rather than hand-maintained, so it can never drift out of sync
   with what's actually shipped.
   ───────────────────────────────────────────────────────────────────────── */

const ChangelogView = {
  entries: [],
  expanded: null,   // version currently showing full details, or null
  mode: 'basic',     // 'basic' (plain bullets only) or 'descriptive' (full commit body)

  async init() {
    document.getElementById('view-changelog').innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text-muted)">Reading the history…</div>';
    try {
      const d = await API.getChangelog();
      this.entries = d.entries || [];
      this.currentVersion = d.currentVersion;
      this.expanded = this.entries[0]?.version || null;
      try { this.mode = localStorage.getItem('changelogMode') === 'descriptive' ? 'descriptive' : 'basic'; } catch (_) {}
      this.render();
    } catch (e) {
      document.getElementById('view-changelog').innerHTML =
        `<p style="color:var(--danger);padding:20px">Failed to load changelog: ${esc(e.message)}</p>`;
    }
  },

  // Commit bodies are free text; a "- " prefixed line is a deliberate
  // user-facing bullet, anything else is the deeper technical explanation
  // underneath it. Split them apart so Basic mode can show only the bullets
  // (plain, skimmable) while Descriptive keeps the full reasoning for anyone
  // who wants the whole story.
  _split(details) {
    if (!details) return { bullets: [], prose: [] };
    const lines = details.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = [], prose = [];
    for (const line of lines) {
      if (line.startsWith('- ')) bullets.push(line.slice(2));
      else prose.push(line);
    }
    return { bullets, prose };
  },

  _formatBasic(details) {
    const { bullets } = this._split(details);
    if (!bullets.length) return '';
    return `<ul style="margin:6px 0 0 18px;padding:0">${bullets.map(b => `<li style="margin-bottom:4px">${esc(b)}</li>`).join('')}</ul>`;
  },

  _formatDescriptive(details) {
    if (!details) return '';
    const { bullets, prose } = this._split(details);
    const html = [];
    if (bullets.length) html.push(`<ul style="margin:6px 0 10px 18px;padding:0">${bullets.map(b => `<li style="margin-bottom:4px">${esc(b)}</li>`).join('')}</ul>`);
    for (const line of prose) html.push(`<p style="margin:0 0 8px">${esc(line)}</p>`);
    return html.join('');
  },

  render() {
    const el = document.getElementById('view-changelog');

    if (!this.entries.length) {
      el.innerHTML = V3.empty
        ? V3.empty('📜', 'No changelog available', 'This deploy isn\'t running from a git checkout, so there\'s no history to read.')
        : '<p style="color:var(--text-muted);padding:20px">No changelog available.</p>';
      return;
    }

    el.innerHTML = `
      <div class="v3-hero" style="background:linear-gradient(135deg,#334155,#0F172A)">
        <button id="clModeToggle" class="btn btn-ghost btn-sm"
          style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,0.12);color:#fff;border-color:rgba(255,255,255,0.25)"
          title="Switch between a plain bullet summary and the full technical explanation">
          ${this.mode === 'basic' ? '📝 Descriptive' : '• Basic'}
        </button>
        <div class="v3-hero-label">WHAT'S NEW</div>
        <div class="v3-hero-value">v${esc(this.currentVersion || this.entries[0].version)}</div>
        <div class="v3-hero-sub">${this.entries.length} update${this.entries.length === 1 ? '' : 's'} on record, newest first.</div>
      </div>

      <div id="clList"></div>
    `;
    const hero = el.querySelector('.v3-hero');
    if (hero) hero.style.position = 'relative';
    document.getElementById('clModeToggle').addEventListener('click', () => {
      this.mode = this.mode === 'basic' ? 'descriptive' : 'basic';
      try { localStorage.setItem('changelogMode', this.mode); } catch (_) {}
      this.render();
    });
    this._renderList();
  },

  _renderList() {
    const list = document.getElementById('clList');
    const descriptive = this.mode === 'descriptive';
    list.innerHTML = this.entries.map(e => {
      const open = this.expanded === e.version;
      const body = descriptive ? this._formatDescriptive(e.details) : this._formatBasic(e.details);
      return `
        <div class="card" style="margin-bottom:12px">
          <button class="cl-entry-head" data-v="${esc(e.version)}"
            style="width:100%;text-align:left;background:none;border:none;padding:14px 18px;cursor:pointer;
                   display:flex;justify-content:space-between;align-items:center;gap:12px;color:inherit;font:inherit">
            <span>
              <span style="font-weight:700;font-size:14.5px">v${esc(e.version)}</span>
              <span style="margin-left:8px">${esc(e.summary)}</span>
            </span>
            <span style="display:flex;align-items:center;gap:10px;white-space:nowrap">
              <span class="v3-muted" style="font-size:12px">${e.date ? fmtDate(e.date) : ''}</span>
              <span style="transform:rotate(${open ? '90deg' : '0deg'});transition:transform 0.15s;font-size:12px">▸</span>
            </span>
          </button>
          ${open && body ? `
            <div style="padding:0 18px 16px;font-size:13px;color:var(--text-muted);line-height:1.5">
              ${body}
            </div>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('[data-v]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.v;
        this.expanded = this.expanded === v ? null : v;
        this._renderList();
      });
    });
  },
};
