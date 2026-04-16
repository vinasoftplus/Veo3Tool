/* Image-to-Video multi-card tab */
(function () {
  'use strict';

  const CFG = {
    aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    model: 'auto',
    count: 1,
    autoUpscale: false,
    autoDownload: false,
    saveFolder: '',
    _saveHandle: null,
  };

  let cards = [];
  let seq = 0;
  let stopFlag = false;

  const $ = id => document.getElementById(id);

  function cardsEl() {
    return $('i2v-cards');
  }

  function reRenderAllCards() {
    const container = cardsEl();
    container.innerHTML = '';
    cards.forEach(card => renderCard(card, true));
    refreshStats();
  }

  function newCard(prompt = '') {
    return {
      id: 'i2v-' + (++seq),
      prompt,
      file: null,
      previewUrl: '',
      status: 'idle',
      jobId: null,
      outputs: [],
      currentIdx: 0,
      upscaling: false,
      error: '',
    };
  }

  let _activeFilter = 'all';

  function applyFilter() {
    const container = document.getElementById('i2v-cards');
    if (!container) return;
    container.querySelectorAll('.t2v-card').forEach(el => {
      const card = cards.find(c => 'card-' + c.id === el.id);
      if (!card) return;
      if (_activeFilter === 'all') { el.style.display = ''; return; }
      if (_activeFilter === 'running') {
        el.style.display = (card.status === 'running') ? '' : 'none';
      } else if (_activeFilter === 'completed') {
        el.style.display = card.outputs.length > 0 ? '' : 'none';
      } else {
        el.style.display = card.status === _activeFilter ? '' : 'none';
      }
    });
  }

  function refreshStats() {
    const idle = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running').length;
    const done = cards.filter(c => c.outputs.length > 0).length;
    const failed = cards.filter(c => c.status === 'failed').length;
    $('i2v-pending-count').textContent = idle;
    $('i2v-saved-count').textContent = done;
    $('i2v-empty').style.display = cards.length ? 'none' : '';
    const totalEl = $('i2v-total-count'); if (totalEl) totalEl.textContent = cards.length;
    const idleEl = $('i2v-idle-count'); if (idleEl) idleEl.textContent = idle;
    const runEl = $('i2v-running-count'); if (runEl) runEl.textContent = running;
    const doneEl = $('i2v-done-count'); if (doneEl) doneEl.textContent = done;
    const failEl = $('i2v-failed-count'); if (failEl) failEl.textContent = failed;
    ['all','idle','running','completed','failed'].forEach(f => {
      const el = $('i2v-filter-' + f);
      if (el) el.classList.toggle('active', _activeFilter === f);
    });
    applyFilter();
  }

  function resultHtml(card) {
    const out = card.outputs[card.currentIdx];
    const url = out?.video_url || out?.videoUri || out?.fifeUrl || '';
    if (card.status === 'idle') return '<div class="t2v-video-preview"><span style="opacity:.4;">Chưa tạo</span></div>';
    if (card.status === 'running') return '<div class="t2v-video-preview"><div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;width:28px;height:28px;border-width:3px;"></div><div class="pulse" style="font-size:11px;">\u0110ang t\u1ea1o video...</div></div></div>';
    if (card.status === 'failed') return `<div class="t2v-video-preview" style="color:var(--red);padding:12px;font-size:12px;">${card.error || 'Lỗi tạo video'}</div>`;
    if (!url) return '<div class="t2v-video-preview"><span style="opacity:.4;">Không có video</span></div>';
    const nav = card.outputs.length > 1
      ? `<div class="t2v-video-nav"><button class="btn btn-secondary btn-sm" onclick="I2V.prev('${card.id}')">◀</button><span>${card.currentIdx + 1} / ${card.outputs.length}</span><button class="btn btn-secondary btn-sm" onclick="I2V.next('${card.id}')">▶</button></div>`
      : '';
    return `<div class="t2v-video-preview"><video controls src="${url}" preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video></div>${nav}<div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="I2V.download('${card.id}',${card.currentIdx})">T\u1ea3i v\u1ec1</button>${CFG.autoUpscale ? '' : `<button class="btn btn-secondary btn-sm" onclick="I2V.upscale('${card.id}',${card.currentIdx})" ${card.upscaling ? 'disabled' : ''}>${card.upscaling ? '\u0110ang upscale...' : 'Upscale 1080p'}</button>`}<button class="btn btn-secondary btn-sm" onclick="I2V.genOne('${card.id}')">T\u1ea1o l\u1ea1i</button></div>`;
  }

  function bindUpload(card, el) {
    const zone = el.querySelector('.upload-zone');
    const input = el.querySelector('input[type="file"]');
    const preview = el.querySelector('img');
    zone.addEventListener('click', e => {
      if (e.target === input) return;
      input.click();
    });
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', () => {
      const f = input.files[0];
      if (!f) return;
      card.file = f;
      card.previewUrl = URL.createObjectURL(f);
      preview.src = card.previewUrl;
      preview.style.display = 'block';
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
  }

  function renderCard(card, append = false) {
    let el = $('card-' + card.id);
    if (!el) {
      el = document.createElement('div');
      el.id = 'card-' + card.id;
      el.className = 't2v-card';
    }
    const idx = cards.indexOf(card) + 1;
    const statusDot = {
      idle: '',
      running: '<span style="color:var(--accent);" class="pulse">●</span>',
      completed: '<span style="color:var(--green);">●</span>',
      failed: '<span style="color:var(--red);">●</span>',
    }[card.status] || '';
    el.innerHTML = `<div class="t2v-card-header"><span class="t2v-card-num">#${idx}</span>${statusDot}<span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(card.prompt || '').slice(0, 80) || '(trống)'}</span><button class="btn btn-secondary btn-sm" onclick="I2V.genOne('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>Tạo Video</button><div class="card-action-group" style="position:relative;display:inline-flex;"><button class="btn btn-secondary btn-sm card-insert-btn" title="Thêm card" onclick="I2V.toggleInsertMenu('${card.id}')">+ Card ▾</button><div class="card-insert-menu" id="insert-menu-${card.id}" style="display:none;"><div onclick="I2V.insertCard('${card.id}','before')">Thêm trước</div><div onclick="I2V.insertCard('${card.id}','after')">Thêm sau</div></div></div><button class="btn btn-secondary btn-sm" title="Nhân bản card" onclick="I2V.cloneCard('${card.id}')">⧉</button><button class="btn btn-secondary btn-sm" onclick="I2V.remove('${card.id}')">X</button></div><div class="t2v-card-body"><div class="t2v-card-left"><div class="form-group"><label class="form-label">Chọn ảnh đầu vào</label><div class="upload-zone"><input type="file" accept="image/*"><div>Kéo thả hoặc click để chọn ảnh</div><img style="display:${card.previewUrl ? 'block' : 'none'};" src="${card.previewUrl || ''}" alt="preview"></div></div><div class="form-group"><label class="form-label">Prompt (tùy chọn)</label><textarea rows="4" placeholder="Mô tả chuyển động...">${card.prompt || ''}</textarea></div></div><div class="t2v-card-right">${resultHtml(card)}</div></div>`;
    if (append) $('i2v-cards').appendChild(el);
    const ta = el.querySelector('textarea');
    ta.addEventListener('input', e => { card.prompt = e.target.value; refreshStats(); });
    bindUpload(card, el);
    refreshStats();
    return el;
  }

  async function downloadVideoFile(url, filename) {
    if (CFG._saveHandle) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const fileHandle = await CFG._saveHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('?? l?u ' + filename, 'success');
        return;
      } catch (_) {}
    }
    downloadUrl(url, filename);
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        CFG._saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        CFG.saveFolder = CFG._saveHandle.name;
        $('i2v-folder-label').textContent = CFG.saveFolder;
        return;
      } catch (e) {
        return;
      }
    }
    const path = prompt('Nh?p ???ng d?n folder l?u video:', CFG.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      CFG.saveFolder = path;
      $('i2v-folder-label').textContent = path;
    }
  }

  function parsePromptFile(text) {
    const scenes = [];
    const lines = text.split(/\r?\n/);
    let current = [];
    for (const line of lines) {
      if (/^SCENE\s+\d+[:\s]/i.test(line) && current.length) {
        scenes.push(current.join('\n').trim());
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.join('').trim()) scenes.push(current.join('\n').trim());
    return scenes.filter(Boolean);
  }

  function importPromptFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = String(e.target.result || '').trim();
      if (!text) return toast('File trống', 'error');
      let prompts = [];
      // JSON: mỗi object → stringify toàn bộ làm prompt
      if (text.startsWith('[') || text.startsWith('{')) {
        try {
          const data = JSON.parse(text);
          const list = Array.isArray(data) ? data : [data];
          prompts = list.map(item => typeof item === 'string' ? item.trim() : JSON.stringify(item, null, 2)).filter(Boolean);
        } catch (_) {}
      }
      if (!prompts.length) {
        prompts = /^SCENE\s+\d+[:\s]/im.test(text) ? parsePromptFile(text) : text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      prompts.forEach(prompt => { const card = newCard(prompt); cards.push(card); renderCard(card, true); });
      refreshStats();
      toast('Đã import ' + prompts.length + ' prompt', 'success');
    };
    reader.readAsText(file, 'utf-8');
  }

  function importImages(files) {
    const list = Array.from(files || []).filter(file => file && String(file.type || '').startsWith('image/'));
    if (!list.length) {
      toast('Kh?ng c? ?nh h?p l?', 'error');
      return;
    }

    list.forEach(file => {
      const card = newCard('');
      card.file = file;
      card.previewUrl = URL.createObjectURL(file);
      cards.push(card);
      renderCard(card, true);
    });

    refreshStats();
    toast('?? n?p ' + list.length + ' ?nh v?o tool', 'success');
  }

  async function autoDownloadCard(card) {
    for (let i = 0; i < card.outputs.length; i++) {
      const out = card.outputs[i];
      const url = out.video_url || out.videoUri || out.fifeUrl;
      if (!url) continue;
      await downloadVideoFile(url, 'i2v_' + String(cards.indexOf(card) + 1).padStart(3, '0') + '_' + (i + 1) + '.mp4');
    }
  }

  async function upscale(card, idx) {
    const out = card.outputs[idx];
    if (!out || card.upscaling) return;
    card.upscaling = true;
    renderCard(card, false);
    try {
      const res = await API.post('/api/veo/job/' + card.jobId + '/upscale', { operation_name: out.operation_name || '', output_index: idx });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[idx] = { ...card.outputs[idx], ...res.outputs[0] };
        toast('Upscale 1080p th?nh c?ng!', 'success');
      } else {
        toast(res.body || res.message || 'Upscale th?t b?i', 'error');
      }
    } catch (e) {
      toast('L?i upscale: ' + e.message, 'error');
    } finally {
      card.upscaling = false;
      renderCard(card, false);
    }
  }

  async function genOne(card) {
    if (!card.file) return toast('Card n?y ch?a c? ?nh', 'error');
    card.status = 'running';
    card.outputs = [];
    card.currentIdx = 0;
    renderCard(card, false);
    const fd = new FormData();
    fd.append('image', card.file);
    fd.append('prompt', card.prompt || '');
    fd.append('aspect_ratio', CFG.aspect);
    fd.append('output_count', String(CFG.count));
    fd.append('model', CFG.model);
    try {
      const res = await API.postForm('/api/veo/image-to-video', fd);
      if (!res.ok) {
        card.status = 'failed';
        card.error = res.detail || 'L?i t?o';
        renderCard(card, false);
        return;
      }
      card.jobId = res.job_id;
      // await pollJob đến khi completed/failed — semaphore giữ slot đúng
      await pollJob(res.job_id, '/api/veo/job', async job => {
        if (stopFlag) {
          card.status = 'idle';
          renderCard(card, false);
          return;
        }
        if (job.status === 'completed' || job.status === 'done') {
          const outs = Array.isArray(job.outputs) ? job.outputs : (job.outputs?.videos || []);
          card.outputs = outs.filter(Boolean);
          card.status = card.outputs.length ? 'completed' : 'failed';
          card.error = card.outputs.length ? '' : 'Không có video';
          renderCard(card, false);
          if (CFG.autoUpscale && card.outputs.length) await upscale(card, 0);
          if (CFG.autoDownload && card.outputs.length) await autoDownloadCard(card);
        } else if (job.status === 'failed') {
          card.status = 'failed';
          card.error = job.error || 'Thất bại';
          renderCard(card, false);
        }
      });
    } catch (e) {
      card.status = 'failed';
      card.error = e.message;
      renderCard(card, false);
    }
  }

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

  async function genAll() {
    const pending = cards.filter(c => c.status === 'idle');
    if (!pending.length) return toast('Không có card nào chờ tạo', 'error');
    stopFlag = false;
    $('i2v-gen-all').style.display = 'none';
    $('i2v-stop').style.display = '';

    // Lấy accounts + maxConcurrent từ config
    let accountIndices = [null], maxConcurrent = 3;
    try {
      const cfgRes = await API.get('/api/settings/config-full');
      const d = (cfgRes && cfgRes.data) ? cfgRes.data : cfgRes;
      const idxs = [];
      for (let i = 1; i <= 10; i++) {
        const acc = d[`account${i}`];
        if (acc && (acc.ACCESS_TOKEN || acc.COOKIE)) idxs.push(i);
      }
      if (idxs.length > 1) accountIndices = idxs;
      maxConcurrent = Math.min(10, Math.max(1, parseInt(d.MAX_CONCURRENT || '3', 10) || 3));
    } catch (_) {}

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = accountIndices.length;
    toast(n > 1
      ? `Chạy ${pending.length} card với ${n} tài khoản (tối đa ${maxConcurrent} job/tài khoản)`
      : `Bắt đầu tạo ${pending.length} video (tối đa ${maxConcurrent} cùng lúc)`, 'info');

    if (n <= 1) {
      const sem = makeSemaphore(maxConcurrent);
      let cardIdx = 0;
      await Promise.all(pending.map(card => sem(async () => {
        if (stopFlag) return;
        const myIdx = cardIdx++;
        if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
        await genOne(card);
      })));
    } else {
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi]; // i2v genOne chưa nhận accIdx — dự phòng tương lai
        if (bi > 0) await sleep(bi * 1000);
        const sem = makeSemaphore(maxConcurrent);
        let cardIdx = 0;
        await Promise.all(bucket.map(card => sem(async () => {
          if (stopFlag) return;
          const myIdx = cardIdx++;
          if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
          await genOne(card);
        })));
      }));
    }

    $('i2v-gen-all').style.display = '';
    $('i2v-stop').style.display = 'none';
    $('i2v-stop').textContent = 'Dừng toàn bộ';
    stopFlag = false;
  }

  async function saveAll() {
    for (const card of cards.filter(c => c.outputs.length)) await autoDownloadCard(card);
  }

  function clearAll() {
    cards = [];
    $('i2v-cards').innerHTML = '';
    refreshStats();
    toast('\u0110\u00e3 x\u00f3a to\u00e0n b\u1ed9 card', 'success');
  }

  window.I2V = {
    setFilter: f => { _activeFilter = f; refreshStats(); },
    genOne: id => { const card = cards.find(c => c.id === id); if (card) genOne(card); },
    remove: id => { cards = cards.filter(c => c.id !== id); $('card-' + id)?.remove(); refreshStats(); },
    prev: id => { const card = cards.find(c => c.id === id); if (card && card.currentIdx > 0) { card.currentIdx--; renderCard(card, false); } },
    next: id => { const card = cards.find(c => c.id === id); if (card && card.currentIdx < card.outputs.length - 1) { card.currentIdx++; renderCard(card, false); } },
    download: async (id, idx) => { const card = cards.find(c => c.id === id); if (!card) return; const out = card.outputs[idx]; const url = out?.video_url || out?.videoUri || out?.fifeUrl; if (url) await downloadVideoFile(url, 'i2v_' + String(cards.indexOf(card) + 1).padStart(3, '0') + '_' + (idx + 1) + '.mp4'); },
    upscale: async (id, idx) => { const card = cards.find(c => c.id === id); if (card) await upscale(card, idx); },
    toggleInsertMenu(cardId) {
      document.querySelectorAll('.card-insert-menu').forEach(menu => {
        if (menu.id !== `insert-menu-${cardId}`) menu.style.display = 'none';
      });
      const menu = document.getElementById(`insert-menu-${cardId}`);
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    },
    insertCard(refId, position) {
      document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
      const refIdx = cards.findIndex(card => card.id === refId);
      if (refIdx === -1) return;
      const card = newCard('');
      cards.splice(position === 'before' ? refIdx : refIdx + 1, 0, card);
      reRenderAllCards();
      setTimeout(() => {
        const ta = document.querySelector(`#card-${card.id} textarea`);
        if (ta) ta.focus();
      }, 50);
    },
    cloneCard(srcId) {
      const src = cards.find(card => card.id === srcId);
      if (!src) return;
      const clone = newCard(src.prompt);
      clone.file = src.file || null;
      clone.previewUrl = src.previewUrl || (src.file ? URL.createObjectURL(src.file) : '');
      const srcIdx = cards.indexOf(src);
      cards.splice(srcIdx + 1, 0, clone);
      reRenderAllCards();
      toast('Đã nhân bản card', 'success');
    },
  };

  window.init_image_to_video = function () {
    document.querySelectorAll('.i2v-aspect-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.i2v-aspect-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      CFG.aspect = btn.dataset.val;
    }));
    document.querySelectorAll('.i2v-count-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.i2v-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      CFG.count = parseInt(btn.dataset.val, 10);
    }));
    $('i2v-model').addEventListener('change', e => { CFG.model = e.target.value; });
    $('i2v-auto-upscale').addEventListener('change', e => { CFG.autoUpscale = e.target.checked; });
    $('i2v-auto-download').addEventListener('change', e => { CFG.autoDownload = e.target.checked; });
    $('i2v-choose-folder').addEventListener('click', chooseFolder);
    $('i2v-import-images').addEventListener('click', () => $('i2v-images-file').click());
    $('i2v-images-file').addEventListener('change', e => {
      if (e.target.files?.length) importImages(e.target.files);
      e.target.value = '';
    });
    $('i2v-import-prompt').addEventListener('click', () => $('i2v-import-file').click());
    $('i2v-import-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importPromptFile(f); e.target.value = ''; });
    $('i2v-add-card').addEventListener('click', () => { const card = newCard(''); cards.push(card); renderCard(card, true); });
    $('i2v-gen-all').addEventListener('click', genAll);
    $('i2v-stop').addEventListener('click', () => { stopFlag = true; $('i2v-stop').textContent = '\u0110ang d\u1eebng...'; });
    $('i2v-save-all').addEventListener('click', saveAll);
    $('i2v-clear-all').addEventListener('click', clearAll);
    document.addEventListener('click', e => {
      if (!e.target.closest('.card-action-group')) {
        document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
      }
    });
    refreshStats();
  };
})();
