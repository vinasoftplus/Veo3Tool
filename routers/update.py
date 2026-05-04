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
    current_dir = str(running_exe.parent)
    current_pid = os.getpid()
    tmp_dir = Path(tempfile.gettempdir())
    new_exe = tmp_dir / f"DreamForge-update-{current_pid}.exe"
    bat_path = tmp_dir / f"df_updater_{current_pid}.bat"
    log_path = tmp_dir / f"df_updater_{current_pid}.log"

    # Download EXE mới
    try:
        urllib.request.urlretrieve(req.download_url, str(new_exe))
    except Exception as e:
        raise HTTPException(500, f"Download thất bại: {e}")
    if not new_exe.exists() or new_exe.stat().st_size <= 0:
        raise HTTPException(500, "Download failed: empty update file")

    # Tạo updater.bat
    bat_content = f"""@echo off
setlocal EnableExtensions
set "NEW_EXE={new_exe}"
set "CURRENT_EXE={current_exe}"
set "CURRENT_DIR={current_dir}"
set "LOG_FILE={log_path}"
set "OLD_PID={current_pid}"

echo [%date% %time%] updater started > "%LOG_FILE%"
echo NEW_EXE=%NEW_EXE% >> "%LOG_FILE%"
echo CURRENT_EXE=%CURRENT_EXE% >> "%LOG_FILE%"
echo CURRENT_DIR=%CURRENT_DIR% >> "%LOG_FILE%"
echo OLD_PID=%OLD_PID% >> "%LOG_FILE%"

if not exist "%NEW_EXE%" (
  echo [%date% %time%] missing downloaded exe >> "%LOG_FILE%"
  exit /b 1
)

set /a WAIT_COUNT=0
:wait_old_process
tasklist /FI "PID eq %OLD_PID%" 2>nul | find "%OLD_PID%" >nul
if errorlevel 1 goto copy_retry
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GEQ 30 (
  echo [%date% %time%] old process still running, forcing shutdown >> "%LOG_FILE%"
  taskkill /PID %OLD_PID% /F >> "%LOG_FILE%" 2>&1
  timeout /t 2 /nobreak >nul
  goto copy_retry
)
timeout /t 1 /nobreak >nul
goto wait_old_process

:copy_retry
set /a COPY_COUNT=0
:copy_loop
set /a COPY_COUNT+=1
echo [%date% %time%] copy attempt %COPY_COUNT% >> "%LOG_FILE%"
copy /y "%NEW_EXE%" "%CURRENT_EXE%" >> "%LOG_FILE%" 2>&1
if not errorlevel 1 if exist "%CURRENT_EXE%" goto start_app
if %COPY_COUNT% GEQ 60 goto fail
timeout /t 1 /nobreak >nul
goto copy_loop

:start_app
echo [%date% %time%] starting app >> "%LOG_FILE%"
start "" /D "%CURRENT_DIR%" "%CURRENT_EXE%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto fail
echo [%date% %time%] update success >> "%LOG_FILE%"
del "%NEW_EXE%" >nul 2>&1
del "%~f0"
exit /b 0

:fail
echo [%date% %time%] update failed >> "%LOG_FILE%"
exit /b 1
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
