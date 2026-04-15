/* Unified library tab — new grid UI */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // ── State ──────────────────────────────────────────────────────
  let selectedIds = new Set();
  let currentType = 'all';       // all / character / asset / style / background / phoi
  let currentGroup = 'all';      // 'all' | category id | '__characters__'
  let libraryCategories = [];    // [{id, name}]
  let libraryAssets = [];        // [{id, name, url, category_id, prompt}]
  let libraryCharacters = [];    // [{id, name, url, synced, media_id}]

  function escapeHtml(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Derived data ───────────────────────────────────────────────
  function allItems() {
    const chars = libraryCharacters.map(ch => ({
      id: ch.id, type: 'character', name: ch.name, url: ch.url,
      group: '__characters__', synced: !!ch.synced, media_id: ch.media_id || '',
    }));
    const assets = libraryAssets.map(a => ({
      id: a.id, type: 'asset', name: a.name, url: a.url,
      group: a.category_id || 'default', prompt: a.prompt || '',
    }));
    return [...chars, ...assets];
  }

  function filteredItems() {
    return allItems().filter(item => {
      if (currentType !== 'all' && item.type !== currentType) return false;
      if (currentGroup !== 'all' && item.group !== currentGroup) return false;
      return true;
    });
  }

  function groupCounts() {
    const counts = { all: 0, __characters__: 0 };
    libraryCategories.forEach(c => { counts[c.id] = 0; });
    allItems().forEach(item => {
      counts.all = (counts.all || 0) + 1;
      counts[item.group] = (counts[item.group] || 0) + 1;
    });
    return counts;
  }

  // ── Render sidebar groups ──────────────────────────────────────
  function renderGroups() {
    const list = $('lib-group-list');
    if (!list) return;
    const counts = groupCounts();
    const groups = [
      { id: 'all', name: 'Tất cả' },
      { id: '__characters__', name: 'Nhân vật' },
      ...libraryCategories,
    ];
    list.innerHTML = groups.map(g => `
      <div class="lib-group-item ${currentGroup === g.id ? 'active' : ''}" data-gid="${escapeHtml(g.id)}">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(g.name)}</span>
        <span class="lib-group-count">${counts[g.id] || 0}</span>
      </div>
    `).join('');
    list.querySelectorAll('.lib-group-item').forEach(el => {
      el.addEventListener('click', () => {
        currentGroup = el.dataset.gid;
        renderGroups();
        renderGrid();
        updateGroupDropdown();
      });
    });

    // Populate upload category select
    const catSel = $('char-upload-category');
    if (catSel) {
      catSel.innerHTML = '<option value="">-- Chọn nhóm --</option>' +
        libraryCategories.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
    }
  }

  function updateGroupDropdown() {
    const sel = $('lib-group-filter');
    if (!sel) return;
    const counts = groupCounts();
    const groups = [
      { id: 'all', name: 'Nhóm: Tất cả' },
      { id: '__characters__', name: 'Nhân vật' },
      ...libraryCategories,
    ];
    sel.innerHTML = groups.map(g =>
      `<option value="${escapeHtml(g.id)}" ${currentGroup === g.id ? 'selected' : ''}>${escapeHtml(g.name)} (${counts[g.id] || 0})</option>`
    ).join('');
  }

  // ── Render grid ────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('char-grid');
    if (!grid) return;
    const items = filteredItems();
    const total = items.length;
    const countLabel = $('lib-count-label');
    if (countLabel) countLabel.textContent = `${total} mục`;

    if (!total) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text3);">
        <div style="font-size:32px;margin-bottom:12px;">📂</div>
        <div style="font-size:13px;">Chưa có mục nào trong danh mục này</div>
      </div>`;
      return;
    }

    grid.innerHTML = items.map(item => {
      const isChar = item.type === 'character';
      const checked = selectedIds.has(item.id) ? 'checked' : '';
      const badge = isChar ? (item.synced ? 'Synced' : 'Chưa sync') : 'Kho';
      const badgePink = !isChar || item.synced;
      const syncDisabled = isChar && item.synced ? 'disabled' : '';
      return `
        <div class="lib-card ${selectedIds.has(item.id) ? 'selected' : ''}" data-id="${escapeHtml(item.id)}" data-type="${escapeHtml(item.type)}">
          <input type="checkbox" class="lib-card-check" data-id="${escapeHtml(item.id)}" ${checked} onclick="event.stopPropagation()">
          <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" loading="lazy">
          <span class="lib-card-badge" style="${badgePink ? '' : 'background:rgba(107,33,168,.75);'}">${escapeHtml(badge)}</span>
          <div class="lib-card-actions">
            ${isChar ? `<button class="lib-sync-btn" data-id="${escapeHtml(item.id)}" ${syncDisabled}>Sync</button>` : ''}
            <button class="lib-del-btn" data-id="${escapeHtml(item.id)}" data-type="${escapeHtml(item.type)}">Xóa</button>
          </div>
          <div class="lib-card-label">${escapeHtml(item.name) || 'Chưa đặt tên'}</div>
        </div>
      `;
    }).join('');

    // Events
    grid.querySelectorAll('.lib-card-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        const card = grid.querySelector(`.lib-card[data-id="${id}"]`);
        if (card) card.classList.toggle('selected', e.target.checked);
        updateSelectAll();
      });
    });
    grid.querySelectorAll('.lib-sync-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); syncIds([btn.dataset.id]); });
    });
    grid.querySelectorAll('.lib-del-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); deleteItem(btn.dataset.id, btn.dataset.type); });
    });
    grid.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.classList.contains('lib-card-check') || e.target.tagName === 'BUTTON') return;
        const id = card.dataset.id;
        const cb = card.querySelector('.lib-card-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });
    updateSelectAll();
  }

  function updateSelectAll() {
    const cb = $('lib-select-all');
    const items = filteredItems();
    if (cb) {
      cb.checked = items.length > 0 && items.every(i => selectedIds.has(i.id));
      cb.indeterminate = !cb.checked && items.some(i => selectedIds.has(i.id));
    }
    // Nút xóa đã chọn
    const delBtn = $('lib-delete-selected-btn');
    const countEl = $('lib-selected-count');
    if (delBtn) delBtn.style.display = selectedIds.size > 0 ? 'inline-flex' : 'none';
    if (countEl) countEl.textContent = selectedIds.size;
  }

  // ── API actions ────────────────────────────────────────────────
  async function loadAll() {
    const grid = $('char-grid');
    if (grid) grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const [catsRes, assetsRes, charsRes] = await Promise.all([
      API.get('/api/image/library/categories'),
      API.get('/api/image/library/assets'),
      API.get('/api/character/list'),
    ]);
    libraryCategories = catsRes.items || [];
    libraryAssets = assetsRes.items || [];
    libraryCharacters = charsRes.data || [];
    renderGroups();
    updateGroupDropdown();
    renderGrid();
  }

  async function createGroup() {
    const name = window.prompt('Nhập tên nhóm mới:');
    if (!name || !name.trim()) return;
    const res = await API.post('/api/image/library/categories', { name: name.trim() });
    if (!res.ok) return toast(res.detail || 'Tạo nhóm thất bại', 'error');
    currentGroup = res.item?.id || 'all';
    toast('✅ Đã tạo nhóm mới', 'success');
    await loadAll();
  }

  async function syncIds(ids) {
    if (!ids.length) return toast('Chưa chọn nhân vật nào', 'error');
    const res = await API.post('/api/character/sync', { ids });
    if (res.ok) {
      toast(res.message || `✅ Sync ${ids.length} nhân vật`, 'success');
      await loadAll();
    } else {
      toast(res.detail || res.message || 'Sync thất bại', 'error');
    }
  }

  async function syncAll() {
    const res = await API.post('/api/character/sync-all', {});
    if (res.ok) {
      toast(res.message || '✅ Sync toàn bộ nhân vật', 'success');
      await loadAll();
    } else {
      toast(res.detail || res.message || 'Sync tất cả thất bại', 'error');
    }
  }

  async function deleteItem(id, type) {
    if (!confirm('Xóa mục này?')) return;
    let res;
    if (type === 'character') {
      res = await API.delete(`/api/character/${id}`);
    } else {
      res = await API.delete(`/api/image/library/assets/${id}`);
    }
    if (res.ok || res.detail === undefined) {
      selectedIds.delete(id);
      toast('✅ Đã xóa', 'success');
      await loadAll();
    } else {
      toast(res.detail || 'Xóa thất bại', 'error');
    }
  }

  async function deleteSelected() {
    if (!selectedIds.size) return toast('Chưa chọn mục nào', 'error');
    if (!confirm(`Xóa ${selectedIds.size} mục đã chọn?`)) return;
    const items = allItems().filter(i => selectedIds.has(i.id));
    await Promise.all(items.map(i => {
      if (i.type === 'character') return API.delete(`/api/character/${i.id}`);
      return API.delete(`/api/image/library/assets/${i.id}`);
    }));
    selectedIds.clear();
    toast('✅ Đã xóa các mục đã chọn', 'success');
    await loadAll();
  }

  async function uploadCharacter() {
    const fileInput = $('char-file');
    const nameInput = $('char-name');
    const files = fileInput?.files;
    const name = (nameInput?.value || '').trim() || 'Character';
    if (!files || !files.length) return toast('Chọn ảnh trước đã', 'error');

    // Xác định đích upload dựa vào nhóm đang chọn
    const catSel = $('char-upload-category');
    const catId = catSel?.value || '';
    // Nếu không chọn nhóm hoặc chọn __characters__ → upload character
    // Nếu chọn một category cụ thể → upload vào library asset của nhóm đó
    const isLibrary = catId && catId !== '__characters__';

    const btn = $('char-upload-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang upload...'; }
    let failed = 0;
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append('image', file);
        const itemName = files.length === 1 ? name : file.name.replace(/\.[^.]+$/, '');
        fd.append('name', itemName);
        let res;
        if (isLibrary) {
          fd.append('category_id', catId);
          res = await API.postForm('/api/image/library/upload', fd);
        } else {
          res = await API.postForm('/api/character/upload', fd);
        }
        if (!res.ok) { failed++; }
      }
      const ok = files.length - failed;
      if (ok > 0) toast(`✅ Đã thêm ${ok} ảnh${isLibrary ? ' vào kho' : ' nhân vật'}`, 'success');
      if (failed > 0) toast(`⚠️ ${failed} ảnh thất bại`, 'error');
      // Reset
      fileInput.value = '';
      clearPreviews();
      $('lib-upload-bar').style.display = 'none';
      await loadAll();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
    }
  }

  // ── Preview strip for multiple files ──────────────────────────
  let _previewUrls = [];

  function clearPreviews() {
    _previewUrls.forEach(u => URL.revokeObjectURL(u));
    _previewUrls = [];
    const strip = $('lib-preview-strip');
    if (strip) strip.innerHTML = '';
  }

  function showPreviews(files) {
    clearPreviews();
    const strip = $('lib-preview-strip');
    if (!strip || !files || !files.length) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      _previewUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.title = file.name;
      strip.appendChild(img);
    });
  }

  function bindUploadZone() {
    const zone = $('char-upload-zone');
    const input = $('char-file');
    if (!zone || !input || zone.dataset.bound === '1') return;
    zone.dataset.bound = '1';

    zone.addEventListener('click', e => { if (e.target !== input) input.click(); });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => showPreviews(input.files));
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const dropped = e.dataTransfer?.files;
      if (!dropped?.length) return;
      const dt = new DataTransfer();
      Array.from(dropped).forEach(f => dt.items.add(f));
      input.files = dt.files;
      showPreviews(input.files);
    });
  }

  // ── Init ───────────────────────────────────────────────────────
  window.init_character = function () {
    bindUploadZone();

    // Type filter tabs
    document.querySelectorAll('.lib-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lib-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentType = btn.dataset.type;
        renderGrid();
      });
    });

    // Group dropdown
    $('lib-group-filter')?.addEventListener('change', e => {
      currentGroup = e.target.value;
      renderGroups();
      renderGrid();
    });

    // Sidebar add group
    $('lib-add-group-btn')?.addEventListener('click', createGroup);

    // Thêm nhân vật → mở upload bar, force chọn nhân vật (không chọn nhóm kho)
    $('lib-add-char-btn')?.addEventListener('click', () => {
      const bar = $('lib-upload-bar');
      if (!bar) return;
      bar.style.display = 'flex';
      // Reset category về nhân vật (value rỗng = nhân vật mặc định)
      const catSel = $('char-upload-category');
      if (catSel) catSel.value = '';
    });

    // Add nhiều hình button → toggle upload bar (giữ nguyên category đang chọn)
    $('lib-add-btn')?.addEventListener('click', () => {
      const bar = $('lib-upload-bar');
      if (bar) bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
    });
    $('lib-upload-cancel')?.addEventListener('click', () => {
      const bar = $('lib-upload-bar');
      if (bar) bar.style.display = 'none';
    });

    // Upload btn
    $('char-upload-btn')?.addEventListener('click', uploadCharacter);

    // Select all
    $('lib-select-all')?.addEventListener('change', e => {
      const items = filteredItems();
      if (e.target.checked) items.forEach(i => selectedIds.add(i.id));
      else items.forEach(i => selectedIds.delete(i.id));
      renderGrid();
    });

    // Sync / delete buttons
    $('char-sync-selected-btn')?.addEventListener('click', () => syncIds([...selectedIds]));
    $('char-sync-all-btn')?.addEventListener('click', syncAll);
    $('lib-delete-all-btn')?.addEventListener('click', deleteSelected);
    $('lib-delete-selected-btn')?.addEventListener('click', deleteSelected);
    $('lib-load-sel-btn')?.addEventListener('click', () => {
      const items = filteredItems().filter(i => selectedIds.has(i.id));
      if (!items.length) return toast('Chưa chọn mục nào', 'info');
      items.forEach(i => {
        const a = document.createElement('a');
        a.href = i.url; a.download = i.name || 'image';
        a.click();
      });
    });

    loadAll();
  };
})();
