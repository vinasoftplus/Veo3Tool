from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import time
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from services.grok_service import (
    GrokClient,
    GrokError,
    cloak_browser_installed,
    ensure_cloak_browser,
    download_with_account,
    grok_login_account,
    load_grok_accounts,
    load_cookie_from_manual_login,
    open_browser_for_manual_login,
    pick_account,
    public_grok_accounts,
    save_grok_accounts,
)


router = APIRouter(tags=["grok"])
logger = logging.getLogger("grok.router")

_jobs: dict[str, dict[str, Any]] = {}
_login_jobs: dict[str, dict[str, Any]] = {}


def _new_job(kind: str) -> str:
    job_id = uuid.uuid4().hex[:8]
    _jobs[job_id] = {
        "job_id": job_id,
        "kind": kind,
        "status": "queued",
        "progress": 0,
        "message": "Đang xếp hàng",
        "outputs": [],
        "images": [],
        "error": "",
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    return job_id


async def _set_job(job_id: str, **updates: Any) -> None:
    job = _jobs.get(job_id)
    if not job:
        return
    job.update(updates)
    job["updated_at"] = time.time()


def _read_account_index(value: str | None) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


async def _read_uploads(files: list[UploadFile]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for idx, file in enumerate(files or []):
        content = await file.read()
        if not content:
            continue
        name = file.filename or f"ref_{idx + 1}.jpg"
        mime = file.content_type or mimetypes.guess_type(name)[0] or "image/jpeg"
        items.append({"name": name, "mime": mime, "content": content})
    return items


def _acc_label(idx: int, account: dict[str, Any]) -> str:
    email = account.get("email") or f"GROK_{idx + 1}"
    return f"acc#{idx + 1}({email})"


def _is_rate_limit(exc: Exception) -> bool:
    return "429" in str(exc) or "Too many requests" in str(exc)


def _pick_next_account(exclude_indices: set[int]) -> tuple[int, dict[str, Any]] | None:
    """Pick first available account not in exclude_indices."""
    accounts = load_grok_accounts()
    for idx, acc in enumerate(accounts):
        if idx in exclude_indices:
            continue
        if acc.get("enabled", True) and acc.get("cookie"):
            return idx, acc
    return None


async def _run_image_job(
    job_id: str,
    *,
    prompt: str,
    aspect_ratio: str,
    quality: str,
    account_index: int | None,
    refs: list[dict[str, Any]],
) -> None:
    t0 = time.time()
    tried: set[int] = set()
    last_exc: Exception | None = None

    # Build ordered list of account indices to try: preferred first, then others
    accounts = load_grok_accounts()
    order: list[int] = []
    if account_index is not None and 0 <= account_index < len(accounts):
        order.append(account_index)
    for i, acc in enumerate(accounts):
        if i not in order and acc.get("enabled", True) and acc.get("cookie"):
            order.append(i)

    for idx in order:
        if idx in tried:
            continue
        tried.add(idx)
        account = accounts[idx]
        acc = _acc_label(idx, account)
        mode = "quality" if str(quality).lower() == "quality" else "speed"
        kind = "i2i" if refs else "t2i"
        try:
            await _set_job(job_id, status="running", progress=1, message=f"Đang chuẩn bị [{acc}]")
            logger.info("🖼  [%s] job=%s | %s | aspect=%s mode=%s", acc, job_id[:8], kind, aspect_ratio, mode)
            client = GrokClient(account)

            async def progress(pct: int, msg: str, _acc=acc) -> None:
                await _set_job(job_id, progress=max(1, min(99, pct)), message=msg)
                if pct % 20 == 0 or pct >= 99:
                    logger.info("   [%s] job=%s | %d%% %s", _acc, job_id[:8], pct, msg)

            if refs:
                await progress(5, "Đang upload ảnh tham chiếu")
                uploaded = await client.upload_image(refs[0]["name"], refs[0]["content"], refs[0]["mime"])
                images = await client.image_to_image(prompt, uploaded, aspect_ratio=aspect_ratio, mode=mode, progress_cb=progress)
            else:
                images = await client.text_to_image_ws(prompt, aspect_ratio=aspect_ratio, mode=mode, progress_cb=progress)

            for item in images:
                item["account_index"] = idx
                item["prompt"] = prompt
                item["label"] = "Ảnh Grok"
            elapsed = time.time() - t0
            logger.info("✅ [%s] job=%s | ảnh xong | %.1fs | url=%s", acc, job_id[:8], elapsed, (images[0].get("url") or "")[:60])
            await _set_job(job_id, status="completed", progress=100, message="Hoàn tất", images=images, outputs=[])
            return
        except Exception as exc:
            last_exc = exc
            if _is_rate_limit(exc):
                logger.warning("⚠️  [%s] job=%s | 429 rate limit — thử account khác", acc, job_id[:8])
                continue
            # Non-429 error — fail immediately
            break

    elapsed = time.time() - t0
    logger.error("❌ [image] job=%s | lỗi %.1fs | %s", job_id[:8], elapsed, last_exc)
    await _set_job(job_id, status="failed", progress=100, message="Lỗi", error=str(last_exc))


async def _run_video_job(
    job_id: str,
    *,
    prompt: str,
    aspect_ratio: str,
    duration: int,
    resolution: str,
    account_index: int | None,
    refs: list[dict[str, Any]],
) -> None:
    t0 = time.time()
    last_exc: Exception | None = None

    accounts = load_grok_accounts()
    order: list[int] = []
    if account_index is not None and 0 <= account_index < len(accounts):
        order.append(account_index)
    for i, acc in enumerate(accounts):
        if i not in order and acc.get("enabled", True) and acc.get("cookie"):
            order.append(i)

    tried: set[int] = set()
    for idx in order:
        if idx in tried:
            continue
        tried.add(idx)
        account = accounts[idx]
        acc = _acc_label(idx, account)
        kind = "i2v" if refs else "t2v"
        try:
            await _set_job(job_id, status="running", progress=1, message=f"Đang chuẩn bị [{acc}]")
            logger.info("🎬 [%s] job=%s | %s | aspect=%s %s %ds", acc, job_id[:8], kind, aspect_ratio, resolution, duration)
            client = GrokClient(account)

            async def progress(pct: int, msg: str, _acc=acc) -> None:
                await _set_job(job_id, progress=max(1, min(99, pct)), message=msg)
                if pct % 20 == 0 or pct >= 99:
                    logger.info("   [%s] job=%s | %d%% %s", _acc, job_id[:8], pct, msg)

            if refs:
                await progress(5, "Đang upload ảnh tham chiếu")
                uploaded = await client.upload_image(refs[0]["name"], refs[0]["content"], refs[0]["mime"])
                outputs = await client.image_to_video(
                    prompt, uploaded,
                    aspect_ratio=aspect_ratio, duration=duration, resolution=resolution, progress_cb=progress,
                )
            else:
                outputs = await client.text_to_video(
                    prompt,
                    aspect_ratio=aspect_ratio, duration=duration, resolution=resolution, progress_cb=progress,
                )
            for item in outputs:
                item["account_index"] = idx
                item["prompt"] = prompt
                item["provider"] = "grok"
            elapsed = time.time() - t0
            logger.info("✅ [%s] job=%s | video xong | %.1fs | url=%s", acc, job_id[:8], elapsed, (outputs[0].get("video_url") or "")[:60])
            await _set_job(job_id, status="completed", progress=100, message="Hoàn tất", outputs=outputs)
            return
        except Exception as exc:
            last_exc = exc
            if _is_rate_limit(exc):
                logger.warning("⚠️  [%s] job=%s | 429 rate limit — thử account khác", acc, job_id[:8])
                continue
            break

    elapsed = time.time() - t0
    logger.error("❌ [video] job=%s | lỗi %.1fs | %s", job_id[:8], elapsed, last_exc)
    await _set_job(job_id, status="failed", progress=100, message="Lỗi", error=str(last_exc))


class GrokLoginRequest(BaseModel):
    lines: str


class GrokAccountToggleRequest(BaseModel):
    index: int
    enabled: bool


class GrokOpenProfileRequest(BaseModel):
    index: int


class GrokManualLoginRequest(BaseModel):
    index: int


class GrokLoadCookieRequest(BaseModel):
    index: int
    email: str = ""


@router.get("/accounts")
async def accounts():
    return {"ok": True, "accounts": public_grok_accounts()}


async def _run_login_job(job_id: str, lines: list[str]) -> None:
    job = _login_jobs[job_id]
    accounts_data = load_grok_accounts()
    results = []
    total = len(lines)
    for i, line in enumerate(lines):
        if "|" not in line:
            results.append({"ok": False, "line": line, "error": "Sai định dạng email|mật khẩu"})
            continue
        email, password = [x.strip() for x in line.split("|", 1)]
        if not email or not password:
            results.append({"ok": False, "email": email, "error": "Thiếu email hoặc mật khẩu"})
            continue
        index = next((i2 for i2, acc in enumerate(accounts_data) if acc.get("email") == email), len(accounts_data))
        job["status"] = "running"
        job["message"] = f"[{i+1}/{total}] Đang mở Chrome đăng nhập {email}..."
        job["email"] = email
        try:
            account = await grok_login_account(email, password, index)
            if index < len(accounts_data):
                accounts_data[index] = account
            else:
                accounts_data.append(account)
            save_grok_accounts(accounts_data)
            results.append({"ok": True, "email": email, "index": index})
            job["message"] = f"[{i+1}/{total}] ✓ {email} đăng nhập thành công"
        except Exception as exc:
            results.append({"ok": False, "email": email, "error": str(exc)})
            job["message"] = f"[{i+1}/{total}] ✗ {email}: {str(exc)[:120]}"
    job["status"] = "done"
    job["results"] = results
    job["accounts"] = public_grok_accounts()
    job["ok"] = any(r.get("ok") for r in results)


@router.post("/accounts/login")
async def login_accounts(req: GrokLoginRequest):
    lines = [line.strip() for line in str(req.lines or "").splitlines() if line.strip()]
    if not lines:
        raise HTTPException(400, "Chưa nhập email|mật khẩu")
    job_id = uuid.uuid4().hex[:10]
    _login_jobs[job_id] = {"status": "queued", "message": "Đang chuẩn bị...", "email": "", "ok": False, "results": [], "accounts": []}
    asyncio.create_task(_run_login_job(job_id, lines))
    return {"ok": True, "job_id": job_id}


@router.get("/accounts/login-status/{job_id}")
async def login_status(job_id: str):
    job = _login_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy login job")
    return {"ok": True, **job}


@router.post("/accounts/toggle")
async def toggle_account(req: GrokAccountToggleRequest):
    accounts_data = load_grok_accounts()
    if req.index < 0 or req.index >= len(accounts_data):
        raise HTTPException(404, "Không tìm thấy tài khoản Grok")
    accounts_data[req.index]["enabled"] = bool(req.enabled)
    save_grok_accounts(accounts_data)
    return {"ok": True, "accounts": public_grok_accounts()}


@router.delete("/accounts/{index}")
async def delete_account(index: int):
    import shutil
    accounts_data = load_grok_accounts()
    if index < 0 or index >= len(accounts_data):
        raise HTTPException(404, "Không tìm thấy tài khoản Grok")
    profile = accounts_data[index].get("profile") or f"GROK_{index + 1}"
    accounts_data.pop(index)
    save_grok_accounts(accounts_data)
    # Remove Chrome + CloakBrowser profile directories
    from services.config_service import CHROME_USER_DATA_ROOT, CLOAK_USER_DATA_ROOT
    for root in (CHROME_USER_DATA_ROOT, CLOAK_USER_DATA_ROOT):
        profile_dir = root / str(profile)
        if profile_dir.exists():
            shutil.rmtree(profile_dir, ignore_errors=True)
    return {"ok": True, "accounts": public_grok_accounts()}


@router.post("/accounts/{index}/health")
async def health(index: int):
    try:
        _, account = pick_account(index)
        data = await GrokClient(account).health()
        return {"ok": True, **data}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/accounts/open-profile")
async def open_profile(req: GrokOpenProfileRequest):
    accounts_data = load_grok_accounts()
    if req.index < 0 or req.index >= len(accounts_data):
        raise HTTPException(404, "Không tìm thấy tài khoản Grok")
    # Reuse open_browser_for_manual_login so CloakBrowser profiles open from CLOAK_USER_DATA_ROOT
    return await open_browser_for_manual_login(req.index)


@router.post("/accounts/open-browser")
async def open_browser_manual(req: GrokManualLoginRequest):
    """Open a visible CloakBrowser window so user can login manually."""
    try:
        return await open_browser_for_manual_login(req.index)
    except Exception as e:
        import traceback
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


_load_cookie_jobs: dict[str, dict] = {}


async def _run_load_cookie_job(job_id: str, index: int, email: str) -> None:
    job = _load_cookie_jobs[job_id]
    try:
        job["message"] = "Đang load cookie..."
        result = await load_cookie_from_manual_login(index, email)
        job["status"] = "done"
        job["ok"] = True
        job["message"] = "Lưu cookie thành công!"
        job["accounts"] = result.get("accounts", [])
    except Exception as exc:
        job["status"] = "done"
        job["ok"] = False
        job["message"] = str(exc)


@router.post("/accounts/load-cookie")
async def load_cookie_manual(req: GrokLoadCookieRequest):
    job_id = uuid.uuid4().hex[:10]
    _load_cookie_jobs[job_id] = {"status": "running", "ok": False, "message": "Đang chuẩn bị...", "accounts": []}
    asyncio.create_task(_run_load_cookie_job(job_id, req.index, req.email))
    return {"ok": True, "job_id": job_id}


@router.get("/accounts/load-cookie-status/{job_id}")
async def load_cookie_status(job_id: str):
    job = _load_cookie_jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy job")
    return {"ok": True, **job}


@router.post("/studio-image")
async def studio_image(
    prompt: str = Form(""),
    aspect_ratio: str = Form("9:16"),
    quality: str = Form("speed"),
    account_index: str | None = Form(None),
    reference_images: list[UploadFile] = File([]),
):
    if not prompt.strip():
        raise HTTPException(400, "Prompt trống")
    refs = await _read_uploads(reference_images)
    job_id = _new_job("image")
    asyncio.create_task(
        _run_image_job(
            job_id,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            quality=quality,
            account_index=_read_account_index(account_index),
            refs=refs,
        )
    )
    return {"ok": True, "job_id": job_id}


@router.post("/studio-video")
async def studio_video(
    prompt: str = Form(""),
    aspect_ratio: str = Form("9:16"),
    duration: int = Form(6),
    resolution: str = Form("720p"),
    account_index: str | None = Form(None),
    reference_images: list[UploadFile] = File([]),
):
    if not prompt.strip():
        raise HTTPException(400, "Prompt trống")
    duration = 10 if int(duration or 6) == 10 else 6
    resolution = "480p" if str(resolution).lower() == "480p" else "720p"
    refs = await _read_uploads(reference_images)
    job_id = _new_job("video")
    asyncio.create_task(
        _run_video_job(
            job_id,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            duration=duration,
            resolution=resolution,
            account_index=_read_account_index(account_index),
            refs=refs,
        )
    )
    return {"ok": True, "job_id": job_id}


@router.get("/job/{job_id}")
async def get_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy job Grok")
    return {"ok": True, "job": job}


@router.get("/proxy-download")
async def proxy_download(url: str, filename: str = "grok_download.bin", account_index: int | None = None):
    import httpx
    if url.startswith("https://imagine-public.x.ai/"):
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as http:
                res = await http.get(url, headers={"Referer": "https://grok.com/"})
            if res.status_code != 200:
                raise HTTPException(502, f"Tải file lỗi HTTP {res.status_code}")
            ct = res.headers.get("content-type", "video/mp4")
            return Response(
                res.content,
                media_type=ct,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )
        except httpx.RequestError as exc:
            raise HTTPException(502, str(exc))
    try:
        _, account = pick_account(account_index)
        content, content_type = await download_with_account(url, account, filename)
        return Response(
            content,
            media_type=content_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except GrokError as exc:
        raise HTTPException(502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(502, detail=str(exc))


@router.get("/proxy-video")
async def proxy_video(url: str, account_index: int | None = None):
    """Proxy Grok video URLs via CloakBrowser fetch (same TLS session as login)."""
    if not url.startswith("https://assets.grok.com/"):
        raise HTTPException(400, "URL không hợp lệ")
    try:
        _, account = pick_account(account_index)
        content, content_type = await download_with_account(url, account, "video.mp4")
        return Response(content, media_type=content_type, headers={"Accept-Ranges": "bytes"})
    except GrokError as exc:
        raise HTTPException(502, str(exc))
    except Exception as exc:
        raise HTTPException(502, str(exc))


@router.get("/proxy-image")
async def proxy_image(url: str, account_index: int | None = None):
    """Proxy Grok image URLs — public ones via httpx, auth ones via account cookie."""
    import httpx
    allowed = ("https://imagine-public.x.ai/", "https://assets.grok.com/")
    if not any(url.startswith(p) for p in allowed):
        raise HTTPException(400, "URL không hợp lệ")
    if url.startswith("https://assets.grok.com/"):
        try:
            _, account = pick_account(account_index)
            content, content_type = await download_with_account(url, account, "image.jpg")
            return Response(content, media_type=content_type)
        except GrokError as exc:
            raise HTTPException(502, detail=str(exc))
        except Exception as exc:
            raise HTTPException(502, detail=str(exc))
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as http:
            res = await http.get(url, headers={"Referer": "https://grok.com/"})
        if res.status_code != 200:
            raise HTTPException(502, f"Tải ảnh lỗi HTTP {res.status_code}")
        ct = res.headers.get("content-type", "image/jpeg")
        return Response(res.content, media_type=ct)
    except httpx.RequestError as exc:
        raise HTTPException(502, str(exc))


@router.get("/browser-status")
async def browser_status():
    """Check if CloakBrowser binary is installed."""
    return {"installed": cloak_browser_installed()}


@router.get("/ensure-browser")
async def ensure_browser_sse():
    """SSE stream: download CloakBrowser if not installed, stream progress to UI."""
    import json

    async def generate():
        async def on_progress(pct: int, msg: str):
            data = json.dumps({"pct": pct, "msg": msg})
            # yield is not allowed inside nested async def, use queue
            await q.put(f"data: {data}\n\n")

        q: asyncio.Queue = asyncio.Queue()

        async def run():
            try:
                await ensure_cloak_browser(progress_cb=on_progress)
            except Exception as e:
                with contextlib.suppress(Exception):
                    await q.put(f"data: {json.dumps({'pct': -1, 'msg': str(e)})}\n\n")
            finally:
                with contextlib.suppress(Exception):
                    await q.put(None)  # sentinel

        task = asyncio.create_task(run())
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        except Exception:
            pass
        with contextlib.suppress(Exception):
            await task

    return StreamingResponse(generate(), media_type="text/event-stream")

