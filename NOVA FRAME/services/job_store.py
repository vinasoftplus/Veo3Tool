"""
SQLite-based async job store.
All jobs (video gen, image gen, subtitle, workflow) tracked here.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from services.config_service import DATA_DIR

DB_PATH = DATA_DIR / "jobs.db"


async def _get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    return db


async def init_db() -> None:
    """Create tables if not exist. Call on app startup."""
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                params_json TEXT NOT NULL DEFAULT '{}',
                outputs_json TEXT NOT NULL DEFAULT '[]',
                error TEXT,
                progress INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type)
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)
        """)
        await db.commit()


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


async def create_job(job_type: str, params: dict) -> str:
    """Create new job, return job_id."""
    job_id = str(uuid.uuid4())
    now = _now_iso()
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(
            """INSERT INTO jobs (id, type, status, params_json, outputs_json, created_at, updated_at)
               VALUES (?, ?, 'queued', ?, '[]', ?, ?)""",
            (job_id, job_type, json.dumps(params, ensure_ascii=False), now, now),
        )
        await db.commit()
    return job_id


async def update_job(
    job_id: str,
    status: str,
    outputs: list[dict] | None = None,
    error: str | None = None,
    progress: int | None = None,
) -> None:
    parts = ["status = ?", "updated_at = ?"]
    vals: list[Any] = [status, _now_iso()]

    if outputs is not None:
        parts.append("outputs_json = ?")
        vals.append(json.dumps(outputs, ensure_ascii=False))
    if error is not None:
        parts.append("error = ?")
        vals.append(error)
    if progress is not None:
        parts.append("progress = ?")
        vals.append(progress)

    vals.append(job_id)
    sql = f"UPDATE jobs SET {', '.join(parts)} WHERE id = ?"
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute(sql, vals)
        await db.commit()


async def get_job(job_id: str) -> dict | None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_dict(row)


async def list_jobs(
    job_type: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    conditions = []
    vals: list[Any] = []
    if job_type:
        conditions.append("type = ?")
        vals.append(job_type)
    if status:
        conditions.append("status = ?")
        vals.append(status)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM jobs {where} ORDER BY created_at DESC LIMIT ? OFFSET ?"
    vals += [limit, offset]

    async with aiosqlite.connect(str(DB_PATH)) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, vals) as cur:
            rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def delete_job(job_id: str) -> None:
    async with aiosqlite.connect(str(DB_PATH)) as db:
        await db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        await db.commit()


def _row_to_dict(row: aiosqlite.Row) -> dict:
    d = dict(row)
    d["params"] = json.loads(d.pop("params_json", "{}") or "{}")
    d["outputs"] = json.loads(d.pop("outputs_json", "[]") or "[]")
    return d
