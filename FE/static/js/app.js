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
  const initFn = window[`init_${tabId.replace(/-/g, '_')}`];
  if (typeof initFn === 'function') {
    initFn();
    window[`init_${tabId.replace(/-/g, '_')}`] = null;
  }
}

NAV_ITEMS.forEach(n => n.addEventListener('click', () => switchTab(n.dataset.tab)));
switchTab('text-to-video');

document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar')?.classList.toggle('collapsed');
});

// ── License System ─────────────────────────────────────────────────────────

let _licenseValid = false;

function showLockScreen(machineUuid, message) {
  const screen = document.getElementById('license-screen');
  const uuidEl = document.getElementById('license-machine-uuid');
  const msgEl  = document.getElementById('license-message');
  if (uuidEl) uuidEl.textContent = machineUuid || '...';
  if (msgEl)  msgEl.textContent  = message || 'Nhập license key để sử dụng phần mềm';
  if (screen) screen.style.display = 'flex';
}

function hideLockScreen() {
  const screen = document.getElementById('license-screen');
  if (screen) screen.style.display = 'none';
}

function setLicenseStatus(info) {
  const el = document.getElementById('license-status');
  const detail = document.getElementById('license-status-detail');
  const uuidSetting = document.getElementById('cfg-machine-uuid');
  const uuidLock = document.getElementById('license-machine-uuid');

  // Điền UUID vào tất cả chỗ
  if (info.machine_uuid) {
    if (uuidSetting) uuidSetting.value = info.machine_uuid;
    if (uuidLock) uuidLock.textContent = info.machine_uuid;
  }

  if (info.dev_mode) {
    if (el) { el.textContent = 'DEV MODE'; el.style.color = 'var(--yellow, #f59e0b)'; }
    if (detail) { detail.textContent = 'Đang chạy chế độ DEV — license bị bypass'; detail.style.color = 'var(--yellow, #f59e0b)'; }
  } else if (info.valid) {
    const exp = info.expires_at ? ` · Hết hạn: ${info.expires_at.slice(0, 10)}` : '';
    if (el) { el.textContent = `✓ Licensed${exp}`; el.style.color = 'var(--green)'; }
    if (detail) { detail.textContent = `✓ License hợp lệ${exp}`; detail.style.color = 'var(--green)'; }
  } else {
    if (el) { el.textContent = 'Chưa kích hoạt'; el.style.color = 'var(--red)'; }
    if (detail) { detail.textContent = info.message || 'Chưa có license hợp lệ'; detail.style.color = 'var(--red)'; }
  }
}

async function checkLicense() {
  try {
    // Tự load token đã lưu và check
    const res = await API.get('/api/license/auto-check');
    if (res.valid) {
      _licenseValid = true;
      hideLockScreen();
      setLicenseStatus(res);
      // Cập nhật UUID vào ô settings nếu có
      const uuidSettingEl = document.getElementById('cfg-machine-uuid');
      if (uuidSettingEl && res.machine_uuid) uuidSettingEl.value = res.machine_uuid;
    } else {
      _licenseValid = false;
      showLockScreen(res.machine_uuid, res.message);
      setLicenseStatus(res);
    }
  } catch (e) {
    _licenseValid = false;
    showLockScreen('', 'Không thể kết nối server');
  }
}

// Kích hoạt license
document.getElementById('license-submit-btn')?.addEventListener('click', async () => {
  const btn   = document.getElementById('license-submit-btn');
  const token = document.getElementById('license-input')?.value.trim();
  if (!token) return;

  btn.disabled = true;
  btn.textContent = 'Đang kiểm tra...';

  try {
    const res = await API.post('/api/license/validate', { token });
    if (res.valid) {
      _licenseValid = true;
      hideLockScreen();
      setLicenseStatus(res);
      toast('Kích hoạt thành công!', 'success');
      // Cập nhật UUID vào ô settings nếu có
      const uuidSettingEl = document.getElementById('cfg-machine-uuid');
      if (uuidSettingEl && res.machine_uuid) uuidSettingEl.value = res.machine_uuid;
    } else {
      toast(res.message || 'License không hợp lệ', 'error', 6000);
    }
  } catch (e) {
    toast('Lỗi kết nối server', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kích hoạt';
  }
});

// Guard: chặn mọi hành động nếu chưa có license
document.addEventListener('click', e => {
  if (_licenseValid) return;
  const screen = document.getElementById('license-screen');
  if (screen && screen.style.display !== 'none') return; // đang hiện lock screen
  // Nếu lock screen bị ẩn nhưng chưa valid → show lại
  checkLicense();
}, true);

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
