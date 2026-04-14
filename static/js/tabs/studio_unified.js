/* Unified Studio override */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const cfg = { aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE', model: 'auto', imageModel: 'Nano Banana 2', imageCount: 1, videoCount: 1, autoUpscale: false, autoDownload: false, saveHandle: null, saveFolder: '' };
  let ready = false;
  let stopAll = false;
  let seq = 0;
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
      const prompt = String(item.prompt || item.description || '').trim();
      if (!prompt) return null;
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

  function routeLabel(card) {
    if (card.chars.length) return 'Đồng nhất nhân vật';
    if (card.refs.length) return 'Ảnh → Video';
    return 'Text → Video';
  }

  function updateStats() {
    const pending = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running' || c.busyImage).length;
    const done = cards.filter(c => c.outputs.length).length;
    $('studio-pending-count').textContent = pending;
    $('studio-saved-count').textContent = done;
    $('studio-metric-total').textContent = cards.length + ' card';
    $('studio-metric-running').textContent = running + ' đang chạy';
    $('studio-metric-done').textContent = done + ' xong';
    $('studio-status-text').textContent = cards.length ? ('Studio đang theo dõi ' + cards.length + ' cụm thao tác.') : 'Chưa có batch đang theo dõi. Bấm import prompt hoặc thêm cụm để bắt đầu.';
    $('studio-empty').style.display = cards.length ? 'none' : '';
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        cfg.saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        cfg.saveFolder = cfg.saveHandle.name;
        $('studio-folder-label').textContent = cfg.saveFolder;
        return;
      } catch (_) {}
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
      } catch (_) {}
    }
    downloadUrl(url, filename);
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
    const options = [{ id: 'all', name: 'T?t c?' }, { id: '__characters__', name: 'Nh?n v?t' }, ...libraryCategories];
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

  function renderLibraryPicker() {
    const grid = $('studio-library-grid');
    const filter = $('studio-library-category-filter')?.value || 'all';
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
      if (!card.refs.some(x => x.url === asset.url)) card.refs.unshift({ url: asset.url, file: null, label: asset.name || 'Ảnh từ kho' });
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
      const img = card.images[0]?.url || '';
      if (card.status === 'running') return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo video...</div></div>';
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${card.error || 'Tạo video thất bại'}</div>`;
      if (url) return `<video controls src="${url}" preload="metadata"></video>`;
      return '<span>Chưa có preview video</span>';
    })();

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Cụm ${idx}</span>
        <span class="studio-note">${routeLabel(card)}</span>
        <div class="studio-toolbar-spacer"></div>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" onclick="Studio.toggleInsertMenu('${card.id}')">+ Card ▾</button>
          <div class="card-insert-menu" id="studio-insert-menu-${card.id}" style="display:none;">
            <div onclick="Studio.insertCard('${card.id}','before')">Thêm trước</div>
            <div onclick="Studio.insertCard('${card.id}','after')">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="Studio.cloneCard('${card.id}')">⧉</button>
        <button class="btn btn-secondary btn-sm" onclick="Studio.deleteCard('${card.id}')">🗑</button>
      </div>
      <div class="studio-card-body">
        <div class="form-group">
          <label class="form-label">Text Prompt</label>
          <textarea class="t2v-prompt-input studio-prompt-input" rows="7" placeholder="Nhập prompt cho cụm này...">${card.prompt || ''}</textarea>
        </div>
        <div class="studio-inline-tools">
          <button class="btn btn-secondary btn-sm studio-open-library">Kho lưu trữ</button>
          <button class="btn btn-secondary btn-sm studio-auto-char">AUTO Nhân Vật</button>
          <button class="btn btn-secondary btn-sm studio-add-ref">+ Thêm từ máy</button>
          <button class="btn btn-secondary btn-sm studio-clear-ref">Xóa ảnh tham chiếu</button>
          <input type="file" class="studio-ref-input" accept="image/*" multiple style="display:none;">
        </div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>Ảnh tham chiếu</span><span>${combinedRefs(card).length ? ('Đã chọn ' + combinedRefs(card).length) : 'Chưa có ảnh'}</span></div>
          <div class="studio-strip">
            ${renderCombinedRefThumbs(card)}
            <button type="button" class="studio-add-thumb studio-open-library">Kho</button>
            <button type="button" class="studio-add-thumb studio-add-ref">+</button>
          </div>
        </div>
        <div class="studio-card-actions">
          <button class="btn btn-primary studio-generate-image" ${card.busyImage ? 'disabled' : ''}>${card.busyImage ? 'Đang tạo hình...' : 'Tạo hình'}</button>
          <button class="btn btn-primary studio-generate-video" ${card.busyVideo ? 'disabled' : ''}>${card.busyVideo ? 'Đang tạo video...' : 'Tạo video'}</button>
        </div>
        <div class="studio-preview-panel">${preview}</div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>Hình ảnh đã tạo (${card.images.length})</span><span class="studio-note">Ấn vào ảnh để xem lớn và chèn vào cụm</span></div>
          <div class="studio-strip">
            ${card.images.length ? card.images.map((img, i) => `<div class="studio-thumb"><img src="${img.url}" alt="img-${i}" onclick="Studio.openPopup('${card.id}','generated',${i})"></div>`).join('') : '<div class="studio-note">Chưa có ảnh tạo trong cụm này.</div>'}
          </div>
        </div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>Video đã tạo (${card.outputs.length})</span><span class="studio-note">${card.outputs.length ? 'Chọn thumbnail để đổi preview' : 'Chưa có video nào'}</span></div>
          <div class="studio-strip">
            ${card.outputs.length ? card.outputs.map((out, i) => {
              const url = out.video_url || out.videoUri || out.fifeUrl || '';
              return `<div class="studio-video-thumb ${i === card.outputIndex ? 'active' : ''}" onclick="Studio.selectOutput('${card.id}',${i})">${url ? `<video src="${url}" muted preload="metadata"></video>` : '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--text3);font-size:10px;">Video</div>'}</div>`;
            }).join('') : '<div class="studio-note">Chưa có video nào được tạo.</div>'}
          </div>
        </div>
      </div>
    `;

    if (append) $('studio-cards').appendChild(el);
    el.querySelector('.studio-prompt-input').addEventListener('input', e => { card.prompt = e.target.value; updateStats(); });
    el.querySelectorAll('.studio-open-library').forEach(btn => btn.addEventListener('click', () => openLibraryPicker(card.id)));
    el.querySelector('.studio-auto-char').addEventListener('click', () => autoCharacters(card.id));
    el.querySelectorAll('.studio-add-ref').forEach(btn => btn.addEventListener('click', () => el.querySelector('.studio-ref-input').click()));
    el.querySelector('.studio-clear-ref').addEventListener('click', () => { card.refs = []; card.refIndex = 0; renderCard(card, false); updateStats(); });
    el.querySelector('.studio-generate-image').addEventListener('click', () => genImages(card.id));
    el.querySelector('.studio-generate-video').addEventListener('click', () => genVideo(card.id));
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
    toast(card.chars.length ? ('?? t? g?n ' + card.chars.length + ' nh?n v?t') : 'Kh?ng nh?n ra nh?n v?t n?o trong prompt', card.chars.length ? 'success' : 'info');
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

  async function genImages(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (!String(card.prompt || '').trim()) return toast('Nh?p prompt tr??c khi t?o h?nh', 'error');
    card.busyImage = true;
    renderCard(card, false);
    try {
      const fd = new FormData();
      fd.append('prompt', card.prompt);
      fd.append('aspect_ratio', cfg.aspect === 'VIDEO_ASPECT_RATIO_PORTRAIT' ? 'IMAGE_ASPECT_RATIO_PORTRAIT' : cfg.aspect === 'VIDEO_ASPECT_RATIO_SQUARE' ? 'IMAGE_ASPECT_RATIO_SQUARE' : 'IMAGE_ASPECT_RATIO_LANDSCAPE');
      fd.append('output_count', String(cfg.imageCount));
      fd.append('model', cfg.imageModel);
      fd.append('character_ids_json', JSON.stringify(card.chars.map(ch => ch.id)));
      for (let i = 0; i < card.refs.length; i++) {
        const ref = card.refs[i];
        let file = ref.file;
        if (!file && ref.url) file = await urlToFile(ref.url, `${card.id}_ref_${i + 1}.png`);
        if (file) fd.append('reference_images', file, file.name || `${card.id}_ref_${i + 1}.png`);
      }
      const res = await API.postForm('/api/image/generate-studio', fd);
      if (!res.ok) throw new Error(res.detail || 'T?o h?nh th?t b?i');
      (res.images || []).forEach(img => {
        const url = img.url || img.downloadUrl || img.image_url || img.imageUrl || '';
        if (url) card.images.unshift({ url, media_id: img.media_id || img.mediaId || '', prompt: card.prompt, label: '?nh ?? t?o' });
      });
      renderCard(card, false);
      toast('?? t?o ' + (res.images || []).length + ' ?nh cho card', 'success');
    } catch (err) {
      toast('L?i t?o h?nh: ' + err.message, 'error');
    } finally {
      card.busyImage = false;
      renderCard(card, false);
    }
  }

  async function createVideo(card) {
    const fd = new FormData();
    fd.append('prompt', card.prompt || '');
    fd.append('aspect_ratio', cfg.aspect);
    fd.append('output_count', String(cfg.videoCount));
    fd.append('model', cfg.model);
    fd.append('character_ids_json', JSON.stringify(card.chars.map(ch => ch.id)));
    for (let i = 0; i < card.refs.length; i++) {
      const ref = card.refs[i];
      let file = ref.file;
      if (!file && ref.url) file = await urlToFile(ref.url, `${card.id}_video_ref_${i + 1}.png`);
      if (file) fd.append('reference_images', file, file.name || `${card.id}_video_ref_${i + 1}.png`);
    }
    const res = await API.postForm('/api/veo/studio-video', fd);
    return { ok: res.ok, jobId: res.job_id || '', error: res.detail || res.message || '' };
  }

  async function genVideo(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (!String(card.prompt || '').trim()) return toast('Nhập prompt trước khi tạo video', 'error');
    card.status = 'running';
    card.busyVideo = true;
    card.outputs = [];
    card.outputIndex = 0;
    card.error = '';
    renderCard(card, false);
    try {
      const req = await createVideo(card);
      if (!req.ok || !req.jobId) throw new Error(req.error || 'Tạo video thất bại');
      card.jobId = req.jobId;
      pollJob(req.jobId, '/api/veo/job', async job => {
        if (stopAll) return;
        if (job.status === 'completed' || job.status === 'done') {
          card.outputs = Array.isArray(job.outputs) ? job.outputs.filter(Boolean) : [];
          card.status = card.outputs.length ? 'completed' : 'failed';
          card.busyVideo = false;
          card.error = card.outputs.length ? '' : 'Không có video trả về';
          renderCard(card, false);
          if (cfg.autoUpscale && card.outputs.length) await upscaleCard(card.id, 0);
          if (cfg.autoDownload && card.outputs.length) await saveOutputs(card.id);
        } else if (job.status === 'failed') {
          card.status = 'failed';
          card.busyVideo = false;
          card.error = job.error || 'Tạo video thất bại';
          renderCard(card, false);
        }
      });
    } catch (err) {
      card.status = 'failed';
      card.busyVideo = false;
      card.error = err.message;
      renderCard(card, false);
    }
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

  async function upscaleCard(cardId, outputIndex) {
    const card = cards.find(c => c.id === cardId);
    if (!card || card.upscaling) return;
    const out = card.outputs[outputIndex];
    if (!out) return;
    card.upscaling = true;
    renderCard(card, false);
    try {
      const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: outputIndex });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[outputIndex] = { ...card.outputs[outputIndex], ...res.outputs[0] };
        toast('Upscale 1080p thành công', 'success');
      } else {
        toast(res.body || res.message || 'Upscale thất bại', 'error');
      }
    } catch (err) {
      toast('Lỗi upscale: ' + err.message, 'error');
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
    popup = { cardId, type, idx, url: item.url, prompt: card.prompt || '', label: item.label || '' };
    $('studio-popup-img').src = item.url;
    $('studio-popup-caption-text').textContent = (item.label || '') + (card.prompt ? ' · ' + card.prompt.slice(0, 120) : '');
    $('studio-img-popup').style.display = 'flex';
  }

  function closePopup() {
    $('studio-img-popup').style.display = 'none';
    popup = null;
  }

  async function saveToLib() {
    if (!popup) return;
    const categoryId = $('studio-save-category')?.value || 'default';
    const res = await API.post('/api/image/studio/save', { url: popup.url, prompt: popup.prompt || '', category_id: categoryId });
    if (res.ok) toast('Đã lưu vào kho', 'success');
    else toast(res.detail || 'Lưu thất bại', 'error');
  }

  function downloadImg() {
    if (!popup) return;
    const ext = (popup.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    downloadUrl(popup.url, `studio_img_${Date.now()}.${ext}`);
  }

  async function addToCard() {
    if (!popup) return;
    const card = cards.find(c => c.id === popup.cardId) || createCard(popup.prompt || '');
    let file = null;
    try { file = await urlToFile(popup.url, `studio_ref_${Date.now()}.png`); } catch (_) {}
    card.refs.unshift({ url: popup.url, file, label: 'Ảnh chèn từ preview' });
    card.refIndex = 0;
    renderCard(card, false);
    closePopup();
    toast('Đã thêm ảnh vào card làm ảnh tham chiếu', 'success');
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

  function importPrompts(file, mode = 'txt') {
    const reader = new FileReader();
    reader.onload = e => {
      const raw = e.target.result;
      const promptItems = mode === 'json' ? parseJsonPromptCards(raw) : parsePrompts(raw).map(prompt => ({ prompt }));
      if (!promptItems.length) return toast('File prompt tr?ng ho?c kh?ng ??ng ??nh d?ng', 'error');
      promptItems.forEach(item => createCard(item.prompt, item));
      updateStats();
      toast('?? import ' + promptItems.length + ' c?m prompt', 'success');
    };
    reader.readAsText(file, 'utf-8');
  }

  async function genAllImages() {
    const pending = cards.filter(c => !c.busyImage && String(c.prompt || '').trim());
    if (!pending.length) return toast('Kh?ng c? card n?o s?n s?ng t?o h?nh', 'error');
    stopAll = false;
    $('studio-gen-all-images').style.display = 'none';
    $('studio-stop-all').style.display = '';
    $('studio-stop-all').textContent = 'D?ng to?n b?';
    for (let i = 0; i < pending.length; i += 3) {
      if (stopAll) break;
      const batch = pending.slice(i, i + 3);
      await Promise.all(batch.map(card => genImages(card.id)));
    }
    $('studio-gen-all-images').style.display = '';
    $('studio-stop-all').style.display = 'none';
    $('studio-stop-all').textContent = '?ang d?ng...';
    stopAll = false;
  }

  async function genAllVideos() {
    const pending = cards.filter(c => c.status === 'idle');
    if (!pending.length) return toast('Không có card nào chờ tạo video', 'error');
    stopAll = false;
    $('studio-gen-all-videos').style.display = 'none';
    $('studio-stop-all').style.display = '';
    for (const card of pending) {
      if (stopAll) break;
      await genVideo(card.id);
    }
    $('studio-gen-all-videos').style.display = '';
    $('studio-stop-all').style.display = 'none';
    $('studio-stop-all').textContent = 'Dừng toàn bộ';
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
    $('studio-add-card').addEventListener('click', () => createCard(''));
    $('studio-open-library-manager')?.addEventListener('click', () => {
      if (typeof window.switchTab === 'function') window.switchTab('character');
    });
    $('studio-import-images').addEventListener('click', () => $('studio-images-file').click());
    $('studio-images-file').addEventListener('change', e => { if (e.target.files?.length) importImages(e.target.files); e.target.value = ''; });
    $('studio-import-prompts').addEventListener('click', () => { $('studio-import-popup').style.display = 'flex'; });
    $('studio-import-text-btn').addEventListener('click', () => { $('studio-import-popup').style.display = 'none'; $('studio-prompts-file-txt').click(); });
    $('studio-import-json-btn').addEventListener('click', () => { $('studio-import-popup').style.display = 'none'; $('studio-prompts-file-json').click(); });
    $('studio-prompts-file-txt').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) importPrompts(file, 'txt'); e.target.value = ''; });
    $('studio-prompts-file-json').addEventListener('change', e => { const file = e.target.files?.[0]; if (file) importPrompts(file, 'json'); e.target.value = ''; });
    $('studio-choose-folder').addEventListener('click', chooseFolder);
    $('studio-gen-all-images').addEventListener('click', genAllImages);
    $('studio-gen-all-videos').addEventListener('click', genAllVideos);
    $('studio-stop-all').addEventListener('click', () => { stopAll = true; $('studio-stop-all').textContent = 'Đang dừng...'; });
    $('studio-clear-all').addEventListener('click', clearAll);
    $('studio-save-all').addEventListener('click', async () => {
      for (const card of cards.filter(c => c.outputs.length)) await saveOutputs(card.id);
    });
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
    $('studio-library-category-filter').addEventListener('change', renderLibraryPicker);
    loadLibrarySources().catch(() => {});
    updateStats();
  };

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
    saveCardOutputs: saveOutputs,
    closeLibraryPicker,
    pickLibraryItem,
  };
})();
