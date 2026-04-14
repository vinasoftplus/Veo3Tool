/* Settings tab */
(function () {
  let cfg = {};
  let accounts = [];

  async function loadSettings() {
    const cfgRes = await API.get('/api/settings/config-full');
    cfg = cfgRes.data || {};
    accounts = [];
    for (let i = 0; i < 5; i++) {
      const key = `account${i + 1}`;
      if (cfg[key]) accounts.push({ ...cfg[key], _index: i });
    }
    renderGeneral();
    renderAccounts();
    checkExtStatus();
  }

  function ensureTokenOptionField() {
    if (document.getElementById('cfg-token-option')) return;
    const ffmpegInput = document.getElementById('cfg-ffmpeg-path');
    const anchor = ffmpegInput?.closest('.form-group');
    if (!anchor || !anchor.parentElement) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'form-group';
    wrapper.innerHTML = `
      <label class="form-label">Token Option</label>
      <select id="cfg-token-option">
        <option value="Option 1">Option 1 - Gửi từ backend</option>
        <option value="Option 2">Option 2 - Gửi qua browser context</option>
      </select>
      <div style="margin-top:6px;font-size:11px;color:var(--text3);">
        Option 2 bám gần flow tool gốc hơn cho text-to-video và image-to-video.
      </div>
    `;
    anchor.insertAdjacentElement('afterend', wrapper);
  }

  function renderGeneral() {
    const el = id => document.getElementById(id);
    ensureTokenOptionField();
    if (el('cfg-youtube-key')) el('cfg-youtube-key').value = cfg.YOUTUBE_API_KEY || '';
    if (el('cfg-gemini-keys')) el('cfg-gemini-keys').value = cfg.GEMINI_API_KEYS || '';
    if (el('cfg-ffmpeg-path')) el('cfg-ffmpeg-path').value = cfg.FFMPEG_PATH || '';
    if (el('cfg-token-option')) el('cfg-token-option').value = cfg.TOKEN_OPTION || 'Option 1';
  }

  function formatExpiry(isoOrTs) {
    if (!isoOrTs) return null;
    const d = new Date(typeof isoOrTs === 'number' ? isoOrTs * 1000 : isoOrTs);
    if (isNaN(d)) return null;
    const now = new Date();
    const diffMs = d - now;
    if (diffMs <= 0) return { expired: true, label: '\u0110\u00e3 h\u1ebft h\u1ea1n', timeLeft: '' };
    const hrs = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    return {
      expired: false,
      label: d.toLocaleString('vi-VN'),
      timeLeft: hrs > 0 ? `C\u00f2n l\u1ea1i: ${hrs} gi\u1edd ${mins} ph\u00fat` : `C\u00f2n l\u1ea1i: ${mins} ph\u00fat`,
    };
  }

  function renderAccounts() {
    const container = document.getElementById('accounts-container');
    if (!container) return;
    container.innerHTML = '';

    const count = Math.min(5, Math.max(1, accounts.length + 1));

    for (let i = 0; i < count; i++) {
      const acc = accounts[i] || {};
      const token = acc.ACCESS_TOKEN || '';
      const expiry = formatExpiry(acc.TOKEN_EXPIRY || acc.token_expiry);
      const tier = acc.TIER || acc.tier || 'NORMAL';
      const hasToken = token.length > 10;

      const expiryHtml = expiry
        ? `<div style="margin-top:6px;font-size:11px;display:flex;gap:12px;flex-wrap:wrap;">
            <span style="color:${expiry.expired ? 'var(--red)' : 'var(--text2)'};">\u23f0 H\u1ebft h\u1ea1n: ${expiry.label}</span>
            ${expiry.timeLeft ? `<span style="color:${expiry.expired ? 'var(--red)' : 'var(--green)'};">\ud83d\udd50 ${expiry.timeLeft}</span>` : ''}
          </div>`
        : (hasToken ? `<div style="margin-top:6px;font-size:11px;color:var(--text3);">Token \u0111\u00e3 nh\u1eadp, th\u1eddi h\u1ea1n kh\u00f4ng r\u00f5</div>` : '');

      const block = document.createElement('div');
      block.className = 'account-block';
      block.innerHTML = `
        <div class="account-header">
          <div class="account-index">${i + 1}</div>
          <strong style="font-size:13px;">T\u00e0i kho\u1ea3n VEO3 #${i + 1}${i === 0 ? ' (M\u1eb7c \u0111\u1ecbnh)' : ''}</strong>
          <select id="acc-tier-${i}" style="margin-left:auto;width:auto;padding:3px 8px;font-size:12px;" title="Tier">
            <option value="NORMAL" ${tier === 'NORMAL' ? 'selected' : ''}>NORMAL</option>
            <option value="PRO" ${tier === 'PRO' ? 'selected' : ''}>PRO</option>
            <option value="ULTRA" ${tier === 'ULTRA' ? 'selected' : ''}>ULTRA</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Labs Project ID</label>
          <input type="text" id="acc-pid-${i}" placeholder="cc783630-ff59-461a-8fc3-d654c5265bca" value="${acc.PROJECT_ID || ''}" style="font-family:monospace;font-size:12px;">
        </div>

        <div class="form-group">
          <label class="form-label">Labs Token</label>
          <textarea id="acc-token-${i}" rows="3" placeholder="ya29.a0Aa7M..." style="font-family:monospace;font-size:11px;resize:vertical;">${token}</textarea>
          ${expiryHtml}
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button class="btn btn-primary btn-sm" onclick="Settings.saveAccount(${i})">L\u01b0u</button>
          <button class="btn btn-secondary btn-sm" onclick="Settings.collectToken(${i})" title="D\u00f9ng extension Chrome \u0111\u1ec3 t\u1ef1 \u0111\u1ed9ng l\u1ea5y token m\u1edbi">L\u1ea5y Token t\u1ef1 \u0111\u1ed9ng</button>
        </div>`;
      container.appendChild(block);
    }
  }

  async function checkExtStatus() {
    const dot = document.getElementById('ext-dot');
    const label = document.getElementById('ext-label');
    if (!dot || !label) return;
    try {
      const res = await API.get('/api/extension/status');
      if (res.ok) {
        dot.style.background = 'var(--green)';
        label.textContent = `Extension \u0111\u00e3 k\u1ebft n\u1ed1i, ${res.pending_captcha_jobs || 0} job \u0111ang ch\u1edd`;
        label.style.color = 'var(--green)';
      } else {
        throw new Error();
      }
    } catch {
      dot.style.background = 'var(--red)';
      label.innerHTML = 'Extension ch\u01b0a k\u1ebft n\u1ed1i, <a href="#" onclick="Settings.showExtGuide();return false;" style="color:var(--accent);">H\u01b0\u1edbng d\u1eabn c\u00e0i</a>';
      label.style.color = 'var(--text2)';
    }
  }

  window.Settings = {
    checkExt: checkExtStatus,

    saveAccount: async function (idx) {
      const acc = {
        PROJECT_ID: document.getElementById(`acc-pid-${idx}`)?.value.trim() || '',
        ACCESS_TOKEN: document.getElementById(`acc-token-${idx}`)?.value.trim() || '',
        TIER: document.getElementById(`acc-tier-${idx}`)?.value || 'NORMAL',
      };
      const res = await API.post('/api/settings/account', { index: idx, account: acc });
      if (res.ok) { toast('\u0110\u00e3 l\u01b0u account ' + (idx + 1), 'success'); loadSettings(); }
      else toast('L\u1ed7i l\u01b0u', 'error');
    },

    collectToken: async function () {
      try {
        const extRes = await API.get('/api/extension/status');
        if (!extRes.ok) throw new Error();
        toast('Extension \u0111ang t\u1ef1 \u0111\u1ed9ng l\u1ea5y token... Ki\u1ec3m tra l\u1ea1i sau v\u00e0i gi\u00e2y.', 'info', 4000);
        setTimeout(async () => {
          await loadSettings();
          toast('\u0110\u00e3 l\u00e0m m\u1edbi th\u00f4ng tin account', 'success');
        }, 5000);
      } catch {
        Settings.showExtGuide();
      }
    },

    showExtGuide: function () {
      let modal = document.getElementById('ext-guide-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ext-guide-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:3000;display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(modal);
      }
      modal.innerHTML = `
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:28px;width:500px;max-width:95vw;">
          <div style="font-size:16px;font-weight:600;margin-bottom:16px;">C\u00e0i Extension Chrome</div>
          <p style="color:var(--text2);font-size:13px;margin-bottom:16px;">
            Extension t\u1ef1 \u0111\u1ed9ng l\u1ea5y <strong>Labs Token</strong> t\u1eeb phi\u00ean \u0111\u0103ng nh\u1eadp Google c\u1ee7a b\u1ea1n.
          </p>
          <ol style="font-size:13px;color:var(--text2);line-height:2;padding-left:20px;">
            <li>M\u1edf Chrome v\u00e0 v\u00e0o <code style="background:var(--bg3);padding:1px 5px;border-radius:3px;">chrome://extensions</code></li>
            <li>B\u1eadt <strong>Developer mode</strong> (g\u00f3c tr\u00ean ph\u1ea3i)</li>
            <li>Click <strong>Load unpacked</strong> v\u00e0 ch\u1ecdn th\u01b0 m\u1ee5c <code style="background:var(--bg3);padding:1px 5px;border-radius:3px;">Veo3Hao/extension/</code></li>
            <li>\u0110\u0103ng nh\u1eadp t\u00e0i kho\u1ea3n Google v\u00e0o Chrome</li>
            <li>Extension t\u1ef1 m\u1edf <code>labs.google</code> v\u00e0 l\u1ea5y token t\u1ef1 \u0111\u1ed9ng</li>
          </ol>
          <p style="font-size:12px;color:var(--text3);margin-top:12px;">
            Ho\u1eb7c nh\u1eadp <strong>Labs Token</strong> th\u1ee7 c\u00f4ng t\u1eeb DevTools, m\u1ee5c Network, header Authorization khi d\u00f9ng labs.google.
          </p>
          <div style="display:flex;justify-content:flex-end;margin-top:20px;">
            <button class="btn btn-primary" onclick="document.getElementById('ext-guide-modal').style.display='none'">\u0110\u00f3ng</button>
          </div>
        </div>`;
      modal.style.display = 'flex';
      modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    },
  };

  window.saveAccount = Settings.saveAccount;
  window.collectToken = Settings.collectToken;

  async function saveGeneral() {
    const updates = {
      YOUTUBE_API_KEY: document.getElementById('cfg-youtube-key')?.value.trim() || '',
      GEMINI_API_KEYS: document.getElementById('cfg-gemini-keys')?.value.trim() || '',
      FFMPEG_PATH: document.getElementById('cfg-ffmpeg-path')?.value.trim() || '',
      TOKEN_OPTION: document.getElementById('cfg-token-option')?.value || 'Option 1',
    };
    for (const [k, v] of Object.entries(updates)) {
      await API.post('/api/settings/save-value', { key: k, value: v });
    }
    toast('\u0110\u00e3 l\u01b0u c\u00e0i \u0111\u1eb7t', 'success');
  }

  window.init_settings = function () {
    document.getElementById('save-general-btn')?.addEventListener('click', saveGeneral);
    loadSettings();
    setInterval(checkExtStatus, 10000);
  };
})();
