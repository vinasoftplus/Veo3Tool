/* Unified library tab */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let selectedIds = new Set();
  let loaded = false;
  let previewUrl = '';
  let currentCategory = 'all';
  let libraryCategories = [];
  let libraryAssets = [];
  let libraryCharacters = [];

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureLibraryToolbar() {
    if ($('library-toolbar')) return;
    const grid = $('char-grid');
    if (!grid || !grid.parentElement) return;
    const wrap = document.createElement('div');
    wrap.id = 'library-toolbar';
    wrap.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;';
    wrap.innerHTML = `
      <select id="library-category-filter" class="t2v-select" style="min-width:220px;"></select>
      <button id="library-create-category" class="btn btn-secondary" type="button">Tạo danh mục</button>
      <span style="font-size:12px;color:var(--text2);">Kho hiển thị ảnh đã lưu về nhân vật trong cùng một nơi.</span>
    `;
    grid.parentElement.insertBefore(wrap, grid);
    $('library-category-filter').addEventListener('change', e => {
      currentCategory = e.target.value;
      renderGrid();
    });
    $('library-create-category').addEventListener('click', createCategory);
  }

  function renderCategoryFilter() {
    const sel = $('library-category-filter');
    if (!sel) return;
    const options = [
      { id: 'all', name: 'T?t c? t?i nguy?n' },
      { id: '__characters__', name: 'Nh?n v?t' },
      ...libraryCategories,
    ];
    sel.innerHTML = options.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    sel.value = currentCategory;
  }

  function mergedItems() {
    const chars = libraryCharacters.map(ch => ({
      id: ch.id,
      type: 'character',
      name: ch.name,
      url: ch.url,
      category_id: '__characters__',
      category_name: 'Nh?n v?t',
      synced: !!ch.synced,
      media_id: ch.media_id || '',
    }));
    const assets = libraryAssets.map(a => ({
      id: a.id,
      type: 'asset',
      name: a.name,
      url: a.url,
      category_id: a.category_id || 'default',
      category_name: a.category_name || 'M?c ??nh',
      prompt: a.prompt || '',
    }));
    const merged = [...chars, ...assets];
    if (currentCategory === 'all') return merged;
    return merged.filter(item => item.category_id === currentCategory);
  }

  function renderGrid() {
    const grid = $('char-grid');
    if (!grid) return;
    const items = mergedItems();
    if (!items.length) {
      grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có dữ liệu trong danh mục này.</div>';
      return;
    }
    grid.innerHTML = items.map(item => {
      const isChar = item.type === 'character';
      const checked = isChar && selectedIds.has(item.id) ? 'checked' : '';
      const badge = isChar ? (item.synced ? '✅ sync' : 'Chưa sync') : item.category_name;
      const badgeColor = isChar ? (item.synced ? 'var(--green)' : 'var(--text3)') : 'var(--accent)';
      return `
        <div class="char-card" data-id="${escapeHtml(item.id)}" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;">
          <div style="position:relative;">
            <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;">
            ${isChar ? `<label style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);border-radius:6px;padding:4px 6px;display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="char-select" data-id="${escapeHtml(item.id)}" ${checked}><span style="font-size:11px;color:#fff;">Chọn</span></label>` : ''}
            <span style="position:absolute;right:8px;top:8px;background:rgba(0,0,0,.62);border-radius:999px;padding:4px 8px;font-size:11px;color:#fff;">${isChar ? 'Nhân vật' : 'Kho'}</span>
          </div>
          <div style="padding:10px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.name)}</div>
            <div style="font-size:11px;color:${badgeColor};margin-bottom:10px;">${escapeHtml(badge)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${isChar ? `<button class="btn btn-secondary btn-sm char-sync-one" data-id="${escapeHtml(item.id)}" ${item.synced ? 'disabled' : ''}>Sync</button>
              <button class="btn btn-secondary btn-sm char-delete" data-id="${escapeHtml(item.id)}">Xóa</button>` : `<button class="btn btn-secondary btn-sm library-copy-prompt" data-prompt="${escapeHtml(item.prompt || '')}">Xem prompt</button>`}
            </div>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.char-select').forEach(input => {
      input.addEventListener('change', e => {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedIds.add(id);
        else selectedIds.delete(id);
      });
    });
    grid.querySelectorAll('.char-sync-one').forEach(btn => {
      btn.addEventListener('click', async () => syncIds([btn.dataset.id]));
    });
    grid.querySelectorAll('.char-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const res = await API.delete(`/api/character/${id}`);
        if (res.ok) {
          selectedIds.delete(id);
          toast('?? x?a nh?n v?t', 'success');
          await loadAll();
        } else {
          toast(res.detail || 'X?a nh?n v?t th?t b?i', 'error');
        }
      });
    });
    grid.querySelectorAll('.library-copy-prompt').forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt || '';
        if (!prompt) return toast('?nh n?y ch?a c? prompt l?u k?m', 'info');
        navigator.clipboard?.writeText(prompt).then(() => toast('?? copy prompt', 'success')).catch(() => toast(prompt, 'info', 7000));
      });
    });
  }

  async function loadAll() {
    ensureLibraryToolbar();
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
    renderCategoryFilter();
    renderGrid();
  }

  async function createCategory() {
    const name = prompt('Nh?p t?n danh m?c m?i:');
    if (!name || !name.trim()) return;
    const res = await API.post('/api/image/library/categories', { name: name.trim() });
    if (!res.ok) return toast(res.detail || 'T?o danh m?c th?t b?i', 'error');
    currentCategory = res.item?.id || 'all';
    toast('?? t?o danh m?c m?i', 'success');
    await loadAll();
  }

  async function uploadCharacter() {
    const fileInput = $('char-file');
    const nameInput = $('char-name');
    const preview = $('char-upload-preview');
    const file = fileInput?.files?.[0];
    const name = (nameInput?.value || '').trim() || 'Character';
    if (!file) {
      toast('Ch?n ?nh nh?n v?t tr??c ??', 'error');
      return;
    }
    const fd = new FormData();
    fd.append('image', file);
    fd.append('name', name);
    const btn = $('char-upload-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await API.postForm('/api/character/upload', fd);
      if (!res.ok) {
        toast(res.detail || 'Upload nh?n v?t th?t b?i', 'error');
        return;
      }
      toast(res.warning || '?? th?m nh?n v?t v?o kho', 'success');
      fileInput.value = '';
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
      if (preview) {
        preview.src = '';
        preview.style.display = 'none';
      }
      await loadAll();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function syncIds(ids) {
    if (!ids.length) return toast('Chưa chọn nhân vật nào', 'error');
    const res = await API.post('/api/character/sync', { ids });
    if (res.ok) {
      toast(res.message || `✅ sync ${ids.length} nhân vật`, 'success');
      await loadAll();
    } else {
      toast(res.detail || res.message || 'Sync nhân vật thất bại', 'error');
    }
  }

  async function syncAll() {
    const res = await API.post('/api/character/sync-all', {});
    if (res.ok) {
      toast(res.message || '?? sync to?n b? nh?n v?t', 'success');
      await loadAll();
    } else {
      toast(res.detail || res.message || 'Sync t?t c? th?t b?i', 'error');
    }
  }

  function bindUploadZone() {
    const zone = $('char-upload-zone');
    const input = $('char-file');
    const preview = $('char-upload-preview');
    if (!zone || !input || zone.dataset.bound === '1') return;
    zone.dataset.bound = '1';

    function updatePreview(file) {
      if (!preview) return;
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
      if (!file) {
        preview.src = '';
        preview.style.display = 'none';
        return;
      }
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.style.display = 'block';
    }

    zone.addEventListener('click', e => {
      if (e.target === input) return;
      input.click();
    });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => updatePreview(input.files?.[0] || null));
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      updatePreview(f);
    });
  }

  window.init_character = function () {
    bindUploadZone();
    ensureLibraryToolbar();
    const title = document.querySelector('#tab-character .card-title');
    if (title) title.textContent = 'Kho l?u tr?';
    $('char-upload-btn')?.addEventListener('click', uploadCharacter);
    $('char-sync-selected-btn')?.addEventListener('click', () => syncIds([...selectedIds]));
    $('char-sync-all-btn')?.addEventListener('click', syncAll);
    if (!loaded) loaded = true;
    loadAll();
  };
})();
