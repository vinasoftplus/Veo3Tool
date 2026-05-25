/* Start-End Video Tab */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let ready = false;
  let stopAll = false;
  let seq = 0;
  let cards = [];
  let cfg = {
    aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    model: 'flow_fast',
    durationSeconds: 8,
    outputCount: 1,
    autoUpscale: false,
    autoDownload: false,
    saveHandle: null,
    saveFolder: '',
    saveQuality: '1080',
  };

  let _activeFilter = 'all';
  let _cardLayout = localStorage.getItem('seCardLayout') || 'vertical';
  let _pendingStartImportFiles = [];

  // ─── Helpers ────────────────────────────────────────────────────────────────

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

  function newCard(prompt = '') {
    return {
      id: 'se-' + (++seq),
      prompt,
      startImg: null,   // { url, file, media_id }
      endImg: null,     // { url, file, media_id }
      outputs: [],
      outputIndex: 0,
      status: 'idle',   // idle | running | completed | failed
      error: '',
      jobId: null,
      busy: false,
      upscaling: false,
      videoAccountIndex: null,
    };
  }

  function parsePrompts(text) {
    return String(text || '').trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  }

  function parseJsonPromptCards(text) {
    let data;
    try { data = JSON.parse(String(text || '').trim()); } catch (_) { return []; }
    const list = Array.isArray(data) ? data : [data];
    return list.map(item => {
      if (!item || typeof item !== 'object') return null;
      return { prompt: item.prompt || JSON.stringify(item) };
    }).filter(Boolean);
  }

  async function urlToFile(url, name) {
    try {
      const r = await fetch(url);
      const blob = await r.blob();
      return new File([blob], name, { type: blob.type || 'image/jpeg' });
    } catch (_) { return null; }
  }

  async function chooseFolder() {
    if (!window.showDirectoryPicker) return;
    try {
      cfg.saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      cfg.saveFolder = cfg.saveHandle.name || 'Đã chọn';
      const lbl = $('se-folder-label');
      if (lbl) lbl.textContent = cfg.saveFolder;
      const dlLbl = $('se-auto-download-label');
      if (dlLbl) dlLbl.textContent = 'Auto Lưu (' + cfg.saveFolder + ')';
      const dl = $('se-auto-download');
      if (dl) dl.checked = true;
      cfg.autoDownload = true;
    } catch (_) {}
  }

  async function saveVideo(url, filename) {
    if (cfg.saveHandle) {
      try {
        const fh = await cfg.saveHandle.getFileHandle(filename, { create: true });
        const w = await fh.createWritable();
        const r = await fetch(url);
        await r.body.pipeTo(w);
        return;
      } catch (_) {}
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }

  async function _loadGenCfg() {
    const cfgRes = await API.get('/api/settings/config-full');
    const d = (cfgRes && cfgRes.data) ? cfgRes.data : cfgRes;
    const activeIndices = [];
    for (let i = 1; i <= 10; i++) {
      const acc = d[`account${i}`];
      if (acc && acc.ENABLED !== false && (acc.ACCESS_TOKEN || acc.COOKIE)) activeIndices.push(i);
    }
    const maxConcurrent = Math.min(3, Math.max(1, parseInt(d.MAX_CONCURRENT || '2', 10) || 2));
    return { accountIndices: activeIndices.length > 0 ? activeIndices : [null], maxConcurrent };
  }

  async function pollJob(jobId, callback) {
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await API.get('/api/veo/job/' + jobId);
        const job = res.job || res;
        await callback(job);
        if (job.status === 'completed' || job.status === 'done' || job.status === 'failed') return;
      } catch (_) {}
    }
  }

  // ─── Filter ──────────────────────────────────────────────────────────────────

  function setFilter(key) {
    _activeFilter = key;
    // Update active state on menu items
    document.querySelectorAll('[data-se-filter]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.seFilter === key);
    });
    // Update toggle label
    const labels = { all: 'Tất cả', running: 'Đang chạy', completed: 'Xong', failed: 'Lỗi', idle: 'Chờ' };
    const count = key === 'all' ? cards.length : cards.filter(c => c.status === key).length;
    const cur = $('se-filter-current');
    if (cur) cur.textContent = (labels[key] || key) + ' : ' + count;
    // Show/hide cards
    const container = $('se-cards');
    if (container) {
      [...container.children].forEach(el => {
        const card = cards.find(c => 'se-card-' + c.id === el.id);
        if (!card) return;
        el.style.display = (key === 'all' || card.status === key) ? '' : 'none';
      });
    }
    // Close menu
    const menu = $('se-filter-menu');
    const toggle = $('se-filter-toggle');
    if (menu) menu.classList.remove('open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  // ─── Update stats (pending count, saved count, filter counts) ───────────────

  function updateStats() {
    const idle = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running').length;
    const done = cards.filter(c => c.status === 'completed').length;
    const failed = cards.filter(c => c.status === 'failed').length;

    const el = $('se-pending-count');
    if (el) el.textContent = idle;
    const el2 = $('se-saved-count');
    if (el2) el2.textContent = done;

    // Filter counts
    const tot = $('se-filter-total-count');
    if (tot) tot.textContent = cards.length;
    const run = $('se-filter-running-count');
    if (run) run.textContent = running;
    const doneEl = $('se-filter-done-count');
    if (doneEl) doneEl.textContent = done;
    const failEl = $('se-filter-failed-count');
    if (failEl) failEl.textContent = failed;
    const idleEl = $('se-filter-idle-count');
    if (idleEl) idleEl.textContent = idle;

    // Update toggle label count
    const labels = { all: 'Tất cả', running: 'Đang chạy', completed: 'Xong', failed: 'Lỗi', idle: 'Chờ' };
    const activeCount = _activeFilter === 'all' ? cards.length : cards.filter(c => c.status === _activeFilter).length;
    const cur = $('se-filter-current');
    if (cur) cur.textContent = (labels[_activeFilter] || _activeFilter) + ' : ' + activeCount;

    const genBtn = $('se-gen-all');
    if (genBtn) genBtn.style.display = stopAll ? 'none' : '';
    const empty = $('se-empty');
    if (empty) empty.style.display = cards.length ? 'none' : '';

    // Re-apply current filter visibility
    const container = $('se-cards');
    if (container) {
      [...container.children].forEach(el => {
        const card = cards.find(c => 'se-card-' + c.id === el.id);
        if (!card) return;
        el.style.display = (_activeFilter === 'all' || card.status === _activeFilter) ? '' : 'none';
      });
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  function _outputVideoUrl(out) {
    if (!out) return '';
    return out.video_url || out.videoUrl || out.videoUri || out.fifeUrl || out.downloadUrl || out.url || out.uri || '';
  }

  function _escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function _openPromptModal(card) {
    if (!card) return;
    let modal = $('se-prompt-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'se-prompt-modal';
      modal.className = 'studio-prompt-modal';
      modal.innerHTML = `
        <div class="studio-prompt-modal-box">
          <div class="studio-prompt-modal-header">
            <div class="studio-prompt-modal-title">Text Prompt</div>
            <button type="button" class="studio-prompt-modal-close" aria-label="Đóng">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <textarea></textarea>
          <div class="studio-prompt-modal-actions">
            <button type="button" class="btn btn-secondary btn-sm se-prompt-cancel">Hủy</button>
            <button type="button" class="btn btn-primary btn-sm se-prompt-save">Lưu prompt</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
      modal.querySelector('.studio-prompt-modal-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
      modal.querySelector('.se-prompt-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });
    }
    const ta = modal.querySelector('textarea');
    ta.value = card.prompt || '';
    modal.querySelector('.se-prompt-save').onclick = () => {
      card.prompt = ta.value;
      modal.style.display = 'none';
      renderCard(card, false);
    };
    modal.style.display = 'flex';
    setTimeout(() => ta.focus(), 0);
  }

  function _imgSlotHtml(slot, imgObj, cardId) {
    const label = slot === 'start' ? 'Ảnh Start' : 'Ảnh End';
    if (!imgObj) {
      return `
        <div class="se-startend-slot-wrap">
          <label class="se-startend-slot se-startend-slot--empty" onclick="SETab.triggerImgPick('${cardId}','${slot}')">
            <strong>${slot === 'start' ? 'Start' : 'End'}</strong>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <rect x="3" y="3" width="18" height="18" rx="2"></rect>
              <path d="M3 15l5-5 4 4 3-3 5 5"></path>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
            </svg>
            <span>Chọn ảnh</span>
          </label>
        </div>`;
    }
    return `
      <div class="se-startend-slot-wrap">
        <div class="se-startend-slot se-startend-slot--filled" onclick="SETab.triggerImgPick('${cardId}','${slot}')">
          <img src="${imgObj.url}" alt="${label}">
          <span class="se-startend-slot-badge">${slot === 'start' ? 'Start' : 'End'}</span>
          <button class="se-img-remove" onclick="event.stopPropagation();SETab.removeImg('${cardId}','${slot}')" title="Xóa ảnh" aria-label="Xóa ảnh">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
  }

  function renderCard(card, scroll = false) {
    const container = $('se-cards');
    if (!container) return;
    let el = $('se-card-' + card.id);
    const isNew = !el;
    if (isNew) {
      el = document.createElement('div');
      el.id = 'se-card-' + card.id;
      el.className = 'se-card studio-card';
      container.appendChild(el);
    }

    const idx = cards.indexOf(card) + 1;
    const statusCls = card.status === 'completed'
      ? 'completed'
      : card.status === 'failed'
        ? 'failed'
        : (card.status === 'running' || card.busy || card.upscaling ? 'running' : '');
    const hasOutput = card.outputs && card.outputs.length > 0;
    const curOut = hasOutput ? card.outputs[card.outputIndex || 0] : null;
    const videoUrl = curOut ? _outputVideoUrl(curOut) : '';

    const previewHtml = (() => {
      if (card.upscaling) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang upscale 1080p...</div></div>';
      if (card.status === 'running' || card.busy) return `<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Đang tạo video...</div>${card.error ? `<div style="margin-top:8px;color:var(--orange);font-size:12px;white-space:pre-wrap;">${_escapeHtml(card.error)}</div>` : ''}</div>`;
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${_escapeHtml(card.error || 'Thất bại')}</div>`;
      if (hasOutput && videoUrl) return `<video src="${videoUrl}" controls preload="metadata"></video>`;
      return '<span>Chưa có preview</span>';
    })();

    const outputNav = hasOutput && card.outputs.length > 1
      ? `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);">
          <button class="btn btn-secondary btn-sm" onclick="SETab.prevOutput('${card.id}')" ${card.outputIndex === 0 ? 'disabled' : ''}>‹</button>
          ${card.outputIndex + 1} / ${card.outputs.length}
          <button class="btn btn-secondary btn-sm" onclick="SETab.nextOutput('${card.id}')" ${card.outputIndex >= card.outputs.length - 1 ? 'disabled' : ''}>›</button>
        </div>` : '';

    const promptBlock = `
      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>Text Prompt</span>
          <span style="font-size:10px;color:var(--text3);font-weight:400;">Nhấn để chỉnh sửa</span>
        </label>
        <div class="studio-prompt-display se-prompt-open ${!card.prompt ? 'empty' : ''}" onclick="SETab.openPrompt('${card.id}')">${card.prompt ? _escapeHtml(card.prompt) : 'Nhập prompt cho cụm này...'}</div>
      </div>
    `;

    const imageBlock = `
      <div class="studio-strip-block se-startend-block">
        <div class="studio-ref-head">
          <div class="studio-ref-head-left">
            <span class="studio-ref-title">Ảnh Start - End</span>
          </div>
        </div>
        <div class="se-startend-pair">
          ${_imgSlotHtml('start', card.startImg, card.id)}
          <div class="se-startend-arrow">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M5 12h14"></path>
              <path d="M12 5l7 7-7 7"></path>
            </svg>
          </div>
          ${_imgSlotHtml('end', card.endImg, card.id)}
        </div>
        <input type="file" id="se-img-file-${card.id}" accept="image/*" style="display:none" onchange="SETab.onImgFileChange(event,'${card.id}')">
      </div>
    `;

    const actionBlock = `
      <div class="se-card-actions">
        ${card.busy
          ? `<button class="btn btn-primary studio-generate-video" disabled>Đang tạo video...</button>`
          : `<button class="btn btn-primary studio-generate-video" onclick="SETab.genOne('${card.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              ${card.status === 'completed' ? 'Tạo lại' : card.status === 'failed' ? 'Thử lại' : 'Tạo video'}
            </button>`}
        ${hasOutput && !card.busy ? `
          <button class="btn btn-secondary btn-sm" onclick="SETab.saveOne('${card.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Lưu
          </button>
          ${!card.upscaling
            ? `<button class="btn btn-secondary btn-sm" onclick="SETab.upscaleOne('${card.id}')">1080p</button>`
            : `<span style="font-size:11px;color:var(--text2);">Upscaling...</span>`}
          ${outputNav}` : ''}
      </div>`;

    const outputBlocks = `
      <div class="studio-strip-block">
        <div class="studio-strip-head"><span>Video đã tạo (${card.outputs.length})</span>${outputNav}</div>
        <div class="studio-strip">
          ${card.outputs.length
            ? card.outputs.map((out, i) => {
                const u = _outputVideoUrl(out);
                return `<div class="studio-video-thumb se-video-thumb ${i === (card.outputIndex||0) ? 'active' : ''}" onclick="SETab.selectOutput('${card.id}',${i})">
                  ${u ? `<video src="${u}" muted preload="metadata"></video>` : '<div style="font-size:10px;color:var(--text3);display:flex;align-items:center;justify-content:center;height:100%;">Video</div>'}
                </div>`;
              }).join('')
            : `<div class="studio-note" style="font-size:10px;">Chưa có</div>`}
        </div>
      </div>`;

    const bodyContent = _cardLayout === 'horizontal'
      ? `
        <div class="studio-card-left">
          <div class="studio-preview-panel se-preview-panel">${previewHtml}</div>
        </div>
        <div class="studio-card-right">
          ${promptBlock}
          ${imageBlock}
          ${card.error && card.status !== 'running' && card.status !== 'failed' ? `<div class="se-error">${_escapeHtml(card.error)}</div>` : ''}
          ${actionBlock}
          <div class="studio-right-strips">${outputBlocks}</div>
        </div>
      `
      : `
        <div class="studio-preview-panel se-preview-panel">${previewHtml}</div>
        ${promptBlock}
        ${imageBlock}
        ${card.error && card.status !== 'running' && card.status !== 'failed' ? `<div class="se-error">${_escapeHtml(card.error)}</div>` : ''}
        ${actionBlock}
        ${outputBlocks}
      `;

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Cụm ${idx}</span>
        <div class="studio-toolbar-spacer"></div>
        <button class="btn btn-secondary btn-sm studio-icon-btn studio-icon-btn-danger" onclick="SETab.removeCard('${card.id}')" title="Xóa cụm" aria-label="Xóa cụm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7h18"/><path d="M8 7V5a1 1 0 011-1h6a1 1 0 011 1v2"/>
            <path d="M6 7l1 12a1 1 0 001 .9h8a1 1 0 001-.9l1-12"/>
          </svg>
        </button>
      </div>
      <div class="studio-card-body ${_cardLayout === 'horizontal' ? 'is-horizontal' : ''}">
        ${bodyContent}
      </div>`;

    if (scroll && isNew) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function rerender() {
    const container = $('se-cards');
    if (!container) return;
    // Remove cards not in list
    [...container.children].forEach(el => {
      if (!cards.find(c => 'se-card-' + c.id === el.id)) el.remove();
    });
    cards.forEach(card => renderCard(card));
    updateStats();
  }

  // ─── Card operations ────────────────────────────────────────────────────────

  function createCard(prompt = '') {
    const card = newCard(prompt);
    cards.push(card);
    renderCard(card, true);
    updateStats();
    return card;
  }

  window.SETab = {
    triggerImgPick(cardId, slot) {
      const input = $('se-img-file-' + cardId);
      if (!input) return;
      input.dataset.slot = slot;
      input.click();
    },

    onImgFileChange(e, cardId) {
      const file = e.target.files?.[0];
      if (!file) return;
      const slot = e.target.dataset.slot || 'start';
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const url = URL.createObjectURL(file);
      card[slot === 'start' ? 'startImg' : 'endImg'] = { url, file, media_id: '' };
      e.target.value = '';
      renderCard(card, false);
    },

    removeImg(cardId, slot) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      card[slot === 'start' ? 'startImg' : 'endImg'] = null;
      renderCard(card, false);
    },

    onPromptInput(e, cardId) {
      const card = cards.find(c => c.id === cardId);
      if (card) card.prompt = e.target.value;
    },

    openPrompt(cardId) {
      _openPromptModal(cards.find(c => c.id === cardId));
    },

    removeCard(cardId) {
      const idx = cards.findIndex(c => c.id === cardId);
      if (idx === -1) return;
      cards.splice(idx, 1);
      $('se-card-' + cardId)?.remove();
      updateStats();
    },

    prevOutput(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || card.outputIndex <= 0) return;
      card.outputIndex--;
      renderCard(card, false);
    },

    nextOutput(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || card.outputIndex >= card.outputs.length - 1) return;
      card.outputIndex++;
      renderCard(card, false);
    },

    selectOutput(cardId, i) {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      card.outputIndex = i;
      renderCard(card, false);
    },

    async saveOne(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || !card.outputs.length) return;
      const out = card.outputs[card.outputIndex || 0];
      const url = _outputVideoUrl(out);
      if (!url) return toast('Không có video để lưu', 'error');
      if (!cfg.saveHandle && window.showDirectoryPicker) await chooseFolder();
      const idx = String(cards.indexOf(card) + 1).padStart(3, '0');
      await saveVideo(url, `startend_${idx}.mp4`);
      toast('Đã lưu video', 'success');
    },

    async upscaleOne(cardId) {
      const card = cards.find(c => c.id === cardId);
      if (!card || !card.jobId || card.upscaling) return;
      card.upscaling = true;
      renderCard(card, false);
      try {
        const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', {
          output_index: card.outputIndex || 0,
          account_index: card.videoAccountIndex || null,
        });
        if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
          card.outputs[card.outputIndex || 0] = { ...card.outputs[card.outputIndex || 0], ...res.outputs[0], _upscaled: true };
          if (res.account_index) card.videoAccountIndex = res.account_index;
          toast('Upscale 1080p thành công', 'success');
        } else {
          toast('Upscale thất bại', 'error');
        }
      } catch (err) {
        toast('Upscale lỗi: ' + err.message, 'error');
      } finally {
        card.upscaling = false;
        renderCard(card, false);
      }
    },

    async genOne(cardId) {
      await _genVideo(cardId);
    },
  };

  // ─── Generate (multipart/form-data — match router signature) ────────────────

  async function _genVideo(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card || card.busy) return;
    if (!card.startImg) return toast('Cần chọn ảnh đầu (Start)', 'error');

    const sem = window._seSemaphore || (window._seSemaphore = makeSemaphore(2));
    await sem(async () => {
      if (stopAll) return;
      card.busy = true;
      card.status = 'running';
      card.error = '';
      renderCard(card, false);
      updateStats();

      const MAX_RETRY = 2;
      let attempt = 0;
      let succeeded = false;

      while (attempt <= MAX_RETRY && !stopAll && !succeeded) {
        if (attempt > 0) {
          card.error = `Đang thử lại ${attempt}/${MAX_RETRY}...`;
          renderCard(card, false);
          await new Promise(r => setTimeout(r, 2000));
        }
        try {
          // Build FormData with image files (router expects UploadFile)
          const fd = new FormData();
          fd.append('prompt', card.prompt || 'Smooth transition');
          fd.append('aspect_ratio', cfg.aspect);
          fd.append('output_count', '1');
          fd.append('model', cfg.model);
          fd.append('duration_seconds', String(cfg.durationSeconds || 8));
          if (accountIndex !== null) fd.append('account_index', String(accountIndex));

          let startFile = card.startImg.file;
          if (!startFile && card.startImg.url) startFile = await urlToFile(card.startImg.url, 'start.jpg');
          if (!startFile) throw new Error('Không lấy được file ảnh đầu');
          fd.append('start_image', startFile, startFile.name || 'start.jpg');

          if (card.endImg) {
            let endFile = card.endImg.file;
            if (!endFile && card.endImg.url) endFile = await urlToFile(card.endImg.url, 'end.jpg');
            if (endFile) fd.append('end_image', endFile, endFile.name || 'end.jpg');
          }

          const res = await API.postForm('/api/veo/startend-video', fd);
          if (!res.ok || !res.job_id) throw new Error(res.detail || res.message || 'Tạo video thất bại');

          card.jobId = res.job_id;
          card.videoAccountIndex = res.account_index || accountIndex || null;

          await pollJob(res.job_id, async job => {
            if (stopAll) return;
            if (job.status === 'completed' || job.status === 'done') {
              const newOutputs = Array.isArray(job.outputs) ? job.outputs.filter(Boolean) : [];
              if (newOutputs.length) {
                const prevCount = card.outputs.length;
                card.outputs = card.outputs.concat(newOutputs);
                card.outputIndex = prevCount;
                succeeded = true;
              }
              card.status = succeeded ? 'completed' : 'failed';
              card.error = succeeded ? '' : 'Không có video trả về';
            } else if (job.status === 'failed') {
              card.error = job.error || job.detail || 'Tạo video thất bại';
            }
          });

          if (succeeded) {
            if (cfg.autoUpscale) await SETab.upscaleOne(card.id);
            if (cfg.autoDownload) await SETab.saveOne(card.id);
          }
        } catch (err) {
          card.error = err.message || String(err);
        }
        attempt++;
        if (!succeeded && attempt <= MAX_RETRY) card.status = 'running';
      }

      if (!succeeded && !card.outputs.length) {
        card.status = 'failed';
      } else if (card.outputs.length) {
        card.status = 'completed';
        card.error = '';
      }

      card.busy = false;
      renderCard(card, false);
      updateStats();
    });
  }

  // ─── Import Prompts ──────────────────────────────────────────────────────────

  function importPrompts(file, mode = 'txt') {
    const reader = new FileReader();
    reader.onload = e => {
      const raw = e.target.result;
      const items = mode === 'json' ? parseJsonPromptCards(raw) : parsePrompts(raw).map(p => ({ prompt: p }));
      if (!items.length) return toast('File trống hoặc không đúng định dạng', 'error');
      if (cards.length > 0) {
        if (items.length !== cards.length) {
          return toast(`Số prompt (${items.length}) không khớp số card (${cards.length})`, 'error');
        }
        cards.forEach((card, i) => { card.prompt = items[i].prompt; });
        rerender();
        toast('Đã thay thế ' + items.length + ' prompt', 'success');
      } else {
        items.forEach(item => createCard(item.prompt));
        updateStats();
        toast('Đã import ' + items.length + ' card', 'success');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function importPromptsXlsx(file) {
    if (typeof XLSX === 'undefined') return toast('Thư viện XLSX chưa được tải', 'error');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const prompts = rows.map(row => (Array.isArray(row) ? row : [row]).join('\t').trim()).filter(Boolean);
        if (!prompts.length) return toast('File Excel trống', 'error');
        if (cards.length > 0) {
          if (prompts.length !== cards.length) return toast(`Số prompt (${prompts.length}) không khớp số card (${cards.length})`, 'error');
          cards.forEach((card, i) => { card.prompt = prompts[i]; });
          rerender();
          toast('Đã thay thế ' + prompts.length + ' prompt từ Excel', 'success');
        } else {
          prompts.forEach(p => createCard(p));
          toast('Đã import ' + prompts.length + ' card từ Excel', 'success');
        }
      } catch (err) { toast('Lỗi đọc Excel: ' + err.message, 'error'); }
    };
    reader.readAsArrayBuffer(file);
  }

  function _imageObjFromFile(file) {
    return { url: URL.createObjectURL(file), file, media_id: '' };
  }

  function _ensureCardsForImageImport(count) {
    if (cards.length > 0) return cards.length === count;
    for (let i = 0; i < count; i++) createCard('');
    return true;
  }

  function _filesFromInput(e) {
    return Array.from(e.target.files || []).filter(file => String(file.type || '').startsWith('image/'));
  }

  function _closeImageImportModal() {
    const modal = $('se-import-images-popup');
    if (modal) modal.style.display = 'none';
  }

  function openImageImportModal() {
    const modal = $('se-import-images-popup');
    const next = $('se-import-images-next');
    if (next) next.style.display = _pendingStartImportFiles.length ? 'flex' : 'none';
    const nextText = $('se-import-images-next-text');
    if (nextText && _pendingStartImportFiles.length) {
      nextText.textContent = `Đã chọn ${_pendingStartImportFiles.length} ảnh Start. Chọn tiếp list ảnh End.`;
    }
    if (modal) modal.style.display = 'flex';
  }

  function importStartImageList(files) {
    if (!files.length) return toast('Không có ảnh Start hợp lệ', 'error');
    if (!_ensureCardsForImageImport(files.length)) {
      return toast(`Số ảnh Start (${files.length}) không khớp số cụm hiện tại (${cards.length})`, 'error');
    }
    _pendingStartImportFiles = files;
    cards.forEach((card, i) => {
      card.startImg = _imageObjFromFile(files[i]);
    });
    rerender();
    updateStats();
    toast(`Đã import ${files.length} ảnh Start. Bấm chọn tiếp list ảnh End.`, 'info');
    openImageImportModal();
  }

  function importEndImageList(files) {
    if (!_pendingStartImportFiles.length) return toast('Chưa chọn list ảnh Start', 'error');
    if (files.length !== cards.length) {
      return toast(`Số ảnh End (${files.length}) không khớp số cụm (${cards.length})`, 'error');
    }
    cards.forEach((card, i) => {
      if (!card.startImg && _pendingStartImportFiles[i]) card.startImg = _imageObjFromFile(_pendingStartImportFiles[i]);
      card.endImg = _imageObjFromFile(files[i]);
    });
    _pendingStartImportFiles = [];
    _closeImageImportModal();
    rerender();
    updateStats();
    toast(`Đã import ${files.length} cặp ảnh Start - End`, 'success');
  }

  function _parsePairName(file) {
    const base = String(file.name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
    const m = base.match(/^(\d+)\s*([ab])(?:\b|[_\-\s.]|$)/i);
    if (!m) return null;
    return { index: parseInt(m[1], 10), side: m[2].toLowerCase() };
  }

  function importNamedPairs(files) {
    if (!files.length) return toast('Không có ảnh hợp lệ', 'error');
    const groups = new Map();
    const ignored = [];
    for (const file of files) {
      const parsed = _parsePairName(file);
      if (!parsed || !parsed.index) {
        ignored.push(file.name);
        continue;
      }
      const row = groups.get(parsed.index) || {};
      row[parsed.side] = file;
      groups.set(parsed.index, row);
    }
    const ordered = Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
    const complete = ordered.filter(([, row]) => row.a && row.b);
    const incomplete = ordered.filter(([, row]) => !row.a || !row.b);
    if (!complete.length) return toast('Không tìm thấy cặp ảnh dạng 1a/1b', 'error');
    if (incomplete.length) {
      const names = incomplete.map(([idx]) => idx).slice(0, 8).join(', ');
      return toast(`Thiếu ảnh a/b cho cụm: ${names}`, 'error');
    }
    if (cards.length > 0 && complete.length !== cards.length) {
      return toast(`Số cặp ảnh (${complete.length}) không khớp số cụm hiện tại (${cards.length})`, 'error');
    }
    if (cards.length === 0) complete.forEach(() => createCard(''));
    complete.forEach(([, row], i) => {
      cards[i].startImg = _imageObjFromFile(row.a);
      cards[i].endImg = _imageObjFromFile(row.b);
    });
    rerender();
    updateStats();
    const ignoredText = ignored.length ? `, bỏ qua ${ignored.length} file sai tên` : '';
    toast(`Đã import ${complete.length} cặp ảnh${ignoredText}`, 'success');
  }

  function openImportModal() {
    const modal = $('se-import-popup');
    if (!modal) return;
    const countEl = $('se-import-card-count');
    if (countEl) countEl.textContent = cards.length;
    const hint = $('se-import-replace-hint');
    if (hint) hint.style.display = cards.length > 0 ? '' : 'none';
    modal.style.display = 'flex';
  }

  // ─── Gen All ─────────────────────────────────────────────────────────────────

  async function genAll() {
    const pending = cards.filter(c => !c.busy && (c.status === 'idle' || c.status === 'failed'));
    if (!pending.length) return toast('Không có card nào chờ tạo', 'error');
    stopAll = false;
    $('se-gen-all').style.display = 'none';
    $('se-stop').style.display = '';

    let accountIndices = [null], maxConcurrent = 2;
    try { ({ accountIndices, maxConcurrent } = await _loadGenCfg()); } catch (_) {}

    window._seSemaphore = makeSemaphore(maxConcurrent);
    const n = accountIndices.length;

    if (n <= 1) {
      await Promise.all(pending.map((card, i) => (async () => {
        if (stopAll) return;
        if (i > 0) await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        await _genVideo(card.id, accountIndices[0]);
      })()));
    } else {
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        if (bi > 0) await new Promise(r => setTimeout(r, bi * 1000));
        for (let i = 0; i < bucket.length; i++) {
          if (stopAll) return;
          if (i > 0) await new Promise(r => setTimeout(r, 1500));
          await _genVideo(bucket[i].id, accountIndices[bi]);
        }
      }));
    }

    stopAll = false;
    $('se-gen-all').style.display = '';
    $('se-stop').style.display = 'none';
    updateStats();
  }

  async function saveAll() {
    const done = cards.filter(c => c.outputs && c.outputs.length);
    if (!done.length) return toast('Chưa có video nào', 'error');
    if (!cfg.saveHandle && window.showDirectoryPicker) await chooseFolder();
    for (const card of done) {
      const out = card.outputs[card.outputIndex || 0];
      const url = _outputVideoUrl(out);
      if (url) await saveVideo(url, `startend_${String(cards.indexOf(card) + 1).padStart(3, '0')}.mp4`);
    }
    toast(`Đã lưu ${done.length} video`, 'success');
  }

  // ─── Fancy dropdown (mirror Studio _enhanceStudioSelect) ────────────────────

  function _seIcon(svg, tone) { return { svg, tone }; }

  function _seGetIcon(selectId, value) {
    if (selectId === 'se-model') {
      if (value === 'flow_lite_low_priority') return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 13h9"/><path d="M4 18h6"/><path d="M14 6l2 2 4-4"/><path d="M14 13h6"/><path d="M14 18h3"/></svg>', 'teal');
      if (value === 'flow_lite')              return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L4 14h7l-1 8 10-14h-7l0-6z"/></svg>', 'orange');
      if (value === 'flow_fast_relaxed')      return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>', 'violet');
      if (value === 'flow_fast_no_ultra')     return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>', 'blue');
      if (value === 'omni_flash')             return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L5 13h6l-1 9 9-13h-6l0-7z"/><path d="M4 4l3 3"/><path d="M17 17l3 3"/></svg>', 'violet');
      return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8z"/></svg>', 'green');
    }
    return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>', 'slate');
  }

  function _seGetLabel(selectId, value, text) {
    return text || '';
  }

  function _seGetBadge(selectId, value) {
    return '';
  }

  function _seModelCredit(opt) {
    if (!opt) return '';
    if (opt.value !== 'omni_flash') return opt.dataset?.credit || '';
    const map = { 4: 15, 6: 20, 8: 25, 10: 30 };
    const seconds = parseInt(cfg.durationSeconds || 8, 10) || 8;
    return `${map[seconds] || 25} credit`;
  }

  function _seIconHtml(selectId, value) {
    const ic = _seGetIcon(selectId, value);
    const badge = _seGetBadge(selectId, value);
    return `<span class="studio-dd-icon-wrap"><span class="studio-dd-icon tone-${ic.tone}">${ic.svg}</span>${badge ? `<span class="studio-dd-badge">${badge}</span>` : ''}</span>`;
  }

  function _enhanceSESelect(selectEl) {
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
      const selectedText = _seGetLabel(selectId, selectEl.value, selectedOpt?.textContent?.trim() || '');
      const selectedCredit = selectId === 'se-model' ? _seModelCredit(selectedOpt) : '';
      trigger.innerHTML = `
        <span class="studio-dd-trigger-main">
          ${_seIconHtml(selectId, selectEl.value)}
          <span class="studio-dd-copy">
            <span class="studio-dd-trigger-text">${selectedText}</span>
            ${selectedCredit ? `<span class="studio-dd-credit">${selectedCredit}</span>` : ''}
          </span>
        </span>
        <span class="studio-dd-caret">⌄</span>`;

      menu.innerHTML = '';
      Array.from(selectEl.options).forEach(opt => {
        const val = opt.value;
        const label = _seGetLabel(selectId, val, opt.textContent.trim());
        const credit = selectId === 'se-model' ? _seModelCredit(opt) : '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'studio-dd-option' + (val === selectEl.value ? ' active' : '');
        btn.innerHTML = `
          <span class="studio-dd-option-main">
            ${_seIconHtml(selectId, val)}
            <span class="studio-dd-copy">
              <span class="studio-dd-option-text">${label}</span>
              ${credit ? `<span class="studio-dd-credit">${credit}</span>` : ''}
            </span>
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

  function _syncSEDurationControls() {
    const group = $('se-duration-group');
    if (!group) return;
    const omni = cfg.model === 'omni_flash';
    if (!omni) cfg.durationSeconds = 8;
    group.classList.toggle('is-locked', !omni);
    group.querySelectorAll('.se-duration-btn').forEach(btn => {
      const value = parseInt(btn.dataset.val, 10) || 8;
      btn.classList.toggle('active', value === cfg.durationSeconds);
      btn.disabled = !omni;
      btn.setAttribute('aria-disabled', String(!omni));
    });
  }

  function _applySECardLayout() {
    const cardsEl = $('se-cards');
    const btn = $('se-layout-toggle');
    if (!cardsEl || !btn) return;
    const label = btn.querySelector('.studio-layout-toggle-label');
    const icon = btn.querySelector('svg');
    if (_cardLayout === 'horizontal') {
      cardsEl.classList.add('layout-horizontal');
      if (icon) icon.innerHTML = '<rect x="3" y="3" width="18" height="8" rx="1"></rect><rect x="3" y="13" width="18" height="8" rx="1"></rect>';
      if (label) label.textContent = 'Cụm dọc';
    } else {
      cardsEl.classList.remove('layout-horizontal');
      if (icon) icon.innerHTML = '<rect x="3" y="3" width="8" height="18" rx="1"></rect><rect x="13" y="3" width="8" height="18" rx="1"></rect>';
      if (label) label.textContent = 'Cụm ngang';
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  window.init_startend_video = function () {
    if (ready) return;
    ready = true;

    // Aspect ratio buttons
    document.querySelectorAll('.se-aspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.se-aspect-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cfg.aspect = btn.dataset.val;
      });
    });

    // Model
    const modelSel = $('se-model');
    if (modelSel) modelSel.addEventListener('change', e => { cfg.model = e.target.value; _syncSEDurationControls(); });

    cfg.outputCount = 1;

    // Enhance selects to fancy Studio dropdowns
    _enhanceSESelect(modelSel);
    _syncSEDurationControls();
    _applySECardLayout();

    $('se-layout-toggle')?.addEventListener('click', () => {
      _cardLayout = _cardLayout === 'horizontal' ? 'vertical' : 'horizontal';
      localStorage.setItem('seCardLayout', _cardLayout);
      _applySECardLayout();
      rerender();
    });

    document.querySelectorAll('.se-duration-btn').forEach(btn => btn.addEventListener('click', () => {
      if (cfg.model !== 'omni_flash') return;
      cfg.durationSeconds = parseInt(btn.dataset.val, 10) || 8;
      _syncSEDurationControls();
      $('se-model')?.dispatchEvent(new Event('change', { bubbles: true }));
    }));

    // Auto upscale / download
    $('se-auto-upscale')?.addEventListener('change', e => { cfg.autoUpscale = e.target.checked; });
    $('se-auto-download')?.addEventListener('change', e => {
      if (e.target.checked && !cfg.saveHandle) {
        // User turned on but no folder — open picker, if cancelled turn off
        chooseFolder().then(() => {
          if (!cfg.saveHandle) {
            e.target.checked = false;
            cfg.autoDownload = false;
          } else {
            cfg.autoDownload = true;
          }
        });
      } else {
        cfg.autoDownload = e.target.checked;
      }
    });

    // Folder
    $('se-choose-folder')?.addEventListener('click', chooseFolder);

    // Filter dropdown
    const filterToggle = $('se-filter-toggle');
    const filterMenu = $('se-filter-menu');
    if (filterToggle && filterMenu) {
      filterToggle.addEventListener('click', () => {
        const isOpen = filterMenu.classList.toggle('open');
        filterToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
      filterMenu.querySelectorAll('[data-se-filter]').forEach(btn => {
        btn.addEventListener('click', () => setFilter(btn.dataset.seFilter));
      });
      document.addEventListener('click', e => {
        if (!filterToggle.contains(e.target) && !filterMenu.contains(e.target)) {
          filterMenu.classList.remove('open');
          filterToggle.setAttribute('aria-expanded', 'false');
        }
      }, true);
    }

    // Toggle toolbar (Ẩn/hiện)
    const toggleToolbarBtn = $('se-toggle-toolbar');
    const stickyBar = $('se-sticky-bar');
    if (toggleToolbarBtn && stickyBar) {
      toggleToolbarBtn.addEventListener('click', () => {
        const collapsed = stickyBar.classList.toggle('studio-toolbar-collapsed');
        toggleToolbarBtn.textContent = collapsed ? 'Hiện Toolbar' : 'Ẩn Toolbar';
      });
    }

    // Save quality menu
    const sqToggle = $('se-save-quality-toggle');
    const sqMenu = $('se-save-quality-menu');
    if (sqToggle && sqMenu) {
      sqToggle.addEventListener('click', e => {
        e.stopPropagation();
        sqMenu.style.display = sqMenu.style.display === 'block' ? 'none' : 'block';
      });
      sqMenu.querySelectorAll('.studio-quality-opt').forEach(opt => {
        opt.addEventListener('click', () => {
          const q = opt.dataset.q;
          cfg.saveQuality = q;
          cfg.autoUpscale = (q === '1080' || q === '4k');
          sqToggle.textContent = q + 'p ▾';
          // update checkmark
          sqMenu.querySelectorAll('.studio-quality-opt svg').forEach(svg => svg.style.opacity = '0');
          opt.querySelector('svg').style.opacity = '1';
          sqMenu.style.display = 'none';
          if ($('se-auto-upscale')) $('se-auto-upscale').checked = cfg.autoUpscale;
        });
      });
      document.addEventListener('click', () => { sqMenu.style.display = 'none'; }, true);
    }

    // Buttons
    $('se-gen-all')?.addEventListener('click', genAll);
    $('se-stop')?.addEventListener('click', () => {
      stopAll = true;
      const el = $('se-stop');
      if (el) el.textContent = 'Đang dừng...';
    });
    $('se-save-all')?.addEventListener('click', saveAll);
    $('se-clear-all')?.addEventListener('click', () => {
      if (!cards.length) return toast('Không có card nào', 'info');
      if (!confirm('Xóa toàn bộ card?')) return;
      cards = [];
      const container = $('se-cards');
      if (container) container.innerHTML = '';
      updateStats();
      toast('Đã xóa tất cả card', 'success');
    });
    $('se-add-card')?.addEventListener('click', () => {
      const dialog = $('se-add-card-dialog');
      if (dialog) {
        dialog.style.display = 'flex';
        if ($('se-add-card-count')) $('se-add-card-count').value = '1';
      } else {
        createCard('');
      }
    });
    $('se-add-card-confirm')?.addEventListener('click', () => {
      const n = Math.max(1, Math.min(200, parseInt($('se-add-card-count')?.value || '1', 10) || 1));
      for (let i = 0; i < n; i++) createCard('');
      if ($('se-add-card-dialog')) $('se-add-card-dialog').style.display = 'none';
      toast('Đã thêm ' + n + ' cụm', 'success');
    });
    $('se-add-card-dialog')?.addEventListener('click', e => {
      if (e.target === $('se-add-card-dialog')) $('se-add-card-dialog').style.display = 'none';
    });

    // Import image modal
    $('se-import-images')?.addEventListener('click', openImageImportModal);
    $('se-import-images-two-lists')?.addEventListener('click', () => {
      _closeImageImportModal();
      _pendingStartImportFiles = [];
      $('se-images-start-files')?.click();
    });
    $('se-import-images-pairs')?.addEventListener('click', () => {
      _closeImageImportModal();
      $('se-images-pair-files')?.click();
    });
    $('se-import-images-popup')?.addEventListener('click', e => {
      if (e.target === $('se-import-images-popup')) $('se-import-images-popup').style.display = 'none';
    });
    $('se-import-images-end-next')?.addEventListener('click', () => {
      $('se-images-end-files')?.click();
    });
    $('se-images-start-files')?.addEventListener('change', e => {
      const files = _filesFromInput(e);
      e.target.value = '';
      importStartImageList(files);
    });
    $('se-images-end-files')?.addEventListener('change', e => {
      const files = _filesFromInput(e);
      e.target.value = '';
      importEndImageList(files);
    });
    $('se-images-pair-files')?.addEventListener('change', e => {
      const files = _filesFromInput(e);
      e.target.value = '';
      importNamedPairs(files);
    });

    // Import prompt modal
    $('se-import-prompt')?.addEventListener('click', openImportModal);
    $('se-import-text-btn')?.addEventListener('click', () => {
      $('se-import-popup').style.display = 'none';
      $('se-prompts-file-txt').click();
    });
    $('se-import-json-btn')?.addEventListener('click', () => {
      $('se-import-popup').style.display = 'none';
      $('se-prompts-file-json').click();
    });
    $('se-import-xlsx-btn')?.addEventListener('click', () => {
      $('se-import-popup').style.display = 'none';
      $('se-prompts-file-xlsx').click();
    });
    $('se-prompts-file-txt')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) importPrompts(file, 'txt');
      e.target.value = '';
    });
    $('se-prompts-file-json')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) importPrompts(file, 'json');
      e.target.value = '';
    });
    $('se-prompts-file-xlsx')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) importPromptsXlsx(file);
      e.target.value = '';
    });
    $('se-import-popup')?.addEventListener('click', e => {
      if (e.target === $('se-import-popup')) $('se-import-popup').style.display = 'none';
    });

    updateStats();
  };
})();
