"""License routes."""
from fastapi import APIRouter
from pydantic import BaseModel

from services.license import get_license_info, validate_license, get_runtime_key, get_bios_uuid
from services.config_service import load_config, save_config

router = APIRouter(tags=["license"])


class ValidateRequest(BaseModel):
    token: str


@router.get("/info")
async def license_info():
    return get_license_info()


@router.get("/machine-uuid")
async def machine_uuid():
    """Return machine UUID for display."""
    return {"machine_uuid": get_bios_uuid()}


@router.get("/runtime-key")
async def runtime_key():
    return {"runtime_key": get_runtime_key()}


@router.get("/auto-check")
async def auto_check():
    """
    Load saved LICENSE_TOKEN from config và tự validate.
    Gọi khi app khởi động để check xem token cũ còn hạn không.
    """
    cfg = load_config()
    saved_token = cfg.get("LICENSE_TOKEN", "").strip()
    if not saved_token:
        return {"valid": False, "message": "Chưa có license token", "machine_uuid": get_bios_uuid()}
    valid, msg = validate_license(saved_token)
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/validate")
async def validate(req: ValidateRequest):
    valid, msg = validate_license(req.token)
    if valid:
        cfg = load_config()
        cfg["LICENSE_TOKEN"] = req.token
        save_config(cfg)
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/clear")
async def clear_license():
    """Xóa license token khỏi config (admin dùng)."""
    cfg = load_config()
    cfg["LICENSE_TOKEN"] = ""
    save_config(cfg)
    return {"ok": True}
