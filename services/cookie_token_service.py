"""
Cookie → Token Service
Tự động lấy access_token từ Google cookie string theo flow labs.google
"""
from __future__ import annotations

import re
import asyncio
from typing import Any

import httpx


HEADERS_BASE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://labs.google",
    "Referer": "https://labs.google/fx/tools/flow",
}


def _parse_cookie_string(cookie_string: str) -> dict[str, str]:
    """Parse cookie string 'k1=v1; k2=v2' thành dict."""
    cookies: dict[str, str] = {}
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" in part:
            key, _, val = part.partition("=")
            cookies[key.strip()] = val.strip()
    return cookies


async def get_token_from_cookie(cookie_string: str, log=None) -> dict[str, Any]:
    """
    4-bước lấy access_token từ cookie Google.

    Returns:
        {
            "access_token": str,
            "email": str | None,
            "project_id": str | None,
            "cookie_string": str,   # raw cookie (giữ lại để reuse)
        }

    Raises:
        Exception với message mô tả lỗi cụ thể.
    """
    def _log(msg: str):
        if log:
            log(msg)

    cookies = _parse_cookie_string(cookie_string)
    if not cookies:
        raise ValueError("Cookie string trống hoặc không hợp lệ")

        # Cookie header string để gửi thủ công (tránh same-site restriction)
    cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())

    async with httpx.AsyncClient(
        timeout=30,
        follow_redirects=False,
        headers={**HEADERS_BASE, "Cookie": cookie_header},
    ) as client:

        # ── Bước 1: Lấy CSRF token ──────────────────────────────
        _log("[1/4] Lấy CSRF token...")
        try:
            resp1 = await client.get("https://labs.google/fx/api/auth/csrf")
        except Exception as e:
            raise ConnectionError(f"Không kết nối được labs.google: {e}")

        if resp1.status_code == 401:
            raise PermissionError("Cookie die — bị từ chối (401)")

        try:
            data1 = resp1.json()
        except Exception:
            raise ValueError("Phản hồi CSRF không phải JSON — cookie có thể die")

        csrf_token = data1.get("csrfToken")
        if not csrf_token:
            raise ValueError("CSRF token not found — cookie die hoặc chưa đăng nhập Google")

        _log(f"[1/4] CSRF OK: {csrf_token[:16]}...")

        # ── Bước 2: Sign in với Google OAuth ────────────────────
        _log("[2/4] Đang sign in Google OAuth...")
        headers2 = {
            **HEADERS_BASE,
            "X-CSRF-Token": csrf_token,
            "Content-Type": "application/json",
        }
        resp2 = await client.post(
            "https://labs.google/fx/api/auth/signin/google",
            json={"callbackUrl": "https://labs.google/fx/tools/flow"},
            headers=headers2,
        )

        # Lấy redirect URL từ Location header hoặc body JSON
        redirect_url = ""
        location = resp2.headers.get("location", "")
        if location:
            redirect_url = location
        else:
            try:
                body2 = resp2.json()
                redirect_url = body2.get("url", "")
            except Exception:
                pass

        if "Cookie die" in resp2.text:
            raise PermissionError("Cookie die — server báo lỗi")

        if not redirect_url:
            raise PermissionError(
                "Google auth URL not found — cookie die hoặc tài khoản chưa liên kết labs.google"
            )

        _log(f"[2/4] Redirect → {redirect_url[:80]}...")

        # ── Bước 3: Follow toàn bộ redirect chain → extract access_token ──
        _log("[3/4] Đang follow redirect chain lấy access_token...")

        # Dùng client mới với follow_redirects=True để follow hết chain
        # Gửi cookie dưới dạng header để bypass same-site restriction của httpx
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers={**HEADERS_BASE, "Cookie": cookie_header},
        ) as follow_client:
            resp3 = await follow_client.get(redirect_url)

        _log(f"[3/4] Final URL: {str(resp3.url)[:80]}...")

        if "Cookie die" in resp3.text:
            raise PermissionError("Cookie die — phát hiện ở bước callback")

        # Tìm access_token trong response body (JSON embedded)
        match = re.search(r'"access_token"\s*:\s*"([^"]+)"', resp3.text)
        if not match:
            # Thử tìm dạng URL param
            match = re.search(r'[?&#]access_token=([^&"\'<\s]+)', resp3.text)
        if not match:
            # Thử tìm trong URL hiện tại
            match = re.search(r'[?&#]access_token=([^&"\'<\s]+)', str(resp3.url))

        if not match:
            # Log thêm để debug
            _log(f"[3/4] Response status: {resp3.status_code}, length: {len(resp3.text)}")
            _log(f"[3/4] Body preview: {resp3.text[:200]}")
            raise ValueError(
                "Không lấy được access_token — thử truy cập labs.google trên trình duyệt rồi thử lại"
            )

        access_token = match.group(1)
        _log(f"[3/4] Access token: {access_token[:30]}...")

        # ── Bước 4: Verify account + lấy project_id ─────────────
        _log("[4/4] Xác nhận tài khoản và lấy project...")
        headers4 = {
            **HEADERS_BASE,
            "Cookie": cookie_header,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }
        resp4 = await client.post(
            "https://labs.google/fx/api/trpc/project.createProject",
            json={"projectTitle": "VEO AI AUTOMATION", "toolName": "flow"},
            headers=headers4,
            follow_redirects=True,
        )

        email: str | None = None
        project_id: str | None = None

        email_match = re.search(r'"email"\s*:\s*"([^"]+)"', resp4.text)
        if email_match:
            email = email_match.group(1)

        pid_match = re.search(r'"project_id"\s*:\s*"([^"]+)"', resp4.text)
        if pid_match:
            project_id = pid_match.group(1)

        if not email:
            # Vẫn OK nếu có access_token, project_id là bonus
            _log("[4/4] Không lấy được email nhưng token hợp lệ")
        else:
            _log(f"[4/4] Email: {email}, Project: {project_id}")

        return {
            "access_token": access_token,
            "email": email,
            "project_id": project_id,
            "cookie_string": cookie_string,
        }


async def check_cookie_status(cookie_string: str) -> dict[str, Any]:
    """
    Quick check: cookie live hay die?
    Returns { "live": bool, "email": str|None, "error": str|None }
    """
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
