# Phân tích Flow Lấy Access Token từ Cookie Google

## Tổng quan

App dùng cookie Google để authenticate với `labs.google` (Google AI Studio / Veo), extract `access_token` từ response, sau đó dùng token đó để call Veo API.

---

## Flow chi tiết

### Bước 1: Lấy CSRF Token

```
GET https://labs.google/fx/api/auth/csrf
Headers:
  Cookie: <google_cookie_string>

Response:
  { "csrfToken": "xxx" }

Nếu không có csrfToken → throw "CSRF token not found"
```

---

### Bước 2: Sign in với Google OAuth

```
POST https://labs.google/fx/api/auth/signin/google
Body:
  { "callbackUrl": "https://labs.google/fx/tools/flow" }
Headers:
  Cookie: <google_cookie_string>
  X-CSRF-Token: <csrfToken từ bước 1>

Response:
  Redirect URL chứa callback với access_token

Nếu response không có google auth URL → throw "google auth URL not found"
Nếu không có callback_url → throw "missing callback_url from Google redirect"
```

---

### Bước 3: Extract Access Token từ Callback

```
GET <callback_url từ bước 2>
Headers:
  Cookie: <google_cookie_string>

Response body: JSON string
Regex extract: "access_token":"([^"]+)"

Nếu không match → throw "failed to get access_token"
```

---

### Bước 4: Xác nhận account hợp lệ (create/get project)

```
POST https://labs.google/fx/api/trpc/project.createProject
Headers:
  Authorization: Bearer <access_token>
  Cookie: <google_cookie_string>
Body:
  {
    "projectTitle": "VEO AI AUTOMATION",
    "toolName": "..."
  }

Response:
  { "result": { "email": "...", "project_id": "..." } }

Regex extract email: "email":"([^"]+)"

Cases:
  - Success → lưu project_id + email
  - Fail nhưng có old project_id cùng email → reuse project_id
  - Fail không có project_id → throw error
```

---

### Bước 5: Dùng access_token để gọi Veo API

```
POST https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideo
Headers:
  Authorization: Bearer <access_token>
  Content-Type: application/json
Body:
  { model, prompts, config... }
```

---

## Cookie Die Detection

App detect cookie die theo 2 cách:

1. **Bước 2 fail** → response không có google auth URL
2. **Response text chứa** `"Cookie die"` → hiển thị "Cookie die vui lòng thay cookie và thử lại"

---

## Implement lại bằng Python

```python
import requests
import re

def get_access_token_from_cookie(cookie_string: str) -> dict:
    """
    Lấy access_token từ cookie Google để dùng với Veo API
    
    Args:
        cookie_string: Cookie string copy từ browser DevTools
        
    Returns:
        { "access_token": "...", "email": "...", "project_id": "..." }
    """
    
    session = requests.Session()
    
    # Parse cookie string thành dict
    cookies = {}
    for part in cookie_string.split(';'):
        part = part.strip()
        if '=' in part:
            key, val = part.split('=', 1)
            cookies[key.strip()] = val.strip()
    
    headers_base = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/fx/tools/flow',
    }
    
    # ===== BƯỚC 1: Lấy CSRF token =====
    resp = session.get(
        'https://labs.google/fx/api/auth/csrf',
        headers=headers_base,
        cookies=cookies
    )
    
    data = resp.json()
    csrf_token = data.get('csrfToken')
    if not csrf_token:
        raise Exception('CSRF token not found - cookie có thể đã die')
    
    print(f'[1] CSRF token: {csrf_token[:20]}...')
    
    # ===== BƯỚC 2: Sign in Google =====
    resp = session.post(
        'https://labs.google/fx/api/auth/signin/google',
        json={'callbackUrl': 'https://labs.google/fx/tools/flow'},
        headers={
            **headers_base,
            'X-CSRF-Token': csrf_token,
            'Content-Type': 'application/json',
        },
        cookies=cookies,
        allow_redirects=False
    )
    
    # Lấy redirect URL
    redirect_url = resp.headers.get('Location') or resp.json().get('url', '')
    if not redirect_url:
        raise Exception('Google auth URL not found - cookie die')
    
    print(f'[2] Redirect URL: {redirect_url[:60]}...')
    
    # ===== BƯỚC 3: Follow callback để lấy access_token =====
    resp = session.get(
        redirect_url,
        headers=headers_base,
        cookies=cookies,
        allow_redirects=True
    )
    
    # Extract access_token bằng regex
    match = re.search(r'"access_token":"([^"]+)"', resp.text)
    if not match:
        raise Exception('Failed to get access_token - cookie die')
    
    access_token = match.group(1)
    print(f'[3] Access token: {access_token[:30]}...')
    
    # ===== BƯỚC 4: Verify + tạo project =====
    resp = session.post(
        'https://labs.google/fx/api/trpc/project.createProject',
        json={
            'projectTitle': 'VEO AI AUTOMATION',
            'toolName': 'flow'
        },
        headers={
            **headers_base,
            'Authorization': f'Bearer {access_token}',
        },
        cookies=cookies
    )
    
    email = None
    project_id = None
    
    email_match = re.search(r'"email":"([^"]+)"', resp.text)
    if email_match:
        email = email_match.group(1)
    
    print(f'[4] Email: {email}')
    
    return {
        'access_token': access_token,
        'email': email,
        'project_id': project_id,
        'cookies': cookies
    }


def check_account_status(cookie_string: str) -> dict:
    """
    Check account status - Live hay Die
    """
    try:
        result = get_access_token_from_cookie(cookie_string)
        return {
            'status': 'live',
            'email': result['email'],
            'access_token': result['access_token']
        }
    except Exception as e:
        return {
            'status': 'die',
            'error': str(e)
        }


# ===== Dùng để generate video =====
def generate_veo_video(access_token: str, prompt: str, model: str = 'veo-3.1-generate-exp') -> str:
    """
    Generate video với Veo API dùng access_token
    """
    resp = requests.post(
        'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideo',
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json',
        },
        json={
            'instances': [{
                'prompt': prompt,
            }],
            'parameters': {
                'storageUri': 'gs://...',
                'sampleCount': 1,
                'model': model,
            }
        }
    )
    return resp.json()


# ===== USAGE =====
if __name__ == '__main__':
    # Copy cookie string từ browser DevTools → Application → Cookies → labs.google
    # Hoặc từ Network tab → copy request headers Cookie
    
    COOKIE_STRING = """
    __Secure-1PSID=xxx; __Secure-3PSID=xxx; SAPISID=xxx; 
    SID=xxx; HSID=xxx; SSID=xxx; APISID=xxx;
    """
    
    result = get_access_token_from_cookie(COOKIE_STRING)
    print('Access Token:', result['access_token'])
    print('Email:', result['email'])
```

---

## Cách lấy Cookie String từ Browser

### Cách 1: DevTools → Application
1. Mở `https://labs.google`
2. F12 → Application → Cookies → labs.google
3. Copy tất cả cookies dưới dạng string

### Cách 2: DevTools → Network
1. Mở `https://labs.google`
2. F12 → Network → chọn bất kỳ request
3. Request Headers → Copy giá trị `Cookie:`

### Cách 3: Extension EditThisCookie / Cookie-Editor
1. Install extension
2. Mở labs.google
3. Export cookies → JSON → convert sang string

---

## SNId Format (Grok accounts)

Từ screenshot thấy account có format `SNId=ABDP0S0eXCXKL4U897pdhj5OTIoT2AJ5I4zsH4FTyNm5n...`

Đây là session token của X.com (Twitter/Grok), dùng để auth với:
```
https://grok.com/rest/...
Headers:
  Cookie: auth_token=xxx; ct0=xxx; SNId=xxx
  X-CSRF-Token: <ct0 value>
```

---

## Cấu trúc Account Object

```typescript
// Veo Account (Google)
{
  id: string,
  type: "veo",
  email: string,
  cookie_string: string,     // raw cookie từ browser
  access_token: string,      // extracted từ cookie
  project_id: string,        // labs.google project
  credit: number,            // quota còn lại
  status: "live" | "die",
  proxy?: string             // http://user:pass@host:port
}

// Grok Account (X.com)
{
  id: string,
  type: "grok", 
  cookie_string: string,     // SNId=...; auth_token=...; ct0=...
  status: "live" | "die",
  credit: "N/A" | number,
  proxy?: string
}
```

---

## Status Detection Logic

```
Cookie Live:
  ✓ CSRF token returned successfully
  ✓ Google OAuth redirect received
  ✓ access_token extracted from callback
  ✓ project.createProject returns email

Cookie Die:
  ✗ CSRF request fails / returns 401
  ✗ No redirect URL in signin response  
  ✗ Response body contains "Cookie die"
  ✗ access_token regex không match
```
