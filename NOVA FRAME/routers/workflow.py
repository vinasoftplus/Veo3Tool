"""Workflow engine routes."""
from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import job_store
from services.config_service import get_gemini_keys

router = APIRouter(tags=["workflow"])


class RunWorkflowRequest(BaseModel):
    workflow: dict
    run_to_node_id: str | None = None


@router.post("/run")
async def run_workflow(req: RunWorkflowRequest):
    from services.workflow.workflow_runner import WorkflowRunner
    run_id = str(uuid.uuid4())
    job_id = await job_store.create_job("workflow", {
        "workflow": req.workflow,
        "run_id": run_id,
        "run_to_node_id": req.run_to_node_id,
    })
    runner = WorkflowRunner()
    asyncio.create_task(runner.run(req.workflow, job_id, req.run_to_node_id))
    return {"ok": True, "job_id": job_id, "run_id": run_id}


@router.get("/status/{job_id}")
async def workflow_status(job_id: str):
    job = await job_store.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job không tìm thấy")
    return {"ok": True, "job": job}


class AIGraphRequest(BaseModel):
    prompt: str


@router.post("/ai-generate-graph")
async def ai_generate_graph(req: AIGraphRequest):
    from services.workflow.workflow_ai import WorkflowAIService
    keys = get_gemini_keys()
    if not keys:
        raise HTTPException(400, "Chưa có Gemini API key")
    svc = WorkflowAIService(keys[0])
    graph = await svc.generate_graph(req.prompt)
    return {"ok": True, "workflow": graph}


@router.post("/upload-image")
async def upload_workflow_image(image: UploadFile = File(...)):
    """Upload image for use in workflow nodes → return media_id."""
    import base64
    from adapters.google_labs import GoogleLabsAdapter
    from services.config_service import get_active_accounts
    accounts = get_active_accounts()
    if not accounts:
        raise HTTPException(400, "Chưa có account có token")
    account = accounts[0]
    adapter = GoogleLabsAdapter()
    b64 = base64.b64encode(await image.read()).decode()
    result = await adapter.upload_image(b64, image.content_type or "image/jpeg", account)
    if not result.get("ok"):
        raise HTTPException(400, "Upload thất bại")
    media_id = adapter.parse_upload_media_id(result.get("body", ""))
    return {"ok": True, "media_id": media_id}
