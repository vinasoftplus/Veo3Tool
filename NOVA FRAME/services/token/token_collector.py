"""Token collector — uses Playwright to automate Chrome and intercept Google Labs auth token."""
from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Callable

RECAPTCHA_SITE_KEY = "k=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
FLOW_URL = "https://labs.google/fx/vi/tools/flow"

CHROME_EXTRA_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--mute-audio",
    "--window-size=900,700",
    "--blink-settings=imagesEnabled=false",
    "--disable-features=Translate,BackForwardCache",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--disable-gpu",
]


def _is_recaptcha_reload(url: str) -> bool:
    return "/recaptcha/enterprise/reload" in url and RECAPTCHA_SITE_KEY in url


def _extract_recaptcha_token(text: str) -> str | None:
    marker = '["rresp","'
    start = text.find(marker)
    if start == -1:
        return None
    start += len(marker)
    end = text.find('"', start)
    if end == -1:
        return None
    return text[start:end]


def _find_chrome_executable() -> str:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return "chrome"


class TokenCollector:
    def __init__(
        self,
        userdata_dir: str,
        profile_name: str = "Default",
        debug_port: int = 9222,
        headless: bool = False,
        log_callback: Callable[[str], None] | None = None,
        token_timeout: int = 90,
    ):
        self.userdata_dir = userdata_dir
        self.profile_name = profile_name
        self.debug_port = debug_port
        self.headless = headless
        self.log_callback = log_callback
        self.token_timeout = token_timeout
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._chrome_proc: subprocess.Popen | None = None

    def _log(self, msg: str):
        if callable(self.log_callback):
            try:
                self.log_callback(msg)
                return
            except Exception:
                pass
        print(msg)

    def _is_port_open(self, port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                return s.connect_ex(("127.0.0.1", port)) == 0
        except Exception:
            return False

    def _is_cdp_ready(self, port: int, timeout: float = 6.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=0.5) as r:
                    data = json.loads(r.read())
                    if data.get("webSocketDebuggerUrl") or data.get("Browser"):
                        return True
            except Exception:
                pass
            time.sleep(0.3)
        return False

    def _launch_chrome(self):
        chrome = _find_chrome_executable()
        args = [
            chrome,
            f"--remote-debugging-port={self.debug_port}",
            f"--user-data-dir={self.userdata_dir}",
            f"--profile-directory={self.profile_name}",
            FLOW_URL,
        ] + CHROME_EXTRA_ARGS
        if self.headless:
            args.append("--headless=new")
        flags = 0
        if os.name == "nt":
            flags = 0x08000000  # DETACHED_PROCESS / no window
        self._chrome_proc = subprocess.Popen(
            args,
            creationflags=flags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    async def collect_token(self) -> tuple[str | None, str | None]:
        """
        Navigate to labs.google, wait for recaptcha reload request,
        intercept Authorization header + recaptcha token.
        Returns (auth_token, recaptcha_token) or (None, None) on failure.
        """
        from playwright.async_api import async_playwright

        if not self._is_port_open(self.debug_port):
            self._log(f"🚀 Khởi động Chrome trên port {self.debug_port}...")
            self._launch_chrome()
            if not self._is_cdp_ready(self.debug_port, timeout=12.0):
                self._log("❌ Chrome không khởi động được")
                return None, None
        else:
            if not self._is_cdp_ready(self.debug_port, timeout=3.0):
                self._log("❌ CDP không sẵn sàng")
                return None, None

        auth_token: str | None = None
        recaptcha_token: str | None = None
        token_event = asyncio.Event()

        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.connect_over_cdp(
                f"http://localhost:{self.debug_port}"
            )
            ctx = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context()
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            async def on_response(response):
                nonlocal auth_token, recaptcha_token
                try:
                    url = response.url
                    if _is_recaptcha_reload(url):
                        # Extract auth from request headers
                        req_headers = response.request.headers
                        auth = req_headers.get("authorization", "")
                        if auth:
                            auth_token = auth
                        # Extract recaptcha token from response body
                        try:
                            body = await response.body()
                            text = body.decode("utf-8", errors="ignore")
                            rc = _extract_recaptcha_token(text)
                            if rc:
                                recaptcha_token = rc
                        except Exception:
                            pass
                        if auth_token:
                            token_event.set()
                except Exception:
                    pass

            page.on("response", on_response)

            # Navigate to flow page to trigger token requests
            try:
                current_url = page.url
                if "labs.google" not in current_url:
                    await page.goto(FLOW_URL, wait_until="domcontentloaded", timeout=30000)
                else:
                    await page.reload(wait_until="domcontentloaded", timeout=30000)
            except Exception as e:
                self._log(f"⚠️ Goto error: {e}")

            self._log("⏳ Đang chờ token từ Chrome...")
            try:
                await asyncio.wait_for(token_event.wait(), timeout=float(self.token_timeout))
            except asyncio.TimeoutError:
                self._log("⏰ Timeout chờ token")
                return None, None

            if auth_token:
                self._log("✅ Thu được token!")
            return auth_token, recaptcha_token

        except Exception as e:
            self._log(f"❌ Lỗi token collector: {e}")
            return None, None
        finally:
            try:
                if self._browser:
                    await self._browser.close()
            except Exception:
                pass
            try:
                await self._playwright.stop()
            except Exception:
                pass


RECAPTCHA_EXECUTE_JS = """
async () => {
  const siteKey = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const action = 'VIDEO_GENERATION';
  try {
    const gr = await new Promise((resolve, reject) => {
      let tries = 0;
      const t = setInterval(() => {
        if (window.grecaptcha && window.grecaptcha.enterprise) {
          clearInterval(t); resolve(window.grecaptcha.enterprise);
        }
        if (++tries > 80) { clearInterval(t); reject(new Error('timeout')); }
      }, 100);
    });
    return await gr.execute(siteKey, { action });
  } catch(e) { return null; }
}
"""


async def get_recaptcha_token_via_playwright(
    project_url: str,
    userdata_dir: str,
    profile_name: str = "Default",
    debug_port: int = 9222,
    timeout: int = 40,
    log_callback: Callable[[str], None] | None = None,
) -> str | None:
    """
    Connect to existing Chrome (or launch new), navigate to labs.google project page,
    then call grecaptcha.enterprise.execute() and return the reCAPTCHA token.
    """
    from playwright.async_api import async_playwright

    def _log(msg):
        if callable(log_callback):
            try: log_callback(msg)
            except Exception: pass

    # Try to connect to already-running Chrome first
    need_launch = False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", debug_port)) != 0:
                need_launch = True
    except Exception:
        need_launch = True

    chrome_proc = None
    if need_launch:
        _log(f"Khởi động Chrome headless trên port {debug_port}...")
        chrome = _find_chrome_executable()
        flags = 0x08000000 if os.name == "nt" else 0
        chrome_proc = subprocess.Popen(
            [
                chrome,
                f"--remote-debugging-port={debug_port}",
                f"--user-data-dir={userdata_dir}",
                f"--profile-directory={profile_name}",
                "--headless=new",
                "--no-first-run",
                "--disable-extensions",
                "--disable-gpu",
                "--window-size=800,600",
                "--mute-audio",
                project_url or FLOW_URL,
            ],
            creationflags=flags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for CDP
        deadline = time.time() + 12
        ready = False
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{debug_port}/json/version", timeout=0.5):
                    ready = True
                    break
            except Exception:
                time.sleep(0.3)
        if not ready:
            _log("Chrome không khởi động được")
            return None

    playwright = await async_playwright().start()
    recaptcha_token: str | None = None
    try:
        browser = await playwright.chromium.connect_over_cdp(f"http://localhost:{debug_port}")
        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        # Navigate to project page if needed
        try:
            cur = page.url or ""
            if "labs.google" not in cur:
                await page.goto(project_url or FLOW_URL, wait_until="domcontentloaded", timeout=20000)
            # else already on labs.google, just execute
        except Exception as e:
            _log(f"Goto error: {e}")

        # Wait for page to settle a bit
        await asyncio.sleep(2)

        # Execute reCAPTCHA
        _log("Đang lấy reCAPTCHA token...")
        try:
            result = await asyncio.wait_for(
                page.evaluate(RECAPTCHA_EXECUTE_JS),
                timeout=float(timeout),
            )
            if result:
                recaptcha_token = str(result)
                _log("✅ Lấy reCAPTCHA token thành công")
            else:
                _log("⚠️ grecaptcha.enterprise.execute() trả về null")
        except asyncio.TimeoutError:
            _log("⏰ Timeout lấy reCAPTCHA token")
        except Exception as e:
            _log(f"❌ Lỗi execute reCAPTCHA: {e}")

        await browser.close()
    except Exception as e:
        _log(f"❌ Playwright error: {e}")
    finally:
        try:
            await playwright.stop()
        except Exception:
            pass
        # Only kill if we launched it
        if chrome_proc and need_launch:
            try:
                chrome_proc.terminate()
            except Exception:
                pass

    return recaptcha_token


async def collect_token_for_account(
    account: dict,
    log_callback: Callable[[str], None] | None = None,
) -> dict:
    """High-level helper: collect token and return updated account dict."""
    from services.config_service import BASE_DIR
    userdata_root = str(BASE_DIR / "data" / "chrome_userdata")
    profile_name = account.get("PROFILE_NAME", "Default")
    port = int(account.get("DEBUG_PORT", 9222))

    collector = TokenCollector(
        userdata_dir=userdata_root,
        profile_name=profile_name,
        debug_port=port,
        headless=False,
        log_callback=log_callback,
        token_timeout=90,
    )
    auth_token, recaptcha_token = await collector.collect_token()
    if auth_token:
        account = {**account, "ACCESS_TOKEN": auth_token}
        if recaptcha_token:
            account["RECAPTCHA_TOKEN"] = recaptcha_token
    return account
