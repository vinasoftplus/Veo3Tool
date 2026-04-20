/* Unified Studio override */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const cfg = { aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE', model: 'flow_fast', imageModel: 'Nano Banana pro', imageCount: 1, videoCount: 1, autoUpscale: false, autoDownload: false, saveHandle: null, saveFolder: '' };
  let ready = false;
  let stopAll = false;
  // Semaphore dùng chung cho cả tạo lẻ lẫn hàng loạt — tránh burst reCAPTCHA
  let _globalVideoSem = null;
  function _getGlobalVideoSem() {
    if (!_globalVideoSem) _globalVideoSem = makeSemaphore(3); // default 3, sẽ được cập nhật theo config
    return _globalVideoSem;
  }
  let seq = 0;
  let _activeFilter = 'all'; // all | running | completed | failed | img-running | img-completed | img-failed
  let _cardLayout = localStorage.getItem('studioCardLayout') || 'vertical';
  let popup = null;
  let cards = [];
  let libraryAssets = [];
  let libraryCharacters = [];
  let libraryCategories = [];
  let libraryPickerCardId = '';
  const isDefaultCategory = (cat) => {
    const id = String(cat?.id || '').toLowerCase();
    const name = norm(cat?.name || '');
    return id === 'default' || name === 'mac dinh';
  };

  const norm = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();

  function parsePrompts(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    if (/^SCENE\s+\d+[:\s]/im.test(raw)) {
      const chunks = [];
      let block = [];
      raw.split(/\r?\n/).forEach(line => {
        if (/^SCENE\s+\d+[:\s]/i.test(line) && block.length) {
          chunks.push(block.join('\n').trim());
          block = [line];
        } else {
          block.push(line);
        }
      });
      if (block.join('').trim()) chunks.push(block.join('\n').trim());
      return chunks.filter(Boolean);
    }
    return raw.split(/\r?\n{2,}/).map(x => x.trim()).filter(Boolean);
  }

  function parseJsonPromptCards(text) {
    let data = null;
    try {
      data = JSON.parse(String(text || '').trim());
    } catch (_) {
      return [];
    }
    const list = Array.isArray(data) ? data : [data];
    return list.map(item => {
      if (!item || typeof item !== 'object') return null;
      // Dùng toàn bộ JSON object làm prompt (stringify đẹp)
      const prompt = JSON.stringify(item, null, 2);
      const charNames = [];
      if (item.characters && typeof item.characters === 'object') {
        if (item.characters.main) charNames.push(String(item.characters.main));
        if (Array.isArray(item.characters.others)) charNames.push(...item.characters.others.map(x => String(x)));
      }
      if (item.attachments && Array.isArray(item.attachments.characters)) {
        charNames.push(...item.attachments.characters.map(x => String(x)));
      }
      return {
        prompt,
        raw: item,
        charHints: Array.from(new Set(charNames.map(x => x.trim()).filter(Boolean))),
      };
    }).filter(Boolean);
  }

  function newCard(prompt = '') {
    return { id: 'studio-' + (++seq), prompt, refs: [], refIndex: 0, chars: [], images: [], outputs: [], outputIndex: 0, status: 'idle', error: '', jobId: null, busyImage: false, busyVideo: false, upscaling: false, videoAccountIndex: null };
  }


  function _cardMatchesFilter(card, filter) {
    if (!card) return false;
    if (filter === 'all') return true;
    if (filter === 'running') return !!(card.busyVideo || (card.status === 'running' && !card.busyImage));
    if (filter === 'processing') return card.status === 'processing' || !!card.upscaling;
    if (filter === 'completed') return card.status === 'completed';
    if (filter === 'failed') return card.status === 'failed';
    if (filter === 'img-running') return !!card.busyImage;
    if (filter === 'img-completed') return !!card.images.length;
    if (filter === 'img-failed') return card.status === 'failed' && !card.outputs.length;
    return false;
  }

  function _getFilteredCount(filter) {
    return cards.reduce((acc, card) => acc + (_cardMatchesFilter(card, filter) ? 1 : 0), 0);
  }

  function updateStats() {
    const pending = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running' || c.status === 'processing' || c.busyImage).length;
    const videoDone = cards.filter(c => c.status === 'completed').length;
    const videoProcessing = cards.filter(c => c.status === 'processing' || c.upscaling).length;
    const imageDone = cards.filter(c => c.images.length > 0).length;
    const failed = cards.filter(c => c.status === 'failed').length;
    const videoRunning = cards.filter(c => c.busyVideo || (c.status === 'running' && !c.busyImage)).length;
    const imageRunning = cards.filter(c => c.busyImage).length;
    const imageFailed = cards.filter(c => c.status === 'failed' && !c.outputs.length).length;
    const el = id => document.getElementById(id);
    if (el('studio-pending-count')) el('studio-pending-count').textContent = pending;
    if (el('studio-saved-count')) el('studio-saved-count').textContent = videoDone;
    if (el('studio-metric-total')) el('studio-metric-total').textContent = cards.length + ' cụm';
    if (el('studio-metric-running')) el('studio-metric-running').textContent = running + ' đang chạy';
    if (el('studio-metric-done')) el('studio-metric-done').textContent = videoDone + ' video / ' + imageDone + ' ảnh';
    if (el('studio-metric-failed')) el('studio-metric-failed').textContent = failed + ' lỗi';
    if (el('studio-status-text')) el('studio-status-text').textContent = cards.length ? ('Studio theo dõi ' + cards.length + ' cụm.') : 'Chưa có batch. Import prompt hoặc thêm cụm để bắt đầu.';
    if (el('studio-filter-current')) {
      const currentMap = {
        all: 'Tất cả cụm',
        running: 'Đang chạy',
        processing: 'Đang xử lý',
        completed: 'Xong',
        failed: 'Lỗi',
        'img-running': 'Ảnh đang chạy',
        'img-completed': 'Ảnh hoàn tất',
        'img-failed': 'Ảnh lỗi',
      };
      el('studio-filter-current').textContent = `${currentMap[_activeFilter] || 'Tất cả cụm'} : ${_getFilteredCount(_activeFilter)}`;
    }
    if (el('studio-filter-total-count')) el('studio-filter-total-count').textContent = cards.length;
    if (el('studio-filter-running-count')) el('studio-filter-running-count').textContent = videoRunning;
    if (el('studio-filter-processing-count')) el('studio-filter-processing-count').textContent = videoProcessing;
    if (el('studio-filter-done-count')) el('studio-filter-done-count').textContent = videoDone;
    if (el('studio-filter-failed-count')) el('studio-filter-failed-count').textContent = failed;
    if (el('studio-filter-image-running-count')) el('studio-filter-image-running-count').textContent = imageRunning;
    if (el('studio-filter-image-done-count')) el('studio-filter-image-done-count').textContent = imageDone;
    if (el('studio-filter-image-failed-count')) el('studio-filter-image-failed-count').textContent = imageFailed;
    if (el('studio-empty')) el('studio-empty').style.display = cards.length ? 'none' : '';
    // Update active filter highlight — dùng data-filter thay vì id trùng
    document.querySelectorAll('[data-studio-filter]').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.studioFilter === _activeFilter);
    });
    applyFilter();
  }

  function applyFilter() {
    const container = $('studio-cards');
    if (!container) return;
    container.querySelectorAll('.studio-card').forEach(el => {
      const card = cards.find(c => 'card-' + c.id === el.id);
      if (!card) return;
      el.style.display = _cardMatchesFilter(card, _activeFilter) ? '' : 'none';
    });
  }

  function setFilter(f) {
    _activeFilter = f;
    updateStats();
  }

  function _setFolderLabel(text) {
    const el = $('studio-folder-label');
    if (!el) return;
    const path = (text || '').trim();
    el.textContent = path ? `AutoSave: ${path}` : 'AutoSave: chưa chọn';
    el.title = path || 'Chưa chọn folder';
    el.style.color = path ? 'var(--accent)' : '';
  }

  function _syncAutoDownloadUILegacy() {
    const autoCb = $('studio-auto-download');
    const autoLabel = $('studio-auto-download-label');
    const hasFolder = !!(cfg.saveHandle || cfg.saveFolder);
    if (autoCb) {
      if (!hasFolder && autoCb.checked) {
        autoCb.checked = false;
        cfg.autoDownload = false;
      }
    }
    if (autoLabel) {
      autoLabel.textContent = hasFolder
        ? `AutoSave: ${cfg.saveFolder || cfg.saveHandle?.name || ''}`
        : 'Auto Lưu (chưa chọn folder)';
      autoLabel.title = hasFolder ? (cfg.saveFolder || cfg.saveHandle?.name || '') : 'Chọn folder để bật Auto Lưu';
    }
  }

  // Override UI sync to keep AutoSave path on folder button (full text)
  function _syncAutoDownloadUI() {
    const autoCb = $('studio-auto-download');
    const autoLabel = $('studio-auto-download-label');
    const hasFolder = !!(cfg.saveHandle || cfg.saveFolder);
    const folderPath = (cfg.saveFolder || cfg.saveHandle?.name || '').trim();
    if (autoCb && !hasFolder && autoCb.checked) {
      autoCb.checked = false;
      cfg.autoDownload = false;
    }
    if (autoLabel) {
      autoLabel.textContent = 'Auto Lưu';
      autoLabel.title = hasFolder ? `Folder AutoSave: ${folderPath}` : 'Bật Auto Lưu sẽ yêu cầu chọn folder';
    }
    _setFolderLabel(folderPath);
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        cfg.saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        cfg.saveFolder = cfg.saveHandle.name;
        _setFolderLabel(cfg.saveFolder);
        _syncAutoDownloadUI();
        toast('Đã chọn folder: ' + cfg.saveHandle.name, 'success');
        return;
      } catch (e) {
        if (e.name !== 'AbortError') toast('Không thể chọn folder', 'error');
        return;
      }
    }
    const path = prompt('Nhập đường dẫn folder lưu video:', cfg.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      cfg.saveFolder = path;
      _setFolderLabel(path);
      _syncAutoDownloadUI();
      toast('Đã lưu folder: ' + path, 'success');
    }
  }

  async function pickManualDownloadFolder() {
    if (!window.showDirectoryPicker) return null;
    try {
      return await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (_) {
      return null;
    }
  }

  async function saveVideo(url, filename, dirHandle = cfg.saveHandle) {
    if (dirHandle) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const handle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('Đã lưu ' + filename, 'success');
        return;
      } catch (_) { }
    }
    // Dùng proxy backend để tránh CORS, buộc trình duyệt download
    const proxyUrl = `/api/veo/proxy-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
    const a = document.createElement('a');
    a.href = proxyUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function urlToFile(url, filename) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new File([blob], filename || ('studio_' + Date.now() + '.png'), { type: blob.type || 'image/png' });
  }

  async function loadLibrarySources() {
    const [catsRes, assetsRes, charsRes] = await Promise.all([
      API.get('/api/image/library/categories'),
      API.get('/api/image/library/assets'),
      API.get('/api/character/list'),
    ]);
    libraryCategories = (catsRes.items || []).filter(c => !isDefaultCategory(c));
    libraryAssets = assetsRes.items || [];
    libraryCharacters = charsRes.data || [];
    populateLibraryCategoryFilters();
  }

  function populateLibraryCategoryFilters() {
    const saveSel = $('studio-save-category');
    const pickerSel = $('studio-library-category-filter');
    if (saveSel) {
      saveSel.innerHTML = libraryCategories.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
      if (!saveSel.value && libraryCategories[0]) saveSel.value = libraryCategories[0].id;
    }
    if (pickerSel) {
      const current = pickerSel.value;
      pickerSel.innerHTML = libraryCategories.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
      if (current && libraryCategories.some(c => c.id === current)) pickerSel.value = current;
      else if (libraryCategories[0]) pickerSel.value = libraryCategories[0].id;
    }
  }

  function combinedRefs(card) {
    const chars = (card.chars || []).map((ch, i) => ({ kind: 'char', idx: i, url: ch.url, name: ch.name }));
    const refs = (card.refs || []).map((ref, i) => ({ kind: 'ref', idx: i, url: ref.url, name: ref.label || `Ảnh ${i + 1}` }));
    return [...chars, ...refs];
  }

  function renderCombinedRefThumbs(card) {
    const items = combinedRefs(card);
    if (!items.length) return '<div class="studio-note">Chưa có ảnh tham chiếu nào được gắn vào cụm này.</div>';
    return items.map(item => `
      <div class="studio-thumb ${item.kind === 'char' ? 'active' : ''}">
        <img src="${item.url}" alt="${item.name}" onclick="Studio.openPopup('${card.id}','${item.kind === 'char' ? 'char' : 'ref'}',${item.idx})">
        <span style="position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.62);padding:2px 6px;border-radius:999px;font-size:10px;color:#fff;">${item.kind === 'char' ? 'Nhân vật' : 'Ảnh'}</span>
        <button type="button" onclick="event.stopPropagation();${item.kind === 'char' ? `Studio.removeChar('${card.id}',${item.idx})` : `Studio.removeRef('${card.id}',${item.idx})`}">×</button>
      </div>
    `).join('');
  }

  function openLibraryPicker(cardId) {
    libraryPickerCardId = cardId;
    const modal = $('studio-library-picker');
    if (!modal) return;
    populateLibraryCategoryFilters();
    renderLibraryPicker();
    modal.style.display = 'flex';
  }

  function closeLibraryPicker() {
    const modal = $('studio-library-picker');
    if (modal) modal.style.display = 'none';
    libraryPickerCardId = '';
  }

  async function deleteCurrentCategory() {
    const filter = $('studio-library-category-filter')?.value || 'all';
    if (!filter) return;
    const cat = libraryCategories.find(c => c.id === filter);
    if (!cat) return;
    if (!confirm(`Xóa nhóm "${cat.name}"? Nhóm phải không có ảnh nào mới xóa được.`)) return;
    const res = await API.delete(`/api/image/library/categories/${filter}`);
    if (res.ok) {
      toast('Đã xóa nhóm', 'success');
      await loadLibrarySources();
      $('studio-library-category-filter').value = 'all';
      renderLibraryPicker();
    } else {
      toast(res.detail || 'Xóa nhóm thất bại', 'error');
    }
  }

  function renderLibraryPicker() {
    const grid = $('studio-library-grid');
    const filter = $('studio-library-category-filter')?.value || 'all';
    // Hiện/ẩn nút xóa nhóm
    const delBtn = $('studio-delete-category-btn');
    if (delBtn) delBtn.style.display = filter ? '' : 'none';
    if (!grid) return;
    const items = libraryAssets
      .map(a => ({ type: 'asset', id: a.id, name: a.name, url: a.url, category_id: a.category_id || 'default' }))
      .filter(item => !filter || item.category_id === filter);
    if (!items.length) {
      grid.innerHTML = '<div class="studio-note" style="grid-column:1/-1;">Danh mục này chưa có ảnh nào.</div>';
      return;
    }
    grid.innerHTML = items.map(item => `
      <button type="button" class="btn btn-secondary" style="padding:8px;border-radius:12px;display:flex;flex-direction:column;gap:8px;align-items:stretch;" onclick="Studio.pickLibraryItem('${item.type}','${item.id}')">
        <img src="${item.url}" alt="${item.name}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block;">
        <span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</span>
      </button>
    `).join('');
  }

  function pickLibraryItem(type, id) {
    const card = cards.find(c => c.id === libraryPickerCardId);
    if (!card) return;
    if (type === 'character') {
      const ch = libraryCharacters.find(x => x.id === id);
      if (!ch) return;
      if (!card.chars.some(x => x.id === ch.id) && card.chars.length < 3) card.chars.push({ id: ch.id, name: ch.name, url: ch.url, media_id: ch.media_id || '' });
    } else {
      const asset = libraryAssets.find(x => x.id === id);
      if (!asset) return;
      if (!card.refs.some(x => x.url === asset.url)) card.refs.unshift({ url: asset.url, file: null, label: asset.name || 'Ảnh từ kho', media_id: asset.media_id || '' });
      card.refIndex = 0;
    }
    renderCard(card, false);
    closeLibraryPicker();
  }

  function renderCard(card, append) {
    let el = $('card-' + card.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'card-' + card.id;
      el.className = 'studio-card';
    }
    const idx = cards.findIndex(x => x.id === card.id) + 1;
    const statusCls = card.status === 'completed'
      ? 'completed'
      : card.status === 'failed'
        ? 'failed'
        : (card.status === 'processing' || card.status === 'running' || card.busyImage ? 'running' : '');
    const preview = (() => {
      const out = card.outputs[card.outputIndex];
      const url = out?.video_url || out?.videoUri || out?.fifeUrl || '';
      if (card.busyImage) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo ảnh...</div></div>';
      if (card.upscaling) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang upscale 1080p...</div></div>';
      if (card.status === 'processing') return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang xử lý...</div></div>';
      if (card.status === 'running') return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo video...</div></div>';
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${card.error || 'Thất bại'}${card.upscaleFailed ? `<br><button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="Studio.retryUpscale('${card.id}')">Upscale lại</button>` : ''}</div>`;
      if (url) return `<video controls src="${url}" preload="metadata"></video>`;
      return '<span>Chưa có preview</span>';
    })();

    const promptBlock = `
      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Text Prompt</span>
          <span style="font-size:10px;color:var(--text3);font-weight:400;">Nhấn để chỉnh sửa</span>
        </label>
        <div class="studio-prompt-display studio-prompt-open ${!card.prompt ? 'empty' : ''}">${card.prompt ? card.prompt.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Nhập prompt cho cụm này...'}</div>
        <input type="file" class="studio-ref-input" accept="image/*" multiple style="display:none;">
      </div>
    `;

    const refCount = combinedRefs(card).length;
    const refBlock = `
      <div class="studio-strip-block studio-ref-block">
        <div class="studio-ref-head">
          <div class="studio-ref-head-left">
            <span class="studio-ref-title">Ảnh tham chiếu</span>
            <span class="studio-ref-cap">(Max 10)</span>
          </div>
          <div class="studio-ref-head-actions">
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-small studio-add-ref">+ Thêm</button>
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-icon studio-open-library" title="Chọn từ kho" aria-label="Chọn từ kho">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
                <path d="M3 10h18"></path>
              </svg>
            </button>
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-icon studio-ref-btn-danger" onclick="Studio.clearCardRefs('${card.id}')" title="Xóa toàn bộ ảnh tham chiếu" aria-label="Xóa toàn bộ ảnh tham chiếu">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7h18"></path>
                <path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>
                <path d="M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-12"></path>
              </svg>
            </button>
          </div>
        </div>
        ${refCount
        ? `<div class="studio-strip-head"><span>Đã chọn ${refCount} ảnh tham chiếu</span></div><div class="studio-strip">${renderCombinedRefThumbs(card)}</div>`
        : `<div class="studio-ref-empty-box">Chưa có ảnh. Bấm "+ Thêm" để upload, hoặc "Kho" để chọn từ kho.</div>`}
      </div>
    `;

    const actionBlock = `
      <div class="studio-card-actions">
        <button class="btn btn-primary studio-generate-image" ${card.busyImage ? 'disabled' : ''}>${card.busyImage ? 'Đang tạo hình...' : 'Tạo hình'}</button>
        <button class="btn btn-primary studio-generate-video" ${card.busyVideo ? 'disabled' : ''}>${card.busyVideo ? 'Đang tạo video...' : 'Tạo video'}</button>
        ${card.status === 'completed' ? `<button class="btn btn-secondary studio-regenerate-video">Tạo lại</button>` : ''}
      </div>
    `;

    const outputBlocks = `
      <div class="studio-strip-block">
        <div class="studio-strip-head"><span>Hình đã tạo (${card.images.length})</span></div>
        <div class="studio-strip">
          ${card.images.length ? card.images.map((img, i) => `<div class="studio-thumb" style="position:relative;"><img src="${img.url}" alt="img-${i}" onclick="Studio.openPopup('${card.id}','generated',${i})"><button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();Studio.deleteImage('${card.id}',${i})" title="Xóa ảnh này">×</button></div>`).join('') : '<div class="studio-note" style="font-size:10px;">Chưa có</div>'}
        </div>
      </div>
      <div class="studio-strip-block">
        <div class="studio-strip-head"><span>Video đã tạo (${card.outputs.length})</span></div>
        <div class="studio-strip">
          ${card.outputs.length ? card.outputs.map((out, i) => {
      const url = out.video_url || out.videoUri || out.fifeUrl || '';
      return `<div class="studio-video-thumb ${i === card.outputIndex ? 'active' : ''}" style="position:relative;" onclick="Studio.openVideoPopup('${card.id}',${i})">${url ? `<video src="${url}" muted preload="metadata"></video>` : '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--text3);font-size:10px;">Video</div>'}<button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();Studio.deleteVideo('${card.id}',${i})" title="Xóa video này">×</button></div>`;
    }).join('') : '<div class="studio-note" style="font-size:10px;">Chưa có</div>'}
        </div>
      </div>
    `;

    const bodyContent = _cardLayout === 'horizontal'
      ? `
        <div class="studio-card-left">
          <div class="studio-preview-panel">${preview}</div>
        </div>
        <div class="studio-card-right">
          ${promptBlock}
          ${refBlock}
          ${actionBlock}
          <div class="studio-right-strips">
            ${outputBlocks}
          </div>
        </div>
      `
      : `
        <div class="studio-preview-panel">${preview}</div>
        ${promptBlock}
        ${refBlock}
        ${actionBlock}
        ${outputBlocks}
      `;

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Cụm ${idx}</span>
        <div class="studio-toolbar-spacer"></div>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" onclick="Studio.toggleInsertMenu('${card.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Cụm
            <span class="studio-btn-caret">▾</span>
          </button>
          <div class="card-insert-menu" id="studio-insert-menu-${card.id}" style="display:none;">
            <div onclick="Studio.insertCard('${card.id}','before')">Thêm trước</div>
            <div onclick="Studio.insertCard('${card.id}','after')">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm studio-icon-btn" onclick="Studio.cloneCard('${card.id}')" title="Nhân bản cụm" aria-label="Nhân bản cụm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="10" height="10" rx="2"></rect>
            <rect x="5" y="5" width="10" height="10" rx="2"></rect>
          </svg>
        </button>
        <button class="btn btn-secondary btn-sm studio-icon-btn studio-icon-btn-danger" onclick="Studio.deleteCard('${card.id}')" title="Xóa cụm" aria-label="Xóa cụm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7h18"></path>
            <path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>
            <path d="M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-12"></path>
          </svg>
        </button>
      </div>
      <div class="studio-card-body ${_cardLayout === 'horizontal' ? 'is-horizontal' : ''}">
        ${bodyContent}
      </div>
    `;

    if (append) $('studio-cards').appendChild(el);
    // Prompt click → modal
    el.querySelector('.studio-prompt-open').addEventListener('click', () => openPromptModal(card));
    el.querySelectorAll('.studio-open-library').forEach(btn => btn.addEventListener('click', () => openLibraryPicker(card.id)));
    el.querySelectorAll('.studio-add-ref').forEach(btn => btn.addEventListener('click', () => el.querySelector('.studio-ref-input').click()));
    el.querySelector('.studio-clear-ref')?.addEventListener('click', () => { card.refs = []; card.refIndex = 0; renderCard(card, false); updateStats(); });
    el.querySelector('.studio-generate-image').addEventListener('click', () => genImages(card.id));
    el.querySelector('.studio-generate-video').addEventListener('click', () => {
      _getGlobalVideoSem()(async () => {
        await genVideo(card.id);
      });
    });
    el.querySelector('.studio-regenerate-video')?.addEventListener('click', () => {
      _getGlobalVideoSem()(async () => {
        await genVideo(card.id);
      });
    });
    const input = el.querySelector('.studio-ref-input');
    input.addEventListener('change', e => {
      const files = Array.from(e.target.files || []).filter(file => String(file.type || '').startsWith('image/'));
      files.forEach(file => card.refs.push({ url: URL.createObjectURL(file), file, label: file.name || 'Ảnh tham chiếu' }));
      if (card.refs.length) card.refIndex = 0;
      renderCard(card, false);
      updateStats();
      input.value = '';
    });
    updateStats();
  }

  function rerender() {
    $('studio-cards').innerHTML = '';
    cards.forEach(card => renderCard(card, true));
    updateStats();
  }

  function createCard(prompt = '', extras = null) {
    const card = newCard(prompt);
    if (extras && Array.isArray(extras.charHints)) card.charHints = extras.charHints.slice();
    if (extras && extras.raw) card.importedPrompt = extras.raw;
    cards.push(card);
    renderCard(card, true);
    updateStats();
    return card;
  }

  async function openCharPicker(cardId) {
    let modal = $('studio-char-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-char-picker-modal';
      modal.className = 'studio-popup-overlay';
      modal.innerHTML = '<div class="studio-popup" style="max-width:720px;padding:18px;"></div>';
      document.body.appendChild(modal);
    }
    const body = modal.firstElementChild;
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;">
        <div><strong>Áp dụng nhân vật cho cụm</strong><div class="studio-note">Chọn tối đa 3 nhân vật hoặc bấm AUTO để quét theo prompt.</div></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('studio-char-picker-modal').style.display='none'">Đóng</button>
        </div>
      </div>
      <div id="studio-char-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;"></div>
    `;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    const res = await API.get('/api/character/list');
    const list = Array.isArray(res.data) ? res.data : [];
    const card = cards.find(c => c.id === cardId);
    const selected = new Set((card?.chars || []).map(ch => ch.id));
    $('studio-char-grid').innerHTML = list.length ? list.map(ch => `
      <button type="button" onclick="Studio.toggleCharacter('${cardId}','${String(ch.id).replace(/'/g, "\\'")}','${String(ch.name).replace(/'/g, "\\'")}','${String(ch.url).replace(/'/g, "\\'")}','${String(ch.media_id || '').replace(/'/g, "\\'")}')" style="border:2px solid ${selected.has(ch.id) ? 'var(--accent)' : 'var(--border)'};background:var(--bg3);border-radius:12px;padding:8px;cursor:pointer;">
        <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;display:block;">
        <div style="margin-top:6px;font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ch.name}</div>
      </button>
    `).join('') : '<div class="studio-note" style="grid-column:1/-1;">Chưa có nhân vật nào trong thư viện.</div>';
  }

  function toggleCharacter(cardId, id, name, url, mediaId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const idx = card.chars.findIndex(ch => ch.id === id);
    if (idx >= 0) card.chars.splice(idx, 1);
    else {
      if (card.chars.length >= 3) return toast('Tối đa 3 nhân vật cho mỗi cụm', 'error');
      card.chars.push({ id, name, url, media_id: mediaId });
    }
    renderCard(card, false);
    openCharPicker(cardId);
  }

  async function autoCharacters(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const res = await API.get('/api/character/list');
    const list = Array.isArray(res.data) ? res.data : [];
    const p = norm(card.prompt);
    const hints = Array.isArray(card.charHints) ? card.charHints.map(norm) : [];
    card.chars = list.filter(ch => {
      const nameNorm = norm(ch.name);
      if (p.includes(nameNorm)) return true;
      return hints.some(h => h && (h.includes(nameNorm) || nameNorm.includes(h)));
    }).slice(0, 3).map(ch => ({ id: ch.id, name: ch.name, url: ch.url, media_id: ch.media_id || '' }));
    renderCard(card, false);
    if ($('studio-char-picker-modal') && $('studio-char-picker-modal').style.display !== 'none') openCharPicker(cardId);
    toast(card.chars.length ? ('Tự gắn ' + card.chars.length + ' Nhân vật') : 'Không nhận ra Nhân vật nào trong prompt', card.chars.length ? 'success' : 'info');
  }

  function removeChar(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.chars.splice(idx, 1);
    renderCard(card, false);
  }

  function removeRef(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.refs.splice(idx, 1);
    card.refIndex = Math.max(0, Math.min(card.refIndex, card.refs.length - 1));
    renderCard(card, false);
  }

  function clearCardRefs(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.refs = [];
    card.refIndex = 0;
    renderCard(card, false);
    updateStats();
  }

  async function genImages(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (!String(card.prompt || '').trim()) return toast('Nhập prompt trước khi tạo hình', 'error');

    const MAX_RETRY = 3;
    let attempt = 0;

    while (attempt <= MAX_RETRY) {
      if (attempt > 0) {
        toast(`Thử lại lần ${attempt}/${MAX_RETRY}...`, 'info');
        await new Promise(r => setTimeout(r, 2000));
      }

      card.busyImage = true;
      card.status = 'running';
      card.error = '';
      renderCard(card, false);
      updateStats();

      try {
        const fd = new FormData();
        fd.append('prompt', card.prompt);
        fd.append('aspect_ratio', cfg.aspect === 'VIDEO_ASPECT_RATIO_PORTRAIT' ? 'IMAGE_ASPECT_RATIO_PORTRAIT' : cfg.aspect === 'VIDEO_ASPECT_RATIO_SQUARE' ? 'IMAGE_ASPECT_RATIO_SQUARE' : 'IMAGE_ASPECT_RATIO_LANDSCAPE');
        fd.append('output_count', String(cfg.imageCount));
        fd.append('model', cfg.imageModel);
        fd.append('character_ids_json', JSON.stringify(card.chars.map(ch => ch.id)));
        if (accountIndex !== null) fd.append('account_index', String(accountIndex));
        for (let i = 0; i < card.chars.length; i++) {
          const ch = card.chars[i];
          let file = ch.file || null;
          if (!file && ch.url) file = await urlToFile(ch.url, `${card.id}_char_${i + 1}.png`);
          if (file) fd.append('reference_images', file, file.name || `${card.id}_char_${i + 1}.png`);
        }
        for (let i = 0; i < card.refs.length; i++) {
          const ref = card.refs[i];
          let file = ref.file;
          if (!file && ref.url) file = await urlToFile(ref.url, `${card.id}_ref_${i + 1}.png`);
          if (file) fd.append('reference_images', file, file.name || `${card.id}_ref_${i + 1}.png`);
        }
        const res = await API.postForm('/api/image/generate-studio', fd);
        if (!res.ok) throw new Error(res.detail || 'Tạo hình thất bại');
        (res.images || []).forEach(img => {
          const url = img.url || img.downloadUrl || img.image_url || img.imageUrl || '';
          if (url) card.images.unshift({ url, media_id: img.media_id || img.mediaId || '', prompt: card.prompt, label: 'Ảnh đã tạo', account_index: accountIndex || 0 });
        });
        card.status = 'idle';
        card.busyImage = false;
        renderCard(card, false);
        updateStats();
        toast('Đã tạo ' + (res.images || []).length + ' ảnh cho cụm', 'success');
        return; // thành công
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRY) {
          card.status = 'failed';
          card.error = err.message;
          card.busyImage = false;
          renderCard(card, false);
          updateStats();
          toast('Lỗi tạo hình: ' + err.message, 'error');
          return;
        }
      }
    }
  }

  async function createVideo(card, accountIndex = null) {
    const fd = new FormData();
    fd.append('prompt', card.prompt || '');
    fd.append('aspect_ratio', cfg.aspect);
    fd.append('output_count', String(cfg.videoCount));
    fd.append('model', cfg.model);
    fd.append('character_ids_json', JSON.stringify(card.chars.map(ch => ch.id)));
    if (accountIndex !== null) fd.append('account_index', String(accountIndex));
    // Upload ảnh nhân vật (chars) trước — ưu tiên cao nhất
    for (let i = 0; i < card.chars.length; i++) {
      const ch = card.chars[i];
      let file = ch.file || null;
      if (!file && ch.url) file = await urlToFile(ch.url, `${card.id}_char_${i + 1}.png`);
      if (file) fd.append('reference_images', file, file.name || `${card.id}_char_${i + 1}.png`);
    }
    // Refs: ảnh có media_id → dùng trực tiếp (đã thuộc đúng account nhờ auto-detect accountIndex)
    //        không có media_id → upload binary
    const refMediaIds = [];
    for (let i = 0; i < card.refs.length; i++) {
      const ref = card.refs[i];
      if (ref.media_id) {
        refMediaIds.push(ref.media_id);
      } else {
        let file = ref.file || null;
        if (!file && ref.url) file = await urlToFile(ref.url, `${card.id}_video_ref_${i + 1}.png`);
        if (file) fd.append('reference_images', file, file.name || `${card.id}_video_ref_${i + 1}.png`);
      }
    }
    if (refMediaIds.length) fd.append('ref_media_ids_json', JSON.stringify(refMediaIds));
    const res = await API.postForm('/api/veo/studio-video', fd);
    return { ok: res.ok, jobId: res.job_id || '', error: res.detail || res.message || '' };
  }

  async function genVideo(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (!String(card.prompt || '').trim()) return toast('Nhập prompt trước khi tạo video', 'error');

    // Auto-detect account từ ảnh gen trong card (images hoặc refs có account_index)
    if (accountIndex === null) {
      const imgWithAcc = card.images.find(img => img.account_index);
      const refWithAcc = card.refs.find(ref => ref.account_index);
      if (imgWithAcc) accountIndex = imgWithAcc.account_index;
      else if (refWithAcc) accountIndex = refWithAcc.account_index;
    }

    const MAX_RETRY = 3;
    let attempt = 0;

    while (attempt <= MAX_RETRY) {
      if (stopAll) break;
      if (attempt > 0) {
        toast(`Thử lại lần ${attempt}/${MAX_RETRY}...`, 'info');
        await new Promise(r => setTimeout(r, 2000));
      }

      card.status = 'running';
      card.busyVideo = true;
      card.outputs = [];
      card.outputIndex = 0;
      card.error = '';
      renderCard(card, false);
      updateStats();

      let succeeded = false;
      let shouldRetry = false;

      try {
        const req = await createVideo(card, accountIndex);
        if (!req.ok || !req.jobId) throw new Error(req.error || 'Tạo video thất bại');
        card.jobId = req.jobId;
        card.videoAccountIndex = accountIndex;

        await pollJob(req.jobId, '/api/veo/job', async job => {
          if (stopAll) return;
          if (job.status === 'completed' || job.status === 'done') {
            card.outputs = Array.isArray(job.outputs) ? job.outputs.filter(Boolean) : [];
            card.status = card.outputs.length ? 'completed' : 'failed';
            card.busyVideo = false;
            card.error = card.outputs.length ? '' : 'Không có video trả về';
            renderCard(card, false);
            updateStats();
            if (card.outputs.length) {
              succeeded = true;
              if (cfg.autoUpscale) {
                card.status = 'processing';
                renderCard(card, false);
                updateStats();
                const upscaleOk = await upscaleCard(card.id, 0);
                if (!upscaleOk) {
                  card.status = 'failed';
                  card.error = 'Upscale 1080p thất bại — ấn "Upscale lại" để thử lại rồi tự tải về';
                  card.upscaleFailed = true;
                  renderCard(card, false);
                  updateStats();
                  return;
                }
              }
              if (cfg.autoDownload) await saveOutputs(card.id);
            } else {
              shouldRetry = true;
            }
          } else if (job.status === 'failed') {
            shouldRetry = true;
            card.status = 'running'; // giữ running để UI không hiện lỗi sớm
            card.busyVideo = true;
          }
        });
      } catch (err) {
        shouldRetry = true;
        card.error = err.message;
      }

      if (succeeded) return; // xong, thoát

      attempt++;
      if (!shouldRetry || attempt > MAX_RETRY) break;
    }

    // Hết retry mà vẫn fail
    card.status = 'failed';
    card.busyVideo = false;
    if (!card.error) card.error = `Thất bại sau ${MAX_RETRY} lần thử`;
    renderCard(card, false);
    updateStats();
  }

  async function saveOutputs(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    // Nếu chưa chọn folder, tự mở dialog chọn folder trước để tránh browser hỏi "allow multiple downloads"
    if (!cfg.saveHandle && window.showDirectoryPicker) {
      await chooseFolder();
    }
    for (let i = 0; i < card.outputs.length; i++) {
      const out = card.outputs[i];
      const url = out.video_url || out.videoUri || out.fifeUrl;
      if (url) await saveVideo(url, `studio_${String(cards.indexOf(card) + 1).padStart(3, '0')}_${i + 1}.mp4`, cfg.saveHandle);
    }
  }

  // Lưu toàn bộ video 720p (chất lượng gốc, không upscale)
  async function saveAllVideos720() {
    const manualHandle = await pickManualDownloadFolder();
    if (window.showDirectoryPicker && !manualHandle) return toast('Bạn chưa chọn folder', 'info');
    const cardsWithOutput = cards.filter(c => c.outputs && c.outputs.length);
    if (!cardsWithOutput.length) return toast('Chưa có video nào', 'info');
    let saved = 0, failed = 0;
    for (const card of cardsWithOutput) {
      for (let i = 0; i < card.outputs.length; i++) {
        const out = card.outputs[i];
        const cardIdx = String(cards.indexOf(card) + 1).padStart(3, '0');
        const url = out.video_url || out.videoUri || out.fifeUrl;
        if (url) { await saveVideo(url, `studio_${cardIdx}_${i + 1}_720p.mp4`, manualHandle); saved++; }
        else failed++;
      }
    }
    if (saved > 0) toast(`Đã lưu ${saved} video 720p (gốc)`, 'success');
    if (failed > 0) toast(`${failed} video thất bại`, 'error');
  }

  // Lưu toàn bộ video 1080p: upscale nếu chưa upscale, rồi lưu
  async function saveAllVideos1080() {
    const manualHandle = await pickManualDownloadFolder();
    if (window.showDirectoryPicker && !manualHandle) return toast('Bạn chưa chọn folder', 'info');
    const cardsWithOutput = cards.filter(c => c.outputs && c.outputs.length && c.status === 'completed');
    if (!cardsWithOutput.length) return toast('Chưa có video nào hoàn tất', 'info');
    toast(`Đang xử lý ${cardsWithOutput.length} cụm...`, 'info');
    let saved = 0, failed = 0;
    for (const card of cardsWithOutput) {
      for (let i = 0; i < card.outputs.length; i++) {
        const out = card.outputs[i];
        const cardIdx = String(cards.indexOf(card) + 1).padStart(3, '0');
        const filename = `studio_${cardIdx}_${i + 1}_1080p.mp4`;
        // Kiểm tra đã upscale chưa: output upscale trả về media_id mới và video_url khác
        const alreadyUpscaled = !!out._upscaled;
        if (!alreadyUpscaled) {
          // Upscale trước
          if (card.upscaling) {
            // Đợi upscale hiện tại xong (tối đa 3 phút)
            let waited = 0;
            while (card.upscaling && waited < 180) { await new Promise(r => setTimeout(r, 2000)); waited += 2; }
          }
          card.upscaling = true;
          card.status = 'processing';
          card.upscaleFailed = false;
          renderCard(card, false);
          updateStats();
          try {
            const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: i, account_index: card.videoAccountIndex || null });
            if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
              card.outputs[i] = { ...out, ...res.outputs[0], _upscaled: true };
              const url1080 = card.outputs[i].video_url || card.outputs[i].videoUri || card.outputs[i].fifeUrl;
              card.status = 'completed';
              if (url1080) { await saveVideo(url1080, filename, manualHandle); saved++; }
              else failed++;
            } else {
              toast(`Cụm ${cardIdx}: upscale thất bại`, 'error');
              card.status = 'failed';
              failed++;
            }
          } catch (err) {
            toast(`Cụm ${cardIdx}: lỗi upscale - ${err.message}`, 'error');
            card.status = 'failed';
            failed++;
          } finally {
            card.upscaling = false;
            renderCard(card, false);
            updateStats();
          }
        } else {
          // Đã upscale rồi, lưu luôn
          const url1080 = out.video_url || out.videoUri || out.fifeUrl;
          if (url1080) { await saveVideo(url1080, filename, manualHandle); saved++; }
          else failed++;
        }
      }
    }
    if (saved > 0) toast(`Đã lưu ${saved} video 1080p`, 'success');
    if (failed > 0) toast(`${failed} video thất bại`, 'error');
  }

  async function upscaleCard(cardId, outputIndex) {
    const card = cards.find(c => c.id === cardId);
    if (!card || card.upscaling) return false;
    const out = card.outputs[outputIndex];
    if (!out) return false;
    card.status = 'processing';
    card.upscaling = true;
    card.upscaleFailed = false;
    renderCard(card, false);
    updateStats();
    try {
      const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: outputIndex, account_index: card.videoAccountIndex || null });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[outputIndex] = { ...card.outputs[outputIndex], ...res.outputs[0], _upscaled: true };
        card.upscaleFailed = false;
        card.status = 'completed';
        toast('Upscale 1080p thành công', 'success');
        return true;
      } else {
        card.status = 'failed';
        toast(res.body || res.message || 'Upscale thất bại', 'error');
        return false;
      }
    } catch (err) {
      card.status = 'failed';
      toast('Lỗi upscale: ' + err.message, 'error');
      return false;
    } finally {
      card.upscaling = false;
      renderCard(card, false);
      updateStats();
    }
  }

  function selectOutput(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.outputIndex = idx;
    renderCard(card, false);
  }

  function openPopup(cardId, type, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const item = type === 'generated' ? card.images[idx] : type === 'char' ? card.chars[idx] : card.refs[idx];
    if (!item) return;
    popup = { cardId, type, idx, url: item.url, prompt: card.prompt || '', label: item.label || '', media_id: item.media_id || '', account_index: item.account_index || 0 };
    $('studio-popup-img').src = item.url;
    $('studio-popup-caption-text').textContent = (item.label || '') + (card.prompt ? ' · ' + card.prompt.slice(0, 120) : '');
    $('studio-img-popup').style.display = 'flex';
  }

  function closePopup() {
    $('studio-img-popup').style.display = 'none';
    popup = null;
  }

  function openPromptModal(card) {
    const modalId = 'studio-prompt-edit-modal';
    let modal = $(modalId);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = modalId;
      modal.className = 'studio-prompt-modal';
      document.body.appendChild(modal);
    }
    const cardIdx = cards.findIndex(c => c.id === card.id) + 1;
    modal.innerHTML = `
      <div class="studio-prompt-modal-box">
        <div class="studio-prompt-modal-header">
          <div class="studio-prompt-modal-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="vertical-align:-2px;margin-right:6px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Chỉnh sửa Prompt — Cụm ${cardIdx}
          </div>
          <button class="studio-prompt-modal-close" id="studio-prompt-modal-close-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <textarea id="studio-prompt-modal-ta" placeholder="Nhập prompt cho cụm này...">${card.prompt || ''}</textarea>
        <div class="studio-prompt-modal-actions">
          <button class="btn btn-secondary" id="studio-prompt-modal-cancel">Hủy</button>
          <button class="btn btn-primary" id="studio-prompt-modal-save">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>
            Lưu
          </button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    const ta = $('studio-prompt-modal-ta');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const close = () => { modal.style.display = 'none'; };
    const save = () => {
      card.prompt = ta.value;
      close();
      renderCard(card, false);
      updateStats();
    };

    modal.onclick = e => { if (e.target === modal) close(); };
    $('studio-prompt-modal-close-btn').onclick = close;
    $('studio-prompt-modal-cancel').onclick = close;
    $('studio-prompt-modal-save').onclick = save;
    ta.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  async function saveToLib() {
    if (!popup) return;
    const cats = libraryCategories.length ? libraryCategories : (await API.get('/api/image/library/categories').then(r => r.items || []).catch(() => []));
    const opts = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const modalId = 'studio-save-lib-modal';
    let modal = $(modalId);
    if (!modal) { modal = document.createElement('div'); modal.id = modalId; modal.className = 'studio-popup-overlay'; document.body.appendChild(modal); }
    modal.innerHTML = `
      <div style="background:var(--bg2);border-radius:14px;padding:22px;min-width:320px;max-width:90vw;">
        <div style="font-weight:600;margin-bottom:14px;">Lưu vào kho (1K)</div>
        <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Nhóm</label>
        <select id="studio-save-lib-cat" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:12px;">${opts}</select>
        <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Thể loại</label>
        <select id="studio-save-lib-type" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:14px;">
          <option value="nhanvat">Nhân vật</option>
          <option value="vatpham">Vật phẩm</option>
          <option value="background">Background</option>
          <option value="style">Style</option>
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${modalId}').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" id="studio-save-lib-confirm">Lưu</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    $('studio-save-lib-confirm').onclick = async () => {
      const categoryId = $('studio-save-lib-cat').value || 'default';
      const assetType = $('studio-save-lib-type').value || 'nhanvat';
      modal.style.display = 'none';
      await _batchSaveLibSSE([{ url: popup.url, media_id: popup.media_id || '', prompt: popup.prompt || '', asset_type: assetType }], categoryId, '1k');
      await loadLibrarySources().catch(() => { });
      if (window.LibraryModule && typeof window.LibraryModule.refresh === 'function') {
        await window.LibraryModule.refresh().catch(() => { });
      }
    };
  }

  async function downloadImg(quality = '1k') {
    if (!popup) return;
    // Chọn folder lưu (không liên quan folder autosave video)
    let dirHandle = null;
    if (window.showDirectoryPicker) {
      try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_) { return; }
    }
    await _downloadImageWithQuality(popup.url, popup.media_id || '', quality, `studio_img_${Date.now()}`, dirHandle, popup.account_index || 0);
  }

  function togglePopupDlMenu() {
    const m = $('studio-popup-dl-menu');
    if (m) m.style.display = m.style.display === 'none' ? '' : 'none';
  }
  function closePopupDlMenu() {
    const m = $('studio-popup-dl-menu');
    if (m) m.style.display = 'none';
  }

  // Đóng dropdown khi click ngoài
  document.addEventListener('click', e => {
    if (!e.target.closest('#studio-popup-dl-menu-btn') && !e.target.closest('#studio-popup-dl-menu')) {
      closePopupDlMenu();
    }
  });

  // ── Helper: download 1 ảnh theo quality, lưu vào dirHandle hoặc browser download
  async function _downloadImageWithQuality(url, media_id, quality, baseName, dirHandle, account_index = 0) {
    _showImgProgress(true, `Đang tải ${quality.toUpperCase()}...`);
    try {
      let finalUrl = url;
      if (quality !== '1k' && media_id) {
        const res = await API.post('/api/image/get-quality-url', { url, media_id, quality, account_index });
        if (res.ok && res.url) finalUrl = res.url;
        else { toast(`Không lấy được ảnh ${quality.toUpperCase()}`, 'error'); _showImgProgress(false); return; }
      }
      let blob;
      if (finalUrl.startsWith('data:')) {
        const res2 = await fetch(finalUrl);
        blob = await res2.blob();
      } else {
        const proxyUrl = `/api/veo/proxy-download?url=${encodeURIComponent(finalUrl)}&filename=${encodeURIComponent(baseName + '.jpg')}`;
        const resp = await fetch(proxyUrl);
        blob = await resp.blob();
      }
      if (dirHandle) {
        const fh = await dirHandle.getFileHandle(`${baseName}.jpg`, { create: true });
        const w = await fh.createWritable(); await w.write(blob); await w.close();
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${baseName}.jpg`; a.click();
      }
      toast(`Đã tải ảnh ${quality.toUpperCase()}`, 'success');
    } catch (e) {
      toast(`Lỗi tải ảnh: ${e.message}`, 'error');
    } finally {
      _showImgProgress(false);
    }
  }

  // ── Helper: progress bar nhỏ dưới màn hình
  function _showImgProgress(show, text = '') {
    let bar = $('studio-img-progress-toast');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'studio-img-progress-toast';
      bar.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 20px;font-size:13px;color:var(--text1);z-index:9998;display:none;box-shadow:0 8px 24px rgba(0,0,0,.3);white-space:nowrap;';
      document.body.appendChild(bar);
    }
    if (show) { bar.textContent = text; bar.style.display = 'block'; }
    else bar.style.display = 'none';
  }

  // ── Helper: batch lưu kho qua SSE stream
  async function _batchSaveLibSSE(images, categoryId, quality) {
    const total = images.length;
    const progWrap = $('studio-save-images-progress');
    const progBar = $('studio-save-images-progress-bar');
    const progText = $('studio-save-images-progress-text');
    if (progWrap) progWrap.style.display = '';

    return new Promise(resolve => {
      let done = 0;
      const body = JSON.stringify({ images, category_id: categoryId, quality });
      fetch('/api/image/studio/batch-save-lib', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .then(resp => {
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          function read() {
            reader.read().then(({ done: doneStream, value }) => {
              if (doneStream) { resolve(); return; }
              const text = dec.decode(value);
              for (const line of text.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                  const d = JSON.parse(line.slice(5).trim());
                  done = d.done;
                  const pct = total ? Math.round(done / total * 100) : 0;
                  if (progBar) progBar.style.width = pct + '%';
                  if (progText) progText.textContent = `${done} / ${total}`;
                  if (d.finished) {
                    toast(`Đã lưu ${done}/${total} ảnh vào kho`, 'success');
                    if (progWrap) setTimeout(() => { progWrap.style.display = 'none'; if (progBar) progBar.style.width = '0%'; }, 1500);
                    resolve();
                  }
                } catch (_) { }
              }
              read();
            });
          }
          read();
        })
        .catch(e => { toast('Lỗi lưu kho: ' + e.message, 'error'); if (progWrap) progWrap.style.display = 'none'; resolve(); });
    });
  }

  async function addToCard() {
    if (!popup) return;
    let card = cards.find(c => c.id === popup.cardId);
    if (!card) return toast('Không tìm thấy cụm', 'error');
    let file = null;
    try {
      // Dùng proxy nếu URL là Google (tránh CORS + expire)
      const fetchUrl = (popup.url.includes('googleapis.com') || popup.url.includes('google.com'))
        ? `/api/veo/proxy-download?url=${encodeURIComponent(popup.url)}&filename=studio_ref_${Date.now()}.png`
        : popup.url;
      const resp = await fetch(fetchUrl);
      const blob = await resp.blob();
      file = new File([blob], `studio_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
    } catch (_) { }
    card.refs.unshift({ url: popup.url, file, label: 'Ảnh chèn từ preview', media_id: popup.media_id || '', account_index: popup.account_index || 0 });
    card.refIndex = 0;
    renderCard(card, false);
    closePopup();
    toast('Đã thêm ảnh vào cụm làm ảnh tham chiếu', 'success');
  }

  function importImages(files) {
    const list = Array.from(files || []).filter(file => String(file.type || '').startsWith('image/'));
    if (!list.length) return toast('Không có ảnh hợp lệ', 'error');

    if (cards.length > 0) {
      // Mode đè vào cụm có sẵn — phải khớp số lượng
      if (list.length !== cards.length) {
        return toast(
          `Số ảnh không khớp: chọn ${list.length} ảnh nhưng Studio đang có ${cards.length} cụm. Vui lòng chọn đúng ${cards.length} ảnh.`,
          'error', 6000
        );
      }
      cards.forEach((card, i) => {
        card.refs.unshift({ url: URL.createObjectURL(list[i]), file: list[i], label: list[i].name || 'Ảnh import' });
      });
      rerender();
      toast('Đã thêm ' + list.length + ' ảnh vào ' + list.length + ' cụm theo thứ tự', 'success');
    } else {
      // Mode tạo mới — mỗi ảnh tạo 1 cụm
      list.forEach(file => {
        const card = createCard('');
        card.refs.push({ url: URL.createObjectURL(file), file, label: file.name || 'Ảnh import' });
        renderCard(card, false);
      });
      updateStats();
      toast('Đã nạp ' + list.length + ' ảnh vào Studio', 'success');
    }
  }

  function importPromptsXlsx(file) {
    // Dùng SheetJS nếu có, fallback thông báo lỗi
    if (typeof XLSX === 'undefined') return toast('Thư viện XLSX chưa được tải', 'error');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        // Mỗi hàng là 1 prompt — lấy toàn bộ hàng join bằng tab, trim
        const prompts = rows
          .map(row => (Array.isArray(row) ? row : [row]).join('\t').trim())
          .filter(Boolean);
        if (!prompts.length) return toast('File Excel trống hoặc không có dữ liệu', 'error');
        const promptItems = prompts.map(p => ({ prompt: p }));

        if (cards.length > 0) {
          if (promptItems.length !== cards.length) {
            return toast(`Prompt không khớp: file có ${promptItems.length} hàng nhưng Studio đang có ${cards.length} cụm`, 'error');
          }
          cards.forEach((card, i) => { card.prompt = promptItems[i].prompt; });
          rerender();
          toast('Đã thay thế ' + promptItems.length + ' prompt từ Excel', 'success');
        } else {
          promptItems.forEach(item => createCard(item.prompt, item));
          updateStats();
          toast('Đã import ' + promptItems.length + ' cụm từ Excel', 'success');
        }
      } catch (err) {
        toast('Lỗi đọc file Excel: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function importPrompts(file, mode = 'txt') {
    const reader = new FileReader();
    reader.onload = e => {
      const raw = e.target.result;
      const promptItems = mode === 'json' ? parseJsonPromptCards(raw) : parsePrompts(raw).map(prompt => ({ prompt }));
      if (!promptItems.length) return toast('File prompt trống hoặc không đúng định dạng', 'error');

      // Replace mode: cards already exist → only replace prompts, keep images/refs/outputs
      if (cards.length > 0) {
        if (promptItems.length !== cards.length) {
          return toast(
            `Prompt không khớp số cụm: file có ${promptItems.length} prompt nhưng Studio đang có ${cards.length} cụm. Vui lòng kiểm tra lại.`,
            'error'
          );
        }
        cards.forEach((card, i) => { card.prompt = promptItems[i].prompt; });
        rerender();
        toast('Đã thay thế ' + promptItems.length + ' prompt (giữ nguyên ảnh/video)', 'success');
      } else {
        // Create mode: no cards yet → create new cards
        promptItems.forEach(item => createCard(item.prompt, item));
        updateStats();
        toast('Đã import ' + promptItems.length + ' cụm prompt', 'success');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function clearAllImages() {
    if (!cards.length) return toast('Không có cụm nào', 'info');
    cards.forEach(card => {
      card.refs = [];
      card.refIndex = 0;
    });
    rerender();
    toast('Đã xóa tất cả ảnh tham chiếu khỏi các cụm', 'success');
  }

  async function autoCharactersAll() {
    if (!cards.length) return toast('Không có cụm nào', 'info');
    const res = await API.get('/api/character/list');
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) return toast('Chưa có nhân vật trong thư viện', 'info');
    let total = 0;
    cards.forEach(card => {
      const p = norm(card.prompt);
      const hints = Array.isArray(card.charHints) ? card.charHints.map(norm) : [];
      card.chars = list.filter(ch => {
        const nameNorm = norm(ch.name);
        if (p.includes(nameNorm)) return true;
        return hints.some(h => h && (h.includes(nameNorm) || nameNorm.includes(h)));
      }).slice(0, 3).map(ch => ({ id: ch.id, name: ch.name, url: ch.url, media_id: ch.media_id || '' }));
      total += card.chars.length;
    });
    rerender();
    toast(`Auto nhân vật xong: ${total} lần gắn trên ${cards.length} cụm`, total ? 'success' : 'info');
  }

  // Semaphore: giới hạn số job chạy đồng thời
  function makeSemaphore(n) {
    let running = 0;
    const queue = [];
    return async function run(fn) {
      if (running >= n) await new Promise(r => queue.push(r));
      running++;
      try { return await fn(); }
      finally { running--; if (queue.length) queue.shift()(); }
    };
  }

  async function _loadGenCfg() {
    const cfgRes = await API.get('/api/settings/config-full');
    const d = (cfgRes && cfgRes.data) ? cfgRes.data : cfgRes;
    const activeIndices = [];
    for (let i = 1; i <= 10; i++) {
      const acc = d[`account${i}`];
      if (acc && (acc.ACCESS_TOKEN || acc.COOKIE)) activeIndices.push(i);
    }
    const maxConcurrent = Math.min(10, Math.max(1, parseInt(d.MAX_CONCURRENT || '3', 10) || 3));
    const maxConcurrentImage = Math.min(5, Math.max(1, parseInt(d.MAX_CONCURRENT_IMAGE || '2', 10) || 2));
    return { accountIndices: activeIndices.length > 1 ? activeIndices : [null], maxConcurrent, maxConcurrentImage };
  }

  async function genAllImages() {
    // Nếu đang lọc "failed" thì tạo lại các card lỗi, không đụng card đã xong
    const pending = _activeFilter === 'failed'
      ? cards.filter(c => !c.busyImage && c.status === 'failed' && String(c.prompt || '').trim())
      : cards.filter(c => !c.busyImage && String(c.prompt || '').trim());
    if (!pending.length) return toast('Không có cụm nào sẵn sàng tạo hình', 'error');
    stopAll = false;
    $('studio-gen-all-images').style.display = 'none';
    $('studio-stop-all').style.display = '';
    $('studio-stop-all').textContent = 'Dừng toàn bộ';
    $('studio-gen-all-videos').disabled = true;

    let accountIndices = [null], maxConcurrentImage = 2;
    try { ({ accountIndices, maxConcurrentImage } = await _loadGenCfg()); } catch (_) { }

    // Anti-block: delay 7-13s giữa image requests (image dễ bị block hơn video)
    const imgDelay = () => 7000 + Math.random() * 6000;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = accountIndices.length;
    toast(n > 1
      ? `Tạo ảnh ${pending.length} cụm với ${n} tài khoản (tối đa ${maxConcurrentImage} ảnh/tài khoản)`
      : `Bắt đầu tạo ảnh ${pending.length} cụm (tối đa ${maxConcurrentImage} cùng lúc)`, 'info');

    if (n <= 1) {
      const sem = makeSemaphore(maxConcurrentImage);
      let cardIdx = 0;
      await Promise.all(pending.map(card => sem(async () => {
        if (stopAll) return;
        const myIdx = cardIdx++;
        if (myIdx > 0) await sleep(imgDelay());
        await genImages(card.id, accountIndices[0]);
      })));
    } else {
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi];
        if (bi > 0) await sleep(bi * 2000);
        const sem = makeSemaphore(maxConcurrentImage);
        let cardIdx = 0;
        await Promise.all(bucket.map(card => sem(async () => {
          if (stopAll) return;
          const myIdx = cardIdx++;
          if (myIdx > 0) await sleep(imgDelay());
          await genImages(card.id, accIdx);
        })));
      }));
    }

    $('studio-gen-all-images').style.display = '';
    $('studio-stop-all').style.display = 'none';
    $('studio-stop-all').textContent = 'Đang dừng...';
    $('studio-gen-all-videos').disabled = false;
    stopAll = false;
  }

  async function genAllVideos() {
    // Nếu đang lọc "failed" thì tạo lại các card lỗi, không đụng card đã xong
    const pending = _activeFilter === 'failed'
      ? cards.filter(c => c.status === 'failed')
      : cards.filter(c => c.status === 'idle');
    if (!pending.length) return toast('Không có cụm nào chờ tạo video', 'error');
    stopAll = false;
    $('studio-gen-all-videos').style.display = 'none';
    $('studio-stop-all').style.display = '';
    $('studio-gen-all-images').disabled = true;

    let accountIndices = [null], maxConcurrent = 3;
    try { ({ accountIndices, maxConcurrent } = await _loadGenCfg()); } catch (_) { }
    // Cập nhật global semaphore theo config mới nhất
    _globalVideoSem = makeSemaphore(maxConcurrent);

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = accountIndices.length;
    toast(n > 1
      ? `Chạy ${pending.length} cụm với ${n} tài khoản (tối đa ${maxConcurrent} job/tài khoản)`
      : `Bắt đầu tạo ${pending.length} video (tối đa ${maxConcurrent} cùng lúc)`, 'info');

    if (n <= 1) {
      // Single account — semaphore pool
      const sem = makeSemaphore(maxConcurrent);
      let cardIdx = 0;
      await Promise.all(pending.map(card => sem(async () => {
        if (stopAll) return;
        const myIdx = cardIdx++;
        if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
        await genVideo(card.id, accountIndices[0]);
      })));
    } else {
      // Multi-account: bucket round-robin, mỗi bucket có semaphore riêng
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi];
        if (bi > 0) await sleep(bi * 1000); // stagger start giữa các bucket
        const sem = makeSemaphore(maxConcurrent);
        let cardIdx = 0;
        await Promise.all(bucket.map(card => sem(async () => {
          if (stopAll) return;
          const myIdx = cardIdx++;
          if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
          await genVideo(card.id, accIdx);
        })));
      }));
    }

    $('studio-gen-all-videos').style.display = '';
    $('studio-stop-all').style.display = 'none';
    $('studio-stop-all').textContent = 'Dừng toàn bộ';
    $('studio-gen-all-images').disabled = false;
    stopAll = false;
  }

  function clearAll() {
    cards = [];
    $('studio-cards').innerHTML = '';
    updateStats();
    toast('Đã xóa tất cả cụm trong Studio', 'success');
  }

  function cloneCard(cardId) {
    const src = cards.find(c => c.id === cardId);
    if (!src) return;
    const clone = newCard(src.prompt || '');
    clone.refs = src.refs.map(ref => ({ ...ref }));
    clone.refIndex = src.refIndex;
    clone.chars = src.chars.map(ch => ({ ...ch }));
    clone.images = src.images.map(img => ({ ...img }));
    const idx = cards.findIndex(c => c.id === cardId);
    cards.splice(idx + 1, 0, clone);
    rerender();
  }

  function insertCard(refId, position) {
    const idx = cards.findIndex(c => c.id === refId);
    if (idx === -1) return;
    cards.splice(position === 'before' ? idx : idx + 1, 0, newCard(''));
    rerender();
  }

  function toggleInsertMenu(cardId) {
    document.querySelectorAll('.card-insert-menu').forEach(menu => {
      if (menu.id !== `studio-insert-menu-${cardId}`) menu.style.display = 'none';
    });
    const menu = $('studio-insert-menu-' + cardId);
    if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  }

  window.init_studio = function () {
    if (ready) return;
    ready = true;

    // Add card → open dialog
    $('studio-add-card').addEventListener('click', () => {
      const dialog = $('studio-add-card-dialog');
      if (dialog) { dialog.style.display = 'flex'; $('studio-add-card-count').value = '1'; }
      else createCard('');
    });
    // Add card dialog confirm
    $('studio-add-card-confirm')?.addEventListener('click', () => {
      const n = Math.max(1, Math.min(200, parseInt($('studio-add-card-count')?.value || '1', 10) || 1));
      for (let i = 0; i < n; i++) createCard('');
      $('studio-add-card-dialog').style.display = 'none';
      toast('Đã thêm ' + n + ' cụm', 'success');
    });
    // Add card dialog cancel + overlay close
    $('studio-add-card-cancel')?.addEventListener('click', () => { $('studio-add-card-dialog').style.display = 'none'; });
    $('studio-add-card-dialog')?.addEventListener('click', e => { if (e.target === $('studio-add-card-dialog')) $('studio-add-card-dialog').style.display = 'none'; });

    $('studio-open-library-manager')?.addEventListener('click', () => {
      if (typeof window.switchTab === 'function') window.switchTab('character');
    });
    $('studio-import-images').addEventListener('click', () => $('studio-images-file').click());
    $('studio-images-file').addEventListener('change', e => { if (e.target.files?.length) importImages(e.target.files); e.target.value = ''; });

    // Import prompts → open popup and show current card count + hint
    $('studio-import-prompts').addEventListener('click', () => {
      const popup = $('studio-import-popup');
      if (!popup) return;
      const countEl = $('studio-import-card-count');
      if (countEl) countEl.textContent = cards.length;
      const hint = $('studio-import-replace-hint');
      if (hint) hint.style.display = cards.length > 0 ? '' : 'none';
      popup.style.display = 'flex';
    });
    $('studio-import-text-btn').addEventListener('click', () => { $('studio-import-popup').style.display = 'none'; $('studio-prompts-file-txt').click(); });
    $('studio-import-json-btn').addEventListener('click', () => { $('studio-import-popup').style.display = 'none'; $('studio-prompts-file-json').click(); });
    $('studio-import-xlsx-btn')?.addEventListener('click', () => { $('studio-import-popup').style.display = 'none'; $('studio-prompts-file-xlsx').click(); });
    $('studio-prompts-file-txt').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) importPrompts(file, 'txt'); e.target.value = ''; });
    $('studio-prompts-file-json').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) importPrompts(file, 'json'); e.target.value = ''; });
    $('studio-prompts-file-xlsx')?.addEventListener('change', e => { const file = e.target.files?.[0]; if (file) importPromptsXlsx(file); e.target.value = ''; });

    // Clear all images + refs + chars
    $('studio-clear-images-btn')?.addEventListener('click', () => {
      if (!cards.length) return toast('Không có cụm nào', 'info');
      if (!confirm('Xóa tất cả ảnh tham chiếu khỏi các cụm?')) return;
      clearAllImages();
    });

    // Auto nhân vật tất cả cụm (kept for backward compat, element may not exist)
    $('studio-auto-char-all-btn')?.addEventListener('click', () => {
      if (!cards.length) return toast('Không có cụm nào', 'info');
      autoCharactersAll();
    });

    // Layout toggle ngang/dọc
    function applyCardLayout() {
      const cardsEl = $('studio-cards');
      const btn = $('studio-layout-toggle');
      if (!cardsEl || !btn) return;
      const label = btn.querySelector('.studio-layout-toggle-label');
      const icon = btn.querySelector('svg');
      if (_cardLayout === 'horizontal') {
        cardsEl.classList.add('layout-horizontal');
        if (icon) icon.innerHTML = '<rect x="3" y="3" width="18" height="8" rx="1"/><rect x="3" y="13" width="18" height="8" rx="1"/>';
        if (label) label.textContent = 'Cụm dọc';
      } else {
        cardsEl.classList.remove('layout-horizontal');
        if (icon) icon.innerHTML = '<rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>';
        if (label) label.textContent = 'Cụm ngang';
      }
    }
    applyCardLayout();
    $('studio-layout-toggle')?.addEventListener('click', () => {
      _cardLayout = _cardLayout === 'horizontal' ? 'vertical' : 'horizontal';
      localStorage.setItem('studioCardLayout', _cardLayout);
      applyCardLayout();
      rerender();
    });

    $('studio-save-images-popup')?.addEventListener('click', e => { if (e.target === $('studio-save-images-popup')) $('studio-save-images-popup').style.display = 'none'; });
    $('studio-choose-folder').addEventListener('click', chooseFolder);
    $('studio-gen-all-images').addEventListener('click', genAllImages);
    $('studio-gen-all-videos').addEventListener('click', genAllVideos);
    $('studio-stop-all').addEventListener('click', () => { stopAll = true; $('studio-stop-all').textContent = 'Đang dừng...'; });
    $('studio-clear-all').addEventListener('click', clearAll);

    // Filter dropdown
    const _filterToggle = $('studio-filter-toggle');
    const _filterMenu = $('studio-filter-menu');
    function _setFilterMenuOpen(open) {
      if (!_filterMenu || !_filterToggle) return;
      _filterMenu.classList.toggle('open', open);
      _filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    _filterToggle?.addEventListener('click', e => {
      e.stopPropagation();
      _setFilterMenuOpen(!_filterMenu?.classList.contains('open'));
    });
    _filterMenu?.addEventListener('click', e => {
      const item = e.target.closest('[data-studio-filter]');
      if (!item) return;
      const filterKey = item.dataset.studioFilter || 'all';
      setFilter(filterKey);
      _setFilterMenuOpen(false);
    });
    document.addEventListener('click', e => {
      if (!_filterMenu || !_filterToggle) return;
      if (!e.target.closest('#studio-filter-menu') && !e.target.closest('#studio-filter-toggle')) {
        _setFilterMenuOpen(false);
      }
    });
    // Save quality dropdown logic
    let _saveQuality = '1080'; // '1080' | '720'
    const _qualityMenu = $('studio-save-quality-menu');
    const _qualityToggle = $('studio-save-quality-toggle');
    const _toolbarToggleBtn = $('studio-toggle-toolbar');
    const _toolbarRoot = $('studio-sticky-bar');
    let _toolbarCompact = localStorage.getItem('studioToolbarCompact') === '1';

    function _applyToolbarCompact() {
      if (_toolbarRoot) _toolbarRoot.classList.toggle('toolbar-compact', _toolbarCompact);
      if (_toolbarToggleBtn) _toolbarToggleBtn.textContent = _toolbarCompact ? 'Hiện Toolbar' : 'Ẩn Toolbar';
      if (_qualityMenu) _qualityMenu.style.display = 'none';
    }

    function _updateQualityLabel() {
      if (_qualityToggle) _qualityToggle.textContent = _saveQuality === '1080' ? '1080p ▾' : '720p ▾';
      // Update checkmark icons
      document.querySelectorAll('.studio-quality-opt').forEach(opt => {
        const check = opt.querySelector('svg');
        if (check) check.style.opacity = opt.dataset.q === _saveQuality ? '1' : '0';
      });
    }

    function _studioFancyLabel(selectId, value, text) {
      if (selectId === 'studio-image-count') {
        const n = parseInt(value, 10) || 1;
        return `${n} ảnh`;
      }
      if (selectId === 'studio-video-count') {
        const n = parseInt(value, 10) || 1;
        return `${n} video`;
      }
      return text || '';
    }

    function _studioFancyIcon(selectId, value) {
      const icon = (svg, tone) => ({ tone, svg });
      if (selectId === 'studio-model') {
        if (value === 'auto') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v4"/><path d="M12 17v4"/><path d="M4.9 4.9l2.8 2.8"/><path d="M16.3 16.3l2.8 2.8"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="M4.9 19.1l2.8-2.8"/><path d="M16.3 7.7l2.8-2.8"/></svg>', 'violet');
        if (value === 'flow_fast_relaxed') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L4 14h7l-1 8 10-14h-7l0-6z"/></svg>', 'orange');
        if (value === 'flow_fast_no_ultra') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>', 'blue');
        return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8z"/></svg>', 'green');
      }
      if (selectId === 'studio-image-model') {
        if (value === 'Nano Banana pro') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="14" y2="16"/></svg>', 'amber');
        if (value === 'Nano Banana 2') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="2"/><circle cx="8" cy="16" r="2"/><path d="M12 8h8"/><path d="M12 16h8"/></svg>', 'orange');
        if (value === 'Imagen 4') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.2 4.4L19 9.6l-4 2.8.8 4.8L12 14.8 8.2 17.2 9 12.4 5 9.6l4.8-2.2L12 3z"/></svg>', 'teal');
        return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>', 'slate');
      }
      if (selectId === 'studio-image-count') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-5 5"/></svg>', 'rose');
      if (selectId === 'studio-video-count') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></svg>', 'blue');
      return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>', 'slate');
    }

    function _studioFancyBadge(selectId, value) {
      if (selectId === 'studio-image-count' || selectId === 'studio-video-count') {
        return String(parseInt(value, 10) || 1);
      }
      return '';
    }

    function _studioFancyIconHtml(selectId, value) {
      const icon = _studioFancyIcon(selectId, value);
      const badge = _studioFancyBadge(selectId, value);
      return `
        <span class="studio-dd-icon-wrap">
          <span class="studio-dd-icon tone-${icon.tone}">${icon.svg}</span>
          ${badge ? `<span class="studio-dd-badge">${badge}</span>` : ''}
        </span>`;
    }

    function _enhanceStudioSelect(selectEl) {
      if (!selectEl || selectEl.dataset.fancyReady === '1') return;
      selectEl.dataset.fancyReady = '1';
      const selectId = selectEl.id;

      const root = document.createElement('div');
      root.className = 'studio-dd';
      selectEl.parentNode.insertBefore(root, selectEl);
      root.appendChild(selectEl);
      selectEl.classList.add('studio-dd-native');

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'studio-dd-trigger';
      const menu = document.createElement('div');
      menu.className = 'studio-dd-menu';
      root.appendChild(trigger);
      root.appendChild(menu);

      function render() {
        const selectedOpt = selectEl.options[selectEl.selectedIndex];
        const selectedText = _studioFancyLabel(selectId, selectEl.value, selectedOpt?.textContent?.trim() || '');
        trigger.innerHTML = `
          <span class="studio-dd-trigger-main">
            ${_studioFancyIconHtml(selectId, selectEl.value)}
            <span class="studio-dd-trigger-text">${selectedText}</span>
          </span>
          <span class="studio-dd-caret">⌄</span>`;

        menu.innerHTML = '';
        Array.from(selectEl.options).forEach(opt => {
          const val = opt.value;
          const label = _studioFancyLabel(selectId, val, opt.textContent.trim());
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'studio-dd-option' + (val === selectEl.value ? ' active' : '');
          btn.innerHTML = `
            <span class="studio-dd-option-main">
              ${_studioFancyIconHtml(selectId, val)}
              <span class="studio-dd-option-text">${label}</span>
            </span>
            <span class="studio-dd-option-check">✓</span>`;
          btn.addEventListener('click', () => {
            if (selectEl.value !== val) {
              selectEl.value = val;
              selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            root.classList.remove('open');
            render();
          });
          menu.appendChild(btn);
        });
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.studio-dd.open').forEach(x => { if (x !== root) x.classList.remove('open'); });
        root.classList.toggle('open');
      });
      selectEl.addEventListener('change', render);
      render();
    }

    _qualityToggle?.addEventListener('click', e => {
      e.stopPropagation();
      if (!_qualityMenu) return;
      const isHidden = _qualityMenu.style.display === 'none' || !_qualityMenu.style.display;
      if (isHidden) {
        _qualityMenu.style.display = 'block';
      } else {
        _qualityMenu.style.display = 'none';
      }
    });

    document.querySelectorAll('.studio-quality-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        _saveQuality = opt.dataset.q;
        _updateQualityLabel();
        if (_qualityMenu) _qualityMenu.style.display = 'none';
      });
      opt.addEventListener('mouseover', () => { opt.style.background = 'var(--bg3,#f5f5f5)'; });
      opt.addEventListener('mouseout', () => { opt.style.background = ''; });
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.studio-save-split') && _qualityMenu) _qualityMenu.style.display = 'none';
    });

    _toolbarToggleBtn?.addEventListener('click', () => {
      _toolbarCompact = !_toolbarCompact;
      localStorage.setItem('studioToolbarCompact', _toolbarCompact ? '1' : '0');
      _applyToolbarCompact();
    });
    _applyToolbarCompact();

    ['studio-model', 'studio-image-model', 'studio-image-count', 'studio-video-count'].forEach(id => _enhanceStudioSelect($(id)));
    document.addEventListener('click', e => {
      if (!e.target.closest('.studio-dd')) document.querySelectorAll('.studio-dd.open').forEach(x => x.classList.remove('open'));
    });

    $('studio-save-all').addEventListener('click', () => {
      if (_saveQuality === '720') saveAllVideos720();
      else saveAllVideos1080();
    });
    $('studio-save-images-btn')?.addEventListener('click', openSaveImagesPopup);
    $('studio-model').addEventListener('change', e => { cfg.model = e.target.value; });
    $('studio-image-model').addEventListener('change', e => { cfg.imageModel = e.target.value; });
    $('studio-image-count').addEventListener('change', e => { cfg.imageCount = parseInt(e.target.value, 10) || 1; });
    $('studio-video-count').addEventListener('change', e => { cfg.videoCount = parseInt(e.target.value, 10) || 1; });
    $('studio-auto-upscale').addEventListener('change', e => { cfg.autoUpscale = e.target.checked; });
    $('studio-auto-download').addEventListener('change', async e => {
      cfg.autoDownload = e.target.checked;
      if (!cfg.autoDownload) return;
      if (!cfg.saveHandle && !cfg.saveFolder) {
        await chooseFolder();
      }
      if (!cfg.saveHandle && !cfg.saveFolder) {
        cfg.autoDownload = false;
        e.target.checked = false;
        toast('Chọn folder trước khi bật Auto Lưu', 'info');
      }
      _syncAutoDownloadUI();
    });
    document.querySelectorAll('.studio-aspect-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.studio-aspect-btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      cfg.aspect = btn.dataset.val;
    }));
    document.addEventListener('click', e => {
      if (!e.target.closest('.card-action-group')) document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
    });
    $('studio-img-popup').addEventListener('click', e => { if (e.target === $('studio-img-popup')) closePopup(); });
    $('studio-import-popup').addEventListener('click', e => { if (e.target === $('studio-import-popup')) $('studio-import-popup').style.display = 'none'; });
    $('studio-library-picker').addEventListener('click', e => { if (e.target === $('studio-library-picker')) closeLibraryPicker(); });
    $('studio-library-category-filter').addEventListener('change', () => renderLibraryPicker());
    _syncAutoDownloadUI();
    loadLibrarySources().catch(() => { });
    initVaultListeners();
    updateStats();

    // ── Drag & Drop ─────────────────────────────────────────────────────────
    _initStudioDragDrop();
  };

  function _initStudioDragDrop() {
    const studioPage = document.querySelector('#tab-studio');
    if (!studioPage) return;

    // Overlay element
    const overlay = document.createElement('div');
    overlay.id = 'studio-dnd-overlay';
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9000;display:none;',
      'align-items:center;justify-content:center;flex-direction:column;gap:16px;',
      'background:color-mix(in srgb, var(--accent,#7c3aed) 14%, transparent);backdrop-filter:blur(2px);',
      'border:3px dashed color-mix(in srgb, var(--accent,#7c3aed) 78%, white 22%);pointer-events:none;transition:opacity .15s;',
    ].join('');
    overlay.innerHTML = `
      <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#7c3aed)" stroke-width="1.5">
        <path d="M12 5v14M5 12l7-7 7 7"/>
      </svg>
      <div id="studio-dnd-label" style="font-size:22px;font-weight:700;color:var(--accent,#7c3aed);text-align:center;line-height:1.4;"></div>`;
    document.body.appendChild(overlay);

    let dragEnterCount = 0;
    let _cardDragTarget = null; // card id being hovered during single-image drag

    function _getFiles(dt) {
      return dt.items
        ? Array.from(dt.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
        : Array.from(dt.files || []);
    }

    function _showOverlay(label) {
      overlay.style.display = 'flex';
      document.getElementById('studio-dnd-label').innerHTML = label;
    }
    function _hideOverlay() { overlay.style.display = 'none'; }

    // ── Per-card hover highlight ─────────────────────────────────────────────
    function _getCardElFromPoint(x, y) {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) {
        const card = el.closest('.studio-card');
        if (card) return card;
      }
      return null;
    }

    function _highlightCard(cardEl, cardIndex) {
      _clearCardHighlight();
      _cardDragTarget = cardEl ? (cardEl.id || '').replace(/^card-/, '') || null : null;
      if (!cardEl) return;
      cardEl.classList.add('dnd-card-hover');
      let badge = cardEl.querySelector('.dnd-card-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'dnd-card-badge';
        badge.style.cssText = [
          'position:absolute;inset:0;border-radius:inherit;z-index:10;',
          'display:flex;align-items:center;justify-content:center;',
          'background:rgba(236,72,153,0.18);border:2px solid var(--pink,#ec4899);',
          'font-size:15px;font-weight:700;color:var(--pink,#ec4899);pointer-events:none;',
        ].join('');
        cardEl.style.position = 'relative';
        cardEl.appendChild(badge);
      }
      badge.textContent = `Thêm vào cụm ${(cardIndex ?? '') + 1}`;
    }

    function _clearCardHighlight() {
      document.querySelectorAll('.studio-card.dnd-card-hover').forEach(el => {
        el.classList.remove('dnd-card-hover');
        el.querySelector('.dnd-card-badge')?.remove();
      });
      _cardDragTarget = null;
    }

    // ── Global dragenter/leave counter ──────────────────────────────────────
    let _isSingleImageDrag = false;

    document.addEventListener('dragenter', e => {
      if (!document.querySelector('#tab-studio.active')) return;
      const items = e.dataTransfer?.items ? Array.from(e.dataTransfer.items) : [];
      if (!items.some(i => i.kind === 'file')) return;
      dragEnterCount++;
      if (dragEnterCount === 1) {
        _isSingleImageDrag = items.length === 1 && items[0].type?.startsWith('image/');
        if (_isSingleImageDrag) {
          // Kéo 1 ảnh: KHÔNG show overlay toàn màn hình, chỉ highlight card
        } else if (items.some(i => i.type?.startsWith('image/'))) {
          _showOverlay(`Thả để import <strong>${items.length}</strong> ảnh vào Studio`);
        } else {
          _showOverlay('Thả file prompt vào đây<br><span style="font-size:14px;font-weight:400;">.txt · .json · .xlsx</span>');
        }
      }
      e.preventDefault();
    }, false);

    document.addEventListener('dragleave', () => {
      if (!document.querySelector('#tab-studio.active')) return;
      dragEnterCount = Math.max(0, dragEnterCount - 1);
      if (dragEnterCount === 0) {
        _hideOverlay();
        _clearCardHighlight();
        _isSingleImageDrag = false;
      }
    }, false);

    document.addEventListener('dragover', e => {
      if (!document.querySelector('#tab-studio.active')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      if (!_isSingleImageDrag) return;

      // Kéo 1 ảnh: highlight card dưới con trỏ
      const cardEl = _getCardElFromPoint(e.clientX, e.clientY);
      const currentHighlighted = document.querySelector('.studio-card.dnd-card-hover');
      if (cardEl !== currentHighlighted) {
        const allCards = Array.from(document.querySelectorAll('#studio-cards .studio-card'));
        const idx = allCards.indexOf(cardEl);
        _highlightCard(cardEl, idx);
      }
    }, false);

    document.addEventListener('drop', e => {
      if (!document.querySelector('#tab-studio.active')) return;
      e.preventDefault();
      dragEnterCount = 0;
      _hideOverlay();

      const files = _getFiles(e.dataTransfer);
      _isSingleImageDrag = false;

      if (!files.length) { _clearCardHighlight(); return; }

      const images = files.filter(f => f.type.startsWith('image/'));
      const docs = files.filter(f => ['txt', 'json', 'xlsx'].includes(f.name.split('.').pop().toLowerCase()));

      // 1 ảnh thả vào card cụ thể → vào refs, bỏ qua rule số cụm
      if (images.length === 1) {
        // Tìm card dưới điểm thả (ưu tiên _cardDragTarget, fallback elementsFromPoint)
        let targetCardEl = _cardDragTarget
          ? document.getElementById('card-' + _cardDragTarget)
          : null;
        if (!targetCardEl) targetCardEl = _getCardElFromPoint(e.clientX, e.clientY);
        _clearCardHighlight();
        if (targetCardEl) {
          const cardId = (targetCardEl.id || '').replace(/^card-/, '');
          const card = cards.find(c => c.id === cardId);
          if (card) {
            const file = images[0];
            card.refs.unshift({ url: URL.createObjectURL(file), file, label: file.name || 'Ảnh tham chiếu' });
            renderCard(card, false);
            updateStats();
            toast(`Đã thêm ảnh vào cụm ${cards.indexOf(card) + 1}`, 'success');
            return;
          }
        }
      }
      _clearCardHighlight();

      // 1 ảnh thả ra ngoài (không trúng card) hoặc nhiều ảnh → importImages với rule số cụm
      if (images.length > 0 && docs.length === 0) {
        importImages(images);
        return;
      }

      // Prompt files
      if (docs.length > 0 && images.length === 0) {
        if (docs.length > 1) { toast('Chỉ kéo 1 file prompt mỗi lần', 'error'); return; }
        const file = docs[0];
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'xlsx') importPromptsXlsx(file);
        else importPrompts(file, ext === 'json' ? 'json' : 'txt');
        return;
      }

      if (images.length === 0 && docs.length === 0) {
        toast('File không hợp lệ — chỉ chấp nhận .txt, .json, .xlsx hoặc ảnh', 'error');
      }
    }, false);
  }

  // ── Save Images Popup ────────────────────────────────────────
  let _saveImgSelected = new Set(); // key = "cardId:imgIndex"
  let _saveImgDlQuality = '1k';
  let _saveImgLibQuality = '1k';

  function toggleSaveImgQualityMenu() {
    const m = $('studio-save-images-quality-menu');
    if (m) m.style.display = m.style.display === 'none' ? '' : 'none';
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#studio-save-images-quality-btn') && !e.target.closest('#studio-save-images-quality-menu')) {
      const m = $('studio-save-images-quality-menu');
      if (m) m.style.display = 'none';
    }
  });

  function openSaveImagesPopup() {
    const allImages = [];
    cards.forEach(card => {
      card.images.forEach((img, i) => {
        allImages.push({ key: `${card.id}:${i}`, cardId: card.id, imgIdx: i, url: img.url, cardTitle: `Cụm ${cards.indexOf(card) + 1}`, prompt: card.prompt || '', media_id: img.media_id || '', account_index: img.account_index || 0 });
      });
    });
    if (!allImages.length) return toast('Chưa có ảnh nào được tạo', 'info');
    _saveImgSelected = new Set();
    const popup = $('studio-save-images-popup');
    const grid = $('studio-save-images-grid');
    const countEl = $('studio-save-images-count');

    function renderGrid() {
      countEl.textContent = _saveImgSelected.size;
      grid.innerHTML = allImages.map(item => `
        <div onclick="this.querySelector('input').click()" style="cursor:pointer;border-radius:10px;overflow:hidden;border:2px solid ${_saveImgSelected.has(item.key) ? 'var(--accent)' : 'var(--border)'};background:var(--bg3);position:relative;">
          <img src="${item.url}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;">
          <div style="position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.55);backdrop-filter:blur(4px);color:#fff;font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;pointer-events:none;white-space:nowrap;">${item.cardTitle}</div>
          <input type="checkbox" data-key="${item.key}" ${_saveImgSelected.has(item.key) ? 'checked' : ''} style="position:absolute;top:6px;right:6px;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" onclick="event.stopPropagation()">
        </div>
      `).join('');
      grid.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (cb.checked) _saveImgSelected.add(cb.dataset.key);
          else _saveImgSelected.delete(cb.dataset.key);
          renderGrid();
        });
      });
    }

    renderGrid();
    popup.style.display = 'flex';

    $('studio-save-images-select-all').onclick = () => { allImages.forEach(i => _saveImgSelected.add(i.key)); renderGrid(); };
    $('studio-save-images-deselect').onclick = () => { _saveImgSelected.clear(); renderGrid(); };

    // Quality menu options
    document.querySelectorAll('.simg-q-opt').forEach(el => {
      el.onclick = () => {
        _saveImgDlQuality = el.dataset.quality;
        $('studio-save-images-to-disk').textContent = `Tải về (${_saveImgDlQuality.toUpperCase()})`;
        $('studio-save-images-quality-menu').style.display = 'none';
      };
    });
    document.querySelectorAll('.simg-lq-opt').forEach(el => {
      el.onclick = () => {
        _saveImgLibQuality = el.dataset.libQuality;
        $('studio-save-images-to-lib').textContent = `Lưu vào kho (${_saveImgLibQuality.toUpperCase()})`;
        $('studio-save-images-quality-menu').style.display = 'none';
      };
    });

    // Tải về — chọn folder 1 lần rồi tải hết
    $('studio-save-images-to-disk').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      let dirHandle = null;
      if (window.showDirectoryPicker) {
        try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_) { return; }
      }
      const progWrap = $('studio-save-images-progress');
      const progBar = $('studio-save-images-progress-bar');
      const progText = $('studio-save-images-progress-text');
      if (progWrap) progWrap.style.display = '';
      let done = 0;
      // Chia 2 luồng song song
      const half = Math.ceil(selected.length / 2);
      const g1 = selected.slice(0, half);
      const g2 = selected.slice(half);
      async function processGroup(group) {
        for (const item of group) {
          const baseName = `studio_img_${item.cardTitle.replace(/\s/g, '_')}_${Date.now()}`;
          await _downloadImageWithQuality(item.url, item.media_id, _saveImgDlQuality, baseName, dirHandle, item.account_index || 0);
          done++;
          const pct = Math.round(done / selected.length * 100);
          if (progBar) progBar.style.width = pct + '%';
          if (progText) progText.textContent = `${done} / ${selected.length}`;
        }
      }
      await Promise.all([processGroup(g1), processGroup(g2)]);
      toast(`Đã tải ${selected.length} ảnh về máy`, 'success');
      if (progWrap) setTimeout(() => { progWrap.style.display = 'none'; if (progBar) progBar.style.width = '0%'; }, 1500);
    };

    // Lưu kho — SSE stream, 2 account song song
    $('studio-save-images-to-lib').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      const cats = libraryCategories.length ? libraryCategories : (await API.get('/api/image/library/categories').then(r => r.items || []).catch(() => []));
      const opts = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      const dlgId = 'studio-save-images-cat-dlg';
      let dlg = $(dlgId);
      if (!dlg) { dlg = document.createElement('div'); dlg.id = dlgId; dlg.className = 'studio-popup-overlay'; document.body.appendChild(dlg); }
      dlg.innerHTML = `<div style="background:var(--bg2);border-radius:14px;padding:22px;min-width:320px;">
        <div style="font-weight:600;margin-bottom:12px;">Lưu ${selected.length} ảnh vào kho (${_saveImgLibQuality.toUpperCase()})</div>
        <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Nhóm</label>
        <select id="studio-simg-cat-sel" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:12px;">${opts}</select>
        <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:4px;">Thể loại</label>
        <select id="studio-simg-type-sel" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:14px;">
          <option value="nhanvat">Nhân vật</option>
          <option value="vatpham">Vật phẩm</option>
          <option value="background">Background</option>
          <option value="style">Style</option>
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${dlgId}').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" id="studio-simg-cat-confirm">Lưu</button>
        </div></div>`;
      dlg.style.display = 'flex';
      dlg.onclick = e => { if (e.target === dlg) dlg.style.display = 'none'; };
      $('studio-simg-cat-confirm').onclick = async () => {
        const catId = $('studio-simg-cat-sel').value || 'default';
        const assetType = $('studio-simg-type-sel').value || 'nhanvat';
        dlg.style.display = 'none';
        const images = selected.map(item => ({ url: item.url, media_id: item.media_id, prompt: item.prompt, asset_type: assetType }));
        await _batchSaveLibSSE(images, catId, _saveImgLibQuality);
        await loadLibrarySources().catch(() => { });
        if (window.LibraryModule && typeof window.LibraryModule.refresh === 'function') {
          await window.LibraryModule.refresh().catch(() => { });
        }
      };
    };

    $('studio-save-images-add-to-card').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      $('studio-save-images-popup').style.display = 'none';
      let added = 0;
      for (const item of selected) {
        const card = cards.find(c => c.id === item.cardId);
        if (!card) continue;
        if (card.refs.some(r => r.url === item.url)) continue;
        // Fetch file qua proxy để tránh CORS/expire của Google URL
        let file = null;
        try {
          const fetchUrl = (item.url.includes('googleapis.com') || item.url.includes('google.com'))
            ? `/api/veo/proxy-download?url=${encodeURIComponent(item.url)}&filename=studio_ref_${Date.now()}.png`
            : item.url;
          const resp = await fetch(fetchUrl);
          const blob = await resp.blob();
          file = new File([blob], `studio_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
        } catch (_) { }
        card.refs.unshift({ url: item.url, file, label: `Ảnh từ ${item.cardTitle}`, media_id: item.media_id || '' });
        card.refIndex = 0;
        renderCard(card, false);
        added++;
      }
      toast(`Đã thêm ${added} ảnh vào cụm tương ứng`, 'success');
    };
  }

  // Video popup state
  let _videoPopup = null;

  function openVideoPopup(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const out = card.outputs[idx];
    if (!out) return;
    const url = out.video_url || out.videoUri || out.fifeUrl || '';
    if (!url) return toast('Video chưa có URL', 'error');
    _videoPopup = { cardId, idx, url };
    const player = document.getElementById('studio-video-popup-player');
    const caption = document.getElementById('studio-video-popup-caption');
    if (player) { player.src = url; player.load(); }
    if (caption) caption.textContent = `Video ${idx + 1} — Cụm ${cards.findIndex(c => c.id === cardId) + 1}`;
    const vpopup = document.getElementById('studio-video-popup');
    if (vpopup) vpopup.style.display = 'flex';
  }

  function closeVideoPopup() {
    const vpopup = document.getElementById('studio-video-popup');
    const player = document.getElementById('studio-video-popup-player');
    if (player) { player.pause(); player.src = ''; }
    if (vpopup) vpopup.style.display = 'none';
    _videoPopup = null;
  }

  async function downloadVideoPopup() {
    if (!_videoPopup) return;
    const manualHandle = await pickManualDownloadFolder();
    if (window.showDirectoryPicker && !manualHandle) return toast('Bạn chưa chọn folder', 'info');
    const card = cards.find(c => c.id === _videoPopup.cardId);
    const cardIdx = card ? String(cards.indexOf(card) + 1).padStart(3, '0') : '000';
    await saveVideo(_videoPopup.url, `studio_${cardIdx}_video_${_videoPopup.idx + 1}.mp4`, manualHandle);
  }

  function deleteVideoPopup() {
    if (!_videoPopup) return;
    deleteVideo(_videoPopup.cardId, _videoPopup.idx);
    closeVideoPopup();
  }

  function deleteVideo(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.outputs.splice(idx, 1);
    card.outputIndex = Math.max(0, Math.min(card.outputIndex, card.outputs.length - 1));
    if (!card.outputs.length) card.status = 'idle';
    renderCard(card, false);
    updateStats();
  }

  function deleteImage(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.images.splice(idx, 1);
    renderCard(card, false);
  }

  function deletePopupItem() {
    if (!popup) return;
    if (popup.type === 'generated') {
      deleteImage(popup.cardId, popup.idx);
    } else if (popup.type === 'ref') {
      removeRef(popup.cardId, popup.idx);
    } else if (popup.type === 'char') {
      removeChar(popup.cardId, popup.idx);
    }
    closePopup();
  }

  // ── VAULT (Kho lưu trữ) ─────────────────────────────────────
  let _vaultAssets = [];
  let _vaultCategories = [];
  let _vaultSelectedIds = new Set();
  let _vaultTypeFilter = 'all';
  let _vaultGroupFilter = 'all';

  // Exact word boundary match để tránh "sparky" khớp "sparkyjsjbd"
  function _matchesName(prompt, charName) {
    const p = norm(prompt);
    const n = norm(charName);
    if (!n) return false;
    // Word boundary: ký tự trước/sau phải là khoảng trắng, dấu câu, hoặc đầu/cuối chuỗi
    const re = new RegExp('(?:^|[\\s,.(\\[\\-])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s,.)\\]\\-])', '');
    return re.test(p);
  }

  async function openVault() {
    const popup = $('studio-vault-popup');
    if (!popup) return;

    // Load data
    const [catsRes, assetsRes] = await Promise.all([
      API.get('/api/image/library/categories'),
      API.get('/api/image/library/assets'),
    ]);
    _vaultCategories = (catsRes.items || []).filter(c => !isDefaultCategory(c));
    _vaultAssets = assetsRes.items || [];
    _vaultSelectedIds = new Set();
    _vaultTypeFilter = 'all';
    _vaultGroupFilter = 'all';

    // Populate group dropdown
    const groupSel = $('vault-group-filter');
    if (groupSel) {
      groupSel.innerHTML = '<option value="all">Tất cả nhóm</option>' +
        _vaultCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      groupSel.value = 'all';
    }
    const typeSel = $('vault-type-filter');
    if (typeSel) typeSel.value = 'all';

    renderVaultGrid();
    popup.style.display = 'flex';
  }

  function closeVault() {
    const popup = $('studio-vault-popup');
    if (popup) popup.style.display = 'none';
    hideVaultMenus();
  }

  function hideVaultMenus() {
    ['vault-ctx-menu', 'vault-add-card-menu'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
  }

  function _vaultFiltered() {
    return _vaultAssets.filter(a => {
      if (_vaultTypeFilter !== 'all' && a.asset_type !== _vaultTypeFilter) return false;
      if (_vaultGroupFilter !== 'all' && a.category_id !== _vaultGroupFilter) return false;
      return true;
    });
  }

  function renderVaultGrid() {
    const grid = $('vault-grid');
    if (!grid) return;
    const items = _vaultFiltered();
    const countLabel = $('vault-count-label');
    if (countLabel) countLabel.textContent = `${items.length} ảnh`;

    const typeLabel = { nhanvat: 'Nhân Vật', vatpham: 'Vật Phẩm', style: 'Style', background: 'BG' };

    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text3);font-size:13px;">Không có ảnh nào</div>`;
      updateVaultSelCount();
      return;
    }

    grid.innerHTML = items.map(item => `
      <div class="studio-vault-card ${_vaultSelectedIds.has(item.id) ? 'selected' : ''}"
           data-id="${item.id}">
        <input type="checkbox" class="studio-vault-card-check" data-id="${item.id}"
               ${_vaultSelectedIds.has(item.id) ? 'checked' : ''} onclick="event.stopPropagation()">
        <img src="${item.url}" alt="${item.name}" loading="lazy">
        <span class="studio-vault-card-badge">${typeLabel[item.asset_type] || 'Kho'}</span>
        <div class="studio-vault-card-label">${item.name || 'Chưa đặt tên'}</div>
      </div>
    `).join('');

    grid.querySelectorAll('.studio-vault-card-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = e.target.dataset.id;
        e.target.checked ? _vaultSelectedIds.add(id) : _vaultSelectedIds.delete(id);
        grid.querySelector(`.studio-vault-card[data-id="${id}"]`)?.classList.toggle('selected', e.target.checked);
        updateVaultSelCount();
      });
    });

    grid.querySelectorAll('.studio-vault-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.classList.contains('studio-vault-card-check')) return;
        const cb = card.querySelector('.studio-vault-card-check');
        if (!cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!_vaultSelectedIds.has(card.dataset.id)) {
          _vaultSelectedIds.add(card.dataset.id);
          card.classList.add('selected');
          const cb = card.querySelector('.studio-vault-card-check');
          if (cb) cb.checked = true;
          updateVaultSelCount();
        }
        showVaultCtxMenu(e.clientX, e.clientY);
      });
    });

    updateVaultSelCount();
  }

  function updateVaultSelCount() {
    const el = $('vault-sel-count');
    if (el) el.textContent = `Đã chọn: ${_vaultSelectedIds.size}`;
    const selAll = $('vault-select-all');
    if (selAll) {
      const items = _vaultFiltered();
      selAll.checked = items.length > 0 && items.every(i => _vaultSelectedIds.has(i.id));
      selAll.indeterminate = !selAll.checked && items.some(i => _vaultSelectedIds.has(i.id));
    }
  }

  function showVaultCtxMenu(x, y) {
    hideVaultMenus();
    const menu = $('vault-ctx-menu');
    if (!menu) return;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
    });
  }

  function showVaultAddCardMenu(x, y) {
    hideVaultMenus();
    const menu = $('vault-add-card-menu');
    const listEl = $('vault-card-list');
    if (!menu || !listEl) return;
    listEl.innerHTML = cards.map((card, idx) =>
      `<div class="lib-ctx-item vault-card-opt" data-cid="${card.id}">Cụm ${idx + 1}</div>`
    ).join('') || '<div class="lib-ctx-head">Chưa có cụm nào</div>';
    listEl.querySelectorAll('.vault-card-opt').forEach(el => {
      el.addEventListener('click', () => {
        hideVaultMenus();
        addVaultItemsToCard(el.dataset.cid);
      });
    });
    // Clamp vị trí để không tràn viewport
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
    });
  }

  async function addVaultItemsToCard(cardId) {
    if (!_vaultSelectedIds.size) return toast('Chưa chọn ảnh nào', 'error');
    const card = cards.find(c => c.id === cardId);
    if (!card) return toast('Không tìm thấy cụm', 'error');
    const items = _vaultAssets.filter(a => _vaultSelectedIds.has(a.id));
    let added = 0;
    for (const item of items) {
      if (card.refs.some(r => r.url === item.url)) continue;
      let file = null;
      try {
        const fetchUrl = (item.url.includes('googleapis.com') || item.url.includes('google.com'))
          ? `/api/veo/proxy-download?url=${encodeURIComponent(item.url)}&filename=vault_ref_${Date.now()}.png`
          : item.url;
        const resp = await fetch(fetchUrl);
        const blob = await resp.blob();
        file = new File([blob], `vault_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
      } catch (_) { }
      card.refs.unshift({ url: item.url, file, label: item.name || 'Ảnh kho', media_id: item.media_id || '' });
      card.refIndex = 0;
      renderCard(card, false);
      added++;
    }
    toast(`Đã thêm ${added} ảnh vào cụm`, added ? 'success' : 'info');
  }

  // Load nhanh: gắn ảnh vào các cụm có prompt chứa tên ảnh (exact word match)
  async function vaultLoadQuick() {
    if (!cards.length) return toast('Không có cụm nào', 'info');
    const items = _vaultFiltered();
    if (!items.length) return toast('Không có ảnh trong bộ lọc', 'info');
    let totalAdded = 0;
    for (const card of cards) {
      for (const item of items) {
        if (!_matchesName(card.prompt, item.name)) continue;
        if (card.refs.some(r => r.url === item.url)) continue;
        let file = null;
        try {
          const resp = await fetch(item.url);
          const blob = await resp.blob();
          file = new File([blob], `vault_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
        } catch (_) { }
        card.refs.unshift({ url: item.url, file, label: item.name || 'Ảnh kho', media_id: item.media_id || '' });
        card.refIndex = 0;
        totalAdded++;
      }
    }
    rerender();
    toast(totalAdded ? `Load nhanh: thêm ${totalAdded} ảnh vào các cụm` : 'Không khớp tên nào trong prompt', totalAdded ? 'success' : 'info');
  }

  function initVaultListeners() {
    $('studio-vault-btn')?.addEventListener('click', openVault);

    $('vault-type-filter')?.addEventListener('change', e => {
      _vaultTypeFilter = e.target.value;
      renderVaultGrid();
    });
    $('vault-group-filter')?.addEventListener('change', e => {
      _vaultGroupFilter = e.target.value;
      renderVaultGrid();
    });
    $('vault-select-all')?.addEventListener('change', e => {
      const items = _vaultFiltered();
      if (e.target.checked) items.forEach(i => _vaultSelectedIds.add(i.id));
      else items.forEach(i => _vaultSelectedIds.delete(i.id));
      renderVaultGrid();
    });
    $('vault-load-quick-btn')?.addEventListener('click', vaultLoadQuick);
    $('vault-add-to-card-btn')?.addEventListener('click', () => {
      if (!_vaultSelectedIds.size) return toast('Chưa chọn ảnh nào', 'error');
      const btn = $('vault-add-to-card-btn');
      const rect = btn.getBoundingClientRect();
      showVaultAddCardMenu(rect.left, rect.top - 8);
    });

    // Context menu actions
    $('vault-ctx-delete')?.addEventListener('click', () => {
      hideVaultMenus();
      // Xóa khỏi tất cả cụm (refs)
      const ids = new Set([..._vaultSelectedIds]);
      const urls = _vaultAssets.filter(a => ids.has(a.id)).map(a => a.url);
      let removed = 0;
      cards.forEach(card => {
        const before = card.refs.length;
        card.refs = card.refs.filter(r => !urls.includes(r.url));
        card.refIndex = Math.max(0, Math.min(card.refIndex, card.refs.length - 1));
        removed += before - card.refs.length;
      });
      rerender();
      toast(`Đã xóa ${removed} ảnh khỏi các cụm`, removed ? 'success' : 'info');
    });
    $('vault-ctx-add-to-card')?.addEventListener('click', e => {
      const rect = e.target.getBoundingClientRect();
      showVaultAddCardMenu(rect.right + 4, rect.top);
    });

    // Close menus on outside click
    document.addEventListener('click', e => {
      ['vault-ctx-menu', 'vault-add-card-menu'].forEach(id => {
        const el = $(id);
        if (el && !el.contains(e.target) && e.target.id !== 'vault-ctx-add-to-card') el.style.display = 'none';
      });
    }, true);
  }

  window.Studio = {
    openPopup,
    closePopup,
    saveToLib,
    downloadImg,
    addToCard,
    removeChar,
    removeRef,
    clearCardRefs,
    deleteCard(cardId) { cards = cards.filter(c => c.id !== cardId); $('card-' + cardId)?.remove(); updateStats(); },
    cloneCard,
    insertCard,
    toggleInsertMenu,
    toggleCharacter,
    autoCharacters,
    selectOutput,
    generateImagesForCard: genImages,
    generateVideoForCard: genVideo,
    upscaleCard,
    retryUpscale: async (cardId) => {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const ok = await upscaleCard(cardId, card.outputIndex || 0);
      if (ok) {
        card.status = 'completed';
        card.error = '';
        card.upscaleFailed = false;
        renderCard(card, false);
        updateStats();
        if (cfg.autoDownload) await saveOutputs(cardId);
      } else {
        card.upscaleFailed = true;
        renderCard(card, false);
      }
    },
    saveCardOutputs: saveOutputs,
    closeLibraryPicker,
    pickLibraryItem,
    autoCharactersAll,
    setFilter,
    deleteCurrentCategory,
    deleteImage,
    deleteVideo,
    openVideoPopup,
    closeVideoPopup,
    downloadVideoPopup,
    deleteVideoPopup,
    deletePopupItem,
    closeVault,
    togglePopupDlMenu,
    closePopupDlMenu,
    toggleSaveImgQualityMenu,
  };
})();
