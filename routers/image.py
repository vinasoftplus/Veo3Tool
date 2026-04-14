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


def _get_account_or_raise():
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chưa có account nào có token.")
    return accounts[0]


def _token_option() -> str:
    cfg = load_config()
    return str(cfg.get("TOKEN_OPTION", "Option 1") or "Option 1").strip()


def _normalize_images(medias: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for item in medias or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url") or item.get("downloadUrl") or item.get("image_url") or item.get("imageUrl") or ""
        media_id = item.get("media_id") or item.get("mediaId") or item.get("mediaGenerationId") or item.get("name") or ""
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
    from routers.extension import request_browser_submit
    from urllib.parse import quote

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    token_option = _token_option()

    if token_option == "Option 2":
        project_id = str(account.get("PROJECT_ID", "") or "").strip()
        if not project_id:
            raise HTTPException(400, "Thiếu PROJECT_ID cho tài khoản hiện tại.")

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
):
    from adapters.google_labs import GoogleLabsAdapter
    from adapters.google_labs import URL_IMG_GEN_TPL
    from routers.extension import request_browser_submit
    from services.character_service import get_character
    from urllib.parse import quote

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    token_option = _token_option()
    project_id = str(account.get("PROJECT_ID", "") or "").strip()
    if not project_id:
        raise HTTPException(400, "Thiếu PROJECT_ID cho tài khoản hiện tại.")

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


@router.get("/library/assets")
async def library_assets():
    from services.library_service import list_assets

    return {"ok": True, "items": await list_assets()}


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
