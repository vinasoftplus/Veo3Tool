from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from services.config_service import BASE_DIR
from services.job_store import DB_PATH

LIBRARY_DIR = BASE_DIR / "data" / "library"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


async def init_library_tables() -> None:
    LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS library_categories (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS library_assets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category_id TEXT,
                filename TEXT NOT NULL,
                prompt TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT 'image',
                origin_url TEXT NOT NULL DEFAULT '',
                asset_type TEXT NOT NULL DEFAULT 'nhanvat',
                created_at TEXT NOT NULL,
                FOREIGN KEY(category_id) REFERENCES library_categories(id)
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS library_asset_syncs (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                account_index INTEGER NOT NULL,
                project_id TEXT NOT NULL DEFAULT '',
                media_id TEXT NOT NULL DEFAULT '',
                flow_handle TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'synced',
                error TEXT NOT NULL DEFAULT '',
                synced_at TEXT NOT NULL,
                UNIQUE(asset_id, account_index, project_id),
                FOREIGN KEY(asset_id) REFERENCES library_assets(id) ON DELETE CASCADE
            )
            """
        )
        # Migration: add columns if not exists
        for migration in [
            "ALTER TABLE library_assets ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'nhanvat'",
            "ALTER TABLE library_assets ADD COLUMN media_id TEXT NOT NULL DEFAULT ''",
        ]:
            try:
                await db.execute(migration)
            except Exception:
                pass
        await db.commit()


async def ensure_default_category() -> None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute("SELECT id FROM library_categories ORDER BY created_at ASC LIMIT 1") as cur:
            row = await cur.fetchone()
        if row:
            return
        await db.execute(
            "INSERT INTO library_categories (id, name, created_at) VALUES (?, ?, ?)",
            ("default", "Mặc định", _now_iso()),
        )
        await db.commit()


async def list_categories() -> list[dict[str, Any]]:
    await ensure_default_category()
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            "SELECT id, name, created_at FROM library_categories ORDER BY created_at ASC"
        ) as cur:
            rows = await cur.fetchall()
    return [{"id": r[0], "name": r[1], "created_at": r[2]} for r in rows]


async def create_category(name: str) -> dict[str, Any]:
    safe_name = str(name or "").strip()
    if not safe_name:
        raise ValueError("Tên danh mục không được trống")
    category = {"id": uuid.uuid4().hex[:12], "name": safe_name, "created_at": _now_iso()}
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            "INSERT INTO library_categories (id, name, created_at) VALUES (?, ?, ?)",
            (category["id"], category["name"], category["created_at"]),
        )
        await db.commit()
    return category


async def save_library_asset(
    *,
    image_bytes: bytes,
    filename: str,
    prompt: str = "",
    category_id: str | None = None,
    source_type: str = "image",
    origin_url: str = "",
    asset_type: str = "nhanvat",
    media_id: str = "",
) -> dict[str, Any]:
    await ensure_default_category()
    category_id = str(category_id or "default").strip() or "default"
    ext = Path(filename).suffix or ".jpg"
    asset_id = uuid.uuid4().hex[:12]
    stored_name = f"{asset_id}{ext}"
    out_path = LIBRARY_DIR / stored_name
    out_path.write_bytes(image_bytes)

    valid_types = {"nhanvat", "vatpham", "style", "background"}
    safe_type = asset_type if asset_type in valid_types else "nhanvat"

    asset = {
        "id": asset_id,
        "name": Path(filename).stem or stored_name,
        "category_id": category_id,
        "filename": stored_name,
        "prompt": str(prompt or ""),
        "source_type": str(source_type or "image"),
        "origin_url": str(origin_url or ""),
        "asset_type": safe_type,
        "media_id": str(media_id or ""),
        "created_at": _now_iso(),
    }
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO library_assets (id, name, category_id, filename, prompt, source_type, origin_url, asset_type, media_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset["id"],
                asset["name"],
                asset["category_id"],
                asset["filename"],
                asset["prompt"],
                asset["source_type"],
                asset["origin_url"],
                asset["asset_type"],
                asset["media_id"],
                asset["created_at"],
            ),
        )
        await db.commit()
    return asset


async def delete_category(category_id: str) -> None:
    if category_id == "default":
        raise ValueError("Không thể xóa nhóm mặc định")
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM library_assets WHERE category_id = ?", (category_id,)
        ) as cur:
            row = await cur.fetchone()
        if row and row[0] > 0:
            raise ValueError("Nhóm còn ảnh, hãy xóa hết ảnh trước khi xóa nhóm")
        result = await db.execute("DELETE FROM library_categories WHERE id = ?", (category_id,))
        if result.rowcount == 0:
            raise ValueError("Không tìm thấy nhóm")
        await db.commit()


async def delete_asset(asset_id: str) -> bool:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute("SELECT filename FROM library_assets WHERE id = ?", (asset_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        filename = row[0]
        await db.execute("DELETE FROM library_asset_syncs WHERE asset_id = ?", (asset_id,))
        await db.execute("DELETE FROM library_assets WHERE id = ?", (asset_id,))
        await db.commit()
    file_path = LIBRARY_DIR / filename
    if file_path.exists():
        file_path.unlink(missing_ok=True)
    return True


async def list_assets() -> list[dict[str, Any]]:
    await ensure_default_category()
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT a.id, a.name, a.category_id, a.filename, a.prompt, a.source_type, a.origin_url, a.created_at,
                   c.name, a.asset_type, COALESCE(a.media_id, '')
            FROM library_assets a
            LEFT JOIN library_categories c ON c.id = a.category_id
            ORDER BY a.created_at DESC
            """
        ) as cur:
            rows = await cur.fetchall()
    assets = [
        {
            "id": r[0],
            "name": r[1],
            "category_id": r[2],
            "filename": r[3],
            "prompt": r[4],
            "source_type": r[5],
            "origin_url": r[6],
            "created_at": r[7],
            "category_name": r[8] or "Mặc định",
            "asset_type": r[9] or "nhanvat",
            "media_id": r[10] or "",
            "url": f"/library-images/{r[3]}",
        }
        for r in rows
    ]
    if not assets:
        return assets

    ids = [a["id"] for a in assets]
    placeholders = ",".join("?" * len(ids))
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            f"""
            SELECT asset_id, account_index, project_id, media_id, flow_handle, status, error, synced_at
            FROM library_asset_syncs
            WHERE asset_id IN ({placeholders})
            ORDER BY account_index ASC
            """,
            ids,
        ) as cur:
            sync_rows = await cur.fetchall()
    by_asset: dict[str, list[dict[str, Any]]] = {a["id"]: [] for a in assets}
    for r in sync_rows:
        by_asset.setdefault(r[0], []).append(
            {
                "account_index": int(r[1] or 0),
                "project_id": r[2] or "",
                "media_id": r[3] or "",
                "flow_handle": r[4] or "",
                "status": r[5] or "",
                "error": r[6] or "",
                "synced_at": r[7] or "",
            }
        )
    for asset in assets:
        asset["syncs"] = by_asset.get(asset["id"], [])
    return assets


async def get_asset(asset_id: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT id, name, category_id, filename, prompt, source_type, origin_url, asset_type,
                   COALESCE(media_id, ''), created_at
            FROM library_assets
            WHERE id = ?
            """,
            (asset_id,),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "category_id": row[2],
        "filename": row[3],
        "prompt": row[4],
        "source_type": row[5],
        "origin_url": row[6],
        "asset_type": row[7] or "nhanvat",
        "media_id": row[8] or "",
        "created_at": row[9],
        "url": f"/library-images/{row[3]}",
        "path": LIBRARY_DIR / row[3],
    }


async def list_asset_syncs(asset_id: str) -> list[dict[str, Any]]:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT asset_id, account_index, project_id, media_id, flow_handle, status, error, synced_at
            FROM library_asset_syncs
            WHERE asset_id = ?
            ORDER BY account_index ASC
            """,
            (asset_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "asset_id": r[0],
            "account_index": int(r[1] or 0),
            "project_id": r[2] or "",
            "media_id": r[3] or "",
            "flow_handle": r[4] or "",
            "status": r[5] or "",
            "error": r[6] or "",
            "synced_at": r[7] or "",
        }
        for r in rows
    ]


async def delete_invalid_asset_syncs() -> int:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        result = await db.execute(
            """
            DELETE FROM library_asset_syncs
            WHERE TRIM(media_id) LIKE '{%'
               OR TRIM(media_id) LIKE '[%'
               OR media_id LIKE '%mediaGenerationId%'
               OR LENGTH(TRIM(media_id)) != 36
               OR SUBSTR(TRIM(media_id), 9, 1) != '-'
               OR SUBSTR(TRIM(media_id), 14, 1) != '-'
               OR SUBSTR(TRIM(media_id), 19, 1) != '-'
               OR SUBSTR(TRIM(media_id), 24, 1) != '-'
            """
        )
        await db.commit()
    return int(result.rowcount or 0)


async def upsert_asset_sync(
    *,
    asset_id: str,
    account_index: int,
    project_id: str,
    media_id: str,
    flow_handle: str,
    status: str = "synced",
    error: str = "",
) -> dict[str, Any]:
    now = _now_iso()
    sync_id = uuid.uuid4().hex[:12]
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO library_asset_syncs
                (id, asset_id, account_index, project_id, media_id, flow_handle, status, error, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset_id, account_index, project_id) DO UPDATE SET
                media_id = excluded.media_id,
                flow_handle = excluded.flow_handle,
                status = excluded.status,
                error = excluded.error,
                synced_at = excluded.synced_at
            """,
            (
                sync_id,
                asset_id,
                int(account_index or 0),
                str(project_id or ""),
                str(media_id or ""),
                str(flow_handle or ""),
                str(status or ""),
                str(error or ""),
                now,
            ),
        )
        await db.commit()
    return {
        "asset_id": asset_id,
        "account_index": int(account_index or 0),
        "project_id": str(project_id or ""),
        "media_id": str(media_id or ""),
        "flow_handle": str(flow_handle or ""),
        "status": str(status or ""),
        "error": str(error or ""),
        "synced_at": now,
    }


async def rename_asset(asset_id: str, new_name: str) -> bool:
    safe = str(new_name or "").strip()
    if not safe:
        raise ValueError("Tên không được trống")
    async with aiosqlite.connect(str(DB_PATH)) as db:
        result = await db.execute("UPDATE library_assets SET name = ? WHERE id = ?", (safe, asset_id))
        await db.commit()
    return result.rowcount > 0


async def move_assets(asset_ids: list[str], target_category_id: str) -> int:
    if not asset_ids:
        return 0
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute("SELECT id FROM library_categories WHERE id = ?", (target_category_id,)) as cur:
            if not await cur.fetchone():
                raise ValueError("Nhóm đích không tồn tại")
        placeholders = ",".join("?" * len(asset_ids))
        result = await db.execute(
            f"UPDATE library_assets SET category_id = ? WHERE id IN ({placeholders})",
            [target_category_id] + list(asset_ids),
        )
        await db.commit()
    return result.rowcount


async def rename_category(category_id: str, new_name: str) -> bool:
    safe = str(new_name or "").strip()
    if not safe:
        raise ValueError("Tên nhóm không được trống")
    async with aiosqlite.connect(str(DB_PATH)) as db:
        result = await db.execute("UPDATE library_categories SET name = ? WHERE id = ?", (safe, category_id))
        await db.commit()
    return result.rowcount > 0
