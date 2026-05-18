"""
Google Labs / AI Sandbox adapter.
Consolidates API_text_to_video.py, API_image_to_video.py,
API_sync_chactacter.py, API_Create_image.py from RUN_VEO_4.0.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import urllib.error
import urllib.request
import uuid
from typing import Any
from urllib.parse import quote

# ---------------------------------------------------------------------------
# Endpoints (confirmed from RUN_VEO_4.0 API_*.py files)
# ---------------------------------------------------------------------------
URL_T2V = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText"
URL_I2V = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage"
URL_STARTEND = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage"
URL_REF_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages"
URL_STATUS = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus"
URL_UPSCALE_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoUpsampleVideo"
URL_UPSCALE_IMAGE = "https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage"
URL_IMG_GEN_TPL = "https://aisandbox-pa.googleapis.com/v1/projects/{project_id}/flowMedia:batchGenerateImages"
URL_FLOW_UPLOAD = "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage"
URL_WHISK = "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage"
URL_UPLOAD = "https://aisandbox-pa.googleapis.com/v1:uploadUserImage"

# Model keys (from API_text_to_video.py and API_image_to_video.py)
_T2V_MODEL_KEYS = {
    ("ULTRA", "landscape"): "veo_3_1_t2v_fast_ultra",
    ("ULTRA", "portrait"): "veo_3_1_t2v_fast_portrait_ultra",
    ("ULTRA", "landscape_relaxed"): "veo_3_1_t2v_fast_ultra_relaxed",
    ("ULTRA", "portrait_relaxed"): "veo_3_1_t2v_fast_portrait_ultra_relaxed",
    ("NORMAL", "landscape"): "veo_3_1_t2v_fast",
    ("NORMAL", "portrait"): "veo_3_1_t2v_fast_portrait",
    ("PRO", "landscape"): "veo_3_1_t2v_fast",
    ("PRO", "portrait"): "veo_3_1_t2v_fast_portrait",
}
_I2V_MODEL_KEYS = {
    ("ULTRA", "landscape"): "veo_3_1_i2v_s_fast_ultra",
    ("ULTRA", "portrait"): "veo_3_1_i2v_s_fast_portrait_ultra",
    ("NORMAL", "landscape"): "veo_3_1_i2v_s_fast",
    ("NORMAL", "portrait"): "veo_3_1_i2v_s_fast_portrait",
    ("PRO", "landscape"): "veo_3_1_i2v_s_fast",
    ("PRO", "portrait"): "veo_3_1_i2v_s_fast_portrait",
}
_REF_MODEL_KEYS = {
    ("ULTRA", "landscape"): "veo_3_1_r2v_fast_landscape_ultra",
    ("ULTRA", "portrait"): "veo_3_1_r2v_fast_portrait_ultra",
    ("NORMAL", "landscape"): "veo_3_1_r2v_fast_landscape",
    ("NORMAL", "portrait"): "veo_3_1_r2v_fast_portrait",
    ("PRO", "landscape"): "veo_3_1_r2v_fast_landscape",
    ("PRO", "portrait"): "veo_3_1_r2v_fast_portrait",
}
_IMG_MODEL_MAP = {
    "Imagen 4": "IMAGEN_3_5",
    "Nano Banana pro": "GEM_PIX_2",
    "Nano Banana 2": "NARWHAL",
    "Nano Banana": "GEM_PIX",
}
_PAYGATE = {
    "ULTRA": "PAYGATE_TIER_TWO",
    "PRO": "PAYGATE_TIER_ONE",
    "NORMAL": "PAYGATE_TIER_NOT_PAID",
}

DEFAULT_SEED = 9797
logger = logging.getLogger("veo.google_labs")

_UUID_PAT = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _random_seed() -> int:
    return random.randint(0, 294967295)


def _orient(aspect_ratio: str) -> str:
    return "portrait" if "PORTRAIT" in aspect_ratio.upper() else "landscape"


def _account_type(account: dict) -> str:
    # Config saves as TIER, fallback to TYPE_ACCOUNT for backwards compat
    return str(account.get("TIER") or account.get("TYPE_ACCOUNT") or "ULTRA").upper()


def _paygate(account: dict) -> str:
    return _PAYGATE.get(_account_type(account), "PAYGATE_TIER_TWO")


def _token(account: dict) -> str:
    return account.get("ACCESS_TOKEN", "")


def _cookie(account: dict) -> str:
    return account.get("COOKIE", "")


def _project_id(account: dict) -> str:
    return account.get("PROJECT_ID", "")


def _resolve_video_model_key(kind: str, account: dict, aspect_ratio: str, model: str = "auto") -> str:
    orient = _orient(aspect_ratio)
    acc_type = _account_type(account)
    normalized = str(model or "auto").strip().lower()

    if kind == "t2v":
        if normalized == "flow_lite_low_priority":
            return "veo_3_1_t2v_lite_low_priority"
        if normalized == "flow_lite":
            return "veo_3_1_t2v_lite"
        if normalized == "flow_fast_relaxed":
            if acc_type == "ULTRA":
                return _T2V_MODEL_KEYS.get((acc_type, f"{orient}_relaxed"), _T2V_MODEL_KEYS.get((acc_type, orient), "veo_3_1_t2v_fast_ultra"))
            return _T2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_t2v_fast")
        if normalized == "flow_fast_no_ultra":
            return _T2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_t2v_fast")
        if normalized == "flow_fast":
            return _T2V_MODEL_KEYS.get((acc_type, orient), _T2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_t2v_fast"))
        if normalized == "flow_quality":
            return _T2V_MODEL_KEYS.get((acc_type, orient), _T2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_t2v_fast"))
        if normalized.startswith("veo_"):
            return model
        return _T2V_MODEL_KEYS.get((acc_type, orient), "veo_3_1_t2v_fast_ultra")

    if kind == "i2v":
        if normalized == "flow_fast_relaxed":
            if acc_type == "ULTRA":
                relaxed_map = {
                    "landscape": "veo_3_1_i2v_s_fast_ultra_relaxed",
                    "portrait": "veo_3_1_i2v_s_fast_portrait_ultra_relaxed",
                }
                return relaxed_map.get(orient, "veo_3_1_i2v_s_fast_ultra_relaxed")
            return _I2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_i2v_s_fast")
        if normalized == "flow_fast_no_ultra":
            return _I2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_i2v_s_fast")
        if normalized == "flow_fast":
            return _I2V_MODEL_KEYS.get((acc_type, orient), _I2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_i2v_s_fast"))
        if normalized == "flow_quality":
            return _I2V_MODEL_KEYS.get((acc_type, orient), _I2V_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_i2v_s_fast"))
        if normalized.startswith("veo_"):
            return model
        return _I2V_MODEL_KEYS.get((acc_type, orient), "veo_3_1_i2v_s_fast_ultra")

    if kind == "r2v":
        if normalized == "flow_lite_low_priority":
            return "veo_3_1_r2v_lite_low_priority"
        if normalized == "flow_lite":
            return "veo_3_1_r2v_lite"
        relaxed_map = {
            "landscape": "veo_3_1_r2v_fast_landscape_ultra_relaxed",
            "portrait": "veo_3_1_r2v_fast_portrait_ultra_relaxed",
        }
        if normalized == "flow_fast_relaxed":
            if acc_type == "ULTRA":
                return relaxed_map.get(orient, "veo_3_1_r2v_fast_landscape_ultra_relaxed")
            return _REF_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_r2v_fast_portrait")
        if normalized == "flow_fast_no_ultra":
            return _REF_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_r2v_fast_portrait")
        if normalized in ("flow_fast", "flow_quality"):
            return _REF_MODEL_KEYS.get((acc_type, orient), _REF_MODEL_KEYS.get(("NORMAL", orient), "veo_3_1_r2v_fast_portrait"))
        if normalized.startswith("veo_"):
            return model
        return _REF_MODEL_KEYS.get((acc_type, orient), "veo_3_1_r2v_fast_landscape_ultra")

    return model or ""


def _endpoint_name(url: str) -> str:
    if "batchAsyncGenerateVideoText" in url:
        return "text-to-video"
    if "batchAsyncGenerateVideoStartImage" in url:
        return "image-to-video"
    if "batchAsyncGenerateVideoStartAndEndImage" in url:
        return "startend-video"
    if "batchAsyncGenerateVideoReferenceImages" in url:
        return "consistent-video"
    if "batchCheckAsyncVideoGenerationStatus" in url:
        return "check-status"
    if "batchAsyncGenerateVideoUpsampleVideo" in url:
        return "upscale-video"
    if "uploadUserImage" in url:
        return "upload-image"
    return url.rsplit("/", 1)[-1]


def _send_request(url: str, payload: dict, token: str, cookie: str = "", method: str = "POST") -> dict:
    data = json.dumps(payload).encode("utf-8")
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Origin": "https://labs.google",
        "Referer": "https://labs.google/",
        "User-Agent": "Mozilla/5.0",
    }
    if cookie:
        headers["Cookie"] = cookie
    logger.info("🌐 [Labs] %s %s", method, _endpoint_name(url))
    req = urllib.request.Request(url=url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            logger.info("✅ [Labs] %s -> HTTP %s", _endpoint_name(url), resp.status)
            return {"ok": True, "status": resp.status, "body": body}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        logger.warning(
            "❌ [Labs] %s -> HTTP %s | %s",
            _endpoint_name(url),
            exc.code,
            body[:400].replace("\n", " "),
        )
        return {"ok": False, "status": exc.code, "body": body}
    except urllib.error.URLError as exc:
        logger.warning("❌ [Labs] %s -> URL error: %s", _endpoint_name(url), exc)
        return {"ok": False, "status": 0, "body": str(exc)}


async def _async_send(url: str, payload: dict, token: str, cookie: str = "") -> dict:
    result = await asyncio.to_thread(_send_request, url, payload, token, cookie)
    # Auto-refresh: nếu 401 và account có cookie → refresh token rồi retry 1 lần
    if result.get("status") == 401 and token:
        try:
            from services.config_service import load_config, save_account
            from services.token_refresh_service import refresh_account_token
            cfg = load_config()
            for i in range(1, 11):
                acc = cfg.get(f"account{i}", {})
                if acc.get("ACCESS_TOKEN", "").strip() == token.strip() and acc.get("COOKIE", "").strip():
                    logger.info("🔄 [AutoRefresh] 401 detected — refreshing account #%s token...", i)
                    ok = await refresh_account_token(i)
                    if ok:
                        # Lấy token mới vừa lưu
                        new_token = load_config().get(f"account{i}", {}).get("ACCESS_TOKEN", "")
                        if new_token and new_token != token:
                            logger.info("🔄 [AutoRefresh] Retrying request with new token...")
                            result = await asyncio.to_thread(_send_request, url, payload, new_token, cookie)
                    break
        except Exception as _e:
            logger.warning("[AutoRefresh] Error during 401 auto-refresh: %s", _e)
    return result


# ---------------------------------------------------------------------------
# Adapter class
# ---------------------------------------------------------------------------

class GoogleLabsAdapter:
    def build_generate_images_payload(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "Imagen 4",
        seed: int | None = None,
        recaptcha_token: str = "",
        reference_input_names: list[str] | None = None,
    ) -> dict:
        project_id = _project_id(account)
        model_key = _IMG_MODEL_MAP.get(model, "IMAGEN_3_5")
        eff_seed = seed if seed is not None else _random_seed()
        ref_names = [str(x or "").strip() for x in list(reference_input_names or []) if str(x or "").strip()]
        user_paygate_tier = _paygate(account)

        def make_request(i: int) -> dict:
            s = (eff_seed + i) % 294967296 if i > 0 and seed is not None else (_random_seed() if i > 0 else eff_seed)
            ctx = {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": project_id,
                "tool": "PINHOLE",
                "userPaygateTier": user_paygate_tier,
            }
            request_item = {
                "clientContext": ctx,
                "imageAspectRatio": aspect_ratio,
                "seed": s,
                "imageModelName": model_key,
                "prompt": prompt,
                "imageInputs": [],
            }
            if ref_names:
                request_item.pop("prompt", None)
                request_item["structuredPrompt"] = {"parts": [{"text": prompt}]}
                request_item["imageInputs"] = [
                    {
                        "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE",
                        "name": ref_name,
                    }
                    for ref_name in ref_names
                ]
            return request_item

        return {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": project_id,
                "tool": "PINHOLE",
                "userPaygateTier": user_paygate_tier,
            },
            "mediaGenerationContext": {
                "batchId": str(uuid.uuid4()),
            },
            "useNewMedia": True,
            "requests": [make_request(i) for i in range(max(1, output_count))],
        }

    def build_text_to_video_payload(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
        structured_prompt_parts: list[dict] | None = None,
    ) -> dict:
        model_key = _resolve_video_model_key("t2v", account, aspect_ratio, model)
        eff_seed = seed if seed is not None else _random_seed()

        def _make_t2v_req() -> dict:
            return {
                "aspectRatio": aspect_ratio,
                "seed": eff_seed,
                "textInput": {"prompt": prompt},
                "videoModelKey": model_key,
                "metadata": {"sceneId": str(uuid.uuid4())},
            }
        return {
            "clientContext": {
                "recaptchaContext": {
                    "token": recaptcha_token,
                    "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                },
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_t2v_req() for _ in range(max(1, output_count))],
        }

    def build_image_to_video_payload(
        self,
        media_id: str,
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("i2v", account, aspect_ratio, model)

        def _make_i2v_req() -> dict:
            return {
                "aspectRatio": aspect_ratio,
                "seed": _random_seed(),
                "textInput": {"prompt": prompt},
                "videoModelKey": model_key,
                "startImage": {"mediaId": media_id},
                "metadata": {"sceneId": str(uuid.uuid4())},
            }
        return {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_i2v_req() for _ in range(max(1, output_count))],
        }

    # --- Upload image ---
    async def upload_image(self, base64_image: str, mime_type: str, account: dict) -> dict:
        payload = {
            "imageInput": {
                "rawImageBytes": base64_image,
                "mimeType": mime_type,
                "isUserUploaded": True,
            },
            "clientContext": {
                "sessionId": str(uuid.uuid4()),
                "tool": "ASSET_MANAGER",
            },
        }
        return await _async_send(URL_UPLOAD, payload, _token(account), _cookie(account))

    async def upload_flow_image(
        self,
        base64_image: str,
        mime_type: str,
        account: dict,
        file_name: str = "reference.jpg",
    ) -> dict:
        payload = {
            "clientContext": {
                "projectId": _project_id(account),
                "tool": "PINHOLE",
            },
            "imageBytes": str(base64_image or ""),
            "isUserUploaded": True,
            "isHidden": False,
            "mimeType": str(mime_type or "image/jpeg"),
            "fileName": str(file_name or "reference.jpg"),
        }
        return await _async_send(URL_FLOW_UPLOAD, payload, _token(account), _cookie(account))

    def parse_upload_media_id(self, response_body: str) -> str | None:
        def _pick(value: Any) -> str | None:
            if value is None:
                return None
            if isinstance(value, str):
                text = value.strip()
                if not text or text.startswith("{") or text.startswith("["):
                    return None
                return text
            if isinstance(value, dict):
                for key in ("mediaId", "mediaGenerationId", "name", "id"):
                    picked = _pick(value.get(key))
                    if picked:
                        return picked
            return None

        try:
            body = json.loads(response_body)
            if not isinstance(body, dict):
                return None
            for key in ("mediaId", "mediaGenerationId", "name", "id"):
                picked = _pick(body.get(key))
                if picked:
                    return picked
            for v in body.values():
                if isinstance(v, dict):
                    picked = _pick(v)
                    if picked:
                        return picked
        except Exception:
            pass
        return None

    def parse_flow_input_name(self, response_body: str) -> str | None:
        try:
            body = json.loads(response_body)
        except Exception:
            return None
        if not isinstance(body, dict):
            return None

        def _pick(value: Any) -> str:
            text = str(value or "").strip()
            if "/" in text:
                last = text.rsplit("/", 1)[-1].strip()
                # Keep normalization safe: only collapse resource paths when trailing segment
                # looks like an ID (UUID-like or alphanumeric token with separators).
                if last and (
                    _UUID_PAT.match(last)
                    or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{5,}", last)
                ):
                    return last
            return text

        mg = body.get("mediaGenerationId")
        if isinstance(mg, dict):
            picked = _pick(mg.get("mediaGenerationId") or mg.get("name"))
            if picked:
                return picked
        if mg and not isinstance(mg, dict):
            picked = _pick(mg)
            if picked:
                return picked
        media = body.get("media")
        if isinstance(media, dict):
            picked = _pick(media.get("mediaId") or media.get("id") or media.get("name"))
            if picked:
                return picked
        workflow = body.get("workflow")
        if isinstance(workflow, dict):
            metadata = workflow.get("metadata")
            if isinstance(metadata, dict):
                picked = _pick(metadata.get("primaryMediaId"))
                if picked:
                    return picked
        for key in ("name", "id", "mediaId"):
            picked = _pick(body.get(key))
            if picked:
                return picked
        return None

    # --- Text to Video ---
    async def text_to_video(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
        structured_prompt_parts: list[dict] | None = None,
    ) -> dict:
        payload = self.build_text_to_video_payload(
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            seed=seed,
            recaptcha_token=recaptcha_token,
        )
        return await _async_send(URL_T2V, payload, _token(account), _cookie(account))

    # --- Image to Video ---
    async def image_to_video(
        self,
        media_id: str,
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        recaptcha_token: str = "",
    ) -> dict:
        payload = self.build_image_to_video_payload(
            media_id=media_id,
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            recaptcha_token=recaptcha_token,
        )
        return await _async_send(URL_I2V, payload, _token(account), _cookie(account))

    # --- Start-End Video ---
    def build_startend_video_payload(
        self,
        start_media_id: str,
        prompt: str,
        account: dict,
        end_media_id: str | None = None,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("i2v", account, aspect_ratio, model)
        def _make_startend_req() -> dict:
            r: dict[str, Any] = {
                "aspectRatio": aspect_ratio,
                "seed": _random_seed(),
                "videoModelKey": model_key,
                "startImage": {"mediaId": start_media_id},
                "metadata": {"sceneId": str(uuid.uuid4())},
            }
            if end_media_id:
                r["endImage"] = {"mediaId": end_media_id}
                r["textInput"] = {"structuredPrompt": {"parts": [{"text": prompt}]}}
            else:
                r["textInput"] = {"prompt": prompt}
            return r
        return {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_startend_req() for _ in range(max(1, output_count))],
        }

    def build_reference_video_payload(
        self,
        reference_media_ids: list[str],
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
        structured_prompt_parts: list[dict] | None = None,
    ) -> dict:
        model_key = _resolve_video_model_key("r2v", account, aspect_ratio, model)
        refs = [
            {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
            for mid in reference_media_ids[:3] if mid
        ]
        if not refs:
            return {}
        eff_seed = seed if seed is not None else _random_seed()
        prompt_parts = structured_prompt_parts if structured_prompt_parts else [{"text": prompt}]
        def _make_ref_req() -> dict:
            return {
                "aspectRatio": aspect_ratio,
                "seed": eff_seed,
                "textInput": {"structuredPrompt": {"parts": prompt_parts}},
                "videoModelKey": model_key,
                "metadata": {"sceneId": str(uuid.uuid4())},
                "referenceImages": refs,
            }
        return {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_ref_req() for _ in range(max(1, output_count))],
        }

    async def startend_video(
        self,
        start_media_id: str,
        prompt: str,
        account: dict,
        end_media_id: str | None = None,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("i2v", account, aspect_ratio, model)
        def _make_se_req() -> dict:
            r: dict[str, Any] = {
                "aspectRatio": aspect_ratio,
                "seed": _random_seed(),
                "videoModelKey": model_key,
                "startImage": {"mediaId": start_media_id},
                "metadata": {"sceneId": str(uuid.uuid4())},
            }
            if end_media_id:
                r["endImage"] = {"mediaId": end_media_id}
                r["textInput"] = {"structuredPrompt": {"parts": [{"text": prompt}]}}
            else:
                r["textInput"] = {"prompt": prompt}
            return r
        url = URL_STARTEND if end_media_id else URL_I2V
        payload = {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_se_req() for _ in range(max(1, output_count))],
        }
        return await _async_send(url, payload, _token(account), _cookie(account))

    # --- Reference / Consistent Video ---
    async def reference_video(
        self,
        reference_media_ids: list[str],
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
        structured_prompt_parts: list[dict] | None = None,
    ) -> dict:
        model_key = _resolve_video_model_key("r2v", account, aspect_ratio, model)
        refs = [
            {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
            for mid in reference_media_ids[:3]
            if mid
        ]
        if not refs:
            return {"ok": False, "status": 0, "body": "No reference media IDs"}

        eff_seed2 = seed if seed is not None else _random_seed()
        prompt_parts = structured_prompt_parts if structured_prompt_parts else [{"text": prompt}]
        def _make_rv_req() -> dict:
            return {
                "aspectRatio": aspect_ratio,
                "seed": eff_seed2,
                "textInput": {"structuredPrompt": {"parts": prompt_parts}},
                "videoModelKey": model_key,
                "metadata": {"sceneId": str(uuid.uuid4())},
                "referenceImages": refs,
            }
        payload = {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [_make_rv_req() for _ in range(max(1, output_count))],
        }
        return await _async_send(URL_REF_VIDEO, payload, _token(account), _cookie(account))

    # --- Check video status ---
    async def check_video_status(self, operations: list[dict], token: str) -> dict:
        clean_operations: list[dict] = []
        for item in operations or []:
            if not isinstance(item, dict):
                continue
            if item.get("_format") == "workflow":
                name = str(item.get("_primary_media_id") or item.get("primaryMediaId") or "").strip()
            else:
                op = item.get("operation") if isinstance(item.get("operation"), dict) else {}
                name = str(op.get("name") or item.get("name") or "").strip()
            if name:
                clean_operations.append({
                    "operation": {"name": name},
                    "sceneId": str(item.get("sceneId") or ""),
                    "status": str(item.get("status") or "MEDIA_GENERATION_STATUS_PENDING"),
                })

        payload = {"operations": clean_operations or operations}
        return await _async_send(URL_STATUS, payload, token)

    # --- Upscale video ---
    def _resolve_upscale_media_id(self, operation_name: str, media_id: str) -> str:
        """UUID operation_name thực ra là mediaId."""
        if operation_name and _UUID_PAT.match(operation_name.strip()) and not media_id:
            return operation_name
        return media_id

    def build_upscale_payload(self, media_id: str, account: dict | None = None, recaptcha_token: str = "", resolution: str = "1080p") -> dict:
        if resolution == "4k":
            res_key = "VIDEO_RESOLUTION_4K"
            model_key = "veo_3_1_upsampler_4k"
        else:
            res_key = "VIDEO_RESOLUTION_1080P"
            model_key = "veo_3_1_upsampler_1080p"
        return {
            "clientContext": {
                "sessionId": str(uuid.uuid4()),
                "tool": "PINHOLE",
                "projectId": _project_id(account) if account else "",
                "userPaygateTier": _paygate(account) if account else "PAYGATE_TIER_ONE",
                "recaptchaContext": {"token": recaptcha_token},
            },
            "requests": [{
                "resolution": res_key,
                "aspectRatio": "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "seed": _random_seed(),
                "videoModelKey": model_key,
                "metadata": {"workflowId": str(uuid.uuid4())},
                "videoInput": {"mediaId": media_id},
            }],
        }

    async def upscale_video(self, operation_name: str, token: str, media_id: str = "", account: dict | None = None, recaptcha_token: str = "") -> dict:
        """Upscale video lên 1080p — direct API call (Option 1 only)."""
        media_id = self._resolve_upscale_media_id(operation_name, media_id)
        if not media_id:
            return {"ok": False, "status": 0, "body": "Missing mediaId for upscale"}
        payload = self.build_upscale_payload(media_id, account=account, recaptcha_token=recaptcha_token)
        logger.info("[Upscale] mediaId=%s recaptcha=%s", media_id, bool(recaptcha_token))
        return await _async_send(URL_UPSCALE_VIDEO, payload, token)

    # --- Generate images (Banana / Imagen) ---
    async def generate_images(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "Imagen 4",
        seed: int | None = None,
        recaptcha_token: str = "",
    ) -> dict:
        project_id = _project_id(account)
        if not project_id:
            return {"ok": False, "status": 0, "body": "Missing PROJECT_ID"}
        payload = self.build_generate_images_payload(
            prompt=prompt,
            account=account,
            aspect_ratio=aspect_ratio,
            output_count=output_count,
            model=model,
            seed=seed,
            recaptcha_token=recaptcha_token,
        )
        url = URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe=""))
        return await _async_send(url, payload, _token(account), _cookie(account))

    # --- Whisk image ---
    async def generate_whisk_image(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        ref_media_id: str | None = None,
    ) -> dict:
        payload = {
            "clientContext": {
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "WHISK",
            },
            "prompt": prompt,
            "aspectRatio": aspect_ratio,
            "outputCount": output_count,
        }
        if ref_media_id:
            payload["referenceImages"] = [{"mediaId": ref_media_id}]
        return await _async_send(URL_WHISK, payload, _token(account), _cookie(account))

    # --- Virtual Try-On ---
    async def virtual_tryon(
        self,
        model_media_id: str,
        clothing_media_id: str,
        prompt: str,
        account: dict,
        output_count: int = 2,
        recaptcha_token: str = "",
    ) -> dict:
        project_id = _project_id(account)
        image_inputs = [
            {"mediaId": model_media_id, "imageUsageType": "IMAGE_USAGE_TYPE_PERSON"},
            {"mediaId": clothing_media_id, "imageUsageType": "IMAGE_USAGE_TYPE_GARMENT"},
        ]

        def make_request(i: int) -> dict:
            ctx = {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": project_id,
                "tool": "PINHOLE",
            }
            return {
                "clientContext": ctx,
                "imageAspectRatio": "IMAGE_ASPECT_RATIO_PORTRAIT",
                "seed": _random_seed(),
                "imageModelName": "IMAGEN_3_5",
                "prompt": prompt,
                "imageInputs": image_inputs,
            }

        payload = {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": project_id,
                "tool": "PINHOLE",
            },
            "requests": [make_request(i) for i in range(max(1, output_count))],
        }
        url = URL_IMG_GEN_TPL.format(project_id=quote(project_id, safe=""))
        return await _async_send(url, payload, _token(account), _cookie(account))

    # --- Upscale image ---
    def build_upscale_image_payload(self, media_id: str, quality: str = "2k", recaptcha_token: str = "", account: dict | None = None) -> dict:
        ctx: dict = {
            "recaptchaContext": {"token": recaptcha_token},
            "sessionId": str(uuid.uuid4()),
            "tool": "PINHOLE",
        }
        if account:
            pid = _project_id(account)
            if pid:
                ctx["projectId"] = pid
            ctx["userPaygateTier"] = _paygate(account)
        payload: dict = {"mediaId": media_id, "clientContext": ctx}
        if quality == "2k":
            payload["targetResolution"] = "UPSAMPLE_IMAGE_RESOLUTION_2K"
        elif quality == "4k":
            payload["targetResolution"] = "UPSAMPLE_IMAGE_RESOLUTION_4K"
        return payload

    async def upscale_image(self, media_id: str, token: str, quality: str = "1k", recaptcha_token: str = "") -> dict:
        """
        quality: "1k" = gốc (không upscale, chỉ lấy URL redirect),
                 "2k" = UPSAMPLE_IMAGE_RESOLUTION_2K,
                 "4k" = UPSAMPLE_IMAGE_RESOLUTION_4K
        """
        payload = self.build_upscale_image_payload(media_id, quality=quality, recaptcha_token=recaptcha_token)
        return await _async_send(URL_UPSCALE_IMAGE, payload, token)

    # ---------------------------------------------------------------------------
    # Response parsers
    # ---------------------------------------------------------------------------

    def parse_operations(self, response_body: str) -> list[dict]:
        """Parse T2V / I2V create response → list of operation dicts."""
        try:
            body = json.loads(response_body)
        except Exception:
            return []
        results = []

        workflows = body.get("workflows", [])
        if isinstance(workflows, list):
            for item in workflows:
                if not isinstance(item, dict):
                    continue
                workflow = item.get("workflow") if isinstance(item.get("workflow"), dict) else item
                metadata = workflow.get("metadata") if isinstance(workflow.get("metadata"), dict) else {}
                primary_media_id = (
                    item.get("primaryMediaId")
                    or workflow.get("primaryMediaId")
                    or metadata.get("primaryMediaId")
                    or item.get("mediaId")
                    or workflow.get("mediaId")
                    or item.get("name")
                    or workflow.get("name")
                )
                project_id = (
                    item.get("projectId")
                    or workflow.get("projectId")
                    or metadata.get("projectId")
                    or body.get("projectId")
                )
                operation_name = ""
                op = item.get("operation") or workflow.get("operation")
                if isinstance(op, dict):
                    operation_name = str(op.get("name") or "")
                elif op:
                    operation_name = str(op)
                if primary_media_id:
                    results.append({
                        "_format": "workflow",
                        "_primary_media_id": str(primary_media_id),
                        "_project_id": str(project_id or ""),
                        "operation": {"name": operation_name or str(primary_media_id)},
                        "sceneId": item.get("sceneId") or workflow.get("sceneId") or str(uuid.uuid4()),
                        "status": item.get("status") or workflow.get("status") or "MEDIA_GENERATION_STATUS_ACTIVE",
                    })

        ops = body.get("operations", [])
        for item in ops:
            op = item.get("operation", {}) or {}
            name = op.get("name")
            scene_id = item.get("sceneId")
            if name:
                results.append({
                    "operation": {"name": name},
                    "sceneId": scene_id or str(uuid.uuid4()),
                    "status": "MEDIA_GENERATION_STATUS_ACTIVE",
                })
        return results

    def parse_video_results(self, response_body: str) -> list[dict]:
        """Parse status response → list of completed video dicts."""
        try:
            body = json.loads(response_body)
        except Exception:
            return []

        videos = []

        def _status_of(obj: dict) -> str:
            return str(obj.get("mediaGenerationStatus") or obj.get("status") or "").upper()

        def _is_success(status: str) -> bool:
            return "SUCCESS" in status or "SUCCEEDED" in status

        def _is_failure(status: str) -> bool:
            return "FAILED" in status or "REJECTED" in status or "CANCELLED" in status or "ERROR" in status

        def _collect(obj: Any):
            if isinstance(obj, dict):
                url = obj.get("fifeUrl") or obj.get("downloadUrl") or obj.get("videoUrl") or obj.get("uri")
                status = _status_of(obj)
                if url and _is_success(status):
                    videos.append({
                        "videoUrl": url,
                        "mediaId": obj.get("mediaId") or obj.get("mediaGenerationId") or obj.get("name", ""),
                        "operationName": obj.get("operationName") or obj.get("name", ""),
                    })
                elif status and _is_failure(status):
                    # Log full object (capped at 1000 chars) để debug nguyên nhân fail
                    import json as _json
                    try:
                        obj_str = _json.dumps(obj, ensure_ascii=False)[:1000]
                    except Exception:
                        obj_str = str(obj)[:1000]
                    logger.warning("[VideoStatus] FAILED status=%s | detail=%s", status, obj_str)
                for v in obj.values():
                    _collect(v)
            elif isinstance(obj, list):
                for item in obj:
                    _collect(item)

        _collect(body)

        # Fallback: any fifeUrl regardless of status
        if not videos:
            def _collect_any(obj: Any):
                if isinstance(obj, dict):
                    url = obj.get("fifeUrl") or obj.get("downloadUrl") or obj.get("videoUrl") or obj.get("uri")
                    if url:
                        videos.append({
                            "videoUrl": url,
                            "mediaId": obj.get("mediaId") or obj.get("mediaGenerationId") or obj.get("name", ""),
                            "operationName": obj.get("operationName") or obj.get("name", ""),
                        })
                    for v in obj.values():
                        _collect_any(v)
                elif isinstance(obj, list):
                    for item in obj:
                        _collect_any(item)
            _collect_any(body)

        return videos

    def parse_image_results(self, response_body: str) -> list[dict]:
        """Parse image gen response → list of image dicts."""
        try:
            body = json.loads(response_body)
        except Exception:
            return []

        medias: list[dict] = []

        def _collect(obj: Any):
            if isinstance(obj, dict):
                url = obj.get("downloadUrl") or obj.get("uri") or obj.get("fifeUrl")
                if url:
                    mid = obj.get("mediaId") or obj.get("mediaGenerationId") or obj.get("name", "")
                    logger.info("[Imagen] url_found media_id=%r obj_keys=%s", mid, list(obj.keys()))
                    medias.append({
                        "mediaId": mid,
                        "downloadUrl": url,
                        "mimeType": obj.get("mimeType", "image/jpeg"),
                    })
                for v in obj.values():
                    _collect(v)
            elif isinstance(obj, list):
                for item in obj:
                    _collect(item)

        _collect(body)
        return medias
