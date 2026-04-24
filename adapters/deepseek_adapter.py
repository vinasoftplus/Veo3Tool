"""DeepSeek adapter — DeepSeek models for text generation tasks."""
from __future__ import annotations


class DeepSeekAdapter:
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def analyze_text(self, text: str, instruction: str, model: str = "deepseek-chat") -> str:
        """General text analysis — same interface as GeminiAdapter.analyze_text."""
        import httpx

        messages = []
        if instruction:
            messages.append({"role": "system", "content": instruction})
        messages.append({"role": "user", "content": text})

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://api.deepseek.com/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={"model": model, "messages": messages},
            )
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"] or ""

    async def analyze_youtube_master_prompt(self, youtube_url: str, master_prompt: str, model: str = "deepseek-chat") -> str:
        """Send YouTube URL + master prompt template to DeepSeek, get filled MD back."""
        system_instruction = (
            "You are a professional video production planner. "
            "The user will give you a YouTube video URL and a master prompt template. "
            "Analyze the video content implied by the URL, then fill in the master prompt template "
            "based on likely content, style, narrative, characters, and locations. "
            "Replace every [INSERT ...] and [placeholder] with concrete, detailed content. "
            "Return the complete filled markdown document — no explanation, no preamble, just the filled template."
        )
        user_message = (
            f"Here is the YouTube video to analyze:\n{youtube_url}\n\n"
            f"Here is the master prompt template to fill:\n\n{master_prompt}"
        )
        return await self.analyze_text(user_message, system_instruction, model=model)
