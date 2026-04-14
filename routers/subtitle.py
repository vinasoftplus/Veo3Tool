"""Subtitle routes — extraction via Gemini, SRT save, FFmpeg burn."""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import job_store
from services.config_service import BASE_DIR, get_gemini_keys

router = APIRouter(tags=["subtitle"])


@router.post("/start")
async def start_subtitle(
    video: UploadFile = File(...),
    language: str = Form("vi"),
):
    """Upload video → start Gemini subtitle extraction job."""
    from services.subtitle.subtitle_service import SubtitleService
    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key. Vào Cài đặt để thêm.")

    # Save uploaded video
    upload_dir = BASE_DIR / "data" / "jobs"
    upload_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(video.filename or "video.mp4").suffix or ".mp4"
    video_filename = f"subtitle_src_{uuid.uuid4().hex[:8]}{ext}"
    video_path = upload_dir / video_filename
    video_path.write_bytes(await video.read())

    job_id = await job_store.create_job("subtitle", {
        "video_path": str(video_path),
        "language": language,
    })
    asyncio.create_task(SubtitleService(keys[0]).run_job(job_id, str(video_path), language))
    return {"ok": True, "job_id": job_id}


@router.get("/{job_id}")
async def get_subtitle_status(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job không tìm thấy")
    return {"ok": True, "job": job}


class SaveSRTRequest(BaseModel):
    job_id: str
    srt_content: str
    filename: str | None = None


@router.post("/save-srt")
async def save_srt(req: SaveSRTRequest):
    out_dir = BASE_DIR / "data" / "jobs"
    fname = req.filename or f"subtitle_{req.job_id[:8]}.srt"
    out_path = out_dir / fname
    out_path.write_text(req.srt_content, encoding="utf-8")
    return {"ok": True, "path": str(out_path), "url": f"/jobs/{fname}"}


class BurnRequest(BaseModel):
    video_path: str
    srt_path: str
    output_filename: str | None = None


@router.post("/burn")
async def burn_subtitle(req: BurnRequest):
    from adapters.ffmpeg import FFmpegAdapter
    adapter = FFmpegAdapter()
    out_dir = BASE_DIR / "data" / "jobs"
    out_fname = req.output_filename or f"burned_{uuid.uuid4().hex[:8]}.mp4"
    out_path = str(out_dir / out_fname)
    success, msg = await adapter.burn_subtitles(req.video_path, req.srt_path, out_path)
    if not success:
        raise HTTPException(500, f"FFmpeg lỗi: {msg}")
    return {"ok": True, "output_path": out_path, "url": f"/jobs/{out_fname}"}
