"""License routes."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.license import get_license_info, validate_license, get_runtime_key
from services.config_service import load_config, save_config

router = APIRouter(tags=["license"])


class ValidateRequest(BaseModel):
    token: str


@router.get("/info")
async def license_info():
    return get_license_info()


@router.get("/runtime-key")
async def runtime_key():
    """Frontend calls this once on load to get the runtime guard key."""
    return {"runtime_key": get_runtime_key()}


@router.post("/validate")
async def validate(req: ValidateRequest):
    valid, msg = validate_license(req.token)
    if valid:
        # Persist token in config
        cfg = load_config()
        cfg["LICENSE_TOKEN"] = req.token
        save_config(cfg)
    return {"valid": valid, "message": msg}
