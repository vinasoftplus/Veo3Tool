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
