/* Navigation */
const NAV_ITEMS = document.querySelectorAll('.nav-item[data-tab]');
const TAB_PANELS = document.querySelectorAll('.tab-panel');
const THEME_KEY = 'dreamforgeTheme';
const LEGACY_THEME_KEY = 'darkMode';
const THEME_CLASSES = ['theme-dawn', 'theme-mist', 'theme-night'];
const THEME_THEME_COLOR = {
  dawn: '#fff1f7',
  mist: '#f8fafc',
  night: '#05070c',
};
let activeTab = null;

function normalizeTheme(theme) {
  return ['dawn', 'mist', 'night'].includes(theme) ? theme : 'night';
}

function getCurrentTheme() {
  if (document.documentElement.classList.contains('theme-dawn')) return 'dawn';
  if (document.documentElement.classList.contains('theme-mist')) return 'mist';
  if (document.documentElement.classList.contains('theme-night')) return 'night';
  return normalizeTheme(localStorage.getItem(THEME_KEY) || 'night');
}

function syncThemeSlider(theme) {
  const slider = document.getElementById('theme-slider');
  if (slider) slider.dataset.theme = theme;
  document.querySelectorAll('input[name="theme-mode"]').forEach((input) => {
    input.checked = input.value === theme;
  });
}

function applyTheme(theme) {
  const nextTheme = normalizeTheme(theme);
  document.documentElement.classList.remove(...THEME_CLASSES);
  document.documentElement.classList.add(`theme-${nextTheme}`);
  document.documentElement.classList.toggle('dark', nextTheme === 'night');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', THEME_THEME_COLOR[nextTheme]);
  syncThemeSlider(nextTheme);
  return nextTheme;
}

function setTheme(theme) {
  const nextTheme = applyTheme(theme);
  localStorage.setItem(THEME_KEY, nextTheme);
  localStorage.removeItem(LEGACY_THEME_KEY);
  return nextTheme;
}

function migrateLegacyTheme() {
  const existing = localStorage.getItem(THEME_KEY);
  if (existing) return normalizeTheme(existing);
  const legacy = localStorage.getItem(LEGACY_THEME_KEY);
  const migrated = legacy === '1' ? 'night' : 'mist';
  localStorage.setItem(THEME_KEY, migrated);
  localStorage.removeItem(LEGACY_THEME_KEY);
  return migrated;
}

function initThemeControls() {
  const initialTheme = migrateLegacyTheme();
  applyTheme(initialTheme);
  document.querySelectorAll('input[name="theme-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) setTheme(input.value);
    });
  });
}

window.toggleDarkMode = function toggleDarkModeCompat() {
  const next = getCurrentTheme() === 'night' ? 'mist' : 'night';
  setTheme(next);
};

function switchTab(tabId) {
  const sameTab = activeTab === tabId;
  if (!sameTab) {
    activeTab = tabId;
    NAV_ITEMS.forEach(n => n.classList.toggle('active', n.dataset.tab === tabId));
    TAB_PANELS.forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
    document.getElementById('topbar-title').textContent =
      document.querySelector(`.nav-item[data-tab="${tabId}"] .nav-label`)?.textContent || '';
  }
  const fnKey = `init_${tabId.replace(/-/g, '_')}`;
  const initFn = window[fnKey];
  if (typeof initFn === 'function') {
    initFn();
    // settings tab reloads accounts on every visit — don't null it out
    if (fnKey !== 'init_settings') window[fnKey] = null;
  }
}

NAV_ITEMS.forEach(n => n.addEventListener('click', () => switchTab(n.dataset.tab)));
initThemeControls();
switchTab('studio');
window.addEventListener('load', () => {
  switchTab(activeTab || 'studio');
});

document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar')?.classList.toggle('collapsed');
});

// ── License System ─────────────────────────────────────────────────────────

let _licenseValid = false;

function _setLockScreenLoading() {
  const iconArea = document.getElementById('license-icon-area');
  const title    = document.getElementById('license-title');
  const msg      = document.getElementById('license-message');
  const uuidBox  = document.getElementById('license-uuid-box');
  const retryBtn = document.getElementById('license-retry-btn');
  const hint     = document.getElementById('license-contact-hint');
  if (iconArea) iconArea.innerHTML = '<div class="spinner" style="margin:0 auto;width:48px;height:48px;border-width:3px;border-color:var(--accent,#ec4899) transparent transparent transparent;"></div>';
  if (title)    title.textContent = 'Đang kiểm tra license...';
  if (msg)      msg.textContent   = 'Vui lòng chờ trong giây lát';
  if (uuidBox)  uuidBox.style.display  = 'none';
  if (retryBtn) retryBtn.style.display = 'none';
  if (hint)     hint.style.display     = 'none';
}

function showLockScreen(machineUuid, message) {
  const screen   = document.getElementById('license-screen');
  const iconArea = document.getElementById('license-icon-area');
  const title    = document.getElementById('license-title');
  const msg      = document.getElementById('license-message');
  const uuidEl   = document.getElementById('license-machine-uuid');
  const uuidBox  = document.getElementById('license-uuid-box');
  const retryBtn = document.getElementById('license-retry-btn');
  const hint     = document.getElementById('license-contact-hint');
  const keyBox   = document.getElementById('license-key-box');

  if (iconArea) iconArea.innerHTML = '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--red,#ef4444)" stroke-width="1.5" style="display:inline-block;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  if (title)    title.textContent = 'License không hợp lệ';
  if (msg)      msg.textContent   = message || 'Máy này chưa được cấp license';
  if (uuidEl)   uuidEl.textContent = machineUuid || '...';
  if (uuidBox)  uuidBox.style.display  = machineUuid ? '' : 'none';
  if (keyBox)   keyBox.style.display   = '';
  if (retryBtn) retryBtn.style.display = '';
  if (hint)     hint.style.display     = '';
  if (screen)   screen.style.display   = 'flex';
}

async function submitLicenseKey() {
  const input = document.getElementById('license-key-input');
  const errEl = document.getElementById('license-key-error');
  const key = (input?.value || '').trim();
  if (!key || key.length < 19) {
    if (errEl) { errEl.textContent = 'Vui lòng nhập key đầy đủ (XXXX-XXXX-XXXX-XXXX)'; errEl.style.display = ''; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  try {
    const res = await API.post('/api/license/set-key', { key });
    if (res.ok || res.saved) {
      await checkLicense({ forceRecheck: true });
    } else {
      if (errEl) { errEl.textContent = res.message || 'Key không hợp lệ'; errEl.style.display = ''; }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Lỗi kết nối, thử lại sau'; errEl.style.display = ''; }
  }
}

function hideLockScreen() {
  const screen = document.getElementById('license-screen');
  if (screen) screen.style.display = 'none';
}

function setLicenseStatus(info) {
  const el     = document.getElementById('license-status');
  const detail = document.getElementById('license-status-detail');
  const uuidSetting = document.getElementById('cfg-machine-uuid');
  if (info.machine_uuid && uuidSetting) uuidSetting.value = info.machine_uuid;

  if (info.valid) {
    const exp = info.expires_at ? ` · Hết hạn: ${String(info.expires_at).slice(0, 10)}` : '';
    const ver = window.__APP_VERSION__ ? ` · v${window.__APP_VERSION__}` : '';
    if (el)     { el.textContent = `✓ Licensed${exp}${ver}`; el.style.color = 'var(--green)'; }
    if (detail) { detail.textContent = `✓ License hợp lệ${exp}`; detail.style.color = 'var(--green)'; }
  } else {
    if (el)     { el.textContent = 'Chưa kích hoạt'; el.style.color = 'var(--red)'; }
    if (detail) { detail.textContent = info.message || 'Chưa có license hợp lệ'; detail.style.color = 'var(--red)'; }
  }
}

async function checkLicense({ forceRecheck = false } = {}) {
  const screen = document.getElementById('license-screen');
  if (screen) { screen.style.display = 'flex'; _setLockScreenLoading(); }

  try {
    // forceRecheck = true → gọi /validate để xóa cache backend, dùng khi user bấm "Thử lại"
    const res = forceRecheck
      ? await API.post('/api/license/validate', {})
      : await API.get('/api/license/auto-check');
    if (res.is_banned) {
      _licenseValid = false;
      showBanScreen(res.ban_reason || 'Tài khoản bị cấm bởi quản trị viên');
      return;
    }
    if (res.valid) {
      _licenseValid = true;
      hideLockScreen();
      setLicenseStatus(res);
      const uuidSettingEl = document.getElementById('cfg-machine-uuid');
      if (uuidSettingEl && res.machine_uuid) uuidSettingEl.value = res.machine_uuid;
    } else {
      _licenseValid = false;
      showLockScreen(res.machine_uuid, res.message);
      setLicenseStatus(res);
    }
  } catch (e) {
    _licenseValid = false;
    showLockScreen('', 'Không thể kết nối server kiểm tra license');
  }
}

function showBanScreen(reason) {
  const screen   = document.getElementById('license-screen');
  if (!screen) return;

  const title    = document.getElementById('license-title');
  const msg      = document.getElementById('license-message');
  const retryBtn = document.getElementById('license-retry-btn');
  const iconArea = document.getElementById('license-icon-area');
  const uuidBox  = document.getElementById('license-uuid-box');
  const hint     = document.getElementById('license-contact-hint');

  if (title)    title.textContent = 'Tài khoản bị cấm';
  if (msg)      msg.innerHTML = `<strong>Lý do:</strong> ${reason}`;
  if (retryBtn) retryBtn.style.display = 'none';
  if (uuidBox)  uuidBox.style.display  = 'none';
  if (hint)     hint.style.display     = 'none';
  if (iconArea) iconArea.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#ef4444"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

  screen.style.display = 'flex';

  // Remove any previous countdown to avoid duplicates
  const existing = document.getElementById('ban-countdown');
  if (existing) existing.remove();

  // 30-second countdown then shutdown
  let seconds = 30;
  const countdownEl = document.createElement('p');
  countdownEl.id = 'ban-countdown';
  countdownEl.style.cssText = 'margin-top:12px;color:#ef4444;font-weight:bold;';
  countdownEl.textContent = `Ứng dụng sẽ tắt sau ${seconds} giây...`;
  if (msg && msg.parentNode) msg.parentNode.insertBefore(countdownEl, msg.nextSibling);

  const timer = setInterval(async () => {
    seconds--;
    if (countdownEl) countdownEl.textContent = `Ứng dụng sẽ tắt sau ${seconds} giây...`;
    if (seconds <= 0) {
      clearInterval(timer);
      try { await fetch('/api/license/shutdown', { method: 'POST' }); } catch(e) {}
    }
  }, 1000);
}

// Guard: chặn mọi click nếu chưa có license
document.addEventListener('click', e => {
  if (_licenseValid) return;
  const screen = document.getElementById('license-screen');
  if (screen && screen.style.display !== 'none') return;
  checkLicense();
}, true);

// Periodic re-check mỗi 15 phút
let _shutdownTimer = null;

function _triggerShutdown() {
  if (_shutdownTimer) return; // đã đếm ngược rồi
  let remaining = 300; // 5 phút
  toast('⛔ License không hợp lệ! Tool sẽ tắt sau 5 phút.', 'error', 10000);
  _shutdownTimer = setInterval(async () => {
    remaining -= 30;
    if (remaining <= 0) {
      clearInterval(_shutdownTimer);
      toast('🔴 Đang tắt ứng dụng...', 'error', 5000);
      await new Promise(r => setTimeout(r, 2000));
      try { await API.post('/api/license/shutdown', {}); } catch (_) {}
      // Fallback: đóng cửa sổ
      window.close();
    } else {
      toast(`⚠️ Tool sẽ tắt sau ${remaining / 60 < 1 ? remaining + ' giây' : Math.ceil(remaining/60) + ' phút'}.`, 'error', 8000);
    }
  }, 30000);
}

setInterval(async () => {
  if (!_licenseValid) return;
  try {
    const res = await API.get('/api/license/auto-check');
    if (res.is_banned) {
      _licenseValid = false;
      showBanScreen(res.ban_reason || 'Tài khoản bị cấm bởi quản trị viên');
      return;
    }
    if (!res.valid) {
      _licenseValid = false;
      showLockScreen(res.machine_uuid, res.message);
      setLicenseStatus(res);
      _triggerShutdown();
    }
  } catch (_) { /* mất mạng — không block, chờ lần sau */ }
}, 15 * 60 * 1000);

// Chạy ngay khi load
checkLicense();

// Auto-refresh tất cả token từ cookie đã lưu (chạy nền, không block UI)
(async () => {
  try {
    await API.post('/api/settings/auto-refresh-all', {});
  } catch (e) {
    // silent
  }
})();

// Check update
async function _doUpdate(downloadUrl, version, btnEl) {
  if (btnEl) { btnEl.textContent = 'Đang tải...'; btnEl.style.pointerEvents = 'none'; }
  try {
    await API.post('/api/update/download-and-apply', { download_url: downloadUrl, version });
    if (btnEl) btnEl.textContent = 'Đang khởi động lại...';
  } catch (err) {
    if (btnEl) { btnEl.textContent = 'Lỗi — thử lại'; btnEl.style.pointerEvents = 'auto'; }
  }
}

function showUpdateBlockScreen(updateInfo) {
  const screen   = document.getElementById('license-screen');
  const iconArea = document.getElementById('license-icon-area');
  const title    = document.getElementById('license-title');
  const msg      = document.getElementById('license-message');
  const retryBtn = document.getElementById('license-retry-btn');
  const uuidBox  = document.getElementById('license-uuid-box');
  const hint     = document.getElementById('license-contact-hint');
  const keyBox   = document.getElementById('license-key-box');

  if (iconArea) iconArea.innerHTML = '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#ec4899)" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  if (title)    title.textContent = `Bắt buộc cập nhật lên v${updateInfo.version}`;
  if (msg)      msg.innerHTML = updateInfo.changelog
    ? `<span style="white-space:pre-line">${updateInfo.changelog}</span>`
    : 'Phiên bản mới bắt buộc. Vui lòng cập nhật để tiếp tục sử dụng.';
  if (uuidBox)  uuidBox.style.display  = 'none';
  if (keyBox)   keyBox.style.display   = 'none';
  if (hint)     hint.style.display     = 'none';

  // Replace retry btn with update btn
  if (retryBtn) {
    retryBtn.textContent = 'Cập nhật ngay';
    retryBtn.style.display = '';
    retryBtn.onclick = () => _doUpdate(updateInfo.download_url, updateInfo.version, retryBtn);
  }

  if (screen) screen.style.display = 'flex';
}

(async () => {
  try {
    const res = await API.get('/api/update-info');
    if (!res.has_update) return;

    if (res.required) {
      showUpdateBlockScreen(res);
      return;
    }

    // Non-required: show banner
    const banner = document.getElementById('update-banner');
    if (!banner) return;
    document.getElementById('update-banner-text').textContent =
      `Có bản cập nhật mới: v${res.version} (hiện tại: v${res.current_version})`;
    const reqEl = document.getElementById('update-banner-required');
    if (reqEl) reqEl.textContent = '';

    const btn = document.getElementById('update-banner-link');
    btn.removeAttribute('href');
    btn.textContent = 'Cập nhật ngay';
    btn.style.cursor = 'pointer';
    btn.onclick = (e) => { e.preventDefault(); _doUpdate(res.download_url, res.version, btn); };

    banner.style.display = 'flex';
  } catch (e) {
    // silent
  }
})();
