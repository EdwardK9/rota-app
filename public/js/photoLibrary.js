/* ─── Photo Library ────────────────────────────────────────────────────────── */

const PhotoLibrary = {
  folders: [],
  currentFolder: null,   // { id, name }
  currentFiles: [],
  selectedIds: new Set(),
  _renameQueuePollTimer: null,

  destroy() {
    clearInterval(this._renameQueuePollTimer);
    this._renameQueuePollTimer = null;
  },

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
          <label class="toggle-label" style="font-weight:400;margin-bottom:12px">
            <input type="checkbox" id="plAutoRenameOnUpload" />
            <span>🏷️ Auto-rename with AI on upload</span>
            <span class="toggle-hint">Reads the week from each screenshot, no shifts are imported</span>
          </label>

          <!-- Rename queue (hidden until something's waiting/failed) -->
          <div id="plRenameQueueCard" style="display:none;margin-bottom:16px;border:1px solid var(--border);
               border-radius:8px;padding:12px 14px;background:var(--card-bg)">
            <div id="plRenameQueueHeader" style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">🏷️ Rename queue</div>
            <div id="plRenameQueueGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px"></div>
          </div>

          <!-- Selection toolbar (hidden until selection) -->
          <div id="plSelectionBar" style="display:none;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;
               background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
            <span id="plSelectionCount" style="font-weight:600;color:var(--text)"></span>
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

    // Remembered server-side, not just in localStorage: this kept coming back
    // unticked on the phone, and per-browser storage is exactly the thing that
    // gets cleared out from under you (or is simply a different browser). The
    // local copy stays as an instant fallback if settings didn't load.
    const autoRenameCb = document.getElementById('plAutoRenameOnUpload');
    let saved = App.settings?.photo_auto_rename;
    if (saved === undefined || saved === null || saved === '') {
      try { saved = localStorage.getItem('pl_autoRenameOnUpload'); } catch (_) {}
    }
    autoRenameCb.checked = saved === '1';
    autoRenameCb.addEventListener('change', async () => {
      const val = autoRenameCb.checked ? '1' : '0';
      try { localStorage.setItem('pl_autoRenameOnUpload', val); } catch (_) {}
      if (App.settings) App.settings.photo_auto_rename = val;
      try { await API.saveSettings({ photo_auto_rename: val }); }
      catch (_) { /* the local copy still holds it for this browser */ }
    });

    this._loadRenameQueue();
    clearInterval(this._renameQueuePollTimer);
    this._renameQueuePollTimer = setInterval(() => this._loadRenameQueue(), 20_000);
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
      // Hover-reveal for the per-photo buttons only works with a real pointer;
      // on a phone they have to be permanently visible or they don't exist.
      const hoverless = window.matchMedia('(hover: none)').matches;
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
            <button data-select-id="${f.id}" title="${sel ? 'Deselect' : 'Select'}"
               style="position:absolute;top:6px;right:6px;width:26px;height:26px;padding:0;
                      border:2px solid ${sel ? 'var(--primary)' : 'rgba(255,255,255,0.85)'};
                      border-radius:50%;background:${sel ? 'var(--primary)' : 'rgba(0,0,0,0.4)'};
                      color:#fff;display:flex;align-items:center;justify-content:center;
                      font-size:14px;line-height:1;cursor:pointer;z-index:3">${sel ? '✓' : ''}</button>
            <a href="/api/photo-library/files/${f.id}/image" download="${esc(f.filename)}"
               class="pl-hover-btn"
               style="position:absolute;bottom:26px;right:5px;width:26px;height:26px;
                      border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;display:flex;
                      align-items:center;justify-content:center;font-size:14px;text-decoration:none;
                      opacity:${hoverless ? 1 : 0};transition:opacity 0.15s;z-index:2"
               title="Download"
               onclick="event.stopPropagation()">⬇</a>
            <div style="padding:5px 7px;font-size:11px;color:var(--text-muted);
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                 title="${esc(f.filename)}">${esc(f.filename)}</div>
          </div>`;
      }).join('');
      // Tapping the photo opens it full-screen — the obvious gesture, and the
      // only way to actually read a rota screenshot on a phone. Selecting is
      // the deliberate act now: the circle in the corner, or a tap anywhere on
      // the card once something is already selected (so building up a multi-
      // select doesn't mean hitting a 26px target over and over).
      grid.querySelectorAll('.pl-photo-card').forEach(el => {
        el.addEventListener('click', () => {
          const id = parseInt(el.dataset.fileId, 10);
          if (this.selectedIds.size > 0) this.toggleSelect(id);
          else this.openViewer(id);
        });
        const btns = el.querySelectorAll('.pl-hover-btn');
        if (!hoverless && btns.length) {
          el.addEventListener('mouseenter', () => btns.forEach(b => b.style.opacity = '1'));
          el.addEventListener('mouseleave', () => btns.forEach(b => b.style.opacity = '0'));
        }
      });
      grid.querySelectorAll('[data-select-id]').forEach(btn =>
        btn.addEventListener('click', e => {
          e.stopPropagation();   // selecting isn't viewing
          this.toggleSelect(parseInt(btn.dataset.selectId, 10));
        })
      );
    }
    this.updateSelectionBar();
  },

  // ── Photo viewer ──────────────────────────────────────────────────────────
  // Full-screen viewer with pinch/wheel zoom and drag-to-pan. Deliberately not
  // built on Modal: it needs the whole screen, its own pointer gestures, and
  // mustn't close on a stray tap while you're dragging a zoomed-in screenshot
  // around — which is the point of it, since a rota screenshot is unreadable at
  // thumbnail size on a phone.
  _viewer: null,

  openViewer(fileId) {
    const files = this._visibleFiles();
    const idx = files.findIndex(f => f.id === fileId);
    if (idx < 0) return;
    if (!this._viewer) this._buildViewer();
    this._viewer.files = files;
    this._viewer.index = idx;
    this._viewer.root.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    this._showViewerPhoto();
  },

  closeViewer() {
    if (!this._viewer) return;
    this._viewer.root.style.display = 'none';
    this._viewer.img.removeAttribute('src');
    document.body.style.overflow = '';
  },

  _buildViewer() {
    const root = document.createElement('div');
    root.id = 'plViewer';
    root.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.94);'
      + 'display:none;flex-direction:column;touch-action:none;user-select:none;-webkit-user-select:none';
    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff;font-size:13px;flex:0 0 auto">
        <span id="plViewerName" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
              white-space:nowrap;opacity:0.85"></span>
        <span id="plViewerZoom" style="opacity:0.6;font-variant-numeric:tabular-nums"></span>
        <button data-vz="out" class="pl-viewer-btn" title="Zoom out">−</button>
        <button data-vz="in"  class="pl-viewer-btn" title="Zoom in">+</button>
        <button data-vz="fit" class="pl-viewer-btn" style="width:auto;padding:0 10px;font-size:12px">Fit</button>
        <a id="plViewerDl" class="pl-viewer-btn" style="text-decoration:none" title="Download">⬇</a>
        <button data-vz="close" class="pl-viewer-btn" title="Close (Esc)">✕</button>
      </div>
      <div id="plViewerStage" style="flex:1;min-height:0;position:relative;overflow:hidden;
           display:flex;align-items:center;justify-content:center;cursor:grab">
        <img id="plViewerImg" draggable="false" alt=""
             style="max-width:100%;max-height:100%;object-fit:contain;display:block;
                    transform-origin:center center;will-change:transform;-webkit-user-drag:none" />
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;padding:10px;
                  color:#fff;font-size:12px;flex:0 0 auto">
        <button data-vz="prev" class="pl-viewer-btn" title="Previous">←</button>
        <span id="plViewerCount" style="opacity:0.6;min-width:70px;text-align:center"></span>
        <button data-vz="next" class="pl-viewer-btn" title="Next">→</button>
      </div>`;
    document.body.appendChild(root);

    const v = this._viewer = {
      root,
      img:   root.querySelector('#plViewerImg'),
      stage: root.querySelector('#plViewerStage'),
      name:  root.querySelector('#plViewerName'),
      zoomLabel: root.querySelector('#plViewerZoom'),
      count: root.querySelector('#plViewerCount'),
      dl:    root.querySelector('#plViewerDl'),
      files: [], index: 0,
      scale: 1, tx: 0, ty: 0,
      pointers: new Map(), pinchStart: null, dragStart: null, lastTap: 0,
    };

    root.querySelectorAll('[data-vz]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const a = btn.dataset.vz;
      if      (a === 'close') this.closeViewer();
      else if (a === 'in')    this._zoomBy(1.4);
      else if (a === 'out')   this._zoomBy(1 / 1.4);
      else if (a === 'fit')   this._resetZoom();
      else if (a === 'prev')  this._stepViewer(-1);
      else if (a === 'next')  this._stepViewer(1);
    }));

    // Wheel / trackpad zoom, anchored on the cursor
    v.stage.addEventListener('wheel', e => {
      e.preventDefault();
      this._zoomBy(Math.exp(-e.deltaY / 400), e.clientX, e.clientY);
    }, { passive: false });

    v.stage.addEventListener('pointerdown', e => {
      v.stage.setPointerCapture(e.pointerId);
      v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (v.pointers.size === 2) {
        const [a, b] = [...v.pointers.values()];
        v.pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: v.scale };
        v.dragStart = null;
      } else if (v.pointers.size === 1) {
        v.dragStart = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, moved: false };
        v.stage.style.cursor = 'grabbing';
      }
    });

    v.stage.addEventListener('pointermove', e => {
      if (!v.pointers.has(e.pointerId)) return;
      v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (v.pointers.size >= 2 && v.pinchStart) {
        const [a, b] = [...v.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (v.pinchStart.dist > 0) {
          this._zoomTo(v.pinchStart.scale * (dist / v.pinchStart.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
      } else if (v.dragStart) {
        const dx = e.clientX - v.dragStart.x, dy = e.clientY - v.dragStart.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) v.dragStart.moved = true;
        // At fit size there's nothing to pan, so let the gesture read as a swipe
        // instead of dragging the image out from under the finger.
        if (v.scale > 1.02) {
          v.tx = v.dragStart.tx + dx;
          v.ty = v.dragStart.ty + dy;
          this._applyTransform();
        }
      }
    });

    const endPointer = e => {
      if (!v.pointers.has(e.pointerId)) return;
      v.pointers.delete(e.pointerId);
      v.stage.style.cursor = 'grab';
      if (v.pointers.size < 2) v.pinchStart = null;
      if (v.pointers.size === 0 && v.dragStart) {
        const start = v.dragStart;
        v.dragStart = null;
        if (!start.moved) {
          const now = Date.now();
          if (now - v.lastTap < 300) {          // double-tap toggles fit / 250%
            v.lastTap = 0;
            if (v.scale > 1.02) this._resetZoom(); else this._zoomTo(2.5, e.clientX, e.clientY);
          } else {
            v.lastTap = now;
          }
        } else if (v.scale <= 1.02 && Math.abs(e.clientX - start.x) > 60) {
          this._stepViewer(e.clientX < start.x ? 1 : -1);   // swipe between photos
        } else {
          this._clampPan();
        }
      }
    };
    v.stage.addEventListener('pointerup', endPointer);
    v.stage.addEventListener('pointercancel', endPointer);
    v.stage.addEventListener('dblclick', e => {
      if (v.scale > 1.02) this._resetZoom(); else this._zoomTo(2.5, e.clientX, e.clientY);
    });

    document.addEventListener('keydown', e => {
      if (root.style.display === 'none') return;
      if      (e.key === 'Escape')     this.closeViewer();
      else if (e.key === 'ArrowLeft')  this._stepViewer(-1);
      else if (e.key === 'ArrowRight') this._stepViewer(1);
      else if (e.key === '+' || e.key === '=') this._zoomBy(1.4);
      else if (e.key === '-')          this._zoomBy(1 / 1.4);
      else if (e.key === '0')          this._resetZoom();
    });
  },

  _showViewerPhoto() {
    const v = this._viewer;
    const f = v.files[v.index];
    if (!f) return;
    v.img.src = `/api/photo-library/files/${f.id}/image`;
    v.name.textContent = f.filename;
    v.name.title = f.filename;
    v.dl.href = `/api/photo-library/files/${f.id}/image`;
    v.dl.setAttribute('download', f.filename);
    v.count.textContent = `${v.index + 1} / ${v.files.length}`;
    this._resetZoom();
  },

  _stepViewer(dir) {
    const v = this._viewer;
    if (!v.files.length) return;
    v.index = (v.index + dir + v.files.length) % v.files.length;
    this._showViewerPhoto();
  },

  _resetZoom() {
    const v = this._viewer;
    v.scale = 1; v.tx = 0; v.ty = 0;
    this._applyTransform();
  },

  _zoomBy(factor, cx, cy) { this._zoomTo(this._viewer.scale * factor, cx, cy); },

  // Zoom towards (cx, cy) in client coords, so the point under the cursor or
  // between the fingers stays put — what makes reading one column of a rota work.
  _zoomTo(target, cx, cy) {
    const v = this._viewer;
    const next = Math.min(8, Math.max(1, target));
    const rect = v.stage.getBoundingClientRect();
    if (cx == null) { cx = rect.left + rect.width / 2; cy = rect.top + rect.height / 2; }
    const ox = cx - (rect.left + rect.width / 2);
    const oy = cy - (rect.top + rect.height / 2);
    const ratio = next / v.scale;
    v.tx = ox - (ox - v.tx) * ratio;
    v.ty = oy - (oy - v.ty) * ratio;
    v.scale = next;
    this._clampPan();
  },

  // Keep the image from being dragged off-screen: centred at fit size, and free
  // to move by however much of it overflows the stage once zoomed in.
  _clampPan() {
    const v = this._viewer;
    const rect = v.stage.getBoundingClientRect();
    const maxX = Math.max(0, (v.img.offsetWidth  * v.scale - rect.width)  / 2);
    const maxY = Math.max(0, (v.img.offsetHeight * v.scale - rect.height) / 2);
    v.tx = Math.min(maxX, Math.max(-maxX, v.tx));
    v.ty = Math.min(maxY, Math.max(-maxY, v.ty));
    this._applyTransform();
  },

  _applyTransform() {
    const v = this._viewer;
    v.img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    v.zoomLabel.textContent = v.scale > 1.02 ? `${Math.round(v.scale * 100)}%` : '';
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
    try {
      const { inserted } = await API.uploadPhotoFiles(this.currentFolder.id, fileList, autoRename);
      showToast(
        `${inserted} photo${inserted !== 1 ? 's' : ''} uploaded` +
        (autoRename ? ' — reading week with AI in the background…' : ''),
        'success'
      );
      document.getElementById('plFileInput').value = '';
      await this.loadFiles();
      // Update folder list count in background
      this.loadFolders();
      // Auto-renaming now happens server-side via the queue (see the "Rename
      // queue" card) instead of looping Gemini calls in this request — that
      // loop was exactly the kind of long, easy-to-interrupt request that
      // broke on mobile for the screenshot importer.
      if (autoRename) this._loadRenameQueue();
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

  // For a handful of photos, read them with Gemini one at a time right here —
  // fast enough that waiting for it is fine. For a big batch (e.g. "Select
  // All" on hundreds of unrenamed screenshots) that same loop would tie up
  // the tab for the best part of an hour and lose all remaining progress the
  // moment the tab closes or the connection drops, so those go through the
  // same background queue as auto-rename-on-upload instead.
  _AI_RENAME_SYNC_LIMIT: 10,

  async aiRenameSelected() {
    if (!this.selectedIds.size) return;
    const ids = [...this.selectedIds];

    if (ids.length > this._AI_RENAME_SYNC_LIMIT) {
      try {
        const { queued } = await API.bulkQueueRename(ids);
        showToast(`Queued ${queued} photo${queued !== 1 ? 's' : ''} for AI rename — see the Rename queue below`, 'success');
        this.clearSelection();
        this._loadRenameQueue();
      } catch (e) {
        showToast('Failed to queue: ' + e.message, 'error');
      }
      return;
    }

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
    this.clearSelection();
    await this.loadFiles();
  },

  // Visual queue for background AI-renames (auto-rename-on-upload). Same
  // pattern as Team Upload's Processing Queue: only in-flight work is shown —
  // a finished rename just appears as its new filename in the photo grid
  // above, so it drops out of this list the moment it's done.
  async _loadRenameQueue() {
    const card = document.getElementById('plRenameQueueCard');
    const grid = document.getElementById('plRenameQueueGrid');
    if (!card || !grid) return;
    try {
      const { pending, failed, paused_seconds: pausedSecs = 0 } = await API.getRenameQueue();
      // A drop in the queue count means something just finished since the last
      // check (a failure stays in `failed` rather than disappearing, so this
      // only fires on a genuine success) — refresh the photo grid so the new
      // AI-picked filename shows up without leaving and coming back, and say
      // so out loud, since a background queue with no visible activity is
      // easy to mistake for "not doing anything."
      const total = pending.length + failed.length;
      if (this._lastRenameQueueCount !== undefined && total < this._lastRenameQueueCount) {
        const done = this._lastRenameQueueCount - total;
        showToast(`✓ ${done} photo${done !== 1 ? 's' : ''} renamed`, 'success');
        if (this.currentFolder) this.loadFiles();
      }
      this._lastRenameQueueCount = total;

      if (!pending.length && !failed.length) { card.style.display = 'none'; return; }
      card.style.display = 'block';

      const thumb = id => `<img src="/api/photo-library/files/${id}/image" loading="lazy"
        style="width:100%;aspect-ratio:3/4;object-fit:cover;display:block" />`;
      const cardWrap = (inner, borderColor) => `
        <div style="position:relative;border-radius:6px;overflow:hidden;background:var(--bg);
          border:1px solid ${borderColor}">${inner}</div>`;
      const badge = (text, bg, fg) => `<div style="position:absolute;top:3px;left:3px;right:3px;
        padding:1px 4px;border-radius:3px;font-size:9px;font-weight:600;text-align:center;
        background:${bg};color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text}</div>`;
      const caption = filename => `<div style="padding:2px 4px;font-size:9px;color:var(--text-muted);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(filename)}">${esc(filename)}</div>`;

      const header = document.getElementById('plRenameQueueHeader');
      if (header) {
        const parts = [];
        if (pending.length) parts.push(`⏳ ${pending.length} waiting`);
        if (failed.length)  parts.push(`⚠️ ${failed.length} failed`);
        // The queue carries on with the app closed — it's a loop on the server,
        // not something this page drives — so when it's sitting out a quota
        // window, say so rather than looking stalled.
        if (pausedSecs > 0) {
          const mins = Math.floor(pausedSecs / 60), secs = pausedSecs % 60;
          parts.push(`⏸️ waiting for Gemini quota, retrying in ${mins ? mins + 'm ' : ''}${secs}s`);
        }
        header.innerHTML = `<span>🏷️ Rename queue — ${parts.join(', ')}</span>` +
          (failed.length > 1
            ? ` <button class="btn btn-sm btn-ghost" id="plRetryAllBtn"
                 style="font-size:11px;padding:2px 8px;margin-left:8px">↻ Retry all ${failed.length}</button>`
            : '');
        document.getElementById('plRetryAllBtn')?.addEventListener('click', async (e) => {
          e.target.disabled = true;
          try {
            const { retried } = await API.retryAllQueuedRenames();
            showToast(`${retried} queued for another attempt`, 'success');
            this._loadRenameQueue();
          } catch (err) {
            e.target.disabled = false;
            showToast('Retry failed: ' + err.message, 'error');
          }
        });
      }

      const why = err => err
        ? `<div style="padding:0 4px 3px;font-size:9px;line-height:1.25;color:var(--danger);
             display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden"
             title="${esc(err)}">${esc(err)}</div>`
        : '';

      let html = '';
      html += pending.map(p => cardWrap(
        `${thumb(p.id)}${badge('⏳', 'rgba(0,0,0,0.55)', '#fff')}${caption(p.filename)}${why(p.rename_error)}`,
        'var(--border)')).join('');
      html += failed.map(f => cardWrap(`
        ${thumb(f.id)}
        ${badge('⚠️', 'var(--danger)', '#fff')}
        ${caption(f.filename)}
        ${why(f.rename_error)}
        <button class="btn btn-sm btn-ghost" data-retry-rename="${f.id}"
          style="width:100%;border-radius:0;font-size:10px;padding:2px" title="${esc(f.rename_error)}">Retry</button>
      `, 'var(--danger)')).join('');

      grid.innerHTML = html;
      grid.querySelectorAll('[data-retry-rename]').forEach(btn =>
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await API.retryQueuedRename(parseInt(btn.dataset.retryRename, 10));
            showToast('Queued for another attempt', 'success');
            this._loadRenameQueue();
          } catch (e) {
            btn.disabled = false;
            showToast('Retry failed: ' + e.message, 'error');
          }
        })
      );
    } catch (_) { /* non-critical — leave whatever was last shown */ }
  },
};
