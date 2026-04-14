"""YouTube Script Analyzer — download transcript via yt-dlp, analyze with Gemini."""
from __future__ import annotations

import asyncio
import json
import re
import tempfile
from pathlib import Path

from services import job_store
from adapters.gemini import GeminiAdapter


def _parse_time(t: str | None) -> float | None:
    """Parse HH:MM:SS or MM:SS to seconds."""
    if not t:
        return None
    parts = t.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except Exception:
        return None


async def _get_transcript_ytdlp(youtube_url: str) -> str:
    """Use yt-dlp to download auto-generated subtitles."""
    import shutil
    ytdlp = shutil.which("yt-dlp") or "yt-dlp"
    with tempfile.TemporaryDirectory() as tmpdir:
        cmd = [
            ytdlp,
            "--write-auto-sub",
            "--skip-download",
            "--sub-format", "vtt",
            "--output", str(Path(tmpdir) / "sub"),
            youtube_url,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        # Find downloaded vtt file
        vtt_files = list(Path(tmpdir).glob("*.vtt"))
        if not vtt_files:
            return ""
        content = vtt_files[0].read_text(encoding="utf-8", errors="ignore")
        # Strip VTT markup
        lines = []
        for line in content.splitlines():
            if "-->" in line or line.startswith("WEBVTT") or re.match(r"^\d+$", line.strip()):
                continue
            clean = re.sub(r"<[^>]+>", "", line).strip()
            if clean:
                lines.append(clean)
        return " ".join(lines)


class ScriptAnalyzerService:
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def run_job(
        self,
        job_id: str,
        youtube_url: str,
        language: str = "vi",
        instruction: str = "",
        time_start: str | None = None,
        time_end: str | None = None,
    ):
        try:
            await job_store.update_job(job_id, status="running", progress=10)

            transcript = await _get_transcript_ytdlp(youtube_url)

            # Trim by time if needed
            if transcript and (time_start or time_end):
                # Simple word-based trim approximation (no timestamps in plain text)
                words = transcript.split()
                total_words = len(words)
                # Estimate: 150 words/minute
                if time_start:
                    ts = _parse_time(time_start) or 0
                    start_word = int(ts / 60 * 150)
                else:
                    start_word = 0
                if time_end:
                    te = _parse_time(time_end) or 0
                    end_word = int(te / 60 * 150)
                else:
                    end_word = total_words
                transcript = " ".join(words[start_word:end_word])

            await job_store.update_job(job_id, progress=40)

            if not transcript.strip():
                await job_store.update_job(
                    job_id, status="failed",
                    error="Không thể lấy transcript từ video. Kiểm tra yt-dlp đã cài và video có phụ đề tự động."
                )
                return

            # Analyze with Gemini
            adapter = GeminiAdapter(self.api_key)
            lang_name = {"vi": "Vietnamese", "en": "English", "ja": "Japanese", "ko": "Korean"}.get(language, language)
            default_instruction = (
                f"Summarize and analyze this YouTube video transcript in {lang_name}. "
                "Provide: 1) Main topic, 2) Key points, 3) Content summary, 4) Suggestions for viral content ideas."
            )
            final_instruction = instruction.strip() or default_instruction
            analysis = await adapter.analyze_text(transcript, final_instruction)

            await job_store.update_job(
                job_id,
                status="done",
                progress=100,
                outputs={
                    "transcript": transcript,
                    "analysis": analysis,
                },
            )
        except Exception as e:
            await job_store.update_job(job_id, status="failed", error=str(e))
