"""Test cookie_token_service dùng requests (không Selenium)."""
import sys
import asyncio
sys.path.insert(0, ".")

from services.cookie_token_service import get_token_from_cookie_sync

print("Dán cookie string (Enter 2 lần để xong):")
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

try:
    result = get_token_from_cookie_sync(cookie_string, log=print)
    print(f"\nSUCCESS!")
    print(f"Token: {result['access_token'][:50]}...")
    print(f"Email: {result['email']}")
    print(f"Project: {result['project_id']}")
except Exception as e:
    print(f"\nFAIL: {e}")
