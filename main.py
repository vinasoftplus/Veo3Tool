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

# Ensure data directories exist
for _d in ("data/jobs", "data/characters", "data/media_cache", "config", "chrome_user_data", "ffmpeg"):
    (BASE_DIR / _d).mkdir(parents=True, exist_ok=True)

PORT = 8765
HOST = "127.0.0.1"


def kill_port(port: int):
    """Kill bất kỳ process nào đang giữ port — Windows only."""
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
    import uvicorn
    from app import create_app
    app = create_app()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning", access_log=False)


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
    # Kill process cũ còn giữ port (nếu có)
    kill_port(PORT)
    time.sleep(0.5)  # Chờ OS release port

    # Start API in background thread
    server_thread = threading.Thread(target=start_api_server, daemon=True)
    server_thread.start()

    if not wait_for_server():
        print("[ERROR] API server failed to start", file=sys.stderr)
        sys.exit(1)

    # Start PyWebView window
    import webview
    window = webview.create_window(
        title="Dream Forge - Tool tạo video AI tự động",
        url=f"http://{HOST}:{PORT}/",
        width=1440,
        height=900,
        min_size=(1024, 700),
        resizable=True,
    )
    webview.start(debug=False)


if __name__ == "__main__":
    main()
