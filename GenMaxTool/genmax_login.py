"""
GenMax Login Tool — đăng nhập Google qua genmax.io bằng CloakBrowser
Cách dùng: python genmax_login.py
"""
import asyncio
import json
import threading
import time
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
ACCOUNTS_PATH = APP_DIR / "accounts.json"
API_KEYS_PATH = APP_DIR / "api_keys.txt"
ERROR_PATH = APP_DIR / "error.txt"

# Keywords nhận biết màn verify / block của Google
_VERIFY_TEXTS = [
    "verify it's you", "xác minh đây là bạn",
    "verify your identity", "xác minh danh tính của bạn", "xác minh danh tính",
    "phone number", "số điện thoại",
    "suspicious activity", "hoạt động đáng ngờ",
    "unusual activity", "hoạt động bất thường",
    "confirm it's you", "xác nhận đây là bạn",
    "2-step verification", "xác minh 2 bước",
    "enter the code", "nhập mã",
    # Màn chọn phương thức xác minh
    "choose how you want to sign in", "chọn cách bạn muốn đăng nhập",
    "get a verification code", "nhận mã xác minh",
    "use another phone", "sử dụng một điện thoại",
    "try another way", "thử cách khác",
]

# Keywords nhận biết email/password sai hoặc tài khoản lỗi
_INVALID_ACCOUNT_TEXTS = [
    # Email sai định dạng
    "enter a valid email", "enter a valid email or phone",
    "nhập địa chỉ email hợp lệ", "địa chỉ email không hợp lệ",
    # Email không tồn tại
    "couldn't find your google account",
    "could not find your google account",
    "no account found",
    "không tìm thấy tài khoản google",
    # Không thể đăng nhập (verify thất bại, org block, v.v.)
    "couldn't sign you in",
    "could not sign you in",
    "google couldn't verify",
    "couldn't verify this account",
    "recover account",
    "account recovery",
    "không thể đăng nhập",
    # Sai mật khẩu / mật khẩu đã đổi
    "wrong password", "incorrect password",
    "that's an incorrect password",
    "password was changed", "password has been changed",
    "mật khẩu đã được thay đổi", "mật khẩu đã thay đổi",
    "sai mật khẩu", "mật khẩu không đúng",
    "try again", "thử lại",
    # Tài khoản bị khoá/vô hiệu
    "account has been disabled",
    "this account has been suspended",
    "tài khoản đã bị vô hiệu hoá",
    "tài khoản đã bị tạm ngưng",
]

GENMAX_URL = "https://genmax.io"
GENMAX_API_URL = "https://genmax.io/app/api-docs"

# Lock đồng bộ cho phần sync (accounts.json, error.txt)
_write_lock = threading.Lock()
# Lock async cho ghi api_keys.txt — khởi tạo lazy trong event loop
_key_lock: asyncio.Lock | None = None


def _get_key_lock() -> asyncio.Lock:
    global _key_lock
    if _key_lock is None:
        _key_lock = asyncio.Lock()
    return _key_lock

# Tính toán vị trí window cho từng luồng (4 cột x n hàng)
_COLS = 4
_WIN_W = 480
_WIN_H = 600


def _window_pos(slot: int) -> str:
    col = slot % _COLS
    row = slot // _COLS
    x = col * _WIN_W
    y = row * _WIN_H
    return f"--window-position={x},{y}"


def load_accounts() -> list:
    if ACCOUNTS_PATH.exists():
        try:
            return json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def save_accounts(accounts: list):
    ACCOUNTS_PATH.write_text(json.dumps(accounts, ensure_ascii=False, indent=2), encoding="utf-8")


def load_existing_keys() -> list[str]:
    if API_KEYS_PATH.exists():
        return [l.strip() for l in API_KEYS_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
    return []


def save_keys_txt(keys: list[str]):
    API_KEYS_PATH.write_text("\n".join(keys) + "\n", encoding="utf-8")


async def _get_api_key(page, email: str = "") -> str:
    try:
        await page.goto(GENMAX_API_URL, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        val = await page.evaluate("""() => {
            const texts = [...document.querySelectorAll('input, textarea, code, pre, span, p, div')]
                .map(el => (el.value || el.textContent || '').trim())
                .filter(t => t.startsWith('sk_') && t.length > 20);
            return texts[0] || '';
        }""")
        key = str(val).strip() if val else ""
        if key:
            async with _get_key_lock():
                existing = load_existing_keys()
                if key not in existing:
                    existing.append(key)
                    save_keys_txt(existing)
                tag_str = f"[{email}] " if email else ""
                print(f"  {tag_str}Đã ghi key vào api_keys.txt: {key[:12]}...")
        return key
    except Exception as e:
        print(f"  [{threading.current_thread().name}] Không lấy được API key: {e}")
        return ""


async def login_one(email: str, password: str, slot: int) -> dict:
    """Đăng nhập 1 tài khoản — tab trắng hoàn toàn, không lưu profile."""
    from cloakbrowser import launch_async

    tag = f"[{slot+1}] {email}"
    result = {"ok": False, "email": email, "api_key": "", "error": ""}

    browser = None
    ctx = None
    try:
        print(f"{tag} Mở browser ...")
        browser = await launch_async(
            headless=False,
            args=[
                _window_pos(slot),
                f"--window-size={_WIN_W},{_WIN_H}",
                "--no-default-browser-check",
                "--no-first-run",
            ],
            stealth_args=True,
            humanize=False,
        )
        ctx = await browser.new_context(
            viewport={"width": _WIN_W, "height": _WIN_H},
        )
        page = await ctx.new_page()

        # 1. Vào genmax.io — đợi nút "Get Started" xuất hiện (tối đa 60s)
        print(f"{tag} [1] genmax.io ...")
        await page.goto(GENMAX_URL, wait_until="domcontentloaded", timeout=60000)
        get_started = page.locator("a:has-text('Get Started'), button:has-text('Get Started')").first
        await get_started.wait_for(state="attached", timeout=60000)

        # 2. Get Started for Free — JS click bypass hidden state
        print(f"{tag} [2] Get Started for Free ...")
        await get_started.evaluate("el => el.click()")

        # 3. Login with Google — thấy rồi click ngay
        print(f"{tag} [3] Login with Google ...")
        google_btn = page.locator("button:has-text('Google')").first
        await google_btn.wait_for(state="visible", timeout=30000)
        await google_btn.click(timeout=15000)

        # 4. Tìm popup Google OAuth
        print(f"{tag} [4] Google OAuth ...")
        target = page
        for _ in range(30):
            popups = [p for p in ctx.pages if p != page and "accounts.google" in (p.url or "")]
            if popups:
                target = popups[0]
                break
            await asyncio.sleep(0.3)

        # Điền email
        email_el = target.locator('input[type="email"]').first
        await email_el.wait_for(state="visible", timeout=20000)
        await email_el.scroll_into_view_if_needed()
        await asyncio.sleep(0.3)
        await email_el.triple_click()  # select-all để clear text cũ
        await email_el.evaluate(
            "(el, v) => { el.focus(); el.value = ''; el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }",
            email,
        )
        try:
            nb = target.locator("button:has-text('Tiếp theo'), button:has-text('Next')").first
            await nb.wait_for(state="visible", timeout=5000)
            await nb.click(timeout=8000)
        except Exception:
            await email_el.press("Enter")

        # Chờ Google xử lý — kiểm tra lỗi email không tồn tại / sai định dạng
        await asyncio.sleep(1.5)
        try:
            body_text = (await target.evaluate("() => document.body?.innerText || ''")).lower()
            matched = next((kw for kw in _INVALID_ACCOUNT_TEXTS if kw in body_text), None)
            if matched:
                pw_visible = await target.locator('input[type="password"]:not([aria-hidden="true"])').count()
                if not pw_visible:
                    raise RuntimeError(f"INVALID_ACCOUNT: Email lỗi — {matched}")
        except RuntimeError:
            raise
        except Exception:
            pass

        # Điền mật khẩu — loại trừ input fake ẩn của Google (hiddenPassword)
        pass_el = target.locator(
            'input[type="password"]:not([aria-hidden="true"]):not([name="hiddenPassword"])'
        ).first
        await pass_el.wait_for(state="visible", timeout=20000)
        await pass_el.scroll_into_view_if_needed()
        await asyncio.sleep(0.3)
        await pass_el.evaluate(
            "(el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }",
            password,
        )
        try:
            nb2 = target.locator("button:has-text('Tiếp theo'), button:has-text('Next')").first
            await nb2.wait_for(state="visible", timeout=5000)
            await nb2.click(timeout=8000)
        except Exception:
            await pass_el.press("Enter")

        # Chờ Google xử lý — kiểm tra lỗi sau khi submit password
        await asyncio.sleep(2)
        try:
            body_text = (await target.evaluate("() => document.body?.innerText || ''")).lower()
            matched = next((kw for kw in _INVALID_ACCOUNT_TEXTS if kw in body_text), None)
            if matched:
                raise RuntimeError(f"INVALID_ACCOUNT: {matched}")
        except RuntimeError:
            raise
        except Exception:
            pass

        # 4b. Màn xác nhận OAuth "Sign in to genmax.io" — click Continue ngay khi thấy
        # Đồng thời phát hiện màn verify phone / block để thoát sớm
        print(f"{tag} [4b] Đợi Continue OAuth ...")
        for _ in range(40):
            # Kiểm tra màn verify/block trên mọi trang Google
            for pg in ctx.pages:
                if "google" not in (pg.url or ""):
                    continue
                try:
                    body_text = (await pg.evaluate("() => document.body?.innerText || ''")).lower()
                    if any(kw in body_text for kw in _VERIFY_TEXTS):
                        raise RuntimeError("VERIFY_REQUIRED")
                    if any(kw in body_text for kw in _INVALID_ACCOUNT_TEXTS):
                        raise RuntimeError("INVALID_ACCOUNT: Tài khoản không hợp lệ hoặc bị chặn")
                except RuntimeError:
                    raise
                except Exception:
                    pass

            for pg in ctx.pages:
                if "google" not in (pg.url or "") and "genmax" not in (pg.url or ""):
                    continue
                try:
                    cb = pg.locator(
                        "button:has-text('Continue'), button:has-text('Tiếp tục'), "
                        "button:has-text('Confirm'), button:has-text('Allow'), button:has-text('Cho phép')"
                    ).first
                    if await cb.count():
                        await cb.click(timeout=3000)
                        print(f"{tag} Đã click Continue")
                except Exception:
                    pass
            if "/app" in (page.url or "") or "dashboard" in (page.url or ""):
                break
            await asyncio.sleep(0.3)

        # 5. Đợi redirect về /app — đồng thời check verify trong lúc chờ
        print(f"{tag} [5] Đợi redirect /app ...")
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if "/app" in (page.url or "") or "dashboard" in (page.url or ""):
                break
            # Check verify / invalid account xuất hiện muộn
            for pg in ctx.pages:
                if "google" not in (pg.url or ""):
                    continue
                try:
                    body_text = (await pg.evaluate("() => document.body?.innerText || ''")).lower()
                    if any(kw in body_text for kw in _VERIFY_TEXTS):
                        raise RuntimeError("VERIFY_REQUIRED")
                    if any(kw in body_text for kw in _INVALID_ACCOUNT_TEXTS):
                        raise RuntimeError("INVALID_ACCOUNT: Tài khoản không hợp lệ hoặc bị chặn")
                except RuntimeError:
                    raise
                except Exception:
                    pass
            await asyncio.sleep(1)
        else:
            raise RuntimeError("Timeout 60s đợi redirect /app")

        print(f"{tag} Đăng nhập OK")

        # 6. Lấy API key
        print(f"{tag} [6] Lấy API key ...")
        api_key = await _get_api_key(page, email)
        if api_key:
            print(f"{tag} Key: {api_key[:12]}...")
            result["api_key"] = api_key
        else:
            print(f"{tag} Không lấy được key tự động")

        result["ok"] = True

    except RuntimeError as e:
        msg = str(e)
        if "VERIFY_REQUIRED" in msg:
            result["error"] = "VERIFY_REQUIRED"
            print(f"{tag} ⚠ Cần xác minh — tắt browser")
        elif "INVALID_ACCOUNT" in msg:
            detail = msg.replace("INVALID_ACCOUNT: ", "")
            result["error"] = f"INVALID_ACCOUNT: {detail}"
            print(f"{tag} ✗ {detail} — tắt browser")
        else:
            result["error"] = msg
            print(f"{tag} LỖI: {msg}")
    except Exception as e:
        result["error"] = str(e)
        print(f"{tag} LỖI: {e}")
    finally:
        await asyncio.sleep(3)
        for obj in (ctx, browser):
            if obj:
                try:
                    await obj.close()
                except Exception:
                    pass

    return result


async def run_batch(lines: list[str], workers: int):
    sem = asyncio.Semaphore(workers)
    accounts = load_accounts()
    results = []

    async def _run(idx: int, line: str):
        parts = line.split("|", 1)
        if len(parts) != 2:
            print(f"[!] Sai định dạng: {line}")
            return
        email, password = parts[0].strip(), parts[1].strip()
        async with sem:
            r = await login_one(email, password, slot=idx)
        results.append(r)

        with _write_lock:
            # Cập nhật accounts.json
            existing = next((a for a in accounts if a.get("email") == email), None)
            if existing:
                existing.update({"ok": r["ok"], "error": r["error"]})
                if r["api_key"]:
                    existing["api_key"] = r["api_key"]
            else:
                accounts.append({"email": email, "ok": r["ok"], "api_key": r["api_key"], "error": r["error"]})
            save_accounts(accounts)

    tasks = [asyncio.create_task(_run(i, line)) for i, line in enumerate(lines)]
    await asyncio.gather(*tasks)

    ok_list      = [r for r in results if r.get("ok")]
    verify_list  = [r for r in results if r.get("error") == "VERIFY_REQUIRED"]
    invalid_list = [r for r in results if not r.get("ok") and str(r.get("error","")).startswith("INVALID_ACCOUNT")]
    fail_list    = [r for r in results if not r.get("ok")
                    and r.get("error") != "VERIFY_REQUIRED"
                    and not str(r.get("error","")).startswith("INVALID_ACCOUNT")]

    # Ghi error.txt
    error_lines = []
    for r in verify_list:
        error_lines.append(f"[VERIFY]  {r['email']}")
    for r in invalid_list:
        detail = str(r.get("error","")).replace("INVALID_ACCOUNT: ", "")
        error_lines.append(f"[INVALID] {r['email']} — {detail}")
    for r in fail_list:
        error_lines.append(f"[FAIL]    {r['email']} — {r.get('error','')}")
    if error_lines:
        with _write_lock:
            with open(ERROR_PATH, "a", encoding="utf-8") as f:
                f.write("\n".join(error_lines) + "\n")
        print(f"\nĐã ghi {len(error_lines)} tài khoản lỗi vào error.txt")

    # Báo cáo cuối
    new_keys = load_existing_keys()
    sep = "=" * 55
    print(f"\n{sep}")
    print(f"  KẾT QUẢ ĐĂNG NHẬP")
    print(sep)
    print(f"  Tổng tài khoản      : {len(results)}")
    print(f"  ✓ Thành công        : {len(ok_list)}")
    print(f"  ⚠ Cần xác minh     : {len(verify_list)}")
    print(f"  ✗ Sai email/pass    : {len(invalid_list)}")
    print(f"  ✗ Lỗi khác          : {len(fail_list)}")
    print(f"  API key đã lưu      : {len(new_keys)} (api_keys.txt)")
    if verify_list:
        print(f"\n  Tài khoản cần xác minh:")
        for r in verify_list:
            print(f"    - {r['email']}")
    if invalid_list:
        print(f"\n  Sai email/mật khẩu:")
        for r in invalid_list:
            detail = str(r.get("error","")).replace("INVALID_ACCOUNT: ", "")
            print(f"    - {r['email']}: {detail}")
    if fail_list:
        print(f"\n  Lỗi khác:")
        for r in fail_list:
            print(f"    - {r['email']}: {r.get('error','')[:60]}")
    print(sep)


def main():
    try:
        import cloakbrowser  # noqa: F401
    except ImportError:
        print("Thiếu CloakBrowser.")
        sys.exit(1)

    print("=" * 50)
    print("  GenMax Login — CloakBrowser")
    print("=" * 50)

    print("\nPaste tài khoản (email|password), một dòng mỗi tài khoản.")
    print("Xong nhấn Enter hai lần:\n")
    raw = []
    while True:
        line = input()
        if not line.strip():
            break
        raw.append(line.strip())
    lines = [l for l in raw if "|" in l]

    if not lines:
        print("Không có tài khoản nào. Thoát.")
        return

    workers_raw = input(f"\nSố luồng chạy đồng thời (Enter = 1): ").strip()
    try:
        workers = max(1, int(workers_raw))
    except ValueError:
        workers = 1
    print(f"Chạy {len(lines)} tài khoản, {workers} luồng đồng thời\n")

    asyncio.run(run_batch(lines, workers))


if __name__ == "__main__":
    main()
