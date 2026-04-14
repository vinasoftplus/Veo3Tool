"""Image generation routes — Banana, Whisk, Virtual Try-On, Frame Cutter."""
from __future__ import annotations

import asyncio
import base64
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import job_store
from services.config_service import get_active_accounts, BASE_DIR

router = APIRouter(tags=["image"])


def _get_account_or_raise():
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chưa có account nào có token.")
    return accounts[0]


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
    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()

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

    medias = adapter.parse_image_results(result.get("body", ""))
    return {"ok": True, "images": medias}


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
