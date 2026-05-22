from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from services.config_service import BASE_DIR
from services.job_store import DB_PATH

CONSISTENT_CHAR_DIR = BASE_DIR / "data" / "consistent_characters"


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


async def init_consistent_character_tables() -> None:
    CONSISTENT_CHAR_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS consistent_characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                voice_id TEXT NOT NULL,
                voice_name TEXT NOT NULL,
                voice_desc TEXT NOT NULL DEFAULT '',
                images_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS consistent_character_syncs (
                id TEXT PRIMARY KEY,
                character_id TEXT NOT NULL,
                account_index INTEGER NOT NULL,
                project_id TEXT NOT NULL DEFAULT '',
                entity_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'synced',
                error TEXT NOT NULL DEFAULT '',
                synced_at TEXT NOT NULL,
                UNIQUE(character_id, account_index, project_id),
                FOREIGN KEY(character_id) REFERENCES consistent_characters(id) ON DELETE CASCADE
            )
            """
        )
        await db.commit()


def _image_url(filename: str) -> str:
    return f"/consistent-character-images/{filename}"


def _decode_images(raw: str) -> list[dict[str, Any]]:
    import json

    try:
        data = json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _row_to_item(row: tuple[Any, ...], syncs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    images = _decode_images(row[6])
    for image in images:
        image["url"] = _image_url(str(image.get("filename") or ""))
    return {
        "id": row[0],
        "name": row[1],
        "description": row[2] or "",
        "voice_id": row[3],
        "voice_name": row[4],
        "voice_desc": row[5] or "",
        "images": images,
        "created_at": row[7],
        "updated_at": row[8],
        "syncs": syncs or [],
    }


async def create_consistent_character(
    *,
    name: str,
    description: str,
    voice_id: str,
    voice_name: str,
    voice_desc: str,
    images: list[dict[str, Any]],
) -> dict[str, Any]:
    import json

    char_id = uuid.uuid4().hex[:12]
    now = _now_iso()
    safe_name = str(name or "").strip() or "Nhan vat"
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO consistent_characters
                (id, name, description, voice_id, voice_name, voice_desc, images_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                char_id,
                safe_name,
                str(description or "").strip(),
                str(voice_id or "").strip(),
                str(voice_name or "").strip(),
                str(voice_desc or "").strip(),
                json.dumps(images, ensure_ascii=False),
                now,
                now,
            ),
        )
        await db.commit()
    return await get_consistent_character(char_id) or {"id": char_id}


async def list_consistent_characters() -> list[dict[str, Any]]:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT id, name, description, voice_id, voice_name, voice_desc, images_json, created_at, updated_at
            FROM consistent_characters
            ORDER BY created_at DESC
            """
        ) as cur:
            rows = await cur.fetchall()
        async with db.execute(
            """
            SELECT character_id, account_index, project_id, entity_id, status, error, synced_at
            FROM consistent_character_syncs
            ORDER BY account_index ASC
            """
        ) as cur:
            sync_rows = await cur.fetchall()

    by_char: dict[str, list[dict[str, Any]]] = {}
    for r in sync_rows:
        by_char.setdefault(r[0], []).append(
            {
                "account_index": int(r[1] or 0),
                "project_id": r[2] or "",
                "entity_id": r[3] or "",
                "status": r[4] or "",
                "error": r[5] or "",
                "synced_at": r[6] or "",
            }
        )
    return [_row_to_item(row, by_char.get(row[0], [])) for row in rows]


async def get_consistent_character(char_id: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        async with db.execute(
            """
            SELECT id, name, description, voice_id, voice_name, voice_desc, images_json, created_at, updated_at
            FROM consistent_characters
            WHERE id = ?
            """,
            (char_id,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        async with db.execute(
            """
            SELECT character_id, account_index, project_id, entity_id, status, error, synced_at
            FROM consistent_character_syncs
            WHERE character_id = ?
            ORDER BY account_index ASC
            """,
            (char_id,),
        ) as cur:
            sync_rows = await cur.fetchall()
    syncs = [
        {
            "account_index": int(r[1] or 0),
            "project_id": r[2] or "",
            "entity_id": r[3] or "",
            "status": r[4] or "",
            "error": r[5] or "",
            "synced_at": r[6] or "",
        }
        for r in sync_rows
    ]
    return _row_to_item(row, syncs)


async def upsert_consistent_character_sync(
    *,
    character_id: str,
    account_index: int,
    project_id: str,
    entity_id: str,
    status: str,
    error: str = "",
) -> dict[str, Any]:
    now = _now_iso()
    sync_id = uuid.uuid4().hex[:12]
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """
            INSERT INTO consistent_character_syncs
                (id, character_id, account_index, project_id, entity_id, status, error, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(character_id, account_index, project_id) DO UPDATE SET
                entity_id = excluded.entity_id,
                status = excluded.status,
                error = excluded.error,
                synced_at = excluded.synced_at
            """,
            (
                sync_id,
                character_id,
                int(account_index or 0),
                str(project_id or ""),
                str(entity_id or ""),
                str(status or ""),
                str(error or ""),
                now,
            ),
        )
        await db.commit()
    return {
        "character_id": character_id,
        "account_index": int(account_index or 0),
        "project_id": str(project_id or ""),
        "entity_id": str(entity_id or ""),
        "status": str(status or ""),
        "error": str(error or ""),
        "synced_at": now,
    }


async def delete_consistent_character(char_id: str) -> bool:
    item = await get_consistent_character(char_id)
    if not item:
        return False
    for image in item.get("images") or []:
        filename = str(image.get("filename") or "")
        if filename:
            (CONSISTENT_CHAR_DIR / filename).unlink(missing_ok=True)
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("DELETE FROM consistent_character_syncs WHERE character_id = ?", (char_id,))
        await db.execute("DELETE FROM consistent_characters WHERE id = ?", (char_id,))
        await db.commit()
    return True
