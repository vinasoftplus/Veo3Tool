"""Veo generation routes - Text-to-Video, Image-to-Video, Start-End, Consistent."""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import job_store
from services.config_service import BASE_DIR, get_active_accounts, load_config

router = APIRouter(tags=["veo"])
logger = logging.getLogger("veo.router")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_account_or_raise(preferred_index: int | None = None):
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chua co account nao co token. Vao Cai dat de lay token.")

    if preferred_index:
        for account in accounts:
            if int(account.get("_index") or 0) == int(preferred_index):
                return account

    return accounts[0]


def _account_display(account: dict) -> str:
    one_based = int(account.get("_index") or 1)
    zero_based = max(0, one_based - 1)
    return f"Account #{one_based} (index {zero_based})"


def _token_preview(account: dict) -> str:
    token = str(account.get("ACCESS_TOKEN", "") or "")
    if len(token) < 20:
        return token
    return f"{token[:18]}..."


def _token_option() -> str:
    cfg = load_config()
    return str(cfg.get("TOKEN_OPTION", "Option 1") or "Option 1").strip()


async def _get_recaptcha_token(job_type: str = "video", account_index: int = 1) -> str:
    """Request reCAPTCHA token from Chrome extension. Returns empty string if unavailable."""
    try:
        from routers.extension import request_captcha_token
        import uuid as _uuid

        job_id = str(_uuid.uuid4())
        logger.info(
            "🧩 Đang yêu cầu reCAPTCHA token cho %s | job_%s | account #%s",
            job_type,
            job_id[:8],
            account_index,
        )
        token = await asyncio.wait_for(
            request_captcha_token(job_id, job_type, account_index=account_index),
            timeout=35.0,
        )
        if token:
            logger.info("✅ Đã nhận reCAPTCHA token cho job_%s", job_id[:8])
            return token
        logger.warning("⚠️ reCAPTCHA trả về rỗng cho job_%s — thử không có token", job_id[:8])
        return ""
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout chờ reCAPTCHA — thử không có token")
        return ""
    except Exception as exc:
        logger.warning("⚠️ Lỗi reCAPTCHA: %s — thử không có token", exc)
        return ""

async def _poll_video_job(job_id: str, token: str, project_id: str, operations: list):
    from adapters.google_labs import GoogleLabsAdapter

    adapter = GoogleLabsAdapter()
    max_polls = 120
    logger.info("⏳ Bắt đầu poll job %s | operations=%s", job_id[:8], len(operations))
    for attempt in range(1, max_polls + 1):
        await asyncio.sleep(5)
        try:
            result = await adapter.check_video_status(operations, token)
            if result.get("ok"):
                videos = adapter.parse_video_results(result.get("body", ""))
                if videos:
                    outputs = []
                    for idx, v in enumerate(videos):
                        op_name = ""
                        if len(operations) == 1:
                            op_name = ((operations[0] or {}).get("operation") or {}).get("name", "")
                        elif idx < len(operations):
                            op_name = ((operations[idx] or {}).get("operation") or {}).get("name", "")
                        outputs.append(
                            {
                                "video_url": v.get("videoUrl") or v.get("fifeUrl", ""),
                                "media_id": v.get("mediaId", ""),
                                "operation_name": v.get("operationName") or op_name,
                            }
                        )
                    await job_store.update_job(job_id, "completed", outputs=outputs, progress=100)
                    logger.info("🎉 Job %s hoàn thành | outputs=%s", job_id[:8], len(outputs))
                    return

                body = result.get("body", "")
                if "MEDIA_GENERATION_STATUS_FAILED" in body or "FAILED" in body:
                    logger.warning("❌ Job %s thất bại | %s", job_id[:8], body[:400].replace("\n", " "))
                    await job_store.update_job(job_id, "failed", error="Generation failed")
                    return

                if attempt == 1 or attempt % 6 == 0:
                    logger.info("⌛ Job %s đang chờ | poll=%s/%s", job_id[:8], attempt, max_polls)
            else:
                status = result.get("status")
                body = str(result.get("body", ""))
                if status in (401, 403):
                    logger.warning("❌ Job %s bị từ chối | HTTP %s | %s", job_id[:8], status, body[:400].replace("\n", " "))
                    await job_store.update_job(job_id, "failed", error="Token het han hoac khong hop le")
                    return
                logger.warning("⚠️ Job %s poll HTTP lỗi | status=%s | %s", job_id[:8], status, body[:300].replace("\n", " "))
        except Exception as exc:
            logger.warning("⚠️ Poll job %s gặp exception: %s", job_id[:8], exc)

    logger.warning("⏰ Job %s timeout sau %s láº§n poll", job_id[:8], max_polls)
    await job_store.update_job(job_id, "failed", error="Timeout - khong nhan duoc video")


# ---------------------------------------------------------------------------
# Text-to-Video
# ---------------------------------------------------------------------------

class T2VRequest(BaseModel):
    prompts: list[str]
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE"
    output_count: int = 1
    model: str = "auto"
    seed: int | None = None


@router.post("/text-to-video")
async def text_to_video(req: T2VRequest):
    from adapters.google_labs import GoogleLabsAdapter, URL_T2V
    from routers.extension import request_browser_submit

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    logger.info("Using %s for text-to-video generation", _account_display(account))
    logger.info(
        "?? text-to-video token/project | account #%s | token=%s | project=%s",
        account_index,
        _token_preview(account),
        account.get("PROJECT_ID", ""),
    )

    token_option = _token_option()
    # Option 2: extension injects fresh reCAPTCHA in-browser — no need to fetch token here
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    job_ids = []
    for prompt in req.prompts:
        if not prompt.strip():
            continue
        try:
            logger.info("[SUBMIT] text-to-video | prompt_len=%s | output_count=%s | TOKEN_OPTION=%s", len(prompt.strip()), req.output_count, token_option)
            if token_option == "Option 2":
                payload = adapter.build_text_to_video_payload(
                    prompt=prompt.strip(),
                    account=account,
                    aspect_ratio=req.aspect_ratio,
                    output_count=req.output_count,
                    model=req.model,
                    seed=req.seed,
                    recaptcha_token="",  # extension will inject fresh token in-browser
                )
                browser_job_id = str(uuid.uuid4())
                result = await request_browser_submit(
                    browser_job_id,
                    job_type="video",
                    url=URL_T2V,
                    payload=payload,
                    access_token=account.get("ACCESS_TOKEN", ""),
                    account_index=account_index,
                )
            else:
                result = await adapter.text_to_video(
                    prompt=prompt.strip(),
                    account=account,
                    aspect_ratio=req.aspect_ratio,
                    output_count=req.output_count,
                    model=req.model,
                    seed=req.seed,
                    recaptcha_token=recaptcha_token,
                )
            if not result.get("ok"):
                job_id = await job_store.create_job("text_to_video", {"prompt": prompt})
                logger.warning("[FAIL] text-to-video create job %s failed immediately | %s", job_id[:8], str(result.get("body", ""))[:400].replace("\n", " "))
                await job_store.update_job(job_id, "failed", error=result.get("body", "API error"))
                job_ids.append(job_id)
                continue

            operations = adapter.parse_operations(result.get("body", ""))
            job_id = await job_store.create_job(
                "text_to_video",
                {
                    "prompt": prompt,
                    "aspect_ratio": req.aspect_ratio,
                    "model": req.model,
                    "operations": operations,
                    "token": account.get("ACCESS_TOKEN", ""),
                    "project_id": account.get("PROJECT_ID", ""),
                    "account_index": account.get("_index"),
                    "recaptcha_used": bool(recaptcha_token),
                    "token_option": token_option,
                },
            )
            logger.info("[JOB] text_to_video %s created | operations=%s", job_id[:8], len(operations))
            asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), account.get("PROJECT_ID", ""), operations))
            job_ids.append(job_id)
        except Exception as exc:
            job_id = await job_store.create_job("text_to_video", {"prompt": prompt})
            logger.warning("[FAIL] text-to-video exception | job=%s | %s", job_id[:8], exc)
            await job_store.update_job(job_id, "failed", error=str(exc))
            job_ids.append(job_id)

    return {"ok": True, "job_ids": job_ids}


# ---------------------------------------------------------------------------
# Image-to-Video
# ---------------------------------------------------------------------------

@router.post("/image-to-video")
async def image_to_video(
    image: UploadFile = File(...),
    prompt: str = Form(""),
    aspect_ratio: str = Form("VIDEO_ASPECT_RATIO_LANDSCAPE"),
    output_count: int = Form(1),
    model: str = Form("auto"),
):
    from adapters.google_labs import GoogleLabsAdapter, URL_I2V
    from routers.extension import request_browser_submit

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    logger.info("Using %s for image-to-video generation", _account_display(account))
    logger.info(
        "?? image-to-video token/project | account #%s | token=%s | project=%s",
        account_index,
        _token_preview(account),
        account.get("PROJECT_ID", ""),
    )
    token_option = _token_option()
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    image_bytes = await image.read()
    mime_type = image.content_type or "image/jpeg"
    b64 = base64.b64encode(image_bytes).decode()
    media_id = ""

    if token_option == "Option 2":
        from routers.extension import request_browser_upload_post
        # Build payload with placeholder mediaId — browser will fill it in after upload
        payload = adapter.build_image_to_video_payload(
            media_id="__PLACEHOLDER__",
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            recaptcha_token="",
        )
        browser_job_id = str(uuid.uuid4())
        result = await request_browser_upload_post(
            browser_job_id,
            job_type="video",
            url=URL_I2V,
            payload=payload,
            uploads=[{"base64": b64, "mimeType": mime_type, "payloadPath": "requests[0].startImage.mediaId"}],
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        upload_result = await adapter.upload_image(b64, mime_type, account)
        if not upload_result.get("ok"):
            raise HTTPException(400, f"Upload anh that bai: {upload_result.get('body', '')}")
        media_id = adapter.parse_upload_media_id(upload_result.get("body", ""))
        if not media_id:
            raise HTTPException(400, "Khong lay duoc mediaId tu upload")
        result = await adapter.image_to_video(
            media_id=media_id,
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            recaptcha_token=recaptcha_token,
        )
    if not result.get("ok"):
        logger.warning("[FAIL] image-to-video API error | %s", str(result.get("body", ""))[:400].replace("\n", " "))
        raise HTTPException(400, f"API error: {result.get('body', '')}")

    operations = adapter.parse_operations(result.get("body", ""))
    job_id = await job_store.create_job(
        "image_to_video",
        {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "model": model,
            "operations": operations,
            "token": account.get("ACCESS_TOKEN", ""),
            "project_id": account.get("PROJECT_ID", ""),
            "media_id": media_id,
            "account_index": account.get("_index"),
            "recaptcha_used": bool(recaptcha_token),
            "token_option": token_option,
        },
    )
    logger.info("[JOB] image_to_video %s created | operations=%s", job_id[:8], len(operations))
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), account.get("PROJECT_ID", ""), operations))
    return {"ok": True, "job_id": job_id}


# ---------------------------------------------------------------------------
# Start-End Video
# ---------------------------------------------------------------------------

@router.post("/startend-video")
async def startend_video(
    start_image: UploadFile = File(...),
    end_image: UploadFile = File(None),
    prompt: str = Form(""),
    aspect_ratio: str = Form("VIDEO_ASPECT_RATIO_LANDSCAPE"),
    output_count: int = Form(1),
    model: str = Form("auto"),
):
    from adapters.google_labs import GoogleLabsAdapter

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    logger.info("Using %s for startend-video generation", _account_display(account))
    logger.info(
        "🔑 startend-video token/project | account #%s | token=%s | project=%s",
        account_index,
        _token_preview(account),
        account.get("PROJECT_ID", ""),
    )
    token_option = _token_option()
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    start_bytes = await start_image.read()
    start_b64 = base64.b64encode(start_bytes).decode()
    start_mime = start_image.content_type or "image/jpeg"
    end_b64 = None
    end_mime = "image/jpeg"
    if end_image:
        end_bytes = await end_image.read()
        end_b64 = base64.b64encode(end_bytes).decode()
        end_mime = end_image.content_type or "image/jpeg"

    if token_option == "Option 2":
        from adapters.google_labs import URL_STARTEND, URL_I2V
        from routers.extension import request_browser_upload_post
        payload = adapter.build_startend_video_payload(
            start_media_id="__PLACEHOLDER_START__",
            end_media_id="__PLACEHOLDER_END__" if end_b64 else None,
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            recaptcha_token="",
        )
        uploads = [{"base64": start_b64, "mimeType": start_mime, "payloadPath": "requests[0].startImage.mediaId"}]
        if end_b64:
            uploads.append({"base64": end_b64, "mimeType": end_mime, "payloadPath": "requests[0].endImage.mediaId"})
        browser_job_id = str(uuid.uuid4())
        result = await request_browser_upload_post(
            browser_job_id,
            job_type="video",
            url=URL_STARTEND if end_b64 else URL_I2V,
            payload=payload,
            uploads=uploads,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        start_upload = await adapter.upload_image(start_b64, start_mime, account)
        if not start_upload.get("ok"):
            raise HTTPException(400, "Upload start image that bai")
        start_media_id = adapter.parse_upload_media_id(start_upload.get("body", ""))
        end_media_id = None
        if end_b64:
            end_upload = await adapter.upload_image(end_b64, end_mime, account)
            if end_upload.get("ok"):
                end_media_id = adapter.parse_upload_media_id(end_upload.get("body", ""))
        result = await adapter.startend_video(
            start_media_id=start_media_id,
            end_media_id=end_media_id,
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            recaptcha_token=recaptcha_token,
        )
    if not result.get("ok"):
        logger.warning("❌ startend-video API lỗi | %s", str(result.get("body", ""))[:400].replace("\n", " "))
        raise HTTPException(400, f"API error: {result.get('body', '')}")

    operations = adapter.parse_operations(result.get("body", ""))
    job_id = await job_store.create_job(
        "startend_video",
        {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "model": model,
            "operations": operations,
            "token": account.get("ACCESS_TOKEN", ""),
            "project_id": account.get("PROJECT_ID", ""),
            "account_index": account.get("_index"),
            "recaptcha_used": bool(recaptcha_token),
        },
    )
    logger.info("📹 Tạo job startend_video %s | operations=%s", job_id[:8], len(operations))
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), account.get("PROJECT_ID", ""), operations))
    return {"ok": True, "job_id": job_id}


# ---------------------------------------------------------------------------
# Reference/Consistent Video
# ---------------------------------------------------------------------------

class ConsistentVideoRequest(BaseModel):
    prompt: str
    character_ids: list[str]
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    output_count: int = 1
    model: str = "auto"
    seed: int | None = None


@router.post("/consistent-video")
async def consistent_video(req: ConsistentVideoRequest):
    from adapters.google_labs import GoogleLabsAdapter
    from services.character_service import get_media_ids_for_account

    account = _get_account_or_raise()
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    logger.info("Using %s for consistent-video generation", _account_display(account))
    logger.info(
        "🔑 consistent-video token/project | account #%s | token=%s | project=%s",
        account_index,
        _token_preview(account),
        account.get("PROJECT_ID", ""),
    )
    token_option = _token_option()
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    media_ids = await get_media_ids_for_account(req.character_ids, account)
    if not media_ids:
        raise HTTPException(400, "Cac character chua duoc sync len Labs. Vao trang Character de sync.")

    if token_option == "Option 2":
        from adapters.google_labs import URL_REF_VIDEO
        from routers.extension import request_browser_submit
        payload = adapter.build_reference_video_payload(
            reference_media_ids=media_ids[:3],
            prompt=req.prompt,
            account=account,
            aspect_ratio=req.aspect_ratio,
            output_count=req.output_count,
            model=req.model,
            seed=req.seed,
            recaptcha_token="",
        )
        browser_job_id = str(uuid.uuid4())
        result = await request_browser_submit(
            browser_job_id,
            job_type="video",
            url=URL_REF_VIDEO,
            payload=payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        result = await adapter.reference_video(
            reference_media_ids=media_ids[:3],
            prompt=req.prompt,
            account=account,
            aspect_ratio=req.aspect_ratio,
            output_count=req.output_count,
            model=req.model,
            seed=req.seed,
            recaptcha_token=recaptcha_token,
        )
    if not result.get("ok"):
        logger.warning("❌ consistent-video API lỗi | %s", str(result.get("body", ""))[:400].replace("\n", " "))
        raise HTTPException(400, f"API error: {result.get('body', '')}")

    operations = adapter.parse_operations(result.get("body", ""))
    job_id = await job_store.create_job(
        "consistent_video",
        {
            "prompt": req.prompt,
            "character_ids": req.character_ids,
            "model": req.model,
            "operations": operations,
            "token": account.get("ACCESS_TOKEN", ""),
            "project_id": account.get("PROJECT_ID", ""),
            "account_index": account.get("_index"),
            "recaptcha_used": bool(recaptcha_token),
        },
    )
    logger.info("📹 Tạo job consistent_video %s | operations=%s", job_id[:8], len(operations))
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), account.get("PROJECT_ID", ""), operations))
    return {"ok": True, "job_id": job_id}


# ---------------------------------------------------------------------------
# Job status + save + upscale
# ---------------------------------------------------------------------------

@router.get("/job/{job_id}")
async def get_job(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job khong tim thay")
    return {"ok": True, "job": job}


@router.get("/jobs")
async def list_jobs(type: str | None = None, status: str | None = None, limit: int = 50):
    jobs = await job_store.list_jobs(job_type=type, status=status, limit=limit)
    return {"ok": True, "jobs": jobs}


@router.post("/job/{job_id}/save")
async def save_job_output(job_id: str, body: dict):
    import httpx

    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job khong tim thay")

    video_url = body.get("video_url", "")
    if not video_url:
        raise HTTPException(400, "Missing video_url")

    save_dir = BASE_DIR / "data" / "jobs"
    save_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{job_id}_{uuid.uuid4().hex[:8]}.mp4"
    out_path = save_dir / filename

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(video_url)
            resp.raise_for_status()
            out_path.write_bytes(resp.content)
    except Exception as exc:
        raise HTTPException(500, f"Loi download: {exc}")

    return {"ok": True, "local_path": f"/jobs/{filename}"}


@router.post("/job/{job_id}/upscale")
async def upscale_job(job_id: str, body: dict):
    from adapters.google_labs import GoogleLabsAdapter

    account = _get_account_or_raise()
    adapter = GoogleLabsAdapter()
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job khong tim thay")

    operation_name = body.get("operation_name", "")
    output_index = int(body.get("output_index", 0) or 0)
    if not operation_name:
        outputs = job.get("outputs") or []
        if 0 <= output_index < len(outputs):
            operation_name = outputs[output_index].get("operation_name", "")
    if not operation_name:
        ops = (job.get("params") or {}).get("operations") or []
        if 0 <= output_index < len(ops):
            operation_name = ((ops[output_index] or {}).get("operation") or {}).get("name", "")
        elif ops:
            operation_name = ((ops[0] or {}).get("operation") or {}).get("name", "")
    if not operation_name:
        raise HTTPException(400, "Missing operation_name")

    result = await adapter.upscale_video(operation_name, account.get("ACCESS_TOKEN", ""))
    if not result.get("ok"):
        return {"ok": False, "body": result.get("body", "")}

    upscale_operations = adapter.parse_operations(result.get("body", ""))
    if not upscale_operations:
        return {"ok": True, "started": True, "message": "Upscale request accepted"}

    for _ in range(60):
        await asyncio.sleep(3)
        status_result = await adapter.check_video_status(upscale_operations, account.get("ACCESS_TOKEN", ""))
        if not status_result.get("ok"):
            continue
        videos = adapter.parse_video_results(status_result.get("body", ""))
        if videos:
            outputs = []
            for v in videos:
                outputs.append(
                    {
                        "video_url": v.get("videoUrl") or v.get("fifeUrl", ""),
                        "media_id": v.get("mediaId", ""),
                        "operation_name": v.get("operationName") or (((upscale_operations[0] or {}).get("operation") or {}).get("name", "")),
                    }
                )
            return {"ok": True, "completed": True, "outputs": outputs}

    return {"ok": True, "started": True, "message": "Upscale da duoc gui, nhung chua co ket qua kip thoi gian cho"}
