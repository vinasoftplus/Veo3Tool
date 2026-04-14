"""
Test lấy access_token từ cookie Google bằng Chrome thật (Selenium + CDP).
"""
import re
import time
import json
import sys
import threading

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

# ─── Lấy cookie string ────────────────────────────────────────────────────────
print("=" * 60)
print("TEST: Lấy access_token từ cookie Google qua Chrome thật")
print("=" * 60)
print()
print("Dán cookie string vào đây (Enter 2 lần để xong):")
lines = []
while True:
    try:
        line = input()
        if line == "" and lines and lines[-1] == "":
            break
        lines.append(line)
    except EOFError:
        break
cookie_string = " ".join(l.strip() for l in lines if l.strip())

if not cookie_string:
    print("Cookie trống, thoát.")
    sys.exit(1)

print(f"\n[OK] Nhận được cookie ({len(cookie_string)} chars)")

# ─── Parse cookie ─────────────────────────────────────────────────────────────
def parse_cookies(s: str) -> list:
    cookies = []
    for part in s.split(";"):
        part = part.strip()
        if "=" in part:
            key, _, val = part.partition("=")
            cookies.append({"name": key.strip(), "value": val.strip()})
    return cookies

cookies = parse_cookies(cookie_string)
print(f"[OK] Parse được {len(cookies)} cookies")

# ─── Khởi động Chrome với CDP logging ─────────────────────────────────────────
opts = Options()
opts.add_argument("--start-maximized")
opts.add_argument("--disable-blink-features=AutomationControlled")
opts.add_experimental_option("excludeSwitches", ["enable-automation"])
opts.add_experimental_option("useAutomationExtension", False)
# Bật performance logging để capture network events
opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})

print("\n[1] Khởi động Chrome...")
try:
    driver = webdriver.Chrome(options=opts)
except Exception as e:
    print(f"Lỗi mở Chrome: {e}")
    sys.exit(1)

driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
    "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
})

# ─── Enable CDP Network để intercept responses ────────────────────────────────
driver.execute_cdp_cmd("Network.enable", {})

try:
    # In tên cookies để debug
    print(f"[DEBUG] Tên cookies: {[c['name'] for c in cookies]}")

    # ─── Set cookie cho accounts.google.com trước ────────────────────────────
    print("[2a] Set cookies cho accounts.google.com...")
    driver.get("https://accounts.google.com")
    time.sleep(2)
    driver.delete_all_cookies()

    # Set TẤT CẢ cookies cho google.com (không lọc)
    set_count = 0
    for c in cookies:
        for domain in [".google.com", "accounts.google.com"]:
            try:
                driver.add_cookie({
                    "name": c["name"],
                    "value": c["value"],
                    "domain": domain,
                    "path": "/",
                    "secure": True,
                })
                set_count += 1
                break
            except Exception as ex:
                pass

    print(f"[OK] Set {set_count} cookies cho google.com")

    # ─── Set cookie cho labs.google ───────────────────────────────────────────
    print("[2b] Set cookies cho labs.google...")
    driver.get("https://labs.google/fx/tools/flow")
    time.sleep(2)

    set_count2 = 0
    for c in cookies:
        for domain in ["labs.google", ".labs.google"]:
            try:
                driver.add_cookie({
                    "name": c["name"],
                    "value": c["value"],
                    "domain": domain,
                    "path": "/",
                    "secure": c["name"].startswith("__Secure-") or c["name"].startswith("__Host-"),
                })
                set_count2 += 1
                break
            except Exception:
                pass

    print(f"[OK] Set {set_count2} cookies cho labs.google")

    # ─── Lấy CSRF token ───────────────────────────────────────────────────────
    print("[3] Lấy CSRF token...")
    driver.get("https://labs.google/fx/api/auth/csrf")
    time.sleep(2)
    body = driver.find_element(By.TAG_NAME, "body").text
    print(f"    CSRF response: {body[:100]}")
    m = re.search(r'"csrfToken"\s*:\s*"([^"]+)"', body)
    if not m:
        print("FAIL: Không lấy được CSRF")
        input("Enter để thoát...")
        sys.exit(1)
    csrf_token = m.group(1)
    print(f"[OK] CSRF: {csrf_token[:20]}...")

    # ─── POST signin bằng form submit + intercept page source ────────────────
    print("[4] POST signin/google via form submit...")

    # Submit form — server sẽ redirect browser đến /signin?csrf=true
    # nhưng page source tại đó chứa JSON {"url":"https://accounts.google.com/..."}
    driver.execute_script(f"""
        window.__intercepted = null;
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = 'https://labs.google/fx/api/auth/signin/google';
        form.style.display = 'none';
        const addF = (n, v) => {{
            const i = document.createElement('input');
            i.type = 'hidden'; i.name = n; i.value = v;
            form.appendChild(i);
        }};
        addF('callbackUrl', 'https://labs.google/fx/tools/flow');
        addF('csrfToken', '{csrf_token}');
        addF('json', 'true');
        document.body.appendChild(form);
        form.submit();
    """)

    # Chờ browser navigate đến /signin?csrf=true (trang chứa JSON)
    print("    Chờ redirect đến trang signin...")
    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.5)
        if "signin" in driver.current_url and "csrf" in driver.current_url:
            break

    time.sleep(1)  # Chờ page load xong
    print(f"    URL hiện tại: {driver.current_url}")

    # Lấy page source — chứa JSON {"url":"https://accounts.google.com/..."}
    body_text = driver.find_element(By.TAG_NAME, "body").text
    print(f"    Body: {body_text[:300]}")

    # Parse Google OAuth URL
    google_url = None
    try:
        data = json.loads(body_text)
        google_url = data.get("url", "")
    except Exception:
        pass
    if not google_url:
        um = re.search(r'"url"\s*:\s*"([^"]+)"', body_text)
        if um:
            google_url = um.group(1).replace("\\u0026", "&").replace("\\/", "/")

    if not google_url:
        print(f"\nKhông lấy được Google URL. Body:")
        print(body_text[:500])
        input("Enter để thoát...")
        sys.exit(1)

    # Unescape
    google_url = google_url.replace("\\u0026", "&").replace("\\/", "/")
    print(f"\n[OK] Google OAuth URL: {google_url[:120]}...")

    # ─── Navigate đến Google OAuth ────────────────────────────────────────────
    print("\n[5] Navigate Chrome đến Google OAuth URL...")
    driver.get(google_url)

    # Chờ redirect về labs.google callback
    print("[6] Chờ Google redirect về labs.google callback...")
    access_token = None
    deadline = time.time() + 30
    prev_url = ""

    while time.time() < deadline:
        time.sleep(1)
        current = driver.current_url
        if current != prev_url:
            print(f"    URL: {current[:120]}")
            prev_url = current

            # Check token trong URL (fragment hoặc query)
            m = re.search(r'[?&#]access_token=([^&"\'<\s]+)', current)
            if m:
                access_token = m.group(1)
                print(f"[OK] Token trong URL!")
                break

            # Đã về labs.google callback
            if "labs.google" in current and "callback" in current:
                print("    Đang ở callback, chờ thêm...")
                time.sleep(3)
                # Check performance logs cho network responses
                logs = driver.get_log("performance")
                for entry in logs:
                    msg = json.loads(entry["message"])
                    method = msg.get("message", {}).get("method", "")
                    if method == "Network.responseReceived":
                        resp_url = msg["message"]["params"]["response"]["url"]
                        if "access_token" in resp_url:
                            m2 = re.search(r'access_token=([^&"\'<\s]+)', resp_url)
                            if m2:
                                access_token = m2.group(1)
                                print(f"[OK] Token từ network log: {resp_url[:80]}")
                                break
                if access_token:
                    break

            # Đã về flow page
            if "labs.google/fx/tools/flow" in current:
                print("    Đã về flow page!")
                time.sleep(2)
                break

            # Nếu Google hỏi chọn account (consent screen)
            if "accounts.google.com" in current:
                print("    ⚠ Google đang hiển thị consent/login screen!")
                print("    Cookie Google có thể chưa được set đúng domain")
                print("    Thử chờ thêm hoặc cần thêm cookie accounts.google.com...")

    # ─── Tìm access_token trong page source và localStorage ──────────────────
    if not access_token:
        # Check current URL lần nữa
        final_url = driver.current_url
        m = re.search(r'[?&#]access_token=([^&"\'<\s]+)', final_url)
        if m:
            access_token = m.group(1)

    if not access_token:
        # Check page source
        try:
            src = driver.page_source
            for pattern in [
                r'"access_token"\s*:\s*"(ya29\.[^"]+)"',
                r'"access_token"\s*:\s*"([^"]+)"',
                r'access_token[=:]["\'\\]*(ya29\.[^&"\'<\s\\]+)',
            ]:
                m = re.search(pattern, src)
                if m:
                    access_token = m.group(1)
                    print(f"[OK] Token trong page source!")
                    break
        except Exception:
            pass

    if not access_token:
        # Check nextauth session cookie
        all_cookies = driver.get_cookies()
        session_cookie = next((c for c in all_cookies if "session-token" in c["name"]), None)
        if session_cookie:
            session_val = session_cookie["value"]
            print(f"\n__Secure-next-auth.session-token: {session_val[:100]}...")
            # JWT decode (base64 middle part)
            parts = session_val.split(".")
            if len(parts) >= 2:
                import base64
                try:
                    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
                    payload = json.loads(base64.urlsafe_b64decode(padded))
                    print(f"Session payload: {json.dumps(payload, indent=2)[:400]}")
                    at = payload.get("accessToken") or payload.get("access_token")
                    if at:
                        access_token = at
                        print("[OK] Token trong session JWT!")
                except Exception as e:
                    print(f"JWT decode fail: {e}")

    if not access_token:
        # Check network performance logs cho redirect URLs
        print("\nKiểm tra network logs...")
        try:
            logs = driver.get_log("performance")
            for entry in logs[-100:]:
                try:
                    msg = json.loads(entry["message"])
                    params = msg.get("message", {}).get("params", {})
                    # Check redirectResponse
                    redir = params.get("redirectResponse", {})
                    redir_url = redir.get("url", "")
                    if "access_token" in redir_url:
                        m = re.search(r'access_token=([^&"\'<\s]+)', redir_url)
                        if m:
                            access_token = m.group(1)
                            print(f"[OK] Token từ redirect URL: {redir_url[:100]}")
                            break
                    # Check request URL
                    req_url = params.get("request", {}).get("url", "")
                    if "access_token" in req_url:
                        m = re.search(r'access_token=([^&"\'<\s]+)', req_url)
                        if m:
                            access_token = m.group(1)
                            print(f"[OK] Token từ request URL: {req_url[:100]}")
                            break
                except Exception:
                    pass
        except Exception as e:
            print(f"Log error: {e}")

    # ─── Kết quả ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    if access_token:
        print(f"SUCCESS! Access token: {access_token[:60]}...")
        with open("access_token_result.txt", "w") as f:
            f.write(access_token)
        print("Đã lưu vào access_token_result.txt")
    else:
        print("FAIL: Không tìm thấy access_token")
        print(f"Final URL: {driver.current_url}")
        # Show cookies
        cks = driver.get_cookies()
        print(f"Cookies: {[c['name'] for c in cks]}")
    print("=" * 60)

except Exception as e:
    print(f"\nLỗi: {e}")
    import traceback
    traceback.print_exc()

finally:
    input("\nNhấn Enter để đóng Chrome...")
    driver.quit()
