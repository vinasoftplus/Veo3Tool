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
  const isDefaultCategory = (cat) => {
    const id = String(cat?.id || '').toLowerCase();
    const name = normalizeText(cat?.name || '');
    return id === 'default' || name === 'mac dinh';
  };

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

  let _activeFilter = 'all';

  function applyFilter() {
    const container = $('cv-cards');
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
    $('cv-pending-count').textContent = idle;
    $('cv-saved-count').textContent = done;
    $('cv-empty').style.display = cards.length ? 'none' : '';
    const totalEl = $('cv-total-count'); if (totalEl) totalEl.textContent = cards.length;
    const idleEl = $('cv-idle-count'); if (idleEl) idleEl.textContent = idle;
    const runEl = $('cv-running-count'); if (runEl) runEl.textContent = running;
    const doneEl = $('cv-done-count'); if (doneEl) doneEl.textContent = done;
    const failEl = $('cv-failed-count'); if (failEl) failEl.textContent = failed;
    ['all','idle','running','completed','failed'].forEach(f => {
      const el = $('cv-filter-' + f);
      if (el) el.classList.toggle('active', _activeFilter === f);
    });
    applyFilter();
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

  function _setFolderLabel(text) {
    const el = $('cv-folder-label');
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
        _setFolderLabel(CFG._saveHandle.name);
        toast('Đã chọn folder: ' + CFG._saveHandle.name, 'success');
        return;
      } catch (e) {
        if (e.name !== 'AbortError') toast('Không thể chọn folder', 'error');
        return;
      }
    }
    const path = prompt('Nhập đường dẫn folder lưu video:', CFG.saveFolder || 'D:\\Downloads\\Videos');
    if (path) {
      CFG.saveFolder = path;
      _setFolderLabel(path);
      toast('Đã lưu folder: ' + path, 'success');
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
    // Nếu chưa chọn folder, tự mở dialog để tránh browser hỏi "allow multiple downloads"
    if (!CFG._saveHandle && window.showDirectoryPicker) {
      await chooseFolder();
    }
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
      // Upload ảnh nhân vật trực tiếp qua FormData — không cần sync
      const fd = new FormData();
      fd.append('prompt', card.prompt || '');
      fd.append('aspect_ratio', CFG.aspect);
      fd.append('output_count', String(CFG.count));
      fd.append('model', CFG.model);
      if (accountIndex != null) fd.append('account_index', String(accountIndex));
      for (const ch of card.chars.slice(0, 3)) {
        if (ch.url) {
          try {
            const blob = await fetch(ch.url).then(r => r.blob());
            fd.append('character_images', blob, (ch.name || 'char') + '.jpg');
          } catch (_) {}
        }
      }
      const res = await API.postForm('/api/veo/consistent-video', fd);
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

  // ── CV Vault (Kho lưu trữ dùng trong tab CV) ────────────────────────────
  let _cvVaultAssets = [];
  let _cvVaultCategories = [];
  let _cvVaultSelectedIds = new Set();
  let _cvVaultTypeFilter = 'all';
  let _cvVaultGroupFilter = 'all';

  function _cvVaultFiltered() {
    return _cvVaultAssets.filter(a => {
      if (_cvVaultTypeFilter !== 'all' && a.asset_type !== _cvVaultTypeFilter) return false;
      if (_cvVaultGroupFilter !== 'all' && a.category_id !== _cvVaultGroupFilter) return false;
      return true;
    });
  }

  function _cvVaultUpdateSelCount() {
    const el = $('cv-vault-sel-count');
    if (el) el.textContent = `Đã chọn: ${_cvVaultSelectedIds.size}`;
  }

  function _cvVaultRenderGrid() {
    const grid = $('cv-vault-grid');
    if (!grid) return;
    const items = _cvVaultFiltered();
    const countLabel = $('cv-vault-count-label');
    if (countLabel) countLabel.textContent = `${items.length} ảnh`;
    const typeLabel = { nhanvat: 'Nhân Vật', vatpham: 'Vật Phẩm', style: 'Style', background: 'BG' };
    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text3);font-size:13px;">Không có ảnh nào</div>`;
      _cvVaultUpdateSelCount();
      return;
    }
    grid.innerHTML = items.map(item => `
      <div class="studio-vault-card ${_cvVaultSelectedIds.has(item.id) ? 'selected' : ''}" data-id="${item.id}">
        <input type="checkbox" class="studio-vault-card-check" data-id="${item.id}"
               ${_cvVaultSelectedIds.has(item.id) ? 'checked' : ''} onclick="event.stopPropagation()">
        <img src="${item.url}" alt="${item.name}" loading="lazy">
        <span class="studio-vault-card-badge">${typeLabel[item.asset_type] || 'Kho'}</span>
        <div class="studio-vault-card-label">${item.name || 'Chưa đặt tên'}</div>
      </div>
    `).join('');
    grid.querySelectorAll('.studio-vault-card-check').forEach(cb => {
      cb.addEventListener('change', e => {
        const id = e.target.dataset.id;
        e.target.checked ? _cvVaultSelectedIds.add(id) : _cvVaultSelectedIds.delete(id);
        grid.querySelector(`.studio-vault-card[data-id="${id}"]`)?.classList.toggle('selected', e.target.checked);
        _cvVaultUpdateSelCount();
      });
    });
    grid.querySelectorAll('.studio-vault-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const cb = card.querySelector('.studio-vault-card-check');
        if (_cvVaultSelectedIds.has(id)) {
          _cvVaultSelectedIds.delete(id);
          card.classList.remove('selected');
          if (cb) cb.checked = false;
        } else {
          _cvVaultSelectedIds.add(id);
          card.classList.add('selected');
          if (cb) cb.checked = true;
        }
        _cvVaultUpdateSelCount();
      });
    });
    _cvVaultUpdateSelCount();
  }

  async function openCVVault() {
    const popup = $('cv-vault-popup');
    if (!popup) return;
    const [catsRes, assetsRes] = await Promise.all([
      API.get('/api/image/library/categories'),
      API.get('/api/image/library/assets'),
    ]);
    _cvVaultCategories = (catsRes.items || []).filter(c => !isDefaultCategory(c));
    _cvVaultAssets = assetsRes.items || [];
    _cvVaultSelectedIds = new Set(defaultChars.map(ch => ch.id));
    _cvVaultTypeFilter = 'all';
    _cvVaultGroupFilter = 'all';

    const groupSel = $('cv-vault-group-filter');
    if (groupSel) {
      groupSel.innerHTML = '<option value="all">Tất cả nhóm</option>' +
        _cvVaultCategories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      groupSel.value = 'all';
    }
    const typeSel = $('cv-vault-type-filter');
    if (typeSel) typeSel.value = 'all';

    _cvVaultRenderGrid();
    popup.style.display = 'flex';
  }

  function _initCVVaultListeners() {
    $('cv-vault-type-filter')?.addEventListener('change', e => {
      _cvVaultTypeFilter = e.target.value;
      _cvVaultRenderGrid();
    });
    $('cv-vault-group-filter')?.addEventListener('change', e => {
      _cvVaultGroupFilter = e.target.value;
      _cvVaultRenderGrid();
    });
    $('cv-vault-select-all')?.addEventListener('change', e => {
      const items = _cvVaultFiltered();
      if (e.target.checked) items.forEach(i => _cvVaultSelectedIds.add(i.id));
      else items.forEach(i => _cvVaultSelectedIds.delete(i.id));
      _cvVaultRenderGrid();
    });
    $('cv-vault-apply-btn')?.addEventListener('click', () => {
      if (!_cvVaultSelectedIds.size) { toast('Chưa chọn ảnh nào', 'error'); return; }
      const selected = _cvVaultAssets.filter(a => _cvVaultSelectedIds.has(a.id)).slice(0, 3);
      defaultChars = selected.map(a => ({ id: a.id, url: a.url, name: a.name || a.id, media_id: a.media_id || '' }));
      cards.forEach(card => {
        card.chars = defaultChars.map(ch => ({ ...ch }));
        renderCard(card, false);
      });
      renderDefaultChars();
      $('cv-vault-popup').style.display = 'none';
      toast('Đã áp dụng ' + selected.length + ' nhân vật cho tất cả card', 'success');
    });
    $('cv-vault-auto-btn')?.addEventListener('click', () => {
      const selected = _cvVaultAssets.filter(a => _cvVaultSelectedIds.has(a.id));
      if (!selected.length) { toast('Chưa chọn ảnh nào', 'error'); return; }
      let affected = 0;
      cards.forEach(card => {
        const matched = selected.filter(a => {
          const name = normalizeText(a.name || '');
          return name && normalizeText(card.prompt).includes(name);
        });
        if (matched.length) {
          card.chars = matched.slice(0, 3).map(a => ({ id: a.id, url: a.url, name: a.name || a.id, media_id: a.media_id || '' }));
          renderCard(card, false);
          affected++;
        }
      });
      renderDefaultChars();
      $('cv-vault-popup').style.display = 'none';
      toast(affected ? `AUTO: áp dụng cho ${affected} card` : 'Không tìm thấy tên nào khớp', affected ? 'success' : 'info');
    });
  }

  window.CV = {
    setFilter: f => { _activeFilter = f; refreshStats(); },
    openVault: openCVVault,
    closeVault: () => { const p = $('cv-vault-popup'); if (p) p.style.display = 'none'; },
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
    $('cv-auto-download')?.addEventListener('change', async e => {
      CFG.autoDownload = e.target.checked;
      if (CFG.autoDownload && !CFG.saveFolder) await chooseFolder();
    });
    $('cv-choose-folder')?.addEventListener('click', chooseFolder);
    $('cv-import-prompt')?.addEventListener('click', () => $('cv-import-file').click());
    $('cv-import-file')?.addEventListener('change', e => { const f = e.target.files[0]; if (f) importPromptFile(f); e.target.value = ''; });
    $('cv-add-card')?.addEventListener('click', () => { const card = newCard(''); cards.push(card); renderCard(card, true); });
    $('cv-gen-all')?.addEventListener('click', genAll);
    $('cv-stop')?.addEventListener('click', () => { stopFlag = true; $('cv-stop').textContent = 'Đang dừng...'; });
    $('cv-save-all')?.addEventListener('click', saveAll);
    $('cv-clear-all')?.addEventListener('click', clearAll);
    $('cv-open-vault')?.addEventListener('click', openCVVault);
    _initCVVaultListeners();
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
