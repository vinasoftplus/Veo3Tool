/* Navigation */
const NAV_ITEMS = document.querySelectorAll('.nav-item[data-tab]');
const TAB_PANELS = document.querySelectorAll('.tab-panel');
let activeTab = null;

function switchTab(tabId) {
  if (activeTab === tabId) return;
  activeTab = tabId;
  NAV_ITEMS.forEach(n => n.classList.toggle('active', n.dataset.tab === tabId));
  TAB_PANELS.forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
  document.getElementById('topbar-title').textContent =
    document.querySelector(`.nav-item[data-tab="${tabId}"] .nav-label`)?.textContent || '';
  const fnKey = `init_${tabId.replace(/-/g, '_')}`;
  const initFn = window[fnKey];
  if (typeof initFn === 'function') {
    initFn();
    // settings tab reloads accounts on every visit — don't null it out
    if (fnKey !== 'init_settings') window[fnKey] = null;
  }
}

NAV_ITEMS.forEach(n => n.addEventListener('click', () => switchTab(n.dataset.tab)));
switchTab('text-to-video');

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

  if (iconArea) iconArea.innerHTML = '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--red,#ef4444)" stroke-width="1.5" style="display:inline-block;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  if (title)    title.textContent = 'License không hợp lệ';
  if (msg)      msg.textContent   = message || 'Máy này chưa được cấp license';
  if (uuidEl)   uuidEl.textContent = machineUuid || '...';
  if (uuidBox)  uuidBox.style.display  = machineUuid ? '' : 'none';
  if (retryBtn) retryBtn.style.display = '';
  if (hint)     hint.style.display     = '';
  if (screen)   screen.style.display   = 'flex';
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
    if (el)     { el.textContent = `✓ Licensed${exp}`; el.style.color = 'var(--green)'; }
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
