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
    "ULTRA": "veo_3_1_r2v_fast_portrait_ultra",
    "NORMAL": "veo_3_1_r2v_fast_portrait",
    "PRO": "veo_3_1_r2v_fast_portrait",
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
        if normalized == "flow_fast_relaxed":
            return "veo_3_1_r2v_fast_portrait_ultra_relaxed" if acc_type == "ULTRA" else _REF_MODEL_KEYS.get("NORMAL", "veo_3_1_r2v_fast_portrait")
        if normalized == "flow_fast_no_ultra":
            return _REF_MODEL_KEYS.get("NORMAL", "veo_3_1_r2v_fast_portrait")
        if normalized in ("flow_fast", "flow_quality"):
            return _REF_MODEL_KEYS.get(acc_type, _REF_MODEL_KEYS.get("NORMAL", "veo_3_1_r2v_fast_portrait"))
        if normalized.startswith("veo_"):
            return model
        return _REF_MODEL_KEYS.get(acc_type, "veo_3_1_r2v_fast_portrait_ultra")

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
    return await asyncio.to_thread(_send_request, url, payload, token, cookie)


# ---------------------------------------------------------------------------
# Adapter class
# ---------------------------------------------------------------------------

class GoogleLabsAdapter:

    def build_text_to_video_payload(
        self,
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("t2v", account, aspect_ratio, model)
        eff_seed = seed if seed is not None else _random_seed()

        request_item = {
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
            "requests": [dict(request_item) for _ in range(max(1, output_count))],
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

        request_item = {
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
            "requests": [dict(request_item) for _ in range(max(1, output_count))],
        }

    # --- Upload image ---
    async def upload_image(self, base64_image: str, mime_type: str, account: dict) -> dict:
        payload = {
            "imageInput": {
                "rawImageBytes": base64_image,
                "mimeType": mime_type,
                "isUserUploaded": True,
                "aspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            },
            "clientContext": {
                "sessionId": str(uuid.uuid4()),
                "tool": "ASSET_MANAGER",
            },
        }
        return await _async_send(URL_UPLOAD, payload, _token(account), _cookie(account))

    def parse_upload_media_id(self, response_body: str) -> str | None:
        try:
            body = json.loads(response_body)
            # Try multiple paths
            for key in ("mediaId", "mediaGenerationId", "name"):
                val = body.get(key)
                if val:
                    return str(val)
            # Nested
            for v in body.values():
                if isinstance(v, dict):
                    for key in ("mediaId", "mediaGenerationId", "name"):
                        val = v.get(key)
                        if val:
                            return str(val)
        except Exception:
            pass
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
        request_item: dict[str, Any] = {
            "aspectRatio": aspect_ratio,
            "seed": _random_seed(),
            "videoModelKey": model_key,
            "startImage": {"mediaId": start_media_id},
            "metadata": {"sceneId": str(uuid.uuid4())},
        }
        if end_media_id:
            request_item["endImage"] = {"mediaId": end_media_id}
            request_item["textInput"] = {"structuredPrompt": {"parts": [{"text": prompt}]}}
        else:
            request_item["textInput"] = {"prompt": prompt}
        return {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [dict(request_item) for _ in range(max(1, output_count))],
        }

    def build_reference_video_payload(
        self,
        reference_media_ids: list[str],
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("r2v", account, aspect_ratio, model)
        refs = [
            {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
            for mid in reference_media_ids[:3] if mid
        ]
        if not refs:
            return {}
        request_item = {
            "aspectRatio": aspect_ratio,
            "seed": seed if seed is not None else _random_seed(),
            "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
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
            "requests": [json.loads(json.dumps(request_item)) for _ in range(max(1, output_count))],
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

        request_item: dict[str, Any] = {
            "aspectRatio": aspect_ratio,
            "seed": _random_seed(),
            "videoModelKey": model_key,
            "startImage": {"mediaId": start_media_id},
            "metadata": {"sceneId": str(uuid.uuid4())},
        }
        if end_media_id:
            request_item["endImage"] = {"mediaId": end_media_id}
            request_item["textInput"] = {
                "structuredPrompt": {"parts": [{"text": prompt}]}
            }
        else:
            request_item["textInput"] = {"prompt": prompt}

        url = URL_STARTEND if end_media_id else URL_I2V
        payload = {
            "clientContext": {
                "recaptchaContext": {"token": recaptcha_token},
                "sessionId": str(uuid.uuid4()),
                "projectId": _project_id(account),
                "tool": "PINHOLE",
                "userPaygateTier": _paygate(account),
            },
            "requests": [dict(request_item) for _ in range(max(1, output_count))],
        }
        return await _async_send(url, payload, _token(account), _cookie(account))

    # --- Reference / Consistent Video ---
    async def reference_video(
        self,
        reference_media_ids: list[str],
        prompt: str,
        account: dict,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        output_count: int = 1,
        model: str = "auto",
        seed: int | None = None,
        recaptcha_token: str = "",
    ) -> dict:
        model_key = _resolve_video_model_key("r2v", account, aspect_ratio, model)
        refs = [
            {"mediaId": mid, "imageUsageType": "IMAGE_USAGE_TYPE_ASSET"}
            for mid in reference_media_ids[:3]
            if mid
        ]
        if not refs:
            return {"ok": False, "status": 0, "body": "No reference media IDs"}

        request_item = {
            "aspectRatio": aspect_ratio,
            "seed": seed if seed is not None else _random_seed(),
            "textInput": {"structuredPrompt": {"parts": [{"text": prompt}]}},
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
            "requests": [json.loads(json.dumps(request_item)) for _ in range(max(1, output_count))],
        }
        return await _async_send(URL_REF_VIDEO, payload, _token(account), _cookie(account))

    # --- Check video status ---
    async def check_video_status(self, operations: list[dict], token: str) -> dict:
        payload = {"operations": operations}
        return await _async_send(URL_STATUS, payload, token)

    # --- Upscale video ---
    async def upscale_video(self, operation_name: str, token: str) -> dict:
        candidate_payloads = [
            {"operationName": operation_name},
            {"name": operation_name},
            {"operation": {"name": operation_name}},
            {"videoOperationName": operation_name},
            {"operationNames": [operation_name]},
            {"operations": [{"operation": {"name": operation_name}}]},
        ]

        last_result = {"ok": False, "status": 0, "body": "No payload attempted"}
        for payload in candidate_payloads:
            result = await _async_send(URL_UPSCALE_VIDEO, payload, token)
            last_result = result
            body = str(result.get("body", "") or "")
            if result.get("ok"):
                return result
            if result.get("status") != 400:
                return result
            if "Unknown name" not in body and "Invalid JSON payload received" not in body:
                return result

        return last_result

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
        model_key = _IMG_MODEL_MAP.get(model, "IMAGEN_3_5")
        eff_seed = seed if seed is not None else _random_seed()

        def make_request(i: int) -> dict:
            s = (eff_seed + i) % 294967296 if i > 0 and seed is not None else (_random_seed() if i > 0 else eff_seed)
            ctx = {
                "recaptchaContext": {"token": recaptcha_token, "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB"},
                "sessionId": str(uuid.uuid4()),
                "projectId": project_id,
                "tool": "PINHOLE",
            }
            return {
                "clientContext": ctx,
                "imageAspectRatio": aspect_ratio,
                "seed": s,
                "imageModelName": model_key,
                "prompt": prompt,
                "imageInputs": [],
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
    async def upscale_image(self, media_id: str, token: str) -> dict:
        payload = {"mediaId": media_id}
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
        ops = body.get("operations", [])
        results = []
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

        def _collect(obj: Any):
            if isinstance(obj, dict):
                url = obj.get("fifeUrl") or obj.get("downloadUrl") or obj.get("videoUrl") or obj.get("uri")
                status = str(obj.get("mediaGenerationStatus", "")).upper()
                if url and "SUCCEEDED" in status:
                    videos.append({
                        "videoUrl": url,
                        "mediaId": obj.get("mediaId") or obj.get("mediaGenerationId") or obj.get("name", ""),
                        "operationName": obj.get("operationName") or obj.get("name", ""),
                    })
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
                    url = obj.get("fifeUrl") or obj.get("downloadUrl")
                    if url:
                        videos.append({"videoUrl": url, "mediaId": ""})
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
                    medias.append({
                        "mediaId": obj.get("mediaId") or obj.get("mediaGenerationId") or obj.get("name", ""),
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
