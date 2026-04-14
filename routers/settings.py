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
    """Return full config including tokens — for internal use."""
    return {"ok": True, "data": load_config()}


@router.post("/config")
async def save_config_route(req: SaveConfigRequest):
    save_config(req.config)
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


@router.post("/save-value")
async def save_value(body: dict):
    """Save a single config key-value."""
    cfg = load_config()
    cfg[body["key"]] = body["value"]
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
    """Lấy credits từ aisandbox API bằng access_token của account."""
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
            # Response dạng {"videoGenerationCredits": 16000} hoặc {"credits": 16000}
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


@router.get("/account-credits")
async def get_account_credits(account_index: int = 0):
    """Lấy số credits còn lại của một account."""
    import httpx
    from fastapi import HTTPException

    accounts = get_all_accounts()
    if account_index < 0 or account_index >= len(accounts):
        raise HTTPException(400, "account_index không hợp lệ")

    account = accounts[account_index]
    access_token = account.get("ACCESS_TOKEN", "").strip()
    if not access_token:
        return {"ok": False, "credits": None, "error": "Account không có ACCESS_TOKEN"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                "https://aisandbox-pa.googleapis.com/v1/credits",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            data = resp.json()
            # API có thể trả về field tên khác nhau, thử các key phổ biến
            credits = (
                data.get("credits")
                or data.get("remainingCredits")
                or data.get("balance")
                or data.get("total")
            )
            return {"ok": True, "credits": credits}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "credits": None, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as e:
        return {"ok": False, "credits": None, "error": str(e)}
