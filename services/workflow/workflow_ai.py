"""AI workflow graph generator — uses Gemini to generate workflow JSON from prompt."""
from __future__ import annotations

import json


SYSTEM_PROMPT = """You are a workflow graph designer for a video/image AI tool.
Generate a valid workflow JSON with "nodes" and "edges" arrays.

Available node types:
- "text": config={text: "..."} → outputs {text}
- "prompt_template": config={template: "..."} (use {variable} placeholders) → outputs {prompt}
- "gemini_rewrite": config={instruction: "..."} → takes {text/prompt} from ctx, outputs {text, prompt}
- "text_to_video": config={prompt, aspect_ratio, duration} → outputs {video_url, videos}
- "image_to_video": config={prompt, media_id, aspect_ratio, duration} → outputs {video_url, videos}
- "generate_image": config={prompt, model, aspect_ratio, count} → outputs {images, first_url}

Edge format: {from: "node_id", to: "node_id", from_key: "output_key", to_key: "input_key"}

Return ONLY valid JSON, no markdown. Example:
{
  "nodes": [
    {"id": "n1", "type": "text", "config": {"text": "A cat"}, "label": "Prompt"},
    {"id": "n2", "type": "text_to_video", "config": {"aspect_ratio": "16:9", "duration": 8}, "label": "Generate"}
  ],
  "edges": [
    {"from": "n1", "to": "n2", "from_key": "text", "to_key": "prompt"}
  ]
}"""


class WorkflowAIService:
    def __init__(self, api_key: str):
        self.api_key = api_key

    async def generate_graph(self, prompt: str) -> dict:
        from adapters.gemini import GeminiAdapter
        adapter = GeminiAdapter(self.api_key)
        full_prompt = f"{SYSTEM_PROMPT}\n\nUser request: {prompt}\n\nGenerate the workflow JSON:"
        raw = await adapter.generate_json(full_prompt, model="gemini-2.0-flash")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # Try to extract JSON block
            import re
            m = re.search(r'\{[\s\S]+\}', raw)
            if m:
                return json.loads(m.group(0))
            return {"nodes": [], "edges": [], "error": "Could not parse AI response"}
