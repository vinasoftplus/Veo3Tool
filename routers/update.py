"""Update router — download EXE mới và khởi động updater."""
from __future__ import annotations

import os
import sys
import tempfile
import subprocess
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(tags=["update"])


class UpdateRequest(BaseModel):
    download_url: str
    version: str


def _get_running_exe_path() -> Path | None:
    """
    Return the currently running EXE path if available.
    Works for Nuitka/PyInstaller by preferring sys.argv[0].
    """
    try:
        if sys.argv and sys.argv[0]:
            p = Path(sys.argv[0]).resolve()
            if p.suffix.lower() == ".exe":
                return p
    except Exception:
        pass
    try:
        p = Path(sys.executable).resolve()
        if p.suffix.lower() == ".exe":
            return p
    except Exception:
        pass
    return None


@router.post("/download-and-apply")
async def download_and_apply(req: UpdateRequest):
    """
    1. Download EXE mới vào %TEMP%
    2. Tạo updater.bat
    3. Chạy bat ngầm
    4. Tắt tool hiện tại
    """
    if not req.download_url.startswith("https://"):
        raise HTTPException(400, "URL không hợp lệ")

    # Chỉ cho phép self-update khi chạy bản EXE.
    # Nếu đang chạy source (python main.py), tuyệt đối không đụng file .py.
    running_exe = _get_running_exe_path()
    if not running_exe:
        raise HTTPException(
            400,
            "Đang chạy chế độ dev (main.py). Tắt app và chạy bản EXE để cập nhật tự động.",
        )

    current_exe = str(running_exe)
    tmp_dir = Path(tempfile.gettempdir())
    new_exe = tmp_dir / "DreamForge-latest.exe"
    bat_path = tmp_dir / "df_updater.bat"

    # Download EXE mới
    try:
        urllib.request.urlretrieve(req.download_url, str(new_exe))
    except Exception as e:
        raise HTTPException(500, f"Download thất bại: {e}")

    # Tạo updater.bat
    bat_content = f"""@echo off
timeout /t 2 /nobreak >nul
copy /y "{new_exe}" "{current_exe}"
start "" "{current_exe}"
del "%~f0"
"""
    bat_path.write_text(bat_content, encoding="utf-8")

    # Chạy bat ngầm rồi tắt tool
    subprocess.Popen(
        ["cmd", "/c", str(bat_path)],
        creationflags=0x08000000,  # CREATE_NO_WINDOW
        close_fds=True,
    )

    # Tắt tool sau 1s (cho phép response trả về trước)
    import asyncio
    async def _shutdown():
        await asyncio.sleep(1)
        os._exit(0)
    asyncio.create_task(_shutdown())

    return {"ok": True, "message": "Đang cập nhật..."}
