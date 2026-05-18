"""
Video Editor API — merge, trim, transition, quality presets.
Uses FFmpeg subprocess for all processing.
"""
from __future__ import annotations

import asyncio
import re
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

router = APIRouter()

# ── Job store (in-memory, per-session) ──────────────────────
_jobs: dict[str, dict] = {}

DATA_DIR = Path(__file__).parent.parent / "data" / "video_editor"
DATA_DIR.mkdir(parents=True, exist_ok=True)


# ── Helpers ─────────────────────────────────────────────────

import sys as _sys
# Nuitka onefile extracts to sys._MEIPASS-like temp dir; also check exe dir
def _find_bin(name: str) -> str:
    candidates = [
        Path(getattr(_sys, "_MEIPASS", "")) / name,          # Nuitka/PyInstaller temp
        Path(_sys.executable).parent / name,                  # beside the .exe
        Path(__file__).parent.parent / name,                  # dev mode
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return name  # fallback: rely on PATH

def _ffmpeg() -> str:  return _find_bin("ffmpeg.exe")
def _ffprobe() -> str: return _find_bin("ffprobe.exe")


def _run(cmd: list[str], cwd: Path | None = None) -> tuple[int, str]:
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(cwd) if cwd else None
        )
        return result.returncode, (result.stderr or "") + (result.stdout or "")
    except Exception as e:
        return 1, str(e)


def _probe_duration(path: Path) -> float:
    """Return video duration in seconds. Uses ffprobe if available, else ffmpeg -i fallback."""
    ffprobe_bin = _ffprobe()
    import json, re as _re
    # Try ffprobe first
    if Path(ffprobe_bin).exists() or ffprobe_bin == "ffprobe":
        cmd = [ffprobe_bin, "-v", "quiet", "-print_format", "json", "-show_format", str(path)]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        try:
            data = json.loads(r.stdout)
            return float(data["format"].get("duration", 0))
        except Exception:
            pass
    # Fallback: parse ffmpeg -i stderr
    r = subprocess.run([_ffmpeg(), "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = _re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
    if m:
        h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        return h * 3600 + mi * 60 + s
    return 0.0


def _trim_video(src: Path, dst: Path, start: float, end_cut: float, unit: str) -> bool:
    """Trim head/tail. end_cut = amount to remove from end."""
    if unit == "frames":
        # Use select filter for frame-accurate cut
        fps_cmd = [
            _ffprobe(), "-v", "quiet", "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(src)
        ]
        r = subprocess.run(fps_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        try:
            num, den = r.stdout.strip().split("/")
            fps = float(num) / float(den)
        except Exception:
            fps = 30.0
        dur = _probe_duration(src)
        total_frames = int(dur * fps)
        end_frame = total_frames - int(end_cut)
        start_frame = int(start)
        if start_frame >= end_frame:
            return False
        cmd = [
            _ffmpeg(), "-y", "-i", str(src),
            "-vf", f"select='between(n,{start_frame},{end_frame})',setpts=N/FRAME_RATE/TB",
            "-af", f"aselect='between(n,{start_frame},{end_frame})',asetpts=N/SR/TB",
            str(dst)
        ]
    else:
        # Seconds-based
        dur = _probe_duration(src)
        t_end = max(0.0, dur - end_cut) if end_cut > 0 else None
        cmd = [_ffmpeg(), "-y", "-ss", str(start), "-i", str(src)]
        if t_end:
            cmd += ["-to", str(t_end - start)]
        cmd += ["-c:v", "libx264", "-preset", "fast", "-c:a", "aac", str(dst)]

    rc, _ = _run(cmd)
    return rc == 0


def _get_encoder(quality: str) -> list[str]:
    presets = {
        "copy":   ["-c", "copy"],
        "fast":   ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac"],
        "medium": ["-c:v", "libx264", "-preset", "medium",    "-crf", "23", "-c:a", "aac"],
        "high":   ["-c:v", "libx264", "-preset", "slow",      "-crf", "20", "-c:a", "aac"],
        "ultra":  ["-c:v", "libx264", "-preset", "slower",    "-crf", "18", "-c:a", "aac", "-b:a", "192k"],
    }
    return presets.get(quality, presets["medium"])


def _parse_progress(stderr_line: str, total_dur: float) -> int:
    """Extract % progress from ffmpeg time= output."""
    m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_line)
    if m and total_dur > 0:
        h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        cur = h * 3600 + mi * 60 + s
        return min(99, int(cur / total_dur * 100))
    return -1


# ── Build xfade filter chain ────────────────────────────────

def _get_video_size(path: Path) -> tuple[int, int]:
    """Return (width, height) of video, rounded down to even numbers."""
    import json as _json
    r = subprocess.run(
        [_ffprobe(), "-v", "quiet", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", str(path)],
        capture_output=True, text=True
    )
    try:
        s = _json.loads(r.stdout)["streams"][0]
        w, h = int(s["width"]), int(s["height"])
        return (w - w % 2, h - h % 2)
    except Exception:
        return (1280, 720)


def _build_xfade_cmd(inputs: list[Path], out: Path, duration: float, quality: str) -> list[str]:
    durations = [_probe_duration(p) for p in inputs]
    n = len(inputs)
    if n < 2:
        return []

    # Use resolution of first clip as target
    w, h = _get_video_size(inputs[0])

    cmd = [_ffmpeg(), "-y"]
    for p in inputs:
        cmd += ["-i", str(p)]

    filters = []

    # Normalize each input to same resolution/fps/format before xfade
    for i in range(n):
        filters.append(f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                       f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[vi{i}]")

    # Chain xfade: offset is cumulative clip start minus overlap
    prev = "vi0"
    cumulative = 0.0
    for i in range(1, n):
        cumulative += durations[i - 1] - duration
        offset_val = max(0.0, cumulative)
        out_label = f"vx{i}"
        filters.append(
            f"[{prev}][vi{i}]xfade=transition=fade:duration={duration}:offset={offset_val:.3f}[{out_label}]"
        )
        prev = out_label

    # Audio: concat all audio streams
    audio_inputs = "".join(f"[{i}:a]" for i in range(n))
    filters.append(f"{audio_inputs}concat=n={n}:v=0:a=1[aout]")

    enc = _get_encoder(quality)
    cmd += [
        "-filter_complex", ";".join(filters),
        "-map", f"[{prev}]",
        "-map", "[aout]",
    ] + enc + [str(out)]
    return cmd


# ── Main merge worker ────────────────────────────────────────

async def _do_merge(job_id: str, work_dir: Path, params: dict) -> None:
    job = _jobs[job_id]

    def _upd(pct: int, msg: str):
        job.update({"progress": pct, "message": msg})

    try:
        sources = [work_dir / f for f in job["files"]]
        # Validate all files exist
        missing = [str(f) for f in sources if not f.exists()]
        if missing:
            job.update({"status": "failed", "error": f"Thiếu file: {', '.join(missing)}"})
            return

        _upd(5, "Đang phân tích video...")

        # Step 1: trim if needed
        trim_enabled = params.get("trim_enabled", False)
        trim_start   = float(params.get("trim_start", 0) or 0)
        trim_end     = float(params.get("trim_end", 0) or 0)
        trim_unit    = params.get("trim_unit", "seconds")

        trimmed: list[Path] = []
        if trim_enabled and (trim_start > 0 or trim_end > 0):
            _upd(10, "Đang trim video...")
            for i, src in enumerate(sources):
                dst = work_dir / f"trimmed_{i}.mp4"
                ok = await asyncio.get_event_loop().run_in_executor(
                    None, _trim_video, src, dst, trim_start, trim_end, trim_unit
                )
                trimmed.append(dst if ok else src)
        else:
            trimmed = list(sources)

        _upd(30, "Đang ghép video...")
        mode       = params.get("mode", "normal")
        transition = params.get("transition", "none")
        quality    = params.get("quality", "medium")
        output_name= params.get("output_name", "output.mp4")
        out_path   = work_dir / output_name

        loop = asyncio.get_event_loop()

        # ── Transition: xfade / fade ──
        if transition in ("xfade", "fade"):
            xfade_dur = float(params.get("xfade_duration") or 0.5)
            cmd = _build_xfade_cmd(trimmed, out_path, xfade_dur, quality)
            if not cmd:
                job.update({"status": "failed", "error": "Không thể build xfade command"})
                return
            rc, out = await loop.run_in_executor(None, _run, cmd)
            if rc != 0:
                job.update({"status": "failed", "error": f"FFmpeg xfade thất bại: {out[-300:]}"})
                return

        # ── Mode: loop to duration ──
        elif mode == "loop":
            target_dur = float(params.get("loop_duration") or 60)
            # Repeat list until >= target_dur
            repeated: list[Path] = []
            acc = 0.0
            while acc < target_dur:
                for p in trimmed:
                    repeated.append(p)
                    acc += _probe_duration(p)
                    if acc >= target_dur:
                        break

            merged_tmp = work_dir / "merged_loop_tmp.mp4"
            concat_file = work_dir / "concat_loop.txt"
            concat_file.write_text("\n".join(f"file '{p}'" for p in repeated), encoding="utf-8")
            cmd = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file)] \
                  + _get_encoder(quality) + [str(merged_tmp)]
            rc, _ = await loop.run_in_executor(None, _run, cmd)
            if rc != 0:
                job.update({"status": "failed", "error": "FFmpeg concat (loop) thất bại"})
                return
            # Trim to exact target duration
            cmd2 = [_ffmpeg(), "-y", "-i", str(merged_tmp), "-t", str(target_dur), "-c", "copy", str(out_path)]
            await loop.run_in_executor(None, _run, cmd2)

        # ── Mode: audio overlay ──
        elif mode == "audio":
            audio_name = params.get("audio_file", "")
            audio_path = work_dir / audio_name if audio_name else None

            concat_file = work_dir / "concat_audio.txt"
            concat_file.write_text("\n".join(f"file '{p}'" for p in trimmed), encoding="utf-8")

            if audio_path and audio_path.exists():
                vol_orig = params.get("vol_orig", 100) / 100.0
                vol_bg   = params.get("vol_bg", 80)   / 100.0
                # Step 1: concat videos giữ audio gốc
                merged_tmp = work_dir / "merged_with_audio.mp4"
                cmd = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
                       "-c:v", "libx264", "-preset", "fast", "-c:a", "aac", str(merged_tmp)]
                rc, out_txt = await loop.run_in_executor(None, _run, cmd)
                if rc != 0:
                    job.update({"status": "failed", "error": f"FFmpeg concat thất bại: {out_txt[-300:]}"})
                    return
                # Step 2: volume adjust + amix tiếng gốc + nhạc nền
                af = (f"[0:a]volume={vol_orig:.2f}[a0];"
                      f"[1:a]volume={vol_bg:.2f}[a1];"
                      f"[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]")
                cmd2 = [_ffmpeg(), "-y",
                        "-i", str(merged_tmp),
                        "-i", str(audio_path),
                        "-filter_complex", af,
                        "-map", "0:v:0",
                        "-map", "[aout]",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                        str(out_path)]
                rc2, out2 = await loop.run_in_executor(None, _run, cmd2)
                if rc2 != 0:
                    job.update({"status": "failed", "error": f"FFmpeg audio mix thất bại: {out2[-400:]}"})
                    return
            else:
                # No audio file → normal concat keeping original audio
                cmd = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file)] \
                      + _get_encoder(quality) + [str(out_path)]
                rc, _ = await loop.run_in_executor(None, _run, cmd)
                if rc != 0:
                    job.update({"status": "failed", "error": "FFmpeg concat (audio mode) thất bại"})
                    return

        # ── Mode: normal concat ──
        else:
            concat_file = work_dir / "concat.txt"
            concat_file.write_text("\n".join(f"file '{p}'" for p in trimmed), encoding="utf-8")
            cmd = [_ffmpeg(), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file)] \
                  + _get_encoder(quality) + [str(out_path)]
            rc, _ = await loop.run_in_executor(None, _run, cmd)
            if rc != 0:
                job.update({"status": "failed", "error": "FFmpeg concat thất bại"})
                return

        _upd(98, "Đang hoàn tất...")
        if out_path.exists():
            job.update({
                "status": "completed",
                "progress": 100,
                "message": "Hoàn tất!",
                "output": str(out_path),
                "output_name": out_path.name,
            })
        else:
            job.update({"status": "failed", "error": "File output không tồn tại sau khi xử lý"})

    except Exception as exc:
        import traceback
        job.update({"status": "failed", "error": traceback.format_exc()[-500:]})


# ── Endpoints ────────────────────────────────────────────────

@router.post("/merge")
async def merge_videos(
    videos: list[UploadFile] = File(...),
    mode: str = Form("normal"),
    transition: str = Form("none"),
    quality: str = Form("medium"),
    output_name: str = Form("output.mp4"),
    trim_enabled: bool = Form(False),
    trim_unit: str = Form("seconds"),
    trim_start: float = Form(0),
    trim_end: float = Form(0),
    loop_duration: Optional[float] = Form(None),
    xfade_duration: Optional[float] = Form(None),
    vol_orig: int = Form(100),
    vol_bg: int = Form(80),
    audio: Optional[UploadFile] = File(None),
):
    job_id = str(uuid.uuid4())
    work_dir = DATA_DIR / job_id
    work_dir.mkdir(parents=True)

    # Save uploaded files
    saved_names: list[str] = []
    for f in videos:
        dst = work_dir / f.filename
        dst.write_bytes(await f.read())
        saved_names.append(f.filename)

    audio_file = None
    if audio:
        audio_dst = work_dir / audio.filename
        audio_dst.write_bytes(await audio.read())
        audio_file = audio.filename

    params = {
        "mode": mode, "transition": transition, "quality": quality,
        "output_name": output_name if output_name.endswith(".mp4") else output_name + ".mp4",
        "trim_enabled": trim_enabled, "trim_unit": trim_unit,
        "trim_start": trim_start, "trim_end": trim_end,
        "loop_duration": loop_duration, "xfade_duration": xfade_duration,
        "vol_orig": vol_orig, "vol_bg": vol_bg,
        "audio_file": audio_file,
    }

    _jobs[job_id] = {
        "status": "running", "progress": 0, "message": "Đang khởi động...",
        "files": saved_names, "output": None, "error": None,
    }

    asyncio.create_task(_do_merge(job_id, work_dir, params))
    return {"job_id": job_id}


@router.get("/job/{job_id}")
async def get_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job không tồn tại")
    return job


@router.post("/job/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = _jobs.get(job_id)
    if job:
        job["status"] = "cancelled"
    return {"ok": True}


@router.get("/download/{job_id}")
async def download_output(job_id: str):
    from fastapi.responses import FileResponse
    job = _jobs.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(404, "Job chưa hoàn thành hoặc không tồn tại")
    out_path = Path(job["output"])
    if not out_path.exists():
        raise HTTPException(404, "File output không tồn tại")
    return FileResponse(
        str(out_path),
        media_type="video/mp4",
        filename=out_path.name,
        headers={"Content-Disposition": f'attachment; filename="{out_path.name}"'},
    )
