"""
FastAPI application factory.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from services.job_store import init_db

BASE_DIR = Path(__file__).parent

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def _setup_logging() -> None:
    root = logging.getLogger()
    if root.handlers:
        return
    import sys

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(name)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    if hasattr(handler.stream, "reconfigure"):
        try:
            handler.stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    root.addHandler(handler)
    root.setLevel(logging.INFO)


CURRENT_VERSION = "1.4.6"

_update_info: dict = {}  # cache kết quả check update


def _check_update() -> dict:
    """Gọi license server lấy version mới nhất. Trả {} nếu lỗi."""
    try:
        import urllib.request, json
        from services.license import LICENSE_SERVER_URL
        url = f"{LICENSE_SERVER_URL}/api/v1/version"
        with urllib.request.urlopen(url, timeout=5) as r:
            data = json.loads(r.read())
        if data.get("version") and data["version"] != CURRENT_VERSION:
            return data
    except Exception:
        pass
    return {}


def create_app() -> FastAPI:
    _setup_logging()
    app = FastAPI(title="Veo3Hao API", version=CURRENT_VERSION, docs_url=None, redoc_url=None, openapi_url=None)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Chrome extension needs wildcard
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------------------------------------------------------------------------
    # Security middleware
    # ---------------------------------------------------------------------------
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse as _JSONResponse
    from services.license import get_runtime_key, is_licensed

    # Paths excluded from all security checks (must always be reachable)
    _PUBLIC_PATHS = {"/", "/api/health", "/api/update-info", "/api/notifications", "/api/license/info", "/api/license/auto-check",
                     "/api/license/validate", "/api/license/set-key", "/api/license/ban-check",
                     "/api/license/clear", "/api/license/shutdown", "/api/extension/poll-job",
                     "/api/extension/submit-job", "/api/extension/submit-browser",
                     "/api/extension/token", "/api/extension/token-for-account",
                     "/api/extension/status"}

    # Paths that need license guard (all /api/* except public + extension)
    _LICENSED_PREFIXES = ("/api/veo", "/api/image", "/api/settings", "/api/workflow",
                          "/api/subtitle", "/api/youtube", "/api/character", "/api/update")

    class SecurityMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            path = request.url.path

            # Always allow static assets and public paths
            if path.startswith(("/static/", "/jobs/", "/characters/", "/studio-images/", "/library-images/")):
                return await call_next(request)
            if path in _PUBLIC_PATHS:
                return await call_next(request)

            # 1. X-App-Token check for all non-public API paths
            if path.startswith("/api/"):
                token = request.headers.get("X-App-Token", "")
                if token != get_runtime_key():
                    return _JSONResponse({"error": "unauthorized"}, status_code=403)

            # 2. License guard for protected prefixes
            if any(path.startswith(p) for p in _LICENSED_PREFIXES):
                if not is_licensed():
                    return _JSONResponse({"error": "license_invalid", "message": "License không hợp lệ hoặc đã hết hạn"}, status_code=403)

            return await call_next(request)

    app.add_middleware(SecurityMiddleware)

    # Static files
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

    # Data file serving
    from services.config_service import DATA_DIR, BASE_DIR as APP_BASE
    app.mount("/jobs", StaticFiles(directory=str(APP_BASE / "data" / "jobs"), html=False), name="jobs")
    app.mount("/characters", StaticFiles(directory=str(APP_BASE / "data" / "characters"), html=False), name="characters")

    @app.on_event("startup")
    async def on_startup():
        global _update_info
        # Auto-validate saved license token
        try:
            from services.license import validate_license
            from services.config_service import load_config
            saved = load_config().get("LICENSE_TOKEN", "").strip()
            if saved:
                validate_license(saved)
        except Exception:
            pass

        # Check for updates in background
        import asyncio
        loop = asyncio.get_event_loop()
        try:
            _update_info = await loop.run_in_executor(None, _check_update)
        except Exception:
            pass

        await init_db()
        from services.character_service import init_characters_table
        from services.library_service import init_library_tables, ensure_default_category
        await init_characters_table()
        await init_library_tables()
        await ensure_default_category()
        # Ensure data dirs exist
        (APP_BASE / "data" / "jobs").mkdir(parents=True, exist_ok=True)
        (APP_BASE / "data" / "characters").mkdir(parents=True, exist_ok=True)
        (APP_BASE / "data" / "library").mkdir(parents=True, exist_ok=True)
        (APP_BASE / "data" / "chrome_userdata").mkdir(parents=True, exist_ok=True)
        (APP_BASE / "data" / "studio").mkdir(parents=True, exist_ok=True)

        # Mount studio-images after startup so the directory exists
        app.mount("/studio-images", StaticFiles(directory=str(APP_BASE / "data" / "studio"), html=False), name="studio-images")
        app.mount("/library-images", StaticFiles(directory=str(APP_BASE / "data" / "library"), html=False), name="library-images")

        # Start auto token refresh background task
        try:
            from services.token_refresh_service import start_auto_refresh
            start_auto_refresh()
        except Exception:
            pass

    # --- Routers ---
    from routers import ui, settings, license_router, veo, image, subtitle, workflow, youtube, character, extension, update

    app.include_router(ui.router)
    app.include_router(settings.router, prefix="/api/settings")
    app.include_router(license_router.router, prefix="/api/license")
    app.include_router(veo.router, prefix="/api/veo")
    app.include_router(image.router, prefix="/api/image")
    app.include_router(subtitle.router, prefix="/api/subtitle")
    app.include_router(workflow.router, prefix="/api/workflow")
    app.include_router(youtube.router, prefix="/api/youtube")
    app.include_router(character.router, prefix="/api/character")
    app.include_router(extension.router, prefix="/api/extension")
    app.include_router(update.router, prefix="/api/update")

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": CURRENT_VERSION}

    @app.get("/api/update-info")
    async def update_info():
        """Frontend poll endpoint — trả về thông tin update nếu có bản mới."""
        if _update_info:
            return {"has_update": True, "current_version": CURRENT_VERSION, **_update_info}
        return {"has_update": False, "current_version": CURRENT_VERSION}

    @app.get("/api/notifications")
    async def get_notifications():
        """Lấy thông báo từ admin server để hiển thị popup khi tool khởi động."""
        try:
            import urllib.request, json
            from services.license import LICENSE_SERVER_URL
            url = f"{LICENSE_SERVER_URL}/api/v1/notifications"
            with urllib.request.urlopen(url, timeout=5) as r:
                data = json.loads(r.read())
            return {"ok": True, "data": data.get("data", [])}
        except Exception:
            return {"ok": True, "data": []}

    return app
