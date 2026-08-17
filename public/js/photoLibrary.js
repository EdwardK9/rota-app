/* ─── Photo Library ────────────────────────────────────────────────────────── */

const PhotoLibrary = {
  folders: [],
  currentFolder: null,   // { id, name }
  currentFiles: [],
  selectedIds: new Set(),

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    const el = document.getElementById('view-photo-library');
    el.innerHTML = `
      <div style="max-width:960px">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
          <h2 style="margin:0">Photo Library</h2>
          <button class="btn btn-primary" id="plNewFolderBtn">+ New Folder</button>
        </div>

        <!-- Folder list -->
        <div id="plFolderView">
          <div id="plFolderGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px"></div>
          <p id="plNoFolders" style="display:none;color:var(--text-muted);margin-top:20px">
            No folders yet — create one to start organising your screenshots.
          </p>
        </div>

        <!-- Files inside a folder -->
        <div id="plFileView" style="display:none">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" id="plBackBtn">← Back</button>
            <h3 id="plFolderTitle" style="margin:0;flex:1"></h3>
            <button class="btn btn-ghost btn-sm" id="plRenameFolderBtn">Rename</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" id="plDeleteFolderBtn">Delete folder</button>
          </div>

          <!-- Upload drop zone -->
          <div class="drop-zone" id="plDropZone" style="margin-bottom:8px">
            <div class="drop-zone-icon">📷</div>
            <div class="drop-zone-text">Drop screenshots here or click to upload</div>
            <div class="drop-zone-hint">PNG, JPG — multiple files supported</div>
            <input type="file" id="plFileInput" accept="image/*" multiple style="display:none" />
          </div>
          <label class="toggle-label" style="font-weight:400;margin-bottom:16px">
            <input type="checkbox" id="plAutoRenameOnUpload" />
            <span>🏷️ Auto-rename with AI on upload</span>
            <span class="toggle-hint">Reads the week from each screenshot, no shifts are imported</span>
          </label>

          <!-- Selection toolbar (hidden until selection) -->
          <div id="plSelectionBar" style="display:none;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;
               background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
            <span id="plSelectionCount" style="font-weight:600;color:var(--text)"></span>
            <button class="btn btn-primary btn-sm" id="plQueueServerBtn">🤖 Queue — Ollama (Server)</button>
            <button class="btn btn-ghost btn-sm" id="plQueueRemoteBtn">💻 Queue — My PC</button>
            <button class="btn btn-ghost btn-sm" id="plDownloadSelectedBtn">⬇ Download</button>
            <button class="btn btn-ghost btn-sm" id="plAiRenameSelectedBtn">🏷️ AI Rename</button>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--danger)" id="plDeleteSelectedBtn">Delete selected</button>
            <button class="btn btn-ghost btn-sm" id="plClearSelectionBtn">✕ Clear</button>
          </div>

          <div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
            <input type="text" id="plSearchInput" placeholder="🔍 Search filename or week (e.g. 17.08)" style="max-width:280px" />
            <select id="plFilterMode" style="max-width:190px">
              <option value="all">All photos</option>
              <option value="renamed">🏷️ Renamed only</option>
              <option value="unrenamed">⚠️ Not renamed</option>
            </select>
            <span id="plFilterCount" style="font-size:12px;color:var(--text-muted)"></span>
          </div>

          <div style="margin-bottom:10px">
            <button class="btn btn-ghost btn-sm" id="plSelectAllBtn">☑ Select All</button>
          </div>

          <!-- Photo grid -->
          <div id="plPhotoGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px"></div>
          <p id="plNoFiles" style="display:none;color:var(--text-muted);margin-top:16px">
            No photos in this folder yet — drop some above.
          </p>
        </div>
      </div>
    `;
    this.bindEvents();
    this.loadFolders();
  },

  // ── Events ────────────────────────────────────────────────────────────────

  bindEvents() {
    document.getElementById('plNewFolderBtn').addEventListener('click', () => this.createFolder());
    document.getElementById('plBackBtn').addEventListener('click', () => this.showFolderView());
    document.getElementById('plRenameFolderBtn').addEventListener('click', () => this.renameFolder());
    document.getElementById('plDeleteFolderBtn').addEventListener('click', () => this.deleteFolder());
    document.getElementById('plClearSelectionBtn').addEventListener('click', () => this.clearSelection());
    document.getElementById('plDeleteSelectedBtn').addEventListener('click', () => this.deleteSelected());
    document.getElementById('plDownloadSelectedBtn').addEventListener('click', () => this.downloadSelected());
    document.getElementById('plAiRenameSelectedBtn').addEventListener('click', () => this.aiRenameSelected());
    document.getElementById('plSelectAllBtn').addEventListener('click', () => this.toggleSelectAll());
    document.getElementById('plSearchInput').addEventListener('input', () => this.renderPhotoGrid());
    document.getElementById('plFilterMode').addEventListener('change', () => this.renderPhotoGrid());
    document.getElementById('plQueueServerBtn').addEventListener('click', () => this.queueSelected('server'));
    document.getElementById('plQueueRemoteBtn').addEventListener('click', () => this.queueSelected('remote'));

    const dropZone = document.getElementById('plDropZone');
    const fileInput = document.getElementById('plFileInput');

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => this.uploadFiles(e.target.files));

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      this.uploadFiles(e.dataTransfer.files);
    });
  },

  // ── Folders ───────────────────────────────────────────────────────────────

  async loadFolders() {
    try {
      const { folders } = await API.get('/api/photo-library/folders');
      this.folders = folders;
      this.renderFolderGrid();
    } catch(e) {
      showToast('Failed to load folders', 'error');
    }
  },

  renderFolderGrid() {
    const grid = document.getElementById('plFolderGrid');
    const empty = document.getElementById('plNoFolders');
    if (!this.folders.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = this.folders.map(f => `
      <div class="card" style="cursor:pointer;padding:16px;text-align:center;transition:box-shadow 0.15s"
           onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'"
           onmouseout="this.style.boxShadow=''"
           data-folder-id="${f.id}">
        <div style="font-size:32px;margin-bottom:8px">📁</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;word-break:break-word">${esc(f.name)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${f.file_count} photo${f.file_count !== 1 ? 's' : ''}</div>
      </div>
    `).join('');
    grid.querySelectorAll('[data-folder-id]').forEach(el => {
      el.addEventListener('click', () => {
        const folder = this.folders.find(f => f.id === parseInt(el.dataset.folderId));
        if (folder) this.openFolder(folder);
      });
    });
  },

  async createFolder() {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    try {
      await API.post('/api/photo-library/folders', { name: name.trim() });
      await this.loadFolders();
    } catch(e) {
      showToast('Failed to create folder', 'error');
    }
  },

  async renameFolder() {
    if (!this.currentFolder) return;
    const name = prompt('New name:', this.currentFolder.name);
    if (!name || !name.trim()) return;
    try {
      await API.patch(`/api/photo-library/folders/${this.currentFolder.id}`, { name: name.trim() });
      this.currentFolder.name = name.trim();
      document.getElementById('plFolderTitle').textContent = name.trim();
      await this.loadFolders();
    } catch(e) {
      showToast('Failed to rename folder', 'error');
    }
  },

  async deleteFolder() {
    if (!this.currentFolder) return;
    if (!confirm(`Delete folder "${this.currentFolder.name}" and all its photos? This cannot be undone.`)) return;
    try {
      await API.delete(`/api/photo-library/folders/${this.currentFolder.id}`);
      this.showFolderView();
      await this.loadFolders();
      showToast('Folder deleted', 'success');
    } catch(e) {
      showToast('Failed to delete folder', 'error');
    }
  },

  // ── Files ─────────────────────────────────────────────────────────────────

  async openFolder(folder) {
    this.currentFolder = folder;
    this.selectedIds = new Set();
    document.getElementById('plFolderView').style.display = 'none';
    document.getElementById('plFileView').style.display = 'block';
    document.getElementById('plFolderTitle').textContent = folder.name;
    document.getElementById('plNewFolderBtn').style.display = 'none';
    document.getElementById('plSearchInput').value = '';
    document.getElementById('plFilterMode').value = 'all';
    await this.loadFiles();
  },

  showFolderView() {
    this.currentFolder = null;
    this.selectedIds = new Set();
    document.getElementById('plFolderView').style.display = 'block';
    document.getElementById('plFileView').style.display = 'none';
    document.getElementById('plNewFolderBtn').style.display = '';
    this.loadFolders();
  },

  async loadFiles() {
    if (!this.currentFolder) return;
    try {
      const { files } = await API.get(`/api/photo-library/folders/${this.currentFolder.id}/files`);
      this.currentFiles = files;
      this.renderPhotoGrid();
    } catch(e) {
      showToast('Failed to load photos', 'error');
    }
  },

  // Files currently matching the search box + filter dropdown — used for both
  // rendering and "Select All", so selecting all only picks what's actually shown.
  _visibleFiles() {
    const query  = (document.getElementById('plSearchInput')?.value || '').trim().toLowerCase();
    const filter = document.getElementById('plFilterMode')?.value || 'all';
    return this.currentFiles.filter(f => {
      if (query && !f.filename.toLowerCase().includes(query)) return false;
      if (filter === 'renamed' && !f.week_start_date) return false;
      if (filter === 'unrenamed' && f.week_start_date) return false;
      return true;
    });
  },

  renderPhotoGrid() {
    const grid = document.getElementById('plPhotoGrid');
    const empty = document.getElementById('plNoFiles');
    const countEl = document.getElementById('plFilterCount');
    const visible = this._visibleFiles();

    if (countEl) {
      countEl.textContent = this.currentFiles.length
        ? (visible.length === this.currentFiles.length
            ? `${this.currentFiles.length} photo${this.currentFiles.length !== 1 ? 's' : ''}`
            : `${visible.length} of ${this.currentFiles.length} shown`)
        : '';
    }

    if (!visible.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = this.currentFiles.length
        ? 'No photos match your search/filter.'
        : 'No photos in this folder yet — drop some above.';
    } else {
      empty.style.display = 'none';
      grid.innerHTML = visible.map(f => {
        const sel = this.selectedIds.has(f.id);
        return `
          <div class="pl-photo-card" data-file-id="${f.id}" style="
            position:relative;border-radius:8px;overflow:hidden;cursor:pointer;
            border:3px solid ${sel ? 'var(--primary)' : 'transparent'};
            box-shadow:var(--card-shadow);transition:border-color 0.15s;background:var(--card-bg)">
            <img src="/api/photo-library/files/${f.id}/image"
                 style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block"
                 loading="lazy" />
            ${sel ? `<div style="position:absolute;top:6px;right:6px;width:22px;height:22px;
                       border-radius:50%;background:var(--primary);display:flex;align-items:center;
                       justify-content:center;font-size:13px">✓</div>` : ''}
            <a href="/api/photo-library/files/${f.id}/image" download="${esc(f.filename)}"
               class="pl-dl-btn"
               style="position:absolute;bottom:26px;right:5px;width:26px;height:26px;
                      border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;display:flex;
                      align-items:center;justify-content:center;font-size:14px;text-decoration:none;
                      opacity:0;transition:opacity 0.15s;z-index:2"
               title="Download"
               onclick="event.stopPropagation()">⬇</a>
            <div style="padding:5px 7px;font-size:11px;color:var(--text-muted);
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                 title="${esc(f.filename)}">${esc(f.filename)}</div>
          </div>`;
      }).join('');
      grid.querySelectorAll('.pl-photo-card').forEach(el => {
        el.addEventListener('click', () => this.toggleSelect(parseInt(el.dataset.fileId)));
        const dlBtn = el.querySelector('.pl-dl-btn');
        if (dlBtn) {
          el.addEventListener('mouseenter', () => dlBtn.style.opacity = '1');
          el.addEventListener('mouseleave', () => dlBtn.style.opacity = '0');
        }
      });
    }
    this.updateSelectionBar();
  },

  toggleSelect(fileId) {
    if (this.selectedIds.has(fileId)) this.selectedIds.delete(fileId);
    else this.selectedIds.add(fileId);
    this.renderPhotoGrid();
  },

  clearSelection() {
    this.selectedIds = new Set();
    this.renderPhotoGrid();
  },

  toggleSelectAll() {
    const visible = this._visibleFiles();
    const allSelected = visible.length > 0 && visible.every(f => this.selectedIds.has(f.id));
    this.selectedIds = allSelected ? new Set() : new Set(visible.map(f => f.id));
    this.renderPhotoGrid();
  },

  updateSelectionBar() {
    const bar = document.getElementById('plSelectionBar');
    const count = document.getElementById('plSelectionCount');
    if (this.selectedIds.size > 0) {
      bar.style.display = 'flex';
      count.textContent = `${this.selectedIds.size} selected`;
    } else {
      bar.style.display = 'none';
    }
    const selectAllBtn = document.getElementById('plSelectAllBtn');
    if (selectAllBtn) {
      const visible = this._visibleFiles();
      const allSelected = visible.length > 0 && visible.every(f => this.selectedIds.has(f.id));
      selectAllBtn.textContent = allSelected ? '☐ Deselect All' : '☑ Select All';
    }
  },

  async uploadFiles(fileList) {
    if (!fileList || !fileList.length || !this.currentFolder) return;
    const autoRename = document.getElementById('plAutoRenameOnUpload')?.checked;
    const formData = new FormData();
    for (const f of fileList) formData.append('photos', f);
    try {
      const res = await fetch(`/api/photo-library/folders/${this.currentFolder.id}/files`, {
        method: 'POST', body: formData
      });
      if (!res.ok) throw new Error(await res.text());
      const { inserted, fileIds } = await res.json();
      showToast(`${inserted} photo${inserted !== 1 ? 's' : ''} uploaded`, 'success');
      document.getElementById('plFileInput').value = '';
      await this.loadFiles();
      // Update folder list count in background
      this.loadFolders();

      if (autoRename && fileIds?.length) {
        await this._aiRenameFileIds(fileIds, { reload: true });
      }
    } catch(e) {
      showToast('Upload failed: ' + e.message, 'error');
    }
  },

  async deleteSelected() {
    if (!this.selectedIds.size) return;
    if (!confirm(`Delete ${this.selectedIds.size} photo${this.selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      await Promise.all([...this.selectedIds].map(id => API.delete(`/api/photo-library/files/${id}`)));
      this.selectedIds = new Set();
      showToast('Photos deleted', 'success');
      await this.loadFiles();
      this.loadFolders();
    } catch(e) {
      showToast('Delete failed', 'error');
    }
  },

  downloadSelected() {
    if (!this.selectedIds.size) return;
    const ids = [...this.selectedIds];
    ids.forEach((id, i) => {
      const file = this.currentFiles.find(f => f.id === id);
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/photo-library/files/${id}/image`;
        a.download = file ? file.filename : `photo-${id}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 200); // stagger to avoid browser blocking
    });
  },

  // Reads the week range off each selected screenshot with Gemini and renames it —
  // one at a time so a failure on one photo doesn't stop the rest.
  async aiRenameSelected() {
    if (!this.selectedIds.size) return;
    await this._aiRenameFileIds([...this.selectedIds], { reload: false });
    this.clearSelection();
    await this.loadFiles();
  },

  // Shared by aiRenameSelected() and the "auto-rename on upload" checkbox — no
  // shifts are imported here, this only reads the date range to rename the file.
  async _aiRenameFileIds(ids, { reload }) {
    let renamed = 0;
    const failures = [];
    showToast(`Reading ${ids.length} photo${ids.length !== 1 ? 's' : ''} with AI…`, 'info');
    for (const id of ids) {
      try {
        await API.aiRenamePhotoFile(id);
        renamed++;
      } catch (e) {
        const file = this.currentFiles.find(f => f.id === id);
        failures.push((file ? file.filename : id) + ': ' + e.message);
      }
    }
    showToast(
      failures.length
        ? `Renamed ${renamed} of ${ids.length} — ${failures.length} failed`
        : `Renamed ${renamed} photo${renamed !== 1 ? 's' : ''}`,
      failures.length && !renamed ? 'error' : 'success'
    );
    if (failures.length) console.warn('AI rename failures:', failures);
    if (reload) await this.loadFiles();
  },

  async queueSelected(source) {
    if (!this.selectedIds.size) return;
    try {
      const { jobId } = await API.post('/api/photo-library/queue-job', {
        fileIds: [...this.selectedIds],
        source
      });
      showToast(`${this.selectedIds.size} photo${this.selectedIds.size !== 1 ? 's' : ''} queued (Job #${jobId})`, 'success');
      this.clearSelection();
      // Switch to Team Upload view so they can watch progress
      if (window.App) App.switchView('team-upload');
    } catch(e) {
      showToast('Failed to queue: ' + e.message, 'error');
    }
  },
};
