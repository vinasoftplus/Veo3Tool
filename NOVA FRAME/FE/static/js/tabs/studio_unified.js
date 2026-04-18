/* Unified Studio override */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const cfg = { aspect: 'VIDEO_ASPECT_RATIO_LANDSCAPE', model: 'flow_fast', imageModel: 'Nano Banana pro', imageCount: 1, videoCount: 1, autoUpscale: false, autoDownload: false, saveHandle: null, saveFolder: '' };
  let ready = false;
  let stopAll = false;
  // Semaphore dÃ¹ng chung cho cáº£ táº¡o láº» láº«n hÃ ng loáº¡t â€” trÃ¡nh burst reCAPTCHA
  let _globalVideoSem = null;
  function _getGlobalVideoSem() {
    if (!_globalVideoSem) _globalVideoSem = makeSemaphore(3); // default 3, sáº½ Ä‘Æ°á»£c cáº­p nháº­t theo config
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

  const norm = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd').replace(/Ä/g, 'd').toLowerCase();

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
      // DÃ¹ng toÃ n bá»™ JSON object lÃ m prompt (stringify Ä‘áº¹p)
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
    if (el('studio-metric-running')) el('studio-metric-running').textContent = running + ' Ä‘ang cháº¡y';
    if (el('studio-metric-done')) el('studio-metric-done').textContent = videoDone + ' video / ' + imageDone + ' áº£nh';
    if (el('studio-metric-failed')) el('studio-metric-failed').textContent = failed + ' lá»—i';
    if (el('studio-status-text')) el('studio-status-text').textContent = cards.length ? ('Studio theo dÃµi ' + cards.length + ' cá»¥m.') : 'ChÆ°a cÃ³ batch. Import prompt hoáº·c thÃªm cá»¥m Ä‘á»ƒ báº¯t Ä‘áº§u.';
    if (el('studio-empty')) el('studio-empty').style.display = cards.length ? 'none' : '';
    // Update active filter highlight â€” dÃ¹ng data-filter thay vÃ¬ id trÃ¹ng
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
    const path = prompt('Nháº­p Ä‘Æ°á»ng dáº«n folder lÆ°u video:', cfg.saveFolder || 'D:\\Downloads\\Videos');
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
        toast('ÄÃ£ lÆ°u ' + filename, 'success');
        return;
      } catch (_) { }
    }
    // DÃ¹ng proxy backend Ä‘á»ƒ trÃ¡nh CORS, buá»™c trÃ¬nh duyá»‡t download
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
    const options = [{ id: 'all', name: 'Táº¥t cáº£' }, { id: '__characters__', name: 'NhÃ¢n váº­t' }, ...libraryCategories];
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
    const refs = (card.refs || []).map((ref, i) => ({ kind: 'ref', idx: i, url: ref.url, name: ref.label || `áº¢nh ${i + 1}` }));
    return [...chars, ...refs];
  }

  function renderCombinedRefThumbs(card) {
    const items = combinedRefs(card);
    if (!items.length) return '<div class="studio-note">ChÆ°a cÃ³ áº£nh tham chiáº¿u nÃ o Ä‘Æ°á»£c gáº¯n vÃ o cá»¥m nÃ y.</div>';
    return items.map(item => `
      <div class="studio-thumb ${item.kind === 'char' ? 'active' : ''}">
        <img src="${item.url}" alt="${item.name}" onclick="Studio.openPopup('${card.id}','${item.kind === 'char' ? 'char' : 'ref'}',${item.idx})">
        <span style="position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.62);padding:2px 6px;border-radius:999px;font-size:10px;color:#fff;">${item.kind === 'char' ? 'NhÃ¢n váº­t' : 'áº¢nh'}</span>
        <button type="button" onclick="event.stopPropagation();${item.kind === 'char' ? `Studio.removeChar('${card.id}',${item.idx})` : `Studio.removeRef('${card.id}',${item.idx})`}">Ã—</button>
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
    if (!confirm(`XÃ³a nhÃ³m "${cat.name}"? NhÃ³m pháº£i khÃ´ng cÃ³ áº£nh nÃ o má»›i xÃ³a Ä‘Æ°á»£c.`)) return;
    const res = await API.delete(`/api/image/library/categories/${filter}`);
    if (res.ok) {
      toast('ÄÃ£ xÃ³a nhÃ³m', 'success');
      await loadLibrarySources();
      $('studio-library-category-filter').value = 'all';
      renderLibraryPicker();
    } else {
      toast(res.detail || 'XÃ³a nhÃ³m tháº¥t báº¡i', 'error');
    }
  }

  function renderLibraryPicker() {
    const grid = $('studio-library-grid');
    const filter = $('studio-library-category-filter')?.value || 'all';
    // Hiá»‡n/áº©n nÃºt xÃ³a nhÃ³m
    const delBtn = $('studio-delete-category-btn');
    if (delBtn) delBtn.style.display = (filter && filter !== 'all' && filter !== '__characters__') ? '' : 'none';
    if (!grid) return;
    const items = [
      ...libraryCharacters.map(ch => ({ type: 'character', id: ch.id, name: ch.name, url: ch.url, category_id: '__characters__', media_id: ch.media_id || '' })),
      ...libraryAssets.map(a => ({ type: 'asset', id: a.id, name: a.name, url: a.url, category_id: a.category_id || 'default' })),
    ].filter(item => filter === 'all' || item.category_id === filter);
    if (!items.length) {
      grid.innerHTML = '<div class="studio-note" style="grid-column:1/-1;">Danh má»¥c nÃ y chÆ°a cÃ³ áº£nh nÃ o.</div>';
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
      if (!card.refs.some(x => x.url === asset.url)) card.refs.unshift({ url: asset.url, file: null, label: asset.name || 'áº¢nh tá»« kho' });
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
      if (card.busyImage) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Äang táº¡o áº£nh...</div></div>';
      if (card.status === 'running') return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Äang táº¡o video...</div></div>';
      if (card.upscaling) return '<div style="text-align:center;"><div class="spinner" style="margin:0 auto 8px;"></div><div class="pulse">Äang upscale 1080p...</div></div>';
      if (card.status === 'failed') return `<div style="padding:12px;color:var(--red);font-size:12px;white-space:pre-wrap;">${card.error || 'Tháº¥t báº¡i'}${card.upscaleFailed ? `<br><button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="Studio.retryUpscale('${card.id}')">Upscale láº¡i</button>` : ''}</div>`;
      if (url) return `<video controls src="${url}" preload="metadata"></video>`;
      return '<span>ChÆ°a cÃ³ preview</span>';
    })();

    el.innerHTML = `
      <div class="studio-card-header">
        <span class="studio-card-status-dot ${statusCls}"></span>
        <span class="studio-card-title">Cá»¥m ${idx}</span>
        <div class="studio-toolbar-spacer"></div>
        <div class="card-action-group" style="position:relative;display:inline-flex;">
          <button class="btn btn-secondary btn-sm card-insert-btn" onclick="Studio.toggleInsertMenu('${card.id}')">+ Cá»¥m â–¾</button>
          <div class="card-insert-menu" id="studio-insert-menu-${card.id}" style="display:none;">
            <div onclick="Studio.insertCard('${card.id}','before')">ThÃªm trÆ°á»›c</div>
            <div onclick="Studio.insertCard('${card.id}','after')">ThÃªm sau</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="Studio.cloneCard('${card.id}')">â§‰</button>
        <button class="btn btn-secondary btn-sm" onclick="Studio.deleteCard('${card.id}')">ðŸ—‘</button>
      </div>
      <div class="studio-card-body">
        ${_cardLayout === 'horizontal' ? `<div class="studio-card-left">` : ''}
        <div class="studio-preview-panel">${preview}</div>
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
            <span>Text Prompt</span>
            <span style="font-size:10px;color:var(--text3);font-weight:400;">Nháº¥n Ä‘á»ƒ chá»‰nh sá»­a</span>
          </label>
          <div class="studio-prompt-display studio-prompt-open ${!card.prompt ? 'empty' : ''}">${card.prompt ? card.prompt.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Nháº­p prompt cho cá»¥m nÃ y...'}</div>
          <input type="file" class="studio-ref-input" accept="image/*" multiple style="display:none;">
        </div>
        <div class="studio-inline-tools">
          <button class="btn btn-secondary btn-sm studio-auto-char">AUTO NhÃ¢n Váº­t</button>
          <button class="btn btn-secondary btn-sm studio-clear-ref">XÃ³a áº£nh tham chiáº¿u</button>
          ${card.outputs.length ? `<button class="btn btn-secondary btn-sm studio-save-video-btn" onclick="Studio.saveCardOutputs('${card.id}')">LÆ°u video</button>` : ''}
        </div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>áº¢nh tham chiáº¿u</span><span>${combinedRefs(card).length ? ('ÄÃ£ chá»n ' + combinedRefs(card).length) : 'ChÆ°a cÃ³ áº£nh'}</span></div>
          <div class="studio-strip">
            ${renderCombinedRefThumbs(card)}
            <button type="button" class="studio-add-thumb studio-open-library">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              Kho
            </button>
            <button type="button" class="studio-add-thumb studio-add-ref">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              ThÃªm
            </button>
          </div>
        </div>
        <div class="studio-card-actions">
          <button class="btn btn-primary studio-generate-image" ${card.busyImage ? 'disabled' : ''}>${card.busyImage ? 'Äang táº¡o hÃ¬nh...' : 'Táº¡o hÃ¬nh'}</button>
          <button class="btn btn-primary studio-generate-video" ${card.busyVideo ? 'disabled' : ''}>${card.busyVideo ? 'Äang táº¡o video...' : 'Táº¡o video'}</button>
          ${card.status === 'completed' ? `<button class="btn btn-secondary studio-regenerate-video">Táº¡o láº¡i</button>` : ''}
        </div>
        ${_cardLayout === 'horizontal' ? `</div><div class="studio-card-right"><div class="studio-right-strips">` : ''}
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>HÃ¬nh Ä‘Ã£ táº¡o (${card.images.length})</span></div>
          <div class="studio-strip">
            ${card.images.length ? card.images.map((img, i) => `<div class="studio-thumb" style="position:relative;"><img src="${img.url}" alt="img-${i}" onclick="Studio.openPopup('${card.id}','generated',${i})"><button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();Studio.deleteImage('${card.id}',${i})" title="XÃ³a áº£nh nÃ y">Ã—</button></div>`).join('') : '<div class="studio-note" style="font-size:10px;">ChÆ°a cÃ³</div>'}
          </div>
        </div>
        <div class="studio-strip-block">
          <div class="studio-strip-head"><span>Video Ä‘Ã£ táº¡o (${card.outputs.length})</span></div>
          <div class="studio-strip">
            ${card.outputs.length ? card.outputs.map((out, i) => {
      const url = out.video_url || out.videoUri || out.fifeUrl || '';
      return `<div class="studio-video-thumb ${i === card.outputIndex ? 'active' : ''}" style="position:relative;" onclick="Studio.openVideoPopup('${card.id}',${i})">${url ? `<video src="${url}" muted preload="metadata"></video>` : '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--text3);font-size:10px;">Video</div>'}<button type="button" style="position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:none;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;padding:0;" onclick="event.stopPropagation();Studio.deleteVideo('${card.id}',${i})" title="XÃ³a video nÃ y">Ã—</button></div>`;
    }).join('') : '<div class="studio-note" style="font-size:10px;">ChÆ°a cÃ³</div>'}
          </div>
        </div>
        ${_cardLayout === 'horizontal' ? `</div></div>` : ''}
      </div>
    `;

    if (append) $('studio-cards').appendChild(el);
    // Prompt click â†’ modal
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
      files.forEach(file => card.refs.push({ url: URL.createObjectURL(file), file, label: file.name || 'áº¢nh tham chiáº¿u' }));
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
        <div><strong>Ãp dá»¥ng nhÃ¢n váº­t cho cá»¥m</strong><div class="studio-note">Chá»n tá»‘i Ä‘a 3 nhÃ¢n váº­t hoáº·c báº¥m AUTO Ä‘á»ƒ quÃ©t theo prompt.</div></div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="Studio.autoCharacters('${cardId}')">AUTO NhÃ¢n Váº­t</button>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('studio-char-picker-modal').style.display='none'">ÄÃ³ng</button>
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
    `).join('') : '<div class="studio-note" style="grid-column:1/-1;">ChÆ°a cÃ³ nhÃ¢n váº­t nÃ o trong thÆ° viá»‡n.</div>';
  }

  function toggleCharacter(cardId, id, name, url, mediaId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    const idx = card.chars.findIndex(ch => ch.id === id);
    if (idx >= 0) card.chars.splice(idx, 1);
    else {
      if (card.chars.length >= 3) return toast('Tá»‘i Ä‘a 3 nhÃ¢n váº­t cho má»—i cá»¥m', 'error');
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
    toast(card.chars.length ? ('Tá»± gáº¯n ' + card.chars.length + ' NhÃ¢n váº­t') : 'KhÃ´ng nháº­n ra NhÃ¢n váº­t nÃ o trong prompt', card.chars.length ? 'success' : 'info');
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
    if (!String(card.prompt || '').trim()) return toast('Nháº­p prompt trÆ°á»›c khi táº¡o hÃ¬nh', 'error');

    const MAX_RETRY = 3;
    let attempt = 0;

    while (attempt <= MAX_RETRY) {
      if (attempt > 0) {
        toast(`Thá»­ láº¡i láº§n ${attempt}/${MAX_RETRY}...`, 'info');
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
        if (!res.ok) throw new Error(res.detail || 'Táº¡o hÃ¬nh tháº¥t báº¡i');
        (res.images || []).forEach(img => {
          const url = img.url || img.downloadUrl || img.image_url || img.imageUrl || '';
          if (url) card.images.unshift({ url, media_id: img.media_id || img.mediaId || '', prompt: card.prompt, label: 'áº¢nh Ä‘Ã£ táº¡o' });
        });
        card.status = 'idle';
        card.busyImage = false;
        renderCard(card, false);
        updateStats();
        toast('ÄÃ£ táº¡o ' + (res.images || []).length + ' áº£nh cho card', 'success');
        return; // thÃ nh cÃ´ng
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRY) {
          card.status = 'failed';
          card.error = err.message;
          card.busyImage = false;
          renderCard(card, false);
          updateStats();
          toast('Lá»—i táº¡o hÃ¬nh: ' + err.message, 'error');
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
    // Upload áº£nh nhÃ¢n váº­t (chars) trÆ°á»›c â€” Æ°u tiÃªn cao nháº¥t
    for (let i = 0; i < card.chars.length; i++) {
      const ch = card.chars[i];
      let file = ch.file || null;
      if (!file && ch.url) file = await urlToFile(ch.url, `${card.id}_char_${i + 1}.png`);
      if (file) fd.append('reference_images', file, file.name || `${card.id}_char_${i + 1}.png`);
    }
    // Sau Ä‘Ã³ upload áº£nh refs thÃ´ng thÆ°á»ng
    for (let i = 0; i < card.refs.length; i++) {
      const ref = card.refs[i];
      let file = ref.file;
      if (!file && ref.url) file = await urlToFile(ref.url, `${card.id}_video_ref_${i + 1}.png`);
      if (file) fd.append('reference_images', file, file.name || `${card.id}_video_ref_${i + 1}.png`);
    }
    const res = await API.postForm('/api/veo/studio-video', fd);
    return { ok: res.ok, jobId: res.job_id || '', error: res.detail || res.message || '' };
  }

  async function genVideo(cardId, accountIndex = null) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    if (!String(card.prompt || '').trim()) return toast('Nháº­p prompt trÆ°á»›c khi táº¡o video', 'error');

    const MAX_RETRY = 3;
    let attempt = 0;

    while (attempt <= MAX_RETRY) {
      if (stopAll) break;
      if (attempt > 0) {
        toast(`Thá»­ láº¡i láº§n ${attempt}/${MAX_RETRY}...`, 'info');
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
        if (!req.ok || !req.jobId) throw new Error(req.error || 'Táº¡o video tháº¥t báº¡i');
        card.jobId = req.jobId;

        await pollJob(req.jobId, '/api/veo/job', async job => {
          if (stopAll) return;
          if (job.status === 'completed' || job.status === 'done') {
            card.outputs = Array.isArray(job.outputs) ? job.outputs.filter(Boolean) : [];
            card.status = card.outputs.length ? 'completed' : 'failed';
            card.busyVideo = false;
            card.error = card.outputs.length ? '' : 'KhÃ´ng cÃ³ video tráº£ vá»';
            renderCard(card, false);
            updateStats();
            if (card.outputs.length) {
              succeeded = true;
              if (cfg.autoUpscale) {
                const upscaleOk = await upscaleCard(card.id, 0);
                if (!upscaleOk) {
                  card.status = 'failed';
                  card.error = 'Upscale 1080p tháº¥t báº¡i â€” áº¥n "Upscale láº¡i" Ä‘á»ƒ thá»­ láº¡i rá»“i tá»± táº£i vá»';
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
            card.status = 'running'; // giá»¯ running Ä‘á»ƒ UI khÃ´ng hiá»‡n lá»—i sá»›m
            card.busyVideo = true;
          }
        });
      } catch (err) {
        shouldRetry = true;
        card.error = err.message;
      }

      if (succeeded) return; // xong, thoÃ¡t

      attempt++;
      if (!shouldRetry || attempt > MAX_RETRY) break;
    }

    // Háº¿t retry mÃ  váº«n fail
    card.status = 'failed';
    card.busyVideo = false;
    if (!card.error) card.error = `Tháº¥t báº¡i sau ${MAX_RETRY} láº§n thá»­`;
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

  // LÆ°u toÃ n bá»™ video 720p (cháº¥t lÆ°á»£ng gá»‘c, khÃ´ng upscale)
  async function saveAllVideos720() {
    if (!cfg.saveHandle) {
      await chooseFolder();
      if (!cfg.saveHandle) return toast('Vui lÃ²ng chá»n folder lÆ°u trÆ°á»›c', 'info');
    }
    const cardsWithOutput = cards.filter(c => c.outputs && c.outputs.length);
    if (!cardsWithOutput.length) return toast('ChÆ°a cÃ³ video nÃ o', 'info');
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
    if (saved > 0) toast(`ÄÃ£ lÆ°u ${saved} video 720p (gá»‘c)`, 'success');
    if (failed > 0) toast(`${failed} video tháº¥t báº¡i`, 'error');
  }

  // LÆ°u toÃ n bá»™ video 1080p: upscale náº¿u chÆ°a upscale, rá»“i lÆ°u
  async function saveAllVideos1080() {
    // Báº¯t buá»™c chá»n folder trÆ°á»›c
    if (!cfg.saveHandle) {
      await chooseFolder();
      if (!cfg.saveHandle) return toast('Vui lÃ²ng chá»n folder lÆ°u trÆ°á»›c', 'info');
    }
    const cardsWithOutput = cards.filter(c => c.outputs && c.outputs.length && c.status === 'completed');
    if (!cardsWithOutput.length) return toast('ChÆ°a cÃ³ video nÃ o hoÃ n táº¥t', 'info');
    toast(`Äang xá»­ lÃ½ ${cardsWithOutput.length} cá»¥m...`, 'info');
    let saved = 0, failed = 0;
    for (const card of cardsWithOutput) {
      for (let i = 0; i < card.outputs.length; i++) {
        const out = card.outputs[i];
        const cardIdx = String(cards.indexOf(card) + 1).padStart(3, '0');
        const filename = `studio_${cardIdx}_${i + 1}_1080p.mp4`;
        // Kiá»ƒm tra Ä‘Ã£ upscale chÆ°a: output upscale tráº£ vá» media_id má»›i vÃ  video_url khÃ¡c
        const alreadyUpscaled = !!out._upscaled;
        if (!alreadyUpscaled) {
          // Upscale trÆ°á»›c
          if (card.upscaling) {
            // Äá»£i upscale hiá»‡n táº¡i xong (tá»‘i Ä‘a 3 phÃºt)
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
              toast(`Cá»¥m ${cardIdx}: upscale tháº¥t báº¡i`, 'error');
              failed++;
            }
          } catch (err) {
            toast(`Cá»¥m ${cardIdx}: lá»—i upscale - ${err.message}`, 'error');
            failed++;
          } finally {
            card.upscaling = false;
            renderCard(card, false);
          }
        } else {
          // ÄÃ£ upscale rá»“i, lÆ°u luÃ´n
          const url1080 = out.video_url || out.videoUri || out.fifeUrl;
          if (url1080) { await saveVideo(url1080, filename); saved++; }
          else failed++;
        }
      }
    }
    if (saved > 0) toast(`ÄÃ£ lÆ°u ${saved} video 1080p`, 'success');
    if (failed > 0) toast(`${failed} video tháº¥t báº¡i`, 'error');
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
        toast('Upscale 1080p thÃ nh cÃ´ng', 'success');
        return true;
      } else {
        toast(res.body || res.message || 'Upscale tháº¥t báº¡i', 'error');
        return false;
      }
    } catch (err) {
      toast('Lá»—i upscale: ' + err.message, 'error');
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
    popup = { cardId, type, idx, url: item.url, prompt: card.prompt || '', label: item.label || '' };
    $('studio-popup-img').src = item.url;
    $('studio-popup-caption-text').textContent = (item.label || '') + (card.prompt ? ' Â· ' + card.prompt.slice(0, 120) : '');
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
            Chá»‰nh sá»­a Prompt â€” Cá»¥m ${cardIdx}
          </div>
          <button class="studio-prompt-modal-close" id="studio-prompt-modal-close-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <textarea id="studio-prompt-modal-ta" placeholder="Nháº­p prompt cho cá»¥m nÃ y...">${card.prompt || ''}</textarea>
        <div class="studio-prompt-modal-actions">
          <button class="btn btn-secondary" id="studio-prompt-modal-cancel">Há»§y</button>
          <button class="btn btn-primary" id="studio-prompt-modal-save">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>
            LÆ°u
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
    // Hiá»‡n dialog chá»n nhÃ³m trÆ°á»›c khi lÆ°u
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
        <div style="font-weight:600;margin-bottom:14px;">Chá»n nhÃ³m lÆ°u áº£nh</div>
        <select id="studio-save-lib-cat" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);color:var(--text1);margin-bottom:14px;">${opts}</select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('${modalId}').style.display='none'">Há»§y</button>
          <button class="btn btn-primary btn-sm" id="studio-save-lib-confirm">LÆ°u</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    $('studio-save-lib-confirm').onclick = async () => {
      const categoryId = $('studio-save-lib-cat').value || 'default';
      modal.style.display = 'none';
      const res = await API.post('/api/image/studio/save', { url: popup.url, prompt: popup.prompt || '', category_id: categoryId });
      if (res.ok) { toast('ÄÃ£ lÆ°u vÃ o kho', 'success'); loadLibrary(); }
      else toast(res.detail || 'LÆ°u tháº¥t báº¡i', 'error');
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
    if (!card) return toast('KhÃ´ng tÃ¬m tháº¥y cá»¥m', 'error');
    let file = null;
    try {
      // DÃ¹ng proxy náº¿u URL lÃ  Google (trÃ¡nh CORS + expire)
      const fetchUrl = (popup.url.includes('googleapis.com') || popup.url.includes('google.com'))
        ? `/api/veo/proxy-download?url=${encodeURIComponent(popup.url)}&filename=studio_ref_${Date.now()}.png`
        : popup.url;
      const resp = await fetch(fetchUrl);
      const blob = await resp.blob();
      file = new File([blob], `studio_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
    } catch (_) { }
    card.refs.unshift({ url: popup.url, file, label: 'áº¢nh chÃ¨n tá»« preview' });
    card.refIndex = 0;
    renderCard(card, false);
    closePopup();
    toast('ÄÃ£ thÃªm áº£nh vÃ o cá»¥m lÃ m áº£nh tham chiáº¿u', 'success');
  }

  function importImages(files) {
    const list = Array.from(files || []).filter(file => String(file.type || '').startsWith('image/'));
    if (!list.length) return toast('KhÃ´ng cÃ³ áº£nh há»£p lá»‡', 'error');
    list.forEach(file => {
      const card = createCard('');
      card.refs.push({ url: URL.createObjectURL(file), file, label: file.name || 'áº¢nh import' });
      renderCard(card, false);
    });
    updateStats();
    toast('ÄÃ£ náº¡p ' + list.length + ' áº£nh vÃ o Studio', 'success');
  }

  function importPromptsXlsx(file) {
    // DÃ¹ng SheetJS náº¿u cÃ³, fallback thÃ´ng bÃ¡o lá»—i
    if (typeof XLSX === 'undefined') return toast('ThÆ° viá»‡n XLSX chÆ°a Ä‘Æ°á»£c táº£i', 'error');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        // Má»—i hÃ ng lÃ  1 prompt â€” láº¥y toÃ n bá»™ hÃ ng join báº±ng tab, trim
        const prompts = rows
          .map(row => (Array.isArray(row) ? row : [row]).join('\t').trim())
          .filter(Boolean);
        if (!prompts.length) return toast('File Excel trá»‘ng hoáº·c khÃ´ng cÃ³ dá»¯ liá»‡u', 'error');
        const promptItems = prompts.map(p => ({ prompt: p }));

        if (cards.length > 0) {
          if (promptItems.length !== cards.length) {
            return toast(`Prompt khÃ´ng khá»›p: file cÃ³ ${promptItems.length} hÃ ng nhÆ°ng Studio Ä‘ang cÃ³ ${cards.length} cá»¥m`, 'error');
          }
          cards.forEach((card, i) => { card.prompt = promptItems[i].prompt; });
          rerender();
          toast('ÄÃ£ thay tháº¿ ' + promptItems.length + ' prompt tá»« Excel', 'success');
        } else {
          promptItems.forEach(item => createCard(item.prompt, item));
          updateStats();
          toast('ÄÃ£ import ' + promptItems.length + ' cá»¥m tá»« Excel', 'success');
        }
      } catch (err) {
        toast('Lá»—i Ä‘á»c file Excel: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function importPrompts(file, mode = 'txt') {
    const reader = new FileReader();
    reader.onload = e => {
      const raw = e.target.result;
      const promptItems = mode === 'json' ? parseJsonPromptCards(raw) : parsePrompts(raw).map(prompt => ({ prompt }));
      if (!promptItems.length) return toast('File prompt trá»‘ng hoáº·c khÃ´ng Ä‘Ãºng Ä‘á»‹nh dáº¡ng', 'error');

      // Replace mode: cards already exist â†’ only replace prompts, keep images/refs/outputs
      if (cards.length > 0) {
        if (promptItems.length !== cards.length) {
          return toast(
            `Prompt khÃ´ng khá»›p sá»‘ cá»¥m: file cÃ³ ${promptItems.length} prompt nhÆ°ng Studio Ä‘ang cÃ³ ${cards.length} cá»¥m. Vui lÃ²ng kiá»ƒm tra láº¡i.`,
            'error'
          );
        }
        cards.forEach((card, i) => { card.prompt = promptItems[i].prompt; });
        rerender();
        toast('ÄÃ£ thay tháº¿ ' + promptItems.length + ' prompt (giá»¯ nguyÃªn áº£nh/video)', 'success');
      } else {
        // Create mode: no cards yet â†’ create new cards
        promptItems.forEach(item => createCard(item.prompt, item));
        updateStats();
        toast('ÄÃ£ import ' + promptItems.length + ' cá»¥m prompt', 'success');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  function clearAllImages() {
    if (!cards.length) return toast('KhÃ´ng cÃ³ cá»¥m nÃ o', 'info');
    cards.forEach(card => {
      card.images = [];
      card.refs = [];
      card.refIndex = 0;
      card.chars = [];
    });
    rerender();
    toast('ÄÃ£ xÃ³a táº¥t cáº£ hÃ¬nh áº£nh, áº£nh tham chiáº¿u vÃ  nhÃ¢n váº­t khá»i táº¥t cáº£ cá»¥m', 'success');
  }

  async function autoCharactersAll() {
    if (!cards.length) return toast('KhÃ´ng cÃ³ cá»¥m nÃ o', 'info');
    const res = await API.get('/api/character/list');
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) return toast('ChÆ°a cÃ³ nhÃ¢n váº­t trong thÆ° viá»‡n', 'info');
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
    toast(`Auto nhÃ¢n váº­t xong: ${total} láº§n gáº¯n trÃªn ${cards.length} cá»¥m`, total ? 'success' : 'info');
  }

  // Semaphore: giá»›i háº¡n sá»‘ job cháº¡y Ä‘á»“ng thá»i
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
    // Náº¿u Ä‘ang lá»c "failed" thÃ¬ táº¡o láº¡i cÃ¡c card lá»—i, khÃ´ng Ä‘á»¥ng card Ä‘Ã£ xong
    const pending = _activeFilter === 'failed'
      ? cards.filter(c => !c.busyImage && c.status === 'failed' && String(c.prompt || '').trim())
      : cards.filter(c => !c.busyImage && String(c.prompt || '').trim());
    if (!pending.length) return toast('KhÃ´ng cÃ³ card nÃ o sáºµn sÃ ng táº¡o hÃ¬nh', 'error');
    stopAll = false;
    $('studio-gen-all-images').style.display = 'none';
    $('studio-stop-all').style.display = '';
    $('studio-stop-all').textContent = 'Dá»«ng toÃ n bá»™';
    $('studio-gen-all-videos').disabled = true;

    let accountIndices = [null], maxConcurrentImage = 2;
    try { ({ accountIndices, maxConcurrentImage } = await _loadGenCfg()); } catch (_) { }

    // Anti-block: delay 7-13s giá»¯a image requests (image dá»… bá»‹ block hÆ¡n video)
    const imgDelay = () => 7000 + Math.random() * 6000;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = accountIndices.length;
    toast(n > 1
      ? `Táº¡o áº£nh ${pending.length} card vá»›i ${n} tÃ i khoáº£n (tá»‘i Ä‘a ${maxConcurrentImage} áº£nh/tÃ i khoáº£n)`
      : `Báº¯t Ä‘áº§u táº¡o áº£nh ${pending.length} card (tá»‘i Ä‘a ${maxConcurrentImage} cÃ¹ng lÃºc)`, 'info');

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
    $('studio-stop-all').textContent = 'Äang dá»«ng...';
    $('studio-gen-all-videos').disabled = false;
    stopAll = false;
  }

  async function genAllVideos() {
    // Náº¿u Ä‘ang lá»c "failed" thÃ¬ táº¡o láº¡i cÃ¡c card lá»—i, khÃ´ng Ä‘á»¥ng card Ä‘Ã£ xong
    const pending = _activeFilter === 'failed'
      ? cards.filter(c => c.status === 'failed')
      : cards.filter(c => c.status === 'idle');
    if (!pending.length) return toast('KhÃ´ng cÃ³ card nÃ o chá» táº¡o video', 'error');
    stopAll = false;
    $('studio-gen-all-videos').style.display = 'none';
    $('studio-stop-all').style.display = '';
    $('studio-gen-all-images').disabled = true;

    let accountIndices = [null], maxConcurrent = 3;
    try { ({ accountIndices, maxConcurrent } = await _loadGenCfg()); } catch (_) { }
    // Cáº­p nháº­t global semaphore theo config má»›i nháº¥t
    _globalVideoSem = makeSemaphore(maxConcurrent);

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = accountIndices.length;
    toast(n > 1
      ? `Cháº¡y ${pending.length} card vá»›i ${n} tÃ i khoáº£n (tá»‘i Ä‘a ${maxConcurrent} job/tÃ i khoáº£n)`
      : `Báº¯t Ä‘áº§u táº¡o ${pending.length} video (tá»‘i Ä‘a ${maxConcurrent} cÃ¹ng lÃºc)`, 'info');

    if (n <= 1) {
      // Single account â€” semaphore pool
      const sem = makeSemaphore(maxConcurrent);
      let cardIdx = 0;
      await Promise.all(pending.map(card => sem(async () => {
        if (stopAll) return;
        const myIdx = cardIdx++;
        if (myIdx > 0) await sleep(2000 + Math.random() * 1000);
        await genVideo(card.id, accountIndices[0]);
      })));
    } else {
      // Multi-account: bucket round-robin, má»—i bucket cÃ³ semaphore riÃªng
      const buckets = accountIndices.map(() => []);
      pending.forEach((card, i) => buckets[i % n].push(card));
      await Promise.all(buckets.map(async (bucket, bi) => {
        const accIdx = accountIndices[bi];
        if (bi > 0) await sleep(bi * 1000); // stagger start giá»¯a cÃ¡c bucket
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
    $('studio-stop-all').textContent = 'Dá»«ng toÃ n bá»™';
    $('studio-gen-all-images').disabled = false;
    stopAll = false;
  }

  function clearAll() {
    cards = [];
    $('studio-cards').innerHTML = '';
    updateStats();
    toast('ÄÃ£ xÃ³a táº¥t cáº£ card trong Studio', 'success');
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

    // Add card â†’ open dialog
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
      toast('ÄÃ£ thÃªm ' + n + ' cá»¥m', 'success');
    });
    // Add card dialog cancel + overlay close
    $('studio-add-card-cancel')?.addEventListener('click', () => { $('studio-add-card-dialog').style.display = 'none'; });
    $('studio-add-card-dialog')?.addEventListener('click', e => { if (e.target === $('studio-add-card-dialog')) $('studio-add-card-dialog').style.display = 'none'; });

    $('studio-open-library-manager')?.addEventListener('click', () => {
      if (typeof window.switchTab === 'function') window.switchTab('character');
    });
    $('studio-import-images').addEventListener('click', () => $('studio-images-file').click());
    $('studio-images-file').addEventListener('change', e => { if (e.target.files?.length) importImages(e.target.files); e.target.value = ''; });

    // Import prompts â†’ open popup and show current card count + hint
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
      if (!cards.length) return toast('KhÃ´ng cÃ³ cá»¥m nÃ o', 'info');
      if (!confirm('XÃ³a táº¥t cáº£ hÃ¬nh áº£nh, áº£nh tham chiáº¿u vÃ  nhÃ¢n váº­t khá»i táº¥t cáº£ cá»¥m?')) return;
      clearAllImages();
    });

    // Auto nhÃ¢n váº­t táº¥t cáº£ cá»¥m (kept for backward compat, element may not exist)
    $('studio-auto-char-all-btn')?.addEventListener('click', () => {
      if (!cards.length) return toast('KhÃ´ng cÃ³ cá»¥m nÃ o', 'info');
      autoCharactersAll();
    });

    // Layout toggle ngang/dá»c
    function applyCardLayout() {
      const cardsEl = $('studio-cards');
      const btn = $('studio-layout-toggle');
      if (!cardsEl || !btn) return;
      if (_cardLayout === 'horizontal') {
        cardsEl.classList.add('layout-horizontal');
        btn.querySelector('svg').innerHTML = '<rect x="3" y="3" width="18" height="8" rx="1"/><rect x="3" y="13" width="18" height="8" rx="1"/>';
        btn.childNodes[btn.childNodes.length - 1].textContent = ' Card dá»c';
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
    $('studio-stop-all').addEventListener('click', () => { stopAll = true; $('studio-stop-all').textContent = 'Äang dá»«ng...'; });
    $('studio-clear-all').addEventListener('click', clearAll);
    // Save quality dropdown logic
    let _saveQuality = '1080'; // '1080' | '720'
    const _qualityMenu = $('studio-save-quality-menu');
    const _qualityToggle = $('studio-save-quality-toggle');

    function _updateQualityLabel() {
      if (_qualityToggle) _qualityToggle.textContent = _saveQuality === '1080' ? '1080p â–¾' : '720p â–¾';
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
        // TÃ­nh vá»‹ trÃ­ fixed dá»±a theo nÃºt toggle Ä‘á»ƒ thoÃ¡t khá»i overflow:hidden cá»§a toolbar
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

  // â”€â”€ Save Images Popup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _saveImgSelected = new Set(); // key = "cardId:imgIndex"

  function openSaveImagesPopup() {
    const allImages = [];
    cards.forEach(card => {
      card.images.forEach((img, i) => {
        allImages.push({ key: `${card.id}:${i}`, cardId: card.id, imgIdx: i, url: img.url, cardTitle: `Cá»¥m ${cards.indexOf(card) + 1}`, prompt: card.prompt || '' });
      });
    });
    if (!allImages.length) return toast('ChÆ°a cÃ³ áº£nh nÃ o Ä‘Æ°á»£c táº¡o', 'info');
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
      if (!selected.length) return toast('ChÆ°a chá»n áº£nh nÃ o', 'error');
      for (const item of selected) {
        const ext = (item.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
        downloadUrl(item.url, `studio_img_${item.cardTitle.replace(/\s/g, '_')}_${Date.now()}.${ext}`);
        await new Promise(r => setTimeout(r, 200));
      }
      toast(`ÄÃ£ táº£i ${selected.length} áº£nh vá» mÃ¡y`, 'success');
    };

    studio-save-images-to-lib.onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('Chưa chọn ảnh nào', 'error');
      const target = await pickLibrarySaveTarget(Chọn nhóm và thể loại lưu ( ảnh));
      if (!target) return;
      // Gửi song song để tránh URL Google expire trước khi gọi đến
      const results = await Promise.all(
        selected.map(item => API.post('/api/image/studio/save', {
          url: item.url,
          prompt: item.prompt,
          category_id: target.category_id,
          asset_type: target.asset_type
        }).catch(() => ({ ok: false })))
      );
      const ok = results.filter(r => r.ok).length;
      toast(Đã lưu / ảnh vào kho, ok === selected.length ? 'success' : 'info');
      loadLibrarySources().catch(() => { });
    };
    $('studio-save-images-add-to-card').onclick = async () => {
      const selected = allImages.filter(i => _saveImgSelected.has(i.key));
      if (!selected.length) return toast('ChÆ°a chá»n áº£nh nÃ o', 'error');
      $('studio-save-images-popup').style.display = 'none';
      let added = 0;
      for (const item of selected) {
        const card = cards.find(c => c.id === item.cardId);
        if (!card) continue;
        if (card.refs.some(r => r.url === item.url)) continue;
        // Fetch file qua proxy Ä‘á»ƒ trÃ¡nh CORS/expire cá»§a Google URL
        let file = null;
        try {
          const fetchUrl = (item.url.includes('googleapis.com') || item.url.includes('google.com'))
            ? `/api/veo/proxy-download?url=${encodeURIComponent(item.url)}&filename=studio_ref_${Date.now()}.png`
            : item.url;
          const resp = await fetch(fetchUrl);
          const blob = await resp.blob();
          file = new File([blob], `studio_ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
        } catch (_) { }
        card.refs.unshift({ url: item.url, file, label: `áº¢nh tá»« ${item.cardTitle}` });
        card.refIndex = 0;
        renderCard(card, false);
        added++;
      }
      toast(`ÄÃ£ thÃªm ${added} áº£nh vÃ o cá»¥m tÆ°Æ¡ng á»©ng`, 'success');
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
    if (!url) return toast('Video chÆ°a cÃ³ URL', 'error');
    _videoPopup = { cardId, idx, url };
    const player = document.getElementById('studio-video-popup-player');
    const caption = document.getElementById('studio-video-popup-caption');
    if (player) { player.src = url; player.load(); }
    if (caption) caption.textContent = `Video ${idx + 1} â€” Cá»¥m ${cards.findIndex(c => c.id === cardId) + 1}`;
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

  // â”€â”€ VAULT (Kho lÆ°u trá»¯) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _vaultAssets = [];
  let _vaultCategories = [];
  let _vaultSelectedIds = new Set();
  let _vaultTypeFilter = 'all';
  let _vaultGroupFilter = 'all';

  // Exact word boundary match Ä‘á»ƒ trÃ¡nh "sparky" khá»›p "sparkyjsjbd"
  function _matchesName(prompt, charName) {
    const p = norm(prompt);
    const n = norm(charName);
    if (!n) return false;
    // Word boundary: kÃ½ tá»± trÆ°á»›c/sau pháº£i lÃ  khoáº£ng tráº¯ng, dáº¥u cÃ¢u, hoáº·c Ä‘áº§u/cuá»‘i chuá»—i
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
      groupSel.innerHTML = '<option value="all">Táº¥t cáº£ nhÃ³m</option>' +
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
    if (countLabel) countLabel.textContent = `${items.length} áº£nh`;

    const typeLabel = { nhanvat: 'NhÃ¢n Váº­t', vatpham: 'Váº­t Pháº©m', style: 'Style', background: 'BG' };

    if (!items.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text3);font-size:13px;">KhÃ´ng cÃ³ áº£nh nÃ o</div>`;
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
        <div class="studio-vault-card-label">${item.name || 'ChÆ°a Ä‘áº·t tÃªn'}</div>
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
    if (el) el.textContent = `ÄÃ£ chá»n: ${_vaultSelectedIds.size}`;
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
      `<div class="lib-ctx-item vault-card-opt" data-cid="${card.id}">Cá»¥m ${idx + 1}</div>`
    ).join('') || '<div class="lib-ctx-head">ChÆ°a cÃ³ cá»¥m nÃ o</div>';
    listEl.querySelectorAll('.vault-card-opt').forEach(el => {
      el.addEventListener('click', () => {
        hideVaultMenus();
        addVaultItemsToCard(el.dataset.cid);
      });
    });
    // Clamp vá»‹ trÃ­ Ä‘á»ƒ khÃ´ng trÃ n viewport
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
    if (!_vaultSelectedIds.size) return toast('ChÆ°a chá»n áº£nh nÃ o', 'error');
    const card = cards.find(c => c.id === cardId);
    if (!card) return toast('KhÃ´ng tÃ¬m tháº¥y cá»¥m', 'error');
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
      card.refs.unshift({ url: item.url, file, label: item.name || 'áº¢nh kho' });
      card.refIndex = 0;
      renderCard(card, false);
      added++;
    }
    toast(`ÄÃ£ thÃªm ${added} áº£nh vÃ o cá»¥m`, added ? 'success' : 'info');
  }

  // Load nhanh: gáº¯n áº£nh vÃ o cÃ¡c cá»¥m cÃ³ prompt chá»©a tÃªn áº£nh (exact word match)
  async function vaultLoadQuick() {
    if (!cards.length) return toast('KhÃ´ng cÃ³ cá»¥m nÃ o', 'info');
    const items = _vaultFiltered();
    if (!items.length) return toast('KhÃ´ng cÃ³ áº£nh trong bá»™ lá»c', 'info');
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
        card.refs.unshift({ url: item.url, file, label: item.name || 'áº¢nh kho' });
        card.refIndex = 0;
        totalAdded++;
      }
    }
    rerender();
    toast(totalAdded ? `Load nhanh: thÃªm ${totalAdded} áº£nh vÃ o cÃ¡c cá»¥m` : 'KhÃ´ng khá»›p tÃªn nÃ o trong prompt', totalAdded ? 'success' : 'info');
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
      if (!_vaultSelectedIds.size) return toast('ChÆ°a chá»n áº£nh nÃ o', 'error');
      const btn = $('vault-add-to-card-btn');
      const rect = btn.getBoundingClientRect();
      showVaultAddCardMenu(rect.left, rect.top - 8);
    });

    // Context menu actions
    $('vault-ctx-delete')?.addEventListener('click', () => {
      hideVaultMenus();
      // XÃ³a khá»i táº¥t cáº£ cá»¥m (refs)
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
      toast(`ÄÃ£ xÃ³a ${removed} áº£nh khá»i cÃ¡c cá»¥m`, removed ? 'success' : 'info');
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
