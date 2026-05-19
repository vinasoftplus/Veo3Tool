/* Settings tab — v4 */
(function () {
  let cfg = {};
  let accounts = []; // chỉ accounts đã có cookie/token

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadSettings() {
    const cfgRes = await API.get('/api/settings/config');
    cfg = cfgRes.data || {};

    // Luôn set TOKEN_OPTION = Option 2 (cố định)
    if (cfg.TOKEN_OPTION !== 'Option 2') {
      await API.post('/api/settings/save-value', { key: 'TOKEN_OPTION', value: 'Option 2' });
    }

    accounts = [];
    for (let i = 1; i <= 10; i++) {
      const key = `account${i}`;
      if (cfg[key] && (cfg[key].COOKIE || cfg[key].ACCESS_TOKEN)) {
        accounts.push({ ...cfg[key], _index: i - 1, _key: key });
      }
    }

    renderGeneral();
    renderAccounts();
    loadGrokAccounts().catch(e => console.error('loadGrokAccounts error', e));
  }

  // ── General ───────────────────────────────────────────────────────────────
  function renderGeneral() {
    const el = id => document.getElementById(id);
    if (el('cfg-youtube-key')) el('cfg-youtube-key').value = cfg.YOUTUBE_API_KEY || '';
    if (el('cfg-gemini-keys')) el('cfg-gemini-keys').value = cfg.GEMINI_API_KEYS || '';
    if (el('cfg-openai-key')) el('cfg-openai-key').value = cfg.OPENAI_API_KEY || '';
    if (el('cfg-deepseek-key')) el('cfg-deepseek-key').value = cfg.DEEPSEEK_API_KEY || '';
    if (el('cfg-ffmpeg-path')) el('cfg-ffmpeg-path').value = cfg.FFMPEG_PATH || '';
    const clampConcurrent = (value, fallback = 2) => Math.min(3, Math.max(1, parseInt(value ?? fallback, 10) || fallback));
    if (el('cfg-max-concurrent')) el('cfg-max-concurrent').value = clampConcurrent(cfg.MAX_CONCURRENT);
    if (el('cfg-max-concurrent-image')) el('cfg-max-concurrent-image').value = clampConcurrent(cfg.MAX_CONCURRENT_IMAGE);
    if (el('cfg-max-concurrent-grok')) el('cfg-max-concurrent-grok').value = Math.min(5, Math.max(1, parseInt(cfg.MAX_CONCURRENT_GROK ?? 2, 10) || 2));
  }

  async function saveGeneral() {
    const rawConcurrent = parseInt(document.getElementById('cfg-max-concurrent')?.value || '2', 10);
    const maxConcurrent = Math.min(3, Math.max(1, isNaN(rawConcurrent) ? 2 : rawConcurrent));
    const rawImg = parseInt(document.getElementById('cfg-max-concurrent-image')?.value || '2', 10);
    const maxConcurrentImage = Math.min(3, Math.max(1, isNaN(rawImg) ? 2 : rawImg));
    const rawGrok = parseInt(document.getElementById('cfg-max-concurrent-grok')?.value || '2', 10);
    const maxConcurrentGrok = Math.min(5, Math.max(1, isNaN(rawGrok) ? 2 : rawGrok));
    const updates = {
      YOUTUBE_API_KEY: document.getElementById('cfg-youtube-key')?.value.trim() || '',
      GEMINI_API_KEYS: document.getElementById('cfg-gemini-keys')?.value.trim() || '',
      OPENAI_API_KEY: document.getElementById('cfg-openai-key')?.value.trim() || '',
      DEEPSEEK_API_KEY: document.getElementById('cfg-deepseek-key')?.value.trim() || '',
      FFMPEG_PATH: document.getElementById('cfg-ffmpeg-path')?.value.trim() || '',
      MAX_CONCURRENT: maxConcurrent,
      MAX_CONCURRENT_IMAGE: maxConcurrentImage,
      MAX_CONCURRENT_GROK: maxConcurrentGrok,
    };
    for (const [k, v] of Object.entries(updates)) {
      await API.post('/api/settings/save-value', { key: k, value: v });
    }
    toast('Đã lưu cài đặt', 'success');
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  function renderAccounts() {
    const container = document.getElementById('accounts-container');
    if (!container) return;
    container.innerHTML = '';

    if (accounts.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:40px 20px;color:var(--text3);">
          <div style="font-size:40px;margin-bottom:12px;">🗂️</div>
          <div style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:6px;">Chưa có tài khoản nào được thêm</div>
          <div style="font-size:12px;">Bấm <strong>Load Cookie</strong> để thêm tài khoản Google Labs.</div>
        </div>`;
      return;
    }

    accounts.forEach((acc, idx) => {
      const hasToken = !!(acc.ACCESS_TOKEN?.length > 10);
      const email = acc.EMAIL || '';
      const projectId = acc.PROJECT_ID || '';
      const credits = acc._credits != null ? acc._credits : '...';
      const isLive = acc._live;
      const isDie = acc._live === false;

      const statusDot = isDie
        ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--red);"><span style="width:8px;height:8px;border-radius:50%;background:var(--red);display:inline-block;"></span>Die</span>`
        : hasToken
          ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--green);"><span style="width:8px;height:8px;border-radius:50%;background:var(--green);display:inline-block;"></span>Live</span>`
          : `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text3);"><span style="width:8px;height:8px;border-radius:50%;background:var(--text3);display:inline-block;"></span>Chưa xác nhận</span>`;

      const block = document.createElement('div');
      block.className = 'account-block';
      block.dataset.idx = idx;
      block.innerHTML = `
        <div class="account-header" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
          <div class="account-index" style="width:28px;height:28px;border-radius:50%;background:var(--pink-light);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${acc._index + 1}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:13px;">${email || 'Tài khoản #' + (acc._index + 1)}</div>
            ${email ? `<div style="font-size:11px;color:var(--text3);font-family:monospace;">${acc.ACCESS_TOKEN?.slice(0, 20)}...</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            ${statusDot}
            <span style="font-size:12px;color:var(--text2);">Credit: <strong>${acc._credits != null ? acc._credits.toLocaleString() : 'N/A'}</strong></span>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label" style="font-size:11px;">Project ID</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="acc-pid-${idx}" value="${projectId}" placeholder="cc783630-ff59-461a-..." style="font-family:monospace;font-size:11px;flex:1;">
            <button class="btn btn-secondary btn-sm" onclick="Settings.saveProjectId(${idx})" style="white-space:nowrap;flex-shrink:0;">Lưu</button>
          </div>
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="Settings.openCookieModal(${idx})"
            style="flex:1;min-width:120px;">
            🍪 Load Cookie
          </button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.openManualTokenModal(${idx})" style="flex:1;min-width:100px;">
            ✏️ Nhập Token
          </button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.reloadAccount(${idx})" title="Kiểm tra cookie live/die + lấy credit" style="flex-shrink:0;">
            🔄
          </button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.deleteAccount(${idx})" style="flex-shrink:0;color:var(--red);">
            🗑️
          </button>
        </div>`;
      container.appendChild(block);
    });
  }

  // ── Reload / check live-die + credits ────────────────────────────────────
  async function reloadAccount(idx) {
    const acc = accounts[idx];
    if (!acc) return;
    const btn = document.querySelector(`[data-idx="${idx}"] .btn[onclick*="reloadAccount"]`);
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    try {
      // Check cookie live/die
      if (acc.COOKIE) {
        const checkRes = await API.post('/api/settings/check-cookie', { cookie_string: acc.COOKIE });
        accounts[idx]._live = checkRes.live;

        // Nếu token hết hạn → tự refresh từ cookie đã lưu
        if (!checkRes.live) {
          try {
            const refreshRes = await API.post('/api/settings/refresh-token', { account_index: acc._index });
            if (refreshRes.ok) {
              accounts[idx]._live = true;
              toast(`Đã refresh token${refreshRes.email ? ' — ' + refreshRes.email : ''}`, 'success', 4000);
              await loadSettings();
              return;
            }
          } catch (re) { /* cookie chết thật */ }
        }
      } else if (acc.ACCESS_TOKEN) {
        accounts[idx]._live = true;
      }

      // Lấy credits
      const credRes = await API.get(`/api/settings/account-credits?account_index=${acc._index}`);
      accounts[idx]._credits = credRes.ok ? credRes.credits : null;
    } catch (e) {
      console.error('reloadAccount error', e);
    }

    renderAccounts();
  }

  // ── Load tất cả credits khi init ─────────────────────────────────────────
  async function loadAllCredits() {
    for (let i = 0; i < accounts.length; i++) {
      try {
        const res = await API.get(`/api/settings/account-credits?account_index=${accounts[i]._index}`);
        accounts[i]._credits = res.ok ? res.credits : null;
        accounts[i]._live = res.ok ? true : (accounts[i].ACCESS_TOKEN ? null : false);
      } catch { accounts[i]._credits = null; }
    }
    renderAccounts();
  }

  // ── Save project ID ───────────────────────────────────────────────────────
  window.Settings = window.Settings || {};

  async function saveProjectId(idx) {
    const acc = accounts[idx];
    if (!acc) return;
    const pid = document.getElementById(`acc-pid-${idx}`)?.value.trim() || '';
    const cfg2 = await API.get('/api/settings/config-full');
    const current = (cfg2.data || {})[acc._key] || {};
    current.PROJECT_ID = pid;
    await API.post('/api/settings/account', { index: acc._index, account: current });
    accounts[idx].PROJECT_ID = pid;
    toast('Đã lưu Project ID', 'success');
  }

  // ── Delete account ────────────────────────────────────────────────────────
  async function deleteAccount(idx) {
    const acc = accounts[idx];
    if (!acc) return;
    if (!confirm(`Xóa tài khoản #${acc._index + 1}?`)) return;
    await API.post('/api/settings/account', { index: acc._index, account: {} });
    toast('Đã xóa tài khoản', 'success');
    await loadSettings();
  }

  // ── Manual token modal ────────────────────────────────────────────────────
  function openManualTokenModal(idx) {
    const isNew = idx === 'new';
    const acc = isNew ? {} : (accounts[idx] || {});
    let modal = document.getElementById('manual-token-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'manual-token-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:28px;width:520px;max-width:95vw;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-size:16px;font-weight:700;">✏️ Nhập Token thủ công — Tài khoản #${(acc._index || idx) + 1}</div>
          <button onclick="document.getElementById('manual-token-modal').style.display='none'" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text2);">×</button>
        </div>
        <p style="color:var(--text2);font-size:12px;margin-bottom:16px;line-height:1.6;">
          Lấy token từ DevTools → Network → request đến <code>labs.google</code> → header <strong>Authorization: Bearer ya29...</strong>
        </p>
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label">Access Token (ya29...)</label>
          <textarea id="manual-token-input" rows="4" placeholder="ya29.a0Aa7M..." style="font-family:monospace;font-size:11px;resize:vertical;">${acc.ACCESS_TOKEN || ''}</textarea>
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label class="form-label">Email (tùy chọn)</label>
          <input type="text" id="manual-email-input" placeholder="user@gmail.com" value="${acc.EMAIL || ''}">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('manual-token-modal').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" onclick="Settings.saveManualToken(${idx})" style="min-width:100px;">Lưu Token</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    setTimeout(() => document.getElementById('manual-token-input')?.focus(), 100);
  }

  async function saveManualToken(idx) {
    const isNew = idx === 'new';
    const token = document.getElementById('manual-token-input')?.value.trim() || '';
    const email = document.getElementById('manual-email-input')?.value.trim() || '';
    if (!token) return toast('Vui lòng nhập token', 'error');

    let accountIndex;
    let current = {};
    const cfgFull = await API.get('/api/settings/config-full');
    const d = cfgFull.data || {};

    if (isNew) {
      // Tìm slot trống
      accountIndex = 0;
      for (let i = 1; i <= 10; i++) {
        if (!d[`account${i}`]?.ACCESS_TOKEN) { accountIndex = i - 1; break; }
      }
    } else {
      const acc = accounts[idx];
      if (!acc) return;
      accountIndex = acc._index;
      current = d[acc._key] || {};
    }

    current.ACCESS_TOKEN = token;
    if (email) current.EMAIL = email;

    await API.post('/api/settings/account', { index: accountIndex, account: current });
    toast('Đã lưu token', 'success');
    document.getElementById('manual-token-modal').style.display = 'none';
    await loadSettings();
    loadAllCredits();
  }

  // ── Cookie modal ──────────────────────────────────────────────────────────
  function openCookieModal(idx) {
    // Nếu idx là "new" thì tạo slot mới
    const isNew = idx === 'new';
    const acc = isNew ? null : accounts[idx];
    const displayIdx = isNew ? '?' : (acc?._index ?? idx) + 1;

    let modal = document.getElementById('cookie-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cookie-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:28px;width:620px;max-width:95vw;max-height:90vh;overflow-y:auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div style="font-size:16px;font-weight:700;">🍪 Load Cookie Google${isNew ? '' : ' — Tài khoản #' + displayIdx}</div>
          <button onclick="document.getElementById('cookie-modal').style.display='none'" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text2);">×</button>
        </div>
        <p style="color:var(--text2);font-size:12px;margin-bottom:16px;line-height:1.7;">
          Dán cookie <strong>accounts.google.com</strong> → hệ thống tự lấy <strong>access_token</strong> và lưu vào tài khoản.<br>
          Token tự động làm mới mỗi lần bấm Load Cookie — không cần extension.
        </p>

        <div style="background:var(--bg3);border-radius:10px;padding:14px;margin-bottom:16px;font-size:12px;color:var(--text2);line-height:1.9;">
          <strong style="color:var(--text);">Cách lấy cookie chuẩn:</strong><br>
          Dùng tiện ích <strong>Get Cookie Google</strong> để lấy cookie chuẩn nhất
        </div>

        <div style="margin-bottom:12px;">
          <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:6px;">Cookie String (accounts.google.com):</label>
          <textarea id="cookie-input-new" rows="5" placeholder="SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx; SAPISID=xxx; __Secure-1PSID=xxx; __Secure-3PSID=xxx; ..."
            style="width:100%;font-family:monospace;font-size:11px;resize:vertical;border-radius:8px;padding:10px;background:var(--bg3);border:1px solid var(--border);color:var(--text);box-sizing:border-box;"></textarea>
        </div>

        <div id="cookie-log-area" style="display:none;background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:12px;font-size:11px;font-family:monospace;color:var(--text2);max-height:130px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('cookie-modal').style.display='none'">Hủy</button>
          <button class="btn btn-primary btn-sm" id="cookie-submit-btn" onclick="Settings.cookieToToken('${isNew ? 'new' : idx}')"
            style="min-width:150px;">
            🍪 Load Cookie
          </button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    setTimeout(() => document.getElementById('cookie-input-new')?.focus(), 100);
  }

  async function cookieToToken(idx) {
    const logEl = document.getElementById('cookie-log-area');
    const submitBtn = document.getElementById('cookie-submit-btn');
    const cookie = document.getElementById('cookie-input-new')?.value.trim();

    if (!cookie) return toast('Vui lòng dán cookie vào ô trên', 'error');

    logEl.style.display = 'block';
    logEl.textContent = 'Đang kết nối...\n';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đang lấy token...';

    const appendLog = msg => {
      logEl.textContent += msg + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    };

    // Xác định account index
    let accountIndex;
    if (idx === 'new') {
      // Tìm slot trống tiếp theo
      const cfgFull = await API.get('/api/settings/config-full');
      const d = cfgFull.data || {};
      accountIndex = 0;
      for (let i = 1; i <= 10; i++) {
        if (!d[`account${i}`] || !d[`account${i}`].COOKIE) { accountIndex = i - 1; break; }
      }
    } else {
      accountIndex = accounts[idx]?._index ?? idx;
    }

    try {
      const res = await API.post('/api/settings/cookie-to-token', {
        account_index: accountIndex,
        cookie_string: cookie,
      });

      if (res.logs?.length) res.logs.forEach(appendLog);

      if (res.ok) {
        appendLog('✅ Thành công!');
        toast(`Load cookie thành công${res.email ? ' — ' + res.email : ''}`, 'success', 5000);
        await loadSettings();
        await loadAllCredits();
        setTimeout(() => {
          document.getElementById('cookie-modal').style.display = 'none';
        }, 1200);
      } else {
        appendLog('❌ ' + (res.message || 'Lỗi không xác định'));
        toast(res.message || 'Lỗi', 'error', 6000);
      }
    } catch (err) {
      appendLog('❌ Network error: ' + err.message);
      toast('Lỗi kết nối server', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '🍪 Load Cookie';
    }
  }

  // ── Bulk import accounts from file ───────────────────────────────────────
  function openImportAccountsModal() {
    let modal = document.getElementById('import-accounts-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'import-accounts-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:3000;display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:28px;width:580px;max-width:95vw;max-height:90vh;overflow-y:auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-size:16px;font-weight:700;">📂 Import Tài Khoản Hàng Loạt</div>
          <button onclick="document.getElementById('import-accounts-modal').style.display='none'" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text2);">×</button>
        </div>

        <div style="background:var(--bg3);border-radius:10px;padding:14px;margin-bottom:16px;font-size:12px;color:var(--text2);line-height:1.9;">
          <strong style="color:var(--text);">Định dạng hỗ trợ:</strong><br>
          📊 <strong>Excel (.xlsx)</strong>: Cột A = Cookie, Cột B = Project ID (1 hàng = 1 tài khoản)<br>
          📄 <strong>TXT (.txt)</strong>: Mỗi dòng là <code style="background:var(--bg);padding:1px 5px;border-radius:4px;">cookie|projectID</code>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:16px;">
          <label style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;border:2px dashed var(--border);border-radius:12px;cursor:pointer;transition:border-color .2s;"
            onmouseover="this.style.borderColor='var(--pink)'" onmouseout="this.style.borderColor='var(--border)'">
            <span style="font-size:28px;">📊</span>
            <span style="font-size:13px;font-weight:600;">Chọn file Excel</span>
            <span style="font-size:11px;color:var(--text3);">.xlsx</span>
            <input type="file" accept=".xlsx" style="display:none;" onchange="Settings.handleImportFile(this,'xlsx')">
          </label>
          <label style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;border:2px dashed var(--border);border-radius:12px;cursor:pointer;transition:border-color .2s;"
            onmouseover="this.style.borderColor='var(--pink)'" onmouseout="this.style.borderColor='var(--border)'">
            <span style="font-size:28px;">📄</span>
            <span style="font-size:13px;font-weight:600;">Chọn file TXT</span>
            <span style="font-size:11px;color:var(--text3);">.txt</span>
            <input type="file" accept=".txt" style="display:none;" onchange="Settings.handleImportFile(this,'txt')">
          </label>
        </div>

        <div id="import-accounts-log" style="display:none;background:var(--bg3);border-radius:8px;padding:12px;font-size:11px;font-family:monospace;color:var(--text2);max-height:200px;overflow-y:auto;line-height:1.7;white-space:pre-wrap;margin-bottom:12px;"></div>

        <div style="display:flex;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('import-accounts-modal').style.display='none'">Đóng</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
  }

  async function handleImportFile(input, type) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';

    const logEl = document.getElementById('import-accounts-log');
    logEl.style.display = 'block';
    logEl.textContent = '';

    const appendLog = msg => {
      logEl.textContent += msg + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    };

    // Parse file → list of {cookie, projectId}
    let rows = [];
    try {
      if (type === 'xlsx') {
        if (typeof XLSX === 'undefined') { appendLog('❌ Thư viện XLSX chưa tải'); return; }
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        rows = raw
          .map(r => ({ cookie: String(r[0] || '').trim(), projectId: String(r[1] || '').trim() }))
          .filter(r => r.cookie);
      } else {
        const text = await file.text();
        rows = text.split('\n')
          .map(line => {
            line = line.trim();
            if (!line) return null;
            // Project ID là UUID ở cuối dòng, phân tách bằng | cuối cùng
            const uuidMatch = line.match(/\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i);
            if (uuidMatch) {
              const projectId = uuidMatch[1];
              const cookie = line.slice(0, line.lastIndexOf('|' + uuidMatch[1])).trim();
              return { cookie, projectId };
            }
            // Không có UUID → toàn bộ dòng là cookie
            return { cookie: line, projectId: '' };
          })
          .filter(r => r && r.cookie);
      }
    } catch (err) {
      appendLog('❌ Lỗi đọc file: ' + err.message);
      return;
    }

    if (!rows.length) { appendLog('❌ File không có dữ liệu hợp lệ'); return; }
    appendLog(`📋 Tìm thấy ${rows.length} dòng. Bắt đầu import...\n`);

    // Find next free slot index (0-based) beyond existing accounts
    const cfgFull = await API.get('/api/settings/config-full');
    const d = cfgFull.data || {};

    let nextSlot = 0;
    for (let i = 1; i <= 20; i++) {
      if (!d[`account${i}`] || !d[`account${i}`].COOKIE) { nextSlot = i - 1; break; }
      if (i === 20) nextSlot = 20;
    }

    let ok = 0, skip = 0;
    for (let i = 0; i < rows.length; i++) {
      const { cookie, projectId } = rows[i];
      const slotIndex = nextSlot + i; // 0-based → API expects 0-based
      appendLog(`[${i + 1}/${rows.length}] Account #${slotIndex + 1} — đang load cookie...`);

      try {
        const res = await API.post('/api/settings/cookie-to-token', {
          account_index: slotIndex,
          cookie_string: cookie,
          project_id: projectId || undefined,
        });

        if (res.ok) {
          // If projectId provided, save it separately
          if (projectId) {
            const accKey = `account${slotIndex + 1}`;
            const accData = (await API.get('/api/settings/config-full')).data?.[accKey] || {};
            accData.PROJECT_ID = projectId;
            await API.post('/api/settings/account', { index: slotIndex, account: accData });
          }
          appendLog(`  ✅ Thành công${res.email ? ' — ' + res.email : ''}`);
          ok++;
        } else {
          appendLog(`  ⚠️ Bỏ qua: ${res.message || 'Lỗi không xác định'}`);
          skip++;
          nextSlot--; // don't advance slot for failed account
        }
      } catch (err) {
        appendLog(`  ⚠️ Bỏ qua: ${err.message}`);
        skip++;
        nextSlot--;
      }
    }

    appendLog(`\n🏁 Xong: ${ok} thành công, ${skip} bỏ qua`);
    await loadSettings();
    await loadAllCredits();
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  async function loadGrokAccounts() {
    const box = document.getElementById('grok-accounts-container');
    if (!box) return;
    box.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:10px;">Đang tải tài khoản Grok...</div>';
    try {
      const res = await API.get('/api/grok/accounts');
      renderGrokAccounts(res.accounts || []);
    } catch (e) {
      box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:10px;">Không tải được Grok accounts: ${e.message || e}</div>`;
    }
  }

  function renderGrokAccounts(items) {
    const box = document.getElementById('grok-accounts-container');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div style="text-align:center;padding:24px 12px;color:var(--text3);border:1px dashed var(--border);border-radius:12px;"><div style="font-size:13px;font-weight:700;color:var(--text2);margin-bottom:4px;">Chưa có tài khoản Grok</div><div style="font-size:12px;">Nhập email|mật khẩu rồi bấm Login Chrome.</div></div>`;
      const slotInput = document.getElementById('grok-manual-index');
      if (slotInput) slotInput.value = 1;
      return;
    }
    // Tính slot trống nhỏ nhất chưa bị dùng, set vào input
    const usedSlots = new Set(items.map(a => a.index + 1));
    let nextSlot = 1;
    while (usedSlots.has(nextSlot)) nextSlot++;
    const slotInput = document.getElementById('grok-manual-index');
    if (slotInput) {
      slotInput.value = nextSlot;
      slotInput.min = 1;
      slotInput.title = `Slot đang dùng: ${[...usedSlots].sort((a,b)=>a-b).join(', ')}. Slot trống: ${nextSlot}`;
    }

    box.innerHTML = items.map(acc => `
      <div class="account-block" style="margin-top:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="account-index" style="width:28px;height:28px;border-radius:50%;background:var(--pink-light);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${acc.index + 1}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-weight:700;font-size:13px;">${acc.email || 'Grok #' + (acc.index + 1)}</span>
              <span id="grok-tier-badge-${acc.index}"></span>
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">${acc.last_login ? '🕐 ' + acc.last_login : (acc.cookie_mask ? '✓ Đã đăng nhập' : 'Chưa đăng nhập')}</div>
            ${acc.last_error ? `<div style="font-size:11px;color:var(--red);margin-top:3px;">${acc.last_error}</div>` : ''}
          </div>
          <label class="studio-bar-toggle t2v-toggle-label" style="margin:0;">
            <input type="checkbox" ${acc.enabled ? 'checked' : ''} onchange="Settings.toggleGrokAccount(${acc.index}, this.checked)">
            <span class="t2v-toggle-track"></span>
            Bật
          </label>
          <button class="btn btn-secondary btn-sm" data-grok-check="${acc.index}" onclick="Settings.checkGrokAccount(${acc.index})">Check</button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.openGrokProfile(${acc.index})" title="Mở browser profile Grok">🌐</button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.deleteGrokAccount(${acc.index})" style="color:var(--red);">Xóa</button>
        </div>
      </div>
    `).join('');
  }

  async function loginGrokAccounts() {
    const input = document.getElementById('cfg-grok-login-lines');
    const btn = document.getElementById('btn-grok-login');
    const statusEl = document.getElementById('grok-login-status');
    const lines = input?.value.trim() || '';
    if (!lines) return toast('Nhập tài khoản Grok dạng email|mật khẩu', 'error');

    if (btn) { btn.disabled = true; btn.textContent = 'Đang login...'; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Đang chuẩn bị...'; }

    let jobId = null;
    try {
      const res = await API.post('/api/grok/accounts/login', { lines });
      jobId = res.job_id;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Login Chrome'; }
      if (statusEl) statusEl.style.display = 'none';
      return toast('Login Grok lỗi: ' + (e.message || e), 'error', 7000);
    }

    // Poll status every 2s
    const poll = async () => {
      try {
        const s = await API.get(`/api/grok/accounts/login-status/${jobId}`);
        if (statusEl) statusEl.textContent = s.message || '...';
        if (s.status === 'done') {
          if (btn) { btn.disabled = false; btn.textContent = 'Login Chrome'; }
          if (statusEl) statusEl.style.display = 'none';
          renderGrokAccounts(s.accounts || []);
          if (s.ok) {
            if (input) input.value = '';
            toast('Đã lưu tài khoản Grok', 'success');
          } else {
            const err = (s.results || []).map(r => r.error).filter(Boolean).join('; ') || 'Login Grok thất bại';
            toast(err, 'error', 7000);
          }
        } else {
          setTimeout(poll, 2000);
        }
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Login Chrome'; }
        if (statusEl) statusEl.style.display = 'none';
        toast('Lỗi kiểm tra trạng thái login: ' + (e.message || e), 'error', 5000);
      }
    };
    setTimeout(poll, 2000);
  }

  async function toggleGrokAccount(index, enabled) {
    const res = await API.post('/api/grok/accounts/toggle', { index, enabled });
    renderGrokAccounts(res.accounts || []);
  }

  async function checkGrokAccount(index) {
    const btn = document.querySelector(`[data-grok-check="${index}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      const res = await API.post(`/api/grok/accounts/${index}/health`, {});
      if (!res.ok) {
        toast('Grok account lỗi: ' + (res.error || 'unknown'), 'error', 6000);
        return;
      }
      const tier = res.tier || '';
      let label = 'Live';
      if (tier === 'SUBSCRIPTION_TIER_GROK_PRO') label = 'Live • PRO';
      else if (tier === 'SUBSCRIPTION_TIER_SUPER_GROK_PRO') label = 'Live • Heavy';
      toast(`Grok #${index + 1}: ${label}`, 'success', 5000);
      // Update badge in row
      const badgeEl = document.getElementById(`grok-tier-badge-${index}`);
      if (badgeEl) {
        if (tier === 'SUBSCRIPTION_TIER_GROK_PRO') {
          badgeEl.innerHTML = '<span style="background:#7c3aed;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;">PRO</span>';
        } else if (tier === 'SUBSCRIPTION_TIER_SUPER_GROK_PRO') {
          badgeEl.innerHTML = '<span style="background:#d97706;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;">Heavy</span>';
        } else {
          badgeEl.innerHTML = '';
        }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Check'; }
    }
  }

  async function deleteGrokAccount(index) {
    if (!confirm(`Xóa tài khoản Grok #${index + 1}?`)) return;
    const res = await API.delete(`/api/grok/accounts/${index}`);
    renderGrokAccounts(res.accounts || []);
    toast('Đã xóa tài khoản Grok', 'success');
  }

  async function openGrokProfile(index) {
    try {
      const res = await API.post('/api/grok/accounts/open-profile', { index });
      toast(res.ok ? 'Đã mở Chrome profile Grok' : 'Không mở được Chrome profile Grok', res.ok ? 'success' : 'error');
    } catch (e) {
      toast('Không mở được Chrome profile: ' + (e.message || e), 'error', 6000);
    }
  }

  function _validateGrokSlot(indexEl) {
    const slot = parseInt(indexEl?.value || '1', 10);
    const grokContainer = document.getElementById('grok-accounts-container');
    const usedSlots = new Set(
      [...(grokContainer ? grokContainer.querySelectorAll('.account-index') : [])].map(el => parseInt(el.textContent.trim(), 10))
    );
    if (usedSlots.has(slot)) {
      toast(`Slot ${slot} đã có tài khoản. Chọn slot khác (đang trống: ${(() => { let s=1; while(usedSlots.has(s)) s++; return s; })()})`, 'error', 5000);
      return false;
    }
    return true;
  }

  async function openGrokBrowser() {
    const indexEl = document.getElementById('grok-manual-index');
    const statusEl = document.getElementById('grok-manual-status');
    if (!_validateGrokSlot(indexEl)) return;

    // Check browser installed first
    try {
      const bs = await API.get('/api/grok/browser-status');
      if (!bs?.installed) {
        if (typeof window._showGrokBrowserModal === 'function') window._showGrokBrowserModal();
        else toast('CloakBrowser chưa được tải. Hãy vào tab Grok Studio để tải về.', 'error', 6000);
        return;
      }
    } catch (_) { }

    const index = Math.max(0, parseInt(indexEl?.value || '1', 10) - 1);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Đang mở browser...'; }
    try {
      const res = await API.post('/api/grok/accounts/open-browser', { index });
      if (statusEl) statusEl.textContent = `Browser đã mở (${res.mode || ''}). Hãy login xong rồi ấn "Load Cookie".`;
      toast('Browser đã mở, hãy login vào Grok', 'success', 5000);
    } catch (e) {
      if (statusEl) { statusEl.style.display = 'none'; }
      const msg = e.message || String(e);
      if (msg.includes('BROWSER_NOT_INSTALLED') || msg.includes('not installed')) {
        const grokNav = document.querySelector('.nav-item[data-tab="grok"]');
        if (grokNav) grokNav.click();
        setTimeout(() => {
          if (typeof window._showGrokBrowserModal === 'function') window._showGrokBrowserModal();
        }, 300);
      } else {
        toast('Không mở được browser: ' + msg, 'error', 6000);
      }
    }
  }

  async function loadGrokCookie() {
    const indexEl = document.getElementById('grok-manual-index');
    const emailEl = document.getElementById('grok-manual-email');
    const statusEl = document.getElementById('grok-manual-status');
    if (!_validateGrokSlot(indexEl)) return;
    const index = Math.max(0, parseInt(indexEl?.value || '1', 10) - 1);
    const email = emailEl?.value.trim() || '';
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Đang load cookie...'; }

    let jobId = null;
    try {
      const res = await API.post('/api/grok/accounts/load-cookie', { index, email });
      jobId = res.job_id;
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Lỗi: ' + (e.message || e);
      return toast('Load cookie thất bại: ' + (e.message || e), 'error', 7000);
    }

    const poll = async () => {
      try {
        const s = await API.get(`/api/grok/accounts/load-cookie-status/${jobId}`);
        if (statusEl) statusEl.textContent = s.message || '...';
        if (s.status === 'done') {
          if (s.ok) {
            if (statusEl) statusEl.style.display = 'none';
            renderGrokAccounts(s.accounts || []);
            toast('Đã lưu cookie Grok thành công!', 'success');
          } else {
            if (statusEl) statusEl.textContent = 'Lỗi: ' + s.message;
            toast('Load cookie thất bại: ' + s.message, 'error', 7000);
          }
        } else {
          setTimeout(poll, 2000);
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Lỗi poll: ' + (e.message || e);
        toast('Lỗi kiểm tra trạng thái: ' + (e.message || e), 'error', 5000);
      }
    };
    setTimeout(poll, 2000);
  }

  Object.assign(window.Settings, {
    saveProjectId,
    deleteAccount,
    openManualTokenModal,
    saveManualToken,
    openCookieModal,
    cookieToToken,
    reloadAccount,
    openImportAccountsModal,
    handleImportFile,
    loginGrokAccounts,
    toggleGrokAccount,
    checkGrokAccount,
    deleteGrokAccount,
    openGrokProfile,
    openGrokBrowser,
    loadGrokCookie,
    reload: loadSettings,
  });

  window.saveAccount = async (idx) => {
    const acc = accounts[idx];
    if (!acc) return;
    const a = {
      ACCESS_TOKEN: document.getElementById(`acc-token-${idx}`)?.value.trim() || acc.ACCESS_TOKEN || '',
      PROJECT_ID: document.getElementById(`acc-pid-${idx}`)?.value.trim() || acc.PROJECT_ID || '',
      TIER: acc.TIER || 'NORMAL',
      EMAIL: acc.EMAIL || '',
      COOKIE: acc.COOKIE || '',
    };
    await API.post('/api/settings/account', { index: acc._index, account: a });
    toast('Đã lưu', 'success');
  };

  window.init_settings = function () {
    const btn = document.getElementById('save-general-btn');
    if (btn && !btn._bound) { btn._bound = true; btn.addEventListener('click', saveGeneral); }
    loadSettings().then(() => loadAllCredits());
  };
})();
