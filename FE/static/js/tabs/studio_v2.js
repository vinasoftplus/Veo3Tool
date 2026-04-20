/* Studio workspace: image generation + unified video cards */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const IMAGE_CFG = {
    aspect: 'IMAGE_ASPECT_RATIO_SQUARE',
    count: 1,
    chars: [],
  };

  const VIDEO_CFG = {
    aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    model: 'auto',
    count: 1,
    autoUpscale: false,
    autoDownload: false,
    saveFolder: '',
    _saveHandle: null,
  };

  let _gallery = [];
  let _popup = null;
  let _statusFilter = 'all';
  let _initialized = false;
  let _charPickerTarget = { type: 'generator' };
  let _videoCards = [];
  let _videoSeq = 0;
  let _videoStop = false;

  function newStudioCard(mode = 'i2v', prompt = '') {
    return {
      id: 'studio-card-' + (++_videoSeq),
      mode,
      prompt,
      file: null,
      previewUrl: '',
      sourceLabel: '',
      chars: [],
      status: 'idle',
      jobId: null,
      outputs: [],
      currentIdx: 0,
      upscaling: false,
      error: '',
    };
  }

  function parsePromptFileText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    if (/^SCENE\s+\d+[:\s]/im.test(trimmed)) {
      const scenes = [];
      let current = [];
      trimmed.split(/\r?\n/).forEach(line => {
        if (/^SCENE\s+\d+[:\s]/i.test(line) && current.length) {
          scenes.push(current.join('\n').trim());
          current = [line];
        } else {
          current.push(line);
        }
      });
      if (current.join('').trim()) scenes.push(current.join('\n').trim());
      return scenes.filter(Boolean);
    }
    return trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }

  async function chooseVideoFolder() {
    if (window.showDirectoryPicker) {
      try {
        VIDEO_CFG._saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        VIDEO_CFG.saveFolder = VIDEO_CFG._saveHandle.name;
        $('studio-video-folder-label').textContent = VIDEO_CFG.saveFolder;
        return;
      } catch (_) {
        return;
      }
    }
    const path = prompt('Nhập đường dẫn folder lưu video:', VIDEO_CFG.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      VIDEO_CFG.saveFolder = path;
      $('studio-video-folder-label').textContent = path;
    }
  }

  async function downloadVideoFile(url, filename) {
    if (VIDEO_CFG._saveHandle) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const fileHandle = await VIDEO_CFG._saveHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('Đã lưu ' + filename, 'success');
        return;
      } catch (_) {}
    }
    downloadUrl(url, filename);
  }

  function switchStudioTab(name) {
    document.querySelectorAll('.studio-subtab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.studioTab === name);
    });
    $('studio-panel-gen-image').style.display = name === 'gen-image' ? '' : 'none';
    $('studio-panel-tracker').style.display = name === 'tracker' ? '' : 'none';
    if (name === 'tracker') refreshJobs();
  }

  async function generateImages() {
    const promptText = ($('studio-prompt')?.value || '').trim();
    if (!promptText) {
      toast('Nhập prompt trước', 'error');
      return;
    }

    const btn = $('studio-gen-btn');
    const statusEl = $('studio-gen-status');
    btn.disabled = true;
    if (statusEl) statusEl.style.display = 'flex';

    try {
      const payload = {
        prompt: promptText,
        aspect_ratio: IMAGE_CFG.aspect,
        output_count: IMAGE_CFG.count,
        model: 'Imagen 4',
      };
      if (IMAGE_CFG.chars.length) payload.character_ids = IMAGE_CFG.chars.map(ch => ch.id);

      const res = await API.post('/api/image/generate', payload);
      if (!res.ok) {
        toast(res.detail || 'Lỗi tạo ảnh', 'error');
        return;
      }

      const images = res.images || [];
      if (!images.length) {
        toast('Không có ảnh nào được tạo', 'error');
        return;
      }

      images.forEach(img => {
        const url = img.url || img.image_url || img.imageUrl || '';
        if (url) {
          _gallery.unshift({
            url,
            media_id: img.media_id || '',
            prompt: promptText,
          });
        }
      });

      renderGallery();
      toast('Đã tạo ' + images.length + ' ảnh', 'success');
    } catch (err) {
      toast('Lỗi: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      if (statusEl) statusEl.style.display = 'none';
    }
  }

  function renderGallery() {
    const el = $('studio-gallery');
    if (!el) return;
    if (!_gallery.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;text-align:center;padding:32px;">Chưa có ảnh. Tạo ảnh để đưa vào Studio.</div>';
      return;
    }
    el.innerHTML = _gallery.map((img, idx) => `
      <div class="studio-img-card" onclick="Studio.openPopup(${idx})" title="${(img.prompt || '').slice(0, 60)}">
        <img src="${img.url}" alt="studio-img-${idx}" loading="lazy">
        <div class="studio-img-status">${(img.prompt || '').slice(0, 34) || ('Ảnh ' + (idx + 1))}</div>
      </div>
    `).join('');
  }

  function openPopup(idx) {
    const img = _gallery[idx];
    if (!img) return;
    _popup = { ...img, idx };
    $('studio-popup-img').src = img.url;
    $('studio-img-popup').style.display = 'flex';
  }

  function closePopup() {
    $('studio-img-popup').style.display = 'none';
    _popup = null;
  }

  async function saveToLib() {
    if (!_popup) return;
    const res = await API.post('/api/image/studio/save', { url: _popup.url, prompt: _popup.prompt });
    if (res.ok) toast('Đã lưu vào kho', 'success');
    else toast(res.detail || 'Lưu thất bại', 'error');
  }

  function downloadImg() {
    if (!_popup) return;
    const ext = (_popup.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    downloadUrl(_popup.url, `studio_img_${Date.now()}.${ext}`);
    toast('Đang tải ảnh...', 'info');
  }

  function clearGallery() {
    _gallery = [];
    renderGallery();
  }

  function ensureAtLeastOneStudioCard() {
    if (_videoCards.length) return _videoCards[0];
    const card = newStudioCard('i2v', _popup?.prompt || '');
    _videoCards.push(card);
    renderStudioCard(card, true);
    refreshStudioVideoStats();
    return card;
  }

  function addImageToCard(cardId, imageUrl, promptText = '') {
    const card = _videoCards.find(item => item.id === cardId) || ensureAtLeastOneStudioCard();
    if (!card) return;
    card.mode = 'i2v';
    card.file = null;
    card.previewUrl = imageUrl;
    card.sourceLabel = 'Ảnh từ Studio';
    if (!card.prompt) card.prompt = promptText || '';
    renderStudioCard(card, false);
  }

  function addToCard() {
    if (!_popup) return;
    let modal = $('studio-card-pick-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-card-pick-modal';
      modal.className = 'studio-popup-overlay';
      modal.innerHTML = '<div class="studio-popup" style="max-width:420px;padding:18px;"></div>';
      document.body.appendChild(modal);
    }
    const body = modal.firstElementChild;
    const cardsMarkup = _videoCards.map((card, idx) => `
      <div onclick="Studio.pickStudioCard('${card.id}')" style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;margin-bottom:8px;background:var(--bg3);">
        <div style="font-size:11px;color:var(--text3);">Card #${idx + 1} · ${card.mode === 'consistent' ? 'Video đồng nhất' : 'Ảnh → Video'}</div>
        <div style="font-size:12px;color:var(--text);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(card.prompt || '(trống)').slice(0, 64)}</div>
      </div>
    `).join('');
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <strong>Gắn ảnh vào card Studio</strong>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('studio-card-pick-modal').style.display='none'">Đóng</button>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:12px;" onclick="Studio.createCardFromPopup()">Tạo card mới từ ảnh này</button>
      ${cardsMarkup || '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Chưa có card nào. Bấm nút ở trên để tạo card mới.</div>'}
    `;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
  }

  function createCardFromPopup() {
    if (!_popup) return;
    const card = newStudioCard('i2v', _popup.prompt || '');
    _videoCards.push(card);
    renderStudioCard(card, true);
    addImageToCard(card.id, _popup.url, _popup.prompt || '');
    $('studio-card-pick-modal').style.display = 'none';
    closePopup();
    toast('Đã tạo card mới từ ảnh Studio', 'success');
  }

  function pickStudioCard(cardId) {
    if (!_popup) return;
    addImageToCard(cardId, _popup.url, _popup.prompt || '');
    $('studio-card-pick-modal').style.display = 'none';
    closePopup();
    toast('Đã gắn ảnh vào card Studio', 'success');
  }

  function renderGeneratorCharStrip() {
    const strip = $('studio-char-strip');
    if (!strip) return;
    strip.innerHTML = IMAGE_CFG.chars.map((ch, idx) => `
      <div class="t2v-char-thumb" title="${ch.name}">
        <img src="${ch.url}" alt="${ch.name}">
        <span>${ch.name}</span>
        <button onclick="Studio.removeGeneratorChar(${idx})" style="position:absolute;top:-4px;right:-4px;background:var(--red);border:none;border-radius:50%;width:14px;height:14px;color:#fff;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">×</button>
      </div>
    `).join('') + `<div class="t2v-char-add" onclick="Studio.openCharPicker()" title="Thêm nhân vật">+</div>`;
  }

  async function openCharPicker(cardId = null) {
    _charPickerTarget = cardId ? { type: 'card', cardId } : { type: 'generator' };
    let modal = $('studio-char-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-char-picker-modal';
      modal.className = 'studio-popup-overlay';
      modal.innerHTML = '<div class="studio-popup" style="max-width:520px;padding:18px;"></div>';
      document.body.appendChild(modal);
    }
    const body = modal.firstElementChild;
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <strong>Chọn nhân vật</strong>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('studio-char-picker-modal').style.display='none'">Đóng</button>
      </div>
      <div id="studio-char-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:10px;">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    `;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

    const res = await API.get('/api/character/list');
    const chars = res.data || [];
    const selectedIds = new Set((_charPickerTarget.type === 'generator'
      ? IMAGE_CFG.chars
      : (_videoCards.find(card => card.id === _charPickerTarget.cardId)?.chars || [])
    ).map(ch => ch.id));

    $('studio-char-grid').innerHTML = chars.length ? chars.map(ch => `
      <button type="button" onclick="Studio.pickChar('${ch.id}','${String(ch.name).replace(/'/g, "\\'")}','${ch.url}','${ch.media_id || ''}')"
        style="border:2px solid ${selectedIds.has(ch.id) ? 'var(--accent)' : 'var(--border)'};background:var(--bg3);border-radius:10px;padding:8px;cursor:pointer;">
        <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;">
        <div style="font-size:11px;color:var(--text2);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ch.name}</div>
      </button>
    `).join('') : '<div style="grid-column:1/-1;color:var(--text3);font-size:12px;">Chưa có nhân vật trong thư viện.</div>';
  }

  function pickChar(id, name, url, mediaId) {
    const targetList = _charPickerTarget.type === 'generator'
      ? IMAGE_CFG.chars
      : (_videoCards.find(card => card.id === _charPickerTarget.cardId)?.chars || []);

    const existingIdx = targetList.findIndex(item => item.id === id);
    if (existingIdx >= 0) targetList.splice(existingIdx, 1);
    else {
      if (targetList.length >= 3) {
        toast('Tối đa 3 nhân vật', 'error');
        return;
      }
      targetList.push({ id, name, url, media_id: mediaId });
    }

    if (_charPickerTarget.type === 'generator') renderGeneratorCharStrip();
    else {
      const card = _videoCards.find(item => item.id === _charPickerTarget.cardId);
      if (card) renderStudioCard(card, false);
    }

    $('studio-char-picker-modal').style.display = 'none';
  }

  function removeGeneratorChar(idx) {
    IMAGE_CFG.chars.splice(idx, 1);
    renderGeneratorCharStrip();
  }

  function refreshStudioVideoStats() {
    $('studio-video-pending-count').textContent = _videoCards.filter(card => card.status === 'idle').length;
    $('studio-video-saved-count').textContent = _videoCards.filter(card => card.outputs.length > 0).length;
    $('studio-video-empty').style.display = _videoCards.length ? 'none' : '';
  }

  function renderStudioResult(card) {
    const out = card.outputs[card.currentIdx];
    const url = out?.video_url || out?.videoUri || out?.fifeUrl || '';
    if (card.status === 'idle') return '<div class="t2v-video-preview"><span style="opacity:.4;">Chưa tạo</span></div>';
    if (card.status === 'running') return '<div class="t2v-video-preview"><div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;width:28px;height:28px;border-width:3px;"></div><div class="pulse" style="font-size:11px;">Đang tạo video...</div></div></div>';
    if (card.status === 'failed') return `<div class="t2v-video-preview" style="color:var(--red);padding:12px;font-size:12px;">${card.error || 'Lỗi tạo video'}</div>`;
    if (!url) return '<div class="t2v-video-preview"><span style="opacity:.4;">Không có video</span></div>';
    const nav = card.outputs.length > 1
      ? `<div class="t2v-video-nav"><button class="btn btn-secondary btn-sm" onclick="Studio.prevOutput('${card.id}')">‹</button><span>${card.currentIdx + 1} / ${card.outputs.length}</span><button class="btn btn-secondary btn-sm" onclick="Studio.nextOutput('${card.id}')">›</button></div>`
      : '';
    return `<div class="t2v-video-preview"><video controls src="${url}" preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video></div>${nav}<div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="Studio.downloadCard('${card.id}',${card.currentIdx})">Tải về</button>${VIDEO_CFG.autoUpscale ? '' : `<button class="btn btn-secondary btn-sm" onclick="Studio.upscaleCard('${card.id}',${card.currentIdx})" ${card.upscaling ? 'disabled' : ''}>${card.upscaling ? 'Đang upscale...' : 'Upscale 1080p'}</button>`}<button class="btn btn-secondary btn-sm" onclick="Studio.genCard('${card.id}')">Tạo lại</button></div>`;
  }

  function renderStudioCard(card, append = false) {
    let el = $('card-' + card.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'card-' + card.id;
      el.className = 't2v-card';
    }
    const idx = _videoCards.indexOf(card) + 1;
    const charStrip = card.chars.length
      ? card.chars.map(ch => `<div class="t2v-char-thumb" title="${ch.name}"><img src="${ch.url}" alt="${ch.name}"><span>${ch.name}</span></div>`).join('')
      : '<div style="font-size:11px;color:var(--text3);">Chưa gắn nhân vật</div>';
    const previewBlock = card.previewUrl
      ? `<img src="${card.previewUrl}" alt="preview" style="display:block;">`
      : '<div>Chọn ảnh hoặc gắn ảnh từ gallery</div><img style="display:none;" alt="preview">';

    el.innerHTML = `
      <div class="t2v-card-header">
        <span class="t2v-card-num">#${idx}</span>
        <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(card.prompt || '').slice(0, 80) || '(trống)'}</span>
        <button class="btn btn-secondary btn-sm" onclick="Studio.genCard('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>Tạo Video</button>
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
      <div class="t2v-card-body">
        <div class="t2v-card-left">
          <div class="form-group">
            <label class="form-label">Chế độ</label>
            <select class="form-control studio-card-mode">
              <option value="i2v" ${card.mode === 'i2v' ? 'selected' : ''}>Ảnh → Video</option>
              <option value="consistent" ${card.mode === 'consistent' ? 'selected' : ''}>Video đồng nhất</option>
            </select>
          </div>
          <div class="form-group studio-image-block" style="display:${card.mode === 'i2v' ? '' : 'none'};">
            <label class="form-label">Ảnh đầu vào</label>
            <div class="upload-zone">
              <input type="file" accept="image/*">
              <div>${card.sourceLabel || 'Kéo thả hoặc click để chọn ảnh'}</div>
              ${previewBlock}
            </div>
          </div>
          <div class="form-group studio-char-block" style="display:${card.mode === 'consistent' ? '' : 'none'};">
            <label class="form-label">Nhân vật tham chiếu</label>
            <div class="t2v-char-strip">${charStrip}</div>
            <div style="margin-top:8px;display:flex;gap:8px;">
              <button class="btn btn-secondary btn-sm studio-apply-char">Áp dụng nhân vật</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Prompt</label>
            <textarea rows="5" placeholder="Nhập prompt video studio...">${card.prompt || ''}</textarea>
          </div>
        </div>
        <div class="t2v-card-right">${renderStudioResult(card)}</div>
      </div>
    `;

    if (append) $('studio-video-cards').appendChild(el);

    const ta = el.querySelector('textarea');
    ta.addEventListener('input', e => { card.prompt = e.target.value; refreshStudioVideoStats(); });

    const modeSelect = el.querySelector('.studio-card-mode');
    modeSelect.addEventListener('change', e => {
      card.mode = e.target.value;
      renderStudioCard(card, false);
    });

    const applyCharBtn = el.querySelector('.studio-apply-char');
    if (applyCharBtn) applyCharBtn.addEventListener('click', () => openCharPicker(card.id));

    bindStudioUpload(card, el);
    refreshStudioVideoStats();
    return el;
  }

  function bindStudioUpload(card, el) {
    const zone = el.querySelector('.upload-zone');
    if (!zone) return;
    const input = zone.querySelector('input[type="file"]');
    const preview = zone.querySelector('img');
    zone.addEventListener('click', e => {
      if (e.target === input) return;
      input.click();
    });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      card.file = file;
      card.previewUrl = URL.createObjectURL(file);
      card.sourceLabel = 'Ảnh cục bộ';
      if (preview) {
        preview.src = card.previewUrl;
        preview.style.display = 'block';
      }
      renderStudioCard(card, false);
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
  }

  async function imageUrlToFile(url, filename = 'studio-image.png') {
    const response = await fetch(url);
    const blob = await response.blob();
    return new File([blob], filename, { type: blob.type || 'image/png' });
  }

  async function genStudioCard(card) {
    card.status = 'running';
    card.outputs = [];
    card.currentIdx = 0;
    card.error = '';
    renderStudioCard(card, false);

    try {
      let res;
      if (card.mode === 'consistent') {
        if (!card.chars.length) throw new Error('Card chưa có nhân vật');
        res = await API.post('/api/veo/consistent-video', {
          prompt: card.prompt || '',
          character_ids: card.chars.map(ch => ch.id),
          aspect_ratio: VIDEO_CFG.aspect,
          output_count: VIDEO_CFG.count,
          model: VIDEO_CFG.model,
        });
      } else {
        const file = card.file || (card.previewUrl ? await imageUrlToFile(card.previewUrl, `${card.id}.png`) : null);
        if (!file) throw new Error('Card chưa có ảnh');
        const fd = new FormData();
        fd.append('image', file);
        fd.append('prompt', card.prompt || '');
        fd.append('aspect_ratio', VIDEO_CFG.aspect);
        fd.append('output_count', String(VIDEO_CFG.count));
        fd.append('model', VIDEO_CFG.model);
        res = await API.postForm('/api/veo/image-to-video', fd);
      }

      if (!res.ok) {
        card.status = 'failed';
        card.error = res.detail || res.message || 'Tạo video thất bại';
        renderStudioCard(card, false);
        return;
      }

      card.jobId = res.job_id;
      pollJob(res.job_id, '/api/veo/job', async job => {
        if (_videoStop) {
          card.status = 'idle';
          renderStudioCard(card, false);
          return;
        }
        if (job.status === 'completed' || job.status === 'done') {
          const outs = Array.isArray(job.outputs) ? job.outputs : (job.outputs?.videos || []);
          card.outputs = outs.filter(Boolean);
          card.status = card.outputs.length ? 'completed' : 'failed';
          card.error = card.outputs.length ? '' : 'Không có video';
          renderStudioCard(card, false);
          if (VIDEO_CFG.autoUpscale && card.outputs.length) await upscaleStudioCardByIdx(card, 0);
          if (VIDEO_CFG.autoDownload && card.outputs.length) await downloadStudioCardOutputs(card);
        } else if (job.status === 'failed') {
          card.status = 'failed';
          card.error = job.error || 'Thất bại';
          renderStudioCard(card, false);
        }
      });
    } catch (err) {
      card.status = 'failed';
      card.error = err.message;
      renderStudioCard(card, false);
    }
  }

  async function downloadStudioCardOutputs(card) {
    for (let idx = 0; idx < card.outputs.length; idx++) {
      const out = card.outputs[idx];
      const url = out.video_url || out.videoUri || out.fifeUrl;
      if (!url) continue;
      await downloadVideoFile(url, `studio_${String(_videoCards.indexOf(card) + 1).padStart(3, '0')}_${idx + 1}.mp4`);
    }
  }

  async function upscaleStudioCardByIdx(card, idx) {
    const out = card.outputs[idx];
    if (!out || card.upscaling) return;
    card.upscaling = true;
    renderStudioCard(card, false);
    try {
      const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', {
        operation_name: out.operation_name || '',
        output_index: idx,
      });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[idx] = { ...card.outputs[idx], ...res.outputs[0] };
        toast('Upscale 1080p thành công', 'success');
      } else {
        toast(res.body || res.message || 'Upscale thất bại', 'error');
      }
    } catch (err) {
      toast('Lỗi upscale: ' + err.message, 'error');
    } finally {
      card.upscaling = false;
      renderStudioCard(card, false);
    }
  }

  async function genAllStudioCards() {
    const pending = _videoCards.filter(card => card.status === 'idle');
    if (!pending.length) {
      toast('Không có card nào chờ tạo', 'error');
      return;
    }
    _videoStop = false;
    $('studio-video-gen-all').style.display = 'none';
    $('studio-video-stop').style.display = '';
    for (const card of pending) {
      if (_videoStop) break;
      await genStudioCard(card);
    }
    $('studio-video-gen-all').style.display = '';
    $('studio-video-stop').style.display = 'none';
    $('studio-video-stop').textContent = 'Dừng toàn bộ';
    _videoStop = false;
  }

  function clearAllStudioCards() {
    _videoCards = [];
    $('studio-video-cards').innerHTML = '';
    refreshStudioVideoStats();
    toast('Đã xóa toàn bộ card Studio', 'success');
  }

  function importStudioPromptFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const prompts = parsePromptFileText(e.target.result);
      if (!prompts.length) return toast('File trống', 'error');
      prompts.forEach(promptText => {
        const card = newStudioCard('consistent', promptText);
        _videoCards.push(card);
        renderStudioCard(card, true);
      });
      refreshStudioVideoStats();
      toast('Đã import ' + prompts.length + ' prompt vào Studio', 'success');
    };
    reader.readAsText(file, 'utf-8');
  }

  function importStudioImages(files) {
    const list = Array.from(files || []).filter(file => file && String(file.type || '').startsWith('image/'));
    if (!list.length) return toast('Không có ảnh hợp lệ', 'error');
    list.forEach(file => {
      const card = newStudioCard('i2v', '');
      card.file = file;
      card.previewUrl = URL.createObjectURL(file);
      card.sourceLabel = 'Ảnh cục bộ';
      _videoCards.push(card);
      renderStudioCard(card, true);
    });
    refreshStudioVideoStats();
    toast('Đã nạp ' + list.length + ' ảnh vào Studio', 'success');
  }

  function reRenderStudioCards() {
    $('studio-video-cards').innerHTML = '';
    _videoCards.forEach(card => renderStudioCard(card, true));
    refreshStudioVideoStats();
  }

  function refreshJobs() {
    Promise.all([
      API.get(`/api/veo/jobs?type=image&status=${_statusFilter === 'all' ? '' : _statusFilter}&limit=50`),
      API.get(`/api/veo/jobs?type=video&status=${_statusFilter === 'all' ? '' : _statusFilter}&limit=50`),
    ]).then(([imgRes, vidRes]) => {
      renderJobList('studio-img-jobs', imgRes.jobs || []);
      renderJobList('studio-video-jobs', vidRes.jobs || []);
    }).catch(err => toast('Lỗi tải jobs: ' + err.message, 'error'));
  }

  const STATUS_LABELS = {
    pending: 'Chờ',
    running: 'Đang chạy',
    processing: 'Đang xử lý',
    completed: 'Xong',
    done: 'Xong',
    failed: 'Lỗi',
    cancelled: 'Đã hủy',
  };

  const STATUS_COLORS = {
    pending: 'var(--text3)',
    running: 'var(--accent)',
    processing: 'var(--orange)',
    completed: 'var(--green)',
    done: 'var(--green)',
    failed: 'var(--red)',
    cancelled: 'var(--text3)',
  };

  function renderJobList(elId, jobs) {
    const el = $(elId);
    if (!el) return;
    if (!jobs.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:12px;text-align:center;">Không có jobs</div>';
      return;
    }
    el.innerHTML = jobs.map(job => {
      const thumb = job.outputs?.[0]?.video_url || job.outputs?.[0]?.image_url || '';
      const status = job.status || 'pending';
      const promptText = (job.prompt || job.id || '').slice(0, 50);
      return `
        <div class="studio-job-row">
          ${thumb ? `<img class="studio-job-thumb" src="${thumb}" alt="">` : `<div class="studio-job-thumb" style="display:flex;align-items:center;justify-content:center;"><span style="font-size:16px;opacity:.3;">•</span></div>`}
          <div class="studio-job-info">
            <div class="studio-job-prompt">${promptText || job.id}</div>
            <div class="studio-job-meta">${new Date(job.created_at || Date.now()).toLocaleTimeString('vi-VN')}</div>
          </div>
          <span style="font-size:10px;color:${STATUS_COLORS[status] || 'var(--text3)'};font-weight:500;flex-shrink:0;">${STATUS_LABELS[status] || status}</span>
        </div>
      `;
    }).join('');
  }

  window.init_studio = function () {
    if (_initialized) return;
    _initialized = true;

    document.querySelectorAll('.studio-subtab').forEach(tab => {
      tab.addEventListener('click', () => switchStudioTab(tab.dataset.studioTab));
    });

    $('studio-gen-btn')?.addEventListener('click', generateImages);
    $('studio-aspect')?.addEventListener('change', e => { IMAGE_CFG.aspect = e.target.value; });
    document.querySelectorAll('.studio-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-count-btn').forEach(item => item.classList.remove('active'));
        btn.classList.add('active');
        IMAGE_CFG.count = parseInt(btn.dataset.val, 10);
      });
    });

    document.querySelectorAll('#studio-status-bar .studio-status-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#studio-status-bar .studio-status-btn').forEach(item => item.classList.remove('active'));
        btn.classList.add('active');
        _statusFilter = btn.dataset.status;
        refreshJobs();
      });
    });

    document.querySelectorAll('.studio-video-aspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-video-aspect-btn').forEach(item => item.classList.remove('active'));
        btn.classList.add('active');
        VIDEO_CFG.aspect = btn.dataset.val;
      });
    });

    document.querySelectorAll('.studio-video-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-video-count-btn').forEach(item => item.classList.remove('active'));
        btn.classList.add('active');
        VIDEO_CFG.count = parseInt(btn.dataset.val, 10);
      });
    });

    $('studio-video-model')?.addEventListener('change', e => { VIDEO_CFG.model = e.target.value; });
    $('studio-video-auto-upscale')?.addEventListener('change', e => { VIDEO_CFG.autoUpscale = e.target.checked; });
    $('studio-video-auto-download')?.addEventListener('change', e => { VIDEO_CFG.autoDownload = e.target.checked; });
    $('studio-video-choose-folder')?.addEventListener('click', chooseVideoFolder);
    $('studio-video-add-card')?.addEventListener('click', () => {
      const card = newStudioCard('i2v', '');
      _videoCards.push(card);
      renderStudioCard(card, true);
      refreshStudioVideoStats();
    });
    $('studio-video-add-images')?.addEventListener('click', () => $('studio-video-images-file').click());
    $('studio-video-images-file')?.addEventListener('change', e => {
      if (e.target.files?.length) importStudioImages(e.target.files);
      e.target.value = '';
    });
    $('studio-video-import-prompt')?.addEventListener('click', () => $('studio-video-import-file').click());
    $('studio-video-import-file')?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) importStudioPromptFile(file);
      e.target.value = '';
    });
    $('studio-video-gen-all')?.addEventListener('click', genAllStudioCards);
    $('studio-video-stop')?.addEventListener('click', () => {
      _videoStop = true;
      $('studio-video-stop').textContent = 'Đang dừng...';
    });
    $('studio-video-save-all')?.addEventListener('click', async () => {
      for (const card of _videoCards.filter(item => item.outputs.length)) {
        await downloadStudioCardOutputs(card);
      }
    });
    $('studio-video-clear-all')?.addEventListener('click', clearAllStudioCards);

    document.addEventListener('click', e => {
      if (!e.target.closest('.card-action-group')) {
        document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
      }
    });

    $('studio-img-popup')?.addEventListener('click', e => {
      if (e.target === $('studio-img-popup')) closePopup();
    });

    renderGeneratorCharStrip();
    renderGallery();
    refreshStudioVideoStats();
  };

  window.Studio = {
    openPopup,
    closePopup,
    saveToLib,
    downloadImg,
    addToCard,
    createCardFromPopup,
    pickStudioCard,
    openCharPicker,
    pickChar,
    removeGeneratorChar,
    clearGallery,
    refreshJobs,
    genCard(id) {
      const card = _videoCards.find(item => item.id === id);
      if (card) genStudioCard(card);
    },
    deleteCard(id) {
      _videoCards = _videoCards.filter(card => card.id !== id);
      $('card-' + id)?.remove();
      refreshStudioVideoStats();
    },
    cloneCard(id) {
      const src = _videoCards.find(card => card.id === id);
      if (!src) return;
      const clone = newStudioCard(src.mode, src.prompt);
      clone.file = src.file || null;
      clone.previewUrl = src.previewUrl || '';
      clone.sourceLabel = src.sourceLabel || '';
      clone.chars = src.chars.map(ch => ({ ...ch }));
      _videoCards.splice(_videoCards.indexOf(src) + 1, 0, clone);
      reRenderStudioCards();
      toast('Đã nhân bản card', 'success');
    },
    toggleInsertMenu(cardId) {
      document.querySelectorAll('.card-insert-menu').forEach(menu => {
        if (menu.id !== `studio-insert-menu-${cardId}`) menu.style.display = 'none';
      });
      const menu = document.getElementById(`studio-insert-menu-${cardId}`);
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    },
    insertCard(refId, position) {
      document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
      const refIdx = _videoCards.findIndex(card => card.id === refId);
      if (refIdx === -1) return;
      const card = newStudioCard('i2v', '');
      _videoCards.splice(position === 'before' ? refIdx : refIdx + 1, 0, card);
      reRenderStudioCards();
    },
    prevOutput(id) {
      const card = _videoCards.find(item => item.id === id);
      if (card && card.currentIdx > 0) {
        card.currentIdx--;
        renderStudioCard(card, false);
      }
    },
    nextOutput(id) {
      const card = _videoCards.find(item => item.id === id);
      if (card && card.currentIdx < card.outputs.length - 1) {
        card.currentIdx++;
        renderStudioCard(card, false);
      }
    },
    async downloadCard(id, idx) {
      const card = _videoCards.find(item => item.id === id);
      if (!card) return;
      const out = card.outputs[idx];
      const url = out?.video_url || out?.videoUri || out?.fifeUrl;
      if (url) await downloadVideoFile(url, `studio_${String(_videoCards.indexOf(card) + 1).padStart(3, '0')}_${idx + 1}.mp4`);
    },
    async upscaleCard(id, idx) {
      const card = _videoCards.find(item => item.id === id);
      if (card) await upscaleStudioCardByIdx(card, idx);
    },
  };
})();
