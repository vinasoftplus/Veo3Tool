"""
Auto Login Service — dùng CloakBrowser để login Google → lấy cookie + token + project_id.

Flow:
  1. Mở CloakBrowser headless với profile riêng
  2. Navigate tới accounts.google.com/signin → điền email + password
  3. Xử lý 2FA nếu có (chờ user input qua callback)
  4. Navigate tới labs.google/fx/tools/flow → chờ load xong
  5. Lấy cookie google.com (COOKIE để refresh token)
  6. Lấy cookie labs.google (LABS_COOKIE để request trực tiếp)
  7. GET /fx/api/auth/session → lấy access_token
  8. POST /fx/api/trpc/project.createProject → lấy project_id
  9. Lưu vào account config
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any, Callable

from services.config_service import CLOAK_USER_DATA_ROOT

logger = logging.getLogger("auto_login")

GOOGLE_SIGN_IN = "https://accounts.google.com/signin/v2/identifier"
LABS_FLOW = "https://labs.google/fx/tools/flow"
LABS_SESSION = "https://labs.google/fx/api/auth/session"
LABS_CREATE_PROJECT = "https://labs.google/fx/api/trpc/project.createProject"
_LOGIN_COLS = 4
_LOGIN_WIN_W = 480
_LOGIN_WIN_H = 600

_VERIFY_TEXTS = [
    "verify it's you", "xác minh đây là bạn",
    "verify your identity", "xác minh danh tính của bạn", "xác minh danh tính",
    "phone number", "số điện thoại",
    "suspicious activity", "hoạt động đáng ngờ",
    "unusual activity", "hoạt động bất thường",
    "confirm it's you", "xác nhận đây là bạn",
    "2-step verification", "xác minh 2 bước",
    "enter the code", "nhập mã",
    "choose how you want to sign in", "chọn cách bạn muốn đăng nhập",
    "get a verification code", "nhận mã xác minh",
    "use another phone", "sử dụng một điện thoại",
    "try another way", "thử cách khác",
]

_INVALID_ACCOUNT_TEXTS = [
    "enter a valid email", "enter a valid email or phone",
    "nhập địa chỉ email hợp lệ", "địa chỉ email không hợp lệ",
    "couldn't find your google account",
    "could not find your google account",
    "no account found",
    "không tìm thấy tài khoản google",
    "couldn't sign you in",
    "could not sign you in",
    "google couldn't verify",
    "couldn't verify this account",
    "recover account",
    "account recovery",
    "không thể đăng nhập",
    "wrong password", "incorrect password",
    "that's an incorrect password",
    "password was changed", "password has been changed",
    "mật khẩu đã được thay đổi", "mật khẩu đã thay đổi",
    "sai mật khẩu", "mật khẩu không đúng",
    "account has been disabled",
    "this account has been suspended",
    "tài khoản đã bị vô hiệu hoá",
    "tài khoản đã bị tạm ngưng",
]


def _login_window_pos(slot: int) -> str:
    col = int(slot or 0) % _LOGIN_COLS
    row = int(slot or 0) // _LOGIN_COLS
    return f"--window-position={col * _LOGIN_WIN_W},{row * _LOGIN_WIN_H}"


def _profile_dir(index: int) -> Path:
    d = CLOAK_USER_DATA_ROOT / f"VEO_AUTO_{index + 1}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cookies_to_string(cookies: list[dict]) -> str:
    """Playwright cookie list → 'k=v; k2=v2' string."""
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def _filter_google_cookies(all_cookies: list[dict]) -> list[dict]:
    """
    Lọc Google cookie đúng cách như extension:
    chỉ lấy cookie có domain là 'google.com', '.google.com', 'www.google.com'.
    Không lấy accounts.google.com, mail.google.com, v.v.
    Loại bỏ duplicate (name + path).
    """
    allowed = {
        "google.com",
        ".google.com",
        "www.google.com",
        "accounts.google.com",
        ".accounts.google.com",
        "www.accounts.google.com",
    }
    seen: set[tuple] = set()
    result = []
    for c in all_cookies:
        domain = c.get("domain", "")
        if domain not in allowed:
            continue
        key = (c.get("name", ""), domain, c.get("path", ""))
        if key in seen:
            continue
        seen.add(key)
        result.append(c)
    return result


def _filter_labs_cookies(all_cookies: list[dict]) -> list[dict]:
    """
    Lọc Labs cookie: domain là 'labs.google' hoặc '.labs.google',
    cộng thêm các __Secure-next-auth* cookie.
    """
    by_name: dict[str, dict] = {}
    for c in all_cookies:
        domain = c.get("domain", "")
        name = c.get("name", "")
        if domain.lstrip(".") != "labs.google" or not name:
            continue
        current = by_name.get(name)
        if not current:
            by_name[name] = c
            continue
        if c.get("path", "/") == "/" or current.get("path", "/") != "/":
            by_name[name] = c
    return list(by_name.values())


async def _read_labs_session(page) -> dict[str, Any]:
    """Read Labs auth session from inside the Labs page context."""
    try:
        data = await page.evaluate(
            """async () => {
                const resp = await fetch('/fx/api/auth/session', {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' },
                });
                const text = await resp.text();
                return { ok: resp.ok, status: resp.status, text };
            }"""
        )
        if not data or not data.get("ok"):
            return {
                "ok": False,
                "status": data.get("status") if data else 0,
                "raw": data.get("text", "") if data else "",
            }
        return {"ok": True, "status": data.get("status"), "raw": data.get("text") or ""}
    except Exception as e:
        return {"ok": False, "status": 0, "raw": str(e)}


def _session_has_user(raw: str) -> bool:
    raw = (raw or "").strip()
    return bool(raw and raw != "{}" and ("access_token" in raw or "user" in raw or "email" in raw))


async def _check_google_login_failure(ctx) -> None:
    for pg in list(getattr(ctx, "pages", []) or []):
        if "google" not in (pg.url or "") and "accounts" not in (pg.url or ""):
            continue
        try:
            body_text = (await pg.evaluate("() => document.body?.innerText || ''")).lower()
        except Exception:
            continue
        matched_verify = next((kw for kw in _VERIFY_TEXTS if kw in body_text), None)
        if matched_verify:
            raise RuntimeError("VERIFY_REQUIRED")
        matched_invalid = next((kw for kw in _INVALID_ACCOUNT_TEXTS if kw in body_text), None)
        if matched_invalid:
            raise RuntimeError(f"INVALID_ACCOUNT: {matched_invalid}")


async def auto_login_google(
    email: str,
    password: str,
    account_index: int,
    log_cb: Callable[[str], None] | None = None,
    twofa_cb: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """
    Login Google bằng CloakBrowser, lấy cookie + token + project_id.

    Args:
        email: Google email
        password: Google password
        account_index: 0-based account index (để tạo profile riêng)
        log_cb: callback(msg) để stream log ra UI
        twofa_cb: async callback() để chờ user nhập 2FA (nếu có)

    Returns:
        {
            "ok": True,
            "cookie": str,        # google.com cookie string (để refresh token)
            "labs_cookie": str,   # labs.google cookie string
            "access_token": str,
            "project_id": str | None,
            "email": str,
        }
    """
    def log(msg: str):
        logger.info(msg)
        if log_cb:
            log_cb(msg)

    try:
        from cloakbrowser import launch_async
    except ImportError:
        raise RuntimeError("CloakBrowser chưa được cài. Hãy tải về trong tab Grok.")

    log(f"[1/6] Mở browser cho account #{account_index + 1}...")

    browser = await launch_async(
        headless=False,
        args=[
            _login_window_pos(account_index),
            f"--window-size={_LOGIN_WIN_W},{_LOGIN_WIN_H}",
            "--no-default-browser-check",
            "--no-first-run",
        ],
        stealth_args=True,
        humanize=False,
    )
    ctx = await browser.new_context(
        viewport={"width": _LOGIN_WIN_W, "height": _LOGIN_WIN_H},
    )
    try:
        # Always use a fresh page for this login job. Reusing an existing page
        # from a shared CloakBrowser instance can mix state between parallel jobs.
        page = await ctx.new_page()

        # ── Bước 1: Mở labs.google Flow → click "Create with Google Flow" ─────
        log("[1/6] Mở labs.google/fx/tools/flow...")
        await page.goto(LABS_FLOW, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)

        log("[1/6] Click 'Create with Google Flow'...")
        try:
            create_btn = page.locator("a:has-text('Create with Google Flow'), button:has-text('Create with Google Flow')")
            await create_btn.first.wait_for(state="visible", timeout=10000)
            await create_btn.first.click()
            await asyncio.sleep(3)
        except Exception as e:
            raise RuntimeError(f"Không tìm thấy nút 'Create with Google Flow': {e}")

        # ── Bước 2: Điền email (Google redirect sang trang login) ─────────────
        log(f"[2/6] Điền email: {email}")
        try:
            email_input = page.locator('input[type="email"]')
            await email_input.wait_for(state="visible", timeout=15000)
            await asyncio.sleep(0.5)
            await email_input.click()
            await asyncio.sleep(0.3)
            await email_input.fill(email)
            await asyncio.sleep(0.5)
            await page.keyboard.press("Enter")
            await asyncio.sleep(3)
            await _check_google_login_failure(ctx)
        except Exception as e:
            if isinstance(e, RuntimeError) and ("INVALID_ACCOUNT" in str(e) or "VERIFY_REQUIRED" in str(e)):
                raise
            raise RuntimeError(f"Không tìm thấy ô email: {e}")

        # ── Bước 3: Điền password ─────────────────────────────────────────────
        log("[3/6] Điền mật khẩu...")
        try:
            await page.wait_for_selector('input[type="password"]', state="visible", timeout=20000)
            pwd_input = page.locator('input[type="password"]').first
            await asyncio.sleep(0.5)
            await pwd_input.click()
            await asyncio.sleep(0.3)
            await pwd_input.fill(password)
            await asyncio.sleep(0.5)
            await page.keyboard.press("Enter")
            for _ in range(20):
                await asyncio.sleep(0.5)
                await _check_google_login_failure(ctx)
                if "labs.google" in (page.url or ""):
                    break
        except Exception as e:
            if isinstance(e, RuntimeError) and ("INVALID_ACCOUNT" in str(e) or "VERIFY_REQUIRED" in str(e)):
                raise
            raise RuntimeError(f"Không tìm thấy ô mật khẩu: {e}")

        # ── Bước 4: Xử lý 2FA / challenge ────────────────────────────────────
        current_url = page.url
        if "challenge" in current_url or "2fa" in current_url.lower() or "totp" in current_url.lower():
            log("[4/6] Phát hiện 2FA — chờ user xác nhận...")
            if twofa_cb:
                await twofa_cb()
            else:
                for _ in range(30):
                    await asyncio.sleep(2)
                    url = page.url
                    if "labs.google" in url or "myaccount.google.com" in url or "google.com/u/" in url:
                        break
                    if "challenge" not in url and "2fa" not in url.lower():
                        break

        # ── Bước 5: Chờ redirect về labs.google sau login ────────────────────
        log("[4/6] Chờ redirect về labs.google...")
        # Chờ vào được app (URL thay đổi hoặc nút New Project xuất hiện)
        for _ in range(60):
            await asyncio.sleep(1)
            await _check_google_login_failure(ctx)
            for pg in list(ctx.pages):
                try:
                    btn = pg.locator(
                        "button:has-text('Continue'), button:has-text('Tiếp tục'), "
                        "button:has-text('Confirm'), button:has-text('Allow'), button:has-text('Cho phép')"
                    ).first
                    if await btn.count():
                        await btn.click(timeout=2000)
                except Exception:
                    pass
            cur = page.url
            # Kiểm tra đã vào app chưa (có nút New Project). Nếu nút xuất hiện
            # sớm thì thoát sớm, còn account load chậm có tối đa 60s.
            np_btn = page.locator("button:has-text('New Project'), button:has-text('New project'), button:has-text('Dự án mới')")
            if "labs.google" in cur and await np_btn.count() > 0:
                break

        # ── Bước 6: Click New Project để lấy project_id ──────────────────────
        log("[5/6] Tạo project mới (click New Project)...")
        project_id = None
        try:
            np_btn = page.locator("button:has-text('New Project'), button:has-text('New project'), button:has-text('Dự án mới')").first
            await np_btn.wait_for(state="visible", timeout=60000)

            # Intercept network request để bắt project_id từ response API
            captured_project_id: list[str] = []

            async def capture_response(response):
                if "project" in response.url and response.status == 200:
                    try:
                        body = await response.text()
                        m = re.search(r'"(?:project_id|projectId)"\s*:\s*"([^"]+)"', body)
                        if m:
                            captured_project_id.append(m.group(1))
                    except Exception:
                        pass

            page.on("response", capture_response)
            await np_btn.click()
            await asyncio.sleep(4)  # chờ API response + redirect
            page.remove_listener("response", capture_response)

            if captured_project_id:
                project_id = captured_project_id[0]
                log(f"[5/6] Lấy được project_id từ API: {project_id}")
            else:
                # Fallback: lấy từ URL hiện tại nếu redirect vào /project/xxx
                cur_url = page.url
                m_url = re.search(r'/project/([a-zA-Z0-9_-]+)', cur_url)
                if m_url:
                    project_id = m_url.group(1)
                    log(f"[5/6] Lấy project_id từ URL: {project_id}")
        except Exception as e:
            log(f"[WARN] Click New Project thất bại: {e}")

        if not project_id:
            log("[5/6] Không bắt được project_id từ UI, tạo project qua API...")
            try:
                create_project = await page.evaluate(
                    """async () => {
                        const resp = await fetch('/fx/api/trpc/project.createProject', {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projectTitle: 'VEO AI AUTOMATION', toolName: 'flow' }),
                        });
                        const text = await resp.text();
                        return { ok: resp.ok, status: resp.status, text };
                    }"""
                )
                body = create_project.get("text", "") if create_project else ""
                m = re.search(r'"(?:project_id|projectId)"\s*:\s*"([^"]+)"', body)
                if m:
                    project_id = m.group(1)
                    log(f"[5/6] Lấy project_id từ API fallback: {project_id}")
                elif create_project and not create_project.get("ok"):
                    log(f"[WARN] project.createProject fallback HTTP {create_project.get('status')}")
            except Exception as e:
                log(f"[WARN] project.createProject fallback thất bại: {e}")

        # ── Bước 7: Lấy Google cookie (sau khi đã vào app + tạo project) ───────
        log("[6/6] Thu thập cookie...")
        all_cookies = await ctx.cookies()

        # Google cookie: chỉ domain google.com / .google.com (đúng như extension)
        google_cookies = _filter_google_cookies(all_cookies)
        # Labs cookie: lấy SAU KHI đã vào app và tạo project → đủ session cookie
        labs_cookies = _filter_labs_cookies(all_cookies)

        google_cookie_str = _cookies_to_string(google_cookies)
        labs_cookie_str = _cookies_to_string(labs_cookies)

        if not google_cookie_str:
            raise RuntimeError("Không lấy được cookie google.com — đăng nhập thất bại")

        log(f"[6/6] {len(google_cookies)} google cookies, {len(labs_cookies)} labs cookies")

        # ── Bước 8: Lấy access_token từ session API ───────────────────────────
        log("[6/6] Lấy access_token...")
        access_token = ""

        try:
            await page.goto(LABS_SESSION, wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(2)
            body = await page.content()
            m = re.search(r'"access_token"\s*:\s*"(ya29\.[^"]+)"', body)
            if m:
                access_token = m.group(1)
            if not project_id:
                m2 = re.search(r'"projectId"\s*:\s*"([^"]+)"', body)
                if m2:
                    project_id = m2.group(1)
        except Exception as e:
            log(f"[WARN] Lấy session API thất bại: {e}")

        # Fallback: dùng cookie_token_service
        # Re-read LABS_COOKIE after hitting the session endpoint. NextAuth can
        # rotate the session cookie there, and an empty "{}" session is not
        # valid for flow.createEntity.
        labs_cookie_str = ""
        try:
            session = await _read_labs_session(page)
            session_raw = session.get("raw", "")
            if _session_has_user(session_raw):
                labs_cookies = _filter_labs_cookies(await ctx.cookies("https://labs.google"))
                labs_cookie_str = _cookies_to_string(labs_cookies)
                log(f"[6/6] LABS_COOKIE active: {len(labs_cookies)} cookies")
            else:
                log("[WARN] LABS_COOKIE inactive: /fx/api/auth/session returned empty session")
        except Exception as e:
            log(f"[WARN] Validate LABS_COOKIE failed: {e}")

        if not access_token and google_cookie_str:
            log("[6/6] Fallback: dùng cookie để lấy token...")
            try:
                from services.cookie_token_service import get_token_from_cookie_sync
                result = get_token_from_cookie_sync(google_cookie_str, log=log)
                access_token = result.get("access_token", "")
                project_id = project_id or result.get("project_id")
            except Exception as e:
                log(f"[WARN] Fallback cookie→token thất bại: {e}")

        log(f"✅ Hoàn tất! Token: {access_token[:20] if access_token else 'N/A'}... | Project: {project_id}")

        return {
            "ok": True,
            "cookie": google_cookie_str,
            "labs_cookie": labs_cookie_str,
            "access_token": access_token,
            "project_id": project_id,
            "email": email,
        }

    finally:
        try:
            await ctx.close()
        except Exception:
            pass
        try:
            await browser.close()
        except Exception:
            pass
