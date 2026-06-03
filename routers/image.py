"""Image generation routes — Banana, Whisk, Virtual Try-On, Frame Cutter."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import job_store
from services.config_service import get_active_accounts, BASE_DIR, load_config

router = APIRouter(tags=["image"])
logger = logging.getLogger("veo.image")

_CHAR_SYNC_JOBS: dict[str, dict] = {}
_CHAR_SYNC_MAX_CONCURRENT = 4


def _get_account_or_raise(account_index: int = 0):
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chưa có account nào có token.")
    if account_index > 0:
        for acc in accounts:
            if int(acc.get("_index") or 0) == account_index:
                return acc
    return accounts[0]


def _token_option() -> str:
    cfg = load_config()
    return str(cfg.get("TOKEN_OPTION", "Option 1") or "Option 1").strip()


def _safe_flow_handle(name: str, suffix: str = ".jpg") -> str:
    import re

    stem = str(name or "").strip() or "character"
    stem = re.sub(r"[\\/:*?\"<>|]+", "_", stem)
    stem = re.sub(r"\s+", "_", stem).strip("._ ")
    if not stem:
        stem = "character"
    ext = suffix if str(suffix or "").startswith(".") else f".{suffix or 'jpg'}"
    return f"{stem}{ext.lower()}"


def _valid_sync_media_id(media_id: str) -> bool:
    text = str(media_id or "").strip()
    if not text or text.startswith("{") or text.startswith("["):
        return False
    if "mediaGenerationId" in text or "mediaId" in text:
        return False
    try:
        uuid.UUID(text)
        return True
    except Exception:
        return False


async def _refresh_if_needed(result: dict, account_index: int) -> bool:
    """Nếu result là 401/403 và account có cookie → refresh token. Trả về True nếu refresh OK."""
    status = result.get("status", 0)
    if status not in (401, 403):
        return False
    body_text = str(result.get("body", "") or "").lower()
    if status == 403 and (
        "recaptcha evaluation failed" in body_text
        or "public_error_unusual_activity" in body_text
        or "recaptcha" in body_text
    ):
        logger.warning("[Image] HTTP 403 do reCAPTCHA/unusual activity - khong refresh token account #%s", account_index)
        return False
    if not account_index:
        return False
    from services.token_refresh_service import refresh_account_token
    logger.warning("[Image] HTTP %s — thử refresh token account #%s...", status, account_index)
    refreshed = await refresh_account_token(account_index)
    if refreshed:
        logger.info("[Image] ✅ Refresh token OK account #%s", account_index)
    else:
        logger.warning("[Image] ❌ Refresh token thất bại account #%s", account_index)
    return refreshed


def _normalize_images(medias: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for item in medias or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or item.get("downloadUrl") or item.get("image_url") or item.get("imageUrl") or ""
        media_id = item.get("media_id") or item.get("mediaId") or item.get("mediaGenerationId") or item.get("name") or ""
        logger.info("[Image] parse media_id=%r keys=%s", media_id, list(item.keys()))
        normalized.append(
            {
                **item,
                "url": url,
                "downloadUrl": item.get("downloadUrl") or url,
                "image_url": item.get("image_url") or url,
                "imageUrl": item.get("imageUrl") or url,
                "media_id": media_id,
                "mediaId": item.get("mediaId") or media_id,
            }
        )
    return normalized


def _augment_reference_prompt(prompt: str, character_names: list[str]) -> str:
    base = str(prompt or "").strip()
    names = [str(x or "").strip() for x in character_names if str(x or "").strip()]
    identity_line = (
        "Use the provided reference images as a hard identity lock for the main subject. "
        "The action in the prompt must be performed by that exact referenced subject. "
        "Keep the same species, face, fur pattern, body proportions, outfit, and overall design. "
        "If the reference depicts a dog or an anthropomorphic dog, keep it as a dog and never turn it into a human, child, woman, man, or generic person. "
        "Do not replace the referenced subject with any new character."
    )
    if names:
        identity_line += " Focus on these exact referenced characters: " + ", ".join(names) + "."
    if base:
        return identity_line + "\n\nScene prompt:\n" + base + "\n\nReminder: the referenced character is the only main subject."
    return identity_line


# ---------------------------------------------------------------------------
# Generate Image (Banana / batchGenerateImages)
# ---------------------------------------------------------------------------

class GenerateImageRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE"
    output_count: int = 1
    model: str = "Imagen 4"
    seed: int | None = None


@router.post("/generate")
async def generate_image(req: GenerateImageRequest):
    from adapters.google_labs import GoogleLabsAdapter
    from adapters.google_labs import URL_IMG_GEN_TPL
    from routers.extension import request_browser_submit, wait_for_browser_account_available
    from urllib.parse import quote

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    token_option = _token_option()

    if token_option == "Option 2":
        project_id = str(account.get("PROJECT_ID", "") or "").strip()
        if not project_id:
            raise HTTPException(400, "Thiếu PROJECT_ID cho tài khoản hiện tại.")
        await wait_for_browser_account_available(account_index)

        payload = adapter.build_generate_images_payload(
            prompt=req.prompt,
            account=account,
            aspect_ratio=req.aspect_ratio,
            output_count=req.output_count,
            model=req.model,
            seed=req.seed,
            recaptcha_token="",
        )
        result = await request_browser_submit(
            str(uuid.uuid4()),
            job_type="image",
            url=URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
            payload=payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        result = await adapter.generate_images(
            prompt=req.prompt,
            account=account,
            aspect_ratio=req.aspect_ratio,
            output_count=req.output_count,
            model=req.model,
            seed=req.seed,
        )
    if not result.get("ok"):
        # Retry 1 lần nếu 401/403 + refresh thành công
        if await _refresh_if_needed(result, account_index):
            account = _get_account_or_raise(account_index)
            if token_option == "Option 2":
                result = await request_browser_submit(
                    str(uuid.uuid4()),
                    job_type="image",
                    url=URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
                    payload=payload,
                    access_token=account.get("ACCESS_TOKEN", ""),
                    account_index=account_index,
                )
            else:
                result = await adapter.generate_images(
                    prompt=req.prompt, account=account,
                    aspect_ratio=req.aspect_ratio, output_count=req.output_count,
                    model=req.model, seed=req.seed,
                )
        if not result.get("ok"):
            raise HTTPException(400, f"API error: {result.get('body', '')}")

    medias = _normalize_images(adapter.parse_image_results(result.get("body", "")))
    return {"ok": True, "images": medias}


@router.post("/generate-studio")
async def generate_image_studio(
    prompt: str = Form(...),
    aspect_ratio: str = Form("IMAGE_ASPECT_RATIO_LANDSCAPE"),
    output_count: int = Form(1),
    model: str = Form("Imagen 4"),
    seed: int | None = Form(None),
    character_ids_json: str = Form("[]"),
    reference_images: list[UploadFile] = File([]),
    account_index: int = Form(0),
):
    from adapters.google_labs import GoogleLabsAdapter
    from adapters.google_labs import URL_IMG_GEN_TPL
    from routers.extension import request_browser_submit, wait_for_browser_account_available
    from services.character_service import get_character
    from urllib.parse import quote

    account = _get_account_or_raise(account_index)
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    token_option = _token_option()
    project_id = str(account.get("PROJECT_ID", "") or "").strip()
    if not project_id:
        raise HTTPException(400, "Thiếu PROJECT_ID cho tài khoản hiện tại.")
    if token_option == "Option 2":
        await wait_for_browser_account_available(account_index)

    try:
        character_ids = json.loads(character_ids_json or "[]")
        if not isinstance(character_ids, list):
            character_ids = []
    except Exception:
        character_ids = []

    reference_input_names: list[str] = []
    character_names: list[str] = []

    async def _upload_reference_bytes(raw: bytes, mime_type: str, file_name: str) -> None:
        if not raw:
            return
        upload = await adapter.upload_flow_image(
            base64.b64encode(raw).decode(),
            mime_type,
            account,
            file_name=file_name,
        )
        if not upload.get("ok"):
            raise HTTPException(400, f"Upload ảnh tham chiếu thất bại: {upload.get('body', '')}")
        ref_name = adapter.parse_flow_input_name(upload.get("body", ""))
        if ref_name:
            reference_input_names.append(ref_name)
        else:
            logger.warning(
                "studio-image upload parsed empty ref | file=%s | body=%s",
                file_name,
                str(upload.get("body", "") or "")[:500].replace("\n", " "),
            )

    for char_id in character_ids[:3]:
        char = await get_character(str(char_id))
        if not char:
            continue
        if char.get("name"):
            character_names.append(str(char["name"]))
        char_path = BASE_DIR / "data" / "characters" / char["filename"]
        if not char_path.exists():
            continue
        mime_type = "image/png" if char_path.suffix.lower() == ".png" else "image/jpeg"
        await _upload_reference_bytes(char_path.read_bytes(), mime_type, char["filename"])

    for ref in reference_images[:6]:
        raw = await ref.read()
        await _upload_reference_bytes(raw, ref.content_type or "image/jpeg", ref.filename or f"ref_{uuid.uuid4().hex[:8]}.jpg")

    effective_prompt = _augment_reference_prompt(prompt, character_names) if reference_input_names else prompt
    logger.warning(
        "studio-image refs | model=%s | chars=%s | ref_count=%s | ref_names=%s | prompt=%s",
        model,
        character_names,
        len(reference_input_names),
        reference_input_names[:6],
        effective_prompt[:220].replace("\n", " "),
    )

    payload = adapter.build_generate_images_payload(
        prompt=effective_prompt,
        account=account,
        aspect_ratio=aspect_ratio,
        output_count=output_count,
        model=model,
        seed=seed,
        recaptcha_token="",
        reference_input_names=reference_input_names,
    )

    if token_option == "Option 2":
        result = await request_browser_submit(
            str(uuid.uuid4()),
            job_type="image",
            url=URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
            payload=payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        if reference_input_names:
            from adapters.google_labs import _async_send
            result = await _async_send(
                URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
                payload,
                account.get("ACCESS_TOKEN", ""),
                account.get("COOKIE", ""),
            )
        else:
            result = await adapter.generate_images(
                prompt=effective_prompt,
                account=account,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                seed=seed,
                recaptcha_token="",
            )

    if not result.get("ok"):
        # Retry 1 lần nếu 401/403 + refresh thành công
        if await _refresh_if_needed(result, account_index):
            account = _get_account_or_raise(account_index)
            if token_option == "Option 2":
                result = await request_browser_submit(
                    str(uuid.uuid4()),
                    job_type="image",
                    url=URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
                    payload=payload,
                    access_token=account.get("ACCESS_TOKEN", ""),
                    account_index=account_index,
                )
            else:
                if reference_input_names:
                    from adapters.google_labs import _async_send
                    result = await _async_send(
                        URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe="")),
                        payload, account.get("ACCESS_TOKEN", ""), account.get("COOKIE", ""),
                    )
                else:
                    result = await adapter.generate_images(
                        prompt=effective_prompt, account=account,
                        aspect_ratio=aspect_ratio, output_count=output_count,
                        model=model, seed=seed, recaptcha_token="",
                    )
        if not result.get("ok"):
            raise HTTPException(400, f"API error: {result.get('body', '')}")

    medias = _normalize_images(adapter.parse_image_results(result.get("body", "")))
    return {"ok": True, "images": medias, "reference_count": len(reference_input_names)}


# ---------------------------------------------------------------------------
# Whisk Image
# ---------------------------------------------------------------------------

class WhiskRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE"


@router.post("/whisk")
async def whisk_image(req: WhiskRequest):
    from adapters.google_labs import GoogleLabsAdapter
    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()

    result = await adapter.generate_whisk_image(
        prompt=req.prompt,
        account=account,
        aspect_ratio=req.aspect_ratio,
    )
    if not result.get("ok"):
        raise HTTPException(400, f"Whisk error: {result.get('body', '')}")

    medias = adapter.parse_image_results(result.get("body", ""))
    return {"ok": True, "images": medias}


# ---------------------------------------------------------------------------
# Virtual Try-On
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Save image from URL to local
# ---------------------------------------------------------------------------

class SaveImageRequest(BaseModel):
    url: str
    filename: str | None = None


@router.post("/save")
async def save_image(req: SaveImageRequest):
    import httpx
    save_dir = BASE_DIR / "data" / "jobs"
    save_dir.mkdir(parents=True, exist_ok=True)
    fname = req.filename or f"img_{uuid.uuid4().hex[:10]}.jpg"
    out_path = save_dir / fname
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
            out_path.write_bytes(resp.content)
    except Exception as e:
        raise HTTPException(500, f"Lỗi lưu ảnh: {e}")
    return {"ok": True, "local_path": f"/jobs/{fname}"}


# ---------------------------------------------------------------------------
# Studio: Save image to library (data/studio/)
# ---------------------------------------------------------------------------

class StudioSaveRequest(BaseModel):
    url: str
    prompt: str | None = None
    filename: str | None = None
    category_id: str | None = None
    media_id: str | None = None
    asset_type: str | None = None


@router.post("/studio/save")
async def studio_save_image(req: StudioSaveRequest):
    """Save a generated image into the shared library."""
    import httpx
    from services.library_service import save_library_asset

    ext = "jpg"
    url_clean = req.url.split("?")[0]
    if "." in url_clean.split("/")[-1]:
        ext = url_clean.split("/")[-1].rsplit(".", 1)[-1].lower()
        if ext not in ("jpg", "jpeg", "png", "webp"):
            ext = "jpg"

    fname = req.filename or f"studio_{uuid.uuid4().hex[:12]}.{ext}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
            asset = await save_library_asset(
                image_bytes=resp.content,
                filename=fname,
                prompt=req.prompt or "",
                category_id=req.category_id or "default",
                source_type="studio",
                origin_url=req.url,
                media_id=req.media_id or "",
                asset_type=req.asset_type or "nhanvat",
            )
    except Exception as e:
        raise HTTPException(500, f"L?i l?u ?nh v?o kho: {e}")

    return {"ok": True, "filename": asset["filename"], "local_path": asset["url"], "asset": asset}


class LibraryCategoryRequest(BaseModel):
    name: str


@router.get("/library/categories")
async def library_categories():
    from services.library_service import list_categories

    return {"ok": True, "items": await list_categories()}


@router.post("/library/categories")
async def library_create_category(req: LibraryCategoryRequest):
    from services.library_service import create_category

    try:
        item = await create_category(req.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "item": item}


@router.delete("/library/categories/{category_id}")
async def library_delete_category(category_id: str):
    from services.library_service import delete_category

    try:
        await delete_category(category_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.get("/library/assets")
async def library_assets():
    from services.library_service import list_assets

    items = await list_assets()
    for item in items:
        item.pop("syncs", None)
    return {"ok": True, "items": items}


@router.post("/library/upload")
async def library_upload_asset(
    image: UploadFile = File(...),
    name: str = Form(""),
    category_id: str = Form("default"),
    asset_type: str = Form("nhanvat"),
):
    """Upload a file directly into library assets."""
    from services.library_service import save_library_asset

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(400, "File rỗng")
    ext = Path(image.filename or "img.jpg").suffix or ".jpg"
    safe_name = (name or Path(image.filename or "image").stem).strip() or "image"
    asset = await save_library_asset(
        image_bytes=image_bytes,
        filename=f"{safe_name}{ext}",
        prompt="",
        category_id=category_id or "default",
        source_type="upload",
        origin_url="",
        asset_type=asset_type or "nhanvat",
    )
    return {"ok": True, "item": asset}


class SyncLibraryAssetsRequest(BaseModel):
    asset_ids: list[str]


async def library_sync_characters(req: SyncLibraryAssetsRequest):
    """Upload selected character assets to every active Labs account and store mediaId per account/project."""
    from adapters.google_labs import GoogleLabsAdapter
    from services.library_service import get_asset, upsert_asset_sync

    asset_ids = [str(x or "").strip() for x in (req.asset_ids or []) if str(x or "").strip()]
    if not asset_ids:
        raise HTTPException(400, "Chưa chọn ảnh nhân vật nào")

    accounts = [
        a for a in get_active_accounts()
        if str(a.get("PROJECT_ID", "")).strip() and str(a.get("ACCESS_TOKEN", "")).strip()
    ]
    if not accounts:
        raise HTTPException(400, "Chưa có account nào có token và Project ID")

    adapter = GoogleLabsAdapter()
    results: list[dict] = []
    total_ok = 0
    total_failed = 0

    for asset_id in asset_ids:
        asset = await get_asset(asset_id)
        if not asset:
            total_failed += 1
            results.append({"asset_id": asset_id, "ok": False, "error": "Asset không tồn tại"})
            continue
        if asset.get("asset_type") != "nhanvat":
            total_failed += 1
            results.append({"asset_id": asset_id, "ok": False, "error": "Chỉ đồng bộ ảnh loại Nhân Vật"})
            continue
        path = asset.get("path")
        if not path or not Path(path).exists():
            total_failed += 1
            results.append({"asset_id": asset_id, "ok": False, "error": "Không tìm thấy file ảnh"})
            continue

        raw = Path(path).read_bytes()
        if not raw:
            total_failed += 1
            results.append({"asset_id": asset_id, "ok": False, "error": "File ảnh rỗng"})
            continue

        suffix = Path(str(asset.get("filename") or "")).suffix or ".jpg"
        character_code = str(asset.get("name") or "").strip()
        flow_handle = _safe_flow_handle(character_code, suffix)
        mime = "image/png" if suffix.lower() == ".png" else "image/jpeg"
        b64 = base64.b64encode(raw).decode()
        per_account = []

        for account in accounts:
            account_index = int(account.get("_index") or 0)
            project_id = str(account.get("PROJECT_ID") or "")
            try:
                upload = await adapter.upload_flow_image(b64, mime, account, file_name=flow_handle)
                if not upload.get("ok"):
                    err = str(upload.get("body") or upload.get("reason") or f"HTTP {upload.get('status')}")
                    total_failed += 1
                    sync = await upsert_asset_sync(
                        asset_id=asset_id,
                        account_index=account_index,
                        project_id=project_id,
                        media_id="",
                        flow_handle=flow_handle,
                        status="failed",
                        error=err[:500],
                    )
                    per_account.append(sync)
                    continue
                media_id = adapter.parse_upload_media_id(upload.get("body", "")) or ""
                if not _valid_sync_media_id(media_id):
                    total_failed += 1
                    sync = await upsert_asset_sync(
                        asset_id=asset_id,
                        account_index=account_index,
                        project_id=project_id,
                        media_id="",
                        flow_handle=flow_handle,
                        status="failed",
                        error="Upload xong nhưng không lấy được mediaId",
                    )
                    per_account.append(sync)
                    continue
                total_ok += 1
                sync = await upsert_asset_sync(
                    asset_id=asset_id,
                    account_index=account_index,
                    project_id=project_id,
                    media_id=media_id,
                    flow_handle=flow_handle,
                    status="synced",
                    error="",
                )
                per_account.append(sync)
            except Exception as exc:
                total_failed += 1
                sync = await upsert_asset_sync(
                    asset_id=asset_id,
                    account_index=account_index,
                    project_id=project_id,
                    media_id="",
                    flow_handle=flow_handle,
                    status="failed",
                    error=str(exc)[:500],
                )
                per_account.append(sync)

        results.append(
            {
                "asset_id": asset_id,
                "character_code": character_code,
                "flow_handle": flow_handle,
                "ok": any(s.get("status") == "synced" and s.get("media_id") for s in per_account),
                "syncs": per_account,
            }
        )

    return {"ok": total_ok > 0, "synced": total_ok, "failed": total_failed, "items": results}


async def library_sync_characters_start(req: SyncLibraryAssetsRequest):
    asset_ids = [str(x or "").strip() for x in (req.asset_ids or []) if str(x or "").strip()]
    if not asset_ids:
        raise HTTPException(400, "Chưa chọn ảnh nhân vật nào")

    job_id = uuid.uuid4().hex[:12]
    _CHAR_SYNC_JOBS[job_id] = {
        "ok": True,
        "job_id": job_id,
        "status": "running",
        "progress": 0,
        "done": 0,
        "total": 0,
        "synced": 0,
        "skipped": 0,
        "failed": 0,
        "message": "Đang chuẩn bị đồng bộ...",
        "items": [],
    }
    asyncio.create_task(_run_character_sync_job(job_id, asset_ids))
    return _CHAR_SYNC_JOBS[job_id]


async def library_sync_character_status(job_id: str):
    job = _CHAR_SYNC_JOBS.get(str(job_id or ""))
    if not job:
        raise HTTPException(404, "Không tìm thấy job đồng bộ")
    return job


async def _run_character_sync_job(job_id: str, asset_ids: list[str]) -> None:
    from adapters.google_labs import GoogleLabsAdapter
    from services.library_service import delete_invalid_asset_syncs, get_asset, list_asset_syncs, upsert_asset_sync

    job = _CHAR_SYNC_JOBS[job_id]
    accounts = [
        a for a in get_active_accounts()
        if str(a.get("PROJECT_ID", "")).strip() and str(a.get("ACCESS_TOKEN", "")).strip()
    ]
    if not accounts:
        job.update({"status": "failed", "message": "Chưa có account nào có token và Project ID"})
        return

    adapter = GoogleLabsAdapter()
    removed_invalid = await delete_invalid_asset_syncs()
    if removed_invalid:
        logger.info("[LibrarySync] removed %s invalid sync rows before sync", removed_invalid)

    pairs: list[tuple[dict, dict, str, str, str, str]] = []
    results_by_asset: dict[str, dict] = {}

    for asset_id in asset_ids:
        asset = await get_asset(asset_id)
        if not asset:
            job["failed"] += 1
            job["items"].append({"asset_id": asset_id, "ok": False, "error": "Asset không tồn tại"})
            continue
        if asset.get("asset_type") != "nhanvat":
            job["failed"] += 1
            job["items"].append({"asset_id": asset_id, "ok": False, "error": "Chỉ đồng bộ ảnh loại Nhân Vật"})
            continue
        path = asset.get("path")
        if not path or not Path(path).exists():
            job["failed"] += 1
            job["items"].append({"asset_id": asset_id, "ok": False, "error": "Không tìm thấy file ảnh"})
            continue
        raw = Path(path).read_bytes()
        if not raw:
            job["failed"] += 1
            job["items"].append({"asset_id": asset_id, "ok": False, "error": "File ảnh rỗng"})
            continue

        suffix = Path(str(asset.get("filename") or "")).suffix or ".jpg"
        character_code = str(asset.get("name") or "").strip()
        flow_handle = _safe_flow_handle(character_code, suffix)
        mime = "image/png" if suffix.lower() == ".png" else "image/jpeg"
        b64 = base64.b64encode(raw).decode()
        results_by_asset[asset_id] = {
            "asset_id": asset_id,
            "character_code": character_code,
            "flow_handle": flow_handle,
            "ok": False,
            "syncs": [],
        }
        existing = {
            (int(s.get("account_index") or 0), str(s.get("project_id") or "")): s
            for s in await list_asset_syncs(asset_id)
        }
        for account in accounts:
            account_index = int(account.get("_index") or 0)
            project_id = str(account.get("PROJECT_ID") or "")
            old = existing.get((account_index, project_id))
            if old and old.get("status") == "synced" and _valid_sync_media_id(old.get("media_id", "")):
                job["skipped"] += 1
                results_by_asset[asset_id]["ok"] = True
                results_by_asset[asset_id]["syncs"].append(old)
            else:
                pairs.append((asset, account, b64, mime, flow_handle, project_id))

    job["total"] = len(pairs) + int(job.get("skipped", 0)) + int(job.get("failed", 0))
    if job["total"] <= 0:
        job.update({
            "status": "completed",
            "progress": 100,
            "message": "Tất cả ảnh đã được đồng bộ sẵn",
            "items": list(results_by_asset.values()) or job["items"],
        })
        return

    sem = asyncio.Semaphore(_CHAR_SYNC_MAX_CONCURRENT)

    def tick(message: str = "") -> None:
        job["done"] = int(job.get("synced", 0)) + int(job.get("skipped", 0)) + int(job.get("failed", 0))
        job["progress"] = min(100, int(job["done"] * 100 / max(1, int(job.get("total") or 1))))
        if message:
            job["message"] = message

    async def sync_one(asset: dict, account: dict, b64: str, mime: str, flow_handle: str, project_id: str) -> None:
        async with sem:
            asset_id = str(asset.get("id") or "")
            account_index = int(account.get("_index") or 0)
            code = str(asset.get("name") or asset_id)
            try:
                tick(f"Đang sync {code} -> account #{account_index}")
                upload = await adapter.upload_flow_image(b64, mime, account, file_name=flow_handle)
                if not upload.get("ok"):
                    err = str(upload.get("body") or upload.get("reason") or f"HTTP {upload.get('status')}")
                    job["failed"] += 1
                    sync = await upsert_asset_sync(
                        asset_id=asset_id,
                        account_index=account_index,
                        project_id=project_id,
                        media_id="",
                        flow_handle=flow_handle,
                        status="failed",
                        error=err[:500],
                    )
                else:
                    media_id = adapter.parse_upload_media_id(upload.get("body", "")) or ""
                    if not _valid_sync_media_id(media_id):
                        job["failed"] += 1
                        sync = await upsert_asset_sync(
                            asset_id=asset_id,
                            account_index=account_index,
                            project_id=project_id,
                            media_id="",
                            flow_handle=flow_handle,
                            status="failed",
                            error="Upload xong nhưng mediaId không hợp lệ",
                        )
                    else:
                        job["synced"] += 1
                        sync = await upsert_asset_sync(
                            asset_id=asset_id,
                            account_index=account_index,
                            project_id=project_id,
                            media_id=media_id,
                            flow_handle=flow_handle,
                            status="synced",
                            error="",
                        )
                        results_by_asset[asset_id]["ok"] = True
                results_by_asset[asset_id]["syncs"].append(sync)
            except Exception as exc:
                job["failed"] += 1
                sync = await upsert_asset_sync(
                    asset_id=asset_id,
                    account_index=account_index,
                    project_id=project_id,
                    media_id="",
                    flow_handle=flow_handle,
                    status="failed",
                    error=str(exc)[:500],
                )
                results_by_asset[asset_id]["syncs"].append(sync)
            finally:
                tick()

    await asyncio.gather(*[sync_one(*pair) for pair in pairs])
    job["items"] = list(results_by_asset.values()) or job["items"]
    job["status"] = "completed" if int(job.get("synced", 0)) or int(job.get("skipped", 0)) else "failed"
    job["progress"] = 100
    job["message"] = f"Đồng bộ xong: mới {job.get('synced', 0)}, đã có {job.get('skipped', 0)}, lỗi {job.get('failed', 0)}"


@router.delete("/library/assets/{asset_id}")
async def library_delete_asset(asset_id: str):
    from services.library_service import delete_asset

    deleted = await delete_asset(asset_id)
    if not deleted:
        raise HTTPException(404, "Asset not found")
    return {"ok": True}


class RenameAssetRequest(BaseModel):
    name: str


@router.patch("/library/assets/{asset_id}/rename")
async def library_rename_asset(asset_id: str, req: RenameAssetRequest):
    from services.library_service import rename_asset

    try:
        ok = await rename_asset(asset_id, req.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Asset not found")
    return {"ok": True}


class MoveAssetsRequest(BaseModel):
    asset_ids: list[str]
    target_category_id: str


@router.post("/library/assets/move")
async def library_move_assets(req: MoveAssetsRequest):
    from services.library_service import move_assets

    try:
        count = await move_assets(req.asset_ids, req.target_category_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "moved": count}


class RenameCategoryRequest(BaseModel):
    name: str


@router.patch("/library/categories/{category_id}/rename")
async def library_rename_category(category_id: str, req: RenameCategoryRequest):
    from services.library_service import rename_category

    try:
        ok = await rename_category(category_id, req.name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "Category not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Upscale Image
# ---------------------------------------------------------------------------

class UpscaleImageRequest(BaseModel):
    media_id: str


@router.post("/upscale")
async def upscale_image(req: UpscaleImageRequest):
    from adapters.google_labs import GoogleLabsAdapter
    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()
    result = await adapter.upscale_image(req.media_id, account.get("ACCESS_TOKEN", ""))
    medias = adapter.parse_image_results(result.get("body", ""))
    return {"ok": result.get("ok", False), "images": medias}


# ---------------------------------------------------------------------------
# Get image URL by quality (1k=gốc, 2k, 4k) — dùng cho download + lưu kho
# ---------------------------------------------------------------------------

class ImageQualityRequest(BaseModel):
    media_id: str
    url: str = ""          # URL gốc (dùng cho 1k nếu có sẵn)
    quality: str = "1k"    # "1k" | "2k" | "4k"
    account_index: int = 0


@router.post("/get-quality-url")
async def get_quality_url(req: ImageQualityRequest):
    """Trả về URL ảnh theo quality. 1k = URL gốc, 2k/4k = gọi upsampleImage qua extension."""
    from adapters.google_labs import GoogleLabsAdapter, URL_UPSCALE_IMAGE
    from routers.extension import request_browser_submit

    adapter = GoogleLabsAdapter()

    if req.quality == "1k":
        return {"ok": True, "url": req.url, "quality": "1k"}

    if not req.media_id:
        raise HTTPException(400, "media_id bắt buộc cho quality 2k/4k")

    account = _get_account_or_raise(req.account_index)
    account_idx = int(account.get("_index") or 1)
    payload = adapter.build_upscale_image_payload(req.media_id, quality=req.quality, recaptcha_token="", account=account)
    upscale_timeout = 150.0 if str(req.quality).lower() == "4k" else 90.0

    # Dùng extension để inject recaptcha token, retry tối đa 2 lần
    result = {"ok": False}
    for _attempt in range(2):
        result = await request_browser_submit(
            str(uuid.uuid4()),
            job_type="image_upscale",
            url=URL_UPSCALE_IMAGE,
            payload=payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_idx,
            timeout_seconds=upscale_timeout,
        )
        if result.get("ok"):
            break
        if _attempt == 0:
            await asyncio.sleep(3)
            account = _get_account_or_raise(req.account_index)
            account_idx = int(account.get("_index") or 1)
            payload = adapter.build_upscale_image_payload(req.media_id, quality=req.quality, recaptcha_token="", account=account)

    if not result.get("ok"):
        raise HTTPException(500, f"Upscale ảnh thất bại: HTTP {result.get('status')} {str(result.get('body',''))[:200]}")

    import json as _json
    try:
        body_json = _json.loads(result.get("body", ""))
        encoded = body_json.get("encodedImage", "")
    except Exception:
        encoded = ""

    if not encoded:
        raise HTTPException(500, "Không lấy được ảnh upscale từ response")

    data_url = f"data:image/jpeg;base64,{encoded}"
    return {"ok": True, "url": data_url, "quality": req.quality}


# ---------------------------------------------------------------------------
# Batch save images to library with quality (2 account song song)
# ---------------------------------------------------------------------------

class BatchSaveLibRequest(BaseModel):
    images: list[dict]     # [{url, media_id, prompt, card_title}]
    category_id: str = "default"
    quality: str = "1k"    # "1k" | "2k" | "4k"


@router.post("/studio/batch-save-lib")
async def batch_save_lib(req: BatchSaveLibRequest):
    """
    Lưu nhiều ảnh vào kho với quality tùy chọn.
    Chia đều 2 account để tăng tốc. Auto retry 1 lần nếu lỗi.
    Trả về progress dạng streaming (SSE) để FE hiển thị thanh load.
    """
    import asyncio
    import httpx
    from adapters.google_labs import GoogleLabsAdapter
    from services.library_service import save_library_asset
    from fastapi.responses import StreamingResponse
    import json as _json

    adapter = GoogleLabsAdapter()
    accounts = get_active_accounts()
    acc1 = accounts[0] if len(accounts) > 0 else None
    acc2 = accounts[1] if len(accounts) > 1 else acc1
    if not acc1:
        raise HTTPException(400, "Chưa có account nào")

    images = req.images
    total = len(images)

    async def process_one(idx: int, item: dict, account, account_index: int) -> dict:
        media_id = item.get("media_id", "")
        url = item.get("url", "")
        prompt = item.get("prompt", "")
        asset_type = item.get("asset_type", "nhanvat")
        custom_name = str(item.get("name") or item.get("filename") or "").strip()

        import json as _json, base64 as _b64
        upscaled_bytes: bytes | None = None

        # Lấy ảnh upscale qua extension (trả encodedImage base64)
        if req.quality != "1k" and media_id:
            from routers.extension import request_browser_submit
            from adapters.google_labs import URL_UPSCALE_IMAGE
            upscale_timeout = 150.0 if str(req.quality).lower() == "4k" else 90.0
            for attempt in range(2):
                try:
                    payload = adapter.build_upscale_image_payload(media_id, quality=req.quality, recaptcha_token="", account=account)
                    result = await request_browser_submit(
                        str(uuid.uuid4()), job_type="image_upscale",
                        url=URL_UPSCALE_IMAGE, payload=payload,
                        access_token=account.get("ACCESS_TOKEN", ""),
                        account_index=account_index,
                        timeout_seconds=upscale_timeout,
                    )
                    if result.get("ok"):
                        body_json = _json.loads(result.get("body", "{}"))
                        encoded = body_json.get("encodedImage", "")
                        if encoded:
                            upscaled_bytes = _b64.b64decode(encoded)
                            break
                except Exception:
                    if attempt == 0:
                        await asyncio.sleep(1)

        # Download + lưu kho, retry 1 lần
        for attempt in range(2):
            try:
                if upscaled_bytes:
                    image_bytes = upscaled_bytes
                else:
                    async with httpx.AsyncClient(timeout=60) as client:
                        resp = await client.get(url)
                        resp.raise_for_status()
                        image_bytes = resp.content
                if custom_name:
                    import re as _re
                    safe_stem = _re.sub(r"[\\/:*?\"<>|]+", "_", custom_name).strip().strip(".")
                    fname = f"{safe_stem or ('studio_' + uuid.uuid4().hex[:12])}.jpg"
                else:
                    fname = f"studio_{uuid.uuid4().hex[:12]}.jpg"
                asset = await save_library_asset(
                    image_bytes=image_bytes,
                    filename=fname,
                    prompt=prompt,
                    category_id=req.category_id,
                    source_type="studio",
                    origin_url=url,
                    media_id=media_id,
                    asset_type=asset_type,
                )
                return {"ok": True, "idx": idx, "asset": asset}
            except Exception as e:
                if attempt == 0:
                    await asyncio.sleep(1)
                else:
                    return {"ok": False, "idx": idx, "error": str(e)}

    async def stream():
        done = 0
        # Chia batch thành 2 luồng xen kẽ theo account
        sem = asyncio.Semaphore(4)  # tối đa 4 concurrent

        async def run(idx, item, acc, acc_idx):
            nonlocal done
            async with sem:
                result = await process_one(idx, item, acc, acc_idx)
                done += 1
                yield_data = _json.dumps({"done": done, "total": total, "ok": result["ok"], "idx": idx})
                return yield_data

        tasks = []
        for i, item in enumerate(images):
            acc = acc1 if i % 2 == 0 else acc2
            acc_idx = int(acc.get("_index") or 1)
            tasks.append(run(i, item, acc, acc_idx))

        for coro in asyncio.as_completed([t for t in tasks]):
            data = await coro
            yield f"data: {data}\n\n"

        yield f"data: {_json.dumps({'done': total, 'total': total, 'finished': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Frame Cutter (FFmpeg)
# ---------------------------------------------------------------------------

class FrameCutterRequest(BaseModel):
    video_path: str
    output_folder: str | None = None
    interval: float = 1.0
    start_at: float = 0.0
    end_at: float | None = None
    img_format: str = "jpg"
    jpg_quality: int = 90


@router.post("/frame-cutter")
async def frame_cutter(req: FrameCutterRequest):
    from adapters.ffmpeg import FFmpegAdapter
    adapter = FFmpegAdapter()

    out_dir = req.output_folder or str(BASE_DIR / "data" / "jobs" / f"frames_{uuid.uuid4().hex[:8]}")
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    start_ts = f"{int(req.start_at//3600):02d}:{int((req.start_at%3600)//60):02d}:{req.start_at%60:06.3f}"
    end_at = req.end_at or (req.start_at + 5)
    end_ts = f"{int(end_at//3600):02d}:{int((end_at%3600)//60):02d}:{end_at%60:06.3f}"
    fps = max(1, int(1.0 / max(0.1, req.interval)))

    ok, msg, files = await adapter.cut_frames_range(req.video_path, out_dir, start_ts, end_ts, fps)
    if not ok:
        raise HTTPException(500, f"FFmpeg error: {msg}")
    frames = [{"path": f, "url": f"/jobs/{Path(f).name}"} for f in files]
    return {"ok": True, "output_dir": out_dir, "frame_count": len(frames), "frames": frames[:20]}


# ---------------------------------------------------------------------------
# Cut frames from uploaded video (form upload)
# ---------------------------------------------------------------------------

@router.post("/cut-frames")
async def cut_frames_upload(
    video: UploadFile = File(...),
    start_time: str = Form("00:00:00"),
    end_time: str = Form("00:00:05"),
    fps: int = Form(1),
):
    from adapters.ffmpeg import FFmpegAdapter
    adapter = FFmpegAdapter()
    upload_dir = BASE_DIR / "data" / "jobs"
    upload_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(video.filename or "video.mp4").suffix or ".mp4"
    vid_path = upload_dir / f"fc_{uuid.uuid4().hex[:8]}{ext}"
    vid_path.write_bytes(await video.read())
    out_dir = str(upload_dir / f"frames_{uuid.uuid4().hex[:8]}")
    ok, msg, files = await adapter.cut_frames_range(str(vid_path), out_dir, start_time, end_time, fps)
    if not ok:
        raise HTTPException(500, f"FFmpeg error: {msg}")
    frames = [{"path": f, "url": f"/jobs/{Path(f).name}"} for f in files]
    return {"ok": True, "frames": frames}


# ---------------------------------------------------------------------------
# Generate Whisk (form-based with optional ref image)
# ---------------------------------------------------------------------------

@router.post("/generate-whisk")
async def generate_whisk_form(
    prompt: str = Form(...),
    aspect_ratio: str = Form("1:1"),
    count: int = Form(1),
    ref_image: UploadFile = File(None),
):
    from adapters.google_labs import GoogleLabsAdapter
    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()

    ref_media_id = None
    if ref_image and ref_image.filename:
        rb = await ref_image.read()
        rb64 = base64.b64encode(rb).decode()
        upload = await adapter.upload_image(rb64, ref_image.content_type or "image/jpeg", account)
        if upload.get("ok"):
            ref_media_id = adapter.parse_upload_media_id(upload.get("body", ""))

    result = await adapter.generate_whisk_image(
        prompt=prompt,
        account=account,
        aspect_ratio=aspect_ratio,
        output_count=count,
        ref_media_id=ref_media_id,
    )
    if not result.get("ok"):
        raise HTTPException(400, f"Whisk error: {result.get('body', '')}")
    medias = adapter.parse_image_results(result.get("body", ""))
    return {"ok": True, "images": medias}


# ---------------------------------------------------------------------------
# Virtual Try-On (person/garment field names for frontend)
# ---------------------------------------------------------------------------

@router.post("/virtual-tryon")
async def virtual_tryon_v2(
    person_image: UploadFile = File(None),
    garment_image: UploadFile = File(None),
    model_image: UploadFile = File(None),
    clothing_image: UploadFile = File(None),
    prompt: str = Form("Realistic virtual try-on"),
    output_count: int = Form(2),
):
    from adapters.google_labs import GoogleLabsAdapter
    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()
    person_file = person_image or model_image
    garment_file = garment_image or clothing_image
    if not person_file or not garment_file:
        raise HTTPException(400, "Cần cả ảnh người và trang phục")

    async def _upload(f: UploadFile):
        b64 = base64.b64encode(await f.read()).decode()
        res = await adapter.upload_image(b64, f.content_type or "image/jpeg", account)
        if not res.get("ok"):
            raise HTTPException(400, "Upload thất bại")
        return adapter.parse_upload_media_id(res.get("body", ""))

    person_mid = await _upload(person_file)
    garment_mid = await _upload(garment_file)
    result = await adapter.virtual_tryon(person_mid, garment_mid, prompt, account, output_count)
    if not result.get("ok"):
        raise HTTPException(400, f"API error: {result.get('body', '')}")
    return {"ok": True, "images": adapter.parse_image_results(result.get("body", ""))}
