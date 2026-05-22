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
import random
import time
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
_browser_job_accounts: dict[str, int] = {}
_browser_job_slots: dict[str, tuple[int, str]] = {}

# Jobs đã được poll, đang xử lý bởi extension (tránh trả lại cùng 1 job)
_inflight_jobs: set[str] = set()
_inflight_browser_counts: dict[tuple[int, str], int] = {}
_browser_account_cooldown_until: dict[int, float] = {}

_RECAPTCHA_COOLDOWN_BASE_SECONDS = 60
_RECAPTCHA_COOLDOWN_JITTER_SECONDS = 30


def _is_unusual_activity(body: str) -> bool:
    text = str(body or "").lower()
    return "public_error_unusual_activity" in text or "recaptcha evaluation failed" in text


def _set_browser_account_cooldown(account_index: int, body: str = "") -> int:
    account = max(1, int(account_index or 1))
    seconds = _RECAPTCHA_COOLDOWN_BASE_SECONDS + random.randint(0, _RECAPTCHA_COOLDOWN_JITTER_SECONDS)
    _browser_account_cooldown_until[account] = time.monotonic() + seconds
    logger.warning(
        "[Extension] Pause browser jobs account #%s trong %ss do reCAPTCHA/unusual activity | body=%s",
        account,
        seconds,
        str(body or "").replace("\n", " ")[:300],
    )
    return seconds


def _browser_account_wait_seconds(account_index: int) -> float:
    account = max(1, int(account_index or 1))
    wait = _browser_account_cooldown_until.get(account, 0.0) - time.monotonic()
    if wait <= 0:
        _browser_account_cooldown_until.pop(account, None)
        return 0.0
    return wait


def _browser_job_group(job_type: str | None) -> str:
    return "image" if str(job_type or "").lower() in {"image", "image_upscale"} else "video"


def _browser_submit_limit(job_type: str | None) -> int:
    try:
        from services.config_service import load_config

        cfg = load_config()
        key = "MAX_CONCURRENT_IMAGE" if _browser_job_group(job_type) == "image" else "MAX_CONCURRENT"
        return max(1, min(3, int(cfg.get(key) or 2)))
    except Exception:
        return 2


def _browser_inflight_count(account_index: int, job_type: str | None) -> int:
    account = max(1, int(account_index or 1))
    return int(_inflight_browser_counts.get((account, _browser_job_group(job_type)), 0))


def _claim_browser_slot(job_id: str, account_index: int, job_type: str | None) -> None:
    account = max(1, int(account_index or 1))
    group = _browser_job_group(job_type)
    key = (account, group)
    _browser_job_slots[job_id] = key
    _inflight_browser_counts[key] = _inflight_browser_counts.get(key, 0) + 1


def _release_browser_slot(job_id: str, fallback_account: int = 1, fallback_job_type: str | None = "video") -> None:
    key = _browser_job_slots.pop(job_id, None)
    if key is None:
        account = max(1, int(fallback_account or 1))
        key = (account, _browser_job_group(fallback_job_type))
    if key not in _inflight_browser_counts:
        return
    next_count = max(0, int(_inflight_browser_counts.get(key, 0)) - 1)
    if next_count:
        _inflight_browser_counts[key] = next_count
    else:
        _inflight_browser_counts.pop(key, None)


async def wait_for_browser_account_available(account_index: int, *, timeout: float = 300.0) -> None:
    """Wait until a browser account is not in-flight/cooldown before doing pre-submit work."""
    account = max(1, int(account_index or 1))
    deadline = time.monotonic() + timeout
    while True:
        wait = _browser_account_wait_seconds(account)
        busy = _browser_inflight_count(account, "image") >= _browser_submit_limit("image")
        if wait <= 0 and not busy:
            return
        if time.monotonic() >= deadline:
            return
        sleep_for = min(2.0, max(0.2, wait if wait > 0 else 1.0))
        await asyncio.sleep(sleep_for)


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
            token_preview = f"{token[:20]}..." if len(token) > 20 else token
            logger.info("[recaptcha_token] :%s", token_preview)
        else:
            logger.warning("⚠️ captcha job_%s trả về token rỗng", job_id[:8])
        return token
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ captcha cho job_%s", job_id[:8])
        return None
    finally:
        _pending_captcha.pop(job_id, None)
        _inflight_jobs.discard(job_id)
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
    timeout_seconds: float = 300.0,
) -> dict:
    """Queue a browser job that uploads image(s) then POSTs the generation request.
    uploads: list of {base64, mimeType, payloadPath} dicts.
    payloadPath: dot-notation path where mediaId should be injected, e.g. 'requests[0].startImage.mediaId'
    """
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_browser_submit[job_id] = fut
    _browser_job_accounts[job_id] = normalized_account_index
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
        result = await asyncio.wait_for(asyncio.shield(fut), timeout=float(timeout_seconds or 300.0))
        return result or {"ok": False, "status": 0, "body": "No browser result"}
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ browser-upload-post cho job_%s", job_id[:8])
        return {"ok": False, "status": 0, "body": "Browser upload+post timeout"}
    finally:
        _pending_browser_submit.pop(job_id, None)
        _inflight_jobs.discard(job_id)
        account_for_job = _browser_job_accounts.pop(job_id, normalized_account_index)
        _release_browser_slot(job_id, account_for_job, job_type)
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
    timeout_seconds: float = 300.0,
) -> dict:
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_browser_submit[job_id] = fut
    _browser_job_accounts[job_id] = normalized_account_index
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
        result = await asyncio.wait_for(asyncio.shield(fut), timeout=float(timeout_seconds or 300.0))
        return result or {"ok": False, "status": 0, "body": "No browser result"}
    except asyncio.TimeoutError:
        logger.warning("⚠️ Timeout khi chờ browser-submit cho job_%s", job_id[:8])
        return {"ok": False, "status": 0, "body": "Browser submit timeout"}
    finally:
        _pending_browser_submit.pop(job_id, None)
        _inflight_jobs.discard(job_id)
        account_for_job = _browser_job_accounts.pop(job_id, normalized_account_index)
        _release_browser_slot(job_id, account_for_job, job_type)
        for i, item in enumerate(_browser_submit_queue):
            if item["jobId"] == job_id:
                _browser_submit_queue.pop(i)
                break


async def request_browser_character_entity(
    job_id: str,
    *,
    payload: dict,
    access_token: str,
    account_index: int = 1,
    timeout_seconds: float = 180.0,
) -> dict:
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    normalized_account_index = max(1, int(account_index or 1))
    _pending_browser_submit[job_id] = fut
    _browser_job_accounts[job_id] = normalized_account_index
    _browser_submit_queue.append(
        {
            "jobId": job_id,
            "jobKind": "browser_character_entity",
            "jobType": "image",
            "accountIndex": normalized_account_index,
            "payload": payload,
            "accessToken": access_token,
        }
    )
    logger.info(
        "ðŸŒ [Server] Xáº¿p hÃ ng browser-character-entity cho job_%s (account #%s)",
        job_id[:8],
        normalized_account_index,
    )
    try:
        result = await asyncio.wait_for(asyncio.shield(fut), timeout=float(timeout_seconds or 180.0))
        return result or {"ok": False, "status": 0, "body": "No browser result"}
    except asyncio.TimeoutError:
        logger.warning("âš ï¸ Timeout khi chá» browser-character-entity cho job_%s", job_id[:8])
        return {"ok": False, "status": 0, "body": "Browser character sync timeout"}
    finally:
        _pending_browser_submit.pop(job_id, None)
        _inflight_jobs.discard(job_id)
        account_for_job = _browser_job_accounts.pop(job_id, normalized_account_index)
        _release_browser_slot(job_id, account_for_job, "image")
        for i, item in enumerate(_browser_submit_queue):
            if item["jobId"] == job_id:
                _browser_submit_queue.pop(i)
                break


@router.get("/poll-job")
async def poll_job():
    # Browser submit jobs — pop ngay khi trả, đánh dấu in-flight
    for i, job in enumerate(_browser_submit_queue):
        job_id = job["jobId"]
        account_index = max(1, int(job.get("accountIndex") or 1))
        if job_id in _inflight_jobs:
            continue  # đang được xử lý, bỏ qua
        if _browser_inflight_count(account_index, job.get("jobType")) >= _browser_submit_limit(job.get("jobType")):
            continue
        if _browser_account_wait_seconds(account_index) > 0:
            continue
        _browser_submit_queue.pop(i)
        _inflight_jobs.add(job_id)
        _claim_browser_slot(job_id, account_index, job.get("jobType"))
        job_kind = str(job.get("jobKind") or "browser_submit")
        logger.info(
            "[Extension] account #%s browser slot %s/%s for %s",
            account_index,
            _browser_inflight_count(account_index, job.get("jobType")),
            _browser_submit_limit(job.get("jobType")),
            job.get("jobType", "video"),
        )
        logger.info(
            "📤 [Extension] poll-job -> job_%s (%s, %s, account #%s)",
            job_id[:8],
            job_kind,
            job.get("jobType", "video"),
            job.get("accountIndex", 1),
        )
        return {
            "hasJob": True,
            "jobKind": job_kind,
            "jobId": job_id,
            "jobType": job.get("jobType", "video"),
            "accountIndex": job.get("accountIndex", 1),
            "url": job.get("url", ""),
            "payload": job.get("payload", {}),
            "accessToken": job.get("accessToken", ""),
        }

    # Captcha jobs
    for i, job in enumerate(_captcha_queue):
        job_id = job["jobId"]
        if job_id in _inflight_jobs:
            continue
        _captcha_queue.pop(i)
        _inflight_jobs.add(job_id)
        logger.info(
            "📤 [Extension] poll-job -> job_%s (%s, account #%s)",
            job_id[:8],
            job.get("jobType", "video"),
            job.get("accountIndex", 1),
        )
        return {
            "hasJob": True,
            "jobKind": "captcha",
            "jobId": job_id,
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

    _inflight_jobs.discard(req.jobId)
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

    _inflight_jobs.discard(req.jobId)
    mapped_account = _browser_job_accounts.get(req.jobId)
    fut = _pending_browser_submit.get(req.jobId)
    if fut and not fut.done():
        expected_account = int(mapped_account or (queued_job or {}).get("accountIndex") or 1)
        received_account = int(req.accountIndex or expected_account)
        expected_type = str((queued_job or {}).get("jobType") or "video")
        _release_browser_slot(req.jobId, expected_account, expected_type)
        logger.info(
            "✅ [Extension] submit-browser cho job_%s | account #%s | status=%s",
            req.jobId[:8],
            received_account,
            req.status,
        )
        if (not req.ok) or int(req.status or 0) >= 400:
            body_preview = str(req.body or "").replace("\n", " ")[:1200]
            reason_preview = str(req.reason or "").replace("\n", " ")[:300]
            logger.warning(
                "❌ [Extension] submit-browser error | job_%s | account #%s | status=%s | reason=%s | body=%s",
                req.jobId[:8],
                received_account,
                req.status,
                reason_preview,
                body_preview,
            )
            if int(req.status or 0) == 403 and _is_unusual_activity(req.body):
                _set_browser_account_cooldown(received_account, req.body)
        fut.set_result(
            {
                "ok": bool(req.ok),
                "status": int(req.status or 0),
                "body": req.body or "",
                "reason": req.reason or "",
            }
        )
        return {"ok": True}

    fallback_account = int(mapped_account or req.accountIndex or 1)
    fallback_type = str((queued_job or {}).get("jobType") or "video")
    _release_browser_slot(req.jobId, fallback_account, fallback_type)
    if int(req.status or 0) == 403 and _is_unusual_activity(req.body):
        _set_browser_account_cooldown(fallback_account, req.body)
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

    if _pending_browser_submit or _inflight_jobs:
        _last_token_capture["decision"] = "ignored_busy_capture"
        logger.info(
            "[Extension] ignored captured token while jobs are active | pending=%s | inflight=%s | account #%s | url=%s",
            len(_pending_browser_submit),
            len(_inflight_jobs),
            int(payload.accountIndex or 1),
            payload.url or "?",
        )
        return {"ok": True, "message": "Ignored captured token while jobs are active"}

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

    # Always save live token captured from browser — it's fresher than anything in config.
    # TOKEN_OPTION only controls user-manual token entry in settings, not live browser capture.

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


@router.get("/token-for-account")
async def get_token_for_account(account_index: int = 1):
    """Extension gọi endpoint này để lấy token đúng theo account_index."""
    from services.config_service import load_config
    cfg = load_config()
    requested_index = max(1, int(account_index or 1))
    target_key = f"account{requested_index}"
    acc = cfg.get(target_key, {})
    token = acc.get("ACCESS_TOKEN", "") if acc else ""
    if not token:
        # Fallback: tìm account đầu tiên có token
        for i in range(1, 6):
            key = f"account{i}"
            t = cfg.get(key, {}).get("ACCESS_TOKEN", "")
            if t:
                token = t
                break
    return {"ok": True, "token": token, "accountIndex": requested_index}


@router.get("/status")
async def extension_status():
    return {
        "ok": True,
        "pending_captcha_jobs": len(_captcha_queue),
        "pending_browser_submit_jobs": len(_browser_submit_queue),
        "waiting_futures": len(_pending_captcha) + len(_pending_browser_submit),
        "inflight_browser_counts": {f"{acc}:{group}": count for (acc, group), count in _inflight_browser_counts.items()},
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
