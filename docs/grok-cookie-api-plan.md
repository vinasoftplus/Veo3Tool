# Plan Tich Hop Grok Cookie API Cho DreamForge

Ngay 2026-05-04. Muc tieu: them provider Grok cho tao anh/video trong Studio, bat buoc dung cookie tai khoan Grok/SuperGrok, khong yeu cau user login tay moi lan. Tai lieu nay tong hop 2 tool mau:

- `C:\Users\PC\Downloads\VEO_PACK\VEO_PACK`: dung Grok cookie/private endpoint, co note `auth_token`, `ct0`, `SNId`.
- `C:\Users\PC\Downloads\data\RUN_VEO_4.0_V2.2.6.exe_extracted`: dung Chrome profile Playwright/CDP da login, inject `fetch()` vao `grok.com`, endpoint private that hon va payload ro hon.

## 1. Ket Luan Kien Truc

Phuong an toi uu: **Cookie + Browser Context Worker**.

Khong nen goi Grok private API truc tiep bang `requests` backend ngay tu dau. Nen cho tool/extension nap cookie vao Chrome context, mo `https://grok.com/imagine`, roi execute `fetch()` trong page. Cach nay ket hop duoc:

- Loi the cua VEO_PACK: user chi can cung cap cookie, khong can API key.
- Loi the cua RUN_VEO: request chay trong browser context, tu mang cookie/session, de lay `x-statsig-id`, it bi chan hon backend raw HTTP.
- Tu dong hon login tay: tool import cookie vao Chrome profile thay vi bat user login web.

Ten goi noi bo de de hieu:

```text
Grok Cookie Provider
Grok Browser Worker
Grok Account Pool
```

## 2. Dieu Khong Nen Hua Qua Muc

Bat buoc ghi ro trong UI/log:

- Tool co the tu nap cookie va tao request.
- Neu cookie hop le va account co quyen Grok Imagine, user khong can login tay.
- Neu Grok/Cloudflare bat captcha/challenge/checkpoint, tool khong nen co gang bypass trai phep.
- Khi gap challenge, tool phai bao `CHALLENGE_REQUIRED` hoac `COOKIE_INVALID`, yeu cau user thay cookie hoac mo profile xu ly.

Ly do: cookie khong phai API chinh thuc. Grok co the bat device verification, Cloudflare, checkpoint hoac rate-limit theo IP/account.

## 3. Luong Tong The

```text
UI config Grok accounts
        |
        v
User paste cookie: auth_token + ct0 + SNId
        |
        v
Backend validate cookie format
        |
        v
Extension/Browser Worker tao Chrome profile rieng
        |
        v
Import cookie vao domain .grok.com
        |
        v
Mo https://grok.com/imagine
        |
        v
Lay x-statsig-id tu localStorage hoac network request
        |
        v
Goi private endpoint bang fetch(credentials: include)
        |
        v
Parse stream JSON tu /rest/app-chat/conversations/new
        |
        v
Download asset ve local library
        |
        v
Tra ket qua ve Studio/job_store
```

## 4. Endpoint Can Implement

### 4.1 Health Check / Rate Limit

Endpoint tu VEO_PACK string:

```http
GET https://grok.com/rest/rate-limits
```

Chay trong browser context:

```js
const res = await fetch('https://grok.com/rest/rate-limits', {
  method: 'GET',
  credentials: 'include',
  headers: Object.assign({}, statsigHeaders || {}),
});
```

Xu ly:

- `200 application/json`: account song.
- `401/403`: cookie die, checkpoint, thieu quyen, hoac challenge.
- `429`: rate-limit, set cooldown.
- `text/html`: redirect login/challenge, coi la fail.

### 4.2 Upload Image

Endpoint tu RUN_VEO:

```http
POST https://grok.com/rest/app-chat/upload-file
```

Payload:

```json
{
  "fileName": "input.png",
  "fileMimeType": "image/png",
  "content": "<base64>",
  "fileSource": "..."
}
```

Fetch trong page:

```js
const res = await fetch('https://grok.com/rest/app-chat/upload-file', {
  method: 'POST',
  credentials: 'include',
  headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
  body: JSON.stringify({ fileName, fileMimeType, content, fileSource }),
});
const data = await res.json().catch(() => null);
```

Fields can lay tu response:

```text
fileMetadataId
fileUri / fileURL / uri / assetUri / assetUrl / url
parentPostId / postId / id
```

### 4.3 Create Media Post

Endpoint:

```http
POST https://grok.com/rest/media/post/create
```

Text-to-video payload:

```json
{
  "mediaType": "MEDIA_POST_TYPE_VIDEO",
  "prompt": "..."
}
```

Image-to-video payload:

```json
{
  "mediaType": "MEDIA_POST_TYPE_IMAGE",
  "mediaUrl": "https://assets.grok.com/..."
}
```

Response can lay:

```text
post.id
id
postId
parentPostId
mediaUrl
url
```

### 4.4 Start Conversation / Generate

Endpoint quan trong nhat:

```http
POST https://grok.com/rest/app-chat/conversations/new
```

Headers:

```http
content-type: application/json
x-xai-request-id: <uuid>
x-statsig-id: <lay tu Grok page neu co>
```

Text-to-video payload:

```json
{
  "temporary": true,
  "modelName": "grok-3",
  "message": "prompt tao video",
  "toolOverrides": {
    "videoGen": true
  },
  "enableSideBySide": true,
  "responseMetadata": {
    "experiments": [],
    "modelConfigOverride": {
      "modelMap": {
        "videoGenModelConfig": {
          "parentPostId": "<post id tu media/post/create>",
          "aspectRatio": "9:16",
          "videoLength": 6,
          "resolutionName": "480p"
        }
      }
    }
  }
}
```

Image-to-video payload:

```json
{
  "temporary": true,
  "modelName": "grok-3",
  "message": "https://assets.grok.com/...  prompt tao video",
  "fileAttachments": [
    "<fileMetadataId>"
  ],
  "toolOverrides": {
    "videoGen": true
  },
  "enableSideBySide": true,
  "responseMetadata": {
    "experiments": [],
    "modelConfigOverride": {
      "modelMap": {
        "videoGenModelConfig": {
          "parentPostId": "<image post id hoac fileMetadataId>",
          "aspectRatio": "9:16",
          "videoLength": 6,
          "resolutionName": "480p",
          "isVideoEdit": false
        }
      }
    }
  }
}
```

Response cua endpoint nay la streaming body, khong phai JSON mot cuc. Parser phai doc `res.body.getReader()` va tach tung JSON object trong stream.

Object can parse:

```json
{
  "result": {
    "response": {
      "streamingVideoGenerationResponse": {
        "progress": 100,
        "videoUrl": "https://assets.grok.com/...",
        "videoId": "...",
        "videoPostId": "...",
        "parentPostId": "..."
      }
    }
  }
}
```

Fields can lay:

```text
streamingVideoGenerationResponse.progress
streamingVideoGenerationResponse.videoUrl
streamingVideoGenerationResponse.generatedVideoUrl
streamingVideoGenerationResponse.generatedVideoUri
streamingVideoGenerationResponse.mediaUrl
streamingVideoGenerationResponse.videoId
streamingVideoGenerationResponse.videoPostId
streamingVideoGenerationResponse.parentPostId
```

### 4.5 Upscale Video

Endpoint:

```http
POST https://grok.com/rest/media/video/upscale
```

Payload:

```json
{
  "videoId": "<videoId hoac parentPostId>"
}
```

Response can lay:

```text
hdMediaUrl
hdVideoUrl
videoUrl
url
```

Retry:

- Toi da 3 lan.
- Backoff: 2s, 4s.
- Neu da co URL 720p thi skip upscale.

## 5. Cookie Import Khong Login Tay

### 5.1 Format Cookie User Nhap

UI cho paste cookie raw:

```http
auth_token=...; ct0=...; SNId=...
```

Validation:

- Bat buoc co `auth_token`.
- Nen co `ct0`.
- Nen co `SNId`.
- Khong log full cookie.
- Chi hien mask: `auth_token=abc...(len)`.

### 5.2 Import Cookie Vao Chrome Profile

Neu dung Playwright:

```python
await context.add_cookies([
    {
        "name": "auth_token",
        "value": "...",
        "domain": ".grok.com",
        "path": "/",
        "httpOnly": True,
        "secure": True,
        "sameSite": "Lax",
    },
    {
        "name": "ct0",
        "value": "...",
        "domain": ".grok.com",
        "path": "/",
        "httpOnly": False,
        "secure": True,
        "sameSite": "Lax",
    },
    {
        "name": "SNId",
        "value": "...",
        "domain": ".grok.com",
        "path": "/",
        "httpOnly": True,
        "secure": True,
        "sameSite": "Lax",
    },
])
```

Neu dung Chrome extension:

```js
chrome.cookies.set({
  url: 'https://grok.com/',
  name: 'auth_token',
  value: authToken,
  domain: '.grok.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax'
});
```

Can permission extension:

```json
{
  "permissions": ["cookies", "tabs", "scripting", "storage"],
  "host_permissions": [
    "https://grok.com/*",
    "https://assets.grok.com/*"
  ]
}
```

### 5.3 Verify Sau Khi Import

Sau khi set cookie:

```js
await chrome.tabs.update(tabId, { url: 'https://grok.com/imagine' });
```

Sau do inject:

```js
const result = await chrome.scripting.executeScript({
  target: { tabId },
  func: async () => {
    const html = document.documentElement.innerText || '';
    const loggedOut =
      location.href.includes('/sign-in') ||
      /sign in|log in|đăng nhập/i.test(html);
    return {
      url: location.href,
      loggedOut,
      statsig: localStorage.getItem('x-statsig-id'),
    };
  }
});
```

Neu `loggedOut = true`: cookie khong du.

## 6. Lay `x-statsig-id`

RUN_VEO co 2 cach:

1. Nghe request cua page, bat header `x-statsig-id`.
2. Doc `localStorage.getItem('x-statsig-id')`.

Voi extension, co the lam:

```js
const statsig = await chrome.scripting.executeScript({
  target: { tabId },
  func: () => {
    try {
      return localStorage.getItem('x-statsig-id') || '';
    } catch {
      return '';
    }
  }
});
```

Neu can bat network header, Playwright lam tot hon extension:

```python
page.on("request", on_request)
await page.goto("https://grok.com/imagine")
```

Khuyen nghi:

- Phase 1: doc localStorage.
- Phase 2: neu localStorage rong, reload `/imagine` va bat request header.

## 7. Parser Stream Cho `/conversations/new`

Can tach JSON object tu stream, vi response co the la nhieu object lien tiep.

Pseudo JS:

```js
function parseJsonObjectsFromBuffer(buffer) {
  const out = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = buffer.slice(start, i + 1);
          try { out.push(JSON.parse(slice)); } catch {}
          start = -1;
        }
      }
    }
  }

  return {
    objects: out,
    tail: start !== -1 ? buffer.slice(start) : ''
  };
}
```

Dieu kien complete:

```js
if (lastEvent.progress >= 95 && lastEvent.videoUrl) done = true;
if (lastEvent.progress >= 100 && lastEvent.videoUrl) done = true;
if (lastEvent.videoUrl && !('progress' in lastEvent)) done = true;
```

## 8. Account Pool Va Queue

### 8.1 Config

Them vao `config/config.json`:

```json
{
  "grok": {
    "enabled": true,
    "mode": "extension_browser_cookie",
    "accounts": [
      {
        "name": "Grok 1",
        "enabled": true,
        "cookie": "auth_token=...; ct0=...; SNId=...",
        "account_type": "SUPER",
        "profile_name": "grok_1",
        "max_concurrent": 2,
        "cooldown_until": 0,
        "last_error": ""
      }
    ],
    "defaults": {
      "aspect_ratio": "9:16",
      "duration": 6,
      "resolution": "480p",
      "upscale": true
    }
  }
}
```

Can ma hoa cookie neu tool phan phoi cho user khac. It nhat khong log cookie.

### 8.2 Scheduler

Moi account co:

- `lock`: tranh import cookie/reload cung luc.
- `semaphore`: gioi han song song, mac dinh 1-2.
- `cooldown_until`: khi gap 429/403.
- `status`: `OK`, `COOKIE_INVALID`, `CHALLENGE_REQUIRED`, `RATE_LIMITED`.

Round-robin:

```text
Pick account enabled
Skip account cooldown
Skip account busy neu dat max_concurrent
Submit job
Neu 429 -> cooldown 60-300s
Neu 401/403/html login -> disable tam thoi
```

Khuyen nghi luc dau:

- `max_concurrent = 1` moi account.
- Sau khi on dinh moi tang len 2-3.
- Khong chay 5-10 job cung 1 account ngay, de bi rate-limit.

## 9. Extension Worker Design

### 9.1 Background State

```js
const grokAccounts = new Map(); // accountIndex -> account state
const grokTabs = new Map();     // accountIndex -> tabId
const grokQueues = new Map();   // accountIndex -> promise tail
```

### 9.2 Ensure Tab

```js
async function ensureGrokTab(accountIndex) {
  // 1. find existing tab for account
  // 2. create if missing
  // 3. import cookies
  // 4. navigate to https://grok.com/imagine
  // 5. wait document ready
  // 6. verify not login page
}
```

### 9.3 Run In Tab

Tat ca request Grok chay qua:

```js
async function runGrokScript(accountIndex, fn, args) {
  return withAccountQueue(accountIndex, async () => {
    const tabId = await ensureGrokTab(accountIndex);
    return chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args: [args],
    });
  });
}
```

Can timeout:

- Upload image: 60s.
- Create post: 30s.
- Generate video stream: 300-600s.
- Upscale: 120s.
- Download asset: 120s.

### 9.4 Job Types

```text
grok_health_check
grok_text_to_video
grok_image_to_video
grok_upscale_video
grok_download_asset
```

## 10. Backend Router Design

Them router moi:

```text
routers/grok.py
```

Endpoints:

```http
GET  /api/grok/accounts
POST /api/grok/accounts
POST /api/grok/accounts/{index}/health
POST /api/grok/text-to-video
POST /api/grok/image-to-video
POST /api/grok/upscale
GET  /api/grok/jobs/{job_id}
```

Neu dung extension queue giong `routers/extension.py`, them browser job type:

```json
{
  "kind": "grok_browser_submit",
  "operation": "text_to_video",
  "account_index": 0,
  "payload": {
    "prompt": "...",
    "aspect_ratio": "9:16",
    "duration": 6,
    "resolution": "480p"
  }
}
```

Extension submit result:

```json
{
  "ok": true,
  "status": 200,
  "video_url": "https://assets.grok.com/...",
  "hd_url": "https://assets.grok.com/...",
  "local_path": "...",
  "post_id": "...",
  "video_id": "...",
  "raw": {}
}
```

## 11. Tich Hop Studio

UI provider:

```text
Google Labs / Veo
Grok Cookie
```

Mapping:

- Text prompt -> `message`.
- Anh tham chieu -> upload-file -> media post -> image-to-video.
- Aspect ratio -> `aspectRatio`.
- Duration -> `videoLength`.
- Resolution -> `resolutionName`.

Ket qua luu:

```json
{
  "provider": "grok_cookie",
  "account_index": 0,
  "post_id": "...",
  "video_id": "...",
  "asset_url": "...",
  "local_path": "...",
  "resolution": "720p"
}
```

Can download ve local ngay vi URL Grok co the het han.

## 12. Download Asset

Candidate URLs:

```text
<videoUrl tu stream>
<hdMediaUrl tu upscale>
https://assets.grok.com/users/<uid>/generated/<generated_id>/generated_video_hd.mp4
https://assets.grok.com/users/<uid>/generated/<generated_id>/generated_video.mp4?cache=1&dl=1
https://imagine-public.x.ai/imagine-public/share-videos/<video_id>.mp4?cache=1&dl=1
```

Validate file:

- HTTP 200.
- Content-Type co `video` hoac `octet-stream`.
- Bytes bat dau co MP4 signature hop ly (`ftyp` trong header).
- File size > threshold, vi error HTML co the cung 200.

## 13. Error Classification

```text
COOKIE_INVALID
```

401/403/login page sau khi import cookie.

```text
CHALLENGE_REQUIRED
```

HTML co Cloudflare/checkpoint/verify.

```text
RATE_LIMITED
```

429 hoac response rate limit.

```text
NO_PERMISSION
```

Account khong co Grok Imagine/video.

```text
STREAM_TIMEOUT
```

`conversations/new` khong co video sau timeout.

```text
PAYLOAD_REJECTED
```

400/422 hoac body bao payload/model/config sai.

```text
ASSET_DOWNLOAD_FAILED
```

Co URL nhung download fail.

## 14. Retry Policy

Khong retry vo han.

Health:

- Retry 1 lan sau reload tab.

Upload:

- Retry 2 lan neu network/status 0.
- Khong retry neu 401/403/429.

Create post:

- Retry 2 lan neu status 0/5xx.

Conversation:

- Retry 1 lan neu fetch error truoc khi co stream.
- Khong retry neu da tao job va dang stream nhung timeout, vi co the ton quota.

Upscale:

- Retry 3 lan, backoff 2s/4s.

Download:

- Thu candidate URL tiep theo.

## 15. Bao Mat Cookie

Bat buoc:

- Khong log cookie.
- Khong ghi cookie vao request debug.
- Mask cookie trong UI.
- Neu co the, encrypt cookie trong config.
- Khi export log/support, auto redact `auth_token=`, `ct0=`, `SNId=`.

Redact regex:

```text
(auth_token|ct0|SNId)=([^;\\s]+)
```

## 16. Phased Implementation

### Phase 1: Grok Account + Cookie Health

Muc tieu: paste cookie, tool tu import vao Chrome/extension, check login.

Files du kien:

```text
services/grok_cookie_service.py
routers/grok.py
static/js/tabs/settings.js
DreamForgeTool/dream-forge-extention/background.js
```

Done khi:

- Them/sua/xoa Grok account.
- Import cookie vao browser context.
- Health check phan biet OK / COOKIE_INVALID / CHALLENGE_REQUIRED / RATE_LIMITED.

### Phase 2: Text-to-Video

Muc tieu: tao video tu prompt.

Implement:

- `/rest/media/post/create`.
- `/rest/app-chat/conversations/new`.
- Stream parser.
- Download mp4 local.

Done khi:

- 1 prompt tao duoc video.
- Luu local path vao job result.
- Log progress tu 0-100.

### Phase 3: Image-to-Video

Muc tieu: upload anh tham chieu tu Studio/library.

Implement:

- base64 image upload.
- create image post.
- conversation image-to-video.
- download mp4.

Done khi:

- Dung anh local/library tao video.
- Khong bi loi media stale vi moi job upload fresh.

### Phase 4: Upscale

Muc tieu: tu upscale len 720p neu config bat.

Implement:

- `/rest/media/video/upscale`.
- Candidate HD URL fallback.
- Skip neu output da 720p.

Done khi:

- Video 480p co the len HD neu account cho phep.
- Fail upscale khong lam mat video goc.

### Phase 5: Multi Account / Queue

Muc tieu: chay nhieu account an toan.

Implement:

- account lock.
- cooldown.
- round-robin.
- max concurrent moi account.

Done khi:

- 2 account chay song song.
- 1 account bi rate-limit khong keo fail account khac.

### Phase 6: Studio Integration

Muc tieu: Studio chon provider Grok Cookie.

Implement:

- provider dropdown.
- mapping card refs/prompt.
- save result into existing card/job store.

Done khi:

- Studio co the tao video bang Grok.
- Ket qua hien chung voi video provider khac.

## 17. Thu Tu Uu Tien Neu Lam Thuc Te

1. Lam health check cookie truoc.
2. Lam text-to-video 1 account, 1 job.
3. Lam download local chac chan.
4. Lam image-to-video.
5. Lam upscale.
6. Lam queue/multi-account.
7. Moi gan vao Studio full.

Khong nen lam ngay multi-account + Studio + image-to-video cung luc, vi debug private API se rat kho.

## 18. Test Cases Bat Buoc

Cookie:

- Cookie dung -> OK.
- Cookie thieu `auth_token` -> reject client-side.
- Cookie het han -> COOKIE_INVALID.
- Cookie bi challenge -> CHALLENGE_REQUIRED.

Text-to-video:

- Prompt ngan.
- Prompt dai.
- 480p 6s.
- 720p neu account support.
- Timeout stream.

Image-to-video:

- PNG.
- JPG.
- Anh lon.
- Anh library da cu.
- Anh URL Grok asset.

Upscale:

- Co `hdMediaUrl`.
- Khong co `hdMediaUrl`.
- 404/429.

Download:

- URL assets.grok.com.
- URL imagine-public.x.ai.
- 200 HTML fake error.

Queue:

- 5 jobs 1 account.
- 5 jobs 2 accounts.
- Account 1 429, account 2 van chay.

## 19. Rui Ro Lon Nhat

1. Endpoint private doi schema.
2. Cookie import khong du vi Grok can device/session khac.
3. Cloudflare/challenge khong the auto xu ly.
4. `x-statsig-id` rong hoac thay doi cach lay.
5. Rate-limit khi chay song song cao.
6. Generated URL het han truoc khi download.
7. Account NORMAL/SUPER khac gioi han duration/resolution.

## 20. Khuyen Nghi Cuoi

Phuong an nen duyet:

```text
Grok Cookie -> import vao Chrome profile/extension -> fetch trong grok.com page -> queue an toan -> download local
```

Khong nen duyet:

```text
Backend requests thuong + raw cookie -> goi truc tiep private endpoint
```

Vi backend raw HTTP se de bi 403/challenge hon, kho lay `x-statsig-id`, kho giong browser fingerprint, va kho debug khi Grok tra HTML/checkpoint.

