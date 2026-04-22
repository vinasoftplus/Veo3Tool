"""UI routes — serve main HTML template."""
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    from services.license import get_runtime_key
    from app import CURRENT_VERSION
    return templates.TemplateResponse(request, "index.html", {
        "app_token": get_runtime_key(),
        "app_version": CURRENT_VERSION,
    })
