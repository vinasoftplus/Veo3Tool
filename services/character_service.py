"""Character (reference image) management — SQLite-backed."""
from __future__ import annotations

import base64
import uuid
from typing import Any

import aiosqlite

from services.config_service import BASE_DIR
from services.job_store import DB_PATH

CHARACTERS_DIR = BASE_DIR / "data" / "characters"


async def init_characters_table():
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                media_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def save_character(name: str, media_id: str, image_b64: str, ext: str = ".jpg") -> dict[str, Any]:
    """Save a character image locally and persist media_id to DB."""
    CHARACTERS_DIR.mkdir(parents=True, exist_ok=True)
    char_id = uuid.uuid4().hex[:12]
    filename = f"{char_id}{ext}"
    file_path = CHARACTERS_DIR / filename
    file_path.write_bytes(base64.b64decode(image_b64))

    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            "INSERT INTO characters (id, name, media_id, filename) VALUES (?, ?, ?, ?)",
            (char_id, name, media_id, filename),
        )
        await db.commit()

    return {"id": char_id, "name": name, "media_id": media_id, "filename": filename}


async def list_characters() -> list[dict[str, Any]]:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            "SELECT id, name, media_id, filename, created_at FROM characters ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
    return [
        {
            "id": r[0], "name": r[1], "media_id": r[2],
            "filename": r[3], "created_at": r[4],
            "url": f"/characters/{r[3]}",
            "synced": bool(r[2]),
        }
        for r in rows
    ]


async def get_character(char_id: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            "SELECT id, name, media_id, filename, created_at FROM characters WHERE id = ?",
            (char_id,),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0], "name": row[1], "media_id": row[2],
        "filename": row[3], "created_at": row[4],
        "url": f"/characters/{row[3]}",
        "synced": bool(row[2]),
    }


async def update_character_media_id(char_id: str, media_id: str) -> bool:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        cur = await db.execute(
            "UPDATE characters SET media_id = ? WHERE id = ?",
            (media_id, char_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def get_media_ids_for_account(char_ids: list[str], account: dict | None = None) -> list[str]:  # noqa: ARG001
    result = []
    for char_id in char_ids:
        char = await get_character(char_id)
        if char and char.get("media_id"):
            result.append(char["media_id"])
    return result


async def delete_character(char_id: str) -> bool:
    row = await get_character(char_id)
    if not row:
        return False
    try:
        (CHARACTERS_DIR / row["filename"]).unlink(missing_ok=True)
    except Exception:
        pass
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
        await db.commit()
    return True
