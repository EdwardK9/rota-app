/* ─── What's New (Changelog) ───────────────────────────────────────────────
   Read straight from git history server-side (see /api/changelog in
   server.js) rather than hand-maintained, so it can never drift out of sync
   with what's actually shipped.
   ───────────────────────────────────────────────────────────────────────── */

const ChangelogView = {
  entries: [],
  expanded: null,   // version currently showing full details, or null

  async init() {
    document.getElementById('view-changelog').innerHTML =
      '<div style="text-align:center;padding:40px;color:var(--text-muted)">Reading the history…</div>';
    try {
      const d = await API.getChangelog();
      this.entries = d.entries || [];
      this.currentVersion = d.currentVersion;
      this.expanded = this.entries[0]?.version || null;
      this.render();
    } catch (e) {
      document.getElementById('view-changelog').innerHTML =
        `<p style="color:var(--danger);padding:20px">Failed to load changelog: ${esc(e.message)}</p>`;
    }
  },

  // Commit bodies are plain text with "- " bullet lines — turn those into a
  // real list, and leave anything else as plain paragraphs.
  _formatDetails(details) {
    if (!details) return '';
    const lines = details.split('\n').map(l => l.trim()).filter(Boolean);
    const html = [];
    let listBuf = [];
    const flush = () => {
      if (listBuf.length) html.push(`<ul style="margin:6px 0 10px 18px;padding:0">${listBuf.join('')}</ul>`);
      listBuf = [];
    };
    for (const line of lines) {
      if (line.startsWith('- ')) listBuf.push(`<li style="margin-bottom:4px">${esc(line.slice(2))}</li>`);
      else { flush(); html.push(`<p style="margin:0 0 8px">${esc(line)}</p>`); }
    }
    flush();
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
        <div class="v3-hero-label">WHAT'S NEW</div>
        <div class="v3-hero-value">v${esc(this.currentVersion || this.entries[0].version)}</div>
        <div class="v3-hero-sub">${this.entries.length} update${this.entries.length === 1 ? '' : 's'} on record, newest first.</div>
      </div>

      <div id="clList"></div>
    `;
    this._renderList();
  },

  _renderList() {
    const list = document.getElementById('clList');
    list.innerHTML = this.entries.map(e => {
      const open = this.expanded === e.version;
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
          ${open && e.details ? `
            <div style="padding:0 18px 16px;font-size:13px;color:var(--text-muted);line-height:1.5">
              ${this._formatDetails(e.details)}
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
