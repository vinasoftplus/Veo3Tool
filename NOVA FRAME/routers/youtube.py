"""YouTube routes — View Hunter, Script Analyzer."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import job_store
from services.config_service import load_config, get_gemini_keys

router = APIRouter(tags=["youtube"])


# ---------------------------------------------------------------------------
# View Hunter
# ---------------------------------------------------------------------------

class ViewHunterRequest(BaseModel):
    keyword: str
    region_code: str | None = None
    order: str = "viewCount"
    published_after: str | None = None
    max_results: int = 50


@router.post("/search")
async def search_videos(req: ViewHunterRequest):
    from services.youtube.view_hunter import ViewHunterService
    cfg = load_config()
    api_key = cfg.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(400, "Chưa có YouTube API Key. Vào Cài đặt để thêm.")

    svc = ViewHunterService(api_key)
    try:
        results = await svc.search(
            keyword=req.keyword,
            region_code=req.region_code,
            order=req.order,
            published_after=req.published_after,
            max_results=req.max_results,
        )
        return {"ok": True, "results": results}
    except Exception as e:
        raise HTTPException(500, str(e))


# ---------------------------------------------------------------------------
# Script Analyzer
# ---------------------------------------------------------------------------

class ScriptRequest(BaseModel):
    youtube_url: str
    language: str = "vi"
    instruction: str = ""
    time_start: str | None = None
    time_end: str | None = None


@router.post("/script")
async def start_script(req: ScriptRequest):
    from services.youtube.script_analyzer import ScriptAnalyzerService
    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key")

    job_id = await job_store.create_job("ytb_script", {
        "youtube_url": req.youtube_url,
        "language": req.language,
        "instruction": req.instruction,
        "time_start": req.time_start,
        "time_end": req.time_end,
    })
    svc = ScriptAnalyzerService(keys[0])
    asyncio.create_task(svc.run_job(job_id, req.youtube_url, req.language, req.instruction))
    return {"ok": True, "job_id": job_id}


@router.get("/script/{job_id}")
async def script_status(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job không tìm thấy")
    return {"ok": True, "job": job}


class SaveScriptRequest(BaseModel):
    content: str
    filename: str | None = None


@router.post("/script/save")
async def save_script(req: SaveScriptRequest):
    from services.config_service import BASE_DIR
    import uuid as _uuid
    save_dir = BASE_DIR / "data" / "jobs"
    fname = req.filename or f"script_{_uuid.uuid4().hex[:8]}.txt"
    (save_dir / fname).write_text(req.content, encoding="utf-8")
    return {"ok": True, "url": f"/jobs/{fname}"}
