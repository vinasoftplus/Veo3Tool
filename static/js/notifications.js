/**
 * Admin notification popup — shown once per session on startup.
 * Fetches active notifications from /api/notifications and displays them.
 */
(function () {
  const ICON = {
    info:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#3b82f6;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#22c55e;flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#f59e0b;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#ef4444;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  };

  const TYPE_BORDER = {
    info:    '#3b82f6',
    success: '#22c55e',
    warning: '#f59e0b',
    error:   '#ef4444',
  };

  function buildInner(notifications) {
    if (notifications.length === 1) {
      const n = notifications[0];
      return `
        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;">
          ${ICON[n.notif_type] || ICON.info}
          ${n.title ? `<div style="font-weight:700;font-size:16px;color:${n.title_color};">${escHtml(n.title)}</div>` : ''}
          <div style="font-size:14px;line-height:1.6;color:${n.message_color};">${escHtml(n.message).replace(/\n/g,'<br>')}</div>
        </div>`;
    }

    // Multiple notifications — canh giữa từng item
    return `<div style="text-align:center;font-weight:700;font-size:16px;color:#1e293b;margin-bottom:16px;display:flex;align-items:center;justify-content:center;gap:8px;">
      <span>🔔</span> Thông báo từ Admin
      <span style="font-size:13px;font-weight:500;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:999px;">${notifications.length}</span>
    </div>` + notifications.map((n, i) => {
      const border = TYPE_BORDER[n.notif_type] || '#ec4899';
      return `
        <div style="border-left:3px solid ${border};padding:12px 14px;border-radius:0 10px 10px 0;
                    background:rgba(0,0,0,.03);margin-bottom:${i < notifications.length - 1 ? '12px' : '0'};text-align:left;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:${n.title ? '6px' : '0'}">
            ${ICON[n.notif_type] || ICON.info}
            ${n.title ? `<div style="font-weight:700;font-size:14px;color:${n.title_color};">${escHtml(n.title)}</div>` : ''}
          </div>
          <div style="font-size:13px;line-height:1.6;color:${n.message_color};padding-left:28px;">${escHtml(n.message).replace(/\n/g,'<br>')}</div>
        </div>`;
    }).join('');
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showPopup(notifications) {
    const overlay = document.getElementById('notif-popup-overlay');
    const box = document.getElementById('notif-popup-box');
    const inner = document.getElementById('notif-popup-inner');
    const closeBtn = document.getElementById('notif-popup-close');
    if (!overlay || !inner) return;

    // Use bg_color from first notification (or white)
    const bgColor = notifications[0]?.bg_color || '#ffffff';
    box.style.background = bgColor;

    // Header
    const headerHtml = notifications.length > 1
      ? `<div style="font-weight:700;font-size:18px;color:#1e293b;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
           <span style="font-size:20px;">🔔</span> Thông báo từ Admin
           <span style="font-size:13px;font-weight:500;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:999px;">${notifications.length}</span>
         </div>`
      : '';

    inner.innerHTML = headerHtml + buildInner(notifications);

    overlay.style.display = 'flex';

    function closePopup() {
      overlay.style.display = 'none';
    }

    closeBtn.onclick = closePopup;
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePopup();
    }, { once: true });
  }

  async function fetchAndShow() {
    try {
      const resp = await fetch('/api/notifications');
      if (!resp.ok) return;
      const data = await resp.json();
      const notifs = data?.data;
      if (!Array.isArray(notifs) || notifs.length === 0) return;
      showPopup(notifs);
    } catch (_) {
      // silently fail — don't block the user
    }
  }

  // Wait until after license check completes before showing notification popup.
  // Poll for the license-screen to be hidden (it hides when license passes).
  function waitForLicenseAndShow() {
    const licScreen = document.getElementById('license-screen');
    if (!licScreen) {
      fetchAndShow();
      return;
    }
    // Observe display changes
    const observer = new MutationObserver(function () {
      if (licScreen.style.display === 'none') {
        observer.disconnect();
        fetchAndShow();
      }
    });
    observer.observe(licScreen, { attributes: true, attributeFilter: ['style'] });
    // Fallback: check after 10s regardless
    setTimeout(function () {
      observer.disconnect();
      if (licScreen.style.display !== 'none') return; // license not passed yet
      fetchAndShow();
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForLicenseAndShow);
  } else {
    waitForLicenseAndShow();
  }
})();
