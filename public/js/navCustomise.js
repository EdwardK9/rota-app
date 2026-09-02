/* ─── Custom sidebar layout ────────────────────────────────────────────────
   Lets the sidebar be rearranged: drag tabs into whatever order you like,
   make your own groups, move tabs between them, rename them.

   The default layout still lives in index.html's markup rather than a list in
   here — this module reads that markup on boot and treats it as the default.
   That way a tab added to index.html later appears on its own (dropped into
   its default group if that group still exists, otherwise at the bottom)
   instead of being invisible to anyone with a saved layout.

   Saved server-side in settings.nav_layout, so the layout follows you between
   the phone and the desktop rather than living in one browser's localStorage.
   ───────────────────────────────────────────────────────────────────────── */

const NavCustomise = {
  KEY: '_nav_layout',
  _defaults: null,     // { entries: [...], views: { view: {label, icon} }, groupOf: { view: groupId } }
  _model: null,        // what's on screen now
  _saved: null,        // last persisted model (for Cancel)
  _editing: false,

  // ── Boot ──────────────────────────────────────────────────────────────────

  apply(settings) {
    this._defaults = this._readDefaults();
    let saved = null;
    try {
      const raw = settings && settings[this.KEY];
      if (raw) saved = JSON.parse(raw);
    } catch (_) { /* corrupt layout — fall back to the default */ }
    this._saved = Array.isArray(saved) ? saved : null;
    this._model = this._merge(this._saved);
    this._render();
  },

  // The static markup, read once, as { entries, views, groupOf }
  _readDefaults() {
    const views = {}, groupOf = {}, entries = [];
    const readLink = (a) => {
      const view  = a.dataset.view;
      const icon  = a.querySelector('.nav-icon')?.textContent || '';
      const label = a.querySelector('.nav-label')?.textContent || view;
      views[view] = { label, icon };
      return { type: 'link', view };
    };
    document.querySelectorAll('.nav-links > li').forEach(li => {
      if (li.classList.contains('nav-group')) {
        const id    = li.dataset.group;
        const head  = li.querySelector('.nav-group-header');
        const items = [...li.querySelectorAll('.nav-sublinks .nav-link')].map(a => {
          groupOf[a.dataset.view] = id;
          return readLink(a);
        });
        entries.push({
          type: 'group', id,
          label: head?.querySelector('.nav-label')?.textContent || id,
          icon:  head?.querySelector('.nav-icon')?.textContent || '📁',
          items,
        });
      } else {
        const a = li.querySelector('.nav-link');
        if (a) entries.push(readLink(a));
      }
    });
    return { entries, views, groupOf };
  },

  // Saved layout + anything new since it was saved. Unknown views are dropped
  // (a tab removed from the app shouldn't leave a dead entry behind).
  _merge(saved) {
    const d = this._defaults;
    if (!saved) return JSON.parse(JSON.stringify(d.entries));

    const known = new Set(Object.keys(d.views));
    const used  = new Set();
    const out   = [];
    for (const e of saved) {
      if (e && e.type === 'group') {
        const items = (e.items || [])
          .map(v => (typeof v === 'string' ? v : v?.view))
          .filter(v => known.has(v) && !used.has(v));
        items.forEach(v => used.add(v));
        out.push({
          type: 'group',
          id: e.id || 'g' + Math.random().toString(36).slice(2, 8),
          label: e.label || 'Group',
          icon:  e.icon  || '📁',
          items: items.map(v => ({ type: 'link', view: v })),
        });
      } else if (e && e.type === 'link' && known.has(e.view) && !used.has(e.view)) {
        used.add(e.view);
        out.push({ type: 'link', view: e.view });
      }
    }

    // Anything in the default markup the saved layout has never seen
    const byId = new Map(out.filter(e => e.type === 'group').map(g => [g.id, g]));
    for (const view of Object.keys(d.views)) {
      if (used.has(view)) continue;
      const home = byId.get(d.groupOf[view]);
      if (home) home.items.push({ type: 'link', view });
      else out.push({ type: 'link', view });
    }
    return out;
  },

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    const ul = document.querySelector('.nav-links');
    if (!ul) return;
    const openState = JSON.parse(localStorage.getItem('navGroups') || '{}');
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const linkHtml = (view) => {
      const v = this._defaults.views[view] || { label: view, icon: '' };
      return `<li>${this._editing ? this._handleHtml() : ''}<a href="#" class="nav-link" data-view="${esc(view)}">` +
        `<span class="nav-icon">${esc(v.icon)}</span><span class="nav-label">${esc(v.label)}</span></a></li>`;
    };

    ul.innerHTML = this._model.map(e => {
      if (e.type === 'link') return linkHtml(e.view);
      // Groups are all forced open while editing so there's somewhere to drop into
      const open = this._editing || openState[e.id] ? ' open' : '';
      const kids = e.items.map(i => linkHtml(i.view)).join('')
        || (this._editing ? '<li class="nav-empty-slot">drop a tab here</li>' : '');
      return `
        <li class="nav-group${open}" data-group="${esc(e.id)}">
          ${this._editing ? this._handleHtml() : ''}
          <button class="nav-group-header" type="button">
            <span class="nav-icon">${esc(e.icon)}</span><span class="nav-label">${esc(e.label)}</span>
            <span class="nav-chevron">▸</span>
          </button>
          ${this._editing ? `<span class="nav-edit-actions">
            <button type="button" class="nav-edit-btn" data-rename-group title="Rename">✏️</button>
            <button type="button" class="nav-edit-btn" data-delete-group title="Delete group">✕</button>
          </span>` : ''}
          <ul class="nav-sublinks">${kids}</ul>
        </li>`;
    }).join('');

    document.getElementById('sidebar')?.classList.toggle('nav-editing', this._editing);
    ul.querySelectorAll('.nav-link').forEach(l =>
      l.classList.toggle('active', l.dataset.view === App.currentView));

    App._wireNav?.();
    if (this._editing) this._wireEditing();
    this._mountEditButton();
  },

  _handleHtml() { return '<span class="nav-drag" title="Drag to move">⠿</span>'; },

  // The Edit/Save/Cancel controls live in the sidebar footer, next to dark mode
  _mountEditButton() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return;
    let bar = document.getElementById('navEditBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'navEditBar';
      footer.insertBefore(bar, footer.firstChild);
    }
    bar.innerHTML = this._editing
      ? `<button type="button" class="nav-edit-action" data-nav-new>＋ Group</button>
         <button type="button" class="nav-edit-action nav-edit-save" data-nav-save>Save</button>
         <button type="button" class="nav-edit-action" data-nav-cancel>Cancel</button>
         <button type="button" class="nav-edit-action" data-nav-reset>Reset</button>`
      : `<button type="button" class="nav-edit-action" data-nav-edit>✏️ Edit menu</button>`;

    bar.querySelector('[data-nav-edit]')  ?.addEventListener('click', () => this.startEditing());
    bar.querySelector('[data-nav-new]')   ?.addEventListener('click', () => this.newGroup());
    bar.querySelector('[data-nav-save]')  ?.addEventListener('click', () => this.save());
    bar.querySelector('[data-nav-cancel]')?.addEventListener('click', () => this.cancel());
    bar.querySelector('[data-nav-reset]') ?.addEventListener('click', () => this.reset());
  },

  // ── Editing ───────────────────────────────────────────────────────────────

  startEditing() {
    this._editing = true;
    this._render();
    showToast('Drag ⠿ to move tabs and groups, then Save', 'success');
  },

  cancel() {
    this._editing = false;
    this._model = this._merge(this._saved);
    this._render();
  },

  newGroup() {
    const label = (window.prompt('Name for the new group?') || '').trim();
    if (!label) return;
    const icon = (window.prompt('An emoji for it? (optional)', '📁') || '📁').trim() || '📁';
    this._model = this._readDom();
    this._model.push({ type: 'group', id: 'g' + Date.now().toString(36), label, icon, items: [] });
    this._render();
  },

  async save() {
    this._model = this._readDom();
    const payload = this._model.map(e => e.type === 'group'
      ? { type: 'group', id: e.id, label: e.label, icon: e.icon, items: e.items.map(i => i.view) }
      : { type: 'link', view: e.view });
    try {
      await API.saveSettings({ [this.KEY]: JSON.stringify(payload) });
      this._saved = payload;
      this._editing = false;
      this._render();
      showToast('Menu saved ✓', 'success');
    } catch (e) {
      showToast('Could not save the menu: ' + e.message, 'error');
    }
  },

  async reset() {
    if (!confirmAction('Put the menu back to the default layout?')) return;
    try {
      await API.saveSettings({ [this.KEY]: '' });
      this._saved = null;
      this._editing = false;
      this._model = this._merge(null);
      this._render();
      showToast('Menu reset to default', 'success');
    } catch (e) {
      showToast('Could not reset the menu: ' + e.message, 'error');
    }
  },

  // The DOM is the source of truth mid-edit (dragging moves real elements), so
  // saving reads it back rather than trying to mirror every move in the model.
  _readDom() {
    const labels = new Map(this._model.filter(e => e.type === 'group').map(g => [g.id, g]));
    const out = [];
    document.querySelectorAll('.nav-links > li').forEach(li => {
      if (li.classList.contains('nav-group')) {
        const id = li.dataset.group;
        const was = labels.get(id) || {};
        out.push({
          type: 'group', id,
          label: li.querySelector('.nav-group-header .nav-label')?.textContent || was.label || 'Group',
          icon:  li.querySelector('.nav-group-header .nav-icon')?.textContent  || was.icon  || '📁',
          items: [...li.querySelectorAll('.nav-sublinks .nav-link')].map(a => ({ type: 'link', view: a.dataset.view })),
        });
      } else {
        const a = li.querySelector('.nav-link');
        if (a) out.push({ type: 'link', view: a.dataset.view });
      }
    });
    return out;
  },

  _wireEditing() {
    const ul = document.querySelector('.nav-links');

    ul.querySelectorAll('[data-rename-group]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.closest('.nav-group');
      const labelEl = li.querySelector('.nav-group-header .nav-label');
      const iconEl  = li.querySelector('.nav-group-header .nav-icon');
      const label = (window.prompt('Group name?', labelEl.textContent) || '').trim();
      if (!label) return;
      labelEl.textContent = label;
      const icon = (window.prompt('Emoji for it?', iconEl.textContent) || '').trim();
      if (icon) iconEl.textContent = icon;
      this._model = this._readDom();
    }));

    // Deleting a group keeps its tabs — they move out to the top level rather
    // than disappearing along with the folder.
    ul.querySelectorAll('[data-delete-group]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.closest('.nav-group');
      const kids = [...li.querySelectorAll('.nav-sublinks > li')].filter(k => k.querySelector('.nav-link'));
      kids.reverse().forEach(k => li.after(k));
      li.remove();
      this._model = this._readDom();
      this._render();
    }));

    // Pointer-based drag so it works with a finger as well as a mouse — HTML5
    // drag-and-drop does nothing on touch. The pointer is captured by the list
    // rather than the handle: dropping a row means moving it in the DOM, and a
    // captured element loses its capture the moment it's detached, which used
    // to strand the drag after the first move.
    if (!this._dragWired) {
      this._dragWired = true;
      ul.addEventListener('pointermove', e => {
        const d = this._drag;
        if (!d) return;
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('li');
        if (!over || over === d.li || d.li.contains(over)) return;
        const list = over.parentElement;
        if (!list.classList.contains('nav-links') && !list.classList.contains('nav-sublinks')) return;
        // Groups don't nest, so a group only ever moves among the top-level rows
        if (d.isGroup && !list.classList.contains('nav-links')) return;
        const r = over.getBoundingClientRect();
        list.insertBefore(d.li, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
      });
      const drop = (e) => {
        const d = this._drag;
        if (!d) return;
        this._drag = null;
        d.li.classList.remove('nav-dragging');
        try { ul.releasePointerCapture(e.pointerId); } catch (_) {}
        // Re-render so empty-group placeholders appear/disappear as needed
        this._model = this._readDom();
        this._render();
      };
      ul.addEventListener('pointerup', drop);
      ul.addEventListener('pointercancel', drop);
    }

    ul.querySelectorAll('.nav-drag').forEach(handle => {
      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        const li = handle.closest('li');
        this._drag = { li, isGroup: li.classList.contains('nav-group') };
        li.classList.add('nav-dragging');
        ul.setPointerCapture(e.pointerId);
      });
    });
  },
};
