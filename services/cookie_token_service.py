"""
Cookie → Token Service
Lấy access_token từ Google cookie string theo đúng flow đã test thành công.

Flow (bám sát test_cookie_chrome.py):
  1. Parse cookie string → list {name, value}
  2. Tạo requests.Session, set cookie cho cả .google.com và labs.google
  3. GET /fx/api/auth/csrf → lấy csrfToken
  4. POST /fx/api/auth/signin/google (form data) → nhận {"url":"https://accounts.google.com/..."}
  5. GET google OAuth URL với cookie google.com → redirect về labs.google/fx/tools/flow
  6. Extract access_token từ page source
  7. POST /fx/api/trpc/project.createProject → lấy email, project_id
"""
from __future__ import annotations

import re
import asyncio
from typing import Any

import requests
from requests import Session


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_cookies(cookie_string: str) -> list[dict[str, str]]:
    """Parse 'k1=v1; k2=v2' → [{"name": k, "value": v}, ...]"""
    result = []
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" in part:
            key, _, val = part.partition("=")
            result.append({"name": key.strip(), "value": val.strip()})
    return result


def _set_cookies_for_domain(session: Session, cookies: list[dict], domain: str):
    """Set cookies vào session cho một domain cụ thể."""
    count = 0
    for c in cookies:
        try:
            session.cookies.set(
                c["name"],
                c["value"],
                domain=domain,
                path="/",
            )
            count += 1
        except Exception:
            pass
    return count


HEADERS_BASE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://labs.google",
    "Referer": "https://labs.google/fx/tools/flow",
}


# ── Main function ─────────────────────────────────────────────────────────────

def get_token_from_cookie_sync(cookie_string: str, log=None) -> dict[str, Any]:
    """
    Lấy access_token từ cookie Google (sync, dùng requests.Session).

    Cookie string phải là cookie của accounts.google.com
    (có SID, SSID, HSID, SAPISID, __Secure-1PSID, __Secure-3PSID...).

    Returns:
        {"access_token": str, "email": str|None, "project_id": str|None, "cookie_string": str}

    Raises:
        ValueError / PermissionError / ConnectionError
    """
    def _log(msg: str):
        if log:
            log(msg)

    cookies = _parse_cookies(cookie_string)
    if not cookies:
        raise ValueError("Cookie string trống hoặc không hợp lệ")

    _log(f"[INFO] Parse được {len(cookies)} cookies: {[c['name'] for c in cookies[:6]]}...")

    session = Session()
    session.headers.update(HEADERS_BASE)

    # The saved cookie string has no domain metadata. Setting the same names on
    # multiple Google domains makes requests send duplicate Cookie headers and
    # Google redirects to the "clear cache & cookies" help page. Keep one copy
    # for the OAuth host and one copy for Labs.
    n1 = _set_cookies_for_domain(session, cookies, "accounts.google.com")
    n2 = _set_cookies_for_domain(session, cookies, "labs.google")
    _log(f"[INFO] Set {n1} cookies cho accounts.google.com, {n2} cho labs.google")

    # ── Bước 1: CSRF token ───────────────────────────────────────────────────
    _log("[1/4] Lấy CSRF token...")
    try:
        r1 = session.get("https://labs.google/fx/api/auth/csrf", timeout=20)
    except Exception as e:
        raise ConnectionError(f"Không kết nối được labs.google: {e}")

    if r1.status_code == 401:
        raise PermissionError("Cookie die — bị từ chối (401)")

    try:
        csrf_token = r1.json().get("csrfToken", "")
    except Exception:
        raise ValueError("Phản hồi CSRF không phải JSON — cookie có thể die")

    if not csrf_token:
        raise ValueError("CSRF token not found — cookie die hoặc chưa đăng nhập Google")

    _log(f"[1/4] CSRF OK: {csrf_token[:16]}...")

    # ── Bước 2: POST signin/google → lấy Google OAuth URL ───────────────────
    _log("[2/4] POST signin/google...")

    # Dùng form data + json=true field (bám sát flow test)
    r2 = session.post(
        "https://labs.google/fx/api/auth/signin/google",
        data={
            "callbackUrl": "https://labs.google/fx/tools/flow",
            "csrfToken": csrf_token,
            "json": "true",
        },
        headers={**HEADERS_BASE, "X-CSRF-Token": csrf_token},
        allow_redirects=False,
        timeout=20,
    )

    _log(f"[2/4] Status: {r2.status_code}, body: {r2.text[:150]}")

    # Parse Google OAuth URL từ JSON body
    google_oauth_url = ""
    try:
        body_json = r2.json()
        google_oauth_url = body_json.get("url", "")
    except Exception:
        pass

    if not google_oauth_url:
        m = re.search(r'"url"\s*:\s*"(https://accounts\.google\.com[^"]+)"', r2.text)
        if m:
            google_oauth_url = m.group(1).replace("\\u0026", "&").replace("\\/", "/")

    if not google_oauth_url:
        google_oauth_url = r2.headers.get("location", "")

    if not google_oauth_url:
        raise PermissionError(
            "Không lấy được Google OAuth URL — cookie die hoặc chưa liên kết labs.google"
        )

    google_oauth_url = google_oauth_url.replace("\\u0026", "&").replace("\\/", "/")
    _log(f"[2/4] Google OAuth URL: {google_oauth_url[:80]}...")

    # ── Bước 3: Follow Google OAuth → callback → access_token ───────────────
    _log("[3/4] Follow Google OAuth redirect chain...")

    try:
        r3 = session.get(
            google_oauth_url,
            allow_redirects=True,
            timeout=30,
        )
    except Exception as e:
        raise ConnectionError(f"Lỗi khi follow Google OAuth: {e}")

    _log(f"[3/4] Final URL: {r3.url}")
    _log(f"[3/4] Status: {r3.status_code}, len: {len(r3.text)}")

    # Tìm access_token
    access_token = None

    # 1. Trong final URL
    m = re.search(r'[?&#]access_token=(ya29\.[^&"\'<\s]+)', str(r3.url))
    if m:
        access_token = m.group(1)
        _log("[3/4] Token tìm thấy trong URL")

    # 2. Trong page source
    if not access_token:
        for pattern in [
            r'"access_token"\s*:\s*"(ya29\.[^"]+)"',
            r'"access_token"\s*:\s*"([^"]{20,})"',
            r'[?&#]access_token=(ya29\.[^&"\'<\s]+)',
        ]:
            m = re.search(pattern, r3.text)
            if m:
                access_token = m.group(1)
                _log("[3/4] Token tìm thấy trong page source")
                break

    # 3. Check redirect history
    if not access_token:
        for resp in r3.history:
            loc = resp.headers.get("location", "")
            m = re.search(r'[?&#]access_token=(ya29\.[^&"\'<\s]+)', loc)
            if m:
                access_token = m.group(1)
                _log(f"[3/4] Token tìm thấy trong redirect history")
                break

    if not access_token:
        _log(f"[3/4] Body preview: {r3.text[:400]}")
        raise ValueError(
            "Không lấy được access_token — cần cookie accounts.google.com còn sống"
        )

    _log(f"[3/4] Access token: {access_token[:30]}...")

    # ── Bước 4: Verify account + lấy email, project_id ──────────────────────
    _log("[4/4] Xác nhận tài khoản và lấy project...")

    r4 = session.post(
        "https://labs.google/fx/api/trpc/project.createProject",
        json={"projectTitle": "VEO AI AUTOMATION", "toolName": "flow"},
        headers={
            **HEADERS_BASE,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        timeout=20,
    )

    email: str | None = None
    project_id: str | None = None

    em = re.search(r'"email"\s*:\s*"([^"]+)"', r4.text)
    if em:
        email = em.group(1)

    pid = re.search(r'"project_id"\s*:\s*"([^"]+)"', r4.text)
    if pid:
        project_id = pid.group(1)

    if email:
        _log(f"[4/4] Email: {email}, Project: {project_id}")
    else:
        _log("[4/4] Token hợp lệ (không lấy được email)")

    return {
        "access_token": access_token,
        "email": email,
        "project_id": project_id,
        "cookie_string": cookie_string,
    }


# ── Async wrapper (cho FastAPI) ───────────────────────────────────────────────

async def get_token_from_cookie(cookie_string: str, log=None) -> dict[str, Any]:
    """Async wrapper chạy sync function trong thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: get_token_from_cookie_sync(cookie_string, log=log)
    )


async def check_cookie_status(cookie_string: str) -> dict[str, Any]:
    """Quick check: cookie live hay die?"""
    try:
        result = await get_token_from_cookie(cookie_string)
        return {
            "live": True,
            "email": result.get("email"),
            "access_token": result.get("access_token"),
            "project_id": result.get("project_id"),
        }
    except Exception as e:
        return {"live": False, "error": str(e)}
