"""License routes — Ed25519 server-based validation."""
from fastapi import APIRouter
from pydantic import BaseModel

from services.license import (
    get_license_info, validate_license,
    get_machine_id, force_recheck, is_banned, get_ban_reason,
)

router = APIRouter(tags=["license"])


@router.get("/info")
async def license_info():
    return get_license_info()


@router.get("/machine-uuid")
async def machine_uuid():
    return {"machine_uuid": get_machine_id()}


@router.get("/auto-check")
async def auto_check():
    """Check license via server (cache 15 min)."""
    valid, msg = validate_license()
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/validate")
async def validate():
    """Trigger recheck immediately (clears cache)."""
    valid, msg = force_recheck()
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/clear")
async def clear_license():
    """Force recheck."""
    valid, msg = force_recheck()
    return {"ok": True, "valid": valid, "message": msg}


@router.get("/ban-check")
async def ban_check():
    """Check if this machine is banned."""
    return {
        "is_banned": is_banned(),
        "ban_reason": get_ban_reason() if is_banned() else None,
        "machine_uuid": get_machine_id(),
    }


class SetKeyRequest(BaseModel):
    key: str

@router.post("/set-key")
async def set_key(body: SetKeyRequest):
    """Save license key to config and validate immediately."""
    from services.config_service import load_config, save_config
    key = body.key.strip()
    if not key:
        return {"ok": False, "message": "Key không được để trống"}
    cfg = load_config()
    cfg["LICENSE_TOKEN"] = key
    save_config(cfg)
    valid, msg = force_recheck()
    return {"ok": valid, "saved": True, "valid": valid, "message": msg}


@router.post("/shutdown")
async def shutdown():
    """Shut down app when license expires or machine is banned."""
    import asyncio, os, signal
    async def _kill():
        await asyncio.sleep(1)
        os.kill(os.getpid(), signal.SIGTERM)
    asyncio.create_task(_kill())
    return {"ok": True}
