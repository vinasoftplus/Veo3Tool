"""Node registry — maps node type strings to handler coroutines."""
from __future__ import annotations

from typing import Any, Callable, Awaitable

# Each handler: async (node_config: dict, context: dict) -> dict
NodeHandler = Callable[[dict, dict], Awaitable[dict]]

_REGISTRY: dict[str, NodeHandler] = {}


def register(node_type: str):
    """Decorator to register a node handler."""
    def decorator(fn: NodeHandler) -> NodeHandler:
        _REGISTRY[node_type.lower()] = fn
        return fn
    return decorator


def get_handler(node_type: str) -> NodeHandler | None:
    return _REGISTRY.get(node_type.lower())


# ── Built-in node handlers ────────────────────────────────────────────────────

@register("text_to_video")
async def _node_t2v(cfg: dict, ctx: dict) -> dict:
    from adapters.google_labs import GoogleLabsAdapter
    from services.config_service import get_active_accounts
    accounts = get_active_accounts()
    if not accounts:
        raise RuntimeError("Chưa có account có token")
    account = accounts[ctx.get("account_index", 0) % len(accounts)]
    adapter = GoogleLabsAdapter()
    payload = adapter.build_t2v_payload(
        prompt=cfg.get("prompt", ctx.get("prompt", "")),
        aspect_ratio=cfg.get("aspect_ratio", "16:9"),
        duration=int(cfg.get("duration", 8)),
        account_tier=account.get("tier", "NORMAL"),
    )
    resp = await adapter.generate_video(payload, account)
    ops = adapter.parse_operations(resp)
    if not ops:
        raise RuntimeError("Không có operations")
    op = ops[0]
    # Poll until done
    import asyncio
    for _ in range(60):
        status_resp = await adapter.get_video_status(op["operation_name"], account)
        videos = adapter.parse_video_results(status_resp)
        if videos:
            return {"video_url": videos[0].get("videoUri", ""), "videos": videos, **op}
        if adapter.is_failed(status_resp):
            raise RuntimeError("Video generation failed")
        await asyncio.sleep(5)
    raise RuntimeError("Timeout polling video")


@register("image_to_video")
async def _node_i2v(cfg: dict, ctx: dict) -> dict:
    from adapters.google_labs import GoogleLabsAdapter
    from services.config_service import get_active_accounts
    accounts = get_active_accounts()
    if not accounts:
        raise RuntimeError("Chưa có account có token")
    account = accounts[ctx.get("account_index", 0) % len(accounts)]
    media_id = cfg.get("media_id") or ctx.get("media_id")
    if not media_id:
        raise RuntimeError("Thiếu media_id")
    adapter = GoogleLabsAdapter()
    payload = adapter.build_i2v_payload(
        prompt=cfg.get("prompt", ctx.get("prompt", "")),
        media_id=media_id,
        aspect_ratio=cfg.get("aspect_ratio", "16:9"),
        duration=int(cfg.get("duration", 8)),
        account_tier=account.get("tier", "NORMAL"),
    )
    resp = await adapter.generate_video(payload, account)
    ops = adapter.parse_operations(resp)
    if not ops:
        raise RuntimeError("Không có operations")
    op = ops[0]
    import asyncio
    for _ in range(60):
        status_resp = await adapter.get_video_status(op["operation_name"], account)
        videos = adapter.parse_video_results(status_resp)
        if videos:
            return {"video_url": videos[0].get("videoUri", ""), "videos": videos, **op}
        if adapter.is_failed(status_resp):
            raise RuntimeError("Video generation failed")
        await asyncio.sleep(5)
    raise RuntimeError("Timeout polling video")


@register("generate_image")
async def _node_gen_image(cfg: dict, ctx: dict) -> dict:
    from adapters.google_labs import GoogleLabsAdapter
    from services.config_service import get_active_accounts
    accounts = get_active_accounts()
    if not accounts:
        raise RuntimeError("Chưa có account có token")
    account = accounts[ctx.get("account_index", 0) % len(accounts)]
    adapter = GoogleLabsAdapter()
    payload = adapter.build_image_payload(
        prompt=cfg.get("prompt", ctx.get("prompt", "")),
        model=cfg.get("model", "IMAGEN_3_5"),
        aspect_ratio=cfg.get("aspect_ratio", "1:1"),
        count=int(cfg.get("count", 1)),
        account_tier=account.get("tier", "NORMAL"),
    )
    resp = await adapter.generate_image(payload, account)
    images = adapter.parse_image_results(resp)
    return {"images": images, "first_url": images[0].get("uri", "") if images else ""}


@register("text")
async def _node_text(cfg: dict, ctx: dict) -> dict:
    """Static text node — just passes text through."""
    return {"text": cfg.get("text", cfg.get("content", ""))}


@register("prompt_template")
async def _node_prompt_template(cfg: dict, ctx: dict) -> dict:
    """Fill a prompt template with context values."""
    template = cfg.get("template", "")
    try:
        filled = template.format(**ctx)
    except KeyError:
        filled = template
    return {"prompt": filled}


@register("gemini_rewrite")
async def _node_gemini_rewrite(cfg: dict, ctx: dict) -> dict:
    from adapters.gemini import GeminiAdapter
    from services.config_service import get_gemini_keys
    keys = get_gemini_keys()
    if not keys:
        raise RuntimeError("Chưa có Gemini API key")
    adapter = GeminiAdapter(keys[0])
    text = cfg.get("text") or ctx.get("text") or ctx.get("prompt", "")
    instruction = cfg.get("instruction", "Rewrite to be more creative and detailed.")
    result = await adapter.analyze_text(text, instruction, model=cfg.get("model", "gemini-2.0-flash"))
    return {"text": result, "prompt": result}
