/* ── Studio Tab ──────────────────────────────────────────────
   Features:
   - Tạo hình: generate images via Banana/Imagen model
   - Gallery with click popup: save to lib / download / add to T2V card
   - Job tracker: filter by status, split Ảnh vs Video
─────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ── State ───────────────────────────────────────────────── */
  const CFG = {
    aspect: 'IMAGE_ASPECT_RATIO_SQUARE',
    count: 1,
    chars: [],       // [{id, name, url, media_id}]
  };

  let _gallery = [];        // [{url, media_id, prompt}]
  let _popup = null;        // current popup image data
  let _statusFilter = 'all';
  let _initialized = false;

  /* ── Sub-tab switching ───────────────────────────────────── */
  function switchStudioTab(name) {
    document.querySelectorAll('.studio-subtab').forEach(t =>
      t.classList.toggle('active', t.dataset.studioTab === name));
    $('studio-panel-gen-image').style.display = name === 'gen-image' ? '' : 'none';
    $('studio-panel-tracker').style.display   = name === 'tracker'   ? '' : 'none';
    if (name === 'tracker') refreshJobs();
  }

  /* ── Image generation ────────────────────────────────────── */
  async function generateImages() {
    const prompt = ($('studio-prompt')?.value || '').trim();
    if (!prompt) { toast('Nhập prompt trước', 'error'); return; }

    const btn = $('studio-gen-btn');
    const statusEl = $('studio-gen-status');
    btn.disabled = true;
    if (statusEl) statusEl.style.display = 'flex';

    try {
      const payload = {
        prompt,
        aspect_ratio: CFG.aspect,
        output_count: CFG.count,
        model: 'Imagen 4',
      };

      // Add character reference if selected
      if (CFG.chars.length > 0) {
        payload.character_ids = CFG.chars.map(c => c.id);
      }

      const res = await API.post('/api/image/generate', payload);

      if (!res.ok) {
        toast(res.detail || 'Lỗi tạo ảnh', 'error');
        return;
      }

      const images = res.images || [];
      if (!images.length) { toast('Không có ảnh nào được tạo', 'error'); return; }

      images.forEach(img => {
        const url = img.url || img.image_url || img.imageUrl || '';
        if (url) {
          _gallery.unshift({ url, media_id: img.media_id || '', prompt });
        }
      });

      renderGallery();
      toast(`Đã tạo ${images.length} ảnh`, 'success');
    } catch (e) {
      toast('Lỗi: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      if (statusEl) statusEl.style.display = 'none';
    }
  }

  /* ── Gallery render ──────────────────────────────────────── */
  function renderGallery() {
    const el = $('studio-gallery');
    if (!el) return;
    if (!_gallery.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;text-align:center;padding:40px;">Chưa có ảnh. Nhập prompt và bấm Tạo hình ảnh.</div>';
      return;
    }
    el.innerHTML = _gallery.map((img, i) => `
      <div class="studio-img-card" onclick="Studio.openPopup(${i})" title="${(img.prompt || '').slice(0, 60)}">
        <img src="${img.url}" alt="studio-img-${i}" loading="lazy">
        <div class="studio-img-status">${(img.prompt || '').slice(0, 30) || 'Ảnh ' + (i + 1)}</div>
      </div>`).join('');
  }

  /* ── Popup ───────────────────────────────────────────────── */
  function openPopup(idx) {
    const img = _gallery[idx];
    if (!img) return;
    _popup = { ...img, idx };
    const popupEl = $('studio-img-popup');
    const imgEl = $('studio-popup-img');
    if (popupEl && imgEl) {
      imgEl.src = img.url;
      popupEl.style.display = 'flex';
    }
  }

  function closePopup() {
    const popupEl = $('studio-img-popup');
    if (popupEl) popupEl.style.display = 'none';
    _popup = null;
  }

  /* ── Popup actions ───────────────────────────────────────── */
  async function saveToLib() {
    if (!_popup) return;
    try {
      const res = await API.post('/api/image/studio/save', { url: _popup.url, prompt: _popup.prompt });
      if (res.ok) toast('Đã lưu vào kho Studio', 'success');
      else toast(res.detail || 'Lưu thất bại', 'error');
    } catch (e) {
      toast('Lỗi lưu: ' + e.message, 'error');
    }
  }

  function downloadImg() {
    if (!_popup) return;
    const ext = (_popup.url.split('?')[0].split('.').pop() || 'jpg').slice(0, 4);
    const filename = `studio_img_${Date.now()}.${ext}`;
    downloadUrl(_popup.url, filename);
    toast('Đang tải ảnh...', 'info');
  }

  function addToCard() {
    if (!_popup) return;
    // Show card picker — list T2V cards
    const cards = window.T2V?._getCards?.() || [];
    if (!cards.length) { toast('Chưa có card nào ở Text to Video', 'error'); return; }

    // Build a small selection modal
    let modal = $('studio-card-pick-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-card-pick-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:4000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;width:380px;max-height:70vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <strong>Chọn card để thêm ảnh</strong>
          <button onclick="document.getElementById('studio-card-pick-modal').style.display='none'" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;">✕</button>
        </div>
        ${cards.map((c, i) => `
          <div onclick="Studio._pickCard('${c.id}')" style="padding:10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-bottom:6px;transition:border-color .15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
            <span style="color:var(--text3);font-size:11px;">#${i + 1}</span>
            <span style="margin-left:8px;font-size:12px;">${(c.prompt || '(trống)').slice(0, 60)}</span>
          </div>`).join('')}
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
  }

  function _pickCard(cardId) {
    if (!_popup) return;
    window.T2V?._setCardImage?.(cardId, _popup.url);
    $('studio-card-pick-modal').style.display = 'none';
    closePopup();
    toast('Đã thêm ảnh vào card', 'success');
  }

  /* ── Character picker ────────────────────────────────────── */
  function openCharPicker() {
    let modal = $('studio-char-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-char-picker-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;width:440px;max-height:80vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <strong>Chọn nhân vật tham chiếu</strong>
          <button onclick="document.getElementById('studio-char-picker-modal').style.display='none'" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px;" id="studio-char-grid">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

    API.get('/api/character/list').then(res => {
      const chars = res.data || [];
      const grid = $('studio-char-grid');
      if (!grid) return;
      if (!chars.length) {
        grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có nhân vật.</div>';
        return;
      }
      const selectedIds = new Set(CFG.chars.map(c => c.id));
      grid.innerHTML = chars.map(ch => `
        <div onclick="Studio._pickChar('${ch.id}','${ch.name}','${ch.url}','${ch.media_id || ''}')"
          style="cursor:pointer;border:2px solid ${selectedIds.has(ch.id) ? 'var(--accent)' : 'var(--border)'};border-radius:8px;overflow:hidden;text-align:center;transition:border-color .15s;">
          <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;">
          <div style="font-size:10px;padding:4px;color:var(--text2);">${ch.name}</div>
        </div>`).join('');
    });
  }

  function _pickChar(id, name, url, mediaId) {
    if (CFG.chars.some(c => c.id === id)) {
      CFG.chars = CFG.chars.filter(c => c.id !== id);
    } else {
      if (CFG.chars.length >= 2) { toast('Tối đa 2 nhân vật', 'error'); return; }
      CFG.chars.push({ id, name, url, media_id: mediaId });
    }
    $('studio-char-picker-modal').style.display = 'none';
    _renderCharStrip();
  }

  function _renderCharStrip() {
    const strip = $('studio-char-strip');
    if (!strip) return;
    strip.innerHTML = CFG.chars.map((ch, i) => `
      <div class="t2v-char-thumb" title="${ch.name}">
        <img src="${ch.url}" alt="${ch.name}">
        <span>${ch.name}</span>
        <button onclick="Studio._removeChar(${i})" style="position:absolute;top:-4px;right:-4px;background:var(--red);border:none;border-radius:50%;width:14px;height:14px;color:#fff;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">✕</button>
      </div>`).join('') +
      `<div class="t2v-char-add" onclick="Studio.openCharPicker()" title="Thêm nhân vật">+</div>`;
  }

  function _removeChar(idx) {
    CFG.chars.splice(idx, 1);
    _renderCharStrip();
  }

  function clearGallery() {
    _gallery = [];
    renderGallery();
  }

  /* ── Job Tracker ─────────────────────────────────────────── */
  async function refreshJobs() {
    try {
      const [imgRes, vidRes] = await Promise.all([
        API.get(`/api/veo/jobs?type=image&status=${_statusFilter === 'all' ? '' : _statusFilter}&limit=50`),
        API.get(`/api/veo/jobs?type=video&status=${_statusFilter === 'all' ? '' : _statusFilter}&limit=50`),
      ]);
      renderJobList('studio-img-jobs', imgRes.jobs || []);
      renderJobList('studio-video-jobs', vidRes.jobs || []);
    } catch (e) {
      toast('Lỗi tải jobs: ' + e.message, 'error');
    }
  }

  const STATUS_LABELS = {
    pending: 'Chờ', running: 'Đang chạy', processing: 'Đang xử lý',
    completed: 'Xong', done: 'Xong', failed: 'Lỗi', cancelled: 'Đã hủy',
  };
  const STATUS_COLORS = {
    pending: 'var(--text3)', running: 'var(--accent)', processing: 'var(--orange)',
    completed: 'var(--green)', done: 'var(--green)', failed: 'var(--red)', cancelled: 'var(--text3)',
  };

  function renderJobList(elId, jobs) {
    const el = $(elId);
    if (!el) return;
    if (!jobs.length) {
      el.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:12px;text-align:center;">Không có jobs</div>';
      return;
    }
    el.innerHTML = jobs.map(j => {
      const thumb = j.outputs?.[0]?.video_url || j.outputs?.[0]?.image_url || '';
      const status = j.status || 'pending';
      const color = STATUS_COLORS[status] || 'var(--text3)';
      const label = STATUS_LABELS[status] || status;
      const promptText = (j.prompt || j.id || '').slice(0, 50);
      return `
        <div class="studio-job-row">
          ${thumb ? `<img class="studio-job-thumb" src="${thumb}" alt="">` : `<div class="studio-job-thumb" style="display:flex;align-items:center;justify-content:center;"><span style="font-size:16px;opacity:.3;">?</span></div>`}
          <div class="studio-job-info">
            <div class="studio-job-prompt">${promptText || j.id}</div>
            <div class="studio-job-meta">${new Date(j.created_at || Date.now()).toLocaleTimeString('vi-VN')}</div>
          </div>
          <span style="font-size:10px;color:${color};font-weight:500;flex-shrink:0;">${label}</span>
        </div>`;
    }).join('');
  }

  /* ── Init ────────────────────────────────────────────────── */
  window.init_studio = function () {
    if (_initialized) return;
    _initialized = true;

    // Sub-tabs
    document.querySelectorAll('.studio-subtab').forEach(t => {
      t.addEventListener('click', () => switchStudioTab(t.dataset.studioTab));
    });

    // Gen button
    $('studio-gen-btn')?.addEventListener('click', generateImages);

    // Aspect
    $('studio-aspect')?.addEventListener('change', e => { CFG.aspect = e.target.value; });

    // Count buttons
    document.querySelectorAll('.studio-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CFG.count = parseInt(btn.dataset.val);
      });
    });

    // Status filter
    document.querySelectorAll('#studio-status-bar .studio-status-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#studio-status-bar .studio-status-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _statusFilter = btn.dataset.status;
        refreshJobs();
      });
    });

    // Close popup on overlay click
    $('studio-img-popup')?.addEventListener('click', e => {
      if (e.target === $('studio-img-popup')) closePopup();
    });

    renderGallery();
  };

  /* ── Public API ──────────────────────────────────────────── */
  window.Studio = {
    openPopup,
    closePopup,
    saveToLib,
    downloadImg,
    addToCard,
    openCharPicker,
    _pickChar,
    _removeChar,
    _pickCard,
    clearGallery,
    refreshJobs,
  };
})();
