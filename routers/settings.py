"""Settings routes — config, accounts."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

from services.config_service import (
    load_config, save_config, get_all_accounts, save_account
)

router = APIRouter(tags=["settings"])


class SaveConfigRequest(BaseModel):
    config: dict


class SaveAccountRequest(BaseModel):
    index: int
    account: dict


@router.get("/config")
async def get_config():
    cfg = load_config()
    # Sanitize: mask tokens for display
    safe = dict(cfg)
    for key in list(safe.keys()):
        if key.startswith("account"):
            acc = dict(safe[key])
            if acc.get("ACCESS_TOKEN"):
                acc["ACCESS_TOKEN"] = acc["ACCESS_TOKEN"][:20] + "..."
            if acc.get("COOKIE"):
                acc["COOKIE"] = "[set]"
            safe[key] = acc
    return {"ok": True, "data": safe}


@router.get("/config-full")
async def get_config_full():
    return {"ok": True, "data": load_config()}


@router.post("/config")
async def save_config_route(req: SaveConfigRequest):
    _ALLOWED_CONFIG_KEYS = {
        "GEMINI_API_KEY", "GEMINI_API_KEYS", "YOUTUBE_API_KEY",
        "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
        "SEED_MODE", "SEED_VALUE", "CREATE_IMAGE_MODEL",
        "TOKEN_OPTION", "MAX_CONCURRENT", "MAX_CONCURRENT_IMAGE", "MAX_CONCURRENT_GROK",
        "LICENSE_TOKEN",
    }
    current = load_config()
    # Allow account keys + whitelisted top-level keys only
    for k, v in req.config.items():
        if k.startswith("account") or k in _ALLOWED_CONFIG_KEYS:
            if k in {"MAX_CONCURRENT", "MAX_CONCURRENT_IMAGE"}:
                try:
                    v = max(1, min(3, int(v)))
                except Exception:
                    v = 2
            current[k] = v
    save_config(current)
    return {"ok": True}


@router.get("/accounts")
async def list_accounts():
    accounts = get_all_accounts()
    # Mask tokens
    safe_accounts = []
    for acc in accounts:
        a = dict(acc)
        if a.get("ACCESS_TOKEN"):
            a["ACCESS_TOKEN"] = a["ACCESS_TOKEN"][:20] + "..."
        if a.get("COOKIE"):
            a["COOKIE"] = "[set]"
        safe_accounts.append(a)
    return {"ok": True, "data": safe_accounts}


@router.post("/account")
async def save_account_route(req: SaveAccountRequest):
    # JS sends 0-based index; config uses 1-based keys (account1, account2...)
    save_account(req.index + 1, req.account)
    return {"ok": True}


_SAVE_VALUE_WHITELIST = {
    "GEMINI_API_KEY", "GEMINI_API_KEYS", "YOUTUBE_API_KEY",
    "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "SEED_MODE", "SEED_VALUE", "CREATE_IMAGE_MODEL",
    "TOKEN_OPTION", "MAX_CONCURRENT", "MAX_CONCURRENT_IMAGE", "MAX_CONCURRENT_GROK",
    "LICENSE_TOKEN",
}

@router.post("/save-value")
async def save_value(body: dict):
    """Save a single config key-value."""
    from fastapi import HTTPException
    key = str(body.get("key", ""))
    if not key.startswith("account") and key not in _SAVE_VALUE_WHITELIST:
        raise HTTPException(400, f"Key '{key}' không được phép ghi")
    cfg = load_config()
    value = body["value"]
    if key in {"MAX_CONCURRENT", "MAX_CONCURRENT_IMAGE"}:
        try:
            value = max(1, min(3, int(value)))
        except Exception:
            value = 2
    elif key == "MAX_CONCURRENT_GROK":
        try:
            value = max(1, min(5, int(value)))
        except Exception:
            value = 2
    cfg[key] = value
    if key == "GEMINI_API_KEYS":
        first = next((k.strip() for k in str(body["value"]).splitlines() if k.strip()), "")
        cfg["GEMINI_API_KEY"] = first
    save_config(cfg)
    return {"ok": True}


class CollectTokenRequest(BaseModel):
    account_index: int = 0


@router.post("/collect-token")
async def collect_token(req: CollectTokenRequest):
    """Trigger Playwright token collection for an account."""
    import asyncio
    from services.token.token_collector import collect_token_for_account
    from services.config_service import get_all_accounts, save_account
    accounts = get_all_accounts()
    if req.account_index >= len(accounts):
        from fastapi import HTTPException
        raise HTTPException(400, "Account index không hợp lệ")
    account = accounts[req.account_index]
    logs = []
    updated = await collect_token_for_account(account, log_callback=lambda m: logs.append(m))
    if updated.get("ACCESS_TOKEN") and updated["ACCESS_TOKEN"] != account.get("ACCESS_TOKEN"):
        save_account(req.account_index + 1, updated)  # 1-based
        return {"ok": True, "message": "Thu token thành công", "logs": logs}
    return {"ok": False, "message": "Không thu được token", "logs": logs}


class CookieToTokenRequest(BaseModel):
    account_index: int
    cookie_string: str


@router.post("/cookie-to-token")
async def cookie_to_token(req: CookieToTokenRequest):
    """
    Nhận cookie string từ user → tự động lấy access_token → lưu vào account.
    Không cần extension hay Playwright.
    """
    from fastapi import HTTPException
    from services.cookie_token_service import get_token_from_cookie
    from services.config_service import get_all_accounts, save_account, load_config

    cookie = req.cookie_string.strip()
    if not cookie:
        raise HTTPException(400, "Cookie string không được trống")

    logs: list[str] = []

    try:
        result = await get_token_from_cookie(cookie, log=lambda m: logs.append(m))
    except PermissionError as e:
        return {"ok": False, "message": str(e), "logs": logs, "status": "die"}
    except Exception as e:
        return {"ok": False, "message": str(e), "logs": logs, "status": "error"}

    # Load current account data để merge (giữ các field khác)
    cfg = load_config()
    acc_key = f"account{req.account_index + 1}"
    current = dict(cfg.get(acc_key, {}))

    # Cập nhật các field mới
    current["ACCESS_TOKEN"] = result["access_token"]
    current["COOKIE"] = cookie
    if result.get("email"):
        current["EMAIL"] = result["email"]
    if result.get("project_id"):
        current["PROJECT_ID"] = result["project_id"]

    save_account(req.account_index + 1, current)

    return {
        "ok": True,
        "message": "Lấy token từ cookie thành công",
        "email": result.get("email"),
        "project_id": result.get("project_id"),
        "token_preview": result["access_token"][:30] + "...",
        "logs": logs,
        "status": "live",
    }


@router.post("/check-cookie")
async def check_cookie(body: dict):
    """Kiểm tra cookie live/die mà không lưu."""
    from services.cookie_token_service import check_cookie_status
    cookie = str(body.get("cookie_string", "")).strip()
    if not cookie:
        return {"ok": False, "live": False, "error": "Cookie trống"}
    result = await check_cookie_status(cookie)
    return {"ok": True, **result}


@router.get("/account-credits")
async def get_account_credits(account_index: int = 0):
    """Lấy credits từ aisandbox API bằng access_token của account.
    account_index là 0-based từ JS (_index = i-1).
    """
    import httpx
    cfg = load_config()
    acc_key = f"account{account_index + 1}"
    acc = cfg.get(acc_key, {})
    token = acc.get("ACCESS_TOKEN", "").strip()
    if not token:
        return {"ok": False, "credits": None, "error": "Chưa có token"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://aisandbox-pa.googleapis.com/v1/credits",
                headers={"Authorization": f"Bearer {token}"},
            )
        if resp.status_code == 200:
            data = resp.json()
            credits = (
                data.get("videoGenerationCredits")
                or data.get("credits")
                or data.get("remainingCredits")
            )
            return {"ok": True, "credits": credits, "raw": data}
        else:
            return {"ok": False, "credits": None, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "credits": None, "error": str(e)}


@router.post("/refresh-token")
async def refresh_token_from_cookie(body: dict):
    """
    Refresh access_token cho 1 account từ cookie đã lưu.
    Body: { "account_index": 0 }
    """
    from services.cookie_token_service import get_token_from_cookie

    account_index = int(body.get("account_index", 0))
    cfg = load_config()
    acc_key = f"account{account_index + 1}"
    acc = cfg.get(acc_key, {})
    cookie = acc.get("COOKIE", "").strip()

    if not cookie:
        return {"ok": False, "message": "Account chưa có cookie — cần Load Cookie lại"}

    logs: list[str] = []
    try:
        result = await get_token_from_cookie(cookie, log=lambda m: logs.append(m))
    except Exception as e:
        return {"ok": False, "message": str(e), "logs": logs}

    current = dict(acc)
    current["ACCESS_TOKEN"] = result["access_token"]
    if result.get("email"):
        current["EMAIL"] = result["email"]
    if result.get("project_id"):
        current["PROJECT_ID"] = result["project_id"]

    save_account(account_index + 1, current)

    return {
        "ok": True,
        "message": "Refresh token thành công",
        "email": result.get("email"),
        "token_preview": result["access_token"][:30] + "...",
        "logs": logs,
    }


@router.post("/auto-refresh-all")
async def auto_refresh_all():
    """
    Startup endpoint: scan tất cả accounts có COOKIE → refresh token song song.
    Gọi 1 lần khi app khởi động và mỗi khi frontend detect token hết hạn.
    """
    from services.cookie_token_service import get_token_from_cookie
    import asyncio

    cfg = load_config()
    results = []

    async def refresh_one(acc_key: str, acc: dict):
        cookie = acc.get("COOKIE", "").strip()
        if not cookie:
            return {"key": acc_key, "ok": False, "reason": "no_cookie"}
        try:
            result = await get_token_from_cookie(cookie)
            current = dict(acc)
            current["ACCESS_TOKEN"] = result["access_token"]
            if result.get("email"):
                current["EMAIL"] = result["email"]
            if result.get("project_id"):
                current["PROJECT_ID"] = result["project_id"]
            idx = int(acc_key.replace("account", ""))
            save_account(idx, current)
            return {"key": acc_key, "ok": True, "email": result.get("email")}
        except Exception as e:
            return {"key": acc_key, "ok": False, "reason": str(e)}

    tasks = [
        refresh_one(k, v)
        for k, v in cfg.items()
        if k.startswith("account") and isinstance(v, dict) and v.get("COOKIE")
    ]

    if tasks:
        results = await asyncio.gather(*tasks)

    return {
        "ok": True,
        "refreshed": len([r for r in results if r.get("ok")]),
        "failed": len([r for r in results if not r.get("ok")]),
        "details": list(results),
    }


class AutoLoginRequest(BaseModel):
    email: str
    password: str
    account_index: int = 0  # 0-based


@router.post("/auto-login")
async def auto_login(req: AutoLoginRequest):
    """
    Tự động login Google bằng CloakBrowser → lấy cookie + token + project_id → lưu vào account.
    Trả về SSE-style progress qua response thông thường (logs list).
    """
    from services.auto_login_service import auto_login_google
    from services.config_service import load_config, save_account

    logs: list[str] = []

    def log_cb(msg: str):
        logs.append(msg)

    try:
        result = await auto_login_google(
            email=req.email,
            password=req.password,
            account_index=req.account_index,
            log_cb=log_cb,
        )
    except Exception as e:
        logs.append(f"❌ Lỗi: {e}")
        err = str(e)
        status = "error"
        if "VERIFY_REQUIRED" in err:
            status = "verify"
        elif "INVALID_ACCOUNT" in err:
            status = "invalid"
        return {"ok": False, "error": err, "status": status, "logs": logs}

    # Lưu vào config
    cfg = load_config()
    acc_key = f"account{req.account_index + 1}"
    current = dict(cfg.get(acc_key, {}))
    current["EMAIL"] = result.get("email", req.email)
    current["COOKIE"] = result.get("cookie", "")
    current["LABS_COOKIE"] = result.get("labs_cookie", "")
    current["ACCESS_TOKEN"] = result.get("access_token", "")
    if result.get("project_id"):
        current["PROJECT_ID"] = result["project_id"]
    if not current.get("TYPE_ACCOUNT"):
        current["TYPE_ACCOUNT"] = "ULTRA"
    if not current.get("PROFILE_NAME"):
        current["PROFILE_NAME"] = f"PROFILE_{req.account_index + 1}"
    current["ENABLED"] = current.get("ENABLED", True) is not False

    save_account(req.account_index + 1, current)

    return {
        "ok": True,
        "email": result.get("email"),
        "project_id": result.get("project_id"),
        "token_preview": result["access_token"][:30] + "..." if result.get("access_token") else "",
        "has_cookie": bool(result.get("cookie")),
        "has_labs_cookie": bool(result.get("labs_cookie")),
        "logs": logs,
    }
