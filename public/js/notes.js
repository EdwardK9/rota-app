/* ─── Notes View ───────────────────────────────────────────────────────────── */

const NotesView = {
  _saveTimer: null,

  async init() {
    this.render();
    await this.load();
  },

  render() {
    document.getElementById('view-notes').innerHTML = `
      <div style="max-width:720px;display:flex;flex-direction:column;height:calc(100vh - 80px);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0;">
          <p style="color:var(--text-muted);font-size:13px;margin:0">Jot down anything — features to add, things to check, reminders.</p>
          <span id="notesSaveStatus" style="font-size:12px;color:var(--text-muted);min-width:80px;text-align:right;"></span>
        </div>
        <textarea
          id="notesTextarea"
          placeholder="Start typing…"
          style="flex:1;width:100%;box-sizing:border-box;resize:none;font-size:14px;line-height:1.6;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:var(--text);font-family:inherit;outline:none;"
        ></textarea>
      </div>
    `;

    document.getElementById('notesTextarea').addEventListener('input', () => this._onInput());
  },

  async load() {
    try {
      const settings = await API.getSettings();
      document.getElementById('notesTextarea').value = settings.app_notes || '';
    } catch(e) { /* non-fatal */ }
  },

  _onInput() {
    const status = document.getElementById('notesSaveStatus');
    status.textContent = 'Unsaved…';
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 1000);
  },

  async _save() {
    const content = document.getElementById('notesTextarea').value;
    const status  = document.getElementById('notesSaveStatus');
    try {
      await API.saveSettings({ app_notes: content });
      status.textContent = 'Saved ✓';
      setTimeout(() => { if (status.textContent === 'Saved ✓') status.textContent = ''; }, 2000);
    } catch(e) {
      status.textContent = 'Save failed';
    }
  },
};
