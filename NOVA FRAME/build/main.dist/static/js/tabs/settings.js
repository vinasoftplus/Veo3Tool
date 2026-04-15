/* Settings tab — v4 */
(function () {
  let cfg = {};
  let accounts = []; // chỉ accounts đã có cookie/token

  // ── Load ──────────────────────────────────────────────────────────────────
  async function loadSettings() {
    const cfgRes = await API.get('/api/settings/config-full');
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
  }

  // ── General ───────────────────────────────────────────────────────────────
  function renderGeneral() {
    const el = id => document.getElementById(id);
    if (el('cfg-youtube-key')) el('cfg-youtube-key').value = cfg.YOUTUBE_API_KEY || '';
    if (el('cfg-gemini-keys')) el('cfg-gemini-keys').value = cfg.GEMINI_API_KEYS || '';
    if (el('cfg-ffmpeg-path')) el('cfg-ffmpeg-path').value = cfg.FFMPEG_PATH || '';
  }

  async function saveGeneral() {
    const updates = {
      YOUTUBE_API_KEY: document.getElementById('cfg-youtube-key')?.value.trim() || '',
      GEMINI_API_KEYS: document.getElementById('cfg-gemini-keys')?.value.trim() || '',
      FFMPEG_PATH: document.getElementById('cfg-ffmpeg-path')?.value.trim() || '',
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
          <button class="btn btn-sm" onclick="Settings.openCookieModal(${idx})"
            style="background:linear-gradient(135deg,#ec4899,#f43f5e);color:#fff;border:none;flex:1;min-width:120px;">
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
            style="background:linear-gradient(135deg,#ec4899,#f43f5e);border-color:transparent;min-width:150px;">
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

  // ── Expose ────────────────────────────────────────────────────────────────
  Object.assign(window.Settings, {
    saveProjectId,
    deleteAccount,
    openManualTokenModal,
    saveManualToken,
    openCookieModal,
    cookieToToken,
    reloadAccount,
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
    document.getElementById('save-general-btn')?.addEventListener('click', saveGeneral);
    loadSettings().then(() => loadAllCredits());
  };
})();
