# Grok Cookie Integration Notes

Ngay 2026-05-04. Tai lieu nay tong hop nhung gi da thay tu tool `VEO_PACK` va tai lieu xAI chinh thuc. Phan cookie Grok la private web API cua `grok.com`, khong phai public API on dinh. Nen coi moi endpoint/payload private la can verify lai bang DevTools Network truoc khi code production.

## 1. Ket luan nhanh

Co 2 cach tich hop Grok:

1. xAI API chinh thuc: dung `XAI_API_KEY`, endpoint `https://api.x.ai/v1/...`, on dinh hon, co docs, co billing/credit rieng.
2. Grok web cookie: dung cookie tai khoan SuperGrok/X Premium de goi endpoint private cua `https://grok.com/...`, khong can API key nhung de bi doi endpoint, rate-limit, captcha/challenge, checkpoint login, va co rui ro vi dung API noi bo.

Neu muc tieu la lam tool ban cho nhieu may, nen uu tien xAI API chinh thuc. Neu bat buoc dung SuperGrok cookie vi khong co API credit, nen lam theo huong extension/browser tab dang login vao `grok.com`, khong nen luu raw cookie tren backend neu khong bat buoc.

## 2. Cookie Grok can gi

Tu file `COOKIE_TO_TOKEN_FLOW.md` cua tool khac, cookie Grok toi thieu gom:

```http
SNId=...
auth_token=...
ct0=...
```

Header quan trong:

```http
Cookie: auth_token=...; ct0=...; SNId=...
X-CSRF-Token: <gia tri ct0>
Origin: https://grok.com
Referer: https://grok.com/imagine
User-Agent: <Chrome desktop moi>
Accept: application/json, text/plain, */*
Content-Type: application/json
```

Ghi chu:

- `auth_token` xac thuc account.
- `ct0` thuong duoc dung lam CSRF token.
- `SNId` co the lien quan session/device.
- Cookie co the het han, bi logout, bi checkpoint, hoac bi revoke khi doi mat khau.

## 3. Co dinh captcha/challenge khong?

Co kha nang co, nhung khong phai luc nao cung hien captcha giong Google.

Cac dang chan co the gap:

- `401/403`: cookie sai, het han, thieu `ct0`, thieu header bat buoc, hoac bi chan bot.
- `429`: het quota/rate-limit cua account.
- HTML thay vi JSON: bi redirect ve login, checkpoint, Cloudflare/challenge, hoac trang bao loi.
- WebSocket connect duoc nhung khong co event ket qua: session khong hop le, payload sai, request id sai, hoac account khong co quyen Imagine/video.
- UI yeu cau xac minh tren trinh duyet: luc nay backend cookie-only thuong khong xu ly duoc; extension tab dang login de xu ly tot hon.

Khac Google Labs/Veo: log hien tai chua thay endpoint Grok co reCAPTCHA token bat buoc trong payload. Nhung Grok co the dung bot detection/challenge rieng, rate-limit theo account/IP/device, va co the yeu cau browser context.

## 4. Endpoint private da thay trong tool khac

Tu string reverse trong `veo-ai-automation/extracted/api_region.txt`, cac endpoint lien quan Grok:

```text
https://grok.com/rest/rate-limits
https://grok.com/rest/app-chat/upload-file
https://grok.com/rest/app-chat/conversations/new
https://grok.com/ws/imagine/listen
https://grok.com/rest/media/post/create
https://grok.com/imagine
https://grok.com/imagine/post/
https://assets.grok.com
```

Va cac field/event string da thay:

```text
streamingImageGenerationResponse
generatedImageUrls
streamingVideoGenerationResponse
videoUrl
thumbnailImageUrl
image_to_video
text_to_video
enableImageGeneration
imageGenerationCount
returnImageBytes
enableImageStreaming
videoGenModelConfig
fileAttachments
modelConfigOverride
imageEditModelConfig
X-Xai-Request-Id
```

Suy luan flow private:

1. Check account/quota qua `/rest/rate-limits`.
2. Neu co anh tham chieu, upload file qua `/rest/app-chat/upload-file`.
3. Tao conversation/job qua `/rest/app-chat/conversations/new`.
4. Mo WebSocket `/ws/imagine/listen` de nghe event stream.
5. Lay image URL tu `generatedImageUrls` hoac video URL tu `videoUrl`.
6. Download ket qua tu `https://assets.grok.com/...` hoac URL tra ve.

## 5. Flow de xuat neu dung cookie

### 5.1 Check cookie/rate limit

Request:

```http
GET https://grok.com/rest/rate-limits
Cookie: auth_token=...; ct0=...; SNId=...
X-CSRF-Token: <ct0>
Referer: https://grok.com/imagine
```

Xu ly:

- `200 JSON`: cookie con song, parse quota neu response co thong tin limit.
- `401/403`: cookie die/thieu header/account bi chan.
- `429`: account het quota hoac bi rate-limit.
- `text/html`: bi redirect/challenge, khong coi la thanh cong.

### 5.2 Upload anh tham chieu

Endpoint da thay:

```http
POST https://grok.com/rest/app-chat/upload-file
```

Payload chua verify chac chan. Co 2 kha nang:

1. `multipart/form-data` voi file binary.
2. JSON/base64 voi metadata file.

Can bat Network that tu `grok.com/imagine` de xac nhan. Khong nen doan schema roi code ngay, vi upload sai schema co the van `200` nhung file id khong dung cho generation.

Output can tim trong response:

```json
{
  "fileId": "...",
  "url": "...",
  "mimeType": "image/png",
  "name": "..."
}
```

Ten field tren la suy luan, can verify lai bang Network.

### 5.3 Tao image text-to-image

Endpoint da thay:

```http
POST https://grok.com/rest/app-chat/conversations/new
```

Payload private can verify. Tu string da thay, shape co the gom cac nhom field:

```json
{
  "message": "prompt tao anh",
  "modelName": "grok-imagine",
  "enableImageGeneration": true,
  "imageGenerationCount": 1,
  "returnImageBytes": false,
  "enableImageStreaming": true,
  "modelConfigOverride": {
    "imageGeneration": {
      "aspectRatio": "16:9",
      "style": "normal"
    }
  },
  "fileAttachments": []
}
```

Can verify cac key that. Cac key nhu `modelName`, `message`, `modelConfigOverride.imageGeneration` o tren la suy luan tu cach app chat thuong lam, khong phai schema da xac nhan.

Ket qua du kien khong tra full image ngay trong HTTP response, ma stream qua WebSocket:

```json
{
  "streamingImageGenerationResponse": {
    "generatedImageUrls": [
      "https://assets.grok.com/..."
    ]
  }
}
```

### 5.4 Image-to-video

Da thay string:

```text
image_to_video
videoGenModelConfig
streamingVideoGenerationResponse
videoUrl
thumbnailImageUrl
```

Payload suy luan:

```json
{
  "message": "animate this image...",
  "enableImageGeneration": false,
  "fileAttachments": [
    {
      "fileId": "<uploaded file id>",
      "mimeType": "image/png"
    }
  ],
  "modelConfigOverride": {
    "videoGenModelConfig": {
      "mode": "image_to_video",
      "prompt": "animate this image...",
      "duration": 6,
      "aspectRatio": "16:9"
    }
  }
}
```

Ket qua du kien:

```json
{
  "streamingVideoGenerationResponse": {
    "videoUrl": "https://assets.grok.com/...",
    "thumbnailImageUrl": "https://assets.grok.com/..."
  }
}
```

Tat ca key payload can bat Network de verify.

### 5.5 Text-to-video

Da thay string:

```text
text_to_video
```

Payload suy luan:

```json
{
  "message": "prompt tao video",
  "modelConfigOverride": {
    "videoGenModelConfig": {
      "mode": "text_to_video",
      "prompt": "prompt tao video",
      "duration": 6,
      "aspectRatio": "16:9"
    }
  }
}
```

Can verify vi Grok web co the khong mo text-to-video cho moi account/region. Co account chi co image hoac image-to-video.

## 6. WebSocket `/ws/imagine/listen`

Endpoint da thay:

```text
wss://grok.com/ws/imagine/listen
```

Can co cookie/header tu browser session. Trong backend Python, WebSocket library phai gui du:

```http
Cookie: auth_token=...; ct0=...; SNId=...
Origin: https://grok.com
User-Agent: <Chrome desktop moi>
```

Van de can verify:

- WebSocket co can query param `conversationId`, `requestId`, `xaiRequestId`, hay khong.
- Event dau tien co can client send message subscribe hay server tu push.
- Ket qua stream co split nhieu chunk khong.
- Co ping/pong timeout khong.

Parser nen thiet ke tolerant:

- Chap nhan text frame JSON.
- Neu frame co nested JSON string thi parse 2 lop.
- Tim URL bang cac key `generatedImageUrls`, `videoUrl`, `thumbnailImageUrl`.
- Neu gap event loi thi tra loi ro body de debug.

## 7. Header/browser fingerprint nen co

Private API Grok co the check header giong browser. Nen mimic Chrome:

```http
Accept: application/json, text/plain, */*
Accept-Language: en-US,en;q=0.9,vi;q=0.8
Cache-Control: no-cache
Pragma: no-cache
Origin: https://grok.com
Referer: https://grok.com/imagine
User-Agent: Mozilla/5.0 (...) Chrome/... Safari/537.36
X-CSRF-Token: <ct0>
X-Xai-Request-Id: <uuid moi moi request>
```

Co the can them header dong bo voi app web that:

```text
x-statsig-id
x-client-name
x-client-version
baggage / sentry-trace
```

Nhung khong nen them ngau nhien neu chua thay trong Network, vi sai header cung co the lam bi flag.

## 8. Loi thuong gap va cach phan loai

```text
401 Unauthorized
```

Cookie het han, sai domain, thieu `auth_token`, hoac account chua login.

```text
403 Forbidden
```

Thieu `ct0`/`X-CSRF-Token`, challenge, account khong co quyen Imagine, bi bot detection, hoac payload sai.

```text
429 Too Many Requests
```

Quota/rate-limit. Nen cooldown account, khong retry lien tuc.

```text
200 text/html
```

Khong phai thanh cong. Thuong la redirect/login/challenge page. Phai check `content-type`.

```text
WebSocket close 1008/1011
```

Policy/session invalid/server error. Can log close code + reason.

```text
Khong co generatedImageUrls/videoUrl
```

Payload sai, prompt bi moderation, job failed, hoac parser chua bat dung event.

## 9. Kien truc nen lam trong DreamForge

### Huong A: Backend cookie-only

Uu diem:

- Nhanh, khong can Chrome tab.
- De queue/multi-account.
- De tich hop voi Studio hien tai.

Nhuoc diem:

- De bi challenge/captcha/checkpoint.
- Cookie raw nam trong config/server, rui ro bao mat.
- Web private API doi la vo.
- Kho debug khi Grok tra HTML/challenge.

### Huong B: Extension/browser-tab

Uu diem:

- Tab da login that, xu ly challenge/login tot hon.
- Cookie khong can luu raw trong backend.
- Giong cach tool dang lam voi Google Labs.

Nhuoc diem:

- Cham hon backend cookie.
- Can tab pool/mutex rieng cho `grok.com`.
- Phuc tap hon neu can WebSocket + download asset.

Khuyen nghi: neu dung cookie cho nhieu user/may, nen lam Huong B truoc. Backend chi queue job, extension dang login Grok lam request trong context tab.

## 10. Queue/multi-account neu dung cookie

Can co:

- Account pool cho Grok rieng, khong tron voi Google/Veo.
- Moi account co cookie, status, cooldown, last_error.
- Khi gap `429`, cooldown account theo response hoac mac dinh 60-300s.
- Khi gap `401/403` nghi cookie die, disable account va bao user thay cookie.
- Khong retry song song cung 1 account qua nhieu job neu vua bi challenge.
- Luu asset ve local ngay, vi URL `assets.grok.com` co the het han.

## 11. xAI API chinh thuc de doi chieu

### 11.1 Image generation

Endpoint:

```http
POST https://api.x.ai/v1/images/generations
Authorization: Bearer <XAI_API_KEY>
Content-Type: application/json
```

Payload:

```json
{
  "model": "grok-imagine-image",
  "prompt": "A cinematic orange cat astronaut on Mars",
  "n": 1,
  "response_format": "url",
  "aspect_ratio": "16:9",
  "resolution": "1k"
}
```

Response dang URL:

```json
{
  "data": [
    {
      "url": "https://..."
    }
  ],
  "usage": {
    "cost_in_usd_ticks": 200000000
  }
}
```

Neu `response_format = "b64_json"`:

```json
{
  "data": [
    {
      "b64_json": "..."
    }
  ]
}
```

Thong so chinh thuc:

- `n`: 1-10.
- `response_format`: `url` hoac `b64_json`.
- `aspect_ratio`: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto`.
- `resolution`: `1k`, `2k`.

### 11.2 Image edit / multi-image edit

Endpoint:

```http
POST https://api.x.ai/v1/images/edits
```

Mot anh:

```json
{
  "model": "grok-imagine-image",
  "prompt": "Render this as an oil painting",
  "image": {
    "type": "image_url",
    "url": "https://example.com/input.png"
  }
}
```

Nhieu anh:

```json
{
  "model": "grok-imagine-image",
  "prompt": "Combine the subjects into one scene",
  "images": [
    { "type": "image_url", "url": "https://example.com/a.jpg" },
    { "type": "image_url", "url": "https://example.com/b.jpg" }
  ],
  "aspect_ratio": "3:2"
}
```

Theo docs xAI, edit support public URL hoac base64 data URI. Toi da thay docs noi multi-image edit toi da 5 anh.

### 11.3 Video generation

Endpoint dung:

```http
POST https://api.x.ai/v1/videos/generations
```

Khong phai:

```text
/v1/video/generations
```

Text-to-video:

```json
{
  "model": "grok-imagine-video",
  "prompt": "A cat lounging in a sunbeam, tail gently swishing",
  "duration": 5,
  "aspect_ratio": "16:9",
  "resolution": "720p"
}
```

Response start:

```json
{
  "request_id": "..."
}
```

Poll:

```http
GET https://api.x.ai/v1/videos/{request_id}
Authorization: Bearer <XAI_API_KEY>
```

Response done:

```json
{
  "status": "done",
  "video": {
    "url": "https://vidgen.x.ai/.../video.mp4",
    "duration": 8,
    "respect_moderation": true
  },
  "model": "grok-imagine-video"
}
```

Status:

```text
pending
done
expired
failed
```

### 11.4 Video modes chinh thuc

Theo docs xAI, `/v1/videos/generations` ho tro:

- Text-to-video: `prompt` only.
- Image-to-video: `prompt` + `image`.
- Reference-to-video: `prompt` + `reference_images`.

Ngoai ra co endpoint rieng:

```http
POST /v1/videos/edits
POST /v1/videos/extensions
```

Thong so video:

- `duration`: 1-15s cho generation.
- `aspect_ratio`: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`.
- `resolution`: `480p` hoac `720p`.
- Generated URL la tam thoi, nen download ve local ngay.

## 12. Nhung diem can bat Network truoc khi code cookie

Can user mo `grok.com/imagine`, tao 1 anh va 1 video, export HAR hoac chup raw request/response cho cac request:

- `/rest/rate-limits`
- `/rest/app-chat/upload-file`
- `/rest/app-chat/conversations/new`
- `/ws/imagine/listen`

Can lay:

- Request method.
- Full request headers, tru cookie co the redact.
- Request payload JSON/form-data.
- Response JSON dau tien.
- WebSocket messages mau cho success/fail.

Khong nen code generation cookie neu chua co payload that, vi rui ro cao nhat nam o `/conversations/new` va WebSocket subscribe.

## 13. Huong implement an toan neu duoc duyet

Phase 1: Account config + cookie health check.

- Them Grok account list: name, cookie, enabled.
- Parse cookie, extract `ct0`.
- Goi `/rest/rate-limits`.
- UI hien `OK`, `COOKIE_DIE`, `RATE_LIMIT`, `CHALLENGE`.

Phase 2: Grok image text-to-image.

- Chi lam 1 account, 1 job/luc.
- Log raw status/content-type/body ngan.
- Download asset ve local library.

Phase 3: Anh tham chieu + image-to-video.

- Verify upload-file.
- Verify WebSocket event video.
- Download mp4 local.

Phase 4: Multi-account/queue.

- Moi account co lock rieng.
- Cooldown account khi `429/403`.
- Khong retry vo han.

Phase 5: Tich hop Studio.

- Them model provider `grok_cookie`.
- Mapping prompt/ref tu card Studio.
- Ket qua luu chung job store/library.

## 14. Rui ro phap ly/van hanh

- Grok cookie/private endpoint co the vi pham dieu khoan dich vu neu automation bi cam. Can tu kiem tra ToS.
- Endpoint private co the doi bat ky luc nao, khong co bao truoc.
- SuperGrok subscription khong dong nghia voi xAI API credit.
- Neu tool phan phoi cho user khac, luu cookie raw la rui ro bao mat lon.
- Nen encrypt config hoac dung extension-tab de tranh backend nam cookie.

## 15. Nguon da dung

- Local reverse notes tu `C:\Users\PC\Downloads\VEO_PACK\VEO_PACK\COOKIE_TO_TOKEN_FLOW.md`.
- Local string reverse tu `C:\Users\PC\Downloads\VEO_PACK\VEO_PACK\veo-ai-automation\extracted\api_region.txt`.
- xAI official image docs: https://docs.x.ai/developers/model-capabilities/images/generation
- xAI official video docs: https://docs.x.ai/docs/guides/video-generations
- xAI cost tracking docs: https://docs.x.ai/developers/cost-tracking
