from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from elevenlabs.core.api_error import ApiError
import os
from pathlib import Path

env_path = Path(__file__).with_name(".env")
load_dotenv(env_path)
output_path = Path(__file__).with_name("test_output.mp3")

api_key = os.getenv("ELEVENLABS_API_KEY")
if not api_key:
    raise RuntimeError(f"Missing ELEVENLABS_API_KEY. Add it to: {env_path}")

elevenlabs = ElevenLabs(
    api_key=api_key,
)

if output_path.exists():
    print(f"Audio already exists, not calling ElevenLabs again: {output_path}")
    raise SystemExit(0)

try:
    audio = elevenlabs.text_to_speech.convert(
        text="Hello, this is a short API test.",
        voice_id="JBFqnCBsd6RMkjVDRZzb",  # "George" - browse voices at elevenlabs.io/app/voice-library
        model_id="eleven_v3",
        output_format="mp3_44100_128",
    )
    output_path.write_bytes(b"".join(audio))
    print(f"Saved: {output_path}")
except ApiError as exc:
    detail = getattr(exc, "body", {}) or {}
    status = detail.get("detail", {}).get("status")
    message = detail.get("detail", {}).get("message")

    if status == "detected_unusual_activity":
        print("ElevenLabs blocked this account/IP for unusual activity.")
        print("Code cannot bypass this. Turn off VPN/proxy, use one legitimate account, or use a paid plan/contact support.")
    elif status == "needs_authorization":
        print("API key was not accepted. Check ELEVENLABS_API_KEY in .env.")
    else:
        print(f"ElevenLabs API error: {status or exc.status_code}")
        if message:
            print(message)
    raise
