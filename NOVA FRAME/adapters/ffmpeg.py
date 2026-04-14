"""FFmpeg adapter — subtitle burn, frame extraction."""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path


def _find_ffmpeg() -> str:
    """Return ffmpeg executable path."""
    custom = None
    try:
        from services.config_service import load_config
        cfg = load_config()
        custom = cfg.get("FFMPEG_PATH", "").strip() or None
    except Exception:
        pass
    if custom and Path(custom).is_file():
        return custom
    found = shutil.which("ffmpeg")
    return found or "ffmpeg"


class FFmpegAdapter:
    def __init__(self):
        self._ffmpeg = _find_ffmpeg()

    async def burn_subtitles(
        self,
        video_path: str,
        srt_path: str,
        output_path: str,
        font_size: int = 18,
        font_color: str = "white",
        outline_color: str = "black",
    ) -> tuple[bool, str]:
        """Burn SRT subtitles into video. Returns (success, message)."""
        # FFmpeg subtitles filter needs escaped Windows paths
        srt_escaped = srt_path.replace("\\", "/").replace(":", "\\:")
        cmd = [
            self._ffmpeg, "-y",
            "-i", video_path,
            "-vf", (
                f"subtitles='{srt_escaped}'"
                f":force_style='FontSize={font_size},"
                f"PrimaryColour=&H00ffffff,"
                f"OutlineColour=&H00000000,Outline=2'"
            ),
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-c:a", "copy",
            output_path,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                return False, stderr.decode(errors="ignore")[-1000:]
            return True, "OK"
        except FileNotFoundError:
            return False, "ffmpeg not found. Install FFmpeg or set FFMPEG_PATH in settings."
        except Exception as e:
            return False, str(e)

    async def extract_frame(
        self,
        video_path: str,
        output_path: str,
        timestamp: str = "00:00:01",
    ) -> tuple[bool, str]:
        """Extract single frame at timestamp."""
        cmd = [
            self._ffmpeg, "-y",
            "-ss", timestamp,
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            output_path,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                return False, stderr.decode(errors="ignore")[-500:]
            return True, "OK"
        except FileNotFoundError:
            return False, "ffmpeg not found."
        except Exception as e:
            return False, str(e)

    async def cut_frames_range(
        self,
        video_path: str,
        output_dir: str,
        start_time: str,
        end_time: str,
        fps: int = 1,
    ) -> tuple[bool, str, list[str]]:
        """Extract frames from start_time to end_time at given fps."""
        from pathlib import Path as _Path
        out = _Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        pattern = str(out / "frame_%04d.jpg")
        cmd = [
            self._ffmpeg, "-y",
            "-ss", start_time,
            "-to", end_time,
            "-i", video_path,
            "-vf", f"fps={fps}",
            "-q:v", "2",
            pattern,
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                return False, stderr.decode(errors="ignore")[-500:], []
            files = sorted(str(f) for f in out.glob("frame_*.jpg"))
            return True, "OK", files
        except FileNotFoundError:
            return False, "ffmpeg not found.", []
        except Exception as e:
            return False, str(e), []
