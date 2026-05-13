#!/usr/bin/env python
"""
Standalone Grok cookie tester.

Usage:
  python scripts/test_grok_cookie.py
  python scripts/test_grok_cookie.py --cookie "sso=...; sso-rw=...; x-userid=..."
  set GROK_COOKIE=sso=...; sso-rw=...; x-userid=...
  python scripts/test_grok_cookie.py --verbose

This script does not use Chrome or an extension. It checks whether a raw
Grok cookie can authenticate against grok.com private web endpoints.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import re
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx


GROK_ORIGIN = "https://grok.com"
GROK_IMAGINE = "https://grok.com/imagine"
GROK_C = "https://grok.com/c"
GROK_NEXT_CHUNKS = "https://grok.com/_next/static/chunks/"
RATE_LIMITS_URL = "https://grok.com/rest/rate-limits"
CONVERSATION_URL = "https://grok.com/rest/app-chat/conversations/new"


DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/147.0.0.0 Safari/537.36"
)


@dataclass
class CheckResult:
    name: str
    ok: bool
    status: int | None = None
    content_type: str = ""
    error: str = ""
    detail: Any = None


def parse_cookie(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    cleaned = normalize_cookie(str(raw or ""))
    if cleaned.lower().startswith("cookie:"):
        cleaned = cleaned.split(":", 1)[1].strip()
    for part in cleaned.split(";"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out


def normalize_cookie(raw: str) -> str:
    cleaned = str(raw or "").strip().replace("\r", "").replace("\n", "")
    # Remove non-printable control characters that make HTTP Cookie invalid.
    cleaned = "".join(ch for ch in cleaned if ch == "\t" or ord(ch) >= 32)
    if cleaned.lower().startswith("cookie:"):
        cleaned = cleaned.split(":", 1)[1].strip()
    return cleaned


def mask_cookie(raw: str) -> str:
    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        val = match.group(2)
        if len(val) <= 8:
            masked = "***"
        else:
            masked = f"{val[:4]}...{val[-4:]}({len(val)})"
        return f"{key}={masked}"

    return re.sub(
        r"(auth_token|ct0|SNId|sso|sso-rw|x-userid|cf_clearance|__cf_bm)=([^;\s]+)",
        repl,
        str(raw or ""),
    )


def detect_cookie_format(cookie_map: dict[str, str]) -> tuple[str, list[str]]:
    """Return cookie format label and missing recommended fields."""
    if cookie_map.get("auth_token"):
        missing = [key for key in ("auth_token", "ct0", "SNId") if not cookie_map.get(key)]
        return "x_auth_token", missing

    # Newer grok.com sessions commonly expose sso/sso-rw instead of auth_token.
    if cookie_map.get("sso") or cookie_map.get("sso-rw"):
        missing = [key for key in ("sso", "sso-rw", "x-userid", "cf_clearance") if not cookie_map.get(key)]
        return "grok_sso", missing

    return "unknown", ["auth_token or sso/sso-rw"]


def base_headers(cookie: str, statsig_id: str = "") -> dict[str, str]:
    cookie = normalize_cookie(cookie)
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Origin": GROK_ORIGIN,
        "Referer": GROK_IMAGINE,
        "User-Agent": DEFAULT_UA,
        "Cookie": cookie,
        "Sec-CH-UA": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    cookie_map = parse_cookie(cookie)
    if cookie_map.get("ct0"):
        headers["X-CSRF-Token"] = cookie_map["ct0"]
    if statsig_id:
        headers["X-Statsig-Id"] = statsig_id
    return headers


def classify_html(text: str) -> str:
    lower = (text or "").lower()
    if "cloudflare" in lower or "cf-chl" in lower:
        return "CHALLENGE_CLOUDFLARE"
    if "sign in" in lower or "log in" in lower or "login" in lower:
        return "LOGIN_PAGE"
    if "grok-site-verification" in lower:
        return "GROK_SITE_VERIFICATION"
    if "challenge" in lower and "signature" in lower:
        return "GROK_CHALLENGE"
    return "HTML"


def extract_statsig_from_text(text: str) -> str:
    patterns = [
        r'"x-statsig-id"\s*:\s*"([^"]+)"',
        r"'x-statsig-id'\s*:\s*'([^']+)'",
        r"x-statsig-id['\"]?\s*[,=:]\s*['\"]([^'\"]+)",
        r"localStorage\.setItem\(['\"]x-statsig-id['\"],\s*['\"]([^'\"]+)",
    ]
    for pat in patterns:
        m = re.search(pat, text or "", re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return ""


def extract_bootstrap_artifacts(text: str) -> dict[str, Any]:
    """Extract non-secret Grok bootstrap artifacts visible in HTML/JS."""
    text = text or ""
    scripts = []
    for match in re.finditer(r'<script[^>]+src=["\']([^"\']+)["\']', text, re.IGNORECASE):
        src = match.group(1).strip()
        if src:
            scripts.append(urljoin(GROK_ORIGIN, src))

    next_actions = sorted(
        set(
            re.findall(r'["\']?Next-Action["\']?\s*[:=]\s*["\']([a-f0-9]{16,})["\']', text, re.IGNORECASE)
            + re.findall(r'createServerReference\)\(["\']([a-f0-9]{16,})["\']\)', text, re.IGNORECASE)
            + re.findall(r'next-action[^a-f0-9]+([a-f0-9]{16,})', text, re.IGNORECASE)
        )
    )

    meta = ""
    m = re.search(
        r'<meta[^>]+name=["\']grok-site-verification["\'][^>]+content=["\']([^"\']+)["\']',
        text,
        re.IGNORECASE,
    )
    if not m:
        m = re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']grok-site-verification["\']',
            text,
            re.IGNORECASE,
        )
    if m:
        meta = m.group(1).strip()

    anon_user = ""
    m = re.search(r'"anonUserId"\s*:\s*"([^"]+)"', text)
    if m:
        anon_user = m.group(1).strip()

    challenge = ""
    signature = ""
    m = re.search(r'"challenge"\s*:\s*"([^"]+)"', text)
    if m:
        challenge = m.group(1).strip()
    m = re.search(r'"signature"\s*:\s*"([^"]+)"', text)
    if m:
        signature = m.group(1).strip()

    statsig = extract_statsig_from_text(text)
    return {
        "statsig_found": bool(statsig),
        "statsig_len": len(statsig) if statsig else 0,
        "grok_site_verification_found": bool(meta),
        "grok_site_verification_len": len(meta) if meta else 0,
        "next_action_count": len(next_actions),
        "next_actions": next_actions[:5],
        "script_count": len(scripts),
        "chunk_scripts": [s for s in scripts if "/_next/static/chunks/" in s or "cdn.grok.com/_next/static/chunks/" in s][:10],
        "anon_user_found": bool(anon_user),
        "challenge_found": bool(challenge),
        "challenge_len": len(challenge) if challenge else 0,
        "signature_found": bool(signature),
        "signature_len": len(signature) if signature else 0,
    }


def compact_body_preview(text: str, limit: int = 500) -> str:
    one_line = re.sub(r"\s+", " ", text or "").strip()
    if len(one_line) > limit:
        return one_line[:limit] + "..."
    return one_line


def curl_cffi_available() -> bool:
    try:
        import curl_cffi  # noqa: F401

        return True
    except Exception:
        return False


def curl_request(
    method: str,
    url: str,
    headers: dict[str, str],
    *,
    payload: dict[str, Any] | None = None,
    impersonate: str = "chrome124",
    timeout: int = 60,
) -> tuple[int, str, str]:
    from curl_cffi import requests as curl_requests

    method = method.upper()
    with curl_requests.Session(impersonate=impersonate, timeout=timeout) as session:
        if method == "GET":
            res = session.get(url, headers=headers, allow_redirects=True)
        elif method == "POST":
            res = session.post(url, headers=headers, json=payload, allow_redirects=True)
        else:
            raise ValueError(f"Unsupported method: {method}")
        ctype = res.headers.get("content-type", "")
        return int(res.status_code), str(ctype), str(res.text or "")


async def curl_fetch_text(
    method: str,
    url: str,
    headers: dict[str, str],
    *,
    payload: dict[str, Any] | None = None,
    impersonate: str = "chrome124",
) -> tuple[int, str, str]:
    return await asyncio.to_thread(curl_request, method, url, headers, payload=payload, impersonate=impersonate)


async def fetch_text(client: httpx.AsyncClient, url: str, headers: dict[str, str]) -> tuple[int, str, str]:
    res = await client.get(url, headers=headers)
    ctype = res.headers.get("content-type", "")
    return res.status_code, ctype, res.text


async def check_page(client: httpx.AsyncClient, cookie: str, verbose: bool) -> tuple[CheckResult, str]:
    headers = base_headers(cookie)
    headers.update(
        {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Upgrade-Insecure-Requests": "1",
        }
    )
    try:
        status, ctype, text = await fetch_text(client, GROK_IMAGINE, headers)
    except Exception as exc:
        return CheckResult("GET /imagine", False, error=str(exc)), ""

    statsig = extract_statsig_from_text(text)
    if status in (200, 307, 308) and "text/html" in ctype:
        label = classify_html(text)
        ok = label not in {"LOGIN_PAGE", "CHALLENGE_CLOUDFLARE"}
        detail = {"html_type": label, "statsig_found": bool(statsig)}
        if verbose:
            detail["preview"] = compact_body_preview(text)
        return CheckResult("GET /imagine", ok, status, ctype, detail=detail), statsig

    return (
        CheckResult(
            "GET /imagine",
            False,
            status,
            ctype,
            detail={"preview": compact_body_preview(text) if verbose else ""},
        ),
        statsig,
    )


async def check_bootstrap_c(client: httpx.AsyncClient, cookie: str, verbose: bool) -> tuple[CheckResult, str]:
    headers = base_headers(cookie)
    headers.update(
        {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
    )
    try:
        status, ctype, text = await fetch_text(client, GROK_C, headers)
    except Exception as exc:
        return CheckResult("GET /c", False, error=str(exc)), ""

    statsig = extract_statsig_from_text(text)
    label = classify_html(text) if "text/html" in ctype else "NON_HTML"
    detail = {"html_type": label, **extract_bootstrap_artifacts(text)}
    if verbose:
        detail["preview"] = compact_body_preview(text)
    ok = status == 200 and label not in {"LOGIN_PAGE", "CHALLENGE_CLOUDFLARE"}
    return CheckResult("GET /c bootstrap", ok, status, ctype, detail=detail), statsig


async def check_curl_bootstrap(cookie: str, verbose: bool, impersonate: str) -> tuple[list[CheckResult], str]:
    results: list[CheckResult] = []
    statsig = ""

    page_headers = base_headers(cookie)
    page_headers.update(
        {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Upgrade-Insecure-Requests": "1",
        }
    )

    try:
        status, ctype, text = await curl_fetch_text("GET", GROK_IMAGINE, page_headers, impersonate=impersonate)
        statsig = extract_statsig_from_text(text) or statsig
        label = classify_html(text) if "text/html" in ctype else "NON_HTML"
        detail = {"html_type": label, **extract_bootstrap_artifacts(text)}
        if verbose:
            detail["preview"] = compact_body_preview(text)
        results.append(CheckResult("curl GET /imagine", status == 200 and label != "CHALLENGE_CLOUDFLARE", status, ctype, detail=detail))
    except Exception as exc:
        results.append(CheckResult("curl GET /imagine", False, error=str(exc)))

    c_headers = base_headers(cookie)
    c_headers.update(
        {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
    )

    c_text = ""
    try:
        status, ctype, c_text = await curl_fetch_text("GET", GROK_C, c_headers, impersonate=impersonate)
        statsig = extract_statsig_from_text(c_text) or statsig
        label = classify_html(c_text) if "text/html" in ctype else "NON_HTML"
        detail = {"html_type": label, **extract_bootstrap_artifacts(c_text)}
        if verbose:
            detail["preview"] = compact_body_preview(c_text)
        results.append(CheckResult("curl GET /c bootstrap", status == 200 and label != "CHALLENGE_CLOUDFLARE", status, ctype, detail=detail))
    except Exception as exc:
        results.append(CheckResult("curl GET /c bootstrap", False, error=str(exc)))

    # If /c gives us chunk scripts, fetch a few and try to extract dynamic action/statsig artifacts.
    artifacts = extract_bootstrap_artifacts(c_text)
    script_hits: list[dict[str, Any]] = []
    for script_url in artifacts.get("chunk_scripts", [])[:5]:
        try:
            h = base_headers(cookie)
            h.update({"Accept": "*/*", "Referer": GROK_C, "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors"})
            s_status, s_ctype, s_text = await curl_fetch_text("GET", script_url, h, impersonate=impersonate)
            s_artifacts = extract_bootstrap_artifacts(s_text)
            if s_artifacts.get("next_action_count") or s_artifacts.get("statsig_found"):
                script_hits.append(
                    {
                        "url": script_url,
                        "status": s_status,
                        "content_type": s_ctype,
                        **s_artifacts,
                    }
                )
                statsig = extract_statsig_from_text(s_text) or statsig
        except Exception as exc:
            script_hits.append({"url": script_url, "error": str(exc)})
    if artifacts.get("chunk_scripts"):
        results.append(
            CheckResult(
                "curl fetch _next chunks",
                bool(script_hits),
                detail={"checked": min(len(artifacts.get("chunk_scripts", [])), 5), "hits": script_hits},
            )
        )

    rate_headers = base_headers(cookie, statsig)
    try:
        status, ctype, text = await curl_fetch_text("GET", RATE_LIMITS_URL, rate_headers, impersonate=impersonate)
        if "application/json" in ctype:
            try:
                data = json.loads(text)
            except Exception:
                data = None
            detail = data if verbose or status != 200 else summarize_json(data)
            results.append(CheckResult("curl GET /rest/rate-limits", status == 200, status, ctype, detail=detail))
        else:
            detail = {"html_type": classify_html(text)}
            if verbose:
                detail["preview"] = compact_body_preview(text)
            results.append(CheckResult("curl GET /rest/rate-limits", False, status, ctype, detail=detail))
    except Exception as exc:
        results.append(CheckResult("curl GET /rest/rate-limits", False, error=str(exc)))

    return results, statsig


async def check_rate_limits(client: httpx.AsyncClient, cookie: str, statsig_id: str, verbose: bool) -> CheckResult:
    headers = base_headers(cookie, statsig_id)
    try:
        res = await client.get(RATE_LIMITS_URL, headers=headers)
    except Exception as exc:
        return CheckResult("GET /rest/rate-limits", False, error=str(exc))

    ctype = res.headers.get("content-type", "")
    if "application/json" in ctype:
        try:
            data = res.json()
        except Exception:
            data = None
        return CheckResult(
            "GET /rest/rate-limits",
            res.status_code == 200,
            res.status_code,
            ctype,
            detail=data if verbose or res.status_code != 200 else summarize_json(data),
        )

    text = res.text
    return CheckResult(
        "GET /rest/rate-limits",
        False,
        res.status_code,
        ctype,
        detail={"html_type": classify_html(text), "preview": compact_body_preview(text) if verbose else ""},
    )


def summarize_json(data: Any) -> Any:
    if isinstance(data, dict):
        keys = list(data.keys())
        return {"keys": keys[:20], "raw_type": "object"}
    if isinstance(data, list):
        return {"len": len(data), "raw_type": "array"}
    return data


async def check_conversation_probe(client: httpx.AsyncClient, cookie: str, statsig_id: str, verbose: bool) -> CheckResult:
    headers = base_headers(cookie, statsig_id)
    headers.update(
        {
            "Content-Type": "application/json",
            "X-Xai-Request-Id": str(uuid.uuid4()),
        }
    )
    payload = {
        "temporary": True,
        "modelName": "grok-3",
        "message": "ping",
        "toolOverrides": {},
        "enableSideBySide": True,
        "responseMetadata": {"experiments": [], "modelConfigOverride": {"modelMap": {}}},
    }
    try:
        res = await client.post(CONVERSATION_URL, headers=headers, json=payload)
    except Exception as exc:
        return CheckResult("POST /conversations/new probe", False, error=str(exc))

    ctype = res.headers.get("content-type", "")
    text = res.text
    # This probe may fail because payload is intentionally minimal. The point is
    # to classify auth/challenge vs payload/model errors without spending video quota.
    auth_ok = res.status_code not in {401, 403}
    detail = {
        "status_meaning": "auth_ok_payload_may_be_invalid" if auth_ok else "auth_failed_or_forbidden",
        "preview": compact_body_preview(text, 800) if verbose or not auth_ok else "",
    }
    return CheckResult("POST /conversations/new probe", auth_ok, res.status_code, ctype, detail=detail)


def print_result(result: CheckResult) -> None:
    mark = "OK" if result.ok else "FAIL"
    status = f" status={result.status}" if result.status is not None else ""
    ctype = f" ctype={result.content_type}" if result.content_type else ""
    print(f"[{mark}] {result.name}{status}{ctype}")
    if result.error:
        print(f"  error: {result.error}")
    if result.detail not in (None, "", {}):
        rendered = json.dumps(result.detail, ensure_ascii=False, indent=2)
        print(f"  detail: {rendered}")


async def run(args: argparse.Namespace) -> int:
    cookie = args.cookie or ""
    if args.cookie_file:
        try:
            cookie = Path(args.cookie_file).read_text(encoding="utf-8").strip()
        except Exception as exc:
            print(f"Cannot read cookie file: {exc}")
            return 2
    if not cookie:
        import os

        cookie = os.environ.get("GROK_COOKIE", "")
    if not cookie:
        cookie = getpass.getpass("Paste Grok cookie (hidden): ").strip()

    cookie = normalize_cookie(cookie)
    if not cookie:
        print("Missing cookie.")
        return 2

    cookie_map = parse_cookie(cookie)
    cookie_format, missing = detect_cookie_format(cookie_map)
    print(f"Cookie: {mask_cookie(cookie)}")
    print(f"Cookie format: {cookie_format}")
    print(f"Cookie keys: {', '.join(list(cookie_map.keys())[:30]) or '(none)'}")
    if missing:
        print(f"[WARN] Missing cookie field(s): {', '.join(missing)}")
    if args.transport in {"curl", "both"} and not curl_cffi_available():
        print("[FAIL] curl_cffi is not installed. Install with: py -m pip install curl_cffi")
        if args.transport == "curl":
            return 2

    results: list[CheckResult] = []
    statsig = args.statsig or ""

    if args.transport in {"httpx", "both"}:
        timeout = httpx.Timeout(connect=20, read=60, write=30, pool=30)
        try:
            client = httpx.AsyncClient(timeout=timeout, follow_redirects=True, http2=True)
        except ImportError:
            print("[WARN] Package h2 is not installed, falling back to HTTP/1.1.")
            client = httpx.AsyncClient(timeout=timeout, follow_redirects=True, http2=False)

        async with client:
            page_result, statsig_1 = await check_page(client, cookie, args.verbose)
            results.append(page_result)

            c_result, statsig_2 = await check_bootstrap_c(client, cookie, args.verbose)
            results.append(c_result)

            statsig = statsig or statsig_1 or statsig_2
            if statsig:
                print(f"X-Statsig-Id: {statsig[:8]}...({len(statsig)})")
            else:
                print("[WARN] X-Statsig-Id not found from /imagine or /c.")

            results.append(await check_rate_limits(client, cookie, statsig, args.verbose))

            if args.probe_conversation:
                results.append(await check_conversation_probe(client, cookie, statsig, args.verbose))

    if args.transport in {"curl", "both"} and curl_cffi_available():
        print(f"curl_cffi transport: impersonate={args.impersonate}")
        curl_results, curl_statsig = await check_curl_bootstrap(cookie, args.verbose, args.impersonate)
        results.extend(curl_results)
        statsig = statsig or curl_statsig
        if curl_statsig:
            print(f"curl X-Statsig-Id: {curl_statsig[:8]}...({len(curl_statsig)})")

    print("")
    for result in results:
        print_result(result)

    if any(r.ok for r in results):
        return 0
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Test Grok cookie without Chrome tab.")
    parser.add_argument("--cookie", default="", help="Raw Grok cookie. Prefer env GROK_COOKIE to avoid shell history.")
    parser.add_argument("--cookie-file", default="", help="Path to a txt file containing the raw Grok cookie.")
    parser.add_argument("--statsig", default="", help="Optional known x-statsig-id.")
    parser.add_argument("--transport", choices=["httpx", "curl", "both"], default="httpx", help="HTTP transport to test.")
    parser.add_argument("--impersonate", default="chrome124", help="curl_cffi browser impersonation profile.")
    parser.add_argument("--probe-conversation", action="store_true", help="Send a minimal conversations/new probe.")
    parser.add_argument("--verbose", action="store_true", help="Print response previews/details.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
