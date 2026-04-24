"""Veo generation routes - Text-to-Video, Image-to-Video, Start-End, Consistent."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services import job_store
from services.config_service import BASE_DIR, get_active_accounts, load_config

router = APIRouter(tags=["veo"])
logger = logging.getLogger("veo.router")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_rr_counter: int = 0  # server-side round-robin counter


def _get_account_or_raise(preferred_index: int | None = None):
    global _rr_counter
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chua co account nao co token. Vao Cai dat de lay token.")

    if preferred_index is not None and preferred_index > 0:
        for account in accounts:
            if int(account.get("_index") or 0) == int(preferred_index):
                return account
        # preferred not found — fall through to round-robin

    # No preference → round-robin across all active accounts
    idx = _rr_counter % len(accounts)
    _rr_counter += 1
    return accounts[idx]


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

async def _poll_video_job(job_id: str, token: str, operations: list, account_index: int = 0):
    from adapters.google_labs import GoogleLabsAdapter
    from services.config_service import load_config

    adapter = GoogleLabsAdapter()
    max_polls = 120
    logger.info("⏳ Bắt đầu poll job %s | operations=%s", job_id[:8], len(operations))
    for attempt in range(1, max_polls + 1):
        await asyncio.sleep(5)
        try:
            live_token = token
            if account_index:
                cfg = load_config()
                acc = cfg.get(f"account{account_index}", {})
                live_token = acc.get("ACCESS_TOKEN", "") or token
            result = await adapter.check_video_status(operations, live_token)
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
                        outputs.append({
                            "video_url": v.get("videoUrl") or v.get("fifeUrl", ""),
                            "media_id": v.get("mediaId", ""),
                            "operation_name": v.get("operationName") or op_name,
                        })
                    await job_store.update_job(job_id, "completed", outputs=outputs, progress=100)
                    logger.info("🎉 Job %s hoàn thành | outputs=%s", job_id[:8], len(outputs))
                    return

                body = result.get("body", "")
                if "MEDIA_GENERATION_STATUS_FAILED" in body or "FAILED" in body:
                    logger.warning("❌ Job %s generation FAILED", job_id[:8])
                    await job_store.update_job(job_id, "failed", error="Generation failed")
                    return

                if attempt == 1 or attempt % 6 == 0:
                    logger.info("⌛ Job %s đang chờ | poll=%s/%s", job_id[:8], attempt, max_polls)
            else:
                status = result.get("status")
                body = str(result.get("body", ""))
                if status in (401, 403) and account_index:
                    logger.warning("⚠️ Job %s HTTP %s — thử refresh token...", job_id[:8], status)
                    from services.token_refresh_service import refresh_account_token
                    refreshed = await refresh_account_token(account_index)
                    if refreshed:
                        logger.info("✅ Refresh token OK account #%s — tiếp tục poll", account_index)
                        continue
                    logger.warning("❌ Job %s refresh token thất bại", job_id[:8])
                    await job_store.update_job(job_id, "failed", error="Token het han, refresh that bai")
                    return
                logger.warning("⚠️ Job %s poll lỗi | status=%s | %s", job_id[:8], status, body[:300].replace("\n", " "))
        except Exception as exc:
            logger.warning("⚠️ Poll job %s exception: %s", job_id[:8], exc)

    logger.warning("⏰ Job %s timeout sau %s lần poll", job_id[:8], max_polls)
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
    account_index: int | None = None


@router.post("/text-to-video")
async def text_to_video(req: T2VRequest):
    from adapters.google_labs import GoogleLabsAdapter, URL_T2V
    from routers.extension import request_browser_submit

    account = _get_account_or_raise(preferred_index=req.account_index)
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
            asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), operations, int(account.get("_index") or 0)))
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
    account_index: int = Form(0),
):
    from adapters.google_labs import GoogleLabsAdapter, URL_I2V
    from routers.extension import request_browser_submit

    account = _get_account_or_raise(preferred_index=account_index or None)
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
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), operations, int(account.get("_index") or 0)))
    return {"ok": True, "job_id": job_id, "account_index": int(account.get("_index") or 0)}


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
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), operations, int(account.get("_index") or 0)))
    return {"ok": True, "job_id": job_id}


# ---------------------------------------------------------------------------
# Reference/Consistent Video
# ---------------------------------------------------------------------------

@router.post("/consistent-video")
async def consistent_video(
    prompt: str = Form(""),
    aspect_ratio: str = Form("VIDEO_ASPECT_RATIO_PORTRAIT"),
    output_count: int = Form(1),
    model: str = Form("auto"),
    seed: int | None = Form(None),
    character_images: list[UploadFile] = File([]),
    account_index: int = Form(0),
):
    """Tạo consistent video — upload ảnh nhân vật trực tiếp, không cần sync."""
    from adapters.google_labs import GoogleLabsAdapter, URL_REF_VIDEO
    from routers.extension import request_browser_submit, request_browser_upload_post

    account = _get_account_or_raise(preferred_index=account_index)
    account_index = int(account.get("_index") or 1)
    adapter = GoogleLabsAdapter()
    logger.info("Using %s for consistent-video generation", _account_display(account))
    token_option = _token_option()
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    # Upload ảnh nhân vật → lấy media_id từng ảnh
    uploaded: list[tuple[str, str]] = []  # (b64, mime)
    for img in character_images[:3]:
        raw = await img.read()
        if not raw:
            continue
        uploaded.append((base64.b64encode(raw).decode(), img.content_type or "image/jpeg"))

    if not uploaded:
        raise HTTPException(400, "Cần ít nhất 1 ảnh nhân vật")

    if token_option == "Option 2":
        # Extension upload+post: ảnh được upload qua extension, media_id điền tự động
        payload = adapter.build_reference_video_payload(
            reference_media_ids=["__PLACEHOLDER_REF__"] * len(uploaded),
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            seed=seed,
            recaptcha_token="",
        )
        uploads = [
            {"base64": b64, "mimeType": mime, "payloadPath": f"requests[0].referenceImages[{i}].mediaId"}
            for i, (b64, mime) in enumerate(uploaded)
        ]
        result = await request_browser_upload_post(
            str(uuid.uuid4()),
            job_type="video",
            url=URL_REF_VIDEO,
            payload=payload,
            uploads=uploads,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
    else:
        # Option 1: upload ảnh trực tiếp qua API, lấy media_id
        media_ids = []
        for b64, mime in uploaded:
            upload_result = await adapter.upload_image(b64, mime, account)
            if not upload_result.get("ok"):
                raise HTTPException(400, f"Upload ảnh nhân vật thất bại: {upload_result.get('body', '')}")
            mid = adapter.parse_upload_media_id(upload_result.get("body", ""))
            if mid:
                media_ids.append(mid)
        if not media_ids:
            raise HTTPException(400, "Không upload được ảnh nhân vật")
        result = await adapter.reference_video(
            reference_media_ids=media_ids[:3],
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            seed=seed,
            recaptcha_token=recaptcha_token,
        )

    if not result.get("ok"):
        logger.warning("❌ consistent-video API lỗi | %s", str(result.get("body", ""))[:400].replace("\n", " "))
        raise HTTPException(400, f"API error: {result.get('body', '')}")

    operations = adapter.parse_operations(result.get("body", ""))
    job_id = await job_store.create_job(
        "consistent_video",
        {
            "prompt": prompt,
            "model": model,
            "operations": operations,
            "token": account.get("ACCESS_TOKEN", ""),
            "project_id": account.get("PROJECT_ID", ""),
            "account_index": account.get("_index"),
            "recaptcha_used": bool(recaptcha_token),
        },
    )
    logger.info("📹 Tạo job consistent_video %s | operations=%s", job_id[:8], len(operations))
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), operations, int(account.get("_index") or 0)))
    return {"ok": True, "job_id": job_id}


@router.post("/studio-video")
async def studio_video(
    prompt: str = Form(""),
    aspect_ratio: str = Form("VIDEO_ASPECT_RATIO_LANDSCAPE"),
    output_count: int = Form(1),
    model: str = Form("auto"),
    seed: int | None = Form(None),
    character_ids_json: str = Form("[]"),
    ref_media_ids_json: str = Form("[]"),
    reference_images: list[UploadFile] = File([]),
    account_index: int = Form(0),
):
    from adapters.google_labs import GoogleLabsAdapter, URL_REF_VIDEO, URL_I2V, URL_T2V
    from routers.extension import request_browser_submit, request_browser_upload_post
    from services.character_service import get_media_ids_for_account

    requested_account_index = int(account_index or 0)
    account = _get_account_or_raise(preferred_index=requested_account_index or None)
    account_index = int(account.get("_index") or 0)
    adapter = GoogleLabsAdapter()
    token_option = _token_option()
    recaptcha_token = "" if token_option == "Option 2" else await _get_recaptcha_token("video", account_index=account_index)

    try:
        character_ids = json.loads(character_ids_json or "[]")
        if not isinstance(character_ids, list):
            character_ids = []
    except Exception:
        character_ids = []

    try:
        ref_media_ids = json.loads(ref_media_ids_json or "[]")
        if not isinstance(ref_media_ids, list):
            ref_media_ids = []
        ref_media_ids = [str(x) for x in ref_media_ids if x]
    except Exception:
        ref_media_ids = []

    logger.info("[StudioVideo] ref_media_ids=%s character_ids=%s", ref_media_ids, character_ids)
    media_ids = await get_media_ids_for_account([str(x) for x in character_ids], account)
    # Thêm media_id từ refs có sẵn (ảnh gen đã upload lên Google, không cần upload lại)
    for mid in ref_media_ids:
        if mid not in media_ids:
            media_ids.append(mid)
    logger.info("[StudioVideo] final media_ids=%s uploaded_refs_count=pending", media_ids)

    uploaded_refs: list[tuple[str, str, str]] = []
    for ref in reference_images[:6]:
        raw = await ref.read()
        if not raw:
            continue
        uploaded_refs.append(
            (
                base64.b64encode(raw).decode(),
                ref.content_type or "image/jpeg",
                ref.filename or f"ref_{uuid.uuid4().hex[:8]}.jpg",
            )
        )

    async def _submit_for_account(account_obj: dict, account_idx: int) -> dict:
        if token_option == "Option 2" and (media_ids or uploaded_refs):
            clean_media_ids = [m for m in media_ids if m and "__PLACEHOLDER" not in m]
            existing_count = min(len(clean_media_ids), 3)
            remaining_slots = max(0, 3 - existing_count)
            uploads = []
            for i, (b64, mime, _name) in enumerate(uploaded_refs[:remaining_slots]):
                uploads.append(
                    {
                        "base64": b64,
                        "mimeType": mime,
                        "payloadPath": f"requests[0].referenceImages[{existing_count + i}].mediaId",
                    }
                )
            payload = adapter.build_reference_video_payload(
                reference_media_ids=(clean_media_ids + ["__PLACEHOLDER_REF__"] * len(uploads))[:3],
                prompt=prompt,
                account=account_obj,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                seed=seed,
                recaptcha_token="",
            )
            if uploads:
                return await request_browser_upload_post(
                    str(uuid.uuid4()),
                    job_type="video",
                    url=URL_REF_VIDEO,
                    payload=payload,
                    uploads=uploads,
                    access_token=account_obj.get("ACCESS_TOKEN", ""),
                    account_index=account_idx,
                )
            # Chỉ có media_ids sẵn, không cần upload → dùng browser_submit
            return await request_browser_submit(
                str(uuid.uuid4()),
                job_type="video",
                url=URL_REF_VIDEO,
                payload=payload,
                access_token=account_obj.get("ACCESS_TOKEN", ""),
                account_index=account_idx,
            )
        if token_option == "Option 2" and uploaded_refs:
            first_b64, first_mime, _ = uploaded_refs[0]
            payload = adapter.build_image_to_video_payload(
                media_id="__PLACEHOLDER__",
                prompt=prompt,
                account=account_obj,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                recaptcha_token="",
            )
            return await request_browser_upload_post(
                str(uuid.uuid4()),
                job_type="video",
                url=URL_I2V,
                payload=payload,
                uploads=[{"base64": first_b64, "mimeType": first_mime, "payloadPath": "requests[0].startImage.mediaId"}],
                access_token=account_obj.get("ACCESS_TOKEN", ""),
                account_index=account_idx,
            )
        if token_option == "Option 2":
            payload = adapter.build_text_to_video_payload(
                prompt=prompt,
                account=account_obj,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                seed=seed,
                recaptcha_token="",
            )
            return await request_browser_submit(
                str(uuid.uuid4()),
                job_type="video",
                url=URL_T2V,
                payload=payload,
                access_token=account_obj.get("ACCESS_TOKEN", ""),
                account_index=account_idx,
            )

        media_ids_local = list(media_ids)
        for b64, mime, _name in uploaded_refs:
            upload_result = await adapter.upload_image(b64, mime, account_obj)
            if upload_result.get("ok"):
                mid = adapter.parse_upload_media_id(upload_result.get("body", ""))
                if mid:
                    media_ids_local.append(mid)
        media_ids_local = [mid for mid in media_ids_local if mid][:3]
        if media_ids_local:
            return await adapter.reference_video(
                reference_media_ids=media_ids_local,
                prompt=prompt,
                account=account_obj,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                seed=seed,
                recaptcha_token=recaptcha_token,
            )
        if uploaded_refs:
            first_b64, first_mime, _ = uploaded_refs[0]
            upload_result = await adapter.upload_image(first_b64, first_mime, account_obj)
            if not upload_result.get("ok"):
                raise HTTPException(400, f"Upload ảnh tham chiếu thất bại: {upload_result.get('body', '')}")
            media_id = adapter.parse_upload_media_id(upload_result.get("body", ""))
            return await adapter.image_to_video(
                media_id=media_id or "",
                prompt=prompt,
                account=account_obj,
                aspect_ratio=aspect_ratio,
                output_count=output_count,
                model=model,
                recaptcha_token=recaptcha_token,
            )
        return await adapter.text_to_video(
            prompt=prompt,
            account=account_obj,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            seed=seed,
            recaptcha_token=recaptcha_token,
        )

    result = await _submit_for_account(account, account_index)

    # Khi FE không pin account (account_index=0), ref_media_id có thể thuộc account khác.
    # Fallback: nếu 404 với ref_media_ids, thử lại tuần tự trên account khác.
    if (
        not result.get("ok")
        and token_option == "Option 2"
        and requested_account_index <= 0
        and ref_media_ids
        and int(result.get("status") or 0) == 404
    ):
        current_idx = int(account.get("_index") or 0)
        for alt in get_active_accounts():
            alt_idx = int(alt.get("_index") or 0)
            if not alt_idx or alt_idx == current_idx:
                continue
            logger.warning(
                "[StudioVideo] HTTP 404 với account #%s, thử fallback account #%s do ref_media_ids có thể khác owner",
                current_idx,
                alt_idx,
            )
            alt_result = await _submit_for_account(alt, alt_idx)
            if alt_result.get("ok"):
                account = alt
                account_index = alt_idx
                result = alt_result
                logger.info("[StudioVideo] fallback thành công với account #%s", alt_idx)
                break

    if not result.get("ok"):
        raise HTTPException(400, f"API error: {result.get('body', '')}")

    operations = adapter.parse_operations(result.get("body", ""))
    job_id = await job_store.create_job(
        "studio_video",
        {
            "prompt": prompt,
            "character_ids": character_ids,
            "aspect_ratio": aspect_ratio,
            "model": model,
            "operations": operations,
            "token": account.get("ACCESS_TOKEN", ""),
            "project_id": account.get("PROJECT_ID", ""),
            "account_index": account.get("_index"),
            "recaptcha_used": bool(recaptcha_token),
            "token_option": token_option,
        },
    )
    asyncio.create_task(_poll_video_job(job_id, account.get("ACCESS_TOKEN", ""), operations, int(account.get("_index") or 0)))
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
    from adapters.google_labs import GoogleLabsAdapter, URL_UPSCALE_VIDEO
    from routers.extension import request_browser_submit

    adapter = GoogleLabsAdapter()
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job khong tim thay")

    # Dùng đúng account đã tạo video — ưu tiên body > job params
    job_params = job.get("params") or {}
    body_account_index = body.get("account_index")
    job_account_index = job_params.get("account_index")
    preferred = body_account_index if body_account_index is not None else job_account_index
    account = _get_account_or_raise(preferred_index=int(preferred) if preferred is not None else None)
    account_index = int(account.get("_index") or 1)

    # Fix 2: lấy aspect_ratio từ job params
    job_aspect = job_params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"

    output_index = int(body.get("output_index", 0) or 0)
    operation_name = body.get("operation_name", "")
    if not operation_name:
        outputs = job.get("outputs") or []
        if 0 <= output_index < len(outputs):
            operation_name = outputs[output_index].get("operation_name", "")
    if not operation_name:
        ops = job_params.get("operations") or []
        if 0 <= output_index < len(ops):
            operation_name = ((ops[output_index] or {}).get("operation") or {}).get("name", "")
        elif ops:
            operation_name = ((ops[0] or {}).get("operation") or {}).get("name", "")

    media_id = ""
    outputs = job.get("outputs") or []
    if 0 <= output_index < len(outputs):
        media_id = outputs[output_index].get("media_id", "")

    if not operation_name and not media_id:
        raise HTTPException(400, "Missing operation_name")

    resolved_media_id = adapter._resolve_upscale_media_id(operation_name, media_id)
    if not resolved_media_id:
        raise HTTPException(400, "Missing mediaId for upscale")

    logger.info("[Upscale] mediaId=%r account=#%s aspect=%s", resolved_media_id, account_index, job_aspect)

    # Fix 3: retry tự động tối đa 3 lần khi 403/500
    result = None
    for attempt in range(3):
        upscale_payload = adapter.build_upscale_payload(resolved_media_id, account=account, recaptcha_token="")
        # Patch aspect_ratio đúng theo video gốc
        if upscale_payload.get("requests"):
            upscale_payload["requests"][0]["aspectRatio"] = job_aspect

        browser_job_id = str(uuid.uuid4())
        result = await request_browser_submit(
            browser_job_id,
            job_type="video",
            url=URL_UPSCALE_VIDEO,
            payload=upscale_payload,
            access_token=account.get("ACCESS_TOKEN", ""),
            account_index=account_index,
        )
        status = result.get("status", 0)
        if result.get("ok"):
            break
        if status in (403, 401):
            logger.warning("[Upscale] attempt %s/%s → HTTP %s, retry...", attempt + 1, 3, status)
            await asyncio.sleep(2)
            continue
        # 500 hoặc lỗi khác — retry luôn
        logger.warning("[Upscale] attempt %s/%s → status=%s body=%s, retry...", attempt + 1, 3, status, str(result.get("body", ""))[:200])
        await asyncio.sleep(2)

    if not result or not result.get("ok"):
        return {"ok": False, "body": result.get("body", "") if result else "No result"}

    upscale_operations = adapter.parse_operations(result.get("body", ""))
    if not upscale_operations:
        return {"ok": True, "started": True, "message": "Upscale request accepted"}

    for _ in range(80):
        await asyncio.sleep(3)
        status_result = await adapter.check_video_status(upscale_operations, account.get("ACCESS_TOKEN", ""))
        if not status_result.get("ok"):
            continue
        videos = adapter.parse_video_results(status_result.get("body", ""))
        if videos:
            upscaled = []
            for v in videos:
                upscaled.append({
                    "video_url": v.get("videoUrl") or v.get("fifeUrl", ""),
                    "media_id": v.get("mediaId", ""),
                    "operation_name": v.get("operationName") or (((upscale_operations[0] or {}).get("operation") or {}).get("name", "")),
                })
            return {"ok": True, "completed": True, "outputs": upscaled}

    return {"ok": True, "started": True, "message": "Upscale da duoc gui, nhung chua co ket qua kip thoi gian cho"}


# ---------------------------------------------------------------------------
# Proxy download — tránh CORS khi tải video từ Google
# ---------------------------------------------------------------------------
@router.get("/proxy-download")
async def proxy_download(url: str, filename: str = "video.mp4"):
    import httpx
    from starlette.background import BackgroundTask
    from fastapi.responses import StreamingResponse
    import urllib.parse

    if not url:
        raise HTTPException(400, "Missing url")
    client = httpx.AsyncClient(timeout=120, follow_redirects=True)
    req = client.build_request("GET", url)
    resp = await client.send(req, stream=True)
    resp.raise_for_status()

    async def _cleanup():
        await resp.aclose()
        await client.aclose()

    safe_name = urllib.parse.quote(filename)
    content_type = resp.headers.get("content-type", "").split(";", 1)[0].strip() or "application/octet-stream"
    return StreamingResponse(
        resp.aiter_bytes(65536),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename*=UTF-8\'\'{safe_name}'},
        background=BackgroundTask(_cleanup),
    )
