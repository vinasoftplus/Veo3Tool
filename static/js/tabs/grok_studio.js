/* Grok Studio tab */
(function () {
  let seq = 0;
  let cards = [];
  let activeFilter = 'all';
  let stopAll = false;
  let saveHandle = null;
  let _grokMaxConcurrent = 2;
  let _cardLayout = localStorage.getItem('grokCardLayout') || 'vertical';

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

  async function _loadGrokCfg() {
    const [accData, cfgData] = await Promise.all([
      API.get('/api/grok/accounts'),
      API.get('/api/settings/config-full').catch(() => ({})),
    ]);
    const accounts = (accData && accData.accounts) || [];
    const activeIndices = accounts
      .map((acc, i) => ({ acc, i }))
      .filter(({ acc }) => acc.enabled !== false && acc.has_cookie)
      .map(({ i }) => i);
    const v = parseInt((cfgData?.data ?? cfgData)?.MAX_CONCURRENT_GROK ?? _grokMaxConcurrent, 10);
    const maxConcurrent = Math.min(5, Math.max(1, isNaN(v) ? _grokMaxConcurrent : v));
    _grokMaxConcurrent = maxConcurrent;
    return { accountIndices: activeIndices.length > 1 ? activeIndices : [null], maxConcurrent };
  }
  const cfg = {
    aspect: '16:9',
    videoQuality: '720p',
    imageQuality: 'speed',
    duration: 6,
    autoDownload: false,
  };

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  function newCard(prompt = '') {
    return {
      id: 'grok-' + (++seq),
      prompt,
      refs: [],
      images: [],
      outputs: [],
      status: 'idle',
      error: '',
      progress: 0,
      message: '',
      busyImage: false,
      busyVideo: false,
      outputIndex: 0,
    };
  }

  function visibleCards() {
    if (activeFilter === 'running') return cards.filter(c => c.busyImage || c.busyVideo || c.status === 'running');
    if (activeFilter === 'completed') return cards.filter(c => c.status === 'completed');
    if (activeFilter === 'failed') return cards.filter(c => c.status === 'failed');
    return cards;
  }

  function updateStats() {
    const total = cards.length;
    const running = cards.filter(c => c.busyImage || c.busyVideo || c.status === 'running').length;
    const done = cards.filter(c => c.status === 'completed').length;
    const failed = cards.filter(c => c.status === 'failed').length;
    const pending = cards.filter(c => c.prompt && !c.busyVideo && !c.outputs.length).length;
    if ($('grok-pending-count')) $('grok-pending-count').textContent = pending;
    if ($('grok-saved-count')) $('grok-saved-count').textContent = cards.reduce((n, c) => n + c.outputs.length, 0);
    if ($('grok-filter-total-count')) $('grok-filter-total-count').textContent = total;
    if ($('grok-filter-running-count')) $('grok-filter-running-count').textContent = running;
    if ($('grok-filter-done-count')) $('grok-filter-done-count').textContent = done;
    if ($('grok-filter-failed-count')) $('grok-filter-failed-count').textContent = failed;
    const label = activeFilter === 'running' ? 'Đang chạy' : activeFilter === 'completed' ? 'Xong' : activeFilter === 'failed' ? 'Lỗi' : 'Tất cả cụm';
    if ($('grok-filter-current')) $('grok-filter-current').textContent = `${label} : ${visibleCards().length}`;
    if ($('grok-empty')) $('grok-empty').style.display = cards.length ? 'none' : 'flex';
  }

  function applyCardLayout() {
    const cardsEl = $('grok-cards');
    const btn = $('grok-layout-toggle');
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

  function renderAll() {
    const wrap = $('grok-cards');
    if (!wrap) return;
    wrap.innerHTML = '';
    visibleCards().forEach((card, i) => wrap.appendChild(renderCard(card, cards.indexOf(card) + 1 || i + 1)));
    applyCardLayout();
    updateStats();
  }

  // Chỉ update phần progress/status của 1 card đang chạy, không rebuild DOM card khác
  function renderCardProgress(card) {
    const el = document.getElementById('grok-card-' + card.id);
    if (!el) { renderAll(); return; }
    // Update class
    const sc = statusClass(card);
    el.className = 'studio-card' + (sc ? ' ' + sc : '');
    // Update preview area (spinner/progress)
    const previewWrap = el.querySelector('.studio-preview-panel');
    if (previewWrap && (card.busyImage || card.busyVideo)) {
      const prog = card.progress
        ? `<div style="height:5px;background:var(--bg3);border-radius:99px;overflow:hidden;margin-top:8px;"><div style="height:100%;width:${Math.max(1, card.progress)}%;background:linear-gradient(90deg,var(--accent,#ec4899),var(--orange,#fb923c));transition:width .3s;"></div></div>`
        : '';
      const msg = card.busyImage
        ? '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo ảnh Grok...</div></div>'
        : `<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">${esc(card.message || 'Đang tạo video Grok...')}</div>${prog}</div>`;
      previewWrap.innerHTML = msg;
    }
    updateStats();
  }

  function statusClass(card) {
    if (card.status === 'failed') return 'failed';
    if (card.status === 'completed') return 'completed';
    if (card.busyImage || card.busyVideo || card.status === 'running') return 'running';
    return '';
  }

  function renderCard(card, index) {
    const el = document.createElement('div');
    el.id = 'grok-card-' + card.id;
    el.className = 'studio-card';
    el.dataset.id = card.id;

    const sc = statusClass(card);
    const prog = card.progress
      ? `<div style="height:5px;background:var(--bg3);border-radius:99px;overflow:hidden;margin-top:8px;"><div style="height:100%;width:${Math.max(1, card.progress)}%;background:linear-gradient(90deg,var(--accent,#ec4899),var(--orange,#fb923c));transition:width .3s;"></div></div>`
      : '';

    const preview = (() => {
      if (card.busyImage) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo ảnh Grok...</div></div>';
      if (card.busyVideo) return `<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">${esc(card.message || 'Đang tạo video Grok...')}</div>${prog}</div>`;
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${esc(card.error || 'Thất bại')}</div>`;
      const out = card.outputs[card.outputIndex] || card.outputs[0];
      const videoUrl = out?.video_url || out?.download_url || '';
      const videoSrc = videoUrl ? (videoUrl.startsWith('https://assets.grok.com/') ? `/api/grok/proxy-video?url=${encodeURIComponent(videoUrl)}` : videoUrl) : '';
      if (videoSrc) return `<video controls src="${esc(videoSrc)}" preload="metadata" style="width:100%;height:100%;object-fit:contain;border-radius:10px;background:#000;cursor:pointer;" ondblclick="GrokStudio.openVideoPopup('${card.id}',${card.outputIndex || 0})" title="Double-click để xem toàn màn hình"></video>`;
      const img = card.images[0];
      const _imgUrl = (item) => item.b64 ? 'data:image/jpeg;base64,' + item.b64 : (item.url ? `/api/grok/proxy-image?url=${encodeURIComponent(item.url)}${Number.isInteger(item.account_index) ? '&account_index=' + item.account_index : ''}` : '');
      const imgSrc = img ? _imgUrl(img) : '';
      if (imgSrc) return `<img src="${esc(imgSrc)}" style="width:100%;height:100%;object-fit:contain;border-radius:10px;display:block;cursor:pointer;" onclick="GrokStudio.openImagePopup('${card.id}','image',0)" title="Nhấp để xem full">`;
      return '<span>Chưa có preview</span>';
    })();

    const promptBlock = `
      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Text Prompt</span>
          <span style="font-size:10px;color:var(--text3);font-weight:400;">Nhấn để chỉnh sửa</span>
        </label>
        <div class="studio-prompt-display grok-prompt-open ${!card.prompt ? 'empty' : ''}" data-card="${card.id}" onclick="GrokStudio.openPromptPopup('${card.id}')" style="cursor:pointer;">${card.prompt ? esc(card.prompt) : 'Nhập prompt cho cụm này...'}</div>
        <input type="file" class="grok-ref-file-input" accept="image/*" multiple style="display:none;">
      </div>`;

    const refThumbsHtml = card.refs.length
      ? card.refs.map((r, i) => `<div class="studio-thumb" style="position:relative;"><img src="${esc(r.url)}" onclick="GrokStudio.openImagePopup('${card.id}','ref',${i})" style="cursor:pointer;"><button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();GrokStudio.deleteRef('${card.id}',${i})" title="Xóa ảnh này">×</button></div>`).join('')
      : '';

    const _imgSrc = (r) => r.b64 ? 'data:image/jpeg;base64,' + r.b64 : (r.url ? `/api/grok/proxy-image?url=${encodeURIComponent(r.url)}${Number.isInteger(r.account_index) ? '&account_index=' + r.account_index : ''}` : '');
    const imgThumbsHtml = card.images.length
      ? card.images.map((r, i) => `<div class="studio-thumb" style="position:relative;"><img src="${esc(_imgSrc(r))}" onclick="GrokStudio.openImagePopup('${card.id}','image',${i})" style="cursor:pointer;"><button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();GrokStudio.deleteImage('${card.id}',${i})" title="Xóa ảnh này">×</button></div>`).join('')
      : '<div class="studio-note" style="font-size:10px;">Chưa có</div>';

    const vidThumbsHtml = card.outputs.length
      ? card.outputs.map((out, i) => {
        const url = out.video_url || out.download_url || '';
        const thumbSrc = url ? (url.startsWith('https://assets.grok.com/') ? `/api/grok/proxy-video?url=${encodeURIComponent(url)}` : url) : '';
        return `<div class="studio-video-thumb ${i === card.outputIndex ? 'active' : ''}" style="position:relative;" onclick="GrokStudio.selectOutput('${card.id}',${i})">${thumbSrc ? `<video src="${esc(thumbSrc)}" muted preload="metadata" ondblclick="event.stopPropagation();GrokStudio.openVideoPopup('${card.id}',${i})" title="Double-click để xem popup"></video>` : '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--text3);font-size:10px;">Video</div>'}<button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();GrokStudio.deleteOutput('${card.id}',${i})" title="Xóa video này">×</button></div>`;
      }).join('')
      : '<div class="studio-note" style="font-size:10px;">Chưa có</div>';

    const refBlock = `
      <div class="studio-strip-block studio-ref-block">
        <div class="studio-ref-head">
          <div class="studio-ref-head-left">
            <span class="studio-ref-title">Ảnh tham chiếu</span>
            <span class="studio-ref-cap">(Max 10)</span>
          </div>
          <div class="studio-ref-head-actions">
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-small grok-add-ref">+ Thêm</button>
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-icon grok-open-vault-ref" title="Chọn từ kho" aria-label="Chọn từ kho">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
                <path d="M3 10h18"></path>
              </svg>
            </button>
            <button type="button" class="btn btn-secondary btn-sm studio-ref-btn-icon studio-ref-btn-danger grok-clear-refs" title="Xóa toàn bộ ảnh tham chiếu">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7h18"></path>
                <path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path>
                <path d="M6 7l1 12a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-12"></path>
              </svg>
            </button>
          </div>
        </div>
        ${card.refs.length
        ? `<div class="studio-strip-head"><span>Đã chọn ${card.refs.length} ảnh tham chiếu</span></div><div class="studio-strip">${refThumbsHtml}</div>`
        : `<div class="studio-ref-empty-box">Chưa có ảnh. Bấm "+ Thêm" để upload, hoặc "Kho" để chọn từ kho.</div>`}
      </div>`;

    const actionBlock = `
      <div class="studio-card-actions">
        <button class="btn btn-primary grok-generate-image" ${card.busyImage ? 'disabled' : ''}>${card.busyImage ? 'Đang tạo hình...' : 'Tạo hình'}</button>
        <button class="btn btn-primary grok-generate-video" ${card.busyVideo ? 'disabled' : ''}>${card.busyVideo ? 'Đang tạo video...' : 'Tạo video'}</button>
      </div>`;

    const outputBlocks = `
      <div class="studio-strip-block">
        <div class="studio-strip-head"><span>Hình đã tạo (${card.images.length})</span></div>
        <div class="studio-strip">${imgThumbsHtml}</div>
      </div>
      <div class="studio-strip-block">
        <div class="studio-strip-head"><span>Video đã tạo (${card.outputs.length})</span></div>
        <div class="studio-strip">${vidThumbsHtml}</div>
      </div>`;

    const bodyContent = _cardLayout === 'horizontal'
      ? `
        <div class="studio-card-left">
          <div class="studio-preview-panel">${preview}</div>
        </div>
        <div class="studio-card-right">
          ${promptBlock}
          ${refBlock}
          ${actionBlock}
          <div class="studio-right-strips">${outputBlocks}</div>
        </div>`
      : `
        <div class="studio-preview-panel">${preview}</div>
        ${promptBlock}
        ${refBlock}
        ${actionBlock}
        ${outputBlocks}`;

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${sc}"></span>
        <span class="studio-card-title">Cụm ${index}</span>
        <div class="studio-toolbar-spacer"></div>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn grok-insert-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Cụm
            <span class="studio-btn-caret">▾</span>
          </button>
          <div class="card-insert-menu grok-insert-menu" style="display:none;">
            <div class="grok-insert-before">Thêm trước</div>
            <div class="grok-insert-after">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm studio-icon-btn grok-dup" title="Nhân bản cụm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="10" height="10" rx="2"></rect>
            <rect x="5" y="5" width="10" height="10" rx="2"></rect>
          </svg>
        </button>
        <button class="btn btn-secondary btn-sm studio-icon-btn studio-icon-btn-danger grok-del" title="Xóa cụm">
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
      ${card.error && !card.busyVideo && !card.busyImage ? `<div style="font-size:11px;color:var(--orange);white-space:pre-wrap;padding:4px 12px 8px;">${esc(card.error)}</div>` : ''}`;

    // Insert menu
    const insertBtn = el.querySelector('.grok-insert-btn');
    const insertMenu = el.querySelector('.grok-insert-menu');
    insertBtn?.addEventListener('click', e => {
      e.stopPropagation();
      insertMenu.style.display = insertMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { if (insertMenu) insertMenu.style.display = 'none'; }, { once: true });
    el.querySelector('.grok-insert-before')?.addEventListener('click', () => {
      const idx = cards.indexOf(card);
      cards.splice(idx, 0, newCard());
      renderAll();
    });
    el.querySelector('.grok-insert-after')?.addEventListener('click', () => {
      const idx = cards.indexOf(card);
      cards.splice(idx + 1, 0, newCard());
      renderAll();
    });

    // Ref actions
    const refFileInput = el.querySelector('.grok-ref-file-input');
    el.querySelector('.grok-add-ref')?.addEventListener('click', () => refFileInput?.click());
    refFileInput?.addEventListener('change', e => {
      Array.from(e.target.files || []).forEach(file => {
        card.refs.push({ url: URL.createObjectURL(file), file, label: file.name });
      });
      e.target.value = '';
      renderAll();
    });
    el.querySelector('.grok-open-vault-ref')?.addEventListener('click', () => openVault(card.id));
    el.querySelector('.grok-clear-refs')?.addEventListener('click', () => { card.refs = []; renderAll(); });

    // Generate buttons
    el.querySelector('.grok-generate-image')?.addEventListener('click', () => generateImage(card.id));
    el.querySelector('.grok-generate-video')?.addEventListener('click', () => generateVideo(card.id));

    // Dup / del
    el.querySelector('.grok-dup')?.addEventListener('click', () => {
      cards.splice(cards.indexOf(card) + 1, 0, { ...newCard(card.prompt), refs: [...card.refs] });
      renderAll();
    });
    el.querySelector('.grok-del')?.addEventListener('click', () => { cards = cards.filter(c => c.id !== card.id); renderAll(); });

    return el;
  }

  async function urlToFile(url, name) {
    const res = await fetch(url);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  async function appendRefsToForm(fd, card) {
    for (let i = 0; i < card.refs.length; i++) {
      const ref = card.refs[i];
      const file = ref.file || await urlToFile(ref.url, `grok_ref_${i + 1}.jpg`);
      fd.append('reference_images', file, file.name || `grok_ref_${i + 1}.jpg`);
    }
  }

  async function startJob(path, card, fields) {
    const fd = new FormData();
    fd.append('prompt', card.prompt || '');
    Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
    await appendRefsToForm(fd, card);
    const res = await API.postForm(path, fd);
    if (!res.ok || !res.job_id) throw new Error(res.detail || res.error || 'Không tạo được job Grok');
    return res.job_id;
  }

  async function waitJob(jobId, card, kind) {
    while (true) {
      if (stopAll) throw new Error('STOPPED');
      const res = await API.get(`/api/grok/job/${jobId}`);
      const job = res.job || res;
      card.progress = job.progress || card.progress || 0;
      card.message = job.message || card.message || '';
      if (job.status === 'completed') {
        card.status = 'completed';
        card.error = '';
        if (kind === 'image') card.images.unshift(...(job.images || []));
        else card.outputs.push(...(job.outputs || []));
        break;
      }
      if (job.status === 'failed') {
        throw new Error(job.error || 'Grok job thất bại');
      }
      renderCardProgress(card);
      await sleep(2500);
    }
  }

  async function generateImage(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card || !card.prompt.trim()) return toast('Nhập prompt trước khi tạo hình', 'error');
    card.busyImage = true; card.status = 'running'; card.error = ''; card.progress = 1; card.message = 'Đang tạo ảnh Grok';
    renderAll();
    try {
      const extra = {};
      if (accountIndex !== null) extra.account_index = accountIndex;
      const jobId = await startJob('/api/grok/studio-image', card, { aspect_ratio: cfg.aspect, quality: cfg.imageQuality, ...extra });
      await waitJob(jobId, card, 'image');
      toast('Đã tạo ảnh Grok', 'success');
    } catch (e) {
      const msg = e.message || String(e);
      if (msg === 'STOPPED') { card.status = 'failed'; card.error = 'Đã dừng'; return; }
      card.status = 'failed';
      card.error = msg;
      toast('Tạo ảnh Grok lỗi: ' + msg, 'error', 7000);
    } finally {
      card.busyImage = false; card.progress = 0; card.message = ''; renderAll();
    }
  }

  async function generateVideo(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card || !card.prompt.trim()) return toast('Nhập prompt trước khi tạo video', 'error');
    const MAX_RETRY = 3;
    card.busyVideo = true; card.status = 'running'; card.error = ''; card.progress = 1;
    renderAll();
    for (let attempt = 0; attempt <= MAX_RETRY && !stopAll; attempt++) {
      try {
        if (attempt > 0) {
          card.error = `Grok lỗi, đang thử lại ${attempt}/${MAX_RETRY}...`;
          card.message = card.error;
          renderCardProgress(card);
          await sleep(2000);
        }
        const extra = {};
        if (accountIndex !== null) extra.account_index = accountIndex;
        const jobId = await startJob('/api/grok/studio-video', card, {
          aspect_ratio: cfg.aspect,
          duration: cfg.duration,
          resolution: cfg.videoQuality,
          ...extra,
        });
        await waitJob(jobId, card, 'video');
        if (cfg.autoDownload && saveHandle) {
          try { await saveOutputs(card.id, Math.max(0, card.outputs.length - 1)); } catch (_) { }
        }
        card.busyVideo = false; card.progress = 0; card.message = '';
        toast('Đã tạo video Grok', 'success');
        renderAll();
        return;
      } catch (e) {
        const msg = e.message || String(e);
        if (msg === 'STOPPED') {
          card.status = 'failed'; card.error = 'Đã dừng';
          card.busyVideo = false; card.progress = 0; card.message = '';
          renderAll(); return;
        }
        if (attempt >= MAX_RETRY) {
          card.status = 'failed';
          card.error = `Thất bại sau ${MAX_RETRY} lần thử: ${msg}`;
          card.busyVideo = false; card.progress = 0; card.message = '';
          toast('Tạo video Grok lỗi: ' + msg, 'error', 7000);
          return;
        }
        card.error = `Grok lỗi: ${msg}\nĐang thử lại ${attempt + 1}/${MAX_RETRY}...`;
      } finally {
        renderAll();
      }
    }
    if (stopAll) card.error = 'Đã dừng';
    card.status = card.outputs.length ? 'completed' : 'failed';
    card.busyVideo = false; card.progress = 0; card.message = ''; renderAll();
  }

  async function generateAll(kind) {
    stopAll = false;
    $('grok-stop-all').style.display = '';
    const pending = cards.filter(c => c.prompt && (kind === 'image' ? !c.busyImage : !c.busyVideo && !c.outputs.length));
    if (!pending.length) { $('grok-stop-all').style.display = 'none'; return; }

    let accountIndices = [null], maxConcurrent = _grokMaxConcurrent;
    try { ({ accountIndices, maxConcurrent } = await _loadGrokCfg()); } catch (_) { }

    const n = accountIndices.length;
    toast(n > 1
      ? `Chạy ${pending.length} cụm với ${n} tài khoản Grok (tối đa ${maxConcurrent} job/tài khoản)`
      : `Bắt đầu tạo ${pending.length} ${kind === 'image' ? 'ảnh' : 'video'} Grok (tối đa ${maxConcurrent} cùng lúc)`, 'info');

    const run = (cardId, accIdx) => kind === 'image' ? generateImage(cardId, accIdx) : generateVideo(cardId, accIdx);

    if (n <= 1) {
      const sem = makeSemaphore(maxConcurrent);
      let i = 0;
      await Promise.all(pending.map(card => sem(async () => {
        if (stopAll) return;
        if (i++ > 0) await sleep(1000 + Math.random() * 1000);
        await run(card.id, accountIndices[0]);
      })));
    } else {
      // Chia đều cụm vào bucket theo account — round-robin
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi];
        if (bi > 0) await sleep(bi * 1000); // stagger start
        const sem = makeSemaphore(maxConcurrent);
        let i = 0;
        await Promise.all(bucket.map(card => sem(async () => {
          if (stopAll) return;
          if (i++ > 0) await sleep(1000 + Math.random() * 1000);
          await run(card.id, accIdx);
        })));
      }));
    }

    $('grok-stop-all').style.display = 'none';
  }

  function importImages(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (!cards.length) cards.push(newCard());
    let idx = 0;
    for (const file of list) {
      const card = cards[idx % cards.length];
      card.refs.push({ url: URL.createObjectURL(file), file, label: file.name });
      idx++;
    }
    renderAll();
  }

  function openImportPopup() {
    let popup = $('grok-import-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'grok-import-popup';
      popup.className = 'studio-popup-overlay';
      popup.innerHTML = `
        <div class="studio-modal" style="max-width:480px;">
          <div class="studio-modal-header">
            <div>
              <div class="studio-modal-title">Import Prompt</div>
              <div class="studio-modal-subtitle">Chọn định dạng file để import vào Grok Studio</div>
            </div>
            <button class="studio-modal-close" id="grok-import-close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="studio-modal-body">
            <div class="studio-import-modes">
              <button id="grok-import-text-btn" class="studio-import-mode-btn studio-import-mode-btn--active" type="button">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <span class="studio-import-mode-name">TXT</span>
                <span class="studio-import-mode-desc">Mỗi dòng = 1 cụm</span>
              </button>
              <button id="grok-import-json-btn" class="studio-import-mode-btn" type="button">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                <span class="studio-import-mode-name">JSON Scene</span>
                <span class="studio-import-mode-desc">Mảng scene với prompt...</span>
              </button>
              <button id="grok-import-xlsx-btn" class="studio-import-mode-btn" type="button">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/><path d="m7 13 2 2-2 2M13 13l2 2-2 2"/></svg>
                <span class="studio-import-mode-name">Excel</span>
                <span class="studio-import-mode-desc">File .xlsx/.xls<br>mỗi hàng = 1 prompt</span>
              </button>
            </div>
            <div id="grok-import-hint" style="display:none;font-size:12px;color:var(--text3);padding:10px 12px;background:var(--bg3);border-radius:8px;display:flex;align-items:flex-start;gap:8px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;margin-top:1px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Đang có <strong id="grok-import-card-count">0</strong> cụm. Import sẽ thêm vào danh sách hiện tại.
            </div>
          </div>
        </div>
        <input type="file" id="grok-prompts-file-txt2" accept=".txt" style="display:none;">
        <input type="file" id="grok-prompts-file-json2" accept=".json" style="display:none;">
        <input type="file" id="grok-prompts-file-xlsx2" accept=".xlsx,.xls" style="display:none;">`;
      document.body.appendChild(popup);
      popup.onclick = e => { if (e.target === popup) popup.style.display = 'none'; };
      $('grok-import-close').onclick = () => { popup.style.display = 'none'; };
      $('grok-import-text-btn').onclick = () => { popup.style.display = 'none'; $('grok-prompts-file-txt2').click(); };
      $('grok-import-json-btn').onclick = () => { popup.style.display = 'none'; $('grok-prompts-file-json2').click(); };
      $('grok-import-xlsx-btn').onclick = () => { popup.style.display = 'none'; $('grok-prompts-file-xlsx2').click(); };
      $('grok-prompts-file-txt2').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importPromptFile(f, 'txt'); e.target.value = ''; });
      $('grok-prompts-file-json2').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importPromptFile(f, 'json'); e.target.value = ''; });
      $('grok-prompts-file-xlsx2').addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importPromptFile(f, 'xlsx'); e.target.value = ''; });
    }
    const countEl = $('grok-import-card-count');
    if (countEl) countEl.textContent = cards.length;
    const hint = $('grok-import-hint');
    if (hint) hint.style.display = cards.length > 0 ? 'flex' : 'none';
    popup.style.display = 'flex';
  }

  async function importPromptFile(file, mode) {
    if (mode === 'xlsx') {
      if (typeof XLSX === 'undefined') return toast('Thư viện XLSX chưa được tải', 'error');
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const prompts = rows.map(row => (Array.isArray(row) ? row : [row]).join('\t').trim()).filter(Boolean);
          if (!prompts.length) return toast('Không tìm thấy prompt nào trong file Excel', 'error');
          prompts.forEach(p => cards.push(newCard(p)));
          renderAll();
          toast(`Đã import ${prompts.length} prompt từ Excel`, 'success');
        } catch (err) {
          toast('Lỗi đọc file Excel: ' + (err.message || err), 'error');
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    const text = await file.text();
    let prompts = [];
    if (mode === 'json') {
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed.scenes || parsed.prompts || [parsed]);
        prompts = arr.map(item => (typeof item === 'string' ? item : (item.prompt || item.text || JSON.stringify(item)))).filter(Boolean);
      } catch {
        prompts = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      }
    } else {
      prompts = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    }
    if (!prompts.length) return toast('Không tìm thấy prompt nào trong file', 'error');
    prompts.forEach(line => cards.push(newCard(line)));
    renderAll();
    toast(`Đã import ${prompts.length} prompt`, 'success');
  }

  function openAddCardDialog() {
    let dialog = $('grok-add-card-dialog');
    if (!dialog) {
      dialog = document.createElement('div');
      dialog.id = 'grok-add-card-dialog';
      dialog.className = 'studio-popup-overlay';
      dialog.innerHTML = `
        <div class="studio-modal" style="max-width:380px;">
          <div class="studio-modal-header">
            <div class="studio-modal-title">Thêm cụm</div>
            <button class="studio-modal-close" id="grok-add-card-close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="studio-modal-body">
            <div class="form-group">
              <label class="form-label">Số cụm muốn thêm</label>
              <input type="number" id="grok-add-card-count" value="1" min="1" max="200"
                style="width:100%;font-size:24px;text-align:center;padding:12px;">
            </div>
            <button id="grok-add-card-confirm" class="btn btn-primary" style="width:100%;">Thêm cụm</button>
          </div>
        </div>`;
      document.body.appendChild(dialog);
      dialog.addEventListener('click', e => { if (e.target === dialog) dialog.style.display = 'none'; });
      $('grok-add-card-close').onclick = () => { dialog.style.display = 'none'; };
      $('grok-add-card-confirm').onclick = () => {
        const n = Math.max(1, Math.min(200, parseInt($('grok-add-card-count')?.value || '1', 10) || 1));
        for (let i = 0; i < n; i++) cards.push(newCard());
        dialog.style.display = 'none';
        renderAll();
        toast('Đã thêm ' + n + ' cụm', 'success');
      };
    }
    $('grok-add-card-count').value = '1';
    dialog.style.display = 'flex';
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) return toast('Trình duyệt không hỗ trợ chọn folder', 'error');
    saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('grok-folder-label').textContent = saveHandle.name || 'Folder';
    $('grok-auto-download-label').textContent = 'Auto Lưu';
  }

  async function saveBlobToHandle(blob, filename) {
    if (!saveHandle) return;
    const fh = await saveHandle.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async function saveOutputs(cardId = null, startIndex = 0) {
    const selected = cardId ? cards.filter(c => c.id === cardId) : cards;
    let saved = 0;
    for (const card of selected) {
      for (let i = startIndex; i < card.outputs.length; i++) {
        const out = card.outputs[i];
        const url = out.download_url || out.video_url;
        if (!url) continue;
        const filename = `grok_${String(cards.indexOf(card) + 1).padStart(3, '0')}_${i + 1}.mp4`;
        let proxy = `/api/grok/proxy-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
        if (Number.isInteger(out.account_index)) proxy += `&account_index=${encodeURIComponent(out.account_index)}`;
        const res = await fetch(proxy, { headers: _appHeaders() });
        if (!res.ok) throw new Error('Tải video lỗi HTTP ' + res.status);
        await saveBlobToHandle(await res.blob(), filename);
        saved++;
      }
    }
    toast(saved ? `Đã lưu ${saved} video` : 'Chưa có video để lưu', saved ? 'success' : 'info');
  }

  async function saveImages() {
    let saved = 0;
    for (const [ci, card] of cards.entries()) {
      for (const [ii, img] of card.images.entries()) {
        let blob;
        if (img.url) {
          // Proxy through backend to avoid CORS
          const res = await fetch(_proxyImgUrl(img.url, img.account_index));
          if (!res.ok) throw new Error(`Tải ảnh lỗi HTTP ${res.status}`);
          blob = await res.blob();
        } else if (img.b64) {
          // Base64 fallback — convert without fetch
          const bin = atob(img.b64);
          const arr = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
          blob = new Blob([arr], { type: 'image/jpeg' });
        } else {
          continue;
        }
        const ext = blob.type === 'image/png' ? 'png' : 'jpg';
        await saveBlobToHandle(blob, `grok_img_${String(ci + 1).padStart(3, '0')}_${ii + 1}.${ext}`);
        saved++;
      }
    }
    toast(saved ? `Đã lưu ${saved} ảnh` : 'Chưa có ảnh để lưu', saved ? 'success' : 'info');
  }

  // ── Image popup ─────────────────────────────────────────────────────────
  let _imagePopup = null;

  function _proxyImgUrl(url, accountIndex) {
    if (!url) return '';
    const acc = Number.isInteger(accountIndex) ? `&account_index=${accountIndex}` : '';
    return `/api/grok/proxy-image?url=${encodeURIComponent(url)}${acc}`;
  }

  function openImagePopup(cardId, type, idx) {
    const card = cards.find(c => c.id === cardId);
    const item = type === 'ref' ? card?.refs[idx] : card?.images[idx];
    if (!item) return;
    const src = item.b64 ? 'data:image/jpeg;base64,' + item.b64 : _proxyImgUrl(item.url, item.account_index);
    if (!src) return;
    _imagePopup = { cardId, type, idx, src, b64: item.b64, url: item.url, accountIndex: item.account_index, cardNum: card ? cards.indexOf(card) + 1 : 1 };
    const img = document.getElementById('grok-image-popup-img');
    const caption = document.getElementById('grok-image-popup-caption');
    if (img) img.src = src;
    if (caption) caption.textContent = type === 'ref' ? `Ảnh tham chiếu ${idx + 1} — Cụm ${_imagePopup.cardNum}` : `Ảnh ${idx + 1} — Cụm ${_imagePopup.cardNum}`;
    const popup = document.getElementById('grok-image-popup');
    if (popup) popup.style.display = 'flex';
  }

  function previewImage(cardId, type, idx) {
    openImagePopup(cardId, type, idx);
  }

  function closeImagePopup() {
    const popup = document.getElementById('grok-image-popup');
    const img = document.getElementById('grok-image-popup-img');
    if (img) img.src = '';
    if (popup) popup.style.display = 'none';
    _imagePopup = null;
  }

  function navigateImagePopup(dir) {
    if (!_imagePopup) return;
    const { cardId, type } = _imagePopup;
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const list = type === 'ref' ? card.refs : card.images;
    const newIdx = _imagePopup.idx + dir;
    if (newIdx < 0 || newIdx >= list.length) return;
    openImagePopup(cardId, type, newIdx);
  }

  async function downloadImagePopup() {
    if (!_imagePopup) return;
    const { b64, url, accountIndex, cardNum, idx } = _imagePopup;
    const filename = `grok_img_${String(cardNum).padStart(3, '0')}_${idx + 1}.jpg`;
    try {
      let blob;
      if (b64) {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
        blob = new Blob([arr], { type: 'image/jpeg' });
      } else if (url) {
        const res = await fetch(_proxyImgUrl(url, accountIndex));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        blob = await res.blob();
      } else return toast('Không có URL ảnh', 'error');
      const ext = blob.type === 'image/png' ? 'png' : 'jpg';
      const fn = filename.replace(/\.jpg$/, '.' + ext);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fn; a.click();
      toast('Đã tải ảnh', 'success');
    } catch (e) {
      toast('Tải ảnh lỗi: ' + e.message, 'error');
    }
  }

  // ── Video popup ─────────────────────────────────────────────────────────
  let _videoPopup = null;

  function openVideoPopup(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const out = card.outputs[idx];
    if (!out) return;
    const url = out.video_url || out.download_url || '';
    if (!url) return toast('Video chưa có URL', 'error');
    const videoSrc = url.startsWith('https://assets.grok.com/') ? `/api/grok/proxy-video?url=${encodeURIComponent(url)}` : url;
    _videoPopup = { cardId, idx, url, downloadUrl: out.download_url || url, accountIndex: out.account_index };
    const player = document.getElementById('grok-video-popup-player');
    const caption = document.getElementById('grok-video-popup-caption');
    if (player) { player.src = videoSrc; player.load(); }
    if (caption) caption.textContent = `Video ${idx + 1} — Cụm ${cards.findIndex(c => c.id === cardId) + 1}`;
    const vpopup = document.getElementById('grok-video-popup');
    if (vpopup) vpopup.style.display = 'flex';
  }

  function closeVideoPopup() {
    const vpopup = document.getElementById('grok-video-popup');
    const player = document.getElementById('grok-video-popup-player');
    if (player) { player.pause(); player.src = ''; }
    if (vpopup) vpopup.style.display = 'none';
    _videoPopup = null;
  }

  function navVideoPopup(dir) {
    if (!_videoPopup) return;
    const card = cards.find(c => c.id === _videoPopup.cardId);
    if (!card) return;
    const newIdx = _videoPopup.idx + dir;
    if (newIdx < 0 || newIdx >= card.outputs.length) return;
    openVideoPopup(_videoPopup.cardId, newIdx);
  }

  async function downloadVideoPopup() {
    if (!_videoPopup) return;
    const url = _videoPopup.downloadUrl || _videoPopup.url;
    const card = cards.find(c => c.id === _videoPopup.cardId);
    const cardIdx = card ? String(cards.indexOf(card) + 1).padStart(3, '0') : '000';
    const filename = `grok_${cardIdx}_video_${_videoPopup.idx + 1}.mp4`;
    let proxy = `/api/grok/proxy-download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
    if (Number.isInteger(_videoPopup.accountIndex)) proxy += `&account_index=${_videoPopup.accountIndex}`;
    try {
      const res = await fetch(proxy, { headers: _appHeaders() });
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try { const j = await res.json(); detail = j.detail || detail; } catch (_) { }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      toast('Đã tải video', 'success');
    } catch (e) {
      toast('Tải video lỗi: ' + e.message, 'error');
    }
  }

  function deleteVideoPopup() {
    if (!_videoPopup) return;
    const { cardId, idx } = _videoPopup;
    closeVideoPopup();
    const c = cards.find(x => x.id === cardId);
    if (c) { c.outputs.splice(idx, 1); if (c.outputIndex >= c.outputs.length) c.outputIndex = Math.max(0, c.outputs.length - 1); renderAll(); }
  }

  // ── Save Videos popup ───────────────────────────────────────────────────
  let _saveVidSelected = new Set();

  function openSaveVideosPopup() {
    const allVideos = [];
    cards.forEach(card => {
      card.outputs.forEach((out, i) => {
        const url = out.download_url || out.video_url || '';
        if (url) allVideos.push({ key: `${card.id}:${i}`, cardId: card.id, idx: i, url, thumb: out.thumbnail_url || '', accountIndex: out.account_index, cardNum: cards.indexOf(card) + 1 });
      });
    });
    if (!allVideos.length) return toast('Chưa có video nào được tạo', 'info');
    _saveVidSelected = new Set();
    const popup = document.getElementById('grok-save-videos-popup');
    const grid = document.getElementById('grok-save-videos-grid');
    const countEl = document.getElementById('grok-save-videos-count');

    function renderGrid() {
      countEl.textContent = _saveVidSelected.size;
      grid.innerHTML = allVideos.map(item => {
        const sel = _saveVidSelected.has(item.key);
        const thumbEl = item.thumb
          ? `<img src="${esc(item.thumb.startsWith('https://assets.grok.com/') ? `/api/grok/proxy-image?url=${encodeURIComponent(item.thumb)}${Number.isInteger(item.accountIndex) ? `&account_index=${item.accountIndex}` : ''}` : item.thumb)}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy">`
          : `<video src="${esc(item.url.startsWith('https://assets.grok.com/') ? `/api/grok/proxy-video?url=${encodeURIComponent(item.url)}` : item.url)}#t=0.1" muted preload="metadata" style="width:100%;height:100%;object-fit:cover;display:block;"></video>`;
        return `<div class="studio-save-img-item ${sel ? 'selected' : ''}" data-key="${esc(item.key)}" style="border-radius:8px;overflow:hidden;cursor:pointer;position:relative;aspect-ratio:16/9;background:var(--bg3);">
          ${thumbEl}
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
            ${sel ? '<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : ''}
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.6);padding:3px 6px;font-size:10px;color:#fff;">Cụm ${item.cardNum} — #${item.idx + 1}</div>
        </div>`;
      }).join('');
      grid.querySelectorAll('.studio-save-img-item').forEach(el => {
        el.addEventListener('click', () => {
          const k = el.dataset.key;
          if (_saveVidSelected.has(k)) _saveVidSelected.delete(k); else _saveVidSelected.add(k);
          renderGrid();
        });
      });
    }

    renderGrid();
    popup.style.display = 'flex';

    document.getElementById('grok-save-videos-select-all').onclick = () => { allVideos.forEach(i => _saveVidSelected.add(i.key)); renderGrid(); };
    document.getElementById('grok-save-videos-deselect').onclick = () => { _saveVidSelected.clear(); renderGrid(); };
    document.getElementById('grok-save-videos-to-disk').onclick = async () => {
      const selected = allVideos.filter(i => _saveVidSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn video nào', 'error');
      let dirHandle = null;
      if (window.showDirectoryPicker) {
        try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_) { return; }
      }
      const progWrap = document.getElementById('grok-save-videos-progress');
      const progBar = document.getElementById('grok-save-videos-progress-bar');
      const progText = document.getElementById('grok-save-videos-progress-text');
      if (progWrap) progWrap.style.display = '';
      let done = 0;
      for (const item of selected) {
        const filename = `grok_${String(item.cardNum).padStart(3, '0')}_video_${item.idx + 1}.mp4`;
        let proxy = `/api/grok/proxy-download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(filename)}`;
        if (Number.isInteger(item.accountIndex)) proxy += `&account_index=${item.accountIndex}`;
        try {
          const res = await fetch(proxy, { headers: _appHeaders() });
          if (!res.ok) {
            let detail = 'HTTP ' + res.status;
            try { const j = await res.json(); detail = j.detail || detail; } catch (_) { }
            throw new Error(detail);
          }
          const blob = await res.blob();
          if (dirHandle) {
            const fh = await dirHandle.getFileHandle(filename, { create: true });
            const w = await fh.createWritable(); await w.write(blob); await w.close();
          } else {
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
          }
          done++;
        } catch (e) {
          toast(`Lỗi video ${item.idx + 1}: ${e.message}`, 'error');
        }
        if (progBar) progBar.style.width = `${Math.round(done / selected.length * 100)}%`;
        if (progText) progText.textContent = `${done} / ${selected.length}`;
      }
      if (progWrap) progWrap.style.display = 'none';
      toast(`Đã lưu ${done} video`, done ? 'success' : 'error');
    };
  }

  // ── Save Images popup ───────────────────────────────────────────────────
  let _saveImgSelected = new Set();

  function openSaveImagesPopup() {
    const allImages = [];
    cards.forEach(card => {
      card.images.forEach((img, i) => {
        const src = img.b64 ? 'data:image/jpeg;base64,' + img.b64 : _proxyImgUrl(img.url, img.account_index);
        if (src) allImages.push({ key: `${card.id}:${i}`, cardId: card.id, idx: i, src, b64: img.b64, url: img.url, accountIndex: img.account_index, cardNum: cards.indexOf(card) + 1 });
      });
    });
    if (!allImages.length) return toast('Chưa có ảnh nào được tạo', 'info');
    _saveImgSelected = new Set();
    const popup = document.getElementById('grok-save-images-popup');
    const grid = document.getElementById('grok-save-images-grid');
    const countEl = document.getElementById('grok-save-images-count');

    function renderGrid() {
      countEl.textContent = _saveImgSelected.size;
      grid.innerHTML = allImages.map(item => {
        const sel = _saveImgSelected.has(item.key);
        return `<div class="studio-save-img-item ${sel ? 'selected' : ''}" data-key="${esc(item.key)}" style="border-radius:8px;overflow:hidden;cursor:pointer;position:relative;aspect-ratio:1;background:var(--bg3);">
          <img src="${esc(item.src)}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy">
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
            ${sel ? '<div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : ''}
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.6);padding:3px 6px;font-size:10px;color:#fff;">Cụm ${item.cardNum} — #${item.idx + 1}</div>
        </div>`;
      }).join('');
      grid.querySelectorAll('.studio-save-img-item').forEach(el => {
        el.addEventListener('click', () => {
          const k = el.dataset.key;
          if (_saveImgSelected.has(k)) _saveImgSelected.delete(k); else _saveImgSelected.add(k);
          renderGrid();
        });
      });
    }

    renderGrid();
    popup.style.display = 'flex';

    document.getElementById('grok-save-images-select-all').onclick = () => { allImages.forEach(i => _saveImgSelected.add(i.key)); renderGrid(); };
    document.getElementById('grok-save-images-deselect').onclick = () => { _saveImgSelected.clear(); renderGrid(); };

    // ── Thêm vào kho ──────────────────────────────────────────────────────
    const vaultOptsRow = document.getElementById('grok-save-images-vault-opts');
    const vaultBtn = document.getElementById('grok-save-images-to-vault');
    const catSel = document.getElementById('grok-vault-upload-category');
    vaultBtn.onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      // Toggle row
      const showing = vaultOptsRow.style.display !== 'none';
      vaultOptsRow.style.display = showing ? 'none' : 'flex';
      if (!showing) {
        // Load categories
        try {
          const res = await fetch('/api/image/library/categories');
          const data = await res.json();
          const cats = data.items || [];
          catSel.innerHTML = '<option value="default">Mặc định</option>' +
            cats.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
        } catch (_) {}
      }
    };

    document.getElementById('grok-save-images-vault-confirm').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      const assetType = document.getElementById('grok-vault-upload-type').value;
      const categoryId = catSel.value || 'default';
      const progWrap = document.getElementById('grok-save-images-progress');
      const progBar = document.getElementById('grok-save-images-progress-bar');
      const progText = document.getElementById('grok-save-images-progress-text');
      if (progWrap) progWrap.style.display = '';
      let done = 0, fail = 0;
      for (const item of selected) {
        const filename = `grok_img_${String(item.cardNum).padStart(3,'0')}_${item.idx + 1}.jpg`;
        try {
          let blob;
          if (item.b64) {
            const bin = atob(item.b64); const arr = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
            blob = new Blob([arr], { type: 'image/jpeg' });
          } else {
            const res = await fetch(_proxyImgUrl(item.url, item.accountIndex));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            blob = await res.blob();
          }
          const fd = new FormData();
          fd.append('image', blob, filename);
          fd.append('name', filename.replace(/\.[^.]+$/, ''));
          fd.append('category_id', categoryId);
          fd.append('asset_type', assetType);
          const r = await fetch('/api/image/library/upload', { method: 'POST', body: fd });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          done++;
        } catch (e) {
          fail++;
          toast(`Lỗi ảnh ${item.idx + 1}: ${e.message}`, 'error');
        }
        if (progBar) progBar.style.width = `${Math.round((done + fail) / selected.length * 100)}%`;
        if (progText) progText.textContent = `${done + fail} / ${selected.length}`;
      }
      if (progWrap) progWrap.style.display = 'none';
      vaultOptsRow.style.display = 'none';
      toast(done ? `Đã thêm ${done} ảnh vào kho` : 'Không thêm được ảnh nào', done ? 'success' : 'error');
    };

    document.getElementById('grok-save-images-to-disk').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      let dirHandle = null;
      if (window.showDirectoryPicker) {
        try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (_) { return; }
      }
      const progWrap = document.getElementById('grok-save-images-progress');
      const progBar = document.getElementById('grok-save-images-progress-bar');
      const progText = document.getElementById('grok-save-images-progress-text');
      if (progWrap) progWrap.style.display = '';
      let done = 0;
      for (const item of selected) {
        const filename = `grok_img_${String(item.cardNum).padStart(3, '0')}_${item.idx + 1}.jpg`;
        try {
          let blob;
          if (item.b64) {
            const bin = atob(item.b64); const arr = new Uint8Array(bin.length);
            for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
            blob = new Blob([arr], { type: 'image/jpeg' });
          } else {
            const res = await fetch(_proxyImgUrl(item.url, item.accountIndex));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            blob = await res.blob();
          }
          if (dirHandle) {
            const ext = blob.type === 'image/png' ? 'png' : 'jpg';
            const fn = filename.replace(/\.jpg$/, '.' + ext);
            const fh = await dirHandle.getFileHandle(fn, { create: true });
            const w = await fh.createWritable(); await w.write(blob); await w.close();
          } else {
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
          }
          done++;
        } catch (e) {
          toast(`Lỗi ảnh ${item.idx + 1}: ${e.message}`, 'error');
        }
        if (progBar) progBar.style.width = `${Math.round(done / selected.length * 100)}%`;
        if (progText) progText.textContent = `${done} / ${selected.length}`;
      }
      if (progWrap) progWrap.style.display = 'none';
      toast(`Đã lưu ${done} ảnh`, done ? 'success' : 'error');
    };
  }

  // ── Prompt popup ─────────────────────────────────────────────────────────
  let _promptPopupCardId = null;

  function openPromptPopup(cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    _promptPopupCardId = cardId;
    const ta = document.getElementById('grok-prompt-popup-ta');
    const subtitle = document.getElementById('grok-prompt-popup-subtitle');
    if (ta) ta.value = card.prompt || '';
    if (subtitle) subtitle.textContent = `Cụm ${cards.indexOf(card) + 1}`;
    const popup = document.getElementById('grok-prompt-popup');
    if (popup) { popup.style.display = 'flex'; setTimeout(() => ta && ta.focus(), 50); }
  }

  function closePromptPopup() {
    document.getElementById('grok-prompt-popup').style.display = 'none';
    _promptPopupCardId = null;
  }

  function savePromptPopup() {
    const card = cards.find(c => c.id === _promptPopupCardId);
    const ta = document.getElementById('grok-prompt-popup-ta');
    if (card && ta) { card.prompt = ta.value; renderAll(); }
    closePromptPopup();
  }

  // ── Vault helpers ────────────────────────────────────────────────────────
  function _norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  }

  function _matchesName(prompt, charName) {
    const p = _norm(prompt);
    const n = _norm(charName);
    if (!n) return false;
    const re = new RegExp('(?:^|[\\s,.(\\[\\-"])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s,.)\\]\\-"])', '');
    return re.test(p);
  }

  function _vaultFiltered() {
    return _vaultAssets.filter(a => {
      if (_vaultTypeFilter !== 'all' && a.asset_type !== _vaultTypeFilter) return false;
      if (_vaultGroupFilter !== 'all' && a.category_id !== _vaultGroupFilter) return false;
      return true;
    });
  }

  async function grokVaultLoadQuick() {
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
        card.refs.unshift({ url: item.url, file, label: item.name || 'Ảnh kho', name: item.name || '', character_code: item.name || '', media_id: item.media_id || '' });
        totalAdded++;
      }
    }
    renderAll();
    toast(totalAdded ? `Load nhanh: thêm ${totalAdded} ảnh vào các cụm` : 'Không khớp tên nào trong prompt', totalAdded ? 'success' : 'info');
  }

  // Vault state
  let _vaultCategories = [];
  let _vaultAssets = [];
  let _vaultTypeFilter = 'nhanvat';
  let _vaultGroupFilter = 'all';
  let _vaultTargetCardId = null;

  async function openVault(targetCardId) {
    _grokVaultSelIds = new Set();
    _vaultTargetCardId = targetCardId || (cards.length ? cards[cards.length - 1].id : null);
    if (!cards.length) cards.push(newCard());

    let overlay = $('grok-vault-popup');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'grok-vault-popup';
      overlay.className = 'studio-popup-overlay';
      overlay.innerHTML = `
        <div class="studio-vault-box">
          <div class="studio-vault-head">
            <div style="font-size:15px;font-weight:700;color:var(--text);">Kho Lưu Trữ</div>
            <div style="display:flex;gap:8px;align-items:center;">
              <select id="grok-vault-type-filter" class="t2v-select" style="min-width:130px;">
                <option value="nhanvat">Nhân Vật</option>
                <option value="vatpham">Vật Phẩm</option>
                <option value="style">Style</option>
                <option value="background">Background</option>
              </select>
              <select id="grok-vault-group-filter" class="t2v-select" style="min-width:130px;"></select>
              <button class="studio-modal-close" id="grok-vault-close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
          <div class="studio-vault-grid-wrap">
            <div id="grok-vault-grid" class="studio-vault-grid"><div style="font-size:12px;color:var(--text3);padding:20px;text-align:center;">Đang tải...</div></div>
          </div>
          <div class="studio-vault-foot">
            <span id="grok-vault-count" style="font-size:12px;color:var(--text3);"></span>
            <div style="display:flex;gap:8px;margin-left:auto;align-items:center;">
              <button id="grok-vault-load-quick-btn" class="btn btn-secondary btn-sm">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Load nhanh (theo prompt)
              </button>
              <button id="grok-vault-confirm-btn" class="btn btn-primary btn-sm" style="display:none;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span id="grok-vault-confirm-label">Thêm vào cụm</span>
              </button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
      $('grok-vault-close').onclick = () => { overlay.style.display = 'none'; };
      $('grok-vault-load-quick-btn').addEventListener('click', () => {
        overlay.style.display = 'none';
        grokVaultLoadQuick();
      });
      $('grok-vault-confirm-btn').addEventListener('click', () => {
        _grokVaultConfirmAdd();
      });
      $('grok-vault-type-filter')?.addEventListener('change', () => {
        _vaultTypeFilter = $('grok-vault-type-filter').value;
        _vaultGroupFilter = _vaultCategories.length ? _vaultCategories[0].id : 'all';
        const gs = $('grok-vault-group-filter');
        if (gs) gs.value = _vaultGroupFilter;
        renderVaultGrid();
      });
      $('grok-vault-group-filter')?.addEventListener('change', () => {
        _vaultGroupFilter = $('grok-vault-group-filter').value;
        renderVaultGrid();
      });
    }

    overlay.style.display = 'flex';
    _grokVaultSelIds.clear();
    _updateVaultConfirmBtn();
    $('grok-vault-grid').innerHTML = '<div style="font-size:12px;color:var(--text3);padding:20px;text-align:center;">Đang tải...</div>';

    try {
      const [catsRes, assetsRes] = await Promise.all([
        API.get('/api/image/library/categories'),
        API.get('/api/image/library/assets'),
      ]);
      _vaultCategories = (catsRes.items || []).filter(c => {
        const id = String(c?.id || '').toLowerCase();
        const name = String(c?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
        return id !== 'default' && name !== 'mac dinh';
      });
      _vaultAssets = assetsRes.items || [];
      _vaultTypeFilter = 'nhanvat';
      _vaultGroupFilter = _vaultCategories.length ? _vaultCategories[0].id : 'all';

      // Populate group dropdown (no "all" option — default to first group)
      const groupSel = $('grok-vault-group-filter');
      if (groupSel) {
        groupSel.innerHTML = _vaultCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        groupSel.value = _vaultGroupFilter;
      }
      const typeSel = $('grok-vault-type-filter');
      if (typeSel) typeSel.value = 'nhanvat';

      renderVaultGrid();
    } catch (e) {
      const grid = $('grok-vault-grid');
      if (grid) grid.innerHTML = `<div style="font-size:12px;color:var(--red);padding:20px;text-align:center;">Không tải được thư viện: ${esc(e.message || e)}</div>`;
    }
  }

  let _grokVaultSelIds = new Set();

  function _grokHideVaultMenus() {
    ['grok-vault-ctx-menu', 'grok-vault-card-menu'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
  }

  function _grokShowVaultCtxMenu(x, y) {
    _grokHideVaultMenus();
    let menu = document.getElementById('grok-vault-ctx-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'grok-vault-ctx-menu';
      menu.className = 'lib-ctx-menu';
      menu.innerHTML = `<div class="lib-ctx-item" id="grok-vault-ctx-add">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Thêm vào cụm số...
      </div>`;
      document.body.appendChild(menu);
      document.getElementById('grok-vault-ctx-add').addEventListener('click', e => {
        const rect = e.target.getBoundingClientRect();
        _grokShowVaultCardMenu(rect.right + 4, rect.top);
      });
      document.addEventListener('click', ev => {
        if (!ev.target.closest('#grok-vault-ctx-menu') && !ev.target.closest('#grok-vault-card-menu'))
          _grokHideVaultMenus();
      }, true);
    }
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
  }

  function _grokShowVaultCardMenu(x, y) {
    _grokHideVaultMenus();
    let menu = document.getElementById('grok-vault-card-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'grok-vault-card-menu';
      menu.className = 'lib-ctx-menu';
      document.body.appendChild(menu);
    }
    menu.innerHTML = '<div class="lib-ctx-head">Chọn cụm để thêm:</div>' +
      cards.map((card, idx) => `<div class="lib-ctx-item grok-vault-card-opt" data-cid="${card.id}">Cụm ${idx + 1}${card.prompt ? ' — ' + card.prompt.slice(0, 30) : ''}</div>`).join('');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block';
    menu.querySelectorAll('.grok-vault-card-opt').forEach(el => {
      el.addEventListener('click', () => {
        _grokHideVaultMenus();
        const targetCard = cards.find(c => c.id === el.dataset.cid);
        if (!targetCard) return;
        const currentItems = _grokVaultCurrentItems();
        const toAdd = _grokVaultSelIds.size
          ? currentItems.filter((_, i) => _grokVaultSelIds.has(i))
          : currentItems.filter((_, i) => _grokVaultLastRightClickIdx === i);
        let added = 0;
        for (const item of toAdd) {
          if (targetCard.refs.some(r => r.url === item.url)) continue;
          targetCard.refs.push({ url: item.url, label: item.name || 'Thư viện', character_code: item.name || '', media_id: item.media_id || '' });
          added++;
        }
        renderAll();
        toast(`Đã thêm ${added} ảnh vào cụm`, added ? 'success' : 'info');
      });
    });
  }

  let _grokVaultLastRightClickIdx = -1;
  let _grokVaultCurrentItems = () => [];

  function _updateVaultConfirmBtn() {
    const btn = $('grok-vault-confirm-btn');
    const label = $('grok-vault-confirm-label');
    if (!btn) return;
    const targetCard = _vaultTargetCardId ? cards.find(c => c.id === _vaultTargetCardId) : null;
    const hasSelection = _grokVaultSelIds.size > 0;
    if (targetCard && hasSelection) {
      const cardIdx = cards.indexOf(targetCard) + 1;
      if (label) label.textContent = `Thêm ảnh vào Cụm ${cardIdx}`;
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  }

  function _grokVaultConfirmAdd() {
    const targetCard = _vaultTargetCardId ? cards.find(c => c.id === _vaultTargetCardId) : null;
    if (!targetCard) return toast('Không xác định được cụm đích', 'error');
    const currentItems = _grokVaultCurrentItems();
    const toAdd = currentItems.filter((_, i) => _grokVaultSelIds.has(i));
    if (!toAdd.length) return toast('Chưa chọn ảnh nào', 'info');
    let added = 0;
    for (const item of toAdd) {
      if (targetCard.refs.some(r => r.url === item.url)) continue;
      targetCard.refs.push({ url: item.url, label: item.name || 'Thư viện', character_code: item.name || '', media_id: item.media_id || '' });
      added++;
    }
    renderAll();
    _grokVaultSelIds.clear();
    _updateVaultConfirmBtn();
    const overlay = $('grok-vault-popup');
    if (overlay) overlay.style.display = 'none';
    toast(`Đã thêm ${added} ảnh vào cụm`, added ? 'success' : 'info');
  }

  function renderVaultGrid() {
    const grid = $('grok-vault-grid');
    if (!grid) return;
    const items = _vaultFiltered();
    _grokVaultCurrentItems = () => items;
    const count = $('grok-vault-count');
    if (count) count.textContent = `${items.length} ảnh`;
    if (!items.length) {
      grid.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:20px;text-align:center;">Không có ảnh nào.</div>';
      return;
    }
    const typeLabel = { nhanvat: 'Nhân Vật', vatpham: 'Vật Phẩm', style: 'Style', background: 'BG' };
    grid.innerHTML = items.map((it, i) => `
      <div class="studio-vault-card ${_grokVaultSelIds.has(i) ? 'selected' : ''}" data-i="${i}">
        <label class="studio-vault-card-check-wrap" onclick="event.stopPropagation()">
          <input type="checkbox" class="studio-vault-card-check" ${_grokVaultSelIds.has(i) ? 'checked' : ''}>
        </label>
        <img src="${esc(it.url)}" alt="${esc(it.name || '')}" loading="lazy">
        <span class="studio-vault-card-badge">${typeLabel[it.asset_type] || 'Kho'}</span>
        <div class="studio-vault-card-label">${esc(it.name || 'Chưa đặt tên')}</div>
      </div>`).join('');
    grid.querySelectorAll('.studio-vault-card').forEach(node => {
      const i = parseInt(node.dataset.i, 10);
      // Left click: toggle selection
      node.addEventListener('click', e => {
        if (e.target.type === 'checkbox') return;
        if (_grokVaultSelIds.has(i)) _grokVaultSelIds.delete(i); else _grokVaultSelIds.add(i);
        node.classList.toggle('selected', _grokVaultSelIds.has(i));
        const cb = node.querySelector('.studio-vault-card-check');
        if (cb) cb.checked = _grokVaultSelIds.has(i);
        _updateVaultConfirmBtn();
      });
      // Checkbox click
      const cb = node.querySelector('.studio-vault-card-check');
      if (cb) cb.addEventListener('change', () => {
        if (cb.checked) _grokVaultSelIds.add(i); else _grokVaultSelIds.delete(i);
        node.classList.toggle('selected', cb.checked);
        _updateVaultConfirmBtn();
      });
      // Right click: context menu
      node.addEventListener('contextmenu', e => {
        e.preventDefault();
        _grokVaultLastRightClickIdx = i;
        if (!_grokVaultSelIds.has(i)) {
          _grokVaultSelIds.add(i);
          node.classList.add('selected');
          if (cb) cb.checked = true;
        }
        _grokShowVaultCtxMenu(e.clientX, e.clientY);
      });
    });
  }

  // ── Custom fancy dropdowns (giống Studio) ─────────────────────────────
  function _grokFancyIcon(selectId, value) {
    const icon = (svg, tone) => ({ tone, svg });
    if (selectId === 'grok-video-quality') {
      if (value === '720p') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M10 10l2 2 4-4"/></svg>', 'blue');
      return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>', 'slate');
    }
    if (selectId === 'grok-image-quality') {
      if (value === 'quality') return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.2 4.4L19 9.6l-4 2.8.8 4.8L12 14.8 8.2 17.2 9 12.4 5 9.6l4.8-2.2L12 3z"/></svg>', 'amber');
      return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L4 14h7l-1 8 10-14h-7l0-6z"/></svg>', 'teal');
    }
    if (selectId === 'grok-video-duration') {
      return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>', 'violet');
    }
    return icon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>', 'slate');
  }

  function _enhanceGrokSelect(selectEl) {
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

    function iconHtml(val) {
      const ic = _grokFancyIcon(selectId, val);
      return `<span class="studio-dd-icon-wrap"><span class="studio-dd-icon tone-${ic.tone}">${ic.svg}</span></span>`;
    }

    function render() {
      const selectedOpt = selectEl.options[selectEl.selectedIndex];
      const selectedText = selectedOpt?.textContent?.trim() || '';
      trigger.innerHTML = `
        <span class="studio-dd-trigger-main">
          ${iconHtml(selectEl.value)}
          <span class="studio-dd-copy"><span class="studio-dd-trigger-text">${selectedText}</span></span>
        </span>
        <span class="studio-dd-caret">⌄</span>`;
      menu.innerHTML = '';
      Array.from(selectEl.options).forEach(opt => {
        const val = opt.value;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'studio-dd-option' + (val === selectEl.value ? ' active' : '');
        btn.innerHTML = `
          <span class="studio-dd-option-main">
            ${iconHtml(val)}
            <span class="studio-dd-copy"><span class="studio-dd-option-text">${opt.textContent.trim()}</span></span>
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

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.studio-dd.open').forEach(x => { if (x !== root) x.classList.remove('open'); });
      root.classList.toggle('open');
    });
    selectEl.addEventListener('change', render);
    render();
  }

  function bind() {
    if ($('grok-add-card')?._bound) return;
    $('grok-add-card')._bound = true;
    $('grok-add-card').addEventListener('click', openAddCardDialog);
    $('grok-gen-all-images').addEventListener('click', () => generateAll('image'));
    $('grok-gen-all-videos').addEventListener('click', () => generateAll('video'));
    $('grok-stop-all').addEventListener('click', () => { stopAll = true; });
    $('grok-import-images').addEventListener('click', () => $('grok-images-file').click());
    $('grok-images-file').addEventListener('change', e => { importImages(e.target.files); e.target.value = ''; });
    $('grok-import-prompts').addEventListener('click', openImportPopup);
    // Legacy txt file input
    const legacyTxt = $('grok-prompts-file-txt');
    if (legacyTxt) legacyTxt.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importPromptFile(f, 'txt'); e.target.value = ''; });
    $('grok-save-all').addEventListener('click', () => openSaveVideosPopup());
    $('grok-save-images-btn').addEventListener('click', () => openSaveImagesPopup());
    $('grok-clear-images-btn').addEventListener('click', () => { cards.forEach(c => c.refs = []); renderAll(); });
    $('grok-clear-all').addEventListener('click', () => { if (confirm('Xóa tất cả cụm Grok?')) { cards = []; renderAll(); } });
    $('grok-choose-folder').addEventListener('click', chooseFolder);
    $('grok-auto-download').addEventListener('change', async e => {
      if (e.target.checked && !saveHandle) {
        try { await chooseFolder(); } catch (_) { e.target.checked = false; return; }
        if (!saveHandle) { e.target.checked = false; return; }
      }
      cfg.autoDownload = e.target.checked;
    });
    $('grok-vault-btn').addEventListener('click', () => openVault(null));
    $('grok-layout-toggle').addEventListener('click', () => {
      _cardLayout = _cardLayout === 'horizontal' ? 'vertical' : 'horizontal';
      localStorage.setItem('grokCardLayout', _cardLayout);
      applyCardLayout();
      renderAll();
    });
    $('grok-toggle-toolbar').addEventListener('click', () => {
      const hidden = $('grok-sticky-bar').classList.toggle('studio-toolbar-collapsed');
      $('grok-toggle-toolbar').textContent = hidden ? 'Hiện Toolbar' : 'Ẩn Toolbar';
    });
    document.querySelectorAll('#grok-aspect-group .studio-aspect-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('#grok-aspect-group .studio-aspect-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cfg.aspect = btn.dataset.val || '16:9';
    }));
    $('grok-video-quality').addEventListener('change', e => { cfg.videoQuality = e.target.value; });
    $('grok-image-quality').addEventListener('change', e => { cfg.imageQuality = e.target.value; });
    $('grok-video-duration').addEventListener('change', e => { cfg.duration = parseInt(e.target.value, 10) || 6; });

    // Enhance selects with fancy dropdown (giống Studio)
    ['grok-video-quality', 'grok-image-quality', 'grok-video-duration'].forEach(id => _enhanceGrokSelect($(id)));
    document.addEventListener('click', e => {
      if (!e.target.closest('.studio-dd')) document.querySelectorAll('#grok-sticky-bar .studio-dd.open').forEach(x => x.classList.remove('open'));
    });

    $('grok-filter-toggle').addEventListener('click', () => $('grok-filter-menu').classList.toggle('open'));
    document.querySelectorAll('#grok-filter-menu .studio-filter-menu-item').forEach(btn => btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter || 'all';
      document.querySelectorAll('#grok-filter-menu .studio-filter-menu-item').forEach(x => x.classList.toggle('active', x === btn));
      $('grok-filter-menu').classList.remove('open');
      renderAll();
    }));
  }

  window.GrokStudio = {
    previewImage,
    openImagePopup,
    closeImagePopup,
    navigateImagePopup,
    downloadImagePopup,
    openVideoPopup,
    closeVideoPopup,
    navVideoPopup,
    downloadVideoPopup,
    deleteVideoPopup,
    openPromptPopup,
    closePromptPopup,
    savePromptPopup,
    selectOutput(cardId, idx) {
      const c = cards.find(x => x.id === cardId);
      if (c) { c.outputIndex = idx; renderAll(); }
    },
    deleteRef(cardId, idx) { const c = cards.find(x => x.id === cardId); if (c) { c.refs.splice(idx, 1); renderAll(); } },
    deleteImage(cardId, idx) { const c = cards.find(x => x.id === cardId); if (c) { c.images.splice(idx, 1); renderAll(); } },
    deleteOutput(cardId, idx) { const c = cards.find(x => x.id === cardId); if (c) { c.outputs.splice(idx, 1); if (c.outputIndex >= c.outputs.length) c.outputIndex = Math.max(0, c.outputs.length - 1); renderAll(); } },
  };

  function _ensureBrowser() {
    API.get('/api/grok/browser-status').then(d => {
      if (d && d.installed) return;
      _showBrowserInstallModal();
    }).catch(() => {
      _showBrowserInstallModal();
    });
  }

  function _closeBrowserModal() {
    document.getElementById('grok-browser-modal')?.remove();
    // Switch back to studio tab
    const studioNav = document.querySelector('.nav-item[data-tab="studio"]');
    if (studioNav) studioNav.click();
  }

  function _showBrowserInstallModal() {
    if (document.getElementById('grok-browser-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'grok-browser-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg2,#1e1e2e);border:1px solid var(--border,#333);border-radius:16px;padding:32px 28px;max-width:420px;width:90%;box-shadow:0 24px 80px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:20px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:40px;height:40px;background:linear-gradient(135deg,#a78bfa,#818cf8);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
          </div>
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text1,#fff);">Cần tải Browser</div>
            <div style="font-size:12px;color:var(--text3,#888);margin-top:2px;">Chỉ tải 1 lần, lần sau dùng ngay</div>
          </div>
        </div>
        <div style="font-size:13px;color:var(--text2,#aaa);line-height:1.6;">
          Chức năng Grok cần <strong style="color:var(--text1,#fff);">CloakBrowser (~300MB)</strong> để bypass Cloudflare.<br>
          Browser sẽ được lưu vào máy và dùng lại mọi lần mở tool sau.
        </div>
        <div id="grok-browser-progress-wrap" style="display:none;flex-direction:column;gap:8px;">
          <div style="background:var(--bg3,#2a2a3e);border-radius:8px;height:10px;overflow:hidden;">
            <div id="grok-dl-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#a78bfa,#818cf8);transition:width .3s;border-radius:8px;"></div>
          </div>
          <div id="grok-dl-msg" style="font-size:12px;color:var(--text3,#888);text-align:center;">Đang kết nối...</div>
        </div>
        <div id="grok-browser-btn-wrap" style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="grok-browser-cancel-btn" style="padding:8px 18px;border-radius:8px;border:1px solid var(--border,#444);background:transparent;color:var(--text2,#aaa);cursor:pointer;font-size:13px;" onclick="window._closeBrowserModal()">Huỷ</button>
          <button id="grok-browser-download-btn" style="padding:8px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#a78bfa,#818cf8);color:#fff;cursor:pointer;font-size:13px;font-weight:600;" onclick="window._startGrokBrowserDownload()">Tải về</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  window._showGrokBrowserModal = _showBrowserInstallModal;
  window._closeBrowserModal = _closeBrowserModal;

  window._startGrokBrowserDownload = function () {
    const progressWrap = document.getElementById('grok-browser-progress-wrap');
    const btnWrap = document.getElementById('grok-browser-btn-wrap');
    if (progressWrap) progressWrap.style.display = 'flex';
    if (btnWrap) btnWrap.style.display = 'none';

    const es = new EventSource('/api/grok/ensure-browser');
    es.onmessage = e => {
      try {
        const { pct, msg } = JSON.parse(e.data);
        const bar = document.getElementById('grok-dl-bar');
        const msgEl = document.getElementById('grok-dl-msg');
        if (bar) bar.style.width = Math.max(0, pct) + '%';
        if (msgEl) msgEl.textContent = msg;
        if (pct === 100) {
          es.close();
          if (msgEl) msgEl.textContent = 'Hoàn tất! Đang khởi động...';
          setTimeout(() => document.getElementById('grok-browser-modal')?.remove(), 1500);
        } else if (pct < 0) {
          es.close();
          if (msgEl) { msgEl.textContent = 'Lỗi: ' + msg; msgEl.style.color = '#f87171'; }
          const bw = document.getElementById('grok-browser-btn-wrap');
          if (bw) bw.style.display = 'flex';
        }
      } catch (_) { }
    };
    es.onerror = () => {
      es.close();
      const msgEl = document.getElementById('grok-dl-msg');
      if (msgEl) { msgEl.textContent = 'Kết nối thất bại, thử lại.'; msgEl.style.color = '#f87171'; }
      const bw = document.getElementById('grok-browser-btn-wrap');
      if (bw) bw.style.display = 'flex';
    };
  };

  let _grokInited = false;
  window.init_grok = function () {
    if (!_grokInited) {
      _grokInited = true;
      bind();
      applyCardLayout();
      renderAll();
      API.get('/api/settings/config-full').then(d => {
        const v = parseInt((d?.data ?? d)?.MAX_CONCURRENT_GROK ?? 2, 10);
        _grokMaxConcurrent = Math.min(5, Math.max(1, isNaN(v) ? 2 : v));
      }).catch(() => { });
    }
    _ensureBrowser();
  };
})();
