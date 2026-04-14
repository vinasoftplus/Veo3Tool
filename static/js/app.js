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

async function checkLicense() {
  try {
    const res = await API.get('/api/license/info');
    if (res.valid || res.dev_mode) {
      document.getElementById('license-screen').style.display = 'none';
    }
  } catch (e) {
    document.getElementById('license-screen').style.display = 'none';
  }
}

document.getElementById('license-submit-btn')?.addEventListener('click', async () => {
  const token = document.getElementById('license-input').value.trim();
  if (!token) return;
  const res = await API.post('/api/license/validate', { token });
  if (res.valid) {
    toast('License h\u1ee3p l\u1ec7!', 'success');
    document.getElementById('license-screen').style.display = 'none';
  } else {
    toast(res.detail || 'License kh\u00f4ng h\u1ee3p l\u1ec7', 'error');
  }
});

checkLicense();
