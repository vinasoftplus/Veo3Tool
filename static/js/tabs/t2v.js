/* ── Text-to-Video — card-based UI ──────────────────────────
   State: array of card objects
   {
     id,           // unique DOM id
     prompt,       // string
     status,       // idle | running | completed | failed
     jobId,        // null | string
     outputs,      // [] of {video_url, media_id}
     currentIdx,   // which output video is showing
     chars,        // [] of {id, name, url, media_id}
   }
─────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── Config state ────────────────────────────────────────── */
  const CFG = {
    aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    model: 'auto',
    count: 1,
    autoUpscale: false,
    autoDownload: false,
    saveFolder: '',     // chosen via showDirectoryPicker or fallback
    _saveHandle: null,  // FileSystemDirectoryHandle
  };

  /* ── Cards state ─────────────────────────────────────────── */
  let cards = [];       // ordered array of card data
  let _cardSeq = 0;
  let _stopFlag = false;
  let _globalChars = []; // loaded from /api/character/list

  function newCard(prompt = '') {
    return { id: 'c' + (++_cardSeq), prompt, status: 'idle', jobId: null, outputs: [], currentIdx: 0, chars: [], upscaling: false };
  }

  /* ── DOM helpers ─────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const cardsEl = () => $('t2v-cards');
  const emptyEl = () => $('t2v-empty');

  function _reRenderAllCards() {
    const container = cardsEl();
    container.innerHTML = '';
    cards.forEach(c => renderCard(c, true));
  }

  let _activeFilter = 'all';

  function applyFilter() {
    const container = cardsEl();
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

  function refreshEmpty() {
    const empty = cards.length === 0;
    emptyEl().style.display = empty ? '' : 'none';
    const idle = cards.filter(c => c.status === 'idle').length;
    const running = cards.filter(c => c.status === 'running').length;
    const done = cards.filter(c => c.outputs.length > 0).length;
    const failed = cards.filter(c => c.status === 'failed').length;
    $('t2v-pending-count').textContent = idle;
    $('t2v-saved-count').textContent = done;
    const totalEl = $('t2v-total-count'); if (totalEl) totalEl.textContent = cards.length;
    const idleEl = $('t2v-idle-count'); if (idleEl) idleEl.textContent = idle;
    const runEl = $('t2v-running-count'); if (runEl) runEl.textContent = running;
    const doneEl = $('t2v-done-count'); if (doneEl) doneEl.textContent = done;
    const failEl = $('t2v-failed-count'); if (failEl) failEl.textContent = failed;
    ['all','idle','running','completed','failed'].forEach(f => {
      const el = $('t2v-filter-' + f);
      if (el) el.classList.toggle('active', _activeFilter === f);
    });
    applyFilter();
  }

  /* ── Render a single card ────────────────────────────────── */
  function renderCard(card, isNew = false) {
    const existing = document.getElementById(`card-${card.id}`);
    const el = existing || document.createElement('div');
    el.id = `card-${card.id}`;
    el.className = 't2v-card';

    const idx = cards.indexOf(card) + 1;
    const isPortrait = CFG.aspect === 'VIDEO_ASPECT_RATIO_PORTRAIT';
    const previewClass = isPortrait ? 't2v-video-preview portrait' : 't2v-video-preview';
    const curOut = card.outputs[card.currentIdx];
    const videoUrl = curOut?.video_url || '';

    // Preview area
    let previewHtml = '';
    if (card.status === 'idle') {
      previewHtml = `<div class="${previewClass}" id="prev-${card.id}"><span style="opacity:.4;">Chưa tạo</span></div>`;
    } else if (card.status === 'running') {
      previewHtml = `<div class="${previewClass}" id="prev-${card.id}">
        <div style="text-align:center;">
          <div class="spinner" style="margin:0 auto 8px;width:28px;height:28px;border-width:3px;"></div>
          <div class="pulse" style="font-size:11px;">Đang tạo video...</div>
        </div>
      </div>`;
    } else if (card.status === 'failed') {
      previewHtml = `<div class="${previewClass}" id="prev-${card.id}" style="color:var(--red);">
        <div style="text-align:center;padding:12px;">
          <div style="font-size:24px;margin-bottom:6px;">⚠</div>
          <div style="font-size:11px;">${card.error || 'Lỗi tạo video'}</div>
        </div>
      </div>`;
    } else if (videoUrl) {
      const navHtml = card.outputs.length > 1 ? `
        <div class="t2v-video-nav" style="padding:6px 0;">
          <button class="btn btn-secondary btn-sm" onclick="T2V.prevOutput('${card.id}')">‹</button>
          <span>${card.currentIdx + 1} / ${card.outputs.length}</span>
          <button class="btn btn-secondary btn-sm" onclick="T2V.nextOutput('${card.id}')">›</button>
        </div>` : '';
      previewHtml = `
        <div class="${previewClass}" id="prev-${card.id}">
          <video id="vid-${card.id}" src="${videoUrl}" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>
        </div>
        ${navHtml}
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="T2V.downloadCard('${card.id}',${card.currentIdx})">⬇ Tải về</button>
          ${CFG.autoUpscale ? '' : `<button class="btn btn-secondary btn-sm" onclick="T2V.upscaleCard('${card.id}',${card.currentIdx})" ${card.upscaling ? 'disabled' : ''}>${card.upscaling ? '⏳ Đang upscale...' : '⬆ Upscale 1080p'}</button>`}
          <button class="btn btn-secondary btn-sm" onclick="T2V.regenCard('${card.id}')">↺ Tạo lại</button>
        </div>`;
    }

    // Characters strip (hidden — char feature removed from T2V)
    const charHtml = '';

    // Header status
    const statusDot = {
      idle: '', running: '<span style="color:var(--accent);" class="pulse">●</span>',
      completed: '<span style="color:var(--green);">●</span>', failed: '<span style="color:var(--red);">●</span>',
    }[card.status] || '';

    el.innerHTML = `
      <div class="t2v-card-header">
        <span class="t2v-card-num">#${idx}</span>
        ${statusDot}
        <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${card.prompt.slice(0, 80) || '(trống)'}</span>
        <button class="btn btn-secondary btn-sm" onclick="T2V.genCard('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>▶ Tạo Video</button>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" title="Thêm card" onclick="T2V.toggleInsertMenu('${card.id}',this)">+ Card ▾</button>
          <div class="card-insert-menu" id="insert-menu-${card.id}" style="display:none;">
            <div onclick="T2V.insertCard('${card.id}','before')">Thêm trước</div>
            <div onclick="T2V.insertCard('${card.id}','after')">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" title="Nhân bản card" onclick="T2V.cloneCard('${card.id}')">⧉</button>
        <button class="btn btn-secondary btn-sm" onclick="T2V.deleteCard('${card.id}')">🗑</button>
      </div>
      <div class="t2v-card-body">
        <div class="t2v-card-left">
          <textarea class="t2v-prompt-input" id="prompt-${card.id}" rows="5"
            oninput="T2V.updatePrompt('${card.id}',this.value)"
            placeholder="Nhập prompt mô tả video #${idx}...">${card.prompt}</textarea>
        </div>
        <div class="t2v-card-right" id="right-${card.id}">
          ${previewHtml}
        </div>
      </div>`;

    if (isNew) cardsEl().appendChild(el);
    return el;
  }

  function reRenderRight(card) {
    const right = document.getElementById(`right-${card.id}`);
    if (!right) return;
    // Re-render only the right side
    const tmp = document.createElement('div');
    const isPortrait = CFG.aspect === 'VIDEO_ASPECT_RATIO_PORTRAIT';
    const previewClass = isPortrait ? 't2v-video-preview portrait' : 't2v-video-preview';
    const curOut = card.outputs[card.currentIdx];
    const videoUrl = curOut?.video_url || '';

    if (card.status === 'idle') {
      right.innerHTML = `<div class="${previewClass}"><span style="opacity:.4;">Chưa tạo</span></div>`;
    } else if (card.status === 'running') {
      right.innerHTML = `<div class="${previewClass}">
        <div style="text-align:center;">
          <div class="spinner" style="margin:0 auto 8px;width:28px;height:28px;border-width:3px;"></div>
          <div class="pulse" style="font-size:11px;">Đang tạo video...</div>
        </div>
      </div>`;
    } else if (card.status === 'failed') {
      right.innerHTML = `<div class="${previewClass}" style="color:var(--red);">
        <div style="text-align:center;padding:12px;">
          <div style="font-size:24px;margin-bottom:6px;">⚠</div>
          <div style="font-size:11px;">${card.error || 'Lỗi'}</div>
        </div>
      </div>`;
    } else if (videoUrl) {
      const navHtml = card.outputs.length > 1 ? `
        <div class="t2v-video-nav">
          <button class="btn btn-secondary btn-sm" onclick="T2V.prevOutput('${card.id}')">‹</button>
          <span>${card.currentIdx + 1} / ${card.outputs.length}</span>
          <button class="btn btn-secondary btn-sm" onclick="T2V.nextOutput('${card.id}')">›</button>
        </div>` : '';
      right.innerHTML = `
        <div class="${previewClass}">
          <video src="${videoUrl}" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>
        </div>
        ${navHtml}
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="T2V.downloadCard('${card.id}',${card.currentIdx})">⬇ Tải về</button>
          ${CFG.autoUpscale ? '' : `<button class="btn btn-secondary btn-sm" onclick="T2V.upscaleCard('${card.id}',${card.currentIdx})" ${card.upscaling ? 'disabled' : ''}>${card.upscaling ? '⏳ Đang upscale...' : '⬆ Upscale 1080p'}</button>`}
          <button class="btn btn-secondary btn-sm" onclick="T2V.regenCard('${card.id}')">↺ Tạo lại</button>
        </div>`;
    }

    // Update header status dot + generate button
    const header = document.querySelector(`#card-${card.id} .t2v-card-header`);
    if (header) {
      const genBtn = header.querySelector('button');
      if (genBtn) genBtn.disabled = card.status === 'running';
      const dot = header.querySelector('span[class]');
      // just re-render header text (simpler to update num indicator)
      const numSpan = header.querySelector('.t2v-card-num');
      if (numSpan) {
        const statusDot = {
          idle: '', running: '<span style="color:var(--accent);" class="pulse">●</span>',
          completed: '<span style="color:var(--green);">●</span>', failed: '<span style="color:var(--red);">●</span>',
        }[card.status] || '';
        // replace second span child
        const existingDot = header.children[1];
        if (existingDot && existingDot !== genBtn) {
          const tmp2 = document.createElement('span');
          tmp2.innerHTML = statusDot;
          if (tmp2.firstChild) header.replaceChild(tmp2.firstChild, existingDot);
        }
      }
    }
    refreshEmpty();
  }

  /* ── Generate a single card ──────────────────────────────── */
  async function genCard(card, accountIndex = null) {
    if (card.status === 'running') return;
    card.status = 'running';
    card.outputs = [];
    card.currentIdx = 0;
    reRenderRight(card);

    try {
      // Build request — use character media_ids if present
      let res;
      if (card.chars.length > 0) {
        // Consistent video
        res = await API.post('/api/veo/consistent-video', {
          prompt: card.prompt,
          character_ids: card.chars.map(c => c.id),
          aspect_ratio: CFG.aspect,
          output_count: CFG.count,
          ...(accountIndex != null ? { account_index: accountIndex } : {}),
        });
      } else {
        res = await API.post('/api/veo/text-to-video', {
          prompts: [card.prompt],
          aspect_ratio: CFG.aspect,
          output_count: CFG.count,
          model: CFG.model,
          ...(accountIndex != null ? { account_index: accountIndex } : {}),
        });
      }

      if (!res.ok) {
        card.status = 'failed';
        card.error = res.detail || 'API lỗi';
        reRenderRight(card);
        return;
      }

      const jobId = (res.job_ids && res.job_ids[0]) || res.job_id;
      card.jobId = jobId;

      // Poll
      await new Promise((resolve) => {
        pollJob(jobId, '/api/veo/job', async (job) => {
          if (_stopFlag) {
            card.status = 'idle';
            reRenderRight(card);
            resolve();
            return;
          }
          if (job.status === 'completed' || job.status === 'done') {
            const rawOutputs = Array.isArray(job.outputs) ? job.outputs : [];
            card.outputs = rawOutputs.filter(v => v.video_url || v.videoUri || v.fifeUrl);
            card.status = card.outputs.length ? 'completed' : 'failed';
            card.error = card.outputs.length ? null : 'Không có video';
            reRenderRight(card);

            // Auto upscale
            if (CFG.autoUpscale && card.outputs.length) {
              await upscaleCardByIdx(card, 0);
            }
            // Auto download
            if (CFG.autoDownload && card.outputs.length) {
              await autoDownloadCard(card);
            }
            resolve();
          } else if (job.status === 'failed') {
            card.status = 'failed';
            card.error = job.error || 'Tạo thất bại';
            reRenderRight(card);
            resolve();
          }
        });
      });
    } catch (e) {
      card.status = 'failed';
      card.error = e.message;
      reRenderRight(card);
    }
    refreshEmpty();
  }

  /* ── Upscale ─────────────────────────────────────────────── */
  async function upscaleCardByIdx(card, idx) {
    const out = card.outputs[idx];
    if (!out || card.upscaling) return;
    card.upscaling = true;
    reRenderRight(card);
    try {
      const res = await API.post(`/api/veo/job/${card.jobId}/upscale`, {
        operation_name: out.operation_name || '',
        output_index: idx,
      });
      if (res.ok && Array.isArray(res.outputs) && res.outputs.length) {
        card.outputs[idx] = { ...card.outputs[idx], ...res.outputs[0] };
        toast('Upscale 1080p thành công!', 'success');
      } else if (res.ok) {
        toast(res.message || 'Đã gửi yêu cầu upscale 1080p', 'info');
      } else {
        toast(res.body || 'Upscale thất bại', 'error');
      }
    } catch (e) {
      toast('Upscale lỗi: ' + e.message, 'error');
    } finally {
      card.upscaling = false;
      reRenderRight(card);
    }
  }

  /* ── Auto download ───────────────────────────────────────── */
  async function autoDownloadCard(card) {
    for (let i = 0; i < card.outputs.length; i++) {
      const url = card.outputs[i].video_url;
      if (!url) continue;
      const idx = cards.indexOf(card) + 1;
      const filename = `veo_${String(idx).padStart(3, '0')}_${i + 1}.mp4`;
      await downloadVideoFile(url, filename);
    }
  }

  async function downloadVideoFile(url, filename) {
    // Try File System Access API (folder)
    if (CFG._saveHandle) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const fileHandle = await CFG._saveHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast(`Đã lưu ${filename}`, 'success');
        return;
      } catch (e) { /* fallback to browser download */ }
    }
    // Fallback: browser download
    downloadUrl(url, filename);
  }

  /* ── Semaphore helper ────────────────────────────────────── */
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

  /* ── Gen All (multi-account + semaphore pool) ────────────── */
  async function genAll() {
    const pending = cards.filter(c => c.status === 'idle');
    if (!pending.length) { toast('Không có card nào chờ tạo', 'error'); return; }
    _stopFlag = false;
    $('t2v-gen-all').style.display = 'none';
    $('t2v-stop').style.display = '';

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
      maxConcurrent = Math.min(3, Math.max(1, parseInt(d.MAX_CONCURRENT || '2', 10) || 2));
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
        if (_stopFlag) return;
        const myIdx = cardIdx++;
        if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
        await genCard(card, accountIndices[0]);
      })));
    } else {
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi];
        if (bi > 0) await sleep(bi * 1000);
        const sem = makeSemaphore(maxConcurrent);
        let cardIdx = 0;
        await Promise.all(bucket.map(card => sem(async () => {
          if (_stopFlag) return;
          const myIdx = cardIdx++;
          if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
          await genCard(card, accIdx);
        })));
      }));
    }

    $('t2v-gen-all').style.display = '';
    $('t2v-stop').style.display = 'none';
    _stopFlag = false;
    refreshEmpty();
  }

  /* ── Save All (download all completed) ──────────────────── */
  async function saveAll() {
    const done = cards.filter(c => c.outputs.length > 0);
    if (!done.length) { toast('Không có video nào', 'error'); return; }
    for (const card of done) {
      await autoDownloadCard(card);
    }
    toast(`Đã tải ${done.length} video`, 'success');
  }

  function clearAll() {
    cards = [];
    cardsEl().innerHTML = '';
    refreshEmpty();
    toast('Đã xóa toàn bộ card', 'success');
  }

  /* ── Import unified (TXT / JSON / XLSX) ─────────────────── */

  // Show unified import dialog — detect format from filename
  function openImportDialog(file) {
    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (ext === 'json') {
      handleJsonImport(file);
    } else if (ext === 'xlsx' || ext === 'xls') {
      handleXlsxImport(file);
    } else {
      // TXT — existing flow
      const reader = new FileReader();
      reader.onload = e => importTxtContent(e.target.result || '');
      reader.readAsText(file, 'utf-8');
    }
  }

  // JSON import: mỗi object trong array → stringify toàn bộ làm prompt
  function handleJsonImport(file) {
    const reader = new FileReader();
    reader.onload = e => {
      let data;
      try { data = JSON.parse(e.target.result); } catch {
        toast('File JSON không hợp lệ', 'error'); return;
      }
      const list = Array.isArray(data) ? data : [data];
      const prompts = list.map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') return JSON.stringify(item, null, 2);
        return null;
      }).filter(Boolean);
      if (!prompts.length) { toast('Không tìm thấy prompt nào trong file JSON', 'error'); return; }
      prompts.forEach(p => { const c = newCard(p); cards.push(c); renderCard(c, true); });
      refreshEmpty();
      toast(`Đã import ${prompts.length} prompt từ JSON`, 'success');
    };
    reader.readAsText(file, 'utf-8');
  }

  // XLSX import: each non-empty row in first column = 1 prompt
  function handleXlsxImport(file) {
    if (typeof XLSX === 'undefined') {
      toast('Đang tải thư viện XLSX...', 'info');
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = () => doXlsxRead(file);
      s.onerror = () => toast('Không tải được thư viện XLSX', 'error');
      document.head.appendChild(s);
    } else {
      doXlsxRead(file);
    }
  }

  function doXlsxRead(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const prompts = [];
        rows.forEach((row, ri) => {
          if (ri === 0 && typeof row[0] === 'string' && /^(prompt|text|nội dung|scene)/i.test(row[0])) return; // skip header
          const val = (row[0] || '').toString().trim();
          if (val) prompts.push(val);
        });
        if (!prompts.length) { toast('Không có dữ liệu trong file Excel', 'error'); return; }
        prompts.forEach(p => { const c = newCard(p); cards.push(c); renderCard(c, true); });
        refreshEmpty();
        toast(`Đã import ${prompts.length} prompt từ Excel`, 'success');
      } catch (err) {
        toast('Lỗi đọc file Excel: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function importTxtContent(text) {
    if (!text.trim()) { toast('File trống', 'error'); return; }
    const hasScenes = /^SCENE\s+\d+[:\s]/im.test(text);
    if (hasScenes) {
      showImportModeDialog(text);
    } else {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) { toast('File trống hoặc không hợp lệ', 'error'); return; }
      lines.forEach(line => { const card = newCard(line); cards.push(card); renderCard(card, true); });
      refreshEmpty();
      toast(`Đã import ${lines.length} prompt`, 'success');
    }
  }

  // Keep old function name for compatibility
  function importPromptFile(file) { openImportDialog(file); }

  /* ── Import prompt txt (scene parser) ───────────────────── */
  function parseSceneFile(text) {
    // Extract header block [CHARACTERS Description]...[END CHARACTERS Description]
    let header = '';
    const headerMatch = text.match(/\[CHARACTERS Description\]([\s\S]*?)\[END CHARACTERS Description\]/i);
    if (headerMatch) {
      header = '[CHARACTERS Description]' + headerMatch[1] + '[END CHARACTERS Description]';
    }

    // Split into scene blocks by "SCENE XX:" pattern
    // Matches "SCENE 01:", "SCENE 1:", "SCENE 01: Title" at start of line
    const sceneRegex = /^(SCENE\s+\d+[:\s].*?)(?=^SCENE\s+\d+[:\s]|\Z)/gim;
    const blocks = [];
    let match;
    // Use split approach: find positions of SCENE headers
    const lines = text.split('\n');
    let currentBlock = [];
    let inScene = false;
    for (const line of lines) {
      if (/^SCENE\s+\d+[:\s]/i.test(line)) {
        if (inScene && currentBlock.length) blocks.push(currentBlock.join('\n').trim());
        currentBlock = [line];
        inScene = true;
      } else if (inScene) {
        currentBlock.push(line);
      }
    }
    if (inScene && currentBlock.length) blocks.push(currentBlock.join('\n').trim());

    return { header, scenes: blocks };
  }

  function importPromptFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result || '';
      if (!text.trim()) { toast('File trống', 'error'); return; }

      // Detect scene-based format
      const hasScenes = /^SCENE\s+\d+[:\s]/im.test(text);

      if (hasScenes) {
        showImportModeDialog(text);
      } else {
        // Simple mode: each non-empty line = 1 card
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) { toast('File trống hoặc không hợp lệ', 'error'); return; }
        lines.forEach(line => {
          const card = newCard(line);
          cards.push(card);
          renderCard(card, true);
        });
        refreshEmpty();
        toast(`Đã import ${lines.length} prompt`, 'success');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function showImportModeDialog(text) {
    const { header, scenes } = parseSceneFile(text);

    let modal = document.getElementById('import-mode-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'import-mode-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;width:480px;max-width:95vw;">
        <div style="font-size:15px;font-weight:600;margin-bottom:16px;">Import ${scenes.length} scenes</div>
        <p style="color:var(--text2);font-size:13px;margin-bottom:16px;">
          File chứa <strong>${scenes.length} SCENE block</strong>${header ? ' và phần CHARACTERS Description' : ''}.
          Chọn cách import:
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:12px;border:1px solid var(--border);border-radius:8px;transition:border-color .15s;" id="im-opt-scene">
            <input type="radio" name="im-mode" value="scene" checked style="margin-top:2px;">
            <div>
              <div style="font-weight:500;margin-bottom:3px;">Mỗi SCENE = 1 card</div>
              <div style="font-size:11px;color:var(--text2);">Tạo ${scenes.length} card, mỗi card chứa toàn bộ nội dung 1 scene${header ? ' + header characters' : ''}</div>
            </div>
          </label>
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:12px;border:1px solid var(--border);border-radius:8px;transition:border-color .15s;" id="im-opt-line">
            <input type="radio" name="im-mode" value="line" style="margin-top:2px;">
            <div>
              <div style="font-weight:500;margin-bottom:3px;">Mỗi dòng = 1 card</div>
              <div style="font-size:11px;color:var(--text2);">Import từng dòng không trống trong file</div>
            </div>
          </label>
        </div>
        ${header ? `
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:20px;font-size:13px;cursor:pointer;">
          <input type="checkbox" id="im-prepend-header" checked>
          <span>Ghép phần CHARACTERS Description vào đầu mỗi scene</span>
        </label>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary" onclick="document.getElementById('import-mode-modal').style.display='none'">Hủy</button>
          <button class="btn btn-primary" onclick="T2V._doImport()">Import</button>
        </div>
      </div>`;

    modal.style.display = 'flex';
    modal.onclick = ev => { if (ev.target === modal) modal.style.display = 'none'; };

    // Highlight selected option
    modal.querySelectorAll('input[name="im-mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        modal.querySelectorAll('label[id^="im-opt"]').forEach(l => l.style.borderColor = 'var(--border)');
        radio.closest('label').style.borderColor = 'var(--accent)';
      });
    });
    modal.querySelector('input[name="im-mode"][value="scene"]').closest('label').style.borderColor = 'var(--accent)';

    // Store data for _doImport
    window._importData = { text, header, scenes };
  }

  /* ── Choose save folder ──────────────────────────────────── */
  function _setFolderLabel(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || 'Chưa chọn folder';
    el.title = text || '';
    el.style.color = text ? 'var(--accent)' : 'var(--text2)';
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        CFG._saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        CFG.saveFolder = CFG._saveHandle.name;
        _setFolderLabel('t2v-folder-label', CFG._saveHandle.name);
        toast('Đã chọn folder: ' + CFG._saveHandle.name, 'success');
        return;
      } catch (e) {
        if (e.name !== 'AbortError') toast('Không thể chọn folder', 'error');
        return;
      }
    }
    // Fallback: ask user to type path
    const path = prompt('Nhập đường dẫn folder lưu video:', CFG.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      CFG.saveFolder = path;
      _setFolderLabel('t2v-folder-label', path);
      await API.post('/api/settings/save-value', { key: 'AUTO_DOWNLOAD_FOLDER', value: path });
      toast('Đã lưu folder: ' + path, 'success');
    }
  }

  /* ── Character picker modal ──────────────────────────────── */
  let _charPickerTarget = null;

  function openCharPicker(cardId) {
    _charPickerTarget = cardId;
    const card = cards.find(c => c.id === cardId);
    const existingIds = new Set((card?.chars || []).map(c => c.id));

    // Create simple modal
    let modal = $('char-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'char-picker-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;width:480px;max-height:80vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <strong>Chọn nhân vật</strong>
          <button onclick="document.getElementById('char-picker-modal').style.display='none'" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px;" id="char-picker-grid">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

    // Load chars
    API.get('/api/character/list').then(res => {
      const chars = res.data || [];
      const grid = $('char-picker-grid');
      if (!chars.length) { grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có nhân vật. Vào Thư viện nhân vật để thêm.</div>'; return; }
      grid.innerHTML = chars.map(ch => `
        <div onclick="T2V.pickChar('${ch.id}','${ch.name}','${ch.url}','${ch.media_id || ''}')"
          style="cursor:pointer;border:2px solid ${existingIds.has(ch.id) ? 'var(--accent)' : 'var(--border)'};border-radius:8px;overflow:hidden;text-align:center;transition:border-color .15s;">
          <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;">
          <div style="font-size:10px;padding:4px;color:var(--text2);">${ch.name}</div>
        </div>`).join('');
    });
  }

  function pickChar(charId, name, url, mediaId) {
    const card = cards.find(c => c.id === _charPickerTarget);
    if (!card) return;
    if (card.chars.length >= 3) { toast('Tối đa 3 nhân vật/card', 'error'); return; }
    if (card.chars.some(c => c.id === charId)) { toast('Nhân vật đã được thêm', 'error'); return; }
    card.chars.push({ id: charId, name, url, media_id: mediaId });
    renderCard(card, false);
    const el = document.getElementById(`card-${card.id}`);
    if (el) cardsEl().replaceChild(renderCard(card, false) || el, el);
    $('char-picker-modal').style.display = 'none';
  }

  function removeChar(cardId, idx) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    card.chars.splice(idx, 1);
    renderCard(card, false);
  }

  /* ── Public API ──────────────────────────────────────────── */
  window.T2V = {
    setFilter: f => { _activeFilter = f; refreshEmpty(); },
    genCard: id => { const c = cards.find(x => x.id === id); if (c) genCard(c); },
    deleteCard: id => {
      cards = cards.filter(c => c.id !== id);
      const el = document.getElementById(`card-${id}`);
      if (el) el.remove();
      // Renumber
      cards.forEach((c, i) => {
        const numEl = document.querySelector(`#card-${c.id} .t2v-card-num`);
        if (numEl) numEl.textContent = `#${i + 1}`;
      });
      refreshEmpty();
    },
    regenCard: id => {
      const c = cards.find(x => x.id === id);
      if (c) { c.status = 'idle'; c.outputs = []; reRenderRight(c); genCard(c); }
    },
    updatePrompt: (id, val) => {
      const c = cards.find(x => x.id === id);
      if (c) c.prompt = val;
    },
    prevOutput: id => {
      const c = cards.find(x => x.id === id);
      if (c && c.currentIdx > 0) { c.currentIdx--; reRenderRight(c); }
    },
    nextOutput: id => {
      const c = cards.find(x => x.id === id);
      if (c && c.currentIdx < c.outputs.length - 1) { c.currentIdx++; reRenderRight(c); }
    },
    downloadCard: async (id, idx) => {
      const c = cards.find(x => x.id === id);
      if (!c || !c.outputs[idx]) return;
      const cardNum = String(cards.indexOf(c) + 1).padStart(3, '0');
      const filename = `veo_${cardNum}_${idx + 1}.mp4`;
      await downloadVideoFile(c.outputs[idx].video_url, filename);
    },
    upscaleCard: async (id, idx) => {
      const c = cards.find(x => x.id === id);
      if (c) await upscaleCardByIdx(c, idx);
    },
    // Expose cards array for Studio tab
    _getCards: () => cards.map(c => ({ id: c.id, prompt: c.prompt })),
    _setCardImage: (cardId, imgUrl) => {
      const c = cards.find(x => x.id === cardId);
      if (!c) return;
      c.refImage = imgUrl;
      // Show thumbnail in card header
      const header = document.querySelector(`#card-${cardId} .t2v-card-num`);
      if (header) {
        const existing = document.querySelector(`#card-${cardId} .t2v-ref-img`);
        if (!existing) {
          const img = document.createElement('img');
          img.className = 't2v-ref-img';
          img.src = imgUrl;
          img.style.cssText = 'width:24px;height:24px;border-radius:3px;object-fit:cover;flex-shrink:0;';
          header.parentNode.insertBefore(img, header.nextSibling);
        } else {
          existing.src = imgUrl;
        }
      }
    },
    openCharPicker,
    pickChar,
    removeChar,

    toggleInsertMenu(cardId, _btn) {
      // Close all other menus first
      document.querySelectorAll('.card-insert-menu').forEach(m => {
        if (m.id !== `insert-menu-${cardId}`) m.style.display = 'none';
      });
      const menu = document.getElementById(`insert-menu-${cardId}`);
      if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    },

    insertCard(refId, position) {
      document.querySelectorAll('.card-insert-menu').forEach(m => m.style.display = 'none');
      const refIdx = cards.findIndex(c => c.id === refId);
      if (refIdx === -1) return;
      const card = newCard('');
      const insertAt = position === 'before' ? refIdx : refIdx + 1;
      cards.splice(insertAt, 0, card);
      // Re-render all cards
      _reRenderAllCards();
      refreshEmpty();
      setTimeout(() => {
        const ta = document.getElementById(`prompt-${card.id}`);
        if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }, 50);
    },

    cloneCard(srcId) {
      const src = cards.find(c => c.id === srcId);
      if (!src) return;
      const clone = newCard(src.prompt);
      clone.chars = src.chars.map(ch => ({ ...ch }));
      const srcIdx = cards.indexOf(src);
      cards.splice(srcIdx + 1, 0, clone);
      _reRenderAllCards();
      refreshEmpty();
      toast('Đã nhân bản card', 'success');
    },

    _doImport() {
      const modal = document.getElementById('import-mode-modal');
      if (!modal) return;
      const mode = modal.querySelector('input[name="im-mode"]:checked')?.value || 'scene';
      const prependHeader = modal.querySelector('#im-prepend-header')?.checked ?? true;
      const { text, header, scenes } = window._importData || {};
      modal.style.display = 'none';

      if (mode === 'scene') {
        if (!scenes || !scenes.length) { toast('Không tìm thấy SCENE nào', 'error'); return; }
        scenes.forEach(scene => {
          const prompt = (prependHeader && header) ? `${header}\n\n${scene}` : scene;
          const card = newCard(prompt);
          cards.push(card);
          renderCard(card, true);
        });
        refreshEmpty();
        toast(`Đã import ${scenes.length} scene`, 'success');
      } else {
        const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
        lines.forEach(line => {
          const card = newCard(line);
          cards.push(card);
          renderCard(card, true);
        });
        refreshEmpty();
        toast(`Đã import ${lines.length} dòng`, 'success');
      }
      delete window._importData;
    },
  };

  /* ── Init ────────────────────────────────────────────────── */
  window.init_text_to_video = function () {
    // Toolbar: Gen all
    $('t2v-gen-all').addEventListener('click', genAll);
    $('t2v-stop').addEventListener('click', () => { _stopFlag = true; $('t2v-stop').textContent = '⏳ Đang dừng...'; });
    $('t2v-save-all').addEventListener('click', saveAll);
    $('t2v-clear-all').addEventListener('click', clearAll);

    // Aspect buttons
    document.querySelectorAll('.t2v-aspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.t2v-aspect-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CFG.aspect = btn.dataset.val;
      });
    });

    // Count buttons
    document.querySelectorAll('.t2v-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.t2v-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CFG.count = parseInt(btn.dataset.val);
      });
    });

    // Model
    $('t2v-model').addEventListener('change', e => { CFG.model = e.target.value; });

    // Toggles
    $('t2v-auto-upscale').addEventListener('change', e => { CFG.autoUpscale = e.target.checked; });
    $('t2v-auto-download').addEventListener('change', async e => {
      CFG.autoDownload = e.target.checked;
      if (CFG.autoDownload && !CFG.saveFolder) await chooseFolder();
    });

    // Folder picker
    $('t2v-choose-folder').addEventListener('click', chooseFolder);

    // Import prompt
    $('t2v-import-prompt').addEventListener('click', () => $('t2v-import-file').click());
    $('t2v-import-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) { importPromptFile(f); e.target.value = ''; }
    });

    // Add card
    $('t2v-add-card').addEventListener('click', () => {
      const card = newCard('');
      cards.push(card);
      renderCard(card, true);
      refreshEmpty();
      // Focus prompt textarea
      setTimeout(() => {
        const ta = document.getElementById(`prompt-${card.id}`);
        if (ta) ta.focus();
      }, 50);
    });

    // Close insert menus when clicking outside
    document.addEventListener('click', e => {
      if (!e.target.closest('.card-action-group')) {
        document.querySelectorAll('.card-insert-menu').forEach(m => m.style.display = 'none');
      }
    });

    refreshEmpty();
  };
})();
