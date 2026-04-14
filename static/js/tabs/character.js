/* Character library tab */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let selectedIds = new Set();
  let loaded = false;
  let previewUrl = '';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderGrid(chars) {
    const grid = $('char-grid');
    if (!grid) return;

    if (!chars.length) {
      grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có nhân vật nào trong thư viện.</div>';
      return;
    }

    grid.innerHTML = chars.map(ch => {
      const checked = selectedIds.has(ch.id) ? 'checked' : '';
      const syncLabel = ch.synced ? 'Đã sync' : 'Chưa sync';
      const syncClass = ch.synced ? 'var(--green)' : 'var(--text3)';
      return `
        <div class="char-card" data-id="${escapeHtml(ch.id)}" style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;">
          <div style="position:relative;">
            <img src="${escapeHtml(ch.url)}" alt="${escapeHtml(ch.name)}" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;">
            <label style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);border-radius:6px;padding:4px 6px;display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" class="char-select" data-id="${escapeHtml(ch.id)}" ${checked}>
              <span style="font-size:11px;color:#fff;">Chọn</span>
            </label>
          </div>
          <div style="padding:10px;">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px;">${escapeHtml(ch.name)}</div>
            <div style="font-size:11px;color:${syncClass};margin-bottom:10px;">${syncLabel}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm char-sync-one" data-id="${escapeHtml(ch.id)}" ${ch.synced ? 'disabled' : ''}>Sync</button>
              <button class="btn btn-secondary btn-sm char-delete" data-id="${escapeHtml(ch.id)}">Xóa</button>
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
      btn.addEventListener('click', async () => {
        await syncIds([btn.dataset.id]);
      });
    });

    grid.querySelectorAll('.char-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const res = await API.delete(`/api/character/${id}`);
        if (res.ok) {
          selectedIds.delete(id);
          toast('Đã xóa nhân vật', 'success');
          await loadCharacters();
        } else {
          toast(res.detail || 'Xóa nhân vật thất bại', 'error');
        }
      });
    });
  }

  async function loadCharacters() {
    const grid = $('char-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const res = await API.get('/api/character/list');
    renderGrid(res.data || []);
  }

  async function uploadCharacter() {
    const fileInput = $('char-file');
    const nameInput = $('char-name');
    const preview = $('char-upload-preview');
    const file = fileInput?.files?.[0];
    const name = (nameInput?.value || '').trim() || 'Character';
    if (!file) {
      toast('Chọn ảnh nhân vật trước đã', 'error');
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
        toast(res.detail || 'Upload nhân vật thất bại', 'error');
        return;
      }
      toast(res.warning || 'Đã thêm nhân vật vào thư viện', 'success');
      fileInput.value = '';
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
      if (preview) {
        preview.src = '';
        preview.style.display = 'none';
      }
      await loadCharacters();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function syncIds(ids) {
    if (!ids.length) {
      toast('Chưa chọn nhân vật nào', 'error');
      return;
    }
    const res = await API.post('/api/character/sync', { ids });
    if (res.ok) {
      toast(res.message || `Đã sync ${ids.length} nhân vật`, 'success');
      await loadCharacters();
    } else {
      toast(res.detail || res.message || 'Sync nhân vật thất bại', 'error');
    }
  }

  async function syncAll() {
    const res = await API.post('/api/character/sync-all', {});
    if (res.ok) {
      toast(res.message || 'Đã sync toàn bộ nhân vật', 'success');
      await loadCharacters();
    } else {
      toast(res.detail || res.message || 'Sync tất cả thất bại', 'error');
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
    input.addEventListener('change', () => {
      updatePreview(input.files?.[0] || null);
    });

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
    $('char-upload-btn')?.addEventListener('click', uploadCharacter);
    $('char-sync-selected-btn')?.addEventListener('click', () => syncIds([...selectedIds]));
    $('char-sync-all-btn')?.addEventListener('click', syncAll);

    if (!loaded) {
      loaded = true;
      loadCharacters();
    } else {
      loadCharacters();
    }
  };
})();
