/* Content script — bridges window.postMessage to chrome.runtime.sendMessage */
function safeSend(msg) {
  try {
    if (typeof chrome === 'undefined' || !chrome || !chrome.runtime || !chrome.runtime.id) return;
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) {}
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  if (data.__VEO3HAO_BEARER__ && data.token) {
    safeSend({ type: 'BEARER_FROM_PAGE', token: data.token, url: data.url || '' });
  }
  if (data.__VEO3HAO_RECAPTCHA__ && data.token) {
    safeSend({ type: 'RECAPTCHA_FROM_PAGE', token: data.token, action: data.action || 'VIDEO_GENERATION' });
  }
});
