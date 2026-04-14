"""
Chrome extension integration:
- /api/extension/poll-job      -> extension polls pending browser jobs
- /api/extension/submit-job    -> extension submits solved reCAPTCHA token
- /api/extension/submit-browser -> extension submits browser fetch result
- /api/extension/token         -> extension pushes captured Bearer token
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["extension"])
logger = logging.getLogger("veo.extension")
_PREFERRED_TOKEN_HOST = "aisandbox-pa.googleapis.com"
_last_token_capture: dict[str, Any] = {}

_pending_captcha: dict[str, asyncio.Future] = {}
_captcha_queue: list[dict[str, Any]] = []

_pending_browser_submit: dict[str, asyncio.Future] = {}
_browser_submit_queue: list[dict[str, Any]] = []


async def request_captcha_token(job_id: str, job_type: str = "video", account_index: int = 1) -> str | None:
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_captcha[job_id] = fut
    _captcha_queue.append(
        {
            "jobId": job_id,
            "jobKind": "captcha",
            "jobType": job_type,
            "accountIndex": normalized_account_index,
        }
    )
    logger.info(
        "📩 [Server] Nhận yêu cầu mới từ: job_%s (type: %s, account: #%s)",
        job_id[:8],
        job_type,
        normalized_account_index,
    )
    try:
        token = await asyncio.wait_for(asyncio.shield(fut), timeout=60.0)
        if token:
            logger.info("[recaptcha_token] :%s", token)
        else:
            logger.warning("⚠️ captcha job_%s trả về token rỗng", job_id[:8])
        return token
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ captcha cho job_%s", job_id[:8])
        return None
    finally:
        _pending_captcha.pop(job_id, None)
        for i, item in enumerate(_captcha_queue):
            if item["jobId"] == job_id:
                _captcha_queue.pop(i)
                break


async def request_browser_upload_post(
    job_id: str,
    *,
    job_type: str,
    url: str,
    payload: dict,
    uploads: list[dict],
    access_token: str,
    account_index: int = 1,
) -> dict:
    """Queue a browser job that uploads image(s) then POSTs the generation request.
    uploads: list of {base64, mimeType, payloadPath} dicts.
    payloadPath: dot-notation path where mediaId should be injected, e.g. 'requests[0].startImage.mediaId'
    """
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_browser_submit[job_id] = fut
    full_payload = dict(payload)
    full_payload["__uploads__"] = uploads
    _browser_submit_queue.append(
        {
            "jobId": job_id,
            "jobKind": "browser_upload_post",
            "jobType": job_type,
            "accountIndex": normalized_account_index,
            "url": url,
            "payload": full_payload,
            "accessToken": access_token,
        }
    )
    logger.info(
        "🌐 [Server] Xếp hàng browser-upload-post cho job_%s (%s, %s ảnh, account #%s)",
        job_id[:8], job_type, len(uploads), normalized_account_index,
    )
    try:
        result = await asyncio.wait_for(asyncio.shield(fut), timeout=120.0)
        return result or {"ok": False, "status": 0, "body": "No browser result"}
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ browser-upload-post cho job_%s", job_id[:8])
        return {"ok": False, "status": 0, "body": "Browser upload+post timeout"}
    finally:
        _pending_browser_submit.pop(job_id, None)
        for i, item in enumerate(_browser_submit_queue):
            if item["jobId"] == job_id:
                _browser_submit_queue.pop(i)
                break


async def request_browser_submit(
    job_id: str,
    *,
    job_type: str,
    url: str,
    payload: dict,
    access_token: str,
    account_index: int = 1,
) -> dict:
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_browser_submit[job_id] = fut
    _browser_submit_queue.append(
        {
            "jobId": job_id,
            "jobKind": "browser_submit",
            "jobType": job_type,
            "accountIndex": normalized_account_index,
            "url": url,
            "payload": payload,
            "accessToken": access_token,
        }
    )
    logger.info(
        "🌐 [Server] Xếp hàng browser-submit cho job_%s (%s, account #%s)",
        job_id[:8],
        job_type,
        normalized_account_index,
    )
    try:
        result = await asyncio.wait_for(asyncio.shield(fut), timeout=90.0)
        return result or {"ok": False, "status": 0, "body": "No browser result"}
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ browser-submit cho job_%s", job_id[:8])
        return {"ok": False, "status": 0, "body": "Browser submit timeout"}
    finally:
        _pending_browser_submit.pop(job_id, None)
        for i, item in enumerate(_browser_submit_queue):
            if item["jobId"] == job_id:
                _browser_submit_queue.pop(i)
                break


@router.get("/poll-job")
async def poll_job():
    if _browser_submit_queue:
        job = _browser_submit_queue[0]
        job_kind = str(job.get("jobKind") or "browser_submit")
        logger.info(
            "📤 [Extension] poll-job -> job_%s (%s, %s, account #%s)",
            str(job["jobId"])[:8],
            job_kind,
            job.get("jobType", "video"),
            job.get("accountIndex", 1),
        )
        return {
            "hasJob": True,
            "jobKind": job_kind,
            "jobId": job["jobId"],
            "jobType": job.get("jobType", "video"),
            "accountIndex": job.get("accountIndex", 1),
            "url": job.get("url", ""),
            "payload": job.get("payload", {}),
            "accessToken": job.get("accessToken", ""),
        }

    if _captcha_queue:
        job = _captcha_queue[0]
        logger.info(
            "📤 [Extension] poll-job -> job_%s (%s, account #%s)",
            str(job["jobId"])[:8],
            job.get("jobType", "video"),
            job.get("accountIndex", 1),
        )
        return {
            "hasJob": True,
            "jobKind": "captcha",
            "jobId": job["jobId"],
            "jobType": job.get("jobType", "video"),
            "accountIndex": job.get("accountIndex", 1),
        }
    return {"hasJob": False}


class SubmitJobRequest(BaseModel):
    jobId: str
    token: str | None = None
    accountIndex: int | None = None


@router.post("/submit-job")
async def submit_job(req: SubmitJobRequest):
    queued_job: dict[str, Any] | None = None
    for i, item in enumerate(_captcha_queue):
        if item["jobId"] == req.jobId:
            queued_job = item
            _captcha_queue.pop(i)
            break

    fut = _pending_captcha.get(req.jobId)
    if fut and not fut.done():
        expected_account = int((queued_job or {}).get("accountIndex") or 1)
        received_account = int(req.accountIndex or expected_account)
        if received_account != expected_account:
            logger.warning(
                "⚠️ [Extension] accountIndex lệch cho job_%s | expected=%s | got=%s",
                req.jobId[:8],
                expected_account,
                received_account,
            )
        logger.info(
            "✅ [Extension] submit-job thành công cho job_%s | account #%s",
            req.jobId[:8],
            received_account,
        )
        fut.set_result(req.token or "")
        return {"ok": True}

    logger.warning("⚠️ [Extension] submit-job bị trễ hoặc job không còn: job_%s", req.jobId[:8])
    return {"ok": False, "detail": "Job not found or already completed"}


class BrowserSubmitResponse(BaseModel):
    jobId: str
    ok: bool = False
    status: int = 0
    body: str = ""
    reason: str = ""
    accountIndex: int | None = None


@router.post("/submit-browser")
async def submit_browser(req: BrowserSubmitResponse):
    queued_job: dict[str, Any] | None = None
    for i, item in enumerate(_browser_submit_queue):
        if item["jobId"] == req.jobId:
            queued_job = item
            _browser_submit_queue.pop(i)
            break

    fut = _pending_browser_submit.get(req.jobId)
    if fut and not fut.done():
        expected_account = int((queued_job or {}).get("accountIndex") or 1)
        received_account = int(req.accountIndex or expected_account)
        logger.info(
            "✅ [Extension] submit-browser cho job_%s | account #%s | status=%s",
            req.jobId[:8],
            received_account,
            req.status,
        )
        fut.set_result(
            {
                "ok": bool(req.ok),
                "status": int(req.status or 0),
                "body": req.body or "",
                "reason": req.reason or "",
            }
        )
        return {"ok": True}

    logger.warning("⚠️ [Extension] submit-browser bị trễ hoặc job không còn: job_%s", req.jobId[:8])
    return {"ok": False, "detail": "Browser submit job not found or already completed"}


class TokenPayload(BaseModel):
    token: str
    url: str = ""
    method: str = ""
    accountIndex: int = 1
    expiry: int | None = None


@router.post("/token")
async def capture_token(payload: TokenPayload):
    from services.config_service import load_config, save_config

    cfg = load_config()
    _last_token_capture.clear()
    _last_token_capture.update(
        {
            "url": payload.url,
            "method": payload.method or "",
            "accountIndex": int(payload.accountIndex or 1),
            "expiry": payload.expiry,
            "tokenPreview": f"{payload.token[:18]}..." if payload.token else "",
        }
    )
    if payload.url and _PREFERRED_TOKEN_HOST not in str(payload.url):
        logger.info("ℹ️ [Extension] bỏ qua token không phải từ Labs API | url=%s", payload.url)
        _last_token_capture["decision"] = "ignored_non_labs"
        return {"ok": True, "message": "Ignored non-Labs token"}

    requested_index = max(1, int(payload.accountIndex or 1))
    updated_account_index = requested_index
    target_key = f"account{requested_index}"

    if target_key not in cfg:
        for i in range(1, 6):
            key = f"account{i}"
            if key in cfg:
                target_key = key
                updated_account_index = i
                break
        else:
            target_key = "account1"
            updated_account_index = 1

    token_option = str(cfg.get("TOKEN_OPTION", "Option 1") or "Option 1").strip()
    existing_token = str(cfg.get(target_key, {}).get("ACCESS_TOKEN", "") or "").strip()
    if token_option == "Option 1" and existing_token and existing_token != payload.token:
        logger.info(
            "ℹ️ [Extension] giữ nguyên token cấu hình cho Account #%s vì TOKEN_OPTION=%s",
            updated_account_index,
            token_option,
        )
        _last_token_capture["decision"] = "kept_configured_token"
        return {"ok": True, "message": "Kept configured token"}

    cfg.setdefault(target_key, {})["ACCESS_TOKEN"] = payload.token
    if payload.expiry:
        cfg[target_key]["TOKEN_EXPIRY"] = payload.expiry

    save_config(cfg)
    _last_token_capture["decision"] = "saved_to_config"
    logger.info(
        "🔐 [Extension] token đã lưu vào Account #%s | method=%s | url=%s",
        updated_account_index,
        payload.method or "?",
        payload.url or "?",
    )
    return {"ok": True, "message": "Token saved"}


@router.get("/status")
async def extension_status():
    return {
        "ok": True,
        "pending_captcha_jobs": len(_captcha_queue),
        "pending_browser_submit_jobs": len(_browser_submit_queue),
        "waiting_futures": len(_pending_captcha) + len(_pending_browser_submit),
        "last_token_capture": dict(_last_token_capture),
        "queue_preview": [
            {
                "jobId": str(item.get("jobId", ""))[:8],
                "jobKind": item.get("jobKind", "captcha"),
                "jobType": item.get("jobType", "video"),
                "accountIndex": item.get("accountIndex", 1),
            }
            for item in (_browser_submit_queue[:3] + _captcha_queue[:3])
        ],
    }
