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


# ---------------------------------------------------------------------------
# Master Script — analyze YouTube video with master prompt template
# ---------------------------------------------------------------------------

class MasterScriptRequest(BaseModel):
    youtube_url: str


_MASTER_PROMPT = """Act as a Creative Director, Lead 3D Animator, and Data Architect for a heartwarming 3D animated feature "[SERIES_NAME]".

Your task is to generate a bulletproof video production plan in a **DUAL FORMAT** (Part 1: Production Header, Part 2: JSON Array).

### MISSION & BATCH LOGIC:
* **TOTAL DURATION TARGET:** [INSERT TARGET DURATION]
* **CURRENT DELIVERY:** Generate ONLY exactly [INSERT SCENE COUNT] SCENES per prompt.
* **PROGRESS TRACKING:** [INSERT BATCH / CONTINUATION RULE]
* **TOTAL BATCHES:** [INSERT BATCH PLAN]

### GLOBAL CONSTRAINTS & BRAND SAFETY PROTOCOL:
1. **LANGUAGE:** Strictly **ENGLISH ONLY**.
2. **JSON STRUCTURE:** Use the EXACT JSON schema provided below. Do NOT add, remove, or rename any keys.
3. **SAFETY POLICY:** [INSERT SAFETY RULES]
4. **NO TRADEMARKS:** [INSERT IP / BRAND RESTRICTIONS]
5. **EMOTIONAL CORE (CRITICAL):** [INSERT CORE EMOTIONAL RULE]
6. **NO HUMANS:** Absolutely no humans, no human-like people, no human faces, no human hands, no human bodies, no human silhouettes, and no human photos or human figures anywhere in any scene or prompt.
7. **NO TEXT ON SCREEN:** Do not generate visible text, captions, signage, labels, logos, subtitles, letters, or written elements inside the image content.
8. **NO DIALOGUE / NO VOICEOVER:** Do not include spoken dialogue, narration, or character speech. All storytelling must be visual only.

### CAMERA, MOTION & TIMING:
* **GOLDEN RULE:** [INSERT CINEMATIC MOTION RULE]
* **HIGH TENSION / ACTION:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **TENDER / EMOTIONAL:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **WONDER / ESTABLISHING:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **CINEMATOGRAPHY:** [INSERT SHOT VARIETY RULES]

### ASSET BIBLE & 3D STYLE GUIDE:
* **VISUAL STYLE:** [INSERT VISUAL STYLE]
* **SHADERS & TEXTURES:** [INSERT SHADER / TEXTURE RULES]
* **LIGHTING & RENDERING:** [INSERT LIGHTING RULES]
* **ANIMATION STYLE:** [INSERT ANIMATION RULES]

### NARRATIVE STYLE:
* **CORE THEME:** [INSERT CORE THEME]
* **EMOTIONAL ARC TEMPLATE:**
  1. [STEP 1]
  2. [STEP 2]
  3. [STEP 3]
  4. [STEP 4]
  5. [STEP 5]
  6. [STEP 6]
* **DUAL-EMOTION STORYTELLING:** [INSERT TONE RULES]
* **THE NARRATOR:** None. No narrator, no voiceover, no spoken lines.

### CHARACTER VISUAL DATABASE:
**CASTING RULE:** [INSERT CASTING LIMIT / ON-SCREEN RULE]

(Use these EXACT descriptions strictly in the `prompt` fields. Use ONLY Code Names in `prompt` fields.)

1. **Code: [CHARACTER_CODE_1] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
2. **Code: [CHARACTER_CODE_2] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
3. **Code: [CHARACTER_CODE_3] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
4. **Code: [CHARACTER_CODE_4] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
5. **Code: [CHARACTER_CODE_5] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
6. **Code: [CHARACTER_CODE_6] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
7. **Code: [CHARACTER_CODE_7] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"
8. **Code: [CHARACTER_CODE_8] ([ROLE]):** "[INSERT EXACT VISUAL DESCRIPTION]"

### WORLD & LOCATION BIBLE:
Define locations once, then reuse exactly.

* **[LOCATION_CODE_1]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_2]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_3]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_4]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_5]:** "[INSERT LOCKED LOCATION DESCRIPTION]"
* **[LOCATION_CODE_6]:** "[INSERT LOCKED LOCATION DESCRIPTION]"

### LOGIC RULES & NARRATIVE STRUCTURE:
1. **CASTING:** [INSERT CASTING RULE]
2. **SEGMENTS PER BATCH:** [INSERT SEGMENT COUNT]
3. **TOTAL SCENES:** [INSERT TOTAL SCENE COUNT]
4. **FULL STORY STRUCTURE:**
   * **Scenes [RANGE 1]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 2]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 3]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 4]:** [INSERT STORY FUNCTION]
   * **Scenes [RANGE 5]:** [INSERT STORY FUNCTION]
5. **CONTINUITY:** [INSERT CONTINUITY RULE]
6. **ANTI-REPETITION:** [INSERT ANTI-REPETITION RULE]
7. **PLATFORM SAFETY:** [INSERT PLATFORM / CONTENT RESTRICTIONS]

### OUTPUT FORMAT (STRICT ORDER):

**PART 1: PROJECT FOUNDATION HEADER**
* **SERIES TITLE:** [INSERT EPISODE TITLE]
* **BATCH PROGRESS:** [INSERT CURRENT BATCH STATUS]
* **CAST:** [INSERT CODE NAMES + ROLES]
* **EMOTIONAL CORE:** [INSERT 1-SENTENCE ARC SUMMARY]
* **LOCATIONS LOCKED:** [INSERT LOCKED LOCATIONS USED]

**PART 2: SCRIPT DATA (JSON ARRAY)**
Output a single JSON Array `[...]` containing exactly [INSERT COUNT] segment objects. Use this schema strictly:

```json
[
  {
    "description": "[INSERT SCENE DESCRIPTION]",
    "characters": {
      "main": "[Code Name] - [Database Description]",
      "others": [
        "[Code Name 1]",
        "[Code Name 2]"
      ]
    },
    "style": "[INSERT STYLE STRING]",
    "sfx": "[INSERT NON-VERBAL SFX / AMBIENCE / MUSIC ONLY]",
    "background": "[INSERT LOCKED LOCATION DESCRIPTION]",
    "prompt": "Priority: Strictly follow the official character references and preserve exact character design consistency. Absolutely no humans, no human-like people, no human faces, no human hands, no human bodies, no human silhouettes, and no human photos or human figures anywhere in the frame. No visible text, no captions, no labels, no signage, no logos, no subtitles, no letters, and no written elements inside the image. [INSERT FULL IMAGE PROMPT]",
    "scene_index": [INSERT INTEGER],
    "duration_seconds": "[INSERT INTEGER OR RULE-BASED VALUE]",
    "shot": {
      "camera": "[INSERT CAMERA TYPE]",
      "lens": "[INSERT LENS]",
      "movement": "[INSERT MOVEMENT]",
      "composition": "[INSERT COMPOSITION]"
    },
    "action": "[INSERT ACTION SUMMARY]",
    "negative": "[INSERT NEGATIVE PROMPT, including humans, human-like figures, text, letters, subtitles, logos, signage, watermarks, and dialogue indicators]",
    "attachments": {
      "characters": [
        "[Code Name 1]",
        "[Code Name 2]"
      ],
      "items": [
        "[INSERT PROP 1]",
        "[INSERT PROP 2]"
      ],
      "backgrounds": [
        "[INSERT BACKGROUND ASSET NAME]"
      ]
    }
  }
]
```

Do not output any narration script, dialogue, subtitle text, or voiceover text."""


@router.post("/master-script")
async def master_script(req: MasterScriptRequest):
    from adapters.gemini import GeminiAdapter

    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key. Vào Cài đặt để thêm.")

    master_prompt = _MASTER_PROMPT

    job_id = await job_store.create_job("master_script", {"youtube_url": req.youtube_url})

    async def _run():
        try:
            await job_store.update_job(job_id, status="running", progress=10)
            adapter = GeminiAdapter(keys[0])
            result = await adapter.analyze_youtube_master_prompt(req.youtube_url, master_prompt)
            await job_store.update_job(job_id, status="done", progress=100, outputs={"md": result})
        except Exception as e:
            await job_store.update_job(job_id, status="failed", error=str(e))

    asyncio.create_task(_run())
    return {"ok": True, "job_id": job_id}


@router.get("/master-script/{job_id}")
async def master_script_status(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job không tìm thấy")
    return {"ok": True, "job": job}


# ---------------------------------------------------------------------------
# Auto Master Prompt
# ---------------------------------------------------------------------------

class AutoMasterPromptRequest(BaseModel):
    idea: str
    scene_count: int
    duration_seconds: int
    video_type: str = "youtube_long"  # "youtube_long" | "short_tiktok"


@router.post("/auto-master-prompt")
async def auto_master_prompt(req: AutoMasterPromptRequest):
    from adapters.gemini import GeminiAdapter

    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key. Vào Cài đặt để thêm.")

    # Fill known values into the master prompt template
    type_label = "YouTube Long-form" if req.video_type == "youtube_long" else "Short / TikTok Vertical"
    mins = req.duration_seconds // 60
    secs = req.duration_seconds % 60
    duration_str = f"{mins}:{secs:02d}" if mins else f"{secs}s"

    filled = (
        _MASTER_PROMPT
        .replace("[INSERT TARGET DURATION]", f"{duration_str} ({req.duration_seconds}s total) — {type_label}")
        .replace("[INSERT SCENE COUNT]", str(req.scene_count))
        .replace("[INSERT BATCH / CONTINUATION RULE]", "Generate all scenes in one response")
        .replace("[INSERT BATCH PLAN]", "1 batch (all scenes)")
        .replace("[INSERT TOTAL SCENE COUNT]", str(req.scene_count))
        .replace("[INSERT COUNT]", str(req.scene_count))
    )

    user_message = (
        f"{req.idea}\n\n"
        f"Viết master prompt cho idea trên theo form này, giữ nguyên bố cục master prompt "
        f"và làm đầy đủ các yêu cầu trong đó và gửi tôi Master Prompt hoàn chỉnh:\n\n"
        f"{filled}"
    )

    job_id = await job_store.create_job("auto_master_prompt", {
        "idea": req.idea,
        "scene_count": req.scene_count,
        "duration_seconds": req.duration_seconds,
        "video_type": req.video_type,
    })

    async def _run():
        try:
            await job_store.update_job(job_id, status="running", progress=10)
            adapter = GeminiAdapter(keys[0])
            result = await adapter.analyze_text(user_message, "", model="gemini-2.5-flash")
            await job_store.update_job(job_id, status="done", progress=100, outputs={"md": result})
        except Exception as e:
            await job_store.update_job(job_id, status="failed", error=str(e))

    asyncio.create_task(_run())
    return {"ok": True, "job_id": job_id}


@router.get("/auto-master-prompt/{job_id}")
async def auto_master_prompt_status(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job không tìm thấy")
    return {"ok": True, "job": job}


# ---------------------------------------------------------------------------
# Channel Analyzer
# ---------------------------------------------------------------------------

class ChannelAnalyzeRequest(BaseModel):
    channel_url: str
    max_videos: int = 30


@router.post("/channel-analyze")
async def channel_analyze(req: ChannelAnalyzeRequest):
    from services.youtube.channel_analyzer import ChannelAnalyzerService
    cfg = load_config()
    api_key = cfg.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(400, "Chưa có YouTube API Key. Vào Cài đặt để thêm.")
    svc = ChannelAnalyzerService(api_key)
    try:
        result = await svc.analyze(req.channel_url, max_videos=req.max_videos)
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(500, str(e))
