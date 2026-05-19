from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import mimetypes
import socket
import subprocess
import re
import time
import uuid
from pathlib import Path
from typing import Any

import random
import string

import httpx

from services.config_service import CHROME_USER_DATA_ROOT, CLOAK_USER_DATA_ROOT, load_config, save_config


GROK_ORIGIN = "https://grok.com"
GROK_IMAGINE = "https://grok.com/imagine"
GROK_SIGN_IN = "https://accounts.x.ai/sign-in?redirect=grok-com&return_to=%2Fimagine"
GROK_ASSETS = "https://assets.grok.com"
GROK_PUBLIC_IMAGES = "https://imagine-public.x.ai/imagine-public/images"

UPLOAD_URL = "https://grok.com/rest/app-chat/upload-file"
POST_CREATE_URL = "https://grok.com/rest/media/post/create"
CONVERSATION_URL = "https://grok.com/rest/app-chat/conversations/new"
RATE_LIMITS_URL = "https://grok.com/rest/rate-limits"
SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions"
WS_IMAGINE_URL = "wss://grok.com/ws/imagine/listen"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/143.0.0.0 Safari/537.36"
)
_PROFILE_CDP_PORTS: dict[str, int] = {}
# Keeps a persistent browser tab open per profile for CDP fetch calls
_PROFILE_GROK_TABS: dict[str, int] = {}  # profile -> cdp port

# CloakBrowser persistent contexts keyed by profile name
_CLOAK_CONTEXTS: dict[str, Any] = {}  # profile -> BrowserContext
_CLOAK_LAUNCH_LOCKS: dict[str, asyncio.Lock] = {}  # profile -> launch lock
_CLOAK_NAV_LOCKS: dict[str, asyncio.Lock] = {}  # profile -> navigate lock

# Tracks which profiles have completed first-launch warm-up
_PROFILE_READY: set[str] = set()

_CLOAK_AVAILABLE: bool | None = None  # None = not checked yet


def cloak_browser_installed() -> bool:
    """Check if CloakBrowser binary already exists on disk (no download needed)."""
    try:
        from cloakbrowser.config import get_binary_path, get_effective_version
        return get_binary_path(get_effective_version()).exists()
    except Exception:
        pass
    # Fallback for bundled exe where cloakbrowser package may not be available:
    # scan ~/.cloakbrowser/ for any chrome.exe
    try:
        cloak_dir = Path.home() / ".cloakbrowser"
        return any(cloak_dir.glob("*/chrome.exe"))
    except Exception:
        return False


async def ensure_cloak_browser(progress_cb=None) -> None:
    """Ensure CloakBrowser binary is downloaded. Calls progress_cb(pct, msg) during download.
    Patches cloakbrowser logger to intercept progress lines."""
    import logging as _logging

    if cloak_browser_installed():
        if progress_cb:
            await progress_cb(100, "CloakBrowser đã sẵn sàng")
        return

    if progress_cb:
        await progress_cb(0, "Đang tải CloakBrowser (~300MB), vui lòng chờ...")

    class _ProgressHandler(_logging.Handler):
        def emit(self, record):
            msg = record.getMessage()
            if "Download progress:" in msg:
                try:
                    pct = int(msg.split("%")[0].split()[-1])
                    asyncio.get_event_loop().call_soon_threadsafe(
                        asyncio.ensure_future,
                        progress_cb(pct, f"Đang tải CloakBrowser... {pct}%")
                    )
                except Exception:
                    pass
            elif "Download complete" in msg or "Binary ready" in msg:
                asyncio.get_event_loop().call_soon_threadsafe(
                    asyncio.ensure_future,
                    progress_cb(95, "Đang giải nén...")
                )

    try:
        from cloakbrowser.download import ensure_binary
    except ImportError:
        if progress_cb:
            await progress_cb(-1, "Không thể tải CloakBrowser: package cloakbrowser không có trong bản exe này. Vui lòng chạy bản Python.")
        return

    handler = _ProgressHandler()
    cloak_logger = _logging.getLogger("cloakbrowser")
    cloak_logger.addHandler(handler)
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, ensure_binary)
    finally:
        cloak_logger.removeHandler(handler)

    if progress_cb:
        await progress_cb(100, "CloakBrowser sẵn sàng!")


def _cloak_available() -> bool:
    global _CLOAK_AVAILABLE
    if _CLOAK_AVAILABLE is None:
        try:
            import cloakbrowser  # noqa: F401
            _CLOAK_AVAILABLE = True
        except ImportError:
            _CLOAK_AVAILABLE = False
    return bool(_CLOAK_AVAILABLE)


# CloakBrowser hidden-window args: position far off-screen, 1x1 pixel
_CLOAK_HIDDEN_ARGS = [
    "--window-position=-32000,-32000",
    "--window-size=1,1",
    "--disable-popup-blocking",
    "--no-default-browser-check",
    "--no-first-run",
]


class GrokError(RuntimeError):
    pass


def _find_chromium_executable() -> str | None:
    candidates = [
        Path(__file__).resolve().parent.parent / "chrome" / "143" / "chrome.exe",
        Path.home() / "AppData" / "Local" / "DgtAutoGenerateVideoAI" / "data" / "chrome" / "143" / "chrome.exe",
        Path.home() / "AppData" / "Local" / "DgtAutoGenerateVideoAI" / "data" / "chrome" / "147" / "chrome.exe",
        Path(__file__).resolve().parent.parent / "chrome" / "147" / "chrome.exe",
        Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _profile_dir(profile: str, cloak: bool = False) -> Path:
    root = CLOAK_USER_DATA_ROOT if cloak else CHROME_USER_DATA_ROOT
    path = root / str(profile)
    path.mkdir(parents=True, exist_ok=True)
    return path


async def _wait_cdp(port: int, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/json/version"
    while time.monotonic() < deadline:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                res = await client.get(url)
            if res.status_code == 200:
                return
        except Exception:
            pass
        await asyncio.sleep(0.4)
    raise GrokError(f"Không kết nối được Brave CDP port {port}")


async def _get_cdp_pages(port: int) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=5) as client:
        res = await client.get(f"http://127.0.0.1:{port}/json/list")
    if res.status_code != 200:
        raise GrokError(f"Không lấy được /json/list từ Chrome CDP: HTTP {res.status_code}")
    data = res.json()
    return data if isinstance(data, list) else []


async def _get_page_ws_url(port: int, prefer_url: str | None = None) -> str:
    """Get WebSocket URL for a CDP page tab.
    If prefer_url given, prefer the tab whose URL starts with it (e.g. grok.com/imagine after CF pass).
    Falls back to first available page tab.
    """
    pages = await _get_cdp_pages(port)
    page_tabs = [p for p in pages if p.get("type") == "page" and p.get("webSocketDebuggerUrl")]
    if not page_tabs:
        raise GrokError("Không lấy được webSocketDebuggerUrl từ Chrome CDP")
    if prefer_url:
        for p in page_tabs:
            if str(p.get("url", "")).startswith(prefer_url):
                return str(p["webSocketDebuggerUrl"])
    return str(page_tabs[0]["webSocketDebuggerUrl"])


class _CdpPage:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self.ws = None
        self._next_id = 0

    async def __aenter__(self):
        import websockets

        self.ws = await websockets.connect(self.ws_url, open_timeout=10, close_timeout=5, max_size=32 * 1024 * 1024)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.ws:
            with contextlib.suppress(Exception):
                await self.ws.close()

    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 20.0) -> dict[str, Any]:
        if not self.ws:
            raise GrokError("CDP chưa kết nối")
        self._next_id += 1
        msg_id = self._next_id
        await self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}, separators=(",", ":")))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=max(0.2, deadline - time.monotonic()))
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("id") != msg_id:
                continue
            if "error" in msg:
                raise GrokError(f"CDP {method} lỗi: {msg['error']}")
            result = msg.get("result")
            return result if isinstance(result, dict) else {}
        raise GrokError(f"Timeout CDP {method}")

    async def evaluate(self, expression: str, timeout: float = 20.0) -> Any:
        result = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
            timeout=timeout,
        )
        remote = result.get("result") or {}
        return remote.get("value")

    async def navigate(self, url: str) -> None:
        await self.call("Page.enable")
        await self.call("Runtime.enable")
        await self.call("Page.navigate", {"url": url}, timeout=15)

    async def cookies(self) -> list[dict[str, Any]]:
        await self.call("Network.enable")
        result = await self.call("Network.getAllCookies")
        cookies = result.get("cookies")
        return cookies if isinstance(cookies, list) else []


async def _navigate_existing_tab(port: int, url: str) -> None:
    ws_url = await _get_page_ws_url(port)
    async with _CdpPage(ws_url) as cdp:
        await cdp.navigate(url)


def _kill_chromium_holding_profile(user_data_dir: Path) -> None:
    """Kill any Chromium/Chrome process holding this user-data-dir lock (Windows, no psutil)."""
    target = str(user_data_dir).lower().replace("/", "\\")
    try:
        result = subprocess.run(
            ["wmic", "process", "where", "name like '%chrome%'", "get", "ProcessId,CommandLine", "/format:csv"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            if target not in line.lower():
                continue
            parts = line.strip().split(",")
            # csv format: Node,CommandLine,ProcessId
            pid_str = parts[-1].strip()
            if pid_str.isdigit():
                subprocess.run(["taskkill", "/F", "/PID", pid_str], capture_output=True, timeout=3)
    except Exception:
        pass


async def _get_or_launch_cloak_context(profile: str) -> Any:
    """Return a live CloakBrowser persistent context for the profile, launching if needed.
    Per-profile lock prevents concurrent launch of same user-data-dir."""
    # Fast path: context already alive
    ctx = _CLOAK_CONTEXTS.get(profile)
    if ctx is not None:
        try:
            ctx.pages  # liveness check
            return ctx
        except Exception:
            _CLOAK_CONTEXTS.pop(profile, None)

    # Slow path: need to launch — serialize per profile
    if profile not in _CLOAK_LAUNCH_LOCKS:
        _CLOAK_LAUNCH_LOCKS[profile] = asyncio.Lock()
    async with _CLOAK_LAUNCH_LOCKS[profile]:
        # Re-check after acquiring lock (another coroutine may have launched)
        ctx = _CLOAK_CONTEXTS.get(profile)
        if ctx is not None:
            try:
                ctx.pages  # liveness check
                return ctx
            except Exception:
                _CLOAK_CONTEXTS.pop(profile, None)

        from cloakbrowser import launch_persistent_context_async

        user_data_dir = _profile_dir(profile, cloak=True)

        # Kill any orphan Chromium processes holding this profile's lock file.
        # This happens after server restart: in-memory context is gone but Chrome is still running.
        _kill_chromium_holding_profile(user_data_dir)

        ctx = await launch_persistent_context_async(
            user_data_dir=str(user_data_dir),
            headless=False,
            args=_CLOAK_HIDDEN_ARGS,
            stealth_args=True,
            humanize=False,
        )
        _CLOAK_CONTEXTS[profile] = ctx
        return ctx


async def _cloak_get_page(profile: str, url: str | None = None) -> Any:
    """Get the first page in the CloakBrowser context, optionally navigating."""
    ctx = await _get_or_launch_cloak_context(profile)
    pages = ctx.pages
    if not pages:
        raise GrokError("CloakBrowser context không có page — context đã chết")
    page = pages[0]
    if url:
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    return page


async def _ensure_grok_tab(profile: str) -> int:
    """Ensure a browser tab is open at grok.com for the given profile. Returns CDP port.
    Falls back to legacy Chrome CDP if CloakBrowser is not available."""
    if _cloak_available():
        # CloakBrowser path — ensure context is alive, return 0 as sentinel (unused)
        await _get_or_launch_cloak_context(profile)
        return 0

    port = _PROFILE_GROK_TABS.get(profile)
    if port:
        try:
            await _wait_cdp(port, timeout=2.0)
            return port
        except Exception:
            _PROFILE_GROK_TABS.pop(profile, None)

    opened = await open_grok_profile(profile, GROK_IMAGINE)
    port = int(opened["port"])
    await asyncio.sleep(5.0)
    _PROFILE_GROK_TABS[profile] = port
    return port


async def _ensure_grok_page(profile: str) -> Any:
    """Ensure CloakBrowser has a page open at grok.com. Auto-relaunches if context was closed.
    Navigation is serialized per-profile so concurrent jobs don't race on the same page."""
    if profile not in _CLOAK_NAV_LOCKS:
        _CLOAK_NAV_LOCKS[profile] = asyncio.Lock()

    for attempt in range(2):
        try:
            ctx = await _get_or_launch_cloak_context(profile)
            pages = ctx.pages
            if not pages:
                raise RuntimeError("context has no pages")
            page = pages[0]

            # Serialize navigation: only 1 coroutine navigates at a time
            async with _CLOAK_NAV_LOCKS[profile]:
                url = page.url or ""
                if not url.startswith("https://grok.com"):
                    await page.goto(GROK_IMAGINE, wait_until="domcontentloaded", timeout=60000)
                    if profile not in _PROFILE_READY:
                        await asyncio.sleep(3.0)
                        _PROFILE_READY.add(profile)

            return page
        except Exception:
            # Context closed — clear cache and retry with fresh launch
            _CLOAK_CONTEXTS.pop(profile, None)
            _PROFILE_READY.discard(profile)
            if attempt == 1:
                raise
    raise GrokError("Không thể khởi động CloakBrowser")


async def _cdp_post(profile: str, url: str, headers: dict[str, str], payload: dict[str, Any], *, timeout: int = 300) -> tuple[int, str, str]:
    """POST via browser fetch() — uses CloakBrowser if available, else legacy Chrome CDP.

    When CloakBrowser is active:
    - drops explicit Cookie/Authorization headers (browser owns them)
    - uses credentials: 'include' so __cf_bm is auto-attached by browser
    """
    body_str = json.dumps(payload)

    if _cloak_available():
        # Strip headers that conflict with browser-owned cookies/auth
        safe_headers = {k: v for k, v in headers.items() if k.lower() not in ("cookie", "authorization")}
        headers_json = json.dumps(safe_headers)
        body_json = json.dumps(body_str)
        script = f"""
(async () => {{
  try {{
    const res = await fetch({json.dumps(url)}, {{
      method: 'POST',
      headers: {headers_json},
      body: {body_json},
      credentials: 'include',
    }});
    const text = await res.text();
    return {{ status: res.status, ct: res.headers.get('content-type') || '', body: text }};
  }} catch(e) {{
    return {{ status: 0, ct: '', body: e.toString() }};
  }}
}})()
"""
        page = await _ensure_grok_page(profile)
        result = await page.evaluate(script)
    else:
        headers_json = json.dumps(headers)
        body_json = json.dumps(body_str)
        script = f"""
(async () => {{
  try {{
    const res = await fetch({json.dumps(url)}, {{
      method: 'POST',
      headers: {headers_json},
      body: {body_json},
      credentials: 'include',
    }});
    const text = await res.text();
    return {{ status: res.status, ct: res.headers.get('content-type') || '', body: text }};
  }} catch(e) {{
    return {{ status: 0, ct: '', body: e.toString() }};
  }}
}})()
"""
        port = await _ensure_grok_tab(profile)
        ws_url = await _get_page_ws_url(port)
        async with _CdpPage(ws_url) as cdp:
            result = await cdp.evaluate(script, timeout=timeout)

    if not isinstance(result, dict):
        raise GrokError(f"CDP fetch không trả kết quả hợp lệ: {result}")
    status = int(result.get("status") or 0)
    if status == 0:
        raise GrokError(f"CDP fetch lỗi: {result.get('body', '')}")
    return status, str(result.get("ct") or ""), str(result.get("body") or "")


async def _legacy_open_grok_profile(profile: str, url: str = GROK_IMAGINE) -> dict[str, Any]:
    executable = _find_chromium_executable()
    if not executable:
        raise GrokError("Không tìm thấy brave.exe")
    existing_port = _PROFILE_CDP_PORTS.get(profile)
    if existing_port:
        try:
            await _wait_cdp(existing_port, timeout=2.0)
            return {"ok": True, "profile": profile, "port": existing_port, "reused": True}
        except Exception:
            _PROFILE_CDP_PORTS.pop(profile, None)

    port = _find_free_port()
    user_data_dir = _profile_dir(profile)
    subprocess.Popen(
        [
            executable,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={str(user_data_dir)}",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-position=0,0",
            "--window-size=960,700",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    await _wait_cdp(port)
    _PROFILE_CDP_PORTS[profile] = port
    return {"ok": True, "profile": profile, "port": port}


async def open_grok_profile(profile: str, url: str = GROK_IMAGINE) -> dict[str, Any]:
    executable = _find_chromium_executable()
    if not executable:
        raise GrokError("Không tìm thấy chrome.exe bản 143")
    existing_port = _PROFILE_CDP_PORTS.get(profile)
    if existing_port:
        try:
            await _wait_cdp(existing_port, timeout=2.0)
            if url:
                with contextlib.suppress(Exception):
                    await _navigate_existing_tab(existing_port, url)
            return {"ok": True, "profile": profile, "port": existing_port, "reused": True}
        except Exception:
            _PROFILE_CDP_PORTS.pop(profile, None)

    port = _find_free_port()
    user_data_dir = _profile_dir(profile)
    subprocess.Popen(
        [
            executable,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={str(user_data_dir)}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-popup-blocking",
            "--window-position=0,0",
            "--window-size=960,700",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    await _wait_cdp(port)
    _PROFILE_CDP_PORTS[profile] = port
    return {"ok": True, "profile": profile, "port": port}


def _gen_statsig_id() -> str:
    """Generate x-statsig-id: base64(JS TypeError error message) — matches Grok's anti-bot expectation."""
    if random.choice([True, False]):
        rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
        msg = f"e:TypeError: Cannot read properties of null (reading 'children[\\'{rand}\\']')"
    else:
        rand = "".join(random.choices(string.ascii_lowercase, k=10))
        msg = f"e:TypeError: Cannot read properties of undefined (reading '{rand}')"
    return base64.b64encode(msg.encode()).decode()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _parse_cookie(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in str(raw or "").replace("\r", "").replace("\n", "").split(";"):
        if "=" not in part:
            continue
        key, val = part.split("=", 1)
        key = key.strip()
        if key:
            out[key] = val.strip()
    return out


def mask_cookie(raw: str) -> str:
    def repl(match: re.Match[str]) -> str:
        value = match.group(2)
        masked = "***" if len(value) <= 8 else f"{value[:4]}...{value[-4:]}({len(value)})"
        return f"{match.group(1)}={masked}"

    return re.sub(
        r"(auth_token|ct0|SNId|sso|sso-rw|x-userid|x-anonuserid|x-challenge|x-signature|cf_clearance|__cf_bm)=([^;\s]+)",
        repl,
        str(raw or ""),
    )


_GROK_DOMAINS = ("grok.com", "x.ai", "grokipedia.com", "grokusercontent.com")
_GROK_REQUIRED_COOKIE_GROUPS = (
    ("cf_clearance",),
    ("sso", "sso-rw", "auth_token"),
)

_GROK_MANUAL_REQUIRED_GROUPS = _GROK_REQUIRED_COOKIE_GROUPS


def _cookie_is_expired(item: dict[str, Any]) -> bool:
    try:
        expires = float(item.get("expires", -1))
    except Exception:
        return False
    return expires > 0 and expires <= time.time()


def _cookie_list_to_header(cookies: list[dict[str, Any]], domain_filter: str = "grok.com") -> str:
    """Build Cookie header string from CDP cookie list, filtered by domain."""
    pairs = []
    for item in cookies or []:
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "").strip()
        domain = str(item.get("domain") or "")
        if name and value and domain_filter in domain and not _cookie_is_expired(item):
            pairs.append(f"{name}={value}")
    return "; ".join(pairs)


def _cookie_list_to_header_all(cookies: list[dict[str, Any]]) -> str:
    """Build Cookie header for grok.com combining all relevant domains."""
    seen: dict[str, str] = {}
    # Priority order: grok.com first, then x.ai (grok.com cookies override)
    for target in ("x.ai", "grokipedia.com", "grokusercontent.com", "grok.com"):
        for item in cookies or []:
            name = str(item.get("name") or "").strip()
            value = str(item.get("value") or "").strip()
            domain = str(item.get("domain") or "")
            if name and value and target in domain and not _cookie_is_expired(item):
                seen[name] = value
    return "; ".join(f"{k}={v}" for k, v in seen.items())


def _cookie_json_to_header(cookie_json: list[dict[str, Any]]) -> str:
    """Convert stored JSON cookie array → Cookie header string for grok.com requests."""
    seen: dict[str, str] = {}
    for target in ("x.ai", "grokipedia.com", "grokusercontent.com", "grok.com"):
        for item in cookie_json or []:
            name = str(item.get("name") or "").strip()
            value = str(item.get("value") or "").strip()
            domain = str(item.get("domain") or "")
            if name and value and target in domain and not _cookie_is_expired(item):
                seen[name] = value
    return "; ".join(f"{k}={v}" for k, v in seen.items())


def _missing_grok_cookie_names(cookie_header: str) -> list[str]:
    cookie_map = _parse_cookie(cookie_header)
    missing = []
    for group in _GROK_REQUIRED_COOKIE_GROUPS:
        if not any(cookie_map.get(name) for name in group):
            missing.append("/".join(group))
    return missing


def _is_grok_cookie_valid(cookie_header: str) -> bool:
    return bool(cookie_header) and not _missing_grok_cookie_names(cookie_header)


def _asset_url(path_or_url: str, *, download: bool = False) -> str:
    value = str(path_or_url or "").strip()
    if not value:
        return ""
    if value.startswith("http://") or value.startswith("https://"):
        return value
    url = f"{GROK_ASSETS}/{value.lstrip('/')}"
    if download:
        sep = "&" if "?" in url else "?"
        url += f"{sep}cache=1&dl=1"
    return url


def _json_objects_from_text(text: str) -> list[dict[str, Any]]:
    decoder = json.JSONDecoder()
    idx = 0
    out: list[dict[str, Any]] = []
    while idx < len(text):
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        if text[idx] != "{":
            idx += 1
            continue
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            idx += 1
            continue
        if isinstance(obj, dict):
            out.append(obj)
        idx = end
    return out


def _deep_find(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for val in obj.values():
            found = _deep_find(val, key)
            if found not in (None, ""):
                return found
    elif isinstance(obj, list):
        for val in obj:
            found = _deep_find(val, key)
            if found not in (None, ""):
                return found
    return None


def _progress_from_event(obj: dict[str, Any], response_key: str) -> tuple[int, dict[str, Any]]:
    node = _deep_find(obj, response_key)
    if isinstance(node, dict):
        progress = node.get("progress")
        if progress is None:
            progress = node.get("percentage_complete")
        try:
            return int(progress or 0), node
        except Exception:
            return 0, node
    return 0, {}


def load_grok_accounts() -> list[dict[str, Any]]:
    cfg = load_config()
    accounts = cfg.get("grok_accounts") or []
    if not isinstance(accounts, list):
        return []
    return [dict(a) for a in accounts]


def save_grok_accounts(accounts: list[dict[str, Any]]) -> None:
    cfg = load_config()
    cfg["grok_accounts"] = accounts
    save_config(cfg)


def _acc_has_cookie(acc: dict[str, Any]) -> bool:
    return _is_grok_cookie_valid(_acc_cookie_header(acc))


def _acc_cookie_header(acc: dict[str, Any]) -> str:
    """Return Cookie header string from account, supporting both JSON array and string format."""
    c = acc.get("cookie")
    if isinstance(c, list):
        return _cookie_json_to_header(c)
    return str(c or "")


def public_grok_accounts() -> list[dict[str, Any]]:
    safe = []
    for idx, acc in enumerate(load_grok_accounts()):
        cookie_str = _acc_cookie_header(acc)
        safe.append(
            {
                "index": idx,
                "email": acc.get("email") or "",
                "enabled": bool(acc.get("enabled", True)),
                "profile": acc.get("profile") or f"GROK_{idx + 1}",
                "cookie_mask": mask_cookie(cookie_str) if cookie_str else "",
                "has_cookie": _acc_has_cookie(acc),
                "missing_cookie": ", ".join(_missing_grok_cookie_names(cookie_str)) if cookie_str else "",
                "last_login": acc.get("last_login") or "",
                "last_error": acc.get("last_error") or "",
            }
        )
    return safe


def pick_account(index: int | None = None) -> tuple[int, dict[str, Any]]:
    accounts = load_grok_accounts()
    if index is not None and 0 <= index < len(accounts):
        acc = accounts[index]
        if _acc_has_cookie(acc):
            return index, acc
    for idx, acc in enumerate(accounts):
        if acc.get("enabled", True) and _acc_has_cookie(acc):
            return idx, acc
    raise GrokError("Chưa có tài khoản Grok đã login/cookie hợp lệ")


class GrokClient:
    def __init__(self, account: dict[str, Any]):
        self.account = account
        self.profile = str(account.get("profile") or "")
        self.cookie = _acc_cookie_header(account)
        if not self.cookie:
            raise GrokError("Tài khoản Grok chưa có cookie")
        self.cookie_map = _parse_cookie(self.cookie)
        missing = _missing_grok_cookie_names(self.cookie)
        if missing:
            raise GrokError("Cookie Grok thieu anti-bot/session: " + ", ".join(missing) + ". Hay login lai tai khoan Grok.")
        self.statsig_id = str(account.get("statsig_id") or "")

    def headers(self, *, json_content: bool = True, referer: str = GROK_IMAGINE) -> dict[str, str]:
        _ver_match = re.search(r"Chrome/(\d+)", DEFAULT_UA)
        _ver = _ver_match.group(1) if _ver_match else "136"
        headers = {
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "en-US,en;q=0.9",
            "Baggage": "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
            "Origin": GROK_ORIGIN,
            "Priority": "u=1, i",
            "Referer": referer,
            "Sec-Ch-Ua": f'"Google Chrome";v="{_ver}", "Chromium";v="{_ver}", "Not(A:Brand";v="24"',
            "Sec-Ch-Ua-Arch": "x86",
            "Sec-Ch-Ua-Bitness": "64",
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Model": "",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "User-Agent": DEFAULT_UA,
            "Cookie": self.cookie,
            "x-statsig-id": _gen_statsig_id(),
            "x-xai-request-id": str(uuid.uuid4()),
        }
        if json_content:
            headers["Content-Type"] = "application/json"
        return headers

    async def _request(self, method: str, url: str, *, payload: dict[str, Any] | None = None, timeout: int = 180, referer: str = GROK_IMAGINE) -> tuple[int, str, str]:
        # Use CloakBrowser (same TLS fingerprint as login) — launch context if needed
        if _cloak_available() and self.profile:
            hdrs = self.headers(json_content=(method.upper() != "GET"), referer=referer)
            safe_hdrs = {k: v for k, v in hdrs.items() if k.lower() not in ("cookie", "authorization")}
            return await _cdp_post(self.profile, url, safe_hdrs, payload or {}, timeout=timeout) if method.upper() != "GET" else await self._cloak_get(url, safe_hdrs, timeout=timeout)
        hdrs = self.headers(json_content=(method.upper() != "GET"), referer=referer)
        async with httpx.AsyncClient(http2=True, timeout=timeout, follow_redirects=True) as client:
            if method.upper() == "GET":
                res = await client.get(url, headers=hdrs)
            else:
                res = await client.post(url, headers=hdrs, content=json.dumps(payload or {}).encode())
            return int(res.status_code), str(res.headers.get("content-type", "")), res.text

    async def _cloak_get(self, url: str, headers: dict[str, str], timeout: int = 60) -> tuple[int, str, str]:  # noqa: ARG002
        headers_json = json.dumps(headers)
        script = f"""
(async () => {{
  try {{
    const res = await fetch({json.dumps(url)}, {{
      method: 'GET',
      headers: {headers_json},
      credentials: 'include',
    }});
    const text = await res.text();
    return {{ status: res.status, ct: res.headers.get('content-type') || '', body: text }};
  }} catch(e) {{
    return {{ status: 0, ct: '', body: e.toString() }};
  }}
}})()
"""
        page = await _ensure_grok_page(self.profile)
        result = await page.evaluate(script)
        if not isinstance(result, dict):
            raise GrokError(f"CDP fetch lỗi: {result}")
        status = int(result.get("status") or 0)
        if status == 0:
            raise GrokError(f"CDP fetch lỗi: {result.get('body', '')}")
        return status, str(result.get("ct") or ""), str(result.get("body") or "")

    async def health(self) -> dict[str, Any]:
        if not _cloak_available() or not self.profile:
            raise GrokError("Cần CloakBrowser để kiểm tra tài khoản Grok")
        # Fetch subscriptions qua browser context — bypass Cloudflare
        status, _, text = await self._cloak_get(SUBSCRIPTIONS_URL, {}, timeout=60)
        if status != 200:
            raise GrokError(f"Grok cookie không hợp lệ hoặc bị chặn: HTTP {status}")
        tier = ""
        try:
            subs = json.loads(text).get("subscriptions") or []
            for sub in subs:
                if sub.get("status") == "SUBSCRIPTION_STATUS_ACTIVE":
                    tier = sub.get("tier", "")
                    break
        except Exception:
            pass
        return {"ok": True, "tier": tier}

    async def upload_image(self, name: str, content: bytes, mime: str | None = None) -> dict[str, Any]:
        mime = mime or mimetypes.guess_type(name)[0] or "image/jpeg"
        payload = {
            "fileName": name or f"ref_{uuid.uuid4().hex}.jpg",
            "fileMimeType": mime,
            "fileSource": "IMAGINE_SELF_UPLOAD_FILE_SOURCE",
            "content": base64.b64encode(content).decode("ascii"),
        }
        status, ctype, text = await self._request("POST", UPLOAD_URL, payload=payload, timeout=120, referer=GROK_ORIGIN + "/")
        if status != 200 or "json" not in ctype:
            raise GrokError(f"Upload ảnh Grok lỗi HTTP {status}: {text[:300]}")
        data = json.loads(text)
        file_id = data.get("fileMetadataId") or data.get("id") or ""
        file_uri = data.get("fileUri") or data.get("fileURL") or data.get("url") or ""
        if not file_id or not file_uri:
            raise GrokError("Upload ảnh Grok không trả về fileMetadataId/fileUri")
        return {**data, "asset_url": _asset_url(file_uri)}

    async def create_media_post(self, *, media_type: str, prompt: str = "", media_url: str = "") -> dict[str, Any]:
        payload: dict[str, Any] = {"mediaType": media_type}
        if prompt:
            payload["prompt"] = prompt
        if media_url:
            payload["mediaUrl"] = media_url
        status, ctype, text = await self._request("POST", POST_CREATE_URL, payload=payload, referer=GROK_ORIGIN + "/", timeout=90)
        if status != 200 or "json" not in ctype:
            raise GrokError(f"Tạo media post Grok lỗi HTTP {status}: {text[:300]}")
        data = json.loads(text)
        post = data.get("post") if isinstance(data.get("post"), dict) else data
        post_id = post.get("id") or data.get("id") or ""
        if not post_id:
            raise GrokError("Grok media/post/create không trả về post id")
        return {**data, "post_id": post_id}

    async def conversation(self, payload: dict[str, Any], *, timeout: int = 600) -> list[dict[str, Any]]:
        status, ctype, text = await self._request("POST", CONVERSATION_URL, payload=payload, referer=GROK_IMAGINE + "/saved", timeout=timeout)
        if status != 200:
            raise GrokError(f"Grok conversations/new lỗi HTTP {status}: {text[:500]}")
        events = _json_objects_from_text(text)
        if not events:
            raise GrokError(f"Grok không trả stream JSON hợp lệ: {text[:300]}")
        return events

    async def text_to_image_ws(self, prompt: str, *, aspect_ratio: str, mode: str, progress_cb=None) -> list[dict[str, Any]]:
        import inspect
        import websockets

        headers = self.headers(json_content=False)
        headers["Pragma"] = "no-cache"
        headers["Cache-Control"] = "no-cache"
        request_id = str(uuid.uuid4())
        first = {
            "type": "conversation.item.create",
            "timestamp": _now_ms(),
            "item": {"type": "message", "content": [{"type": "reset"}]},
        }
        second = {
            "type": "conversation.item.create",
            "timestamp": _now_ms(),
            "item": {
                "type": "message",
                "content": [
                    {
                        "requestId": request_id,
                        "text": prompt,
                        "type": "input_text",
                        "properties": {
                            "section_count": 0,
                            "is_kids_mode": False,
                            "enable_nsfw": True,
                            "skip_upsampler": False,
                            "enable_side_by_side": True,
                            "is_initial": False,
                            "aspect_ratio": aspect_ratio,
                            "enable_pro": mode == "quality",
                        },
                    }
                ],
            },
        }
        images: list[dict[str, Any]] = []
        ws_kwargs = {"open_timeout": 45, "close_timeout": 10}
        header_key = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
        ws_kwargs[header_key] = headers
        async with websockets.connect(WS_IMAGINE_URL, **ws_kwargs) as ws:
            await ws.send(json.dumps(first, separators=(",", ":")))
            await ws.send(json.dumps(second, separators=(",", ":")))
            deadline = time.monotonic() + 360
            while time.monotonic() < deadline:
                msg = await asyncio.wait_for(ws.recv(), timeout=45)
                try:
                    obj = json.loads(msg)
                except Exception:
                    continue
                if obj.get("type") == "json":
                    pct, node = _progress_from_event(obj, "streamingImageGenerationResponse")
                    if progress_cb:
                        await progress_cb(min(99, pct or 1), "Đang tạo ảnh Grok")
                    url = node.get("url") or node.get("imageUrl") or node.get("generatedImageUrl") or ""
                    if pct >= 100 and url:
                        images.append({"url": url, "media_id": node.get("id") or node.get("job_id") or ""})
                elif obj.get("type") == "image":
                    pct_img = obj.get("pct") or obj.get("percentage_complete") or 0
                    url = obj.get("url") or ""
                    blob = obj.get("blob") or ""
                    if not url and obj.get("id"):
                        url = f"{GROK_PUBLIC_IMAGES}/{obj['id']}.jpg"
                    # Only accept pct=100 (final image), skip pct=50 previews
                    if int(pct_img) >= 100:
                        images.append({"url": url, "b64": blob, "media_id": obj.get("id") or obj.get("job_id") or ""})
                if len(images) >= 1 and any((img.get("url") or img.get("b64")) for img in images):
                    break
        if not images:
            raise GrokError("Grok không trả ảnh")
        return images[:1]

    async def image_to_image(self, prompt: str, ref: dict[str, Any], *, aspect_ratio: str, mode: str, progress_cb=None) -> list[dict[str, Any]]:
        post = await self.create_media_post(media_type="MEDIA_POST_TYPE_IMAGE", media_url=ref["asset_url"])
        payload = {
            "temporary": True,
            "modelName": "imagine-image-edit",
            "message": prompt,
            "enableImageGeneration": True,
            "returnImageBytes": False,
            "returnRawGrokInXaiRequest": False,
            "enableImageStreaming": True,
            "imageGenerationCount": 1,
            "forceConcise": False,
            "enableSideBySide": True,
            "sendFinalMetadata": True,
            "isReasoning": False,
            "disableTextFollowUps": True,
            "responseMetadata": {
                "modelConfigOverride": {
                    "modelMap": {
                        "imageEditModelConfig": {
                            "imageReferences": [ref["asset_url"]],
                            "aspectRatio": aspect_ratio,
                            "parentPostId": post["post_id"],
                        },
                        "imageEditModel": "imagine",
                    }
                }
            },
            "disableMemory": False,
            "forceSideBySide": False,
        }
        events = await self.conversation(payload, timeout=420)

        # Collect progress and final asset URL from streamingImageGenerationResponse
        asset_url: str = ""
        asset_id: str = ""
        for obj in events:
            pct, node = _progress_from_event(obj, "streamingImageGenerationResponse")
            if progress_cb and pct:
                await progress_cb(min(99, pct), "Đang tạo ảnh Grok")
            if int(node.get("progress") or 0) >= 100:
                asset_id = node.get("assetId") or node.get("imageId") or ""
                img_url = node.get("imageUrl") or node.get("generatedImageUrl") or ""
                if img_url:
                    asset_url = _asset_url(img_url)  # full https://assets.grok.com/... URL

        # Fallback: modelResponse.generatedImageUrls
        if not asset_url:
            for obj in events:
                generated = _deep_find(obj, "generatedImageUrls")
                if isinstance(generated, list):
                    for x in generated:
                        if x:
                            asset_url = _asset_url(x)
                            # extract UUID from path
                            parts = [p for p in x.split("/") if p]
                            asset_id = next((p for p in reversed(parts) if len(p) == 36 and p.count("-") == 4), "")
                            break
                if asset_url:
                    break

        if not asset_url:
            raise GrokError("Grok không trả ảnh")

        # Download via CloakBrowser (same session/cookies as the account) → base64
        # This avoids any proxy/TLS issues — the browser already has auth cookies
        b64_data = ""
        if _cloak_available() and self.profile:
            try:
                content, _ = await _cloak_download_binary(self.profile, asset_url)
                b64_data = base64.b64encode(content).decode()
            except Exception:
                pass

        if b64_data:
            return [{"url": asset_url, "b64": b64_data, "media_id": asset_id}]
        # Fallback: return URL only (proxy-image will handle it)
        return [{"url": asset_url, "b64": "", "media_id": asset_id}]

    async def text_to_video(self, prompt: str, *, aspect_ratio: str, duration: int, resolution: str, progress_cb=None) -> list[dict[str, Any]]:
        post = await self.create_media_post(media_type="MEDIA_POST_TYPE_VIDEO", prompt=prompt)
        payload = {
            "temporary": True,
            "modelName": "grok-3",
            "message": f"{prompt} --mode=custom",
            "toolOverrides": {"videoGen": True},
            "enableSideBySide": True,
            "responseMetadata": {
                "experiments": [],
                "coif": [18, 0],
                "modelConfigOverride": {
                    "modelMap": {
                        "videoGenModelConfig": {
                            "parentPostId": post["post_id"],
                            "aspectRatio": aspect_ratio,
                            "videoLength": duration,
                            "resolutionName": resolution,
                        }
                    }
                },
            },
        }
        return await self._video_conversation(payload, progress_cb=progress_cb)

    async def image_to_video(self, prompt: str, ref: dict[str, Any], *, aspect_ratio: str, duration: int, resolution: str, progress_cb=None) -> list[dict[str, Any]]:
        post = await self.create_media_post(media_type="MEDIA_POST_TYPE_IMAGE", media_url=ref["asset_url"])
        payload = {
            "temporary": True,
            "modelName": "grok-3",
            "message": f"{ref['asset_url']} {prompt} --mode=custom",
            "fileAttachments": [ref.get("fileMetadataId") or ref.get("id") or ""],
            "toolOverrides": {"videoGen": True},
            "enableSideBySide": True,
            "responseMetadata": {
                "experiments": [],
                "coif": [18, 0],
                "modelConfigOverride": {
                    "modelMap": {
                        "videoGenModelConfig": {
                            "parentPostId": post["post_id"],
                            "aspectRatio": aspect_ratio,
                            "videoLength": duration,
                            "resolutionName": resolution,
                        }
                    }
                },
            },
        }
        return await self._video_conversation(payload, progress_cb=progress_cb)

    async def create_public_image_link(self, image_id: str) -> str:
        """Return public CDN URL for image asset — direct imagine-public.x.ai URL."""
        # shareLink from create-link is a post page URL (grok.com/imagine/post/...), not a CDN image URL.
        # The direct public CDN pattern is stable: imagine-public.x.ai/imagine-public/images/{assetId}.jpg
        return f"https://imagine-public.x.ai/imagine-public/images/{image_id}.jpg?cache=1"

    async def create_public_video_link(self, video_id: str) -> str:
        """Call /rest/media/post/create-link via browser fetch, return public URL."""
        payload = {"postId": video_id, "source": "post-page", "platform": "web"}
        try:
            status, ctype, text = await self._request(
                "POST", "https://grok.com/rest/media/post/create-link",
                payload=payload, referer=GROK_ORIGIN + "/", timeout=20,
            )
            if status == 200 and "json" in ctype:
                data = json.loads(text)
                share_link = data.get("shareLink") or ""
                if share_link and share_link.endswith(".mp4"):
                    return share_link
        except Exception:
            pass
        return f"https://imagine-public.x.ai/imagine-public/share-videos/{video_id}.mp4?cache=1"

    async def _video_conversation(self, payload: dict[str, Any], *, progress_cb=None) -> list[dict[str, Any]]:
        events = await self.conversation(payload, timeout=720)
        outputs: list[dict[str, Any]] = []
        for obj in events:
            pct, node = _progress_from_event(obj, "streamingVideoGenerationResponse")
            if progress_cb and pct:
                await progress_cb(min(99, pct), "Đang tạo video Grok")
            url = node.get("videoUrl") or node.get("generatedVideoUrl") or node.get("generatedVideoUri") or node.get("mediaUrl") or ""
            thumb = node.get("thumbnailImageUrl") or node.get("thumbnailUrl") or ""
            video_id = node.get("videoId") or node.get("assetId") or ""
            if url and int(node.get("progress") or 0) >= 100:
                public_url = await self.create_public_video_link(video_id) if video_id else _asset_url(url, download=False)
                asset_url = _asset_url(url, download=False)
                outputs.append(
                    {
                        "video_url": public_url or asset_url,
                        "download_url": _asset_url(url, download=True),
                        "thumbnail_url": _asset_url(thumb) if thumb else "",
                        "video_id": video_id,
                        "post_id": node.get("videoPostId") or node.get("parentPostId") or "",
                    }
                )
        if not outputs:
            raise GrokError("Grok không trả video")
        return outputs[-1:]


async def _legacy_grok_login_account(email: str, password: str, index: int) -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise GrokError("Tính năng login tự động cần playwright. Vui lòng chạy bản Python hoặc cài playwright: pip install playwright && playwright install chromium")

    profile = f"GROK_{index + 1}"
    opened = await open_grok_profile(profile, GROK_SIGN_IN)
    port = int(opened["port"])
    playwright = await async_playwright().start()
    browser = None
    try:
        browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(GROK_SIGN_IN, wait_until="domcontentloaded", timeout=60000)

        # Best-effort autofill. If Grok changes/login challenge appears, the user can finish in the opened browser.
        try:
            email_box = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"], input[type="text"], input').first
            await email_box.fill(email, timeout=15000)
            next_btn = page.get_by_role("button", name=re.compile(r"following|continue|next|tiếp|sign\s*in", re.I)).first
            if await next_btn.count():
                await next_btn.click(timeout=10000)
            else:
                await page.keyboard.press("Enter")
            await page.wait_for_timeout(2000)
            password_box = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first
            await password_box.fill(password, timeout=15000)
            submit_btn = page.get_by_role("button", name=re.compile(r"sign\s*in|log\s*in|continue|next|following", re.I)).first
            if await submit_btn.count():
                await submit_btn.click(timeout=10000)
            else:
                await page.keyboard.press("Enter")
        except Exception:
            pass

        deadline = time.monotonic() + 240
        cookie_header = ""
        while time.monotonic() < deadline:
            cookies = await context.cookies()
            cookie_header = _cookie_list_to_header(cookies)
            cookie_map = _parse_cookie(cookie_header)
            if (cookie_map.get("sso") or cookie_map.get("sso-rw") or cookie_map.get("auth_token")) and cookie_map.get("cf_clearance"):
                break
            if "grok.com/imagine" in page.url and not any(x in page.url for x in ("sign-in", "login")) and (cookie_map.get("sso") or cookie_map.get("auth_token")):
                break
            await page.wait_for_timeout(2000)

        if not cookie_header:
            raise GrokError("Không lấy được cookie Grok sau khi đăng nhập")

        statsig_id = ""
        try:
            statsig_id = await page.evaluate("() => localStorage.getItem('x-statsig-id') || ''")
        except Exception:
            statsig_id = ""

        return {
            "email": email,
            "password": password,
            "profile": profile,
            "cookie": cookie_header,
            "statsig_id": statsig_id,
            "enabled": True,
            "last_login": time.strftime("%Y-%m-%d %H:%M:%S"),
            "last_error": "",
        }
    finally:
        if browser:
            await browser.close()
        await playwright.stop()


def _login_fill_script(email: str, password: str) -> str:
    return f"""
(async () => {{
  const email = {json.dumps(email)};
  const password = {json.dumps(password)};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const visible = (el) => {{
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }};
  const setValue = (el, value) => {{
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};
  const inputs = () => [...document.querySelectorAll('input')].filter(visible);
  const buttons = () => [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(visible);
  const clickByText = (patterns) => {{
    const btn = buttons().find(b => {{
      const txt = (b.textContent || b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      return patterns.some(rx => rx.test(txt));
    }});
    if (btn) {{ btn.click(); return true; }}
    return false;
  }};
  const pressEnter = (el) => {{
    ['keydown','keypress','keyup'].forEach(type => {{
      el.dispatchEvent(new KeyboardEvent(type, {{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }}));
    }});
  }};
  const submitForm = (el) => {{
    const form = el.closest('form');
    if (form) {{ try {{ form.requestSubmit(); }} catch(e) {{ form.submit(); }} return true; }}
    return false;
  }};

  const _submitTexts = ['login','log in','sign in','continue','next','tiếp theo','đăng nhập','submit'];
  const clickSubmit = () => {{
    // Try type=submit first
    const byType = document.querySelector('button[type="submit"]');
    if (byType && visible(byType)) {{ byType.click(); return true; }}
    // Fallback: any visible button with login/next related text
    const loginBtn = buttons().find(b => {{
      const txt = (b.textContent || b.innerText || b.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      return _submitTexts.some(s => txt === s || txt.startsWith(s));
    }});
    if (loginBtn) {{ loginBtn.click(); return true; }}
    // Last resort: click the only visible button
    const allBtns = buttons().filter(b => b.type !== 'reset');
    if (allBtns.length === 1) {{ allBtns[0].click(); return true; }}
    return false;
  }};

  // Wait up to 15s for email input to appear
  let emailInput = null;
  for (let i = 0; i < 30; i++) {{
    emailInput = inputs().find(i => /email/i.test(i.type || '') || /email|username/i.test(i.name || '') || /username/i.test(i.autocomplete || ''));
    if (!emailInput && inputs().length > 0) emailInput = inputs().find(i => !/password/i.test(i.type || '')) || null;
    if (emailInput) break;
    await sleep(500);
  }}
  if (emailInput && email && !/password/i.test(emailInput.type || '')) {{
    await sleep(300);
    setValue(emailInput, email);
    await sleep(800);
    // Click button[type="submit"] (Next), retry up to 5x
    let nextClicked = false;
    for (let attempt = 0; attempt < 5; attempt++) {{
      nextClicked = clickSubmit();
      if (nextClicked) break;
      await sleep(400);
    }}
    if (!nextClicked) {{ pressEnter(emailInput); }}
  }}

  // Wait up to 8s for password input to appear
  let passInput = null;
  for (let i = 0; i < 16; i++) {{
    await sleep(500);
    passInput = inputs().find(i => /password/i.test(i.type || '') || /current-password/i.test(i.autocomplete || ''));
    if (passInput) break;
  }}

  if (passInput && password) {{
    passInput.focus();
    await sleep(200);
    setValue(passInput, password);
    await sleep(500);
    // Poll Turnstile: click as soon as it passes, wait up to 30s, min 1s
    const cfDone = async () => {{
      for (let i = 0; i < 60; i++) {{
        const box = document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]');
        if (!box) return true;  // no captcha = already passed or not needed
        const successIcon = document.querySelector('[data-state="passed"], .cf-success, svg[class*="success"]');
        if (successIcon) return true;
        await sleep(500);
      }}
      return true; // timeout, try anyway
    }};
    await sleep(1000);  // min 1s for Turnstile to mount
    await cfDone();
    await sleep(300);
    // Click Login button, retry up to 20x with 500ms gap
    let loginClicked = false;
    for (let attempt = 0; attempt < 20; attempt++) {{
      loginClicked = clickSubmit();
      if (loginClicked) break;
      await sleep(500);
    }}
    if (!loginClicked) {{ pressEnter(passInput); }}
  }}
  return {{
    href: location.href,
    title: document.title,
    emailFilled: !!emailInput,
    passwordFilled: !!passInput,
    bodyText: (document.body && document.body.innerText || '').slice(0, 500)
  }};
}})()
"""


async def _cdp_get_cookies(port: int) -> list[dict[str, Any]]:
    """Reconnect fresh CDP on the grok.com tab and get all cookies.
    Only connects to tabs that have passed Cloudflare (URL starts with grok.com/imagine or grok.com).
    Returns empty list if no qualifying tab found yet.
    """
    try:
        pages = await _get_cdp_pages(port)
        page_tabs = [p for p in pages if p.get("type") == "page" and p.get("webSocketDebuggerUrl")]
        # Find a tab that has passed Cloudflare — URL is grok.com (not "Just a moment")
        grok_tab = None
        for p in page_tabs:
            url = str(p.get("url", ""))
            title = str(p.get("title", ""))
            # Skip Cloudflare challenge tabs
            if "Just a moment" in title or "Verifying" in title:
                continue
            if url.startswith("https://grok.com"):
                grok_tab = p
                break
        if not grok_tab:
            return []
        ws_url = str(grok_tab["webSocketDebuggerUrl"])
        async with _CdpPage(ws_url) as cdp:
            return await cdp.cookies()
    except Exception:
        return []


async def _cdp_evaluate_fresh(port: int, expression: str) -> Any:
    """Reconnect fresh CDP on grok.com tab and evaluate JS."""
    try:
        ws_url = await _get_page_ws_url(port, prefer_url="https://grok.com")
        async with _CdpPage(ws_url) as cdp:
            return await cdp.evaluate(expression, timeout=5)
    except Exception:
        return None


async def _cloak_login_account(email: str, password: str, index: int) -> dict[str, Any]:
    """Login using CloakBrowser — visible window so user can see/interact."""
    profile = f"GROK_{index + 1}"

    # Close any existing context for this profile so we start fresh
    old_ctx = _CLOAK_CONTEXTS.pop(profile, None)
    if old_ctx:
        with contextlib.suppress(Exception):
            await old_ctx.close()

    from cloakbrowser import launch_persistent_context_async

    user_data_dir = _profile_dir(profile, cloak=True)
    ctx = await launch_persistent_context_async(
        user_data_dir=str(user_data_dir),
        headless=False,
        args=[  # visible window, maximized
            "--start-maximized",
            "--disable-popup-blocking",
            "--no-default-browser-check",
            "--no-first-run",
        ],
        stealth_args=True,
        humanize=False,
    )
    _CLOAK_CONTEXTS[profile] = ctx

    pages = ctx.pages
    page = pages[0] if pages else await ctx.new_page()

    # Phase 1: navigate to sign-in and fill credentials via Playwright API
    await page.goto(GROK_SIGN_IN, wait_until="domcontentloaded", timeout=60000)

    # Wait for email input and fill
    try:
        email_sel = 'input[type="email"], input[name="email"], input[autocomplete="username"], input[type="text"]'
        await page.wait_for_selector(email_sel, timeout=15000)
        await page.fill(email_sel, email)
        await asyncio.sleep(0.5)
        # Click Next button
        try:
            await page.click('button:has-text("Next")', timeout=5000)
        except Exception:
            try:
                await page.click('button[type="submit"]', timeout=3000)
            except Exception:
                await page.keyboard.press("Enter")
    except Exception:
        pass

    # Wait for password input and fill
    try:
        pass_sel = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
        await page.wait_for_selector(pass_sel, timeout=15000)
        await page.fill(pass_sel, password)
        await asyncio.sleep(1.0)
        # Wait for Turnstile (up to 30s)
        for _ in range(30):
            frame_exists = await page.evaluate("!!document.querySelector('iframe[src*=\"turnstile\"], iframe[src*=\"challenges.cloudflare\"]')")
            if not frame_exists:
                break
            passed = await page.evaluate("!!document.querySelector('[data-state=\"passed\"], .cf-success')")
            if passed:
                break
            await asyncio.sleep(1.0)
        await asyncio.sleep(0.5)
        # Click Login button
        try:
            await page.click('button:has-text("Login")', timeout=5000)
        except Exception:
            try:
                await page.click('button[type="submit"]', timeout=3000)
            except Exception:
                await page.keyboard.press("Enter")
    except Exception:
        pass

    # Phase 1b: retry clicking submit every 3s if still on login page
    for _ in range(10):
        await asyncio.sleep(3.0)
        with contextlib.suppress(Exception):
            _c = await ctx.cookies()
            _h = _cookie_list_to_header_all(_c)
            _m = _parse_cookie(_h)
            if _m.get("sso") or _m.get("sso-rw") or _m.get("auth_token"):
                break
        if "accounts.x.ai" in (page.url or ""):
            with contextlib.suppress(Exception):
                await page.click('button[type="submit"]', timeout=2000)
            with contextlib.suppress(Exception):
                await page.click('button:has-text("Login")', timeout=2000)
            with contextlib.suppress(Exception):
                await page.click('button:has-text("Next")', timeout=2000)

    # Phase 2: wait for SSO cookie to appear (login success)
    deadline_sso = time.monotonic() + 300
    while time.monotonic() < deadline_sso:
        await asyncio.sleep(3.0)
        with contextlib.suppress(Exception):
            _c = await ctx.cookies()
            _h = _cookie_list_to_header_all(_c)
            _m = _parse_cookie(_h)
            if _m.get("sso") or _m.get("sso-rw") or _m.get("auth_token"):
                break
    else:
        _CLOAK_CONTEXTS.pop(profile, None)
        with contextlib.suppress(Exception):
            await ctx.close()
        raise GrokError("Đăng nhập thất bại sau 5 phút. Kiểm tra email/mật khẩu và thử lại.")

    # Phase 3: navigate to grok.com/imagine to trigger Cloudflare challenge
    # Get the current active page (may have changed due to redirects)
    active_page = ctx.pages[-1] if ctx.pages else page
    with contextlib.suppress(Exception):
        await active_page.goto(GROK_IMAGINE, wait_until="domcontentloaded", timeout=90000)

    # Phase 4: poll until all anti-bot cookies appear (CF + x-challenge + x-signature)
    deadline = time.monotonic() + 180
    raw_cookies: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        await asyncio.sleep(3.0)
        with contextlib.suppress(Exception):
            raw_cookies = await ctx.cookies()
        final_header = _cookie_list_to_header_all(raw_cookies)
        if _is_grok_cookie_valid(final_header):
            break
    else:
        raw_cookies = await ctx.cookies()
        final_header = _cookie_list_to_header_all(raw_cookies)
        if not _is_grok_cookie_valid(final_header):
            missing = _missing_grok_cookie_names(final_header)
            _CLOAK_CONTEXTS.pop(profile, None)
            with contextlib.suppress(Exception):
                await ctx.close()
            raise GrokError("Chưa lấy đủ cookie anti-bot: " + ", ".join(missing) + ". Cloudflare chưa pass.")

    statsig_id = ""
    with contextlib.suppress(Exception):
        val = await page.evaluate("""(() => {
            const stores = [localStorage, sessionStorage];
            for (const store of stores) {
                const direct = store.getItem('x-statsig-id') || store.getItem('statsigStableID') || store.getItem('statsig.stable_id');
                if (direct) return direct;
                for (let i = 0; i < store.length; i++) {
                    const key = store.key(i) || '';
                    if (/statsig/i.test(key)) {
                        const value = store.getItem(key) || '';
                        const m = value.match(/[A-Za-z0-9+/=_-]{40,}/);
                        if (m) return m[0];
                    }
                }
            }
            return '';
        })()""")
        statsig_id = str(val or "")

    # Keep the context alive in _CLOAK_CONTEXTS for subsequent API calls
    return {
        "email": email,
        "password": password,
        "profile": profile,
        "cookie": raw_cookies,
        "statsig_id": statsig_id,
        "enabled": True,
        "last_login": time.strftime("%Y-%m-%d %H:%M:%S"),
        "last_error": "",
    }


async def _legacy_login_account(email: str, password: str, index: int) -> dict[str, Any]:
    """Login using legacy Chrome CDP (fallback when CloakBrowser unavailable)."""
    profile = f"GROK_{index + 1}"
    opened = await open_grok_profile(profile, GROK_SIGN_IN)
    port = int(opened["port"])

    ws_url = await _get_page_ws_url(port)
    async with _CdpPage(ws_url) as cdp:
        await cdp.navigate(GROK_SIGN_IN)
        await asyncio.sleep(2.5)

        for _ in range(3):
            with contextlib.suppress(Exception):
                await cdp.evaluate(_login_fill_script(email, password), timeout=20)
            await asyncio.sleep(2.0)
            cookies = await cdp.cookies()
            cookie_header = _cookie_list_to_header_all(cookies)
            cookie_map = _parse_cookie(cookie_header)
            if cookie_map.get("sso") or cookie_map.get("sso-rw") or cookie_map.get("auth_token"):
                break

        deadline = time.monotonic() + 300
        raw_cookies: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            raw_cookies = await cdp.cookies()
            cookie_header = _cookie_list_to_header_all(raw_cookies)
            cookie_map = _parse_cookie(cookie_header)
            if cookie_map.get("sso") or cookie_map.get("sso-rw") or cookie_map.get("auth_token"):
                break
            await asyncio.sleep(2.0)

        cookie_header = _cookie_list_to_header_all(raw_cookies)
        cookie_map = _parse_cookie(cookie_header)
        if not (cookie_map.get("sso") or cookie_map.get("sso-rw") or cookie_map.get("auth_token")):
            _PROFILE_CDP_PORTS.pop(profile, None)
            raise GrokError("Đăng nhập thất bại sau 5 phút.")

        with contextlib.suppress(Exception):
            await cdp.navigate(GROK_IMAGINE)

    await asyncio.sleep(10.0)
    deadline2 = time.monotonic() + 120
    while time.monotonic() < deadline2:
        extra = await _cdp_get_cookies(port)
        final_header = _cookie_list_to_header_all(extra)
        if _is_grok_cookie_valid(final_header):
            raw_cookies = extra
            break
        await asyncio.sleep(3.0)
    else:
        extra = await _cdp_get_cookies(port)
        final_header = _cookie_list_to_header_all(extra)
        if extra and _is_grok_cookie_valid(final_header):
            raw_cookies = extra
        else:
            missing = _missing_grok_cookie_names(final_header)
            _PROFILE_CDP_PORTS.pop(profile, None)
            raise GrokError("Chưa lấy đủ cookie anti-bot: " + ", ".join(missing))

    statsig_id = ""
    val = await _cdp_evaluate_fresh(port, """(() => {
        const stores = [localStorage, sessionStorage];
        for (const store of stores) {
            const direct = store.getItem('x-statsig-id') || store.getItem('statsigStableID') || store.getItem('statsig.stable_id');
            if (direct) return direct;
            for (let i = 0; i < store.length; i++) {
                const key = store.key(i) || '';
                if (/statsig/i.test(key)) {
                    const value = store.getItem(key) || '';
                    const m = value.match(/[A-Za-z0-9+/=_-]{40,}/);
                    if (m) return m[0];
                }
            }
        }
        return '';
    })()""")
    statsig_id = str(val or "")

    with contextlib.suppress(Exception):
        ws_url2 = await _get_page_ws_url(port)
        async with _CdpPage(ws_url2) as cdp2:
            await cdp2.evaluate("window.close()", timeout=3)
    _PROFILE_CDP_PORTS.pop(profile, None)

    return {
        "email": email,
        "password": password,
        "profile": profile,
        "cookie": raw_cookies,
        "statsig_id": statsig_id,
        "enabled": True,
        "last_login": time.strftime("%Y-%m-%d %H:%M:%S"),
        "last_error": "",
    }


async def _cleanup_failed_login(profile: str) -> None:
    """Kill browser + xóa profile dir khi login thất bại — không để lại profile rác."""
    import shutil
    ctx = _CLOAK_CONTEXTS.pop(profile, None)
    if ctx:
        with contextlib.suppress(Exception):
            await ctx.close()
    profile_dir = _profile_dir(profile, cloak=True)
    _kill_chromium_holding_profile(profile_dir)
    with contextlib.suppress(Exception):
        shutil.rmtree(str(profile_dir), ignore_errors=True)


async def grok_login_account(email: str, password: str, index: int) -> dict[str, Any]:
    profile = f"GROK_{index + 1}"
    # Total timeout: 10 min (phase1 90s fill + phase2 300s SSO + phase3 180s CF + margin)
    try:
        if _cloak_available():
            return await asyncio.wait_for(_cloak_login_account(email, password, index), timeout=660)
        return await asyncio.wait_for(_legacy_login_account(email, password, index), timeout=660)
    except asyncio.TimeoutError:
        await _cleanup_failed_login(profile)
        raise GrokError("Đăng nhập timeout sau 11 phút — kiểm tra email/mật khẩu hoặc mạng")
    except Exception:
        await _cleanup_failed_login(profile)
        raise


# --- Manual login (user logs in themselves in the browser window) ---

# Tracks open manual-login browsers: profile -> BrowserContext
_MANUAL_CONTEXTS: dict[str, Any] = {}


async def open_browser_for_manual_login(index: int) -> dict[str, Any]:
    """Open a visible CloakBrowser window at grok.com/imagine for the user to login manually."""
    profile = f"GROK_{index + 1}"

    # Close any existing manual context for this profile
    old = _MANUAL_CONTEXTS.pop(profile, None)
    if old:
        with contextlib.suppress(Exception):
            await old.close()

    if not _cloak_available():
        raise GrokError("CloakBrowser chưa được cài đặt. Hãy tải về trong tab Grok.")
    if not cloak_browser_installed():
        raise GrokError("BROWSER_NOT_INSTALLED")

    from cloakbrowser import launch_persistent_context_async

    user_data_dir = _profile_dir(profile, cloak=True)
    # Visible window (no hidden args) so user can interact
    ctx = await launch_persistent_context_async(
        user_data_dir=str(user_data_dir),
        headless=False,
        args=["--start-maximized", "--no-default-browser-check", "--no-first-run"],
        stealth_args=True,
        humanize=False,
    )
    _MANUAL_CONTEXTS[profile] = ctx
    pages = ctx.pages
    page = pages[0] if pages else await ctx.new_page()
    await page.goto(GROK_SIGN_IN, wait_until="domcontentloaded", timeout=60000)
    return {"ok": True, "profile": profile, "mode": "cloakbrowser"}


async def load_cookie_from_manual_login(index: int, email: str = "") -> dict[str, Any]:
    """Navigate to grok.com/imagine, wait for all anti-bot cookies, then save account."""
    profile = f"GROK_{index + 1}"
    ctx = _MANUAL_CONTEXTS.get(profile)

    if ctx is None:
        raise GrokError("Không tìm thấy browser đang mở. Hãy nhấn 'Mở Browser' trước.")

    def _manual_cookie_valid(hdr: str) -> bool:
        cmap = _parse_cookie(hdr)
        return all(any(cmap.get(n) for n in grp) for grp in _GROK_MANUAL_REQUIRED_GROUPS)

    def _manual_missing(hdr: str) -> list[str]:
        cmap = _parse_cookie(hdr)
        return ["/".join(grp) for grp in _GROK_MANUAL_REQUIRED_GROUPS if not any(cmap.get(n) for n in grp)]

    raw_cookies: list[dict[str, Any]] = await ctx.cookies()
    final_header = _cookie_list_to_header_all(raw_cookies)
    if not _manual_cookie_valid(final_header):
        missing = _manual_missing(final_header)
        raise GrokError("Cookie chưa đủ: " + ", ".join(missing) + ". Hãy login xong rồi ấn Load Cookie.")

    statsig_id = ""
    with contextlib.suppress(Exception):
        _pages = ctx.pages
        if _pages:
            val = await _pages[-1].evaluate("""(() => {
                const stores = [localStorage, sessionStorage];
                for (const store of stores) {
                    const d = store.getItem('x-statsig-id') || store.getItem('statsigStableID') || store.getItem('statsig.stable_id');
                    if (d) return d;
                }
                return '';
            })()""")
            statsig_id = str(val or "")

    # Close browser
    _MANUAL_CONTEXTS.pop(profile, None)
    with contextlib.suppress(Exception):
        await ctx.close()

    accounts_data = load_grok_accounts()
    acc_index = index
    if email:
        for i, a in enumerate(accounts_data):
            if a.get("email") == email:
                acc_index = i
                break

    account = {
        "email": email or (accounts_data[acc_index].get("email") if acc_index < len(accounts_data) else ""),
        "profile": profile,
        "cookie": raw_cookies,
        "statsig_id": statsig_id,
        "enabled": True,
        "last_login": time.strftime("%Y-%m-%d %H:%M:%S"),
        "last_error": "",
    }
    if acc_index < len(accounts_data):
        accounts_data[acc_index] = account
    else:
        accounts_data.append(account)
    save_grok_accounts(accounts_data)
    return {"ok": True, "profile": profile, "accounts": public_grok_accounts()}


async def _cloak_download_binary(profile: str, url: str, referer: str = "") -> tuple[bytes, str]:
    """Download asset from assets.grok.com using cookies from the CloakBrowser context.

    Extracts cookies from the live browser context and uses httpx with curl_cffi TLS
    impersonation to download — avoids new tab launch and keeps the main page stable.
    """
    # Get cookies from the live browser context
    ctx = await _get_or_launch_cloak_context(profile)
    raw_cookies: list[dict] = []
    try:
        raw_cookies = await ctx.cookies()
    except Exception:
        pass

    cookie_header = _cookie_list_to_header_all(raw_cookies)

    # Try curl_cffi first (Chrome TLS fingerprint)
    try:
        from curl_cffi.requests import AsyncSession as CurlSession
        headers = {
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Referer": "https://grok.com/",
            "Sec-Fetch-Dest": "image",
            "Sec-Fetch-Mode": "no-cors",
            "Sec-Fetch-Site": "same-site",
            "User-Agent": DEFAULT_UA,
            "Cookie": cookie_header,
        }
        async with CurlSession(impersonate="chrome136") as session:
            resp = await session.get(url, headers=headers, timeout=60, allow_redirects=True)
        if resp.status_code == 200:
            ct = resp.headers.get("content-type", "image/jpeg")
            return bytes(resp.content), ct
        raise GrokError(f"Tải ảnh lỗi HTTP {resp.status_code}")
    except ImportError:
        pass

    # Fallback: httpx
    headers = {
        "Accept": "image/*,*/*",
        "Referer": "https://grok.com/",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": DEFAULT_UA,
        "Cookie": cookie_header,
    }
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code != 200:
        raise GrokError(f"Tải ảnh lỗi HTTP {resp.status_code}")
    return bytes(resp.content), resp.headers.get("content-type", "image/jpeg")


async def download_with_account(url: str, account: dict[str, Any], filename: str) -> tuple[bytes, str]:
    client = GrokClient(account)
    if _cloak_available() and client.profile:
        return await _cloak_download_binary(client.profile, url)
    headers = client.headers(json_content=False, referer=GROK_ORIGIN + "/")
    # assets.grok.com is same-site (not same-origin) from grok.com
    headers["Sec-Fetch-Site"] = "same-site"
    headers["Sec-Fetch-Dest"] = "video"
    headers["Sec-Fetch-Mode"] = "no-cors"
    async with httpx.AsyncClient(timeout=180, follow_redirects=True) as http:
        res = await http.get(url, headers=headers)
    if res.status_code != 200:
        raise GrokError(f"Tải file Grok lỗi HTTP {res.status_code}: {res.text[:200]}")
    content_type = res.headers.get("content-type") or "application/octet-stream"
    return res.content, content_type
