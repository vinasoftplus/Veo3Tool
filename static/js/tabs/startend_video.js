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
    outputCount: 1,
    autoUpscale: false,
    autoDownload: false,
    saveHandle: null,
    saveFolder: '',
    saveQuality: '1080',
  };

  let _activeFilter = 'all';

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
      if (acc && (acc.ACCESS_TOKEN || acc.COOKIE)) activeIndices.push(i);
    }
    const maxConcurrent = Math.min(3, Math.max(1, parseInt(d.MAX_CONCURRENT || '2', 10) || 2));
    return { accountIndices: activeIndices.length > 0 ? activeIndices : [null], maxConcurrent };
  }

  async function pollJob(jobId, callback) {
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const job = await API.get('/api/veo/job/' + jobId);
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

  function _imgSlotHtml(slot, imgObj, cardId) {
    const label = slot === 'start' ? 'Ảnh Start' : 'Ảnh End';
    if (!imgObj) {
      return `
        <div class="se-slot-wrap">
          <div class="se-slot-label">${label}</div>
          <label class="se-img-slot se-img-slot--empty" onclick="SETab.triggerImgPick('${cardId}','${slot}')">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.35"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 3-3 5 5"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>
            <span style="font-size:11px;color:var(--text3);margin-top:4px;">Chọn ảnh</span>
          </label>
        </div>`;
    }
    return `
      <div class="se-slot-wrap">
        <div class="se-slot-label">${label}</div>
        <div class="se-img-slot se-img-slot--filled" style="position:relative;cursor:pointer;" onclick="SETab.triggerImgPick('${cardId}','${slot}')">
          <img src="${imgObj.url}" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">
          <button class="se-img-remove" onclick="event.stopPropagation();SETab.removeImg('${cardId}','${slot}')" title="Xóa ảnh">
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
    const statusCls = { idle: '', running: 'status-running', completed: 'status-done', failed: 'status-failed' }[card.status] || '';
    const hasOutput = card.outputs && card.outputs.length > 0;
    const curOut = hasOutput ? card.outputs[card.outputIndex || 0] : null;
    const videoUrl = curOut ? (curOut.video_url || curOut.videoUri || curOut.fifeUrl || '') : '';

    // Left: preview panel
    const previewHtml = hasOutput && videoUrl
      ? `<video src="${videoUrl}" controls style="width:100%;height:100%;object-fit:contain;border-radius:10px;background:#000;" preload="metadata"></video>`
      : `<div class="studio-preview-panel" style="display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;height:100%;">Chưa có preview</div>`;

    const outputNav = hasOutput && card.outputs.length > 1
      ? `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);">
          <button class="btn btn-secondary btn-sm" onclick="SETab.prevOutput('${card.id}')" ${card.outputIndex === 0 ? 'disabled' : ''}>‹</button>
          ${card.outputIndex + 1} / ${card.outputs.length}
          <button class="btn btn-secondary btn-sm" onclick="SETab.nextOutput('${card.id}')" ${card.outputIndex >= card.outputs.length - 1 ? 'disabled' : ''}>›</button>
        </div>` : '';

    // Right panel
    const rightHtml = `
      <div class="se-right-prompt">
        <div class="se-slot-label" style="margin-bottom:6px;">Text Prompt</div>
        <textarea class="se-prompt-ta" placeholder="Mô tả chuyển động (để trống = smooth transition)"
          oninput="SETab.onPromptInput(event,'${card.id}')">${card.prompt || ''}</textarea>
      </div>

      <div class="se-images-row">
        ${_imgSlotHtml('start', card.startImg, card.id)}
        <div class="se-arrow-mid">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
        ${_imgSlotHtml('end', card.endImg, card.id)}
      </div>

      <input type="file" id="se-img-file-${card.id}" accept="image/*" style="display:none" onchange="SETab.onImgFileChange(event,'${card.id}')">

      ${card.error ? `<div class="se-error">${card.error}</div>` : ''}

      <div class="se-card-actions">
        ${card.busy
          ? `<button class="btn btn-primary" disabled>Đang tạo...</button>`
          : `<button class="btn btn-primary" onclick="SETab.genOne('${card.id}')">
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
      </div>

      <div class="se-video-strip">
        <div class="se-slot-label" style="margin-bottom:6px;">Video đã tạo (${card.outputs.length})</div>
        <div class="se-strip">
          ${card.outputs.length
            ? card.outputs.map((out, i) => {
                const u = out.video_url || out.videoUri || out.fifeUrl || '';
                return `<div class="se-video-thumb ${i === (card.outputIndex||0) ? 'active' : ''}" onclick="SETab.selectOutput('${card.id}',${i})">
                  ${u ? `<video src="${u}" muted preload="metadata"></video>` : '<div style="font-size:10px;color:var(--text3);display:flex;align-items:center;justify-content:center;height:100%;">Video</div>'}
                </div>`;
              }).join('')
            : `<div style="font-size:12px;color:var(--text3);">Chưa có</div>`}
        </div>
      </div>`;

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Card ${idx}</span>
        <div class="studio-toolbar-spacer"></div>
        <button class="btn btn-secondary btn-sm studio-icon-btn studio-icon-btn-danger" onclick="SETab.removeCard('${card.id}')" title="Xóa card">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7h18"/><path d="M8 7V5a1 1 0 011-1h6a1 1 0 011 1v2"/>
            <path d="M6 7l1 12a1 1 0 001 .9h8a1 1 0 001-.9l1-12"/>
          </svg>
        </button>
      </div>
      <div class="studio-card-body is-horizontal se-card-body-h">
        <div class="studio-card-left">
          <div class="studio-preview-panel se-preview-panel">
            ${previewHtml}
          </div>
        </div>
        <div class="studio-card-right">
          ${rightHtml}
        </div>
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
      const url = out.video_url || out.videoUri || out.fifeUrl;
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
          fd.append('output_count', String(cfg.outputCount));
          fd.append('model', cfg.model);
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
      const url = out.video_url || out.videoUri || out.fifeUrl;
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
      return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8z"/></svg>', 'green');
    }
    if (selectId === 'se-output-count') {
      return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></svg>', 'blue');
    }
    return _seIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>', 'slate');
  }

  function _seGetLabel(selectId, value, text) {
    if (selectId === 'se-output-count') return (parseInt(value, 10) || 1) + ' video';
    return text || '';
  }

  function _seGetBadge(selectId, value) {
    if (selectId === 'se-output-count') return String(parseInt(value, 10) || 1);
    return '';
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
      const selectedCredit = selectId === 'se-model' ? (selectedOpt?.dataset?.credit || '') : '';
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
        const credit = selectId === 'se-model' ? (opt.dataset.credit || '') : '';
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
    if (modelSel) modelSel.addEventListener('change', e => { cfg.model = e.target.value; });

    // Output count (select)
    const outputCountSel = $('se-output-count');
    if (outputCountSel) outputCountSel.addEventListener('change', e => {
      cfg.outputCount = parseInt(e.target.value, 10) || 1;
    });

    // Enhance selects to fancy Studio dropdowns
    _enhanceSESelect(modelSel);
    _enhanceSESelect(outputCountSel);

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
    $('se-add-card')?.addEventListener('click', () => createCard(''));

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
