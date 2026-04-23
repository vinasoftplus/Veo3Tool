"""
Entry point: start FastAPI backend + PyWebView desktop window.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# Nuitka onefile: __file__ = temp dir, sys.argv[0] = real EXE location
_EXE_DIR = Path(sys.argv[0]).resolve().parent
_LOG_FILE = _EXE_DIR / "logs" / "startup.log"
_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

def _log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    try:
        with open(_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    try:
        sys.stdout.write(line)
        sys.stdout.flush()
    except Exception:
        pass

_log(f"=== App starting === BASE_DIR={BASE_DIR} EXE_DIR={_EXE_DIR}")

# Ensure data directories exist
for _d in ("data/jobs", "data/characters", "data/media_cache", "config", "chrome_user_data", "ffmpeg"):
    (BASE_DIR / _d).mkdir(parents=True, exist_ok=True)

PORT = 8765
HOST = "127.0.0.1"


def kill_port(port: int):
    """Kill bat ky process nao dang giu port - Windows only."""
    try:
        import subprocess
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True, text=True, timeout=5, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = parts[-1]
                if pid.isdigit() and int(pid) != 0:
                    subprocess.run(
                        ["taskkill", "/F", "/PID", pid],
                        capture_output=True, timeout=5, creationflags=0x08000000
                    )
    except Exception:
        pass


def start_api_server():
    try:
        import uvicorn
        from app import create_app
        import app as _app_mod
        _log(f"Starting API server... version={_app_mod.CURRENT_VERSION} path={_app_mod.__file__}")
        app = create_app()
        uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False, log_config=None)
    except Exception:
        import traceback
        _log("API server error:\n" + traceback.format_exc())


def wait_for_server(timeout: float = 15.0):
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((HOST, PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def main():
    _log("main() started")
    # Kill process cu con giu port (neu co)
    kill_port(PORT)
    time.sleep(0.5)  # Cho OS release port

    # Start API in background thread
    server_thread = threading.Thread(target=start_api_server, daemon=True)
    server_thread.start()

    if not wait_for_server():
        _log("ERROR: API server failed to start within 15s")
        sys.exit(1)

    _log("API server ready, launching webview...")
    # Load pythonnet runtime before pywebview imports clr
    try:
        import pythonnet
        pythonnet.load()
        _log("pythonnet loaded OK")
    except Exception as e:
        _log(f"pythonnet load failed: {e}")
    # Start PyWebView window
    import webview
    _log(f"webview platforms winforms test...")
    try:
        import webview.platforms.winforms as _wf
        _log("winforms import OK")
    except Exception as e:
        _log(f"winforms import FAILED: {e}")
    window = webview.create_window(
        title="Dream Forge - Tool tao video AI tu dong",
        url=f"http://{HOST}:{PORT}/",
        width=1440,
        height=900,
        min_size=(1024, 700),
        resizable=True,
    )
    _log("webview.start() called")
    try:
        webview.start(debug=False)
    except Exception:
        import traceback
        _log("webview error:\n" + traceback.format_exc())


if __name__ == "__main__":
    main()
