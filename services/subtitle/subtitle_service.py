"""Subtitle extraction service — uses Gemini to generate SRT from video."""
from __future__ import annotations

from services import job_store
from adapters.gemini import GeminiAdapter


class SubtitleService:
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def run_job(self, job_id: str, video_path: str, language: str = "vi"):
        try:
            await job_store.update_job(job_id, status="running", progress=10)
            adapter = GeminiAdapter(self.api_key)
            srt_content = await adapter.transcribe_video(video_path, language)
            if not srt_content.strip():
                await job_store.update_job(job_id, status="failed", error="Gemini trả về nội dung rỗng")
                return
            await job_store.update_job(
                job_id,
                status="done",
                progress=100,
                outputs={"srt_content": srt_content},
            )
        except Exception as e:
            await job_store.update_job(job_id, status="failed", error=str(e))
