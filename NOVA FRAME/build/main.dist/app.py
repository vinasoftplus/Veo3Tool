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
    handler.setFormatter(logging.Formatter("%(asctime)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    # Force UTF-8 output on Windows
    if hasattr(handler.stream, "reconfigure"):
        try:
            handler.stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    root.setLevel(logging.INFO)
    root.addHandler(handler)


def create_app() -> FastAPI:
    _setup_logging()
    app = FastAPI(title="Veo3Hao API", version="1.0.0", docs_url="/docs")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Chrome extension needs wildcard
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Static files
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

    # Data file serving
    from services.config_service import DATA_DIR, BASE_DIR as APP_BASE
    app.mount("/jobs", StaticFiles(directory=str(APP_BASE / "data" / "jobs"), html=False), name="jobs")
    app.mount("/characters", StaticFiles(directory=str(APP_BASE / "data" / "characters"), html=False), name="characters")

    @app.on_event("startup")
    async def on_startup():
        # Auto-validate saved license token
        try:
            from services.license import validate_license
            from services.config_service import load_config
            saved = load_config().get("LICENSE_TOKEN", "").strip()
            if saved:
                validate_license(saved)
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

    # --- Routers ---
    from routers import ui, settings, license_router, veo, image, subtitle, workflow, youtube, character, extension

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

    @app.get("/api/health")
    async def health():
        return {"ok": True, "version": "1.0.0"}

    return app
