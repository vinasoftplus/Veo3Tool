const APP_URL = 'http://127.0.0.1:8765';

async function refresh() {
  // Check app connectivity
  try {
    const r = await fetch(`${APP_URL}/api/extension/status`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    const el = document.getElementById('app-status');
    el.textContent = 'Đã kết nối';
    el.className = 'badge ok';
  } catch (e) {
    const el = document.getElementById('app-status');
    el.textContent = 'Không kết nối';
    el.className = 'badge err';
  }

  // Check stored token
  const { lastBearer } = await chrome.storage.local.get(['lastBearer']);
  const tokenEl = document.getElementById('token-status');
  const previewEl = document.getElementById('token-preview');
  const tsEl = document.getElementById('token-ts');

  if (lastBearer && lastBearer.token) {
    tokenEl.textContent = 'Có token';
    tokenEl.className = 'badge ok';
    previewEl.textContent = lastBearer.token;
    tsEl.textContent = 'Lúc: ' + (lastBearer.ts ? new Date(lastBearer.ts).toLocaleTimeString() : '?');
  } else {
    tokenEl.textContent = 'Chưa có';
    tokenEl.className = 'badge err';
    previewEl.textContent = 'Chưa bắt được token. Mở labs.google/fx/tools/flow và thực hiện 1 thao tác bất kỳ.';
    tsEl.textContent = '—';
  }
}

document.getElementById('btn-copy').onclick = async () => {
  const { lastBearer } = await chrome.storage.local.get(['lastBearer']);
  if (lastBearer && lastBearer.token) {
    await navigator.clipboard.writeText(lastBearer.token);
    const btn = document.getElementById('btn-copy');
    btn.textContent = 'Đã copy!';
    setTimeout(() => { btn.textContent = 'Copy token'; }, 1500);
  }
};

document.getElementById('btn-refresh').onclick = refresh;

// Listen for new tokens
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TOKEN_CAPTURED') refresh();
});

refresh();
