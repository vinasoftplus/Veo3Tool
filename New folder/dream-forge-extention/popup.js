const APP_URL = "http://127.0.0.1:8765";

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const content = document.getElementById("tab-" + tab.dataset.tab);
      if (content) content.classList.add("active");
      if (tab.dataset.tab === "proxy") loadProxyUI();
    });
  });
}

function setBadge(el, okText, errText, isOk) {
  el.textContent = isOk ? okText : errText;
  el.className = `badge ${isOk ? "ok" : "err"}`;
}

async function refreshTokenTab() {
  try {
    const r = await fetch(`${APP_URL}/api/extension/status`, { signal: AbortSignal.timeout(8000) });
    await r.json();
    setBadge(document.getElementById("app-status"), "Đã kết nối", "Chưa kết nối", true);
  } catch (e) {
    setBadge(document.getElementById("app-status"), "Đã kết nối", "Không kết nối", false);
  }

  const { lastBearer } = await chrome.storage.local.get(["lastBearer"]);
  const tokenStatus = document.getElementById("token-status");
  const previewEl = document.getElementById("token-preview");
  const tsEl = document.getElementById("token-ts");

  if (lastBearer && lastBearer.token) {
    setBadge(tokenStatus, "Có token", "Chưa có", true);
    previewEl.textContent = lastBearer.token;
    tsEl.textContent = "Lúc: " + (lastBearer.ts ? new Date(lastBearer.ts).toLocaleTimeString() : "?");
  } else {
    setBadge(tokenStatus, "Có token", "Chưa có", false);
    previewEl.textContent = "Chưa bắt được token. Mở labs.google/fx/tools/flow và thực hiện thao tác bất kỳ.";
    tsEl.textContent = "-";
  }
}

async function copyToken() {
  const { lastBearer } = await chrome.storage.local.get(["lastBearer"]);
  if (!lastBearer || !lastBearer.token) return;
  await navigator.clipboard.writeText(lastBearer.token);
  const btn = document.getElementById("btn-copy");
  const old = btn.textContent;
  btn.textContent = "Đã sao chép";
  setTimeout(() => {
    btn.textContent = old;
  }, 1300);
}

function bindTokenTab() {
  document.getElementById("btn-copy").onclick = copyToken;
  document.getElementById("btn-refresh").onclick = refreshTokenTab;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TOKEN_CAPTURED") refreshTokenTab();
  });
}

function sendMsg(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { success: false });
      }
    });
  });
}

function renderProxyList(proxies, status) {
  const list = document.getElementById("px-list");
  if (!proxies.length) {
    list.innerHTML = '<div class="empty">Chưa có proxy</div>';
    return;
  }

  list.innerHTML = proxies
    .map((p) => {
      const isActive = Boolean(
        status &&
          status.isEnabled &&
          status.currentProxy &&
          status.currentProxy.host === p.host &&
          status.currentProxy.port === p.port,
      );
      const hostView = `${p.protocol !== "http" ? `${p.protocol}://` : ""}${p.host}:${p.port}`;
      const meta = `${p.username ? `${p.username}@` : ""}${p.enabled ? "" : "[disabled]"}`;
      return `
        <div class="proxy-item${isActive ? " active" : ""}">
          <div>
            <div class="proxy-host">${hostView}</div>
            <div class="proxy-meta">${meta}</div>
          </div>
          <div class="proxy-actions">
            <button class="icon-btn" title="Chọn" onclick="selectProxy('${p.id}')">✓</button>
            <button class="icon-btn" title="Xóa" onclick="removeProxy('${p.id}')">✕</button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function loadProxyUI() {
  const [statusResp, proxiesResp] = await Promise.all([sendMsg("proxy_getStatus"), sendMsg("proxy_getProxies")]);

  if (statusResp.success && statusResp.data) {
    const s = statusResp.data;
    const statusEl = document.getElementById("px-status");
    statusEl.textContent = s.isEnabled ? "Bật" : "Tắt";
    statusEl.style.color = s.isEnabled ? "#4ade80" : "#f87171";

    document.getElementById("px-count").textContent = s.totalProxies || 0;
    document.getElementById("px-current").textContent = s.currentProxy
      ? `${s.currentProxy.host}:${s.currentProxy.port}`
      : "-";

    document.getElementById("px-enable-toggle").checked = !!s.isEnabled;
    document.getElementById("px-autorotate-toggle").checked = !!s.autoRotate;
    document.getElementById("px-rotate-interval").value = s.rotateInterval || 5;
    document.getElementById("px-prompt-rotate-toggle").checked = !!s.promptBasedRotate;
    document.getElementById("px-prompt-interval").value = s.promptRotateInterval || 3;
  }

  if (proxiesResp.success) {
    renderProxyList(proxiesResp.data || [], statusResp.data);
  }
}

function bindProxyTab() {
  window.selectProxy = async (id) => {
    await sendMsg("proxy_select", { proxyId: id });
    loadProxyUI();
  };

  window.removeProxy = async (id) => {
    await sendMsg("proxy_remove", { proxyId: id });
    loadProxyUI();
  };

  document.getElementById("px-add-btn").onclick = async () => {
    const text = document.getElementById("px-bulk-input").value.trim();
    if (!text) return;
    const resp = await sendMsg("proxy_addBulk", { text });
    if (resp.success) {
      document.getElementById("px-bulk-input").value = "";
      const d = resp.data || {};
      alert(`Thêm ${d.added || 0} proxy thành công${d.failed ? `, ${d.failed} lỗi` : ""}`);
      loadProxyUI();
    } else {
      alert("Lỗi: " + (resp.error || "Unknown"));
    }
  };

  document.getElementById("px-export-btn").onclick = async () => {
    const resp = await sendMsg("proxy_export");
    if (resp.success && resp.data) {
      await navigator.clipboard.writeText(resp.data);
      alert("Đã copy danh sách proxy vào clipboard");
    }
  };

  document.getElementById("px-enable-toggle").onchange = async (e) => {
    await sendMsg("proxy_setEnabled", { enabled: e.target.checked });
    loadProxyUI();
  };

  document.getElementById("px-autorotate-toggle").onchange = async (e) => {
    const minutes = parseInt(document.getElementById("px-rotate-interval").value, 10) || 5;
    await sendMsg("proxy_setRotateInterval", { minutes });
    await sendMsg("proxy_setAutoRotate", { enabled: e.target.checked });
  };

  document.getElementById("px-prompt-rotate-toggle").onchange = async (e) => {
    const prompts = parseInt(document.getElementById("px-prompt-interval").value, 10) || 3;
    await sendMsg("proxy_setPromptRotateInterval", { prompts });
    await sendMsg("proxy_setPromptBasedRotate", { enabled: e.target.checked });
  };

  document.getElementById("px-rotate-now-btn").onclick = async () => {
    const resp = await sendMsg("proxy_rotate");
    if (resp.success) {
      loadProxyUI();
    } else {
      alert("Không thể xoay: " + (resp.error || "Không có proxy"));
    }
  };

  document.getElementById("px-clear-btn").onclick = async () => {
    if (!confirm("Xóa tất cả proxy?")) return;
    await sendMsg("proxy_clearAll");
    loadProxyUI();
  };
}

initTabs();
bindTokenTab();
bindProxyTab();
refreshTokenTab();
