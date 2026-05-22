"""Character library routes - CRUD and sync for reference images."""
from __future__ import annotations

import base64
import json
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter(tags=["character"])


class SyncRequest(BaseModel):
    ids: list[str] = []


class ConsistentSyncRequest(BaseModel):
    id: str
    account_index: int = 0


def _voice_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name or "").strip().lower()).strip("_")


def _voice_file_path() -> Path:
    from services.config_service import BASE_DIR

    return BASE_DIR / "giọng nói.txt"


def _load_voice_presets() -> list[dict]:
    path = _voice_file_path()
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    voices: list[dict] = []
    blocks = re.split(r"\n\s*-{5,}\s*\n", text)
    for block in blocks:
        lines = [x.strip() for x in block.splitlines() if x.strip()]
        if not lines:
            continue
        name = lines[0]
        desc = " ".join(lines[1:]).strip()
        voices.append({"id": _voice_id(name), "name": name, "description": desc})
    return voices


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


@router.get("/consistent/voices")
async def consistent_character_voices():
    return {"ok": True, "items": _load_voice_presets()}


@router.get("/consistent/list")
async def consistent_character_list():
    from services.consistent_character_service import list_consistent_characters

    return {"ok": True, "items": await list_consistent_characters()}


@router.post("/consistent/create")
async def consistent_character_create(
    images: list[UploadFile] = File(...),
    name: str = Form(...),
    voice_id: str = Form(...),
    voice_name: str = Form(""),
    voice_desc: str = Form(""),
    description: str = Form(""),
):
    from services.consistent_character_service import CONSISTENT_CHAR_DIR, create_consistent_character

    files = list(images or [])[:2]
    if not files:
        raise HTTPException(400, "Chưa chọn ảnh nhân vật")
    safe_name = str(name or "").strip()
    if not safe_name:
        raise HTTPException(400, "Tên nhân vật không được trống")
    safe_voice_id = str(voice_id or "").strip()
    if not safe_voice_id:
        raise HTTPException(400, "Chưa chọn giọng nói")

    CONSISTENT_CHAR_DIR.mkdir(parents=True, exist_ok=True)
    stored_images: list[dict] = []
    for idx, image in enumerate(files):
        raw = await image.read()
        if not raw:
            continue
        ext = Path(image.filename or "character.jpg").suffix.lower() or ".jpg"
        if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
            ext = ".jpg"
        filename = f"{uuid.uuid4().hex[:12]}_{idx + 1}{ext}"
        (CONSISTENT_CHAR_DIR / filename).write_bytes(raw)
        stored_images.append(
            {
                "filename": filename,
                "original_name": image.filename or filename,
                "mime_type": image.content_type or ("image/png" if ext == ".png" else "image/jpeg"),
            }
        )

    if not stored_images:
        raise HTTPException(400, "Ảnh tải lên rỗng")

    item = await create_consistent_character(
        name=safe_name,
        description=description,
        voice_id=safe_voice_id,
        voice_name=voice_name or safe_voice_id,
        voice_desc=voice_desc,
        images=stored_images,
    )
    return {"ok": True, "item": item}


def _extract_entity_id(body: str) -> str:
    def pick(value):
        if isinstance(value, dict):
            for key in ("entityId", "id"):
                if isinstance(value.get(key), str) and value.get(key):
                    return value.get(key)
            for child in value.values():
                got = pick(child)
                if got:
                    return got
        if isinstance(value, list):
            for child in value:
                got = pick(child)
                if got:
                    return got
        return ""

    try:
        return pick(json.loads(body or "{}")) or ""
    except Exception:
        return ""


async def _create_veo_entity_with_labs_cookie(project_id: str, labs_cookie: str) -> tuple[str, str]:
    import httpx

    safe_project_id = str(project_id or "").strip()
    safe_cookie = str(labs_cookie or "").strip()
    if not safe_project_id:
        raise HTTPException(400, "Thiáº¿u PROJECT_ID")
    if not safe_cookie:
        raise HTTPException(400, "Thiáº¿u LABS_COOKIE cho account nÃ y")

    referer = f"https://labs.google/fx/vi/tools/flow/project/{safe_project_id}/characters"
    headers = {
        "Cookie": safe_cookie,
        "Origin": "https://labs.google",
        "Referer": referer,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/148.0.0.0 Safari/537.36"
        ),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        # This is harmless if already accepted; it mirrors the browser flow before createEntity.
        try:
            await client.post(
                "https://labs.google/fx/api/trpc/general.submitUserAcknowledgement",
                headers=headers,
                json={
                    "json": {
                        "acknowledgementVersion": "FLOW_IMAGE_UPLOAD_TOS",
                        "frontendCommitHash": "v-release-candidate-05-14-26-026ceb06b-260519175754",
                    }
                },
            )
        except Exception:
            pass

        resp = await client.post(
            "https://labs.google/fx/api/trpc/flow.createEntity",
            headers=headers,
            json={"json": {"projectId": safe_project_id}},
        )

    body = resp.text or ""
    if resp.status_code >= 400:
        raise RuntimeError(f"CREATE_ENTITY_HTTP_{resp.status_code}: {body[:800]}")
    entity_id = _extract_entity_id(body)
    if not entity_id:
        raise RuntimeError(f"CREATE_ENTITY_NO_ENTITY_ID: {body[:800]}")
    return entity_id, body


@router.post("/consistent/sync")
async def consistent_character_sync(req: ConsistentSyncRequest):
    from services.config_service import BASE_DIR, get_active_accounts
    from services.consistent_character_service import get_consistent_character, upsert_consistent_character_sync
    from routers.extension import request_browser_character_entity

    item = await get_consistent_character(str(req.id or ""))
    if not item:
        raise HTTPException(404, "Không tìm thấy nhân vật")

    accounts = [
        a for a in get_active_accounts()
        if str(a.get("PROJECT_ID", "")).strip() and str(a.get("ACCESS_TOKEN", "")).strip()
    ]
    if req.account_index:
        accounts = [a for a in accounts if int(a.get("_index") or 0) == int(req.account_index)]
    if not accounts:
        raise HTTPException(400, "Chưa có account nào có token và Project ID")

    images_payload: list[dict] = []
    for image in (item.get("images") or [])[:2]:
        filename = str(image.get("filename") or "")
        path = BASE_DIR / "data" / "consistent_characters" / filename
        if not filename or not path.exists():
            continue
        raw = path.read_bytes()
        if not raw:
            continue
        images_payload.append(
            {
                "base64": base64.b64encode(raw).decode(),
                "mimeType": image.get("mime_type") or "image/jpeg",
                "fileName": image.get("original_name") or filename,
            }
        )
    if not images_payload:
        raise HTTPException(400, "Không tìm thấy ảnh nhân vật để upload")

    results = []
    synced = 0
    failed = 0
    for account in accounts:
        account_index = int(account.get("_index") or 1)
        project_id = str(account.get("PROJECT_ID") or "")
        try:
            entity_id, create_body = await _create_veo_entity_with_labs_cookie(
                project_id,
                str(account.get("LABS_COOKIE") or ""),
            )
        except Exception as e:
            failed += 1
            msg = str(e)
            results.append(
                {
                    "account_index": account_index,
                    "ok": False,
                    "status": 0,
                    "reason": "CREATE_ENTITY_BACKEND_FAILED",
                    "error": msg,
                }
            )
            await upsert_consistent_character_sync(
                character_id=item["id"],
                account_index=account_index,
                project_id=project_id,
                entity_id="",
                status="failed",
                error=msg,
            )
            continue
        payload = {
            "projectId": project_id,
            "entityId": entity_id,
            "name": item.get("name") or "Character",
            "description": item.get("description") or "",
            "voiceId": item.get("voice_id") or "",
            "images": images_payload,
        }
        result = await request_browser_character_entity(
            str(uuid.uuid4()),
            payload=payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
            timeout_seconds=180.0,
        )
        body = result.get("body") or create_body or ""
        entity_id = _extract_entity_id(body) or entity_id
        if result.get("ok") and entity_id:
            synced += 1
            sync = await upsert_consistent_character_sync(
                character_id=item["id"],
                account_index=account_index,
                project_id=project_id,
                entity_id=entity_id,
                status="synced",
                error="",
            )
            results.append({"ok": True, "account_index": account_index, "entity_id": entity_id, "sync": sync})
        else:
            failed += 1
            error = str(body or result.get("reason") or f"HTTP {result.get('status')}")
            sync = await upsert_consistent_character_sync(
                character_id=item["id"],
                account_index=account_index,
                project_id=project_id,
                entity_id=entity_id,
                status="failed",
                error=error[:500],
            )
            results.append({"ok": False, "account_index": account_index, "error": error[:500], "sync": sync})

    return {"ok": synced > 0, "synced": synced, "failed": failed, "items": results}


@router.delete("/consistent/{char_id}")
async def consistent_character_delete(char_id: str):
    from services.consistent_character_service import delete_consistent_character

    ok = await delete_consistent_character(char_id)
    if not ok:
        raise HTTPException(404, "Không tìm thấy nhân vật")
    return {"ok": True}


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


async def sync_characters(body: SyncRequest):
    return await _sync_characters_impl(body.ids)


async def sync_all_characters():
    return await _sync_characters_impl([])


@router.delete("/{char_id}")
async def delete_character(char_id: str):
    from services.character_service import delete_character as _del

    ok = await _del(char_id)
    if not ok:
        raise HTTPException(404, "Khong tim thay nhan vat")
    return {"ok": True}
