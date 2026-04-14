/* Veo3Hao Extension background service worker
   Connects to app at http://127.0.0.1:8765
   - Captures Bearer tokens from labs.google requests
   - Intercepts natural reCAPTCHA tokens from page activity
   - Falls back to grecaptcha.enterprise.execute() if no cached token
   - Polls /api/extension/poll-job for captcha/browser tasks
   - Submits tokens to /api/extension/submit-job
*/

const APP_URL = 'http://127.0.0.1:8765';
const URL_UPLOAD_IMAGE = 'https://aisandbox-pa.googleapis.com/v1:uploadUserImage';
const POLL_INTERVAL = 2000;
const KEEPALIVE_INTERVAL = 20000;
const TOKEN_REFRESH_INTERVAL = 3 * 60 * 1000;
const AUTO_REFRESH_ENABLED = false;
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const LABS_URL = 'https://labs.google/fx/tools/flow';
const LABS_FLOW_MATCH = '*://labs.google/fx/tools/flow*';
const TOKEN_SOURCE_HOSTS = ['aisandbox-pa.googleapis.com'];
// Cached reCAPTCHA token intercepted from page (expires in 2 minutes)
const RECAPTCHA_CACHE_TTL = 110 * 1000;

const DEBUG = false;
const log = DEBUG ? console.log.bind(console, '[Veo3Hao]') : () => {};

// In-memory cache for intercepted reCAPTCHA tokens keyed by action
const _recaptchaCache = {};

function normalizeAccountIndex(value, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function isPreferredTokenUrl(url) {
  try {
    return TOKEN_SOURCE_HOSTS.some((host) => String(url || '').includes(host));
  } catch (e) {
    return false;
  }
}

async function getCurrentAccountIndex(fallback = 1) {
  try {
    const data = await chrome.storage.local.get(['currentAccountIndex']);
    return normalizeAccountIndex(data.currentAccountIndex, fallback);
  } catch (e) {
    return fallback;
  }
}

setInterval(() => {
  chrome.storage.local.set({ keepAlive: Date.now() });
}, KEEPALIVE_INTERVAL);

async function autoReloadLabsTab() {
  try {
    const tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
    if (tabs.length > 0) {
      log('Auto-reloading labs.google tab for fresh token');
      await chrome.tabs.reload(tabs[0].id);
    } else {
      log('No labs.google tab found, opening one');
      chrome.tabs.create({ url: LABS_URL, active: false });
    }
  } catch (e) {
    log('Auto-reload error:', e.message);
  }
}

const ALARM_TOKEN_REFRESH = 'veo3hao-token-refresh';
if (AUTO_REFRESH_ENABLED) {
  chrome.alarms.create(ALARM_TOKEN_REFRESH, {
    delayInMinutes: 0.1,
    periodInMinutes: TOKEN_REFRESH_INTERVAL / 60000,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (AUTO_REFRESH_ENABLED && alarm.name === ALARM_TOKEN_REFRESH) {
    autoReloadLabsTab();
  }
});

// --- Bearer token capture via webRequest ---
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      if (!isPreferredTokenUrl(details.url)) return;
      const authHeader = (details.requestHeaders || []).find(
        (h) => h.name.toLowerCase() === 'authorization'
      );
      if (authHeader && authHeader.value && authHeader.value.toLowerCase().startsWith('bearer ')) {
        const token = authHeader.value.slice(7);
        const payload = { token, url: details.url, ts: new Date().toISOString() };

        chrome.storage.local.set({ lastBearer: payload });

        const expiryTs = Date.now() + 3600 * 1000;
        getCurrentAccountIndex().then((accountIndex) => {
          fetch(`${APP_URL}/api/extension/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, url: details.url, expiry: expiryTs, accountIndex }),
          }).catch(() => {});
        });

        chrome.runtime.sendMessage({ type: 'TOKEN_CAPTURED', payload }).catch(() => {});
      }
    } catch (e) {}
  },
  { urls: ['*://*.googleapis.com/*', '*://labs.google/*'] },
  ['requestHeaders', 'extraHeaders']
);

// --- Inject fetch/XHR hooks + reCAPTCHA interceptor into labs.google tab ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.includes('labs.google')) return;

  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (siteKey) => {
      if (window.__veo3hao_hooked__) return;
      window.__veo3hao_hooked__ = true;

      // Hook fetch to capture Bearer tokens AND intercept reCAPTCHA reload responses
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';

        // Capture Bearer tokens from outbound requests
        try {
          const headers = init && init.headers;
          if (headers) {
            let auth = null;
            if (typeof headers.get === 'function') {
              auth = headers.get('Authorization') || headers.get('authorization');
            } else {
              auth = headers['Authorization'] || headers['authorization'];
            }
            if (auth && auth.toLowerCase().startsWith('bearer ')) {
              window.postMessage({ __VEO3HAO_BEARER__: true, token: auth.slice(7), url }, '*');
            }
          }
        } catch (e) {}

        const result = origFetch.apply(this, arguments);

        // Intercept reCAPTCHA reload response to capture real tokens
        if (url && url.includes('/recaptcha/enterprise/reload') && url.includes(siteKey)) {
          result.then((resp) => {
            const clone = resp.clone();
            clone.text().then((text) => {
              // Token is encoded as ["rresp","TOKEN_VALUE",...]
              const marker = '["rresp","';
              const start = text.indexOf(marker);
              if (start !== -1) {
                const after = text.indexOf('"', start + marker.length);
                if (after !== -1) {
                  const token = text.slice(start + marker.length, after);
                  if (token && token.length > 20) {
                    // Determine action from URL
                    let action = 'VIDEO_GENERATION';
                    try {
                      const urlObj = new URL(url);
                      const ac = urlObj.searchParams.get('ac') || '';
                      if (ac.includes('IMAGE')) action = 'IMAGE_GENERATION';
                    } catch (e) {}
                    window.postMessage({
                      __VEO3HAO_RECAPTCHA__: true,
                      token,
                      action,
                    }, '*');
                  }
                }
              }
            }).catch(() => {});
          }).catch(() => {});
        }

        return result;
      };

      // Hook XMLHttpRequest to capture Bearer tokens
      const origOpen = XMLHttpRequest.prototype.open;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (method, url) {
        this._hookedUrl = url;
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name && name.toLowerCase() === 'authorization' && value && value.toLowerCase().startsWith('bearer ')) {
          window.postMessage({ __VEO3HAO_BEARER__: true, token: value.slice(7), url: this._hookedUrl }, '*');
        }
        return origSetHeader.apply(this, arguments);
      };

      // Hook grecaptcha.enterprise.execute to intercept tokens the page requests naturally
      function hookGrecaptcha() {
        if (!window.grecaptcha || !window.grecaptcha.enterprise) return false;
        if (window.grecaptcha.enterprise.__veo3hao_hooked__) return true;
        window.grecaptcha.enterprise.__veo3hao_hooked__ = true;
        const origExecute = window.grecaptcha.enterprise.execute.bind(window.grecaptcha.enterprise);
        window.grecaptcha.enterprise.execute = function (siteKeyArg, opts) {
          const promise = origExecute(siteKeyArg, opts);
          promise.then((token) => {
            if (token) {
              const action = (opts && opts.action) || 'VIDEO_GENERATION';
              window.postMessage({ __VEO3HAO_RECAPTCHA__: true, token, action }, '*');
            }
          }).catch(() => {});
          return promise;
        };
        return true;
      }

      // Try to hook immediately, then poll until available
      if (!hookGrecaptcha()) {
        let tries = 0;
        const timer = setInterval(() => {
          if (hookGrecaptcha() || ++tries > 100) clearInterval(timer);
        }, 200);
      }
    },
    args: [RECAPTCHA_SITE_KEY],
  }).catch(() => {});
});

// --- Handle messages from content.js ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BEARER_FROM_PAGE') {
    if (!isPreferredTokenUrl(msg.url)) return;
    const payload = { token: msg.token, url: msg.url, ts: new Date().toISOString() };
    chrome.storage.local.set({ lastBearer: payload });
    getCurrentAccountIndex().then((accountIndex) => {
      fetch(`${APP_URL}/api/extension/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: msg.token, url: msg.url, accountIndex }),
      }).catch(() => {});
    });
    chrome.runtime.sendMessage({ type: 'TOKEN_CAPTURED', payload }).catch(() => {});
  }

  if (msg.type === 'RECAPTCHA_FROM_PAGE') {
    const { token, action } = msg;
    if (token && token.length > 20) {
      const key = action || 'VIDEO_GENERATION';
      _recaptchaCache[key] = { token, ts: Date.now() };
      log('Intercepted natural reCAPTCHA token for action:', key, token.slice(0, 20) + '...');
    }
  }
});

// --- solveCaptcha: use cached intercepted token first, fall back to execute() ---
async function solveCaptcha(action = 'VIDEO_GENERATION') {
  // 1. Use cached intercepted token if fresh enough
  const cached = _recaptchaCache[action];
  if (cached && (Date.now() - cached.ts) < RECAPTCHA_CACHE_TTL) {
    log('Using cached reCAPTCHA token for action:', action);
    delete _recaptchaCache[action]; // use once
    return cached.token;
  }

  // 2. Try to trigger a natural reCAPTCHA execution by calling execute() in page context
  const tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
  if (!tabs.length) throw new Error('No labs.google tab open');

  const tabId = tabs[0].id;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (siteKey, actionName) => {
      try {
        const gr = await new Promise((resolve, reject) => {
          let tries = 0;
          const timer = setInterval(() => {
            if (window.grecaptcha && window.grecaptcha.enterprise) {
              clearInterval(timer);
              resolve(window.grecaptcha.enterprise);
            }
            if (++tries > 50) {
              clearInterval(timer);
              reject(new Error('grecaptcha timeout'));
            }
          }, 100);
        });
        return await gr.execute(siteKey, { action: actionName });
      } catch (e) {
        return null;
      }
    },
    args: [RECAPTCHA_SITE_KEY, action],
  });
  return results[0]?.result ?? null;
}

async function executeBrowserPost(url, payload, accessToken) {
  const tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
  if (!tabs.length) throw new Error('No labs.google flow tab open');

  const tabId = tabs[0].id;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (targetUrl, targetPayload, token, siteKey) => {
      try {
        // Get fresh reCAPTCHA token in-browser right before sending — same execution context
        let recaptchaToken = '';
        try {
          const gr = await new Promise((resolve, reject) => {
            let tries = 0;
            const t = setInterval(() => {
              if (window.grecaptcha && window.grecaptcha.enterprise) { clearInterval(t); resolve(window.grecaptcha.enterprise); }
              if (++tries > 30) { clearInterval(t); reject(new Error('timeout')); }
            }, 100);
          });
          recaptchaToken = await gr.execute(siteKey, { action: 'VIDEO_GENERATION' }) || '';
        } catch (e) {}

        // Inject fresh token into payload's recaptchaContext
        if (recaptchaToken && targetPayload && targetPayload.clientContext) {
          targetPayload.clientContext.recaptchaContext = {
            token: recaptchaToken,
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
          };
        }

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(targetPayload),
          credentials: 'include',
          mode: 'cors',
        });
        const body = await response.text();
        return { ok: response.ok, status: response.status, reason: response.statusText, body };
      } catch (error) {
        return { ok: false, status: 0, reason: 'BROWSER_FETCH_ERROR', body: String(error?.message || error || '') };
      }
    },
    args: [url, payload, accessToken, RECAPTCHA_SITE_KEY],
  });
  return results[0]?.result ?? { ok: false, status: 0, reason: 'NO_RESULT', body: '' };
}

// Upload image(s) in browser then immediately POST the video generation request
// payload.__uploads__ = [{fieldKey, base64, mimeType, targetPayloadPath}, ...]
async function executeBrowserUploadAndPost(url, payload, accessToken) {
  const tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
  if (!tabs.length) throw new Error('No labs.google flow tab open');

  const tabId = tabs[0].id;
  const uploads = payload.__uploads__ || [];
  // Remove internal marker before sending to page
  const cleanPayload = Object.assign({}, payload);
  delete cleanPayload.__uploads__;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (uploadUrl, targetUrl, targetPayload, token, uploadsList, siteKey) => {
      function normalizeMediaId(value) {
        if (!value) return null;
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return String(value);
        if (typeof value === 'object') {
          return (
            value.mediaId ||
            value.mediaGenerationId ||
            value.id ||
            value.name ||
            null
          );
        }
        return String(value);
      }

      // Helper: upload one image, return mediaId
      async function uploadImage(base64str, mimeType) {
        const uploadPayload = {
          imageInput: {
            rawImageBytes: base64str,
            mimeType: mimeType,
            isUserUploaded: true,
            aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          },
          clientContext: { sessionId: crypto.randomUUID(), tool: 'ASSET_MANAGER' },
        };
        const resp = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(uploadPayload),
          credentials: 'include',
          mode: 'cors',
        });
        if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
        const body = await resp.json();
        return normalizeMediaId(
          body.mediaId ||
          body.mediaGenerationId ||
          body.id ||
          body.name ||
          body.media ||
          null
        );
      }

      try {
        // Ensure __uploads__ is not sent to the API
        delete targetPayload.__uploads__;

        // Upload all images and inject mediaIds into payload
        for (const up of uploadsList) {
          const mediaId = await uploadImage(up.base64, up.mimeType);
          if (!mediaId) return { ok: false, status: 0, reason: 'UPLOAD_NO_MEDIA_ID', body: '' };
          // Navigate nested path: e.g. "requests[0].startImage.mediaId"
          const parts = up.payloadPath.split('.');
          let obj = targetPayload;
          for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            const arrMatch = p.match(/^(\w+)\[(\d+)\]$/);
            obj = arrMatch ? obj[arrMatch[1]][parseInt(arrMatch[2])] : obj[p];
          }
          const finalKey = parts[parts.length - 1];
          const finalArrMatch = finalKey.match(/^(\w+)\[(\d+)\]$/);
          if (finalArrMatch) {
            obj[finalArrMatch[1]][parseInt(finalArrMatch[2])] = mediaId;
          } else {
            obj[finalKey] = mediaId;
          }
        }

        // Get fresh reCAPTCHA token right before POST
        let recaptchaToken = '';
        try {
          const gr = await new Promise((resolve, reject) => {
            let tries = 0;
            const t = setInterval(() => {
              if (window.grecaptcha && window.grecaptcha.enterprise) { clearInterval(t); resolve(window.grecaptcha.enterprise); }
              if (++tries > 30) { clearInterval(t); reject(new Error('timeout')); }
            }, 100);
          });
          recaptchaToken = await gr.execute(siteKey, { action: 'VIDEO_GENERATION' }) || '';
        } catch (e) {}

        if (recaptchaToken && targetPayload.clientContext) {
          targetPayload.clientContext.recaptchaContext = {
            token: recaptchaToken,
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
          };
        }

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(targetPayload),
          credentials: 'include',
          mode: 'cors',
        });
        const body = await response.text();
        return { ok: response.ok, status: response.status, reason: response.statusText, body };
      } catch (error) {
        return { ok: false, status: 0, reason: 'BROWSER_ERROR', body: String(error?.message || error || '') };
      }
    },
    args: [URL_UPLOAD_IMAGE, url, cleanPayload, accessToken, uploads, RECAPTCHA_SITE_KEY],
  });
  return results[0]?.result ?? { ok: false, status: 0, reason: 'NO_RESULT', body: '' };
}

async function pollLoop() {
  while (true) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${APP_URL}/api/extension/poll-job`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();

      if (data.hasJob) {
        const accountIndex = normalizeAccountIndex(data.accountIndex, 1);
        await chrome.storage.local.set({ currentAccountIndex: accountIndex });

        if (data.jobKind === 'browser_upload_post') {
          log('Upload+submit browser request for job:', data.jobId, 'type:', data.jobType, 'account:', accountIndex);
          const result = await executeBrowserUploadAndPost(data.url, data.payload || {}, data.accessToken || '');
          await fetch(`${APP_URL}/api/extension/submit-browser`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: data.jobId, accountIndex, ok: !!result.ok, status: result.status || 0, reason: result.reason || '', body: result.body || '' }),
          });
          log('Upload+submit completed for job:', data.jobId, 'status:', result.status);
        } else if (data.jobKind === 'browser_submit') {
          log('Submitting browser request for job:', data.jobId, 'type:', data.jobType, 'account:', accountIndex);
          const result = await executeBrowserPost(data.url, data.payload || {}, data.accessToken || '');
          await fetch(`${APP_URL}/api/extension/submit-browser`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: data.jobId,
              accountIndex,
              ok: !!result.ok,
              status: result.status || 0,
              reason: result.reason || '',
              body: result.body || '',
            }),
          });
          log('Browser submit completed for job:', data.jobId, 'status:', result.status);
        } else {
          log('Solving captcha for job:', data.jobId, 'type:', data.jobType, 'account:', accountIndex);
          const action = data.jobType === 'image' ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
          const token = await Promise.race([
            solveCaptcha(action),
            new Promise((_, rej) => setTimeout(() => rej(new Error('captcha timeout')), 30000)),
          ]);

          await fetch(`${APP_URL}/api/extension/submit-job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: data.jobId, token, accountIndex }),
          });
          log('Captcha submitted for job:', data.jobId, 'account:', accountIndex);
        }
      }
    } catch (e) {
      log('Poll error:', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

pollLoop();
chrome.runtime.onStartup.addListener(() => pollLoop());
