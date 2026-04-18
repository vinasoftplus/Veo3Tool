"""License routes — Google Sheets based."""
from fastapi import APIRouter

from services.license import get_license_info, validate_license, get_runtime_key, get_machine_id, force_recheck

router = APIRouter(tags=["license"])


@router.get("/info")
async def license_info():
    return get_license_info()


@router.get("/machine-uuid")
async def machine_uuid():
    return {"machine_uuid": get_machine_id()}


@router.get("/runtime-key")
async def runtime_key():
    return {"runtime_key": get_runtime_key()}


@router.get("/auto-check")
async def auto_check():
    """Check license qua Google Sheets (cache 1h)."""
    valid, msg = validate_license()
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/validate")
async def validate():
    """
    Trigger check lại ngay (bỏ cache).
    Body không cần gì — giữ endpoint để tương thích frontend cũ.
    """
    valid, msg = force_recheck()
    info = get_license_info()
    return {"valid": valid, "message": msg, **info}


@router.post("/clear")
async def clear_license():
    """Force recheck (không còn token để xóa)."""
    valid, msg = force_recheck()
    return {"ok": True, "valid": valid, "message": msg}


@router.post("/shutdown")
async def shutdown():
    """Tắt app khi license hết hạn."""
    import asyncio, os, signal
    async def _kill():
        await asyncio.sleep(1)
        os.kill(os.getpid(), signal.SIGTERM)
    asyncio.create_task(_kill())
    return {"ok": True}
