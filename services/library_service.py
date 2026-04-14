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
                created_at TEXT NOT NULL,
                FOREIGN KEY(category_id) REFERENCES library_categories(id)
            )
            """
        )
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
) -> dict[str, Any]:
    await ensure_default_category()
    category_id = str(category_id or "default").strip() or "default"
    ext = Path(filename).suffix or ".jpg"
    asset_id = uuid.uuid4().hex[:12]
    stored_name = f"{asset_id}{ext}"
    out_path = LIBRARY_DIR / stored_name
    out_path.write_bytes(image_bytes)

    asset = {
        "id": asset_id,
        "name": Path(filename).stem or stored_name,
        "category_id": category_id,
        "filename": stored_name,
        "prompt": str(prompt or ""),
        "source_type": str(source_type or "image"),
        "origin_url": str(origin_url or ""),
        "created_at": _now_iso(),
    }
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO library_assets (id, name, category_id, filename, prompt, source_type, origin_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset["id"],
                asset["name"],
                asset["category_id"],
                asset["filename"],
                asset["prompt"],
                asset["source_type"],
                asset["origin_url"],
                asset["created_at"],
            ),
        )
        await db.commit()
    return asset


async def list_assets() -> list[dict[str, Any]]:
    await ensure_default_category()
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT a.id, a.name, a.category_id, a.filename, a.prompt, a.source_type, a.origin_url, a.created_at,
                   c.name
            FROM library_assets a
            LEFT JOIN library_categories c ON c.id = a.category_id
            ORDER BY a.created_at DESC
            """
        ) as cur:
            rows = await cur.fetchall()
    return [
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
            "url": f"/library-images/{r[3]}",
        }
        for r in rows
    ]

