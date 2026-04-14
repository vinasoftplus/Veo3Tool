# Phase 03 — Studio Tab

## Overview

New "Studio" sidebar tab with two sub-features:
1. **Tạo hình** — image generation (Banana/Nano Pro model), gallery, click-to-action popup
2. **Bộ lọc trạng thái** — split view: Ảnh tab and Video tab with status filter

Architecture decisions:
- New `static/js/tabs/studio.js` IIFE module, exposes `window.Studio`
- One new backend endpoint `POST /api/image/studio/save` in `routers/image.py`
- `app.py`: mount `/studio-images` static dir for serving saved files
- Status filtering for Studio images stored as job_type `'studio_image'` in existing `jobs` SQLite table — no schema change

---

## Files to Modify / Create

| File | Action |
|------|--------|
| `templates/index.html` | Add sidebar nav item + tab panel HTML + `<script>` tag |
| `static/js/tabs/studio.js` | CREATE — full tab logic |
| `static/css/app.css` | Add Studio-specific styles |
| `routers/image.py` | Add `POST /studio/save` endpoint |
| `app.py` | Mount `/studio-images` static dir + `startup` mkdir |

---

## Part A — Backend Changes

### `routers/image.py`

Add at end of file (after existing routes):

```python
# ---------------------------------------------------------------------------
# Studio — save generated image to library
# ---------------------------------------------------------------------------

class StudioSaveRequest(BaseModel):
    url: str                       # remote URL or data:image/... base64
    filename: str | None = None


@router.post("/studio/save")
async def studio_save(req: StudioSaveRequest):
    """Save a studio-generated image to data/studio/ and record in job_store."""
    import httpx, re

    studio_dir = BASE_DIR / "data" / "studio"
    studio_dir.mkdir(parents=True, exist_ok=True)

    fname = req.filename or f"studio_{uuid.uuid4().hex[:12]}.jpg"
    out_path = studio_dir / fname

    if req.url.startswith("data:"):
        # base64 data URI
        match = re.match(r"data:image/\w+;base64,(.+)", req.url)
        if not match:
            raise HTTPException(400, "Invalid data URI")
        out_path.write_bytes(__import__('base64').b64decode(match.group(1)))
    else:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
            out_path.write_bytes(resp.content)

    local_url = f"/studio-images/{fname}"
    return {"ok": True, "local_url": local_url, "filename": fname}
```

### `app.py`

In `on_startup` (after line 66):
```python
        (APP_BASE / "data" / "studio").mkdir(parents=True, exist_ok=True)
```

After existing `app.mount("/characters", ...)` line (~line 57):
```python
    app.mount("/studio-images", StaticFiles(directory=str(APP_BASE / "data" / "studio"), html=False), name="studio-images")
```

---

## Part B — Sidebar Navigation

### `templates/index.html`

In the `HÌNH ẢNH` nav section (after `gen-image-banana` nav-item, around line 129), add:

```html
        <div class="nav-item" data-tab="studio">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
            <path d="M14 2h4v4"/>
          </svg>
          <span class="nav-label">Studio</span>
          <span class="nav-badge new">NEW</span>
        </div>
```

---

## Part C — Tab Panel HTML

### `templates/index.html`

Add new tab panel after the `tab-gen-image-banana` panel (find `<!-- FRAME CUTTER` comment as anchor, insert before it):

```html
        <!-- STUDIO ════════════════════════════════════════════ -->
        <div id="tab-studio" class="tab-panel">

          <!-- Sub-tab bar -->
          <div class="studio-subtab-bar">
            <button class="studio-subtab active" data-subtab="studio-gen">Tạo hình</button>
            <button class="studio-subtab" data-subtab="studio-filter">Bộ lọc trạng thái</button>
          </div>

          <!-- ── Sub-tab: Tạo hình ───────────────────────────── -->
          <div id="subtab-studio-gen" class="studio-subtab-panel active">
            <div class="studio-gen-layout">
              <!-- Left: controls -->
              <div class="studio-gen-controls card">
                <div class="card-title">Tạo hình ảnh</div>
                <div class="form-group">
                  <label class="form-label">Prompt</label>
                  <textarea id="studio-prompt" class="prompt-area" rows="4" placeholder="Mô tả hình ảnh muốn tạo..."></textarea>
                </div>
                <div class="form-group">
                  <label class="form-label">Nhân vật (tùy chọn)</label>
                  <div id="studio-char-strip" style="display:flex;flex-wrap:wrap;gap:6px;min-height:36px;align-items:center;">
                    <div class="t2v-char-add" id="studio-char-add" title="Thêm nhân vật">+</div>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Model</label>
                  <select id="studio-model" class="t2v-select" style="width:100%;">
                    <option value="Banana Pro">Banana Pro</option>
                    <option value="Nano Pro">Nano Pro</option>
                    <option value="Imagen 4">Imagen 4</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Tỷ lệ</label>
                  <div class="t2v-ctrl-group">
                    <button class="studio-ratio-btn active" data-val="IMAGE_ASPECT_RATIO_LANDSCAPE">16:9</button>
                    <button class="studio-ratio-btn" data-val="IMAGE_ASPECT_RATIO_PORTRAIT">9:16</button>
                    <button class="studio-ratio-btn" data-val="IMAGE_ASPECT_RATIO_SQUARE">1:1</button>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">Số lượng</label>
                  <div class="t2v-ctrl-group">
                    <button class="studio-count-btn active" data-val="1">1</button>
                    <button class="studio-count-btn" data-val="2">2</button>
                    <button class="studio-count-btn" data-val="4">4</button>
                  </div>
                </div>
                <button id="studio-gen-btn" class="btn btn-primary" style="width:100%;margin-top:8px;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:middle;">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  Tạo hình
                </button>
                <div id="studio-gen-status" style="margin-top:8px;font-size:12px;color:var(--text2);min-height:20px;"></div>
              </div>

              <!-- Right: gallery -->
              <div class="studio-gallery-area">
                <div class="studio-gallery-header">
                  <span style="font-size:13px;font-weight:600;">Kết quả (<span id="studio-img-count">0</span>)</span>
                  <button class="btn btn-secondary btn-sm" id="studio-clear-gallery">Xóa tất cả</button>
                </div>
                <div id="studio-gallery" class="studio-gallery"></div>
                <div id="studio-gallery-empty" style="text-align:center;padding:48px 20px;color:var(--text3);">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin:0 auto 10px;display:block;opacity:.3;">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <div>Nhập prompt và nhấn Tạo hình</div>
                </div>
              </div>
            </div>
          </div>

          <!-- ── Sub-tab: Bộ lọc trạng thái ─────────────────── -->
          <div id="subtab-studio-filter" class="studio-subtab-panel">
            <div class="studio-filter-layout">
              <!-- Filter sidebar -->
              <div class="studio-filter-sidebar card">
                <div class="card-title">Bộ lọc</div>

                <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px;text-transform:uppercase;">Ảnh</div>
                <div class="studio-filter-group" id="studio-img-filters">
                  <label class="studio-filter-item active" data-type="img" data-status="all">
                    <input type="radio" name="studio-img-status" value="all" checked> Tất cả
                  </label>
                  <label class="studio-filter-item" data-type="img" data-status="queued">
                    <input type="radio" name="studio-img-status" value="queued">
                    <span class="status-dot" style="background:var(--text3)"></span> Chờ
                  </label>
                  <label class="studio-filter-item" data-type="img" data-status="running">
                    <input type="radio" name="studio-img-status" value="running">
                    <span class="status-dot" style="background:var(--accent)"></span> Đang chạy
                  </label>
                  <label class="studio-filter-item" data-type="img" data-status="processing">
                    <input type="radio" name="studio-img-status" value="processing">
                    <span class="status-dot" style="background:var(--orange)"></span> Đang xử lý
                  </label>
                  <label class="studio-filter-item" data-type="img" data-status="completed">
                    <input type="radio" name="studio-img-status" value="completed">
                    <span class="status-dot" style="background:var(--green)"></span> Xong
                  </label>
                  <label class="studio-filter-item" data-type="img" data-status="failed">
                    <input type="radio" name="studio-img-status" value="failed">
                    <span class="status-dot" style="background:var(--red)"></span> Lỗi
                  </label>
                </div>

                <div style="font-size:11px;font-weight:700;color:var(--text3);margin:14px 0 6px;text-transform:uppercase;">Video</div>
                <div class="studio-filter-group" id="studio-vid-filters">
                  <label class="studio-filter-item active" data-type="vid" data-status="all">
                    <input type="radio" name="studio-vid-status" value="all" checked> Tất cả
                  </label>
                  <label class="studio-filter-item" data-type="vid" data-status="queued">
                    <input type="radio" name="studio-vid-status" value="queued">
                    <span class="status-dot" style="background:var(--text3)"></span> Chờ
                  </label>
                  <label class="studio-filter-item" data-type="vid" data-status="running">
                    <input type="radio" name="studio-vid-status" value="running">
                    <span class="status-dot" style="background:var(--accent)"></span> Đang chạy
                  </label>
                  <label class="studio-filter-item" data-type="vid" data-status="processing">
                    <input type="radio" name="studio-vid-status" value="processing">
                    <span class="status-dot" style="background:var(--orange)"></span> Đang xử lý
                  </label>
                  <label class="studio-filter-item" data-type="vid" data-status="completed">
                    <input type="radio" name="studio-vid-status" value="completed">
                    <span class="status-dot" style="background:var(--green)"></span> Xong
                  </label>
                  <label class="studio-filter-item" data-type="vid" data-status="failed">
                    <input type="radio" name="studio-vid-status" value="failed">
                    <span class="status-dot" style="background:var(--red)"></span> Lỗi
                  </label>
                </div>
                <button class="btn btn-secondary btn-sm" id="studio-filter-refresh" style="margin-top:12px;width:100%;">Làm mới</button>
              </div>

              <!-- Split view: images + videos -->
              <div class="studio-split-view">
                <div class="studio-split-pane">
                  <div class="studio-split-title">Ảnh</div>
                  <div id="studio-filter-img-list" class="studio-job-list"></div>
                </div>
                <div class="studio-split-pane">
                  <div class="studio-split-title">Video</div>
                  <div id="studio-filter-vid-list" class="studio-job-list"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Image action popup (shared) -->
          <div id="studio-img-popup" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:4000;align-items:center;justify-content:center;">
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:0;max-width:520px;width:95vw;overflow:hidden;">
              <div style="position:relative;">
                <img id="studio-popup-img" src="" alt="" style="width:100%;display:block;max-height:360px;object-fit:contain;background:var(--bg);">
                <button onclick="Studio.closePopup()" style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);border:none;border-radius:50%;width:28px;height:28px;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
              </div>
              <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
                <div style="font-size:12px;color:var(--text2);margin-bottom:4px;">Chọn hành động:</div>
                <button class="btn btn-primary" onclick="Studio.saveToLibrary()">
                  💾 Lưu vào kho (data/studio/)
                </button>
                <button class="btn btn-secondary" onclick="Studio.saveToMachine()">
                  ⬇ Lưu về máy
                </button>
                <div style="border-top:1px solid var(--border);padding-top:10px;">
                  <div style="font-size:12px;color:var(--text2);margin-bottom:6px;">Thêm vào card T2V:</div>
                  <select id="studio-popup-card-sel" class="t2v-select" style="width:100%;margin-bottom:8px;">
                    <option value="">— Chọn card —</option>
                  </select>
                  <button class="btn btn-secondary" onclick="Studio.addImageToCard()" style="width:100%;">+ Thêm vào card đã chọn</button>
                </div>
              </div>
            </div>
          </div>
        </div>
```

---

## Part D — Script Tag

In `templates/index.html`, add before `</body>`:
```html
  <script src="/static/js/tabs/studio.js"></script>
```

---

## Part E — `static/js/tabs/studio.js` (NEW FILE)

```js
/* ── Studio Tab ─────────────────────────────────────────────
   Sub-tabs: "Tạo hình" and "Bộ lọc trạng thái"
   Exposes: window.Studio
──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── State ───────────────────────────────────────────────── */
  const CFG = {
    model: 'Banana Pro',
    ratio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    count: 1,
  };

  let _gallery = [];          // [{url, local_url?}]
  let _popupUrl = '';
  let _popupIdx = -1;
  let _chars = [];            // selected chars for generation
  let _globalChars = [];
  let _initialized = false;

  const $ = id => document.getElementById(id);

  /* ── Sub-tab switching ───────────────────────────────────── */
  function initSubTabs() {
    document.querySelectorAll('.studio-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-subtab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.studio-subtab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`subtab-${btn.dataset.subtab}`)?.classList.add('active');
        if (btn.dataset.subtab === 'studio-filter') loadFilteredJobs();
      });
    });
  }

  /* ── Image generation ────────────────────────────────────── */
  async function generateImages() {
    const prompt = $('studio-prompt').value.trim();
    if (!prompt) { toast('Nhập prompt trước', 'error'); return; }

    const genBtn = $('studio-gen-btn');
    const statusEl = $('studio-gen-status');
    genBtn.disabled = true;
    statusEl.innerHTML = '<span class="pulse">Đang gửi yêu cầu...</span>';

    try {
      const res = await API.post('/api/image/generate', {
        prompt,
        aspect_ratio: CFG.ratio,
        output_count: CFG.count,
        model: CFG.model,
      });

      if (!res.ok) {
        toast(res.detail || 'Tạo ảnh thất bại', 'error');
        statusEl.textContent = 'Lỗi: ' + (res.detail || 'Unknown');
        return;
      }

      const images = res.images || [];
      if (!images.length) {
        toast('Không có ảnh nào được tạo', 'error');
        statusEl.textContent = 'Không có kết quả';
        return;
      }

      images.forEach(img => {
        const url = img.url || img.imageUri || img.fifeUrl || img;
        if (url) _gallery.unshift({ url });
      });

      renderGallery();
      statusEl.textContent = `Đã tạo ${images.length} ảnh`;
      toast(`Tạo thành công ${images.length} ảnh`, 'success');
    } catch (e) {
      toast('Lỗi: ' + e.message, 'error');
      statusEl.textContent = 'Lỗi kết nối';
    } finally {
      genBtn.disabled = false;
    }
  }

  function renderGallery() {
    const gallery = $('studio-gallery');
    const empty = $('studio-gallery-empty');
    $('studio-img-count').textContent = _gallery.length;

    if (!_gallery.length) {
      gallery.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    gallery.innerHTML = _gallery.map((item, idx) => `
      <div class="studio-gallery-item" onclick="Studio.openPopup(${idx})">
        <img src="${item.local_url || item.url}" alt="studio-img-${idx}" loading="lazy">
        ${item.saved ? '<div class="studio-saved-badge">✓ Đã lưu</div>' : ''}
      </div>`).join('');
  }

  /* ── Popup ───────────────────────────────────────────────── */
  function openPopup(idx) {
    const item = _gallery[idx];
    if (!item) return;
    _popupIdx = idx;
    _popupUrl = item.local_url || item.url;
    $('studio-popup-img').src = _popupUrl;

    // Populate T2V card selector
    const sel = $('studio-popup-card-sel');
    sel.innerHTML = '<option value="">— Chọn card —</option>';
    // Access T2V cards via global (they share window scope)
    if (window.T2V && typeof window._T2V_getCards === 'function') {
      window._T2V_getCards().forEach((card, i) => {
        const opt = document.createElement('option');
        opt.value = card.id;
        opt.textContent = `#${i + 1} ${card.prompt.slice(0, 40) || '(trống)'}`;
        sel.appendChild(opt);
      });
    }

    const popup = $('studio-img-popup');
    popup.style.display = 'flex';
    popup.onclick = e => { if (e.target === popup) closePopup(); };
  }

  function closePopup() {
    $('studio-img-popup').style.display = 'none';
    _popupUrl = '';
    _popupIdx = -1;
  }

  async function saveToLibrary() {
    if (!_popupUrl) return;
    try {
      const res = await API.post('/api/image/studio/save', { url: _popupUrl });
      if (res.ok) {
        if (_popupIdx >= 0 && _gallery[_popupIdx]) {
          _gallery[_popupIdx].local_url = res.local_url;
          _gallery[_popupIdx].saved = true;
        }
        renderGallery();
        toast('Đã lưu vào kho: ' + (res.filename || ''), 'success');
        closePopup();
      } else {
        toast('Lưu thất bại', 'error');
      }
    } catch (e) {
      toast('Lỗi lưu ảnh: ' + e.message, 'error');
    }
  }

  function saveToMachine() {
    if (!_popupUrl) return;
    const fname = 'studio_' + Date.now() + '.jpg';
    downloadUrl(_popupUrl, fname);
    closePopup();
  }

  function addImageToCard() {
    const cardId = $('studio-popup-card-sel').value;
    if (!cardId) { toast('Chọn card trước', 'error'); return; }
    if (typeof window._T2V_setCardImage === 'function') {
      window._T2V_setCardImage(cardId, _popupUrl);
      toast('Đã thêm ảnh vào card', 'success');
      closePopup();
    } else {
      toast('Tính năng chưa được hỗ trợ bởi tab T2V', 'error');
    }
  }

  /* ── Character strip ─────────────────────────────────────── */
  function renderCharStrip() {
    const strip = $('studio-char-strip');
    const thumbs = _chars.map((ch, i) => `
      <div class="t2v-char-thumb" title="${ch.name}">
        <img src="${ch.url}" alt="${ch.name}">
        <span>${ch.name}</span>
        <button onclick="Studio.removeChar(${i})" style="position:absolute;top:-4px;right:-4px;background:var(--red);border:none;border-radius:50%;width:14px;height:14px;color:#fff;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">✕</button>
      </div>`).join('');
    strip.innerHTML = thumbs + '<div class="t2v-char-add" id="studio-char-add" onclick="Studio.openCharPicker()" title="Thêm nhân vật">+</div>';
  }

  function openCharPicker() {
    let modal = document.getElementById('studio-char-picker');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'studio-char-picker';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    const existingIds = new Set(_chars.map(c => c.id));
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;width:480px;max-height:80vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <strong>Chọn nhân vật</strong>
          <button onclick="document.getElementById('studio-char-picker').style.display='none'" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:18px;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px;" id="studio-char-grid">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    API.get('/api/character/list').then(res => {
      const chars = res.data || [];
      const grid = document.getElementById('studio-char-grid');
      if (!chars.length) { grid.innerHTML = '<div style="color:var(--text3);font-size:12px;grid-column:1/-1;">Chưa có nhân vật.</div>'; return; }
      grid.innerHTML = chars.map(ch => `
        <div onclick="Studio.pickChar('${ch.id}','${ch.name}','${ch.url}','${ch.media_id || ''}')"
          style="cursor:pointer;border:2px solid ${existingIds.has(ch.id) ? 'var(--accent)' : 'var(--border)'};border-radius:8px;overflow:hidden;text-align:center;">
          <img src="${ch.url}" alt="${ch.name}" style="width:100%;aspect-ratio:1;object-fit:cover;">
          <div style="font-size:10px;padding:4px;color:var(--text2);">${ch.name}</div>
        </div>`).join('');
    });
  }

  /* ── Status filter view ──────────────────────────────────── */
  async function loadFilteredJobs() {
    const imgStatus = document.querySelector('input[name="studio-img-status"]:checked')?.value || 'all';
    const vidStatus = document.querySelector('input[name="studio-vid-status"]:checked')?.value || 'all';

    await Promise.all([
      loadJobList('studio_image', imgStatus, 'studio-filter-img-list'),
      loadJobList('t2v', vidStatus, 'studio-filter-vid-list'),
    ]);
  }

  async function loadJobList(jobType, status, containerId) {
    const container = $(containerId);
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const params = new URLSearchParams({ type: jobType });
      if (status && status !== 'all') params.set('status', status);
      const res = await API.get(`/api/veo/jobs?${params}`);
      const jobs = res.jobs || res.data || [];
      if (!jobs.length) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">Không có kết quả</div>';
        return;
      }
      container.innerHTML = jobs.map(job => `
        <div class="studio-job-item">
          <div class="studio-job-status">
            <span class="job-status ${job.status}${job.status === 'running' ? ' pulse' : ''}">${_statusLabel(job.status)}</span>
          </div>
          <div class="studio-job-info">
            <div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${(job.params?.prompt || job.params?.prompts?.[0] || '—').slice(0, 60)}</div>
            <div style="font-size:10px;color:var(--text3);">${job.created_at?.slice(0, 16).replace('T', ' ') || ''}</div>
          </div>
        </div>`).join('');
    } catch (e) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red);font-size:12px;">Lỗi tải dữ liệu</div>';
    }
  }

  function _statusLabel(s) {
    return { queued: 'Chờ', running: 'Đang chạy', processing: 'Đang xử lý', completed: 'Xong', done: 'Xong', failed: 'Lỗi' }[s] || s;
  }

  /* ── Init ────────────────────────────────────────────────── */
  window.init_studio = function () {
    if (_initialized) return;
    _initialized = true;

    initSubTabs();

    // Model
    $('studio-model').addEventListener('change', e => { CFG.model = e.target.value; });

    // Ratio buttons
    document.querySelectorAll('.studio-ratio-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-ratio-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CFG.ratio = btn.dataset.val;
      });
    });

    // Count buttons
    document.querySelectorAll('.studio-count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.studio-count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CFG.count = parseInt(btn.dataset.val);
      });
    });

    // Generate
    $('studio-gen-btn').addEventListener('click', generateImages);

    // Clear gallery
    $('studio-clear-gallery').addEventListener('click', () => {
      _gallery = [];
      renderGallery();
    });

    // Filter refresh
    $('studio-filter-refresh').addEventListener('click', loadFilteredJobs);

    // Filter radio change
    document.querySelectorAll('#studio-img-filters input, #studio-vid-filters input').forEach(r => {
      r.addEventListener('change', () => {
        // Update active class on labels
        r.closest('.studio-filter-group').querySelectorAll('.studio-filter-item').forEach(l => l.classList.remove('active'));
        r.closest('.studio-filter-item').classList.add('active');
        loadFilteredJobs();
      });
    });
  };

  /* ── Public API ──────────────────────────────────────────── */
  window.Studio = {
    openPopup,
    closePopup,
    saveToLibrary,
    saveToMachine,
    addImageToCard,
    openCharPicker,
    pickChar(charId, name, url, mediaId) {
      if (_chars.length >= 3) { toast('Tối đa 3 nhân vật', 'error'); return; }
      if (_chars.some(c => c.id === charId)) return;
      _chars.push({ id: charId, name, url, media_id: mediaId });
      renderCharStrip();
      document.getElementById('studio-char-picker').style.display = 'none';
    },
    removeChar(idx) {
      _chars.splice(idx, 1);
      renderCharStrip();
    },
  };
})();
```

---

## Part F — `static/css/app.css` Additions

Append at end of file:

```css
/* ── Studio Tab ───────────────────────────────────────────── */
.studio-subtab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0;
  padding: 0 16px;
  background: var(--bg2);
  flex-shrink: 0;
}

.studio-subtab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text2);
  cursor: pointer;
  padding: 10px 16px;
  font-size: 13px;
  transition: color var(--transition), border-color var(--transition);
}

.studio-subtab:hover { color: var(--text); }
.studio-subtab.active { color: var(--accent); border-bottom-color: var(--accent); }

.studio-subtab-panel { display: none; flex: 1; overflow: auto; }
.studio-subtab-panel.active { display: flex; flex-direction: column; }

/* Tạo hình layout */
.studio-gen-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow: hidden;
}

.studio-gen-controls {
  overflow-y: auto;
  height: 100%;
}

.studio-gallery-area {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.studio-gallery-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.studio-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
  overflow-y: auto;
  flex: 1;
}

.studio-gallery-item {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
  cursor: pointer;
  aspect-ratio: 1;
  background: var(--bg3);
  transition: border-color var(--transition);
}

.studio-gallery-item:hover { border-color: var(--accent); }
.studio-gallery-item img { width: 100%; height: 100%; object-fit: cover; display: block; }

.studio-saved-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(34, 197, 94, 0.85);
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
}

/* Filter view */
.studio-filter-layout {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow: hidden;
}

.studio-filter-sidebar {
  overflow-y: auto;
}

.studio-filter-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.studio-filter-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text2);
  transition: background var(--transition), color var(--transition);
}

.studio-filter-item input { display: none; }
.studio-filter-item:hover { background: var(--bg3); color: var(--text); }
.studio-filter-item.active { background: var(--bg3); color: var(--accent); }

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.studio-split-view {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  overflow: hidden;
}

.studio-split-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.studio-split-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text3);
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.studio-job-list {
  overflow-y: auto;
  flex: 1;
}

.studio-job-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-bottom: 6px;
  background: var(--bg3);
}

.studio-job-info { flex: 1; min-width: 0; }
```

---

## Integration Note: T2V Card Image Support

The Studio popup's "Thêm vào card" feature calls `window._T2V_getCards()` and `window._T2V_setCardImage(cardId, url)`. These need to be exposed from `t2v.js`.

Add to `window.T2V` in `t2v.js`:
```js
    _getCards: () => cards,
    _setCardImage: (cardId, imageUrl) => {
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      // Store reference image on card — renderer picks it up
      card.refImage = imageUrl;
      renderCard(card, false);
    },
```

This requires adding `refImage` display in `renderCard` left side (below textarea) — a simple `<img>` preview if `card.refImage` is set.

---

## Implementation Steps

1. Backend: add `POST /api/image/studio/save` to `routers/image.py`
2. Backend: mount `/studio-images` static dir and `mkdir` in `app.py`
3. HTML: add "Studio" nav-item to HÌNH ẢNH section in sidebar
4. HTML: add full `<div id="tab-studio">` panel before the frame-cutter panel
5. HTML: add `<script src="/static/js/tabs/studio.js"></script>` before `</body>`
6. Create `static/js/tabs/studio.js` with full IIFE module
7. CSS: append Studio styles to `app.css`
8. `t2v.js`: expose `_getCards` and `_setCardImage` on `window.T2V`

---

## Success Criteria

- [ ] "Studio" nav item appears in sidebar under HÌNH ẢNH section
- [ ] Clicking Studio activates tab, `init_studio` runs once
- [ ] "Tạo hình" sub-tab: prompt → generate → images appear in gallery
- [ ] Clicking gallery image → popup with 3 action buttons
- [ ] "Lưu vào kho": POSTs to `/api/image/studio/save`, saves to `data/studio/`, card shows ✓ badge
- [ ] "Lưu về máy": triggers browser download
- [ ] "Thêm vào card": populates card selector from T2V cards, sets ref image
- [ ] "Bộ lọc trạng thái" sub-tab: Ảnh and Video columns side by side
- [ ] Radio filters re-fetch and re-render job list
- [ ] No console errors on tab switch
