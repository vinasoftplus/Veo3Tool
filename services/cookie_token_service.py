"""
Cookie -> Token Service
Tu dong lay access_token tu Google cookie string theo flow labs.google
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin

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
    """Parse cookie string 'k1=v1; k2=v2' thanh dict."""
    cookies: dict[str, str] = {}
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" in part:
            key, _, val = part.partition("=")
            cookies[key.strip()] = val.strip()
    return cookies


async def get_token_from_cookie(cookie_string: str, log=None) -> dict[str, Any]:
    """
    4-buoc lay access_token tu cookie Google.

    Returns:
        {
            "access_token": str,
            "email": str | None,
            "project_id": str | None,
            "cookie_string": str,
        }
    """
    def _log(msg: str):
        if log:
            log(msg)

    cookies = _parse_cookie_string(cookie_string)
    if not cookies:
        raise ValueError("Cookie string trong hoac khong hop le")

    cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())

    async with httpx.AsyncClient(
        timeout=30,
        follow_redirects=False,
        headers={**HEADERS_BASE, "Cookie": cookie_header},
    ) as client:
        client.cookies.update(cookies)

        _log("[1/4] Lay CSRF token...")
        try:
            resp1 = await client.get(
                "https://labs.google/fx/api/auth/csrf",
                headers={**HEADERS_BASE, "Cookie": cookie_header},
            )
        except Exception as e:
            raise ConnectionError(f"Khong ket noi duoc labs.google: {e}")

        if resp1.status_code == 401:
            raise PermissionError("Cookie die - bi tu choi (401)")

        try:
            data1 = resp1.json()
        except Exception:
            raise ValueError("Phan hoi CSRF khong phai JSON - cookie co the die")

        csrf_token = data1.get("csrfToken")
        if not csrf_token:
            raise ValueError("CSRF token not found - cookie die hoac chua dang nhap Google")

        _log(f"[1/4] CSRF OK: {csrf_token[:16]}...")

        _log("[2/4] Dang sign in Google OAuth...")
        headers2 = {
            **HEADERS_BASE,
            "Cookie": cookie_header,
            "Content-Type": "application/x-www-form-urlencoded",
        }
        resp2 = await client.post(
            "https://labs.google/fx/api/auth/signin/google",
            data={
                "csrfToken": csrf_token,
                "callbackUrl": "https://labs.google/fx/tools/flow",
                "json": "true",
            },
            headers=headers2,
        )

        redirect_url = ""
        location = resp2.headers.get("location", "")
        if location:
            redirect_url = urljoin("https://labs.google", location)
        else:
            try:
                body2 = resp2.json()
                redirect_url = urljoin("https://labs.google", body2.get("url", "")) if body2.get("url") else ""
            except Exception:
                pass

        if "Cookie die" in resp2.text:
            raise PermissionError("Cookie die - server bao loi")

        if not redirect_url:
            _log(f"[2/4] Signin status: {resp2.status_code}")
            _log(f"[2/4] Headers: {dict(resp2.headers)}")
            _log(f"[2/4] Body preview: {resp2.text[:300]}")
            raise PermissionError(
                "Google auth URL not found - cookie die hoac tai khoan chua lien ket labs.google"
            )

        _log(f"[2/4] Signin status: {resp2.status_code}")
        _log(f"[2/4] Location: {location[:200] if location else '(none)'}")
        _log(f"[2/4] Redirect -> {redirect_url[:120]}...")

        _log("[3/4] Dang follow redirect chain lay access_token...")
        async with httpx.AsyncClient(
            timeout=30,
            follow_redirects=True,
            headers={**HEADERS_BASE, "Cookie": cookie_header},
        ) as follow_client:
            follow_client.cookies.update(cookies)
            resp3 = await follow_client.get(
                redirect_url,
                headers={**HEADERS_BASE, "Cookie": cookie_header},
            )

        _log(f"[3/4] Final URL: {str(resp3.url)[:120]}...")

        if "Cookie die" in resp3.text:
            raise PermissionError("Cookie die - phat hien o buoc callback")

        match = re.search(r'"access_token"\s*:\s*"([^"]+)"', resp3.text)
        if not match:
            match = re.search(r"[?&#]access_token=([^&\"'<>\\s]+)", resp3.text)
        if not match:
            match = re.search(r"[?&#]access_token=([^&\"'<>\\s]+)", str(resp3.url))

        if not match:
            _log(f"[3/4] Response status: {resp3.status_code}, length: {len(resp3.text)}")
            _log(f"[3/4] Body preview: {resp3.text[:300]}")
            raise ValueError(
                "Khong lay duoc access_token - thu truy cap labs.google tren trinh duyet roi thu lai"
            )

        access_token = match.group(1)
        _log(f"[3/4] Access token: {access_token[:30]}...")

        _log("[4/4] Xac nhan tai khoan va lay project...")
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
        if not pid_match:
            pid_match = re.search(r'"projectId"\s*:\s*"([^"]+)"', resp4.text)
        if pid_match:
            project_id = pid_match.group(1)

        if not email:
            _log("[4/4] Khong lay duoc email nhung token hop le")
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
