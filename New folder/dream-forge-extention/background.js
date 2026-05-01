/* Dream Forge Extention background service worker
   Connects to app at http://127.0.0.1:8765
   - Captures Bearer tokens from labs.google requests
   - Intercepts natural reCAPTCHA tokens from page activity
   - Falls back to grecaptcha.enterprise.execute() if no cached token
   - Polls /api/extension/poll-job for captcha/browser tasks
   - Submits tokens to /api/extension/submit-job
   - Proxy management: rotate proxy per N prompts to avoid IP bans
*/

// Import proxy manager
importScripts('proxy-manager.js');


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

const DEBUG = true;
const log = DEBUG ? console.log.bind(console, '[DreamForgeExt]') : () => {};

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

// Dùng chrome.alarms để wake SW mỗi 25s — setInterval không đủ trong MV3
const ALARM_KEEPALIVE = 'veo3hao-keepalive';
chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 25 / 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    chrome.storage.local.set({ keepAlive: Date.now() });
    // Ping server để giữ connection
    fetch(`${APP_URL}/api/extension/poll-job`).catch(() => {});
  }
});

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
  let tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
  if (!tabs.length) {
    // Tự mở tab labs.google và đợi load xong (tối đa 20s)
    log('No labs.google tab — opening one and waiting...');
    await chrome.tabs.create({ url: LABS_URL, active: false });
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
      if (tabs.length) break;
    }
    if (!tabs.length) throw new Error('No labs.google tab open after auto-open');
    // Thêm 2s để page init grecaptcha
    await new Promise(r => setTimeout(r, 2000));
  }

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

// Get token cho đúng accountIndex từ backend config
async function getFreshToken(fallback = '', accountIndex = 1) {
  try {
    const res = await fetch(`${APP_URL}/api/extension/token-for-account?account_index=${accountIndex}`);
    if (res.ok) {
      const data = await res.json();
      if (data.token) return data.token;
    }
  } catch (e) {}
  return fallback;
}

// Mutex for reCAPTCHA acquisition — only one call to grecaptcha.execute() at a time
let _recaptchaMutex = Promise.resolve();

// Get reCAPTCHA token from the labs.google tab (tab needed only for reCAPTCHA)
async function getRecaptchaFromTab(action = 'VIDEO_GENERATION') {
  // Try cached intercepted token first (no mutex needed)
  const cached = _recaptchaCache[action];
  if (cached && (Date.now() - cached.ts) < RECAPTCHA_CACHE_TTL) {
    log('Using cached reCAPTCHA for action:', action);
    delete _recaptchaCache[action];
    return cached.token;
  }
  // Serialize reCAPTCHA executions — concurrent calls to grecaptcha.execute() in same tab fail
  let resolve;
  const prev = _recaptchaMutex;
  _recaptchaMutex = new Promise(r => { resolve = r; });
  await prev;
  try {
    // Check cache again after acquiring mutex (another job may have cached it)
    const cached2 = _recaptchaCache[action];
    if (cached2 && (Date.now() - cached2.ts) < RECAPTCHA_CACHE_TTL) {
      delete _recaptchaCache[action];
      return cached2.token;
    }
    return await solveCaptcha(action);
  } finally {
    resolve();
  }
}

// Ensure a labs.google tab is open and return its tabId
async function ensureLabsTab() {
  let tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
  if (tabs.length) return tabs[0].id;
  log('No labs.google tab — opening one and waiting...');
  await chrome.tabs.create({ url: LABS_URL, active: false });
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    tabs = await chrome.tabs.query({ url: LABS_FLOW_MATCH });
    if (tabs.length) break;
  }
  if (!tabs.length) throw new Error('No labs.google tab open after auto-open');
  await new Promise(r => setTimeout(r, 2000));
  return tabs[0].id;
}

// Execute fetch from inside the labs.google tab so Chrome auto-adds x-browser-* headers
async function fetchViaTab(tabId, url, fetchToken, bodyStr) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (reqUrl, token, body) => {
      try {
        const resp = await fetch(reqUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Goog-Encode-Response-If-Executable': 'base64',
          },
          body,
          credentials: 'include',
          mode: 'cors',
        });
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, reason: resp.statusText, body: text };
      } catch (e) {
        return { ok: false, status: 0, reason: 'TAB_FETCH_ERROR', body: String(e?.message || e) };
      }
    },
    args: [url, fetchToken, bodyStr],
  });
  return results[0]?.result || { ok: false, status: 0, reason: 'NO_RESULT', body: '' };
}

// Execute upload from inside the labs.google tab
async function uploadViaTab(tabId, uploadUrl, fetchToken, uploadPayloadStr) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (reqUrl, token, body) => {
      try {
        const resp = await fetch(reqUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body,
          credentials: 'include',
          mode: 'cors',
        });
        if (!resp.ok) return { ok: false, status: resp.status, body: null };
        const json = await resp.json();
        return { ok: true, status: resp.status, body: json };
      } catch (e) {
        return { ok: false, status: 0, body: null };
      }
    },
    args: [uploadUrl, fetchToken, uploadPayloadStr],
  });
  return results[0]?.result || { ok: false, status: 0, body: null };
}

// POST via labs.google tab — Chrome auto-adds x-browser-validation and x-client-data
async function executeBrowserPost(url, payload, accessToken, action = 'VIDEO_GENERATION', accountIndex = 1) {
  const freshToken = await getFreshToken(accessToken, accountIndex);
  const recaptchaToken = await getRecaptchaFromTab(action) || '';

  const p = JSON.parse(JSON.stringify(payload));
  if (p.clientContext) {
    p.clientContext.sessionId = crypto.randomUUID();
    if (recaptchaToken) {
      p.clientContext.recaptchaContext = {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
      };
    }
  }

  try {
    const tabId = await ensureLabsTab();
    let result = await fetchViaTab(tabId, url, freshToken, JSON.stringify(p));

    // 401/403 → reload tab, capture new token, retry once
    if (result.status === 401 || result.status === 403) {
      log('Got', result.status, '— reloading labs tab to refresh token...');
      const oldToken = freshToken;
      await chrome.tabs.reload(tabId);
      let retryToken = oldToken;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        retryToken = await getFreshToken(accessToken, accountIndex);
        if (retryToken && retryToken !== oldToken) { log('New token after', (i + 1) * 2, 's'); break; }
      }
      const retryRecaptcha = await getRecaptchaFromTab(action).catch(() => '') || '';
      const retryP = JSON.parse(JSON.stringify(p));
      if (retryP.clientContext) {
        retryP.clientContext.sessionId = crypto.randomUUID();
        if (retryRecaptcha) retryP.clientContext.recaptchaContext = { token: retryRecaptcha, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
      }
      const newTabId = await ensureLabsTab();
      result = await fetchViaTab(newTabId, url, retryToken, JSON.stringify(retryP));
    }
    return result;
  } catch (error) {
    return { ok: false, status: 0, reason: 'FETCH_ERROR', body: String(error?.message || error || '') };
  }
}

// Upload images + POST generation request — all via labs.google tab for x-browser-* headers
async function executeBrowserUploadAndPost(url, payload, accessToken, accountIndex = 1, action = 'VIDEO_GENERATION') {
  const freshToken = await getFreshToken(accessToken, accountIndex);
  const uploads = payload.__uploads__ || [];
  const cleanPayload = Object.assign({}, payload);
  delete cleanPayload.__uploads__;

  function parseUploadMediaId(body) {
    if (!body || typeof body !== 'object') return null;
    const KEYS = ['mediaId', 'mediaGenerationId', 'id', 'name'];
    for (const k of KEYS) {
      if (typeof body[k] === 'string' && body[k]) return body[k];
    }
    for (const v of Object.values(body)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of KEYS) {
          if (typeof v[k] === 'string' && v[k]) return v[k];
        }
      }
    }
    return null;
  }

  try {
    const tabId = await ensureLabsTab();
    const p = JSON.parse(JSON.stringify(cleanPayload));

    // Upload each image via tab so Chrome adds x-browser-* headers
    for (const up of uploads) {
      const uploadPayload = {
        imageInput: { rawImageBytes: up.base64, mimeType: up.mimeType, isUserUploaded: true },
        clientContext: { sessionId: crypto.randomUUID(), tool: 'ASSET_MANAGER' },
      };
      const upResult = await uploadViaTab(tabId, URL_UPLOAD_IMAGE, freshToken, JSON.stringify(uploadPayload));
      if (!upResult.ok) return { ok: false, status: upResult.status, reason: 'UPLOAD_FAILED', body: '' };
      const mediaId = parseUploadMediaId(upResult.body);
      if (!mediaId) return { ok: false, status: 0, reason: 'UPLOAD_NO_MEDIA_ID', body: '' };

      // Inject mediaId into payload at the correct path
      const parts = up.payloadPath.split('.');
      let obj = p;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        const arrMatch = seg.match(/^(\w+)\[(\d+)\]$/);
        obj = arrMatch ? obj[arrMatch[1]][parseInt(arrMatch[2])] : obj[seg];
      }
      const finalKey = parts[parts.length - 1];
      const finalArrMatch = finalKey.match(/^(\w+)\[(\d+)\]$/);
      if (finalArrMatch) obj[finalArrMatch[1]][parseInt(finalArrMatch[2])] = mediaId;
      else obj[finalKey] = mediaId;
    }

    // Get reCAPTCHA and POST via tab
    const recaptchaToken = await getRecaptchaFromTab(action) || '';
    if (p.clientContext) {
      p.clientContext.sessionId = crypto.randomUUID();
      if (recaptchaToken) p.clientContext.recaptchaContext = { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
    }

    let result = await fetchViaTab(tabId, url, freshToken, JSON.stringify(p));

    // 401/403 → reload tab, get new token, retry once
    if (result.status === 401 || result.status === 403) {
      log('Upload+Post got', result.status, '— reloading labs tab...');
      const oldToken = freshToken;
      await chrome.tabs.reload(tabId);
      let retryToken = oldToken;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        retryToken = await getFreshToken(accessToken, accountIndex);
        if (retryToken && retryToken !== oldToken) { log('New token after', (i + 1) * 2, 's'); break; }
      }
      const retryRecaptcha = await getRecaptchaFromTab(action).catch(() => '') || '';
      const retryP = JSON.parse(JSON.stringify(p));
      if (retryP.clientContext) {
        retryP.clientContext.sessionId = crypto.randomUUID();
        if (retryRecaptcha) retryP.clientContext.recaptchaContext = { token: retryRecaptcha, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
      }
      const newTabId = await ensureLabsTab();
      result = await fetchViaTab(newTabId, url, retryToken, JSON.stringify(retryP));
    }

    return result;
  } catch (error) {
    return { ok: false, status: 0, reason: 'SW_ERROR', body: String(error?.message || error || '') };
  }
}

// Execute a single job and report result back to server
async function executeJob(data) {
  const accountIndex = normalizeAccountIndex(data.accountIndex, 1);
  await chrome.storage.local.set({ currentAccountIndex: accountIndex });

  // Giữ SW sống trong suốt quá trình xử lý job bằng cách ping định kỳ
  let _swAlive = true;
  const _swPing = setInterval(() => {
    if (!_swAlive) return;
    chrome.storage.local.set({ jobAlive: data.jobId + '_' + Date.now() });
    fetch(`${APP_URL}/api/extension/poll-job`).catch(() => {});
  }, 20000);

  try {
    if (data.jobKind === 'browser_upload_post') {
      log('Upload+submit for job:', data.jobId, 'account:', accountIndex);
      const _uploadAction = data.jobType === 'image' ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
      const result = await executeBrowserUploadAndPost(data.url, data.payload || {}, data.accessToken || '', accountIndex, _uploadAction);
      await fetch(`${APP_URL}/api/extension/submit-browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: data.jobId, accountIndex, ok: !!result.ok, status: result.status || 0, reason: result.reason || '', body: result.body || '' }),
      }).catch(() => {});
      log('Upload+submit done for job:', data.jobId, 'status:', result.status);
      await maybeRotateProxy();

    } else if (data.jobKind === 'browser_submit') {
      log('Browser-submit for job:', data.jobId, 'account:', accountIndex);
      const action = (data.jobType === 'image' || data.jobType === 'image_upscale') ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
      const result = await executeBrowserPost(data.url, data.payload || {}, data.accessToken || '', action, accountIndex);
      await fetch(`${APP_URL}/api/extension/submit-browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: data.jobId, accountIndex, ok: !!result.ok, status: result.status || 0, reason: result.reason || '', body: result.body || '' }),
      }).catch(() => {});
      log('Browser-submit done for job:', data.jobId, 'status:', result.status);
      await maybeRotateProxy();

    } else {
      // Captcha job — needs tab, must run from SW but tab is used for grecaptcha.execute()
      log('Captcha for job:', data.jobId, 'account:', accountIndex);
      const action = data.jobType === 'image' ? 'IMAGE_GENERATION' : 'VIDEO_GENERATION';
      const token = await Promise.race([
        solveCaptcha(action),
        new Promise((_, rej) => setTimeout(() => rej(new Error('captcha timeout')), 30000)),
      ]);
      await fetch(`${APP_URL}/api/extension/submit-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: data.jobId, token, accountIndex }),
      }).catch(() => {});
      log('Captcha done for job:', data.jobId, 'account:', accountIndex);
      await maybeRotateProxy();
    }
  } catch (e) {
    console.error('[DreamForgeExt] Job error for', data.jobId, ':', e.message, e.stack);
  } finally {
    _swAlive = false;
    clearInterval(_swPing);
  }
}

// Track in-flight jobs to avoid duplicate execution
const _runningJobs = new Set();

async function pollLoop() {
  while (true) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${APP_URL}/api/extension/poll-job`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();

      if (data.hasJob && data.jobId && !_runningJobs.has(data.jobId)) {
        _runningJobs.add(data.jobId);
        // Fire and forget — allows next poll immediately for parallel jobs
        executeJob(data).finally(() => _runningJobs.delete(data.jobId));
      }
    } catch (e) {
      log('Poll error:', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// =============================================
// PROXY: Auth handler + prompt-based rotation
// =============================================

let promptsSentSinceRotate = 0;
let promptRotateEnabled = false;
let promptRotateInterval = 3; // rotate after every N prompts

// Load proxy rotation settings
chrome.storage.local.get(['promptBasedRotateEnabled', 'promptRotateInterval'], (data) => {
  promptRotateEnabled = data.promptBasedRotateEnabled || false;
  promptRotateInterval = parseInt(data.promptRotateInterval) || 3;
});

// Auto-provide credentials for proxy auth
if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      const proxy = proxyManager.getCurrentProxy();
      if (proxy && proxy.username && proxy.password) {
        callback({ authCredentials: { username: proxy.username, password: proxy.password } });
      } else {
        callback({ cancel: false });
      }
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );
}

// Rotate proxy after N prompts (call this each time a job is submitted)
async function maybeRotateProxy() {
  if (!promptRotateEnabled) return;
  if (!proxyManager.isProxyEnabled || proxyManager.proxies.length < 2) return;
  promptsSentSinceRotate++;
  if (promptsSentSinceRotate >= promptRotateInterval) {
    promptsSentSinceRotate = 0;
    try {
      await proxyManager.rotateProxy();
      log('Proxy rotated after', promptRotateInterval, 'prompts');
    } catch (e) {
      log('Proxy rotate failed:', e.message);
    }
  }
}

// Handle proxy messages from popup UI
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message.action || !message.action.startsWith('proxy_')) return false;

  (async () => {
    try {
      switch (message.action) {
        case 'proxy_getStatus': {
          const status = proxyManager.getStatus();
          status.promptBasedRotate = promptRotateEnabled;
          status.promptRotateInterval = promptRotateInterval;
          sendResponse({ success: true, data: status });
          break;
        }
        case 'proxy_getProxies':
          sendResponse({ success: true, data: proxyManager.getProxiesWithStats() });
          break;
        case 'proxy_add':
          await proxyManager.addProxy(message.proxy);
          sendResponse({ success: true });
          break;
        case 'proxy_addBulk': {
          const results = await proxyManager.addProxiesFromText(message.text);
          sendResponse({ success: true, data: { added: results.added.length, failed: results.failed.length, errors: results.failed } });
          break;
        }
        case 'proxy_remove':
          await proxyManager.removeProxy(message.proxyId);
          sendResponse({ success: true });
          break;
        case 'proxy_toggle': {
          const enabled = await proxyManager.toggleProxy(message.proxyId);
          sendResponse({ success: true, data: enabled });
          break;
        }
        case 'proxy_select': {
          const idx = proxyManager.proxies.findIndex(p => p.id === message.proxyId);
          if (idx >= 0) {
            proxyManager.currentProxyIndex = idx;
            await proxyManager.applyCurrentProxy();
            await proxyManager.saveConfig();
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Proxy not found' });
          }
          break;
        }
        case 'proxy_setEnabled':
          if (message.enabled) {
            if (proxyManager.proxies.length === 0) { sendResponse({ success: false, error: 'No proxies' }); break; }
            if (proxyManager.currentProxyIndex < 0) proxyManager.currentProxyIndex = 0;
            await proxyManager.applyCurrentProxy();
          } else {
            await proxyManager.disableProxy();
          }
          sendResponse({ success: true });
          break;
        case 'proxy_setAutoRotate':
          if (message.enabled) proxyManager.startAutoRotate();
          else proxyManager.stopAutoRotate();
          sendResponse({ success: true });
          break;
        case 'proxy_setRotateInterval':
          await proxyManager.setRotateInterval(message.minutes);
          sendResponse({ success: true });
          break;
        case 'proxy_setPromptBasedRotate':
          promptRotateEnabled = !!message.enabled;
          await chrome.storage.local.set({ promptBasedRotateEnabled: promptRotateEnabled });
          sendResponse({ success: true });
          break;
        case 'proxy_setPromptRotateInterval':
          promptRotateInterval = Math.max(1, parseInt(message.prompts) || 3);
          await chrome.storage.local.set({ promptRotateInterval });
          sendResponse({ success: true });
          break;
        case 'proxy_rotate': {
          const next = await proxyManager.rotateProxy();
          sendResponse({ success: true, data: next });
          break;
        }
        case 'proxy_test': {
          const p = proxyManager.proxies.find(x => x.id === message.proxyId);
          if (p) { const r = await proxyManager.testProxy(p); sendResponse({ success: true, data: r }); }
          else sendResponse({ success: false, error: 'Proxy not found' });
          break;
        }
        case 'proxy_testReal': {
          const p = proxyManager.proxies.find(x => x.id === message.proxyId);
          if (p) { const r = await proxyManager.testProxyWithRealConnection(p); sendResponse({ success: true, data: r }); }
          else sendResponse({ success: false, error: 'Proxy not found' });
          break;
        }
        case 'proxy_clearAll':
          await proxyManager.clearAllProxies();
          sendResponse({ success: true });
          break;
        case 'proxy_export':
          sendResponse({ success: true, data: proxyManager.exportProxies() });
          break;
        default:
          sendResponse({ success: false, error: 'Unknown proxy action' });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // keep channel open for async
});

pollLoop();
chrome.runtime.onStartup.addListener(() => pollLoop());
