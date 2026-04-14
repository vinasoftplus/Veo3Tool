"""Gemini adapter — wraps google-genai for subtitle/script/workflow tasks."""
from __future__ import annotations

import asyncio
import base64
import mimetypes
from pathlib import Path


class GeminiAdapter:
    def __init__(self, api_key: str):
        self.api_key = api_key

    def _client(self):
        from google import genai
        return genai.Client(api_key=self.api_key)

    async def transcribe_video(self, video_path: str, language: str = "vi") -> str:
        """Upload video to Gemini Files API and transcribe with timestamps."""
        client = self._client()
        from google.genai import types as gtypes

        video_file_path = Path(video_path)
        mime = mimetypes.guess_type(str(video_file_path))[0] or "video/mp4"

        # Upload file via Files API
        def _upload():
            return client.files.upload(
                file=video_file_path,
                config=gtypes.UploadFileConfig(mime_type=mime),
            )

        uploaded = await asyncio.to_thread(_upload)

        # Wait for processing
        import time
        for _ in range(30):
            f = await asyncio.to_thread(client.files.get, uploaded.name)
            if str(getattr(f, "state", "")).upper() == "ACTIVE":
                break
            await asyncio.sleep(2)

        lang_name = {"vi": "Vietnamese", "en": "English", "ja": "Japanese", "ko": "Korean"}.get(language, language)
        prompt = (
            f"Transcribe this video in {lang_name}. "
            "Output ONLY valid SRT format with timestamps and sequence numbers. "
            "No explanations. Example:\n1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n"
        )

        def _generate():
            return client.models.generate_content(
                model="gemini-2.0-flash",
                contents=[uploaded, prompt],
            )

        response = await asyncio.to_thread(_generate)
        return response.text or ""

    async def analyze_text(self, text: str, instruction: str, model: str = "gemini-2.0-flash") -> str:
        """General text analysis/rewrite."""
        client = self._client()
        full_prompt = f"{instruction}\n\n---\n{text}" if instruction else text

        def _gen():
            return client.models.generate_content(model=model, contents=full_prompt)

        resp = await asyncio.to_thread(_gen)
        return resp.text or ""

    async def generate_json(self, prompt: str, model: str = "gemini-2.0-flash") -> str:
        """Generate JSON-structured response."""
        client = self._client()
        from google.genai import types as gtypes

        def _gen():
            return client.models.generate_content(
                model=model,
                contents=prompt,
                config=gtypes.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )

        resp = await asyncio.to_thread(_gen)
        return resp.text or "{}"
