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
  let _activeFilter = 'all'; // all | idle | running | completed | failed
  let _cardLayout = localStorage.getItem('studioCardLayout') || 'vertical';
  let popup = null;
  let cards = [];
  let libraryAssets = [];
  let libraryCharacters = [];
  let libraryCategories = [];
  let libraryPickerCardId = '';

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
    return { id: 'studio-' + (++seq), prompt, refs: [], refIndex: 0, chars: [], images: [], outputs: [], outputIndex: 0, status: 'idle', error: '', jobId: null, busyImage: false, busyVideo: false, upscaling: false };
  }


  function updateStats() {
    const pending = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running' || c.busyImage).length;
    const videoDone = cards.filter(c => c.outputs.length > 0).length;
    const imageDone = cards.filter(c => c.images.length > 0).length;
    const failed = cards.filter(c => c.status === 'failed').length;
    const el = id => document.getElementById(id);
    if (el('studio-pending-count')) el('studio-pending-count').textContent = pending;
    if (el('studio-saved-count')) el('studio-saved-count').textContent = videoDone;
    if (el('studio-metric-total')) el('studio-metric-total').textContent = cards.length + ' card';
    if (el('studio-metric-running')) el('studio-metric-running').textContent = running + ' đang chạy';
    if (el('studio-metric-done')) el('studio-metric-done').textContent = videoDone + ' video / ' + imageDone + ' ảnh';
    if (el('studio-metric-failed')) el('studio-metric-failed').textContent = failed + ' lỗi';
    if (el('studio-status-text')) el('studio-status-text').textContent = cards.length ? ('Studio theo dõi ' + cards.length + ' cụm.') : 'Chưa có batch. Import prompt hoặc thêm cụm để bắt đầu.';
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
      if (_activeFilter === 'all') { el.style.display = ''; return; }
      if (_activeFilter === 'running') {
        el.style.display = (card.status === 'running' || card.busyImage) ? '' : 'none';
      } else if (_activeFilter === 'completed') {
        el.style.display = (card.outputs.length > 0 || card.images.length > 0) ? '' : 'none';
      } else {
        el.style.display = card.status === _activeFilter ? '' : 'none';
      }
    });
  }

  function setFilter(f) {
    _activeFilter = f;
    updateStats();
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        cfg.saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        cfg.saveFolder = cfg.saveHandle.name;
        $('studio-folder-label').textContent = cfg.saveFolder;
        return;
      } catch (_) { }
    }
    const path = prompt('Nhập đường dẫn folder lưu video:', cfg.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      cfg.saveFolder = path;
      $('studio-folder-label').textContent = path;
    }
  }

  async function saveVideo(url, filename) {
    if (cfg.saveHandle) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const handle = await cfg.saveHandle.getFileHandle(filename, { create: true });
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
    libraryCategories = catsRes.items || [];
    libraryAssets = assetsRes.items || [];
    libraryCharacters = charsRes.data || [];
    populateLibraryCategoryFilters();
  }

  function populateLibraryCategoryFilters() {
    const saveSel = $('studio-save-category');
    const pickerSel = $('studio-library-category-filter');
    const options = [{ id: 'all', name: 'Tất cả' }, { id: '__characters__', name: 'Nhân vật' }, ...libraryCategories];
    if (saveSel) {
      saveSel.innerHTML = libraryCategories.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
      if (!saveSel.value && libraryCategories[0]) saveSel.value = libraryCategories[0].id;
    }
    if (pickerSel) {
      const current = pickerSel.value || 'all';
      pickerSel.innerHTML = options.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
      pickerSel.value = options.some(item => item.id === current) ? current : 'all';
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
    if (!filter || filter === 'all' || filter === '__characters__') return;
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
    if (delBtn) delBtn.style.display = (filter && filter !== 'all' && filter !== '__characters__') ? '' : 'none';
    if (!grid) return;
    const items = [
      ...libraryCharacters.map(ch => ({ type: 'character', id: ch.id, name: ch.name, url: ch.url, category_id: '__characters__', media_id: ch.media_id || '' })),
      ...libraryAssets.map(a => ({ type: 'asset', id: a.id, name: a.name, url: a.url, category_id: a.category_id || 'default' })),
    ].filter(item => filter === 'all' || item.category_id === filter);
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
    const statusCls = card.status === 'completed' ? 'completed' : card.status === 'failed' ? 'failed' : (card.status === 'running' || card.busyImage ? 'running' : '');
    const preview = (() => {
      const out = card.outputs[card.outputIndex];
      const url = out?.video_url || out?.videoUri || out?.fifeUrl || '';
      if (card.busyImage) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo ảnh...</div></div>';
      if (card.status === 'running') return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo video...</div></div>';
      if (card.upscaling) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang upscale 1080p...</div></div>';
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${card.error || 'Thất bại'}${card.upscaleFailed ? `<br><button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="Studio.retryUpscale('${card.id}')">Upscale lại</button>` : ''}</div>`;
      if (url) return `<video controls src="${url}" preload="metadata"></video>`;
      return '<span>Chưa có preview</span>';
    })();

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Cụm ${idx}</span>
        <div class="studio-toolbar-spacer"></div>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" onclick="Studio.toggleInsertMenu('${card.id}')">+ Cụm ▾</button>
          <div class="card-insert-menu" id="studio-insert-menu-${card.id}" style="display:none;">
            <div onclick="Studio.insertCard('${card.id}','before')">Thêm trước</div>
            <div onclick="Studio.insertCard('${card.id}','after')">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="Studio.cloneCard('${card.id}')">⧉</button>
        <button class="btn btn-secondary btn-sm" onclick="Studio.deleteCard('${card.id}')">🗑</button>
      </div>
      <div class="studio-card-body">
        ${_cardLayout === 'horizontal' ? `<div class="studio-card-left">` : ''}
        <div class="studio-preview-panel">${preview}</div>
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
            <span>Text Prompt</span>
            <span style="font-size:10px;color:var(--text3);font-weight:400;">Nhấn để chỉnh sửa</span>
          </label>
          <div class="studio-prompt-display studio-prompt-open ${!card.prompt ? 'empty' : ''}">${card.prompt ? card.prompt.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Nhập prompt cho cụm này...'}</div>
          <input type="file" class="studio-ref-input" accept="image/*" multiple style="display:none;">
        </div>
        <div class="studio-inline-tools">
          <button class="btn btn-secondary btn-sm studio-auto-char">AUTO Nhân Vật</button>
          <button class="btn btn-secondary btn-sm studio-clear-ref">Xóa ảnh tham chiếu</button>
          ${card.outputs.length ? `<button class="btn btn-secondary btn-sm studio-save-video-btn" onclick="Studio.saveCardOutputs('${card.id}')">Lưu video</button>` : ''}
        </div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>Ảnh tham chiếu</span><span>${combinedRefs(card).length ? ('Đã chọn ' + combinedRefs(card).length) : 'Chưa có ảnh'}</span></div>
          <div class="studio-strip">
            ${renderCombinedRefThumbs(card)}
            <button type="button" class="studio-add-thumb studio-open-library">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              Kho
            </button>
            <button type="button" class="studio-add-thumb studio-add-ref">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm
            </button>
          </div>
        </div>
        <div class="studio-card-actions">
          <button class="btn btn-primary studio-generate-image" ${card.busyImage ? 'disabled' : ''}>${card.busyImage ? 'Đang tạo hình...' : 'Tạo hình'}</button>
          <button class="btn btn-primary studio-generate-video" ${card.busyVideo ? 'disabled' : ''}>${card.busyVideo ? 'Đang tạo video...' : 'Tạo video'}</button>
          ${card.status === 'completed' ? `<button class="btn btn-secondary studio-regenerate-video">Tạo lại</button>` : ''}
        </div>
        ${_cardLayout === 'horizontal' ? `</div><div class="studio-card-right"><div class="studio-right-strips">` : ''}
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
        ${_cardLayout === 'horizontal' ? `</div></div>` : ''}
      </div>
    `;

    if (append) $('studio-cards').appendChild(el);
    // Prompt click → modal
    el.querySelector('.studio-prompt-open').addEventListener('click', () => openPromptModal(card));
    el.querySelectorAll('.studio-open-library').forEach(btn => btn.addEventListener('click', () => openLibraryPicker(card.id)));
    el.querySelector('.studio-auto-char').addEventListener('click', () => autoCharacters(card.id));
    el.querySelectorAll('.studio-add-ref').forEach(btn => btn.addEventListener('click', () => el.querySelector('.studio-ref-input').click()));
    el.querySelector('.studio-clear-ref').addEventListener('click', () => { card.refs = []; card.refIndex = 0; renderCard(card, false); updateStats(); });
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
          <button class="btn btn-secondary btn-sm" onclick="Studio.autoCharacters('${cardId}')">AUTO Nhân Vật</button>
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
          if (url) card.images.unshift({ url, media_id: img.media_id || img.mediaId || '', prompt: card.prompt, label: 'Ảnh đã tạo' });
        });
        card.status = 'idle';
        card.busyImage = false;
        renderCard(card, false);
        updateStats();
        toast('Đã tạo ' + (res.images || []).length + ' ảnh cho card', 'success');
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
    // Refs: ảnh có media_id thì gửi media_id, không thì upload binary
    const refMediaIds = [];
    for (let i = 0; i < card.refs.length; i++) {
      const ref = card.refs[i];
      if (ref.media_id) {
        refMediaIds.push(ref.media_id);
      } else {
        let file = ref.file;
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
    for (let i = 0; i < card.outputs.length; i++) {
      const out = card.outputs[i];
      const url = out.video_url || out.videoUri || out.fifeUrl;
      if (url) await saveVideo(url, `studio_${String(cards.indexOf(card) + 1).padStart(3, '0')}_${i + 1}.mp4`);
    }
  }

  // Lưu toàn bộ video 720p (chất lượng gốc, không upscale)
  async function saveAllVideos720() {
    if (!cfg.saveHandle) {
      await chooseFolder();
      if (!cfg.saveHandle) return toast('Vui lòng chọn folder lưu trước', 'info');
    }
    const cardsWithOutput = cards.filter(c => c.outputs && c.outputs.length);
    if (!cardsWithOutput.length) return toast('Chưa có video nào', 'info');
    let saved = 0, failed = 0;
    for (const card of cardsWithOutput) {
      for (let i = 0; i < card.outputs.length; i++) {
        const out = card.outputs[i];
        const cardIdx = String(cards.indexOf(card) + 1).padStart(3, '0');
        const url = out.video_url || out.videoUri || out.fifeUrl;
        if (url) { await saveVideo(url, `studio_${cardIdx}_${i + 1}_720p.mp4`); saved++; }
        else failed++;
      }
    }
    if (saved > 0) toast(`Đã lưu ${saved} video 720p (gốc)`, 'success');
    if (failed > 0) toast(`${failed} video thất bại`, 'error');
  }

  // Lưu toàn bộ video 1080p: upscale nếu chưa upscale, rồi lưu
  async function saveAllVideos1080() {
    // Bắt buộc chọn folder trước
    if (!cfg.saveHandle) {
      await chooseFolder();
      if (!cfg.saveHandle) return toast('Vui lòng chọn folder lưu trước', 'info');
    }
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
          card.upscaleFailed = false;
          renderCard(card, false);
          try {
            const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: i });
            if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
              card.outputs[i] = { ...out, ...res.outputs[0], _upscaled: true };
              const url1080 = card.outputs[i].video_url || card.outputs[i].videoUri || card.outputs[i].fifeUrl;
              if (url1080) { await saveVideo(url1080, filename); saved++; }
              else failed++;
            } else {
              toast(`Cụm ${cardIdx}: upscale thất bại`, 'error');
              failed++;
            }
          } catch (err) {
            toast(`Cụm ${cardIdx}: lỗi upscale - ${err.message}`, 'error');
            failed++;
          } finally {
            card.upscaling = false;
            renderCard(card, false);
          }
        } else {
          // Đã upscale rồi, lưu luôn
          const url1080 = out.video_url || out.videoUri || out.fifeUrl;
          if (url1080) { await saveVideo(url1080, filename); saved++; }
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
    card.upscaling = true;
    card.upscaleFailed = false;
    renderCard(card, false);
    try {
      const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: outputIndex });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[outputIndex] = { ...card.outputs[outputIndex], ...res.outputs[0], _upscaled: true };
        card.upscaleFailed = false;
        toast('Upscale 1080p thành công', 'success');
        return true;
      } else {
        toast(res.body || res.message || 'Upscale thất bại', 'error');
        return false;
      }
    } catch (err) {
      toast('Lỗi upscale: ' + err.message, 'error');
      return false;
    } finally {
      card.upscaling = false;
      renderCard(card, false);
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
    popup = { cardId, type, idx, url: item.url, prompt: card.prompt || '', label: item.label || '', media_id: item.media_id || '' };
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
    // Hiện dialog chọn nhóm trước khi lưu
    const cats = libraryCategories.length ? libraryCategories : (await API.get('/api/image/library/categories').then(r => r.items || []).catch(() => []));
    const opts = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const modalId = 'studio-save-lib-modal';
    let modal = $(modalId);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = modalId;
      modal.className = 'studio-popup-overlay';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border-radius:14px;padding:22px;min-width:300px;max-width:90vw;">
        <div style="font-weight:600;margin-bottom:14px;">Chọn nhóm lưu ảnh</div>
        <select id="studio-save-lib-cat" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:14px;">${opts}</select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${modalId}').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" id="studio-save-lib-confirm">Lưu</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    $('studio-save-lib-confirm').onclick = async () => {
      const categoryId = $('studio-save-lib-cat').value || 'default';
      modal.style.display = 'none';
      const res = await API.post('/api/image/studio/save', { url: popup.url, prompt: popup.prompt || '', category_id: categoryId, media_id: popup.media_id || '' });
      if (res.ok) { toast('Đã lưu vào kho', 'success'); loadLibrary(); }
      else toast(res.detail || 'Lưu thất bại', 'error');
    };
  }

  function downloadImg() {
    if (!popup) return;
    const ext = (popup.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    downloadUrl(popup.url, `studio_img_${Date.now()}.${ext}`);
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
    card.refs.unshift({ url: popup.url, file, label: 'Ảnh chèn từ preview', media_id: popup.media_id || '' });
    card.refIndex = 0;
    renderCard(card, false);
    closePopup();
    toast('Đã thêm ảnh vào cụm làm ảnh tham chiếu', 'success');
  }

  function importImages(files) {
    const list = Array.from(files || []).filter(file => String(file.type || '').startsWith('image/'));
    if (!list.length) return toast('Không có ảnh hợp lệ', 'error');
    list.forEach(file => {
      const card = createCard('');
      card.refs.push({ url: URL.createObjectURL(file), file, label: file.name || 'Ảnh import' });
      renderCard(card, false);
    });
    updateStats();
    toast('Đã nạp ' + list.length + ' ảnh vào Studio', 'success');
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
    if (!pending.length) return toast('Không có card nào sẵn sàng tạo hình', 'error');
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
      ? `Tạo ảnh ${pending.length} card với ${n} tài khoản (tối đa ${maxConcurrentImage} ảnh/tài khoản)`
      : `Bắt đầu tạo ảnh ${pending.length} card (tối đa ${maxConcurrentImage} cùng lúc)`, 'info');

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
    if (!pending.length) return toast('Không có card nào chờ tạo video', 'error');
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
      ? `Chạy ${pending.length} card với ${n} tài khoản (tối đa ${maxConcurrent} job/tài khoản)`
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
    toast('Đã xóa tất cả card trong Studio', 'success');
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
      if (_cardLayout === 'horizontal') {
        cardsEl.classList.add('layout-horizontal');
        btn.querySelector('svg').innerHTML = '<rect x="3" y="3" width="18" height="8" rx="1"/><rect x="3" y="13" width="18" height="8" rx="1"/>';
        btn.childNodes[btn.childNodes.length - 1].textContent = ' Card dọc';
      } else {
        cardsEl.classList.remove('layout-horizontal');
        btn.querySelector('svg').innerHTML = '<rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/>';
        btn.childNodes[btn.childNodes.length - 1].textContent = ' Card ngang';
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
    // Save quality dropdown logic
    let _saveQuality = '1080'; // '1080' | '720'
    const _qualityMenu = $('studio-save-quality-menu');
    const _qualityToggle = $('studio-save-quality-toggle');

    function _updateQualityLabel() {
      if (_qualityToggle) _qualityToggle.textContent = _saveQuality === '1080' ? '1080p ▾' : '720p ▾';
      // Update checkmark icons
      document.querySelectorAll('.studio-quality-opt').forEach(opt => {
        const check = opt.querySelector('svg');
        if (check) check.style.opacity = opt.dataset.q === _saveQuality ? '1' : '0';
      });
    }

    _qualityToggle?.addEventListener('click', e => {
      e.stopPropagation();
      if (!_qualityMenu) return;
      const isHidden = _qualityMenu.style.display === 'none' || !_qualityMenu.style.display;
      if (isHidden) {
        // Tính vị trí fixed dựa theo nút toggle để thoát khỏi overflow:hidden của toolbar
        const rect = _qualityToggle.getBoundingClientRect();
        _qualityMenu.style.top = (rect.bottom + 4) + 'px';
        _qualityMenu.style.right = (window.innerWidth - rect.right) + 'px';
        _qualityMenu.style.left = 'auto';
        _qualityMenu.style.display = '';
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
    $('studio-auto-download').addEventListener('change', e => { cfg.autoDownload = e.target.checked; });
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
    loadLibrarySources().catch(() => { });
    initVaultListeners();
    updateStats();
  };

  // ── Save Images Popup ────────────────────────────────────────
  let _saveImgSelected = new Set(); // key = "cardId:imgIndex"

  function openSaveImagesPopup() {
    const allImages = [];
    cards.forEach(card => {
      card.images.forEach((img, i) => {
        allImages.push({ key: `${card.id}:${i}`, cardId: card.id, imgIdx: i, url: img.url, cardTitle: `Cụm ${cards.indexOf(card) + 1}`, prompt: card.prompt || '', media_id: img.media_id || '' });
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

    const _toDiskBtn = $('studio-save-images-to-disk');
    if (_toDiskBtn) _toDiskBtn.onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      for (const item of selected) {
        const ext = (item.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
        downloadUrl(item.url, `studio_img_${item.cardTitle.replace(/\s/g, '_')}_${Date.now()}.${ext}`);
        await new Promise(r => setTimeout(r, 200));
      }
      toast(`Đã tải ${selected.length} ảnh về máy`, 'success');
    };

    $('studio-save-images-to-lib').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      const cats = libraryCategories.length ? libraryCategories : (await API.get('/api/image/library/categories').then(r => r.items || []).catch(() => []));
      const opts = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      const dlgId = 'studio-save-images-cat-dlg';
      let dlg = $(dlgId);
      if (!dlg) { dlg = document.createElement('div'); dlg.id = dlgId; dlg.className = 'studio-popup-overlay'; document.body.appendChild(dlg); }
      dlg.innerHTML = `<div style="background:var(--bg2);border-radius:14px;padding:22px;min-width:280px;">
        <div style="font-weight:600;margin-bottom:12px;">Chọn nhóm lưu (${selected.length} ảnh)</div>
        <select id="studio-simg-cat-sel" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:14px;">${opts}</select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${dlgId}').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" id="studio-simg-cat-confirm">Lưu</button>
        </div></div>`;
      dlg.style.display = 'flex';
      dlg.onclick = e => { if (e.target === dlg) dlg.style.display = 'none'; };
      $('studio-simg-cat-confirm').onclick = async () => {
        const catId = $('studio-simg-cat-sel').value || 'default';
        dlg.style.display = 'none';
        // Gửi song song để tránh URL Google expire trước khi gọi đến
        const results = await Promise.all(
          selected.map(item => API.post('/api/image/studio/save', { url: item.url, prompt: item.prompt, category_id: catId }).catch(() => ({ ok: false })))
        );
        const ok = results.filter(r => r.ok).length;
        toast(`Đã lưu ${ok}/${selected.length} ảnh vào kho`, ok === selected.length ? 'success' : 'info');
        loadLibrarySources().catch(() => { });
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

  function downloadVideoPopup() {
    if (!_videoPopup) return;
    const card = cards.find(c => c.id === _videoPopup.cardId);
    const cardIdx = card ? String(cards.indexOf(card) + 1).padStart(3, '0') : '000';
    saveVideo(_videoPopup.url, `studio_${cardIdx}_video_${_videoPopup.idx + 1}.mp4`);
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
    _vaultCategories = catsRes.items || [];
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
  };
})();
