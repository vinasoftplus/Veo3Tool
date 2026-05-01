"""
Auto Token Refresh Service
- Chạy background task mỗi 45 phút, tự refresh token từ cookie cho mọi account có COOKIE
- Cung cấp hàm refresh_account_token() để gọi on-demand khi nhận 401
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from services.config_service import get_all_accounts, load_config, save_account

logger = logging.getLogger("token_refresh")

REFRESH_INTERVAL = 45 * 60  # 45 phút
_refresh_task: asyncio.Task | None = None


def _now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%H:%M:%S")


async def refresh_account_token(account_index: int) -> bool:
    """
    Refresh token cho 1 account (1-based index) từ cookie đã lưu.
    Trả về True nếu thành công.
    """
    from services.cookie_token_service import get_token_from_cookie

    cfg = load_config()
    acc = cfg.get(f"account{account_index}", {})
    cookie = acc.get("COOKIE", "").strip()
    if not cookie:
        return False

    try:
        logger.info("[AutoRefresh] Refreshing token account #%s...", account_index)
        result = await get_token_from_cookie(cookie)
        current = dict(acc)
        current["ACCESS_TOKEN"] = result["access_token"]
        if result.get("email"):
            current["EMAIL"] = result["email"]
        if result.get("project_id"):
            current["PROJECT_ID"] = result["project_id"]
        save_account(account_index, current)
        logger.info(
            "[AutoRefresh] ✅ Account #%s token refreshed at %s | %s",
            account_index,
            _now(),
            result["access_token"][:20] + "...",
        )
        return True
    except Exception as e:
        logger.warning("[AutoRefresh] ❌ Account #%s refresh failed: %s", account_index, e)
        return False


async def refresh_all_accounts() -> dict[int, bool]:
    """Refresh token cho tất cả account có COOKIE."""
    accounts = get_all_accounts()
    results: dict[int, bool] = {}
    for acc in accounts:
        idx = acc.get("_index")
        if not idx:
            continue
        if not acc.get("COOKIE", "").strip():
            continue  # Bỏ qua account không có cookie
        results[idx] = await refresh_account_token(idx)
        # Delay nhỏ giữa các account để tránh burst
        if len(accounts) > 1:
            await asyncio.sleep(3)
    return results


async def _refresh_loop():
    """Background loop: chờ 45 phút rồi refresh."""
    logger.info("[AutoRefresh] Background token refresh started (interval=%ds)", REFRESH_INTERVAL)
    # Refresh ngay lúc startup
    await asyncio.sleep(5)  # Chờ server fully ready
    await refresh_all_accounts()

    while True:
        await asyncio.sleep(REFRESH_INTERVAL)
        logger.info("[AutoRefresh] ⏰ Scheduled refresh triggered at %s", _now())
        await refresh_all_accounts()


def start_auto_refresh():
    """Gọi từ app startup để bắt đầu background task."""
    global _refresh_task
    if _refresh_task and not _refresh_task.done():
        return  # Đã chạy rồi
    _refresh_task = asyncio.create_task(_refresh_loop())
    logger.info("[AutoRefresh] Task created")


async def on_api_401(account_index: int) -> bool:
    """Gọi khi API trả về 401 — thử refresh token ngay lập tức."""
    logger.warning("[AutoRefresh] 401 detected for account #%s — refreshing now...", account_index)
    return await refresh_account_token(account_index)


async def on_api_403(account_index: int) -> bool:
    """403 often means reCAPTCHA/unusual activity, not an expired token."""
    logger.warning("[AutoRefresh] 403 detected for account #%s - skip automatic token refresh", account_index)
    return False
