/* Thư viện nhân vật — redesigned */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // ── Thể loại cố định ───────────────────────────────────────────
  const ASSET_TYPES = [
    { id: 'all',        label: 'Tất cả'    },
    { id: 'nhanvat',    label: 'Nhân Vật'  },
    { id: 'vatpham',    label: 'Vật Phẩm'  },
    { id: 'style',      label: 'Style'     },
    { id: 'background', label: 'Background'},
  ];

  // ── State ──────────────────────────────────────────────────────
  let selectedIds     = new Set();
  let currentType     = 'all';
  let currentGroup    = ''; // '' = first user cat | category id
  let libraryCategories = [];  // [{id, name, created_at}]
  let libraryAssets     = [];  // [{id, name, url, category_id, asset_type, ...}]
  let consistentCharacters = [];
  let voicePresets = [];
  let ccSelectedVoice = null;
  let ccPreviewUrls = [];

  // Wizard state
  let wizSelectedGroup = null; // {id, name}
  let wizSelectedType  = 'nhanvat';

  // Context menu state
  let ctxTargetGroupId = null; // for group right-click
  let renameCallback   = null; // fn(newName)

  function escHtml(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function ensureConsistentCharacterUI() {
    const tabs = $('lib-type-tabs');
    if (tabs && !tabs.querySelector('[data-type="consistent"]')) {
      const btn = document.createElement('button');
      btn.className = 'lib-type-btn';
      btn.dataset.type = 'consistent';
      btn.textContent = 'Nhân vật đồng nhất';
      const vatpham = tabs.querySelector('[data-type="vatpham"]');
      tabs.insertBefore(btn, vatpham || null);
    }

    const uploadBtn = $('lib-upload-btn');
    if (uploadBtn && !$('consistent-create-btn')) {
      const btn = document.createElement('button');
      btn.id = 'consistent-create-btn';
      btn.className = 'btn btn-primary btn-sm';
      btn.style.display = 'none';
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M16 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2" />
          <circle cx="9.5" cy="7" r="4" />
          <path d="M19 8v6" />
          <path d="M22 11h-6" />
        </svg>
        Tạo nhân vật
      `;
      uploadBtn.parentElement?.appendChild(btn);
    }

    if (!$('consistent-character-popup')) {
      const wrap = document.createElement('div');
      wrap.id = 'consistent-character-popup';
      wrap.className = 'lib-popup-overlay';
      wrap.style.display = 'none';
      wrap.innerHTML = `
        <div class="lib-popup-box consistent-character-modal">
          <div class="lib-popup-head">
            <span>Tạo nhân vật đồng nhất</span>
            <button class="lib-popup-close" id="consistent-character-close" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="consistent-character-body">
            <div class="consistent-character-form">
              <label class="cc-field-label">Tên nhân vật</label>
              <input id="cc-name" class="cc-input" type="text" placeholder="VD: Daddy Pig, Dr Brown Bear...">
              <label class="cc-field-label">Giọng nói</label>
              <button id="cc-voice-trigger" class="cc-voice-trigger" type="button">
                <span class="cc-voice-icon">♪</span>
                <span class="cc-voice-main">
                  <strong id="cc-voice-name">Chọn giọng nói</strong>
                  <small id="cc-voice-desc">Chưa chọn</small>
                </span>
                <span class="cc-voice-caret">▾</span>
              </button>
              <div id="cc-voice-menu" class="cc-voice-menu" style="display:none;">
                <input id="cc-voice-search" class="cc-voice-search" type="text" placeholder="Tìm giọng nói...">
                <div id="cc-voice-list" class="cc-voice-list"></div>
              </div>
              <label class="cc-field-label">Mô tả / tính cách <span>(tùy chọn)</span></label>
              <textarea id="cc-description" class="cc-textarea" placeholder="Mô tả tính cách, cách nói, vai trò của nhân vật..."></textarea>
            </div>
            <div class="consistent-character-media">
              <div id="cc-upload-zone" class="cc-upload-zone">
                <input id="cc-images" type="file" accept="image/*" multiple>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <strong>Upload ảnh nhân vật</strong>
                <span>Tối đa 2 ảnh cho 1 nhân vật</span>
              </div>
              <div id="cc-preview" class="cc-preview-strip"></div>
            </div>
          </div>
          <div class="consistent-character-actions">
            <button id="cc-cancel" class="btn btn-secondary btn-sm" type="button">Hủy</button>
            <button id="cc-save" class="btn btn-primary btn-sm" type="button">Lưu nhân vật</button>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
    }
  }

  // ── Derived ────────────────────────────────────────────────────
  function filteredItems() {
    return libraryAssets.filter(a => {
      if (currentType !== 'all' && a.asset_type !== currentType) return false;
      if (currentGroup && a.category_id !== currentGroup) return false;
      return true;
    });
  }

  function groupCounts() {
    const counts = {};
    libraryCategories.forEach(c => { counts[c.id] = 0; });
    libraryAssets.forEach(a => {
      const cid = a.category_id;
      if (cid && counts[cid] !== undefined) counts[cid] = (counts[cid] || 0) + 1;
    });
    return counts;
  }

  // ── Render Sidebar ─────────────────────────────────────────────
  function renderGroups() {
    const list = $('lib-group-list');
    if (!list) return;
    const counts = groupCounts();

    const groups = libraryCategories;

    list.innerHTML = groups.map(g => `
      <div class="lib-group-item ${currentGroup === g.id ? 'active' : ''}"
           data-gid="${escHtml(g.id)}"
           data-special="${g.isSpecial ? '1' : '0'}"
           title="${escHtml(g.name)}">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${escHtml(g.name)}</span>
        <span class="lib-group-count">${counts[g.id] || 0}</span>
      </div>
    `).join('');

    list.querySelectorAll('.lib-group-item').forEach(el => {
      el.addEventListener('click', () => {
        currentGroup = el.dataset.gid;
        renderGroups();
        renderGrid();
      });
      el.addEventListener('contextmenu', e => {
        if (el.dataset.special === '1') return;
        e.preventDefault();
        ctxTargetGroupId = el.dataset.gid;
        showGroupContextMenu(e.clientX, e.clientY);
      });
    });
  }

  // ── Render Grid ────────────────────────────────────────────────
  function renderGrid() {
    const grid = $('char-grid');
    if (!grid) return;
    if (currentType === 'consistent') {
      renderConsistentGrid();
      return;
    }
    grid.classList.remove('consistent-grid');
    const items = filteredItems();
    const countLabel = $('lib-count-label');
    if (countLabel) countLabel.textContent = `${items.length} mục`;

    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text3);">
        <div style="font-size:36px;margin-bottom:12px;">📂</div>
        <div style="font-size:13px;">Chưa có ảnh nào. Nhấn <b>Upload</b> để thêm ảnh.</div>
      </div>`;
      updateInfoBar();
      return;
    }

    const typeLabel = { nhanvat:'Nhân Vật', vatpham:'Vật Phẩm', style:'Style', background:'Background' };

    grid.innerHTML = items.map(item => `
      <div class="lib-card ${selectedIds.has(item.id) ? 'selected' : ''}"
           data-id="${escHtml(item.id)}" data-type="${escHtml(item.asset_type || 'nhanvat')}">
        <input type="checkbox" class="lib-card-check" data-id="${escHtml(item.id)}"
               ${selectedIds.has(item.id) ? 'checked' : ''} onclick="event.stopPropagation()">
        <img src="${escHtml(item.url)}" alt="${escHtml(item.name)}" loading="lazy">
        <span class="lib-card-badge">${escHtml(typeLabel[item.asset_type] || 'Kho')}</span>
        <div class="lib-card-label lib-card-label--editable" data-id="${escHtml(item.id)}"
             title="Double-click để đổi tên">${escHtml(item.name) || 'Chưa đặt tên'}</div>
      </div>
    `).join('');

    // Checkbox change
    grid.querySelectorAll('.lib-card-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = e.target.dataset.id;
        e.target.checked ? selectedIds.add(id) : selectedIds.delete(id);
        grid.querySelector(`.lib-card[data-id="${id}"]`)?.classList.toggle('selected', e.target.checked);
        updateInfoBar();
      });
    });

    // Card click → toggle select
    grid.querySelectorAll('.lib-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.classList.contains('lib-card-check') || e.target.closest('.lib-card-label--editable')) return;
        const cb = card.querySelector('.lib-card-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      // Right-click on card
      card.addEventListener('contextmenu', e => {
        if (!selectedIds.size) {
          // auto-select this card
          const id = card.dataset.id;
          selectedIds.add(id);
          card.classList.add('selected');
          const cb = card.querySelector('.lib-card-check');
          if (cb) cb.checked = true;
          updateInfoBar();
        }
        e.preventDefault();
        showItemContextMenu(e.clientX, e.clientY);
      });
    });

    // Double-click label → rename
    grid.querySelectorAll('.lib-card-label--editable').forEach(el => {
      el.addEventListener('dblclick', e => {
        e.stopPropagation();
        const id = el.dataset.id;
        const item = libraryAssets.find(a => a.id === id);
        if (!item) return;
        const rect = el.getBoundingClientRect();
        showRenameInput(rect.left, rect.bottom + 4, item.name, async newName => {
          const res = await API.patch(`/api/image/library/assets/${id}/rename`, { name: newName });
          if (res.ok) { item.name = newName; renderGrid(); toast('Đã đổi tên', 'success'); }
          else toast(res.detail || 'Đổi tên thất bại', 'error');
        });
      });
    });

    updateInfoBar();
  }

  function renderConsistentGrid() {
    const grid = $('char-grid');
    if (!grid) return;
    grid.classList.add('consistent-grid');
    const countLabel = $('lib-count-label');
    if (countLabel) countLabel.textContent = `${consistentCharacters.length} nhân vật`;
    if (!consistentCharacters.length) {
      grid.innerHTML = `<div class="consistent-empty">
        <div class="consistent-empty-icon">+</div>
        <strong>Chưa có nhân vật đồng nhất</strong>
        <span>Bấm "Tạo nhân vật" để thêm ảnh, giọng nói và đồng bộ lên VEO.</span>
      </div>`;
      updateInfoBar();
      return;
    }
    grid.innerHTML = consistentCharacters.map(item => {
      const images = item.images || [];
      const main = images[0]?.url || '';
      const thumbs = images.map(img => `<img src="${escHtml(img.url)}" alt="">`).join('');
      return `
        <div class="consistent-card" data-id="${escHtml(item.id)}">
          <div class="consistent-card-image">
            ${main ? `<img src="${escHtml(main)}" alt="${escHtml(item.name)}" loading="lazy">` : ''}
          </div>
          <div class="consistent-card-body">
            <div class="consistent-card-title">${escHtml(item.name)}</div>
            <div class="consistent-card-voice"><span>♪</span>${escHtml(item.voice_name || item.voice_id || '')}</div>
            ${item.description ? `<div class="consistent-card-desc">${escHtml(item.description)}</div>` : ''}
            <div class="consistent-card-thumbs">${thumbs}</div>
            <div class="consistent-card-actions">
              <button class="btn btn-secondary btn-sm consistent-sync-btn" data-id="${escHtml(item.id)}" type="button">Đồng bộ lên VEO</button>
              <button class="btn btn-danger btn-sm consistent-delete-btn" data-id="${escHtml(item.id)}" type="button">Xóa</button>
            </div>
          </div>
        </div>`;
    }).join('');
    grid.querySelectorAll('.consistent-sync-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        syncConsistentCharacter(btn.dataset.id, btn);
      });
    });
    grid.querySelectorAll('.consistent-delete-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteConsistentCharacter(btn.dataset.id);
      });
    });
    updateInfoBar();
  }

  function updateInfoBar() {
    const delBtn = $('lib-delete-selected-btn');
    const countEl = $('lib-selected-count');
    const selAll = $('lib-select-all');
    const items = filteredItems();
    const uploadBtn = $('lib-upload-btn');
    const createBtn = $('consistent-create-btn');
    const sidebar = document.querySelector('#tab-character .lib-sidebar');
    if (uploadBtn) uploadBtn.style.display = currentType === 'consistent' ? 'none' : 'inline-flex';
    if (createBtn) createBtn.style.display = currentType === 'consistent' ? 'inline-flex' : 'none';
    if (sidebar) sidebar.style.display = currentType === 'consistent' ? 'none' : '';
    if (currentType === 'consistent') {
      if (delBtn) delBtn.style.display = 'none';
      if (countEl) countEl.textContent = '0';
      if (selAll) selAll.checked = false;
      return;
    }
    if (delBtn) delBtn.style.display = selectedIds.size > 0 ? 'inline-flex' : 'none';
    if (countEl) countEl.textContent = selectedIds.size;
    if (selAll) {
      selAll.checked = items.length > 0 && items.every(i => selectedIds.has(i.id));
      selAll.indeterminate = !selAll.checked && items.some(i => selectedIds.has(i.id));
    }
  }

  // ── API ────────────────────────────────────────────────────────
  async function loadAll() {
    const grid = $('char-grid');
    if (grid) grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const [catsRes, assetsRes, ccRes, voiceRes] = await Promise.all([
      API.get('/api/image/library/categories'),
      API.get('/api/image/library/assets'),
      API.get('/api/character/consistent/list'),
      API.get('/api/character/consistent/voices'),
    ]);
    libraryCategories = (catsRes.items || []).filter(c => c.id !== 'default');
    libraryAssets = assetsRes.items || [];
    consistentCharacters = ccRes.items || [];
    voicePresets = voiceRes.items || [];
    if (!currentGroup || !libraryCategories.some(c => c.id === currentGroup)) {
      currentGroup = libraryCategories[0]?.id || '';
    }
    renderGroups();
    renderGrid();
    populateWizardGroupList();
  }

  async function createGroup(name) {
    const n = name || window.prompt('Nhập tên nhóm mới:');
    if (!n || !n.trim()) return null;
    const res = await API.post('/api/image/library/categories', { name: n.trim() });
    if (!res.ok) { toast(res.detail || 'Tạo nhóm thất bại', 'error'); return null; }
    toast('Đã tạo nhóm', 'success');
    await loadAll();
    return res.item;
  }

  async function deleteItem(id) {
    if (!confirm('Xóa mục này?')) return;
    const res = await API.delete(`/api/image/library/assets/${id}`);
    if (res.ok || res.detail === undefined) {
      selectedIds.delete(id);
      toast('Đã xóa', 'success');
      await loadAll();
    } else toast(res.detail || 'Xóa thất bại', 'error');
  }

  async function deleteSelected() {
    if (!selectedIds.size) return toast('Chưa chọn mục nào', 'error');
    if (!confirm(`Xóa ${selectedIds.size} mục đã chọn?`)) return;
    await Promise.all([...selectedIds].map(id => API.delete(`/api/image/library/assets/${id}`)));
    selectedIds.clear();
    toast('Đã xóa các mục đã chọn', 'success');
    await loadAll();
  }

  function openConsistentPopup() {
    ensureConsistentCharacterUI();
    ccSelectedVoice = null;
    ccPreviewUrls.forEach(u => URL.revokeObjectURL(u));
    ccPreviewUrls = [];
    if ($('cc-name')) $('cc-name').value = '';
    if ($('cc-description')) $('cc-description').value = '';
    if ($('cc-images')) $('cc-images').value = '';
    if ($('cc-preview')) $('cc-preview').innerHTML = '';
    if ($('cc-voice-name')) $('cc-voice-name').textContent = 'Chọn giọng nói';
    if ($('cc-voice-desc')) $('cc-voice-desc').textContent = 'Chưa chọn';
    if ($('cc-voice-menu')) $('cc-voice-menu').style.display = 'none';
    renderVoiceList('');
    $('consistent-character-popup').style.display = 'flex';
  }

  function closeConsistentPopup() {
    const popup = $('consistent-character-popup');
    if (popup) popup.style.display = 'none';
  }

  function renderVoiceList(query) {
    const list = $('cc-voice-list');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();
    const items = voicePresets.filter(v => !q || String(v.name || '').toLowerCase().includes(q) || String(v.description || '').toLowerCase().includes(q));
    list.innerHTML = items.map(v => `
      <button class="cc-voice-option ${ccSelectedVoice?.id === v.id ? 'active' : ''}" data-id="${escHtml(v.id)}" type="button">
        <span class="cc-voice-avatar">♪</span>
        <span class="cc-voice-text"><strong>${escHtml(v.name)}</strong><small>${escHtml(v.description || '')}</small></span>
      </button>
    `).join('') || '<div class="cc-voice-empty">Không tìm thấy giọng nói</div>';
    list.querySelectorAll('.cc-voice-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const voice = voicePresets.find(v => v.id === btn.dataset.id);
        if (!voice) return;
        ccSelectedVoice = voice;
        $('cc-voice-name').textContent = voice.name;
        $('cc-voice-desc').textContent = voice.description || voice.id;
        $('cc-voice-menu').style.display = 'none';
      });
    });
  }

  function showConsistentPreviews(files) {
    ccPreviewUrls.forEach(u => URL.revokeObjectURL(u));
    ccPreviewUrls = [];
    const strip = $('cc-preview');
    if (!strip) return;
    strip.innerHTML = '';
    Array.from(files || []).slice(0, 2).forEach(file => {
      const url = URL.createObjectURL(file);
      ccPreviewUrls.push(url);
      strip.insertAdjacentHTML('beforeend', `<img src="${escHtml(url)}" alt="${escHtml(file.name)}">`);
    });
  }

  async function saveConsistentCharacter() {
    const files = Array.from($('cc-images')?.files || []).slice(0, 2);
    const name = ($('cc-name')?.value || '').trim();
    if (!name) return toast('Nhập tên nhân vật trước', 'error');
    if (!ccSelectedVoice) return toast('Chọn giọng nói trước', 'error');
    if (!files.length) return toast('Chọn tối thiểu 1 ảnh nhân vật', 'error');

    const btn = $('cc-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang lưu...'; }
    try {
      const fd = new FormData();
      files.forEach(file => fd.append('images', file));
      fd.append('name', name);
      fd.append('description', $('cc-description')?.value || '');
      fd.append('voice_id', ccSelectedVoice.id);
      fd.append('voice_name', ccSelectedVoice.name);
      fd.append('voice_desc', ccSelectedVoice.description || '');
      const res = await API.postForm('/api/character/consistent/create', fd);
      if (!res.ok) throw new Error(res.detail || 'Tạo nhân vật thất bại');
      toast('Đã tạo nhân vật đồng nhất', 'success');
      closeConsistentPopup();
      await loadAll();
    } catch (err) {
      toast(err.message || String(err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Lưu nhân vật'; }
    }
  }

  async function syncConsistentCharacter(id, btn) {
    if (!id) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Đang đồng bộ...'; }
    try {
      const res = await API.post('/api/character/consistent/sync', { id });
      if (!res.ok) throw new Error(res.detail || res.message || 'Đồng bộ thất bại');
      toast(`Đồng bộ VEO xong: ${res.synced || 0} account` + ((res.failed || 0) ? `, lỗi ${res.failed}` : ''), (res.failed || 0) ? 'info' : 'success');
      await loadAll();
    } catch (err) {
      toast('Lỗi đồng bộ VEO: ' + (err.message || err), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Đồng bộ lên VEO'; }
    }
  }

  async function deleteConsistentCharacter(id) {
    if (!id || !confirm('Xóa nhân vật đồng nhất này?')) return;
    const res = await API.delete(`/api/character/consistent/${id}`);
    if (res.ok || res.detail === undefined) {
      toast('Đã xóa nhân vật', 'success');
      await loadAll();
    } else {
      toast(res.detail || 'Xóa thất bại', 'error');
    }
  }

  async function moveSelectedToGroup(targetGroupId) {
    if (!selectedIds.size) return;
    const res = await API.post('/api/image/library/assets/move', {
      asset_ids: [...selectedIds],
      target_category_id: targetGroupId,
    });
    if (res.ok) { toast(`Đã chuyển ${res.moved} mục`, 'success'); selectedIds.clear(); await loadAll(); }
    else toast(res.detail || 'Chuyển nhóm thất bại', 'error');
  }

  // ── Upload Wizard ──────────────────────────────────────────────
  function populateWizardGroupList() {
    const container = $('lib-wiz-group-list');
    if (!container) return;
    container.innerHTML = libraryCategories.length
      ? libraryCategories.map(g => `
          <div class="lib-wiz-group-card" data-gid="${escHtml(g.id)}" data-gname="${escHtml(g.name)}">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            <span>${escHtml(g.name)}</span>
            <span class="lib-wiz-group-count">${libraryAssets.filter(a => a.category_id === g.id).length}</span>
          </div>
        `).join('')
      : '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px;">Chưa có nhóm nào.<br>Tạo nhóm mới bên dưới.</div>';

    container.querySelectorAll('.lib-wiz-group-card').forEach(el => {
      el.addEventListener('click', () => {
        wizSelectedGroup = { id: el.dataset.gid, name: el.dataset.gname };
        $('lib-wiz-group-name').textContent = el.dataset.gname;
        $('lib-wiz-step1').style.display = 'none';
        $('lib-wiz-step2').style.display = '';
      });
    });
  }

  function openUploadWizard() {
    wizSelectedGroup = null;
    wizSelectedType = 'nhanvat';
    $('lib-wiz-step1').style.display = '';
    $('lib-wiz-step2').style.display = 'none';
    $('lib-wiz-file').value = '';
    $('lib-wiz-name').value = '';
    $('lib-wiz-preview').innerHTML = '';
    // Reset type buttons
    $('lib-wiz-type-row').querySelectorAll('.lib-wiz-type-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.type === 'nhanvat');
    });
    $('lib-upload-popup').style.display = 'flex';
    populateWizardGroupList();
  }

  function closeUploadWizard() {
    $('lib-upload-popup').style.display = 'none';
    clearWizPreviews();
  }

  let _wizPreviewUrls = [];
  function clearWizPreviews() {
    _wizPreviewUrls.forEach(u => URL.revokeObjectURL(u));
    _wizPreviewUrls = [];
    const strip = $('lib-wiz-preview');
    if (strip) strip.innerHTML = '';
  }

  function showWizPreviews(files) {
    clearWizPreviews();
    const strip = $('lib-wiz-preview');
    if (!strip) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      _wizPreviewUrls.push(url);
      const img = document.createElement('img');
      img.src = url; img.title = file.name;
      strip.appendChild(img);
    });
  }

  async function doUpload() {
    if (!wizSelectedGroup) return toast('Chưa chọn nhóm', 'error');
    const fileInput = $('lib-wiz-file');
    const files = fileInput?.files;
    if (!files || !files.length) return toast('Chưa chọn ảnh', 'error');

    const btn = $('lib-wiz-upload-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang upload...'; }
    let failed = 0;
    const name = ($('lib-wiz-name')?.value || '').trim();

    for (const file of files) {
      const fd = new FormData();
      fd.append('image', file);
      fd.append('name', files.length === 1 && name ? name : file.name.replace(/\.[^.]+$/, ''));
      fd.append('category_id', wizSelectedGroup.id);
      fd.append('asset_type', wizSelectedType);
      const res = await API.postForm('/api/image/library/upload', fd);
      if (!res.ok) failed++;
    }

    const ok = files.length - failed;
    if (ok > 0) toast(`Đã upload ${ok} ảnh vào nhóm ${wizSelectedGroup.name}`, 'success');
    if (failed > 0) toast(`${failed} ảnh thất bại`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }

    clearWizPreviews();
    fileInput.value = '';
    closeUploadWizard();
    await loadAll();
  }

  // ── Right-click menus ──────────────────────────────────────────
  function hideAllMenus() {
    ['lib-context-menu','lib-group-context-menu','lib-move-group-menu'].forEach(id => {
      const el = $(id);
      if (el) el.style.display = 'none';
    });
  }

  function showItemContextMenu(x, y) {
    hideAllMenus();
    const menu = $('lib-context-menu');
    if (!menu) return;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.display = 'block';
    // Clamp to viewport
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
    });
  }

  function showGroupContextMenu(x, y) {
    hideAllMenus();
    const menu = $('lib-group-context-menu');
    if (!menu) return;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.display = 'block';
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
    });
  }

  function showMoveGroupMenu(x, y) {
    hideAllMenus();
    const menu = $('lib-move-group-menu');
    if (!menu) return;
    const listEl = $('lib-move-group-list');
    if (listEl) {
      listEl.innerHTML = libraryCategories.map(g => `
        <div class="lib-ctx-item lib-move-group-opt" data-gid="${escHtml(g.id)}">${escHtml(g.name)}</div>
      `).join('');
      listEl.querySelectorAll('.lib-move-group-opt').forEach(el => {
        el.addEventListener('click', () => {
          hideAllMenus();
          moveSelectedToGroup(el.dataset.gid);
        });
      });
    }
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.style.display = 'block';
  }

  // ── Rename input ───────────────────────────────────────────────
  function showRenameInput(x, y, currentName, onConfirm) {
    const wrap = $('lib-rename-wrap');
    const inp  = $('lib-rename-input');
    if (!wrap || !inp) return;
    renameCallback = onConfirm;
    inp.value = currentName;
    wrap.style.left = Math.min(x, window.innerWidth - 240) + 'px';
    wrap.style.top  = y + 'px';
    wrap.style.display = 'block';
    inp.focus(); inp.select();
  }

  function hideRenameInput() {
    const wrap = $('lib-rename-wrap');
    if (wrap) wrap.style.display = 'none';
    renameCallback = null;
  }

  async function confirmRename() {
    const inp = $('lib-rename-input');
    const val = inp?.value.trim();
    if (!val) return toast('Tên không được trống', 'error');
    if (renameCallback) await renameCallback(val);
    hideRenameInput();
  }

  // ── Init ───────────────────────────────────────────────────────
  window.init_character = function () {
    ensureConsistentCharacterUI();
    // Type filter tabs
    document.querySelectorAll('.lib-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lib-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentType = btn.dataset.type;
        selectedIds.clear();
        renderGrid();
      });
    });

    // Upload button → open wizard
    $('lib-upload-btn')?.addEventListener('click', openUploadWizard);
    $('consistent-create-btn')?.addEventListener('click', openConsistentPopup);
    $('consistent-character-close')?.addEventListener('click', closeConsistentPopup);
    $('cc-cancel')?.addEventListener('click', closeConsistentPopup);
    $('cc-save')?.addEventListener('click', saveConsistentCharacter);
    $('consistent-character-popup')?.addEventListener('click', e => {
      if (e.target === $('consistent-character-popup')) closeConsistentPopup();
    });
    $('cc-voice-trigger')?.addEventListener('click', () => {
      const menu = $('cc-voice-menu');
      if (!menu) return;
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
      if (menu.style.display === 'block') $('cc-voice-search')?.focus();
    });
    $('cc-voice-search')?.addEventListener('input', e => renderVoiceList(e.target.value));

    const ccZone = $('cc-upload-zone');
    const ccInput = $('cc-images');
    if (ccZone && ccInput && !ccZone.dataset.bound) {
      ccZone.dataset.bound = '1';
      ccZone.addEventListener('click', e => { if (e.target !== ccInput) ccInput.click(); });
      ccInput.addEventListener('click', e => e.stopPropagation());
      ccInput.addEventListener('change', () => {
        const dt = new DataTransfer();
        Array.from(ccInput.files || []).slice(0, 2).forEach(f => dt.items.add(f));
        ccInput.files = dt.files;
        showConsistentPreviews(ccInput.files);
      });
      ccZone.addEventListener('dragover', e => { e.preventDefault(); ccZone.classList.add('drag-over'); });
      ccZone.addEventListener('dragleave', () => ccZone.classList.remove('drag-over'));
      ccZone.addEventListener('drop', e => {
        e.preventDefault();
        ccZone.classList.remove('drag-over');
        const dt = new DataTransfer();
        Array.from(e.dataTransfer?.files || []).slice(0, 2).forEach(f => dt.items.add(f));
        ccInput.files = dt.files;
        showConsistentPreviews(ccInput.files);
      });
    }

    // Wizard close
    $('lib-upload-wizard-close')?.addEventListener('click', closeUploadWizard);
    $('lib-upload-popup')?.addEventListener('click', e => { if (e.target === $('lib-upload-popup')) closeUploadWizard(); });

    // Wizard: tạo nhóm mới
    $('lib-wiz-new-group-btn')?.addEventListener('click', async () => {
      const item = await createGroup();
      if (item) {
        wizSelectedGroup = { id: item.id, name: item.name };
        $('lib-wiz-group-name').textContent = item.name;
        $('lib-wiz-step1').style.display = 'none';
        $('lib-wiz-step2').style.display = '';
      }
    });

    // Wizard: back
    $('lib-wiz-back-btn')?.addEventListener('click', () => {
      $('lib-wiz-step1').style.display = '';
      $('lib-wiz-step2').style.display = 'none';
    });

    // Wizard: type buttons
    $('lib-wiz-type-row')?.querySelectorAll('.lib-wiz-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('lib-wiz-type-row').querySelectorAll('.lib-wiz-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        wizSelectedType = btn.dataset.type;
      });
    });

    // Wizard: upload zone
    const wzone = $('lib-wiz-zone');
    const wfile = $('lib-wiz-file');
    if (wzone && wfile) {
      if (!wzone.dataset.bound) {
        wzone.dataset.bound = '1';
        wzone.addEventListener('click', e => { if (e.target !== wfile) wfile.click(); });
        wfile.addEventListener('click', e => e.stopPropagation());
        wfile.addEventListener('change', () => showWizPreviews(wfile.files));
        wzone.addEventListener('dragover', e => { e.preventDefault(); wzone.classList.add('drag-over'); });
        wzone.addEventListener('dragleave', () => wzone.classList.remove('drag-over'));
        wzone.addEventListener('drop', e => {
          e.preventDefault(); wzone.classList.remove('drag-over');
          const dt = new DataTransfer();
          Array.from(e.dataTransfer?.files || []).forEach(f => dt.items.add(f));
          wfile.files = dt.files;
          showWizPreviews(wfile.files);
        });
      }
    }

    $('lib-wiz-upload-btn')?.addEventListener('click', doUpload);
    $('lib-wiz-cancel-btn')?.addEventListener('click', closeUploadWizard);

    // Sidebar: add group
    $('lib-add-group-btn')?.addEventListener('click', () => createGroup());

    // Info bar
    $('lib-select-all')?.addEventListener('change', e => {
      const items = filteredItems();
      if (e.target.checked) items.forEach(i => selectedIds.add(i.id));
      else items.forEach(i => selectedIds.delete(i.id));
      renderGrid();
    });
    $('lib-delete-selected-btn')?.addEventListener('click', deleteSelected);
    $('lib-download-sel-btn')?.addEventListener('click', () => {
      const items = filteredItems().filter(i => selectedIds.has(i.id));
      if (!items.length) return toast('Chưa chọn mục nào', 'info');
      items.forEach(i => {
        const a = document.createElement('a');
        a.href = i.url; a.download = i.name || 'image'; a.click();
      });
    });

    // Context menu: items
    $('lib-ctx-delete')?.addEventListener('click', () => { hideAllMenus(); deleteSelected(); });
    $('lib-ctx-move')?.addEventListener('click', e => {
      const rect = e.target.getBoundingClientRect();
      showMoveGroupMenu(rect.right + 4, rect.top);
    });

    // Context menu: group
    $('lib-ctx-group-rename')?.addEventListener('click', () => {
      hideAllMenus();
      if (!ctxTargetGroupId) return;
      const g = libraryCategories.find(c => c.id === ctxTargetGroupId);
      if (!g) return;
      // Find DOM element position
      const el = document.querySelector(`.lib-group-item[data-gid="${ctxTargetGroupId}"]`);
      const rect = el ? el.getBoundingClientRect() : { left: 200, bottom: 200 };
      showRenameInput(rect.left + rect.width + 8, rect.top, g.name, async newName => {
        const res = await API.patch(`/api/image/library/categories/${ctxTargetGroupId}/rename`, { name: newName });
        if (res.ok) { g.name = newName; renderGroups(); toast('Đã đổi tên nhóm', 'success'); }
        else toast(res.detail || 'Đổi tên thất bại', 'error');
      });
    });

    $('lib-ctx-group-delete')?.addEventListener('click', async () => {
      hideAllMenus();
      if (!ctxTargetGroupId) return;
      const g = libraryCategories.find(c => c.id === ctxTargetGroupId);
      if (!g) return;
      if (!confirm(`Xóa nhóm "${g.name}"? Nhóm phải trống mới xóa được.`)) return;
      const res = await API.delete(`/api/image/library/categories/${ctxTargetGroupId}`);
      if (res.ok) {
        if (currentGroup === ctxTargetGroupId) currentGroup = 'all';
        toast('Đã xóa nhóm', 'success');
        await loadAll();
      } else toast(res.detail || 'Xóa nhóm thất bại', 'error');
    });

    // Rename input controls
    $('lib-rename-ok')?.addEventListener('click', confirmRename);
    $('lib-rename-cancel')?.addEventListener('click', hideRenameInput);
    $('lib-rename-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
      if (e.key === 'Escape') hideRenameInput();
    });

    // Close menus on outside click
    document.addEventListener('click', e => {
      const menus = ['lib-context-menu','lib-group-context-menu','lib-move-group-menu'];
      menus.forEach(id => {
        const el = $(id);
        if (el && !el.contains(e.target)) el.style.display = 'none';
      });
      const renameWrap = $('lib-rename-wrap');
      if (renameWrap && !renameWrap.contains(e.target)) hideRenameInput();
    }, true);

    loadAll();
  };

  // Expose for Studio module to read + refresh library immediately after save
  window.LibraryModule = {
    getAssets: () => libraryAssets,
    getCategories: () => libraryCategories,
    refresh: async () => {
      await loadAll();
    }
  };
})();
