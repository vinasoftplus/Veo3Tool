"""Character library routes - CRUD and sync for reference images."""
from __future__ import annotations

import base64
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter(tags=["character"])


class SyncRequest(BaseModel):
    ids: list[str] = []


def _normalize_media_id(value) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        return (
            _normalize_media_id(value.get("mediaId"))
            or _normalize_media_id(value.get("mediaGenerationId"))
            or _normalize_media_id(value.get("id"))
            or _normalize_media_id(value.get("name"))
            or ""
        )
    return str(value)


@router.get("/list")
async def list_characters():
    from services.character_service import list_characters as _list

    chars = await _list()
    return {"ok": True, "data": chars}


@router.post("/upload")
async def upload_character(
    image: UploadFile = File(...),
    name: str = Form("Character"),
):
    """Save the character locally, try to sync to Google Labs via browser extension."""
    from services.character_service import save_character

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(400, "Anh tai len rong")

    b64 = base64.b64encode(image_bytes).decode()
    mime = image.content_type or "image/jpeg"
    ext = Path(image.filename or "char.jpg").suffix or ".jpg"
    safe_name = (name or "Character").strip() or "Character"

    # Save locally without media_id — sync step will upload via browser
    char = await save_character(safe_name, "", b64, ext)
    return {"ok": True, "data": char, "warning": "Nhan vat da luu. Bam Sync de dong bo len Labs."}


async def _sync_characters_impl(char_ids: list[str]) -> dict:
    from services.character_service import get_character, list_characters, update_character_media_id
    from services.config_service import get_active_accounts, BASE_DIR
    from routers.extension import request_browser_upload_post
    from adapters.google_labs import URL_UPLOAD
    import uuid as _uuid

    chars = await list_characters()
    if char_ids:
        wanted = set(char_ids)
        chars = [c for c in chars if c["id"] in wanted]
    else:
        # sync-all: sync everyone regardless (force re-sync)
        pass  # chars already = all

    if not chars:
        return {"ok": True, "synced": 0, "failed": 0, "items": [],
                "message": "Khong co nhan vat nao"}

    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chua co account/token Labs de sync nhan vat")

    account = accounts[0]
    results = []
    synced = 0
    failed = 0

    for char in chars:
        full_char = await get_character(char["id"])
        if not full_char:
            failed += 1
            results.append({"id": char["id"], "ok": False, "error": "Khong tim thay nhan vat"})
            continue

        abs_path = BASE_DIR / "data" / "characters" / full_char["filename"]
        if not abs_path.exists():
            failed += 1
            results.append({"id": char["id"], "ok": False, "error": "Khong tim thay file anh"})
            continue

        mime = "image/png" if abs_path.suffix.lower() == ".png" else "image/jpeg"
        b64 = base64.b64encode(abs_path.read_bytes()).decode()

        # Upload via browser extension so mediaId belongs to the browser session
        browser_job_id = str(_uuid.uuid4())
        upload_payload = {
            "imageInput": {
                "rawImageBytes": b64,
                "mimeType": mime,
                "isUserUploaded": True,
                "aspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            },
            "clientContext": {"sessionId": str(_uuid.uuid4()), "tool": "ASSET_MANAGER"},
        }
        result = await request_browser_upload_post(
            browser_job_id,
            job_type="upload",
            url=URL_UPLOAD,
            payload=upload_payload,
            uploads=[],  # no image uploads needed — imageInput has b64 inline
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=int(account.get("_index") or 1),
        )

        if result.get("ok"):
            import json as _json
            try:
                body = _json.loads(result.get("body", "{}"))
                media_id = _normalize_media_id(
                    body.get("mediaId")
                    or body.get("mediaGenerationId")
                    or body.get("id")
                    or body.get("name")
                    or body.get("media")
                    or body
                )
            except Exception:
                media_id = ""
            if media_id and await update_character_media_id(char["id"], media_id):
                synced += 1
                results.append({"id": char["id"], "ok": True, "media_id": media_id})
            else:
                failed += 1
                results.append({"id": char["id"], "ok": False, "error": "Upload OK nhung khong lay duoc media_id"})
        else:
            failed += 1
            results.append({
                "id": char["id"], "ok": False,
                "error": result.get("body") or result.get("reason") or "Sync that bai",
            })

    return {
        "ok": True, "synced": synced, "failed": failed, "items": results,
        "message": f"Da sync {synced} nhan vat" + (f", loi {failed}" if failed else ""),
    }


@router.post("/sync")
async def sync_characters(body: SyncRequest):
    return await _sync_characters_impl(body.ids)


@router.post("/sync-all")
async def sync_all_characters():
    return await _sync_characters_impl([])


@router.delete("/{char_id}")
async def delete_character(char_id: str):
    from services.character_service import delete_character as _del

    ok = await _del(char_id)
    if not ok:
        raise HTTPException(404, "Khong tim thay nhan vat")
    return {"ok": True}
