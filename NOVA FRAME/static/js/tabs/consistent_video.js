/* Consistent Video tab */
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

  const $ = id => document.getElementById(id);
  let cards = [];
  let seq = 0;
  let stopFlag = false;
  let libraryChars = [];
  let defaultChars = [];

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();
  }

  function newCard(prompt = '') {
    return {
      id: 'cv-' + (++seq),
      prompt,
      chars: defaultChars.map(ch => ({ ...ch })),
      status: 'idle',
      jobId: null,
      outputs: [],
      currentIdx: 0,
      upscaling: false,
      error: '',
    };
  }

  function refreshStats() {
    $('cv-pending-count').textContent = cards.filter(c => c.status === 'idle').length;
    $('cv-saved-count').textContent = cards.filter(c => c.outputs.length > 0).length;
    $('cv-empty').style.display = cards.length ? 'none' : '';
  }

  function cardsEl() {
    return $('cv-cards');
  }

  function reRenderAllCards() {
    const container = cardsEl();
    container.innerHTML = '';
    cards.forEach(card => renderCard(card, true));
    refreshStats();
  }

  function renderDefaultChars() {
    const grid = $('cv-char-grid');
    if (!grid) return;
    if (!defaultChars.length) {
      grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có nhân vật mặc định. Bấm "Áp dụng nhân vật" để chọn.</div>';
      return;
    }
    grid.innerHTML = defaultChars.map(ch => `
      <div class="t2v-char-thumb" title="${ch.name}">
        <img src="${ch.url}" alt="${ch.name}">
        <span>${ch.name}</span>
      </div>
    `).join('');
  }

  function charStripHtml(card) {
    if (!card.chars.length) {
      return '<div style="font-size:11px;color:var(--text3);">Chưa gán nhân vật cho card này</div>';
    }
    return card.chars.map(ch => `
      <div class="t2v-char-thumb" title="${ch.name}">
        <img src="${ch.url}" alt="${ch.name}">
        <span>${ch.name}</span>
      </div>
    `).join('');
  }

  function resultHtml(card) {
    const out = card.outputs[card.currentIdx];
    const url = out?.video_url || out?.videoUri || out?.fifeUrl || '';
    if (card.status === 'idle') return '<div class="t2v-video-preview"><span style="opacity:.4;">Chưa tạo</span></div>';
    if (card.status === 'running') return '<div class="t2v-video-preview"><div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;width:28px;height:28px;border-width:3px;"></div><div class="pulse" style="font-size:11px;">Đang tạo video...</div></div></div>';
    if (card.status === 'failed') return `<div class="t2v-video-preview" style="color:var(--red);padding:12px;font-size:12px;">${card.error || 'Lỗi tạo video'}</div>`;
    if (!url) return '<div class="t2v-video-preview"><span style="opacity:.4;">Không có video</span></div>';
    const nav = card.outputs.length > 1
      ? `<div class="t2v-video-nav"><button class="btn btn-secondary btn-sm" onclick="CV.prev('${card.id}')">‹</button><span>${card.currentIdx + 1} / ${card.outputs.length}</span><button class="btn btn-secondary btn-sm" onclick="CV.next('${card.id}')">›</button></div>`
      : '';
    return `<div class="t2v-video-preview"><video controls src="${url}" preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video></div>${nav}<div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="CV.download('${card.id}',${card.currentIdx})">Tải về</button>${CFG.autoUpscale ? '' : `<button class="btn btn-secondary btn-sm" onclick="CV.upscale('${card.id}',${card.currentIdx})" ${card.upscaling ? 'disabled' : ''}>${card.upscaling ? 'Đang upscale...' : 'Upscale 1080p'}</button>`}<button class="btn btn-secondary btn-sm" onclick="CV.genOne('${card.id}')">Tạo lại</button></div>`;
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
    el.innerHTML = `
      <div class="t2v-card-header">
        <span class="t2v-card-num">#${idx}</span>${statusDot}
        <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(card.prompt || '').slice(0, 80) || '(trống)'}</span>
        <button class="btn btn-secondary btn-sm" onclick="CV.genOne('${card.id}')" ${card.status === 'running' ? 'disabled' : ''}>Tạo Video</button>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" title="Thêm card" onclick="CV.toggleInsertMenu('${card.id}')">+ Card ▾</button>
          <div class="card-insert-menu" id="cv-insert-menu-${card.id}" style="display:none;">
            <div onclick="CV.insertCard('${card.id}','before')">Thêm trước</div>
            <div onclick="CV.insertCard('${card.id}','after')">Thêm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" title="Nhân bản card" onclick="CV.cloneCard('${card.id}')">⧉</button>
        <button class="btn btn-secondary btn-sm" onclick="CV.remove('${card.id}')">X</button>
      </div>
      <div class="t2v-card-body">
        <div class="t2v-card-left">
          <div class="form-group">
            <label class="form-label">Prompt</label>
            <textarea rows="6" placeholder="Nhập prompt video đồng nhất...">${card.prompt || ''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Nhân vật áp dụng</label>
            <div class="t2v-char-strip">${charStripHtml(card)}</div>
          </div>
        </div>
        <div class="t2v-card-right">${resultHtml(card)}</div>
      </div>
    `;
    if (append) $('cv-cards').appendChild(el);
    const ta = el.querySelector('textarea');
    ta.addEventListener('input', e => { card.prompt = e.target.value; refreshStats(); });
    refreshStats();
    return el;
  }

  async function loadCharacters() {
    const res = await API.get('/api/character/list');
    libraryChars = res.data || [];
    defaultChars = defaultChars
      .map(sel => libraryChars.find(ch => ch.id === sel.id) || sel)
      .filter(Boolean);
    renderDefaultChars();
    cards.forEach(card => {
      card.chars = card.chars
        .map(sel => libraryChars.find(ch => ch.id === sel.id) || sel)
        .filter(Boolean);
      renderCard(card, false);
    });
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
        toast('Đã lưu ' + filename, 'success');
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
        $('cv-folder-label').textContent = CFG.saveFolder;
        return;
      } catch (e) {
        return;
      }
    }
    const path = prompt('Nhập đường dẫn folder lưu video:', CFG.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      CFG.saveFolder = path;
      $('cv-folder-label').textContent = path;
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

  async function autoDownloadCard(card) {
    for (let i = 0; i < card.outputs.length; i++) {
      const out = card.outputs[i];
      const url = out.video_url || out.videoUri || out.fifeUrl;
      if (!url) continue;
      await downloadVideoFile(url, 'cv_' + String(cards.indexOf(card) + 1).padStart(3, '0') + '_' + (i + 1) + '.mp4');
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
        toast('Upscale 1080p thành công!', 'success');
      } else {
        toast(res.body || res.message || 'Upscale thất bại', 'error');
      }
    } catch (e) {
      toast('Lỗi upscale: ' + e.message, 'error');
    } finally {
      card.upscaling = false;
      renderCard(card, false);
    }
  }

  async function genOne(card, accountIndex = null) {
    if (!card.chars.length) {
      toast('Card này chưa có nhân vật', 'error');
      return;
    }
    card.status = 'running';
    card.outputs = [];
    card.currentIdx = 0;
    renderCard(card, false);
    try {
      const res = await API.post('/api/veo/consistent-video', {
        prompt: card.prompt || '',
        character_ids: card.chars.map(c => c.id),
        aspect_ratio: CFG.aspect,
        output_count: CFG.count,
        model: CFG.model,
        ...(accountIndex != null ? { account_index: accountIndex } : {}),
      });
      if (!res.ok) {
        card.status = 'failed';
        card.error = res.detail || 'Lỗi tạo';
        renderCard(card, false);
        return;
      }
      card.jobId = res.job_id;
      pollJob(res.job_id, '/api/veo/job', async job => {
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

  async function genAll() {
    const pending = cards.filter(c => c.status === 'idle');
    if (!pending.length) return toast('Không có card nào chờ tạo', 'error');
    stopFlag = false;
    $('cv-gen-all').style.display = 'none';
    $('cv-stop').style.display = '';

    // Multi-account: lấy danh sách accounts có token
    let accountIndices = [null];
    try {
      const cfgRes = await API.get('/api/settings/config-full');
      const d = cfgRes.data || {};
      const idxs = [];
      for (let i = 1; i <= 10; i++) {
        const acc = d[`account${i}`];
        if (acc && acc.ACCESS_TOKEN && acc.ACCESS_TOKEN.length > 10) idxs.push(i);
      }
      if (idxs.length > 1) accountIndices = idxs;
    } catch (_) {}

    const n = accountIndices.length;
    if (n > 1) toast(`Chạy ${pending.length} card với ${n} tài khoản song song`, 'info');

    const buckets = accountIndices.map(() => []);
    pending.forEach((card, i) => buckets[i % n].push(card));

    await Promise.all(buckets.map(async (bucket, bi) => {
      const accIdx = accountIndices[bi];
      for (const card of bucket) {
        if (stopFlag) break;
        await genOne(card, accIdx);
      }
    }));

    $('cv-gen-all').style.display = '';
    $('cv-stop').style.display = 'none';
    $('cv-stop').textContent = 'Dừng toàn bộ';
    stopFlag = false;
  }

  async function saveAll() {
    for (const card of cards.filter(c => c.outputs.length)) await autoDownloadCard(card);
  }

  function clearAll() {
    cards = [];
    $('cv-cards').innerHTML = '';
    refreshStats();
    toast('Đã xóa toàn bộ card', 'success');
  }

  function findCharactersForPrompt(prompt) {
    const normalizedPrompt = normalizeText(prompt);
    if (!normalizedPrompt) return [];

    const normalizedChars = libraryChars
      .map(ch => ({ ...ch, _normalizedName: normalizeText(ch.name) }))
      .filter(ch => ch._normalizedName)
      .sort((a, b) => b._normalizedName.length - a._normalizedName.length);

    const matched = [];
    for (const ch of normalizedChars) {
      if (matched.length >= 3) break;
      if (normalizedPrompt.includes(ch._normalizedName) && !matched.some(item => item.id === ch.id)) {
        const { _normalizedName, ...plainChar } = ch;
        matched.push({ ...plainChar });
      }
    }
    return matched;
  }

  function autoApplyCharactersToCards(targetCardIds = null) {
    const targetCards = Array.isArray(targetCardIds) && targetCardIds.length
      ? cards.filter(card => targetCardIds.includes(card.id))
      : cards;

    let affectedCount = 0;
    targetCards.forEach(card => {
      const matchedChars = findCharactersForPrompt(card.prompt);
      if (!matchedChars.length) return;
      card.chars = matchedChars.map(ch => ({ ...ch }));
      renderCard(card, false);
      affectedCount++;
    });

    if (affectedCount) {
      toast('Đã auto gán nhân vật cho ' + affectedCount + ' card', 'success');
    } else {
      toast('Không tìm thấy tên nhân vật nào khớp trong prompt', 'error');
    }
    return affectedCount;
  }

  function openApplyCharsModal() {
    if (!libraryChars.length) {
      toast('Chưa có nhân vật trong thư viện', 'error');
      return;
    }

    let modal = $('cv-apply-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cv-apply-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }

    const selectedCharIds = new Set(defaultChars.map(ch => ch.id));
    const selectedCardIds = new Set(cards.map(c => c.id));

    const render = () => {
      modal.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;width:900px;max-width:95vw;max-height:90vh;overflow:auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div>
              <div style="font-size:18px;font-weight:700;">Áp dụng nhân vật cho prompt</div>
              <div style="font-size:12px;color:var(--text2);margin-top:4px;">Chọn tối đa 3 nhân vật và gán vào các card đang có.</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="cv-apply-close">Đóng</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;margin-bottom:18px;">
            ${libraryChars.map(ch => `
              <button type="button" class="cv-char-choice ${selectedCharIds.has(ch.id) ? 'active' : ''}" data-id="${ch.id}"
                style="position:relative;border:2px solid ${selectedCharIds.has(ch.id) ? 'var(--accent)' : 'var(--border)'};background:var(--bg3);border-radius:12px;padding:8px;cursor:pointer;">
                <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block;">
                <div style="font-size:12px;margin-top:8px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ch.name}</div>
                <div style="position:absolute;top:10px;right:10px;width:24px;height:24px;border-radius:999px;background:${selectedCharIds.has(ch.id) ? 'var(--accent)' : 'rgba(15,23,42,.65)'};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;">${selectedCharIds.has(ch.id) ? '✓' : ''}</div>
              </button>
            `).join('')}
          </div>
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Chọn card áp dụng</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:18px;">
            ${cards.map((card, idx) => `
              <label style="display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;cursor:pointer;">
                <input type="checkbox" class="cv-card-check" data-id="${card.id}" ${selectedCardIds.has(card.id) ? 'checked' : ''}>
                <span>Card #${idx + 1}</span>
              </label>
            `).join('')}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="btn btn-secondary" id="cv-apply-auto">AUTO Nhân Vật</button>
            <button class="btn btn-secondary" id="cv-apply-clear">Bỏ chọn</button>
            <button class="btn btn-primary" id="cv-apply-submit">Áp dụng</button>
          </div>
        </div>
      `;

      modal.style.display = 'flex';
      modal.onclick = ev => { if (ev.target === modal) modal.style.display = 'none'; };
      $('cv-apply-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
      $('cv-apply-clear')?.addEventListener('click', () => {
        selectedCharIds.clear();
        selectedCardIds.clear();
        render();
      });

      $('cv-apply-auto')?.addEventListener('click', () => {
        const affectedCount = autoApplyCharactersToCards(Array.from(selectedCardIds));
        if (affectedCount) {
          modal.style.display = 'none';
          renderDefaultChars();
        }
      });

      modal.querySelectorAll('.cv-char-choice').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          if (selectedCharIds.has(id)) selectedCharIds.delete(id);
          else {
            if (selectedCharIds.size >= 3) {
              toast('Tối đa 3 nhân vật', 'error');
              return;
            }
            selectedCharIds.add(id);
          }
          render();
          window.CVUIEnhancer?.decorateNow?.();
        });
      });

      modal.querySelectorAll('.cv-card-check').forEach(input => {
        input.addEventListener('change', e => {
          const id = e.target.dataset.id;
          if (e.target.checked) selectedCardIds.add(id);
          else selectedCardIds.delete(id);
        });
      });

      $('cv-apply-submit')?.addEventListener('click', () => {
        const selectedChars = libraryChars.filter(ch => selectedCharIds.has(ch.id)).slice(0, 3);
        defaultChars = selectedChars.map(ch => ({ ...ch }));
        const targetCards = cards.filter(c => selectedCardIds.has(c.id));
        targetCards.forEach(card => {
          card.chars = selectedChars.map(ch => ({ ...ch }));
          renderCard(card, false);
        });
        renderDefaultChars();
        modal.style.display = 'none';
        toast('Đã áp dụng nhân vật cho ' + targetCards.length + ' card', 'success');
      });

      window.CVUIEnhancer?.decorateNow?.();
    };

    render();
  }

  window.CV = {
    genOne: id => { const card = cards.find(c => c.id === id); if (card) genOne(card); },
    remove: id => { cards = cards.filter(c => c.id !== id); $('card-' + id)?.remove(); refreshStats(); },
    prev: id => { const card = cards.find(c => c.id === id); if (card && card.currentIdx > 0) { card.currentIdx--; renderCard(card, false); } },
    next: id => { const card = cards.find(c => c.id === id); if (card && card.currentIdx < card.outputs.length - 1) { card.currentIdx++; renderCard(card, false); } },
    download: async (id, idx) => { const card = cards.find(c => c.id === id); if (!card) return; const out = card.outputs[idx]; const url = out?.video_url || out?.videoUri || out?.fifeUrl; if (url) await downloadVideoFile(url, 'cv_' + String(cards.indexOf(card) + 1).padStart(3, '0') + '_' + (idx + 1) + '.mp4'); },
    upscale: async (id, idx) => { const card = cards.find(c => c.id === id); if (card) await upscale(card, idx); },
    toggleInsertMenu(cardId) {
      document.querySelectorAll('.card-insert-menu').forEach(menu => {
        if (menu.id !== `cv-insert-menu-${cardId}`) menu.style.display = 'none';
      });
      const menu = document.getElementById(`cv-insert-menu-${cardId}`);
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
      clone.chars = src.chars.map(ch => ({ ...ch }));
      const srcIdx = cards.indexOf(src);
      cards.splice(srcIdx + 1, 0, clone);
      reRenderAllCards();
      toast('Đã nhân bản card', 'success');
    },
  };

  window.init_consistent_video = function () {
    document.querySelectorAll('.cv-aspect-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.cv-aspect-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      CFG.aspect = btn.dataset.val;
    }));
    document.querySelectorAll('.cv-count-btn').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.cv-count-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      CFG.count = parseInt(btn.dataset.val, 10);
    }));
    $('cv-model')?.addEventListener('change', e => { CFG.model = e.target.value; });
    $('cv-auto-upscale')?.addEventListener('change', e => { CFG.autoUpscale = e.target.checked; });
    $('cv-auto-download')?.addEventListener('change', e => { CFG.autoDownload = e.target.checked; });
    $('cv-choose-folder')?.addEventListener('click', chooseFolder);
    $('cv-import-prompt')?.addEventListener('click', () => $('cv-import-file').click());
    $('cv-import-file')?.addEventListener('change', e => { const f = e.target.files[0]; if (f) importPromptFile(f); e.target.value = ''; });
    $('cv-add-card')?.addEventListener('click', () => { const card = newCard(''); cards.push(card); renderCard(card, true); });
    $('cv-gen-all')?.addEventListener('click', genAll);
    $('cv-stop')?.addEventListener('click', () => { stopFlag = true; $('cv-stop').textContent = 'Đang dừng...'; });
    $('cv-save-all')?.addEventListener('click', saveAll);
    $('cv-clear-all')?.addEventListener('click', clearAll);
    $('cv-apply-chars')?.addEventListener('click', openApplyCharsModal);
    document.addEventListener('click', e => {
      if (!e.target.closest('.card-action-group')) {
        document.querySelectorAll('.card-insert-menu').forEach(menu => { menu.style.display = 'none'; });
      }
    });
    window.CVUIEnhancer?.init?.();
    loadCharacters();
    renderDefaultChars();
    refreshStats();
  };
})();
