"""Cinematic planning and export. No provider calls happen in this module."""
from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path
from threading import RLock
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

router = APIRouter(tags=["cinematic"])
_lock = RLock()
PRESETS = {
    "cinema": "Live-action cinematic realism; ARRI Alexa 35 / Sony Venice 2 look; 28mm spherical, f/2.8, motivated practical lighting, gentle haze, natural skin texture, restrained orange/teal grade. No CGI look.",
    "vietnam_1990s": "Vietnam in the 1990s; authentic period clothing, architecture and props; warm amber practical lights, muted cyan shadows, subtle analog film grain; realistic Vietnamese drama. No modern phones or contemporary signage.",
    "nostalgic_mv": "Romantic late-1980s / 1990s music-video atmosphere; amber and cyan lighting, soft halation, restrained analog grain, expressive close-ups, emotionally grounded live-action realism.",
}


class Character(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    identity: str = Field(default="", max_length=8000)
    wardrobe: str = Field(default="", max_length=4000)
    reference: str = Field(default="", max_length=2000)


class Scene(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    title: str = Field(default="Untitled scene", max_length=200)
    description: str = Field(default="", max_length=12000)
    duration: float = Field(default=8, gt=0, le=600)
    timing: Literal["draft", "verified"] = "draft"
    characters: list[str] = Field(default_factory=list, max_length=50)
    location: str = Field(default="", max_length=2000)
    camera: str = Field(default="Slow, steady push-in", max_length=2000)
    continuity: str = Field(default="", max_length=4000)
    image_prompt: str = Field(default="", max_length=20000)
    video_prompt: str = Field(default="", max_length=20000)
    media_id: str = Field(default="", max_length=2000)
    image_asset: str = Field(default="", max_length=2000)
    video_asset: str = Field(default="", max_length=2000)


class Project(BaseModel):
    title: str = Field(default="My cinematic project", min_length=1, max_length=200)
    kind: Literal["music_video", "short_film"] = "music_video"
    aspect_ratio: Literal["16:9", "9:16"] = "16:9"
    preset: Literal["cinema", "vietnam_1990s", "nostalgic_mv"] = "cinema"
    script: str = Field(default="", max_length=200000)
    continuity: str = Field(default="", max_length=8000)
    characters: list[Character] = Field(default_factory=list, max_length=50)
    scenes: list[Scene] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_ids(self):
        ids = [c.id for c in self.characters]
        if len(ids) != len(set(ids)):
            raise ValueError("Character IDs must be unique")
        scene_ids = [s.id for s in self.scenes]
        if len(scene_ids) != len(set(scene_ids)):
            raise ValueError("Scene IDs must be unique")
        for scene in self.scenes:
            if not set(scene.characters).issubset(ids):
                raise ValueError("Scene references an unknown character ID")
        return self


def project_dir() -> Path:
    from services.config_service import DATA_DIR
    root = DATA_DIR / "cinematic_projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_path(project_id: UUID) -> Path:
    return project_dir() / f"{project_id}.json"


def read_project(project_id: UUID) -> Project:
    path = project_path(project_id)
    if not path.exists():
        raise HTTPException(404, "Project not found")
    return Project.model_validate_json(path.read_text(encoding="utf-8"))


def write_project(project_id: UUID, project: Project) -> None:
    path = project_path(project_id)
    temporary = path.with_suffix(".tmp")
    with _lock:
        temporary.write_text(project.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, path)


def prompts(project: Project, scene: Scene) -> tuple[str, str]:
    cast = []
    for character in project.characters:
        if character.id in scene.characters:
            cast.append(f"{character.name}: {character.identity}. Wardrobe: {character.wardrobe}.")
    shared = "\n".join(filter(None, [PRESETS[project.preset], f"Aspect ratio: {project.aspect_ratio}.",
        "Preserve apparent age, facial proportions and natural skin; no beautification or face reshaping.",
        *cast, project.continuity, scene.continuity]))
    image = scene.image_prompt.strip() or f"{shared}\nScene: {scene.description}\nLocation: {scene.location}.\nComposition: {scene.camera}. No text overlay."
    video = scene.video_prompt.strip() or f"{shared}\nAction: {scene.description}\nLocation: {scene.location}.\nCamera motion: {scene.camera}. Natural movement and motion blur; preserve wardrobe, props, geography and screen direction. No cuts or unrequested dialogue."
    return image, video


@router.get("/presets")
def presets():
    return PRESETS


@router.get("/projects")
def list_projects():
    result = []
    for path in sorted(project_dir().glob("*.json")):
        try:
            UUID(path.stem)
            project = Project.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        result.append({"id": path.stem, "title": project.title, "scenes": len(project.scenes)})
    return result


@router.post("/projects")
def create_project(project: Project):
    project_id = uuid4()
    write_project(project_id, project)
    return {"id": str(project_id), "project": project.model_dump()}


@router.get("/projects/{project_id}")
def get_project(project_id: UUID):
    return {"id": str(project_id), "project": read_project(project_id).model_dump()}


@router.put("/projects/{project_id}")
def update_project(project_id: UUID, project: Project):
    with _lock:
        read_project(project_id)
        write_project(project_id, project)
    return {"id": str(project_id), "project": project.model_dump()}


@router.get("/projects/{project_id}/export/{format}")
def export_project(project_id: UUID, format: Literal["json", "csv", "prompts"]):
    project = read_project(project_id)
    if format == "json":
        content, media, extension = project.model_dump_json(indent=2), "application/json", "json"
    elif format == "csv":
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer)
        writer.writerow(["scene", "title", "start_seconds", "duration", "timing", "image_prompt", "video_prompt", "image_asset", "video_asset"])
        start = 0.0
        for i, scene in enumerate(project.scenes, 1):
            image, video = prompts(project, scene)
            row = [f"SC{i:03}", scene.title, start, scene.duration, scene.timing, image, video, scene.image_asset, scene.video_asset]
            # Prevent spreadsheet formulas when user-authored text is opened in Excel.
            writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v for v in row])
            start += scene.duration
        content, media, extension = "\ufeff" + buffer.getvalue(), "text/csv", "csv"
    else:
        lines = [f"# {project.title}", "", "Timing is planned unless individually marked verified. References are planning notes; generation requires uploaded provider media IDs."]
        for i, scene in enumerate(project.scenes, 1):
            image, video = prompts(project, scene)
            lines.extend(["", f"## SC{i:03} — {scene.title} ({scene.duration}s; {scene.timing})", "", "### Image", image, "", "### Video", video])
        content, media, extension = "\n".join(lines), "text/markdown", "md"
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="cinematic-{project_id}.{extension}"'})


class GraphRequest(BaseModel):
    stage: Literal["image", "text_to_video", "image_to_video"]
    scene_ids: list[str] = Field(min_length=1, max_length=500)


@router.post("/projects/{project_id}/graph")
def compile_graph(project_id: UUID, request: GraphRequest):
    project = read_project(project_id)
    selected = set(request.scene_ids)
    if not selected.issubset({s.id for s in project.scenes}):
        raise HTTPException(422, "Unknown scene ID")
    nodes = []
    for i, scene in enumerate(project.scenes, 1):
        if scene.id not in selected:
            continue
        if not scene.description.strip() and not (scene.image_prompt.strip() if request.stage == "image" else scene.video_prompt.strip()):
            raise HTTPException(422, f"SC{i:03}: enter a description or prompt")
        image, video = prompts(project, scene)
        cfg = {"prompt": image if request.stage == "image" else video, "aspect_ratio": project.aspect_ratio}
        if request.stage == "image":
            cfg["count"] = 1
        else:
            if scene.duration != 8:
                raise HTTPException(422, f"SC{i:03}: this adapter export supports 8-second clips; split or trim other planned durations")
            cfg["duration"] = 8
        if request.stage == "image_to_video":
            if not scene.media_id.strip():
                raise HTTPException(422, f"SC{i:03}: upload an image using /api/workflow/upload-image and enter its media_id")
            cfg["media_id"] = scene.media_id
        nodes.append({"id": scene.id, "label": f"SC{i:03} — {scene.title}", "type": "generate_image" if request.stage == "image" else request.stage, "config": cfg})
    return {"workflow": {"nodes": nodes, "edges": []}, "note": "Prepared only. Submit to /api/workflow/run to generate; provider credits may be used. Reference notes do not attach images. Inspect each node output for errors."}
