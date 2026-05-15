"""YouTube routes — View Hunter, Script Analyzer, Comment Extractor."""
from __future__ import annotations

import asyncio
import re
import json as _json
import httpx
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("youtube.router")

from services import job_store
from services.config_service import load_config, get_gemini_keys


def _get_adapter(model_provider: str):
    """Return (adapter, model_name) based on provider string like 'gemini', 'gpt-4o', 'deepseek-chat'."""
    cfg = load_config()
    if model_provider.startswith("gpt") or model_provider == "openai":
        api_key = cfg.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(400, "Chưa có OpenAI API Key. Vào Cài đặt để thêm.")
        from adapters.openai_adapter import OpenAIAdapter
        model = model_provider if model_provider.startswith("gpt") else "gpt-4o"
        return OpenAIAdapter(api_key), model
    if model_provider.startswith("deepseek"):
        api_key = cfg.get("DEEPSEEK_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(400, "Chưa có DeepSeek API Key. Vào Cài đặt để thêm.")
        from adapters.deepseek_adapter import DeepSeekAdapter
        model = model_provider if model_provider != "deepseek" else "deepseek-chat"
        return DeepSeekAdapter(api_key), model
    # Default: Gemini
    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key. Vào Cài đặt để thêm.")
    from adapters.gemini import GeminiAdapter
    model = "gemini-2.5-flash" if model_provider in ("gemini", "gemini-2.5-flash", "") else model_provider
    return GeminiAdapter(keys[0]), model

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
    model: str = "gemini-2.5-flash"


_MASTER_PROMPT = '''Act as [INSERT CREATIVE ROLE / PRODUCTION ROLE] for "[SERIES_NAME]".

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
5. **CORE INTENT:** [INSERT CORE INTENT / EMOTIONAL OR INFORMATIONAL RULE]
6. **HUMAN / CHARACTER POLICY:** [INSERT HUMAN, CHARACTER, CAST, OR SUBJECT RULES]
7. **TEXT ON SCREEN POLICY:** [INSERT TEXT, CAPTION, SIGNAGE, LOGO, SUBTITLE, OR WRITTEN-ELEMENT RULES]
8. **DIALOGUE / VOICEOVER POLICY:** [INSERT DIALOGUE, NARRATION, VOICEOVER, OR SILENT-STORYTELLING RULES]

### CAMERA, MOTION & TIMING:
* **GOLDEN RULE:** [INSERT CINEMATIC MOTION RULE]
* **HIGH TENSION / ACTION:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **LOW-INTENSITY / DETAIL MOMENTS:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **ESTABLISHING / CONTEXT MOMENTS:** [INSERT DURATION + MOVEMENT + CAMERA RULE]
* **CINEMATOGRAPHY:** [INSERT SHOT VARIETY RULES]

### ASSET BIBLE & 3D STYLE GUIDE:
* **VISUAL STYLE:** [INSERT VISUAL STYLE]
* **SHADERS & TEXTURES:** [INSERT SHADER / TEXTURE RULES]
* **LIGHTING & RENDERING:** [INSERT LIGHTING RULES]
* **ANIMATION STYLE:** [INSERT ANIMATION RULES]

### NARRATIVE STYLE:
* **CORE THEME:** [INSERT CORE THEME]
* **NARRATIVE / CONTENT ARC TEMPLATE:**
  1. [STEP 1]
  2. [STEP 2]
  3. [STEP 3]
  4. [STEP 4]
  5. [STEP 5]
  6. [STEP 6]
* **TONE / DELIVERY STYLE:** [INSERT TONE RULES]
* **THE NARRATOR / PRESENTER:** [INSERT NARRATOR, PRESENTER, VOICEOVER, OR NO-NARRATOR RULE]

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
* **CORE INTENT:** [INSERT 1-SENTENCE ARC OR CONTENT SUMMARY]
* **LOCATIONS LOCKED:** [INSERT LOCKED LOCATIONS USED]

**PART 2: SCRIPT DATA (JSON ARRAY SCHEMA)**
Keep exactly ONE sample object in this JSON block as the reusable schema. Do NOT expand it into the full scene list here. Do NOT output all scenes in this master prompt. The full scene JSON will be generated later by using this completed master prompt.

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
    "prompt": "Priority: Strictly follow the official references, style rules, and continuity requirements. [INSERT SUBJECT / HUMAN / CHARACTER POLICY]. [INSERT TEXT / LOGO / SUBTITLE POLICY]. [INSERT FULL IMAGE PROMPT]",
    "scene_index": [INSERT INTEGER],
    "duration_seconds": "[INSERT INTEGER OR RULE-BASED VALUE]",
    "shot": {
      "camera": "[INSERT CAMERA TYPE]",
      "lens": "[INSERT LENS]",
      "movement": "[INSERT MOVEMENT]",
      "composition": "[INSERT COMPOSITION]"
    },
    "action": "[INSERT ACTION SUMMARY]",
    "negative": "[INSERT NEGATIVE PROMPT based on the project rules, including unwanted subjects, styles, text, logos, artifacts, or continuity errors]",
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

Do not output extra explanation outside the required format.'''


def _load_master_prompt() -> str:
    return _MASTER_PROMPT


@router.post("/master-script")
async def master_script(req: MasterScriptRequest):
    adapter, model = _get_adapter(req.model)
    master_prompt = _load_master_prompt()

    job_id = await job_store.create_job("master_script", {"youtube_url": req.youtube_url, "model": req.model})

    async def _run():
        try:
            await job_store.update_job(job_id, status="running", progress=10)
            result = await adapter.analyze_youtube_master_prompt(req.youtube_url, master_prompt, model=model)
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
    model: str = "gemini-2.5-flash"


@router.post("/auto-master-prompt")
async def auto_master_prompt(req: AutoMasterPromptRequest):
    adapter, model = _get_adapter(req.model)

    # Fill known values into the master prompt template
    type_label = "YouTube Long-form" if req.video_type == "youtube_long" else "Short / TikTok Vertical"
    mins = req.duration_seconds // 60
    secs = req.duration_seconds % 60
    duration_str = f"{mins}:{secs:02d}" if mins else f"{secs}s"

    filled = (
        _load_master_prompt()
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
        "IMPORTANT: In PART 2, keep exactly one JSON object as the schema sample. "
        "Do not expand it into the full scene list inside this master prompt.\n\n"
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
            result = await adapter.analyze_text(user_message, "", model=model)
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


# ---------------------------------------------------------------------------
# Comment Extractor (InnerTube API — no API key needed)
# ---------------------------------------------------------------------------

_INNERTUBE_CLIENT = {
    "hl": "en",
    "gl": "VN",
    "clientName": "WEB",
    "clientVersion": "2.20240101.00.00",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "platform": "DESKTOP",
}

_INNERTUBE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _extract_video_id(url_or_id: str) -> str:
    url_or_id = url_or_id.strip()
    # Already an ID (11 chars alphanumeric+dash+underscore)
    if re.match(r'^[A-Za-z0-9_\-]{11}$', url_or_id):
        return url_or_id
    m = re.search(r'(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_\-]{11})', url_or_id)
    if m:
        return m.group(1)
    raise ValueError(f"Không nhận ra video ID từ: {url_or_id}")


async def _fetch_innertube_key_and_token(video_id: str) -> tuple[str, str]:
    """Fetch page HTML, extract INNERTUBE_API_KEY and first comment continuation token."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    async with httpx.AsyncClient(headers=_INNERTUBE_HEADERS, follow_redirects=True, timeout=20) as client:
        r = await client.get(url)
        html = r.text

    # API key
    api_key_m = re.search(r'"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"', html) or \
                re.search(r'"innertubeApiKey"\s*:\s*"([^"]+)"', html)
    api_key = api_key_m.group(1) if api_key_m else "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

    # Parse ytInitialData JSON to find comment section continuation token
    token = ""
    yd_m = re.search(r'var ytInitialData\s*=\s*(\{.+?\});\s*(?:var |window\[|</script)', html, re.DOTALL)
    if yd_m:
        try:
            yd = _json.loads(yd_m.group(1))
            # Walk: contents → twoColumnWatchNextResults → results → results → contents
            results = (yd.get("contents") or {}) \
                .get("twoColumnWatchNextResults", {}) \
                .get("results", {}) \
                .get("results", {}) \
                .get("contents", [])
            for section in results:
                isr = section.get("itemSectionRenderer", {})
                if isr.get("sectionIdentifier") == "comment-item-section" or \
                   any("comment" in str(c).lower() for c in isr.get("contents", [])[:1]):
                    for cont in isr.get("continuations", []):
                        t = (cont.get("reloadContinuationData") or cont.get("nextContinuationData") or {}).get("continuation", "")
                        if t:
                            token = t
                            break
                if token:
                    break
            # Fallback: find any engagementPanel with comments
            if not token:
                panels = yd.get("engagementPanels", [])
                for panel in panels:
                    ep_r = panel.get("engagementPanelSectionListRenderer", {})
                    header = str(ep_r.get("header", ""))
                    if "comment" in header.lower():
                        for cont in ep_r.get("continuations", []):
                            t = (cont.get("reloadContinuationData") or cont.get("nextContinuationData") or {}).get("continuation", "")
                            if t:
                                token = t
                                break
        except Exception as e:
            logger.warning("ytInitialData parse error: %s", e)

    # Regex fallback: all long tokens, pick one near "comment"
    if not token:
        # find token right after commentSectionRenderer
        m = re.search(r'comment[^"]{0,200}"token"\s*:\s*"([A-Za-z0-9_\-]{30,})"', html, re.DOTALL)
        if m:
            token = m.group(1)
    if not token:
        tokens = re.findall(r'"token"\s*:\s*"([A-Za-z0-9_\-]{50,})"', html)
        token = tokens[-1] if tokens else ""

    logger.info("video=%s api_key=%s... token=%s...", video_id, api_key[:12], token[:20] if token else "NONE")

    if not token:
        raise ValueError("Không lấy được continuation token — video có thể tắt comment hoặc private.")

    return api_key, token


def _parse_comment_renderer(comment_r: dict) -> dict:
    runs = (comment_r.get("authorText") or {}).get("runs", [])
    author = runs[0].get("text", "") if runs else ""
    text_runs = (comment_r.get("contentText") or {}).get("runs", [])
    text = "".join(r.get("text", "") for r in text_runs)
    likes_obj = comment_r.get("voteCount") or {}
    likes = likes_obj.get("simpleText") or likes_obj.get("accessibility", {}).get("accessibilityData", {}).get("label", "0")
    pub_obj = comment_r.get("publishedTimeText") or {}
    runs2 = pub_obj.get("runs", [])
    published = runs2[0].get("text", "") if runs2 else pub_obj.get("simpleText", "")
    is_pinned = bool(comment_r.get("pinnedCommentBadge"))
    return {"author": author, "text": text, "likes": likes, "published": published, "pinned": is_pinned}


def _walk_items(items: list) -> tuple[list[dict], str]:
    """Extract comments and next continuation token from a list of continuationItems."""
    comments: list[dict] = []
    next_cont = ""
    for item in items:
        # commentThreadRenderer (top-level comments)
        thread = item.get("commentThreadRenderer", {})
        comment_r = (thread.get("comment") or {}).get("commentRenderer", {})
        if comment_r:
            comments.append(_parse_comment_renderer(comment_r))

        # commentRenderer directly (replies)
        direct_r = item.get("commentRenderer", {})
        if direct_r:
            comments.append(_parse_comment_renderer(direct_r))

        # continuationItemRenderer → next page token
        cont_item = item.get("continuationItemRenderer", {})
        if cont_item:
            # pattern 1: continuationEndpoint.continuationCommand.token
            ep = cont_item.get("continuationEndpoint", {})
            token = (ep.get("continuationCommand") or {}).get("token", "")
            if not token:
                # pattern 2: button.buttonRenderer.command.continuationCommand.token
                btn_cmd = (cont_item.get("button") or {}).get("buttonRenderer", {}).get("command", {})
                token = (btn_cmd.get("continuationCommand") or {}).get("token", "")
            if token:
                next_cont = token

    return comments, next_cont


async def _fetch_comments_page(api_key: str, continuation: str) -> tuple[list[dict], str]:
    """One page of comments via InnerTube /next. Returns (comments, next_continuation)."""
    url = f"https://www.youtube.com/youtubei/v1/next?key={api_key}"
    body: dict = {
        "context": {"client": _INNERTUBE_CLIENT},
        "continuation": continuation,
    }
    headers = {
        **_INNERTUBE_HEADERS,
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": _INNERTUBE_CLIENT["clientVersion"],
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, json=body, headers=headers)
    data = r.json()

    comments: list[dict] = []
    next_cont = ""

    # ── Path 1: onResponseReceivedEndpoints (classic + modern) ──────────────
    endpoints = data.get("onResponseReceivedEndpoints", [])
    for ep in endpoints:
        items = (ep.get("reloadContinuationItemsCommand") or {}).get("continuationItems") or \
                (ep.get("appendContinuationItemsAction") or {}).get("continuationItems", [])
        if items:
            c, n = _walk_items(items)
            comments.extend(c)
            if n:
                next_cont = n

    # ── Path 2: frameworkUpdates.entityBatchUpdate (YouTube 2024+ format) ──
    fw_mutations = (data.get("frameworkUpdates") or {}) \
        .get("entityBatchUpdate", {}).get("mutations", [])
    for m in fw_mutations:
        payload = m.get("payload", {})
        ce = payload.get("commentEntityPayload", {})
        if not ce:
            continue
        props = ce.get("properties", {})
        author_info = ce.get("author", {})
        text_content = (props.get("content") or {}).get("content", "")
        if not text_content:
            continue
        comments.append({
            "author": author_info.get("displayName", ""),
            "text": text_content,
            "likes": str(props.get("likeCount", "0")),
            "published": props.get("publishedTime", ""),
            "pinned": False,
        })

    # ── next_cont from continuationEndpoint inside mutations ────────────────
    if not next_cont:
        for m in fw_mutations:
            payload = m.get("payload", {})
            cursor = payload.get("commentsSectionEntityPayload", {})
            if cursor:
                next_cont = cursor.get("continuationToken", "")
                if next_cont:
                    break

    logger.info("InnerTube page: %d comments, next_cont=%s", len(comments), bool(next_cont))
    return comments, next_cont


class GetCommentsRequest(BaseModel):
    url: str
    max_comments: int = 100


@router.post("/get-comments")
async def get_comments(req: GetCommentsRequest):
    try:
        video_id = _extract_video_id(req.url)
    except ValueError as e:
        raise HTTPException(400, str(e))

    try:
        api_key, first_token = await _fetch_innertube_key_and_token(video_id)
    except Exception as e:
        logger.warning("get-comments fetch page error: %s", e)
        raise HTTPException(500, f"Không tải được trang video: {e}")

    all_comments: list[dict] = []
    continuation = first_token
    # Allow extra pages for "header/sort" pages that return 0 comments
    max_pages = max(1, req.max_comments // 20) + 10
    empty_streak = 0

    for _ in range(max_pages):
        if not continuation or len(all_comments) >= req.max_comments:
            break
        try:
            page_comments, continuation = await _fetch_comments_page(api_key, continuation)
            if page_comments:
                all_comments.extend(page_comments)
                empty_streak = 0
            else:
                empty_streak += 1
                # Stop if 3 consecutive empty pages with no next token
                if empty_streak >= 3 and not continuation:
                    break
        except Exception as e:
            logger.warning("get-comments page error: %s", e)
            break

    all_comments = all_comments[:req.max_comments]
    return {
        "ok": True,
        "video_id": video_id,
        "total": len(all_comments),
        "comments": all_comments,
    }
