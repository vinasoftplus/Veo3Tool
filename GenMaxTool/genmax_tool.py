import json
import concurrent.futures
import mimetypes
import os
import queue
import re
import threading
import time
import webbrowser
from collections import Counter
from pathlib import Path
from tkinter import BOTH, END, LEFT, RIGHT, X, Y, BooleanVar, StringVar, Tk, filedialog, messagebox
from tkinter import ttk
import tkinter as tk

import requests


BASE_URL = "https://api.genmax.io"
APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.json"


ENDPOINTS = [
    ("GET", "/v1/auth/me", "Auth: get user and credits"),
    ("GET", "/v1/models", "Models: provider optional, use provider=minimax for MiniMax"),
    ("GET", "/v1/languages", "Languages: provider optional"),
    ("GET", "/v1/shared-voices", "ElevenLabs shared voices"),
    ("GET", "/v1/default-voices", "ElevenLabs default voices"),
    ("GET", "/v1/minimax/system-voices", "MiniMax system voices"),
    ("GET", "/v1/minimax/voices", "MiniMax cloned voices"),
    ("POST", "/v1/text-to-speech/{voice_id}", "Text to speech async"),
    ("GET", "/v1/history", "TTS/dialogue history"),
    ("GET", "/v1/history/{id}", "TTS/dialogue detail"),
    ("POST", "/v1/history/{id}/retry", "Retry TTS/dialogue task"),
    ("DELETE", "/v1/history/{id}", "Delete TTS/dialogue task"),
    ("POST", "/v1/dialogue", "Multi-speaker dialogue TTS"),
    ("POST", "/v1/speech-to-text", "Speech to text multipart"),
    ("POST", "/v1/voice-changer", "Speech-to-speech voice changer"),
    ("GET", "/v1/voice-changer/history", "Voice changer history"),
    ("GET", "/v1/voice-changer/history/{id}", "Voice changer detail"),
    ("POST", "/v1/voice-changer/history/{id}/retry", "Retry voice changer"),
    ("DELETE", "/v1/voice-changer/history/{id}", "Delete voice changer task"),
    ("POST", "/v1/dubbing", "Audio/video dubbing"),
    ("GET", "/v1/dubbing/history", "Dubbing history"),
    ("GET", "/v1/dubbing/history/{id}", "Dubbing detail"),
    ("POST", "/v1/dubbing/history/{id}/retry", "Retry dubbing"),
    ("DELETE", "/v1/dubbing/history/{id}", "Delete dubbing task"),
    ("POST", "/v1/minimax/voices/clone", "Clone MiniMax voice"),
    ("POST", "/v1/minimax/voices/{voice_id}/retry", "Retry MiniMax clone"),
    ("DELETE", "/v1/minimax/voices/{voice_id}", "Delete MiniMax cloned voice"),
]


def load_config():
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name.strip())
    return name or "output"


def parse_params(text):
    text = text.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        params = {}
        for part in re.split(r"[&\n]", text):
            if not part.strip():
                continue
            key, _, value = part.partition("=")
            params[key.strip()] = value.strip()
        return params


def parse_json(text, fallback=None):
    text = text.strip()
    if not text:
        return fallback
    return json.loads(text)


def parse_batch_line(line):
    parts = line.split("|", 2)
    if len(parts) != 3:
        return None
    file_name, character, text = [part.strip() for part in parts]
    if not file_name and not character and not text:
        return None
    return file_name, character, text


def extract_task_id(data):
    if not isinstance(data, dict):
        return None
    return data.get("id") or data.get("task_id") or data.get("transcription_id")


def result_url(data):
    if not isinstance(data, dict):
        return None
    result = data.get("result")
    if isinstance(result, dict):
        for key in ("audio_url", "video_url", "srt_url", "url"):
            if result.get(key):
                return result[key]
    for key in ("audio_url", "video_url", "srt_url", "url"):
        if data.get(key):
            return data[key]
    return None


def compact_voice_label(item):
    name = item.get("name") or item.get("voice_name") or item.get("voice_id") or item.get("uniq_id") or "Voice"
    accent = item.get("accent") or ""
    gender = item.get("gender") or ""
    desc = item.get("description") or item.get("descriptive") or ""
    tags = item.get("tag_list") or []
    if tags and not accent:
        accent = ", ".join(tags[:2])
    bits = [str(x) for x in (name, accent, gender, desc) if x]
    return " - ".join(bits)[:110]


def model_label(item):
    return item.get("name") or item.get("model_id") or "Model"


class GenMaxClient:
    def __init__(self, api_key_getter, log, payment_handler=None):
        self.api_key_getter = api_key_getter
        self.log = log
        self.payment_handler = payment_handler

    def headers(self, json_body=True):
        key = self.api_key_getter().strip()
        if not key:
            raise RuntimeError("Chua nhap API key.")
        headers = {"xi-api-key": key}
        if json_body:
            headers["Content-Type"] = "application/json"
        return headers

    def is_payment_error(self, resp):
        text = ""
        try:
            text = resp.text.lower()
        except Exception:
            pass
        return resp.status_code == 402 or any(
            token in text
            for token in (
                "need payment",
                "payment required",
                "insufficient credit",
                "insufficient balance",
                "not enough credit",
                "credit balance",
            )
        )

    def request(self, method, path, params=None, json_body=None, files=None, data=None, stream=False):
        url = BASE_URL + path
        tried_keys = set()
        while True:
            key = self.api_key_getter().strip()
            tried_keys.add(key)
            headers = self.headers(json_body=files is None and data is None)
            if files is not None or data is not None:
                headers.pop("Content-Type", None)
            resp = requests.request(
                method,
                url,
                headers=headers,
                params=params or None,
                json=json_body,
                files=files,
                data=data,
                timeout=180,
                stream=stream,
            )
            if resp.ok or not self.payment_handler or not self.is_payment_error(resp):
                break
            switched = self.payment_handler(key, f"{resp.status_code} {resp.reason}: {resp.text[:500]}")
            if not switched or self.api_key_getter().strip() in tried_keys:
                break
        if not resp.ok:
            raise RuntimeError(f"{resp.status_code} {resp.reason}: {resp.text[:1500]}")
        if stream:
            return resp
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    def download(self, url, target):
        resp = requests.get(url, headers={"xi-api-key": self.api_key_getter().strip()}, timeout=180, stream=True)
        if not resp.ok:
            resp = requests.get(url, timeout=180, stream=True)
        if not resp.ok:
            raise RuntimeError(f"Download failed {resp.status_code}: {resp.text[:500]}")
        with open(target, "wb") as f:
            for chunk in resp.iter_content(1024 * 128):
                if chunk:
                    f.write(chunk)


class App(Tk):
    def __init__(self):
        super().__init__()
        self.title("GenMax API Tool")
        self.geometry("1180x760")
        self.minsize(980, 640)
        self.cfg = load_config()
        self.api_keys = self.normalize_api_keys(self.cfg.get("api_keys"), self.cfg.get("api_key", ""))
        self.api_key_lock = threading.Lock()
        self.api_key = StringVar(value=self.api_keys[0] if self.api_keys else self.cfg.get("api_key", ""))
        self.is_batch_running = BooleanVar(value=False)
        self.batch_workers = StringVar(value=str(self.cfg.get("batch_workers", 3)))
        self.batch_filter_character = StringVar(value="All")
        self.batch_filter_status = StringVar(value="All")
        self.credit_text = StringVar(value="Credits: --")
        self.total_credit_text = StringVar(value="Total: --")
        self.user_text = StringVar(value="")
        self.auto_credit_refresh = BooleanVar(value=True)
        self.last_total_credit_refresh = 0
        self.thread_key = threading.local()
        self.log_queue = queue.Queue()
        self.client = GenMaxClient(self.get_request_api_key, self.log, self.handle_payment_key)
        self._build()
        self.after(100, self._drain_logs)
        self.after(1000, self.refresh_credits_silent)
        self.after(1500, lambda: self.run_thread(self.refresh_all_credits))
        self.after(30000, self.credit_refresh_loop)

    def _build(self):
        top = ttk.Frame(self, padding=8)
        top.pack(fill=X)
        ttk.Label(top, text="API key").pack(side=LEFT)
        ttk.Entry(top, textvariable=self.api_key, show="*", width=55).pack(side=LEFT, padx=6)
        ttk.Button(top, text="Keys...", command=self.open_api_keys_dialog).pack(side=LEFT)
        ttk.Button(top, text="Save", command=self.save_settings).pack(side=LEFT)
        ttk.Button(top, text="Test /me", command=lambda: self.run_thread(self.test_me)).pack(side=LEFT, padx=6)
        ttk.Button(top, textvariable=self.credit_text, command=lambda: self.run_thread(self.refresh_credits)).pack(side=LEFT, padx=(8, 4))
        ttk.Button(top, textvariable=self.total_credit_text, command=lambda: self.run_thread(self.refresh_all_credits)).pack(side=LEFT, padx=(0, 4))
        ttk.Label(top, textvariable=self.user_text).pack(side=LEFT)
        ttk.Checkbutton(top, text="Auto credit", variable=self.auto_credit_refresh).pack(side=LEFT, padx=8)
        ttk.Button(top, text="Open API docs", command=lambda: webbrowser.open("https://genmax.io/app/api-docs")).pack(side=RIGHT)

        main = ttk.PanedWindow(self, orient=tk.VERTICAL)
        main.pack(fill=BOTH, expand=True)
        self.tabs = ttk.Notebook(main)
        main.add(self.tabs, weight=5)
        log_frame = ttk.Frame(main, padding=(8, 4))
        main.add(log_frame, weight=1)
        ttk.Label(log_frame, text="Log").pack(anchor="w")
        self.log_text = tk.Text(log_frame, height=9, wrap="word")
        self.log_text.pack(fill=BOTH, expand=True)

        self.build_tts_tab()
        self.build_voices_tab()
        self.build_history_tab()
        self.build_dialogue_tab()
        self.build_stt_tab()
        self.build_audio_tools_tab()
        self.build_generic_tab()

    def log(self, msg):
        self.log_queue.put(f"[{time.strftime('%H:%M:%S')}] {msg}")

    def _drain_logs(self):
        while True:
            try:
                msg = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_text.insert(END, msg + "\n")
            self.log_text.see(END)
        self.after(100, self._drain_logs)

    def run_thread(self, func):
        threading.Thread(target=self._safe_run, args=(func,), daemon=True).start()

    def _safe_run(self, func):
        try:
            func()
        except Exception as exc:
            self.log(f"ERROR: {exc}")
            self.after(0, lambda: messagebox.showerror("Error", str(exc)))

    def start_batch(self):
        if self.is_batch_running.get():
            self.log("Batch is already running.")
            return
        self.is_batch_running.set(True)
        self.set_batch_buttons_running(True)

        def worker():
            try:
                self.run_batch_tts()
            except Exception as exc:
                self.log(f"ERROR: {exc}")
                self.after(0, lambda: messagebox.showerror("Error", str(exc)))
            finally:
                self.is_batch_running.set(False)
                self.after(0, lambda: self.set_batch_buttons_running(False))

        threading.Thread(target=worker, daemon=True).start()

    def set_batch_buttons_running(self, running):
        state = "disabled" if running else "normal"
        top_text = "Running..." if running else "Start"
        side_text = "Running..." if running else "Start Batch TTS"
        if hasattr(self, "start_batch_button"):
            self.start_batch_button.configure(text=top_text, state=state)
        if hasattr(self, "side_start_batch_button"):
            self.side_start_batch_button.configure(text=side_text, state=state)

    def normalize_api_keys(self, keys, fallback=""):
        raw = []
        if isinstance(keys, list):
            raw.extend(str(key) for key in keys)
        elif isinstance(keys, str):
            raw.extend(keys.splitlines())
        if fallback:
            raw.append(str(fallback))
        clean = []
        seen = set()
        for key in raw:
            key = key.strip()
            if key and key not in seen:
                clean.append(key)
                seen.add(key)
        return clean

    def sync_api_key_list_from_field(self):
        current = self.api_key.get().strip()
        with self.api_key_lock:
            if current and current not in self.api_keys:
                self.api_keys.insert(0, current)
            elif current in self.api_keys and self.api_keys[0] != current:
                self.api_keys.remove(current)
                self.api_keys.insert(0, current)

    def get_request_api_key(self):
        key = getattr(self.thread_key, "key", "")
        return key or self.api_key.get()

    def set_thread_api_key(self, key=None):
        self.thread_key.key = key or self.api_key.get().strip()

    def clear_thread_api_key(self):
        self.thread_key.key = ""

    def persist_api_keys(self):
        self.cfg["api_keys"] = list(self.api_keys)
        self.cfg["api_key"] = self.api_key.get().strip()
        save_config(self.cfg)

    def open_api_keys_dialog(self):
        win = tk.Toplevel(self)
        win.title("API keys")
        win.geometry("720x520")
        win.transient(self)
        ttk.Label(win, text="Paste API keys, one key per line").pack(anchor="w", padx=8, pady=(8, 2))
        text = tk.Text(win, height=22, wrap="none")
        text.pack(fill=BOTH, expand=True, padx=8, pady=4)
        with self.api_key_lock:
            keys = list(self.api_keys)
        current = self.api_key.get().strip()
        if current and current not in keys:
            keys.insert(0, current)
        text.insert("1.0", "\n".join(keys))
        status = StringVar(value=f"{len(keys)} keys")
        bottom = ttk.Frame(win, padding=8)
        bottom.pack(fill=X)
        ttk.Label(bottom, textvariable=status).pack(side=LEFT)

        def save_keys():
            new_keys = self.normalize_api_keys(text.get("1.0", END))
            with self.api_key_lock:
                self.api_keys = new_keys
                self.api_key.set(new_keys[0] if new_keys else "")
            self.persist_api_keys()
            status.set(f"Saved {len(new_keys)} keys")
            self.log(f"Saved {len(new_keys)} API keys")
            win.destroy()
            self.run_thread(self.refresh_all_credits)

        ttk.Button(bottom, text="Save keys", command=save_keys).pack(side=RIGHT)
        ttk.Button(bottom, text="Cancel", command=win.destroy).pack(side=RIGHT, padx=6)

    def handle_payment_key(self, failed_key, reason):
        with self.api_key_lock:
            if failed_key in self.api_keys:
                self.api_keys.remove(failed_key)
                masked = f"{failed_key[:8]}...{failed_key[-4:]}" if len(failed_key) > 14 else "***"
                self.log(f"Removed exhausted API key {masked}: {reason}")
            if not self.api_keys:
                self.api_key.set("")
                self.persist_api_keys()
                self.after(0, lambda: self.credit_text.set("Credits: --"))
                self.after(0, lambda: self.total_credit_text.set("Total: 0"))
                return False
            next_key = self.api_keys[0]
            self.api_key.set(next_key)
            self.thread_key.key = next_key
            self.persist_api_keys()
        self.log("Switched to next API key.")
        self.after(0, lambda: self.run_thread(self.refresh_all_credits))
        return True

    def save_settings(self):
        self.sync_api_key_list_from_field()
        self.cfg["api_key"] = self.api_key.get().strip()
        self.cfg["api_keys"] = list(self.api_keys)
        self.cfg["characters"] = self.get_character_map()
        self.cfg["output_dir"] = self.output_dir.get().strip()
        self.cfg["batch_workers"] = self.get_batch_worker_count()
        self.cfg["provider"] = self.provider.get()
        self.cfg["voice_id"] = self.voice_id.get()
        self.cfg["voice_label"] = self.voice_label.get()
        self.cfg["model_id"] = self.model_id.get()
        self.cfg["model_label"] = self.model_label.get()
        self.cfg["language_code"] = self.language_code.get()
        self.cfg["language_options"] = list(self.language_combo["values"]) if hasattr(self, "language_combo") else []
        self.cfg["export_transcript"] = self.export_srt.get()
        self.cfg["voice_settings"] = parse_json(self.voice_settings.get("1.0", END), {})
        save_config(self.cfg)
        self.log("Saved config.json")

    def test_me(self):
        self.sync_api_key_list_from_field()
        data = self.client.request("GET", "/v1/auth/me")
        self.update_credit_display(data)
        self.log(json.dumps(data, ensure_ascii=False, indent=2))
        self.refresh_all_credits()

    def update_credit_display(self, data):
        if not isinstance(data, dict):
            return
        credits = data.get("credit_balance")
        if credits is not None:
            try:
                credits_label = f"{float(credits):,.0f}".rstrip("0").rstrip(".")
            except Exception:
                credits_label = str(credits)
            self.after(0, lambda: self.credit_text.set(f"Credits: {credits_label}"))
        name = data.get("name") or data.get("email") or ""
        role = data.get("role") or ""
        label = f"{name} ({role})" if name and role else name
        self.after(0, lambda: self.user_text.set(label))

    def refresh_credits(self):
        self.sync_api_key_list_from_field()
        data = self.client.request("GET", "/v1/auth/me")
        self.update_credit_display(data)
        self.log(f"Credits refreshed: {data.get('credit_balance') if isinstance(data, dict) else '--'}")
        self.refresh_all_credits()

    def fetch_credit_for_key(self, key):
        resp = requests.get(
            BASE_URL + "/v1/auth/me",
            headers={"xi-api-key": key},
            timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(f"{resp.status_code} {resp.reason}: {resp.text[:500]}")
        data = resp.json()
        return data, float(data.get("credit_balance") or 0)

    def refresh_all_credits(self):
        self.sync_api_key_list_from_field()
        with self.api_key_lock:
            keys = list(self.api_keys)
        if not keys:
            self.after(0, lambda: self.total_credit_text.set("Total: 0"))
            return
        self.last_total_credit_refresh = time.time()
        total = 0.0
        ok_count = 0
        bad_keys = []
        for key in keys:
            try:
                data, credits = self.fetch_credit_for_key(key)
                total += credits
                ok_count += 1
                if key == self.api_key.get().strip():
                    self.update_credit_display(data)
            except Exception as exc:
                self.log(f"Credit check failed for key {key[:8]}...: {exc}")
                if "need payment" in str(exc).lower() or "payment" in str(exc).lower() or "402" in str(exc):
                    bad_keys.append(key)
        for key in bad_keys:
            self.handle_payment_key(key, "credit check need payment")
        total_label = f"{total:,.0f}".rstrip("0").rstrip(".")
        self.after(0, lambda: self.total_credit_text.set(f"Total: {total_label} ({ok_count})"))
        self.log(f"Total credits refreshed: {total_label} across {ok_count} keys")

    def refresh_credits_silent(self):
        if not self.api_key.get().strip():
            return
        try:
            data = self.client.request("GET", "/v1/auth/me")
            self.update_credit_display(data)
        except Exception as exc:
            self.log(f"Credit refresh failed: {exc}")
            return
        with self.api_key_lock:
            multi_key = len(self.api_keys) > 1
        if multi_key and time.time() - self.last_total_credit_refresh > 60:
            try:
                self.refresh_all_credits()
            except Exception as exc:
                self.log(f"Total credit refresh failed: {exc}")

    def credit_refresh_loop(self):
        if self.auto_credit_refresh.get() and self.api_key.get().strip():
            threading.Thread(target=self.refresh_credits_silent, daemon=True).start()
        self.after(30000, self.credit_refresh_loop)

    def build_tts_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="TTS Batch")
        left = ttk.Frame(tab)
        left.pack(side=LEFT, fill=BOTH, expand=True)
        right = ttk.Frame(tab)
        right.pack(side=RIGHT, fill=Y, padx=(8, 0))

        row = ttk.Frame(left)
        row.pack(fill=X)
        self.batch_file = StringVar()
        self.output_dir = StringVar(value=self.cfg.get("output_dir", str(APP_DIR / "outputs")))
        ttk.Entry(row, textvariable=self.batch_file).pack(side=LEFT, fill=X, expand=True)
        ttk.Button(row, text="Import TXT", command=self.pick_batch).pack(side=LEFT, padx=4)
        ttk.Button(row, text="Sample", command=self.load_sample_batch).pack(side=LEFT)
        self.start_batch_button = ttk.Button(row, text="Start", command=self.start_batch)
        self.start_batch_button.pack(side=LEFT, padx=(8, 0))
        ttk.Label(row, text="Luồng").pack(side=LEFT, padx=(10, 2))
        ttk.Spinbox(row, from_=1, to=100, textvariable=self.batch_workers, width=5).pack(side=LEFT)
        ttk.Label(row, text="Lọc nhân vật").pack(side=LEFT, padx=(10, 2))
        self.batch_filter_combo = ttk.Combobox(row, textvariable=self.batch_filter_character, values=("All",), state="readonly", width=18)
        self.batch_filter_combo.pack(side=LEFT)
        self.batch_filter_combo.bind("<<ComboboxSelected>>", lambda _event: self.apply_batch_filter())
        ttk.Label(row, text="Trạng thái").pack(side=LEFT, padx=(10, 2))
        self.batch_status_filter_combo = ttk.Combobox(
            row,
            textvariable=self.batch_filter_status,
            values=("All", "Waiting", "Queued", "Running", "Submitted", "Processing", "Downloading", "Done", "Failed", "Skipped"),
            state="readonly",
            width=14,
        )
        self.batch_status_filter_combo.pack(side=LEFT)
        self.batch_status_filter_combo.bind("<<ComboboxSelected>>", lambda _event: self.apply_batch_filter())
        ttk.Button(row, text="Xóa tất cả", command=self.clear_batch_rows).pack(side=LEFT, padx=(8, 0))
        row2 = ttk.Frame(left)
        row2.pack(fill=X, pady=4)
        ttk.Entry(row2, textvariable=self.output_dir).pack(side=LEFT, fill=X, expand=True)
        ttk.Button(row2, text="Output folder", command=self.pick_output_dir).pack(side=LEFT, padx=4)

        self.batch_rows = []
        batch_table_frame = ttk.Frame(left)
        batch_table_frame.pack(fill=BOTH, expand=True, pady=4)
        self.batch_preview = ttk.Treeview(batch_table_frame, columns=("file", "character", "text", "status"), show="headings", height=12)
        for col, text, width in (("file", "Tên file lưu", 160), ("character", "Tên nhân vật", 140), ("text", "Câu cần chuyển qua giọng nói", 500), ("status", "Trạng thái", 160)):
            self.batch_preview.heading(col, text=text)
            self.batch_preview.column(col, width=width, anchor="w")
        batch_y_scroll = ttk.Scrollbar(batch_table_frame, orient=tk.VERTICAL, command=self.batch_preview.yview)
        batch_x_scroll = ttk.Scrollbar(batch_table_frame, orient=tk.HORIZONTAL, command=self.batch_preview.xview)
        self.batch_preview.configure(yscrollcommand=batch_y_scroll.set, xscrollcommand=batch_x_scroll.set)
        self.batch_preview.grid(row=0, column=0, sticky="nsew")
        batch_y_scroll.grid(row=0, column=1, sticky="ns")
        batch_x_scroll.grid(row=1, column=0, sticky="ew")
        batch_table_frame.rowconfigure(0, weight=1)
        batch_table_frame.columnconfigure(0, weight=1)

        opts = ttk.LabelFrame(right, text="Settings", padding=8)
        opts.pack(fill=X)
        self.provider = StringVar(value=self.cfg.get("provider", "elevenlabs"))
        self.voice_id = StringVar(value=self.cfg.get("voice_id", ""))
        self.voice_label = StringVar(value=self.cfg.get("voice_label", self.cfg.get("voice_id", "No voice selected")))
        self.model_id = StringVar(value=self.cfg.get("model_id", "eleven_multilingual_v2"))
        self.model_label = StringVar(value=self.cfg.get("model_label", self.cfg.get("model_id", "eleven_multilingual_v2")))
        self.language_code = StringVar(value=self.cfg.get("language_code", "en"))
        self.export_srt = BooleanVar(value=bool(self.cfg.get("export_transcript", False)))
        self.voice_settings = tk.Text(opts, width=42, height=6)
        self.voice_settings.insert(END, json.dumps(self.cfg.get("voice_settings", {"stability": 0.5, "similarity_boost": 0.75, "speed": 1.0}), indent=2))

        ttk.Label(opts, text="Provider").pack(anchor="w", pady=(4, 2))
        provider_row = ttk.Frame(opts)
        provider_row.pack(fill=X)
        ttk.Radiobutton(provider_row, text="ElevenLabs", variable=self.provider, value="elevenlabs", command=self.on_provider_change).pack(side=LEFT, fill=X, expand=True)
        ttk.Radiobutton(provider_row, text="MiniMax", variable=self.provider, value="minimax", command=self.on_provider_change).pack(side=LEFT, fill=X, expand=True)

        ttk.Label(opts, text="Select Voice").pack(anchor="w", pady=(10, 2))
        voice_btn = ttk.Button(opts, textvariable=self.voice_label, command=self.open_voice_selector)
        voice_btn.pack(fill=X)
        voice_id_row = ttk.Frame(opts)
        voice_id_row.pack(fill=X, pady=(2, 0))
        ttk.Label(voice_id_row, text="Voice ID").pack(side=LEFT)
        ttk.Entry(voice_id_row, textvariable=self.voice_id, width=28).pack(side=RIGHT, fill=X, expand=True)

        ttk.Label(opts, text="Select Model").pack(anchor="w", pady=(10, 2))
        ttk.Button(opts, textvariable=self.model_label, command=self.open_model_selector).pack(fill=X)
        model_id_row = ttk.Frame(opts)
        model_id_row.pack(fill=X, pady=(2, 0))
        ttk.Label(model_id_row, text="Model ID").pack(side=LEFT)
        ttk.Entry(model_id_row, textvariable=self.model_id, width=28).pack(side=RIGHT, fill=X, expand=True)

        ttk.Label(opts, text="Select language").pack(anchor="w", pady=(10, 2))
        lang_row = ttk.Frame(opts)
        lang_row.pack(fill=X)
        self.language_combo = ttk.Combobox(lang_row, textvariable=self.language_code, values=self.cfg.get("language_options", []))
        self.language_combo.pack(side=LEFT, fill=X, expand=True)
        ttk.Button(lang_row, text="Load", command=lambda: self.run_thread(self.load_languages_for_provider)).pack(side=LEFT, padx=(4, 0))

        ttk.Checkbutton(opts, text="Export SRT transcript", variable=self.export_srt).pack(anchor="w")
        ttk.Label(opts, text="Voice settings JSON").pack(anchor="w", pady=(6, 0))
        self.voice_settings.pack(fill=X)
        ttk.Button(opts, text="Reset values", command=self.reset_voice_settings).pack(anchor="e", pady=(6, 0))

        chars = ttk.LabelFrame(right, text="Character voices", padding=8)
        chars.pack(fill=BOTH, expand=True, pady=8)
        char_table_frame = ttk.Frame(chars)
        char_table_frame.pack(fill=BOTH, expand=True)
        self.char_tree = ttk.Treeview(char_table_frame, columns=("char", "provider", "voice", "model", "lang"), show="headings", height=8)
        for col, text, width in (("char", "Character", 90), ("provider", "Provider", 75), ("voice", "Voice ID", 120), ("model", "Model", 130), ("lang", "Lang", 60)):
            self.char_tree.heading(col, text=text)
            self.char_tree.column(col, width=width)
        char_y_scroll = ttk.Scrollbar(char_table_frame, orient=tk.VERTICAL, command=self.char_tree.yview)
        char_x_scroll = ttk.Scrollbar(char_table_frame, orient=tk.HORIZONTAL, command=self.char_tree.xview)
        self.char_tree.configure(yscrollcommand=char_y_scroll.set, xscrollcommand=char_x_scroll.set)
        self.char_tree.grid(row=0, column=0, sticky="nsew")
        char_y_scroll.grid(row=0, column=1, sticky="ns")
        char_x_scroll.grid(row=1, column=0, sticky="ew")
        char_table_frame.rowconfigure(0, weight=1)
        char_table_frame.columnconfigure(0, weight=1)
        for item in self.cfg.get("characters", []):
            self.char_tree.insert("", END, values=(item.get("character", ""), item.get("provider", "elevenlabs"), item.get("voice_id", ""), item.get("model_id", ""), item.get("language_code", "")))
        btns = ttk.Frame(chars)
        btns.pack(fill=X, pady=4)
        ttk.Button(btns, text="Add/Edit", command=self.edit_character).pack(side=LEFT)
        ttk.Button(btns, text="Delete", command=self.delete_character).pack(side=LEFT, padx=4)
        self.side_start_batch_button = ttk.Button(right, text="Start Batch TTS", command=self.start_batch)
        self.side_start_batch_button.pack(fill=X, pady=4)

    def _form(self, parent, label, widget):
        ttk.Label(parent, text=label).pack(anchor="w", pady=(4, 0))
        widget.pack(fill=X)

    def on_provider_change(self):
        if self.provider.get() == "minimax":
            if not self.model_id.get() or self.model_id.get().startswith("eleven"):
                self.model_id.set("speech-2.8-turbo")
                self.model_label.set("Speech 2.8 Turbo")
            if self.language_code.get() in ("en", ""):
                self.language_code.set("English")
            self.voice_settings.delete("1.0", END)
            self.voice_settings.insert(END, json.dumps({"speed": 1.0, "pitch": 0, "vol": 1.0}, indent=2))
        else:
            if not self.model_id.get() or self.model_id.get().startswith("speech-"):
                self.model_id.set("eleven_multilingual_v2")
                self.model_label.set("Eleven Multilingual v2")
            if self.language_code.get() in ("English", ""):
                self.language_code.set("en")
            self.voice_settings.delete("1.0", END)
            self.voice_settings.insert(END, json.dumps({"stability": 0.5, "similarity_boost": 0.75, "speed": 1.0}, indent=2))

    def reset_voice_settings(self):
        self.on_provider_change()
        self.export_srt.set(False)

    def load_languages_for_provider(self):
        params = {}
        is_minimax = self.provider.get() == "minimax"
        if is_minimax:
            params["provider"] = "minimax"
        data = self.client.request("GET", "/v1/languages", params=params)
        values = []
        display_rows = []

        def add_item(item):
            if isinstance(item, dict):
                code = str(item.get("code") or item.get("language_id") or item.get("id") or "").strip()
                name = str(item.get("name") or item.get("language") or "").strip()
                value = name or code if is_minimax else code or name
                if value:
                    values.append(value)
                    display_rows.append(f"{value} - {name or code}" if (name or code) and value != (name or code) else value)
            elif item is not None:
                value = str(item).strip()
                if value:
                    values.append(value)
                    display_rows.append(value)

        if isinstance(data, list):
            for item in data:
                add_item(item)
        elif isinstance(data, dict):
            raw = data.get("languages") or data.get("data") or []
            for item in raw:
                add_item(item)
        values = [v for v in dict.fromkeys(values) if v]
        self.after(0, lambda: self.language_combo.configure(values=values))
        self.log(f"Loaded {len(values)} languages for {self.provider.get()}: {', '.join(display_rows[:8])}")

    def open_voice_selector(self):
        win = tk.Toplevel(self)
        win.title("Select a voice")
        win.geometry("1120x700")
        win.minsize(900, 540)
        rows = {}

        top = ttk.Frame(win, padding=10)
        top.pack(fill=X)
        source = StringVar(value="shared" if self.provider.get() == "elevenlabs" else "minimax")
        search = StringVar()
        language = StringVar(value="" if self.provider.get() == "elevenlabs" else self.language_code.get())
        accent = StringVar()
        quality = StringVar(value="")
        gender = StringVar()
        age = StringVar()
        sort = StringVar(value="trending")

        source_values = ("shared", "default") if self.provider.get() == "elevenlabs" else ("minimax",)
        controls = [
            ("Library", ttk.Combobox(top, textvariable=source, values=source_values, state="readonly", width=12)),
            ("Language", ttk.Entry(top, textvariable=language, width=16)),
            ("Accent", ttk.Entry(top, textvariable=accent, width=16)),
            ("Quality", ttk.Combobox(top, textvariable=quality, values=("", "high_quality"), width=14)),
            ("Gender", ttk.Combobox(top, textvariable=gender, values=("", "male", "female", "neutral", "Male", "Female"), width=12)),
            ("Age", ttk.Combobox(top, textvariable=age, values=("", "young", "middle_aged", "old", "Young", "Middle-aged"), width=14)),
            ("Sort", ttk.Combobox(top, textvariable=sort, values=("trending", "created_date", "cloned_by_count", "usage_character_count_1y"), width=18)),
        ]
        for col, (label, widget) in enumerate(controls):
            ttk.Label(top, text=label).grid(row=0, column=col, sticky="w", padx=(0, 8))
            widget.grid(row=1, column=col, sticky="ew", padx=(0, 12))
        ttk.Label(top, text="Search").grid(row=2, column=0, sticky="w", pady=(8, 0))
        search_entry = ttk.Entry(top, textvariable=search)
        search_entry.grid(row=3, column=0, columnspan=6, sticky="ew", pady=(0, 8))

        table = ttk.Treeview(win, columns=("name", "voice_id", "meta", "description"), show="headings")
        for col, text, width in (("name", "Voice", 260), ("voice_id", "Voice ID / uniq_id", 220), ("meta", "Tags", 220), ("description", "Description", 360)):
            table.heading(col, text=text)
            table.column(col, width=width)
        table.pack(fill=BOTH, expand=True, padx=10, pady=(0, 10))

        bottom = ttk.Frame(win, padding=10)
        bottom.pack(fill=X)
        status = StringVar(value="Click Load to fetch voices.")
        ttk.Label(bottom, textvariable=status).pack(side=LEFT)

        def build_params():
            params = {"page_size": 30}
            if search.get().strip():
                params["search"] = search.get().strip()
            if self.provider.get() == "minimax":
                params["page"] = 1
                for key, var in (("language", language), ("accent", accent), ("gender", gender), ("age", age)):
                    if var.get().strip():
                        params[key] = var.get().strip()
                return "/v1/minimax/system-voices", params
            if source.get() == "default":
                return "/v1/default-voices", params
            params["page"] = 0
            params["sort"] = sort.get() or "trending"
            if quality.get().strip():
                params["category"] = quality.get().strip()
            if gender.get().strip():
                params["gender"] = gender.get().strip().lower()
            if age.get().strip():
                params["age"] = age.get().strip()
            if accent.get().strip():
                params["accent"] = accent.get().strip()
            if language.get().strip():
                params["required_languages"] = language.get().strip()
            return "/v1/shared-voices", params

        def fill(data):
            table.delete(*table.get_children())
            rows.clear()
            items = []
            if isinstance(data, dict):
                items = data.get("voices") or data.get("voice_list") or data.get("data") or []
            elif isinstance(data, list):
                items = data
            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                vid = item.get("voice_id") or item.get("uniq_id") or item.get("id") or ""
                name = item.get("name") or item.get("voice_name") or vid
                tags = item.get("tag_list") or []
                meta_bits = [item.get("accent"), item.get("gender"), item.get("age"), item.get("language")]
                meta = ", ".join([str(x) for x in meta_bits if x] + [str(x) for x in tags[:4]])
                desc = item.get("description") or item.get("descriptive") or ""
                iid = str(idx)
                rows[iid] = item
                table.insert("", END, iid=iid, values=(name, vid, meta, desc))
            status.set(f"Loaded {len(rows)} voices.")

        def load():
            path, params = build_params()
            status.set("Loading...")

            def worker():
                try:
                    data = self.client.request("GET", path, params=params)
                    self.after(0, lambda: fill(data))
                except Exception as exc:
                    self.after(0, lambda: status.set(f"Error: {exc}"))
                    self.log(f"Voice load error: {exc}")

            threading.Thread(target=worker, daemon=True).start()

        def use_selected():
            selected = table.selection()
            if not selected:
                return
            item = rows[selected[0]]
            vid = item.get("voice_id") or item.get("uniq_id") or item.get("id") or ""
            self.voice_id.set(str(vid))
            self.voice_label.set(compact_voice_label(item))
            if self.provider.get() == "minimax":
                tags = item.get("tag_list") or []
                if tags:
                    self.language_code.set(str(tags[0]))
            else:
                langs = item.get("verified_languages") or []
                if langs and isinstance(langs[0], dict):
                    self.language_code.set(str(langs[0].get("language_id") or self.language_code.get()))
            win.destroy()

        def open_preview():
            selected = table.selection()
            if not selected:
                return
            item = rows[selected[0]]
            url = item.get("preview_url") or item.get("sample_audio") or item.get("sample_audio_url")
            if url:
                webbrowser.open(str(url))
            else:
                status.set("Selected voice has no preview URL.")

        table.bind("<Double-1>", lambda _event: use_selected())
        ttk.Button(bottom, text="Load", command=load).pack(side=RIGHT, padx=(4, 0))
        ttk.Button(bottom, text="Use selected", command=use_selected).pack(side=RIGHT)
        ttk.Button(bottom, text="Play preview", command=open_preview).pack(side=RIGHT, padx=(0, 4))
        search_entry.bind("<Return>", lambda _event: load())
        load()

    def open_model_selector(self):
        win = tk.Toplevel(self)
        win.title("Select a model")
        win.geometry("720x560")
        rows = {}
        top = ttk.Frame(win, padding=10)
        top.pack(fill=X)
        status = StringVar(value="Loading models...")
        ttk.Label(top, textvariable=status).pack(side=LEFT)
        table = ttk.Treeview(win, columns=("name", "model_id", "description", "languages"), show="headings")
        for col, text, width in (("name", "Model", 180), ("model_id", "Model ID", 190), ("description", "Description", 260), ("languages", "Languages", 160)):
            table.heading(col, text=text)
            table.column(col, width=width)
        table.pack(fill=BOTH, expand=True, padx=10, pady=10)
        bottom = ttk.Frame(win, padding=10)
        bottom.pack(fill=X)

        def fill(data):
            table.delete(*table.get_children())
            rows.clear()
            items = data if isinstance(data, list) else data.get("models", []) if isinstance(data, dict) else []
            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                langs = item.get("languages") or []
                lang_names = []
                for lang in langs[:3]:
                    if isinstance(lang, dict):
                        lang_names.append(str(lang.get("name") or lang.get("language_id") or ""))
                    else:
                        lang_names.append(str(lang))
                more = f" +{len(langs) - 3} more" if len(langs) > 3 else ""
                iid = str(idx)
                rows[iid] = item
                table.insert("", END, iid=iid, values=(model_label(item), item.get("model_id", ""), item.get("description", ""), ", ".join(lang_names) + more))
            status.set(f"Loaded {len(rows)} models for {self.provider.get()}.")

        def load():
            params = {"provider": "minimax"} if self.provider.get() == "minimax" else {}

            def worker():
                try:
                    data = self.client.request("GET", "/v1/models", params=params)
                    self.after(0, lambda: fill(data))
                except Exception as exc:
                    self.after(0, lambda: status.set(f"Error: {exc}"))
                    self.log(f"Model load error: {exc}")

            threading.Thread(target=worker, daemon=True).start()

        def use_selected():
            selected = table.selection()
            if not selected:
                return
            item = rows[selected[0]]
            mid = item.get("model_id") or ""
            self.model_id.set(str(mid))
            self.model_label.set(model_label(item))
            langs = item.get("languages") or []
            if langs and isinstance(langs[0], dict):
                self.language_code.set(str(langs[0].get("language_id") or self.language_code.get()))
            win.destroy()

        table.bind("<Double-1>", lambda _event: use_selected())
        ttk.Button(bottom, text="Refresh", command=load).pack(side=RIGHT, padx=(4, 0))
        ttk.Button(bottom, text="Use selected", command=use_selected).pack(side=RIGHT)
        load()

    def pick_batch(self):
        path = filedialog.askopenfilename(filetypes=[("Text files", "*.txt"), ("All files", "*.*")])
        if path:
            self.load_batch_file(path)

    def load_sample_batch(self):
        self.load_batch_file(APP_DIR / "sample_batch.txt")

    def load_batch_file(self, path):
        path = Path(path)
        self.batch_file.set(str(path))
        rows = []
        for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            parsed = parse_batch_line(line)
            if parsed:
                rows.append((*parsed, line_no, "Waiting"))
            else:
                self.log(f"TXT line {line_no} sai dinh dang, can: tenfile|nhanvat|cau")
        self.populate_batch_preview(rows)
        self.log(f"Imported {len(rows)} TXT rows from {path.name}")

    def populate_batch_preview(self, rows, reset_filter=True, update_master=True):
        normalized_rows = []
        for row in rows:
            if len(row) == 4:
                file_name, character, text, line_no = row
                status = "Waiting"
            else:
                file_name, character, text, line_no, status = row
            normalized_rows.append((file_name, character, text, line_no, status))
        if update_master:
            self.batch_rows = normalized_rows
        if reset_filter:
            characters = sorted({character for _file_name, character, _text, _line_no, _status in self.batch_rows if character})
            values = ["All"] + characters
            self.batch_filter_character.set("All")
            self.batch_filter_status.set("All")
            if hasattr(self, "batch_filter_combo"):
                self.batch_filter_combo.configure(values=values)
        self.apply_batch_filter()

    def visible_batch_rows(self):
        selected_character = self.batch_filter_character.get()
        selected_status = self.batch_filter_status.get()
        rows = list(self.batch_rows)
        if selected_character and selected_character != "All":
            rows = [row for row in rows if row[1] == selected_character]
        if selected_status and selected_status != "All":
            rows = [row for row in rows if str(row[4]).startswith(selected_status)]
        return rows

    def apply_batch_filter(self):
        rows = self.visible_batch_rows()
        self.batch_preview.delete(*self.batch_preview.get_children())
        for idx, (file_name, character, text, line_no, status) in enumerate(rows, 1):
            self.batch_preview.insert("", END, iid=str(line_no), values=(file_name, character, text, status))
        self.log(f"Showing {len(rows)} rows for filters: character={self.batch_filter_character.get()}, status={self.batch_filter_status.get()}")

    def clear_batch_rows(self):
        self.batch_rows = []
        self.batch_filter_character.set("All")
        self.batch_filter_status.set("All")
        if hasattr(self, "batch_filter_combo"):
            self.batch_filter_combo.configure(values=("All",))
        if hasattr(self, "batch_preview"):
            self.batch_preview.delete(*self.batch_preview.get_children())
        self.batch_file.set("")
        self.log("Cleared all imported rows.")

    def set_batch_status(self, index, status):
        iid = str(index)
        updated_rows = []
        for row in self.batch_rows:
            file_name, character, text, line_no, old_status = row
            if line_no == index:
                updated_rows.append((file_name, character, text, line_no, status))
            else:
                updated_rows.append(row)
        self.batch_rows = updated_rows
        if not hasattr(self, "batch_preview"):
            return
        if self.batch_preview.exists(iid):
            values = list(self.batch_preview.item(iid, "values"))
            while len(values) < 4:
                values.append("")
            values[3] = status
            self.batch_preview.item(iid, values=values)
            self.batch_preview.see(iid)

    def get_batch_worker_count(self):
        try:
            workers = int(str(self.batch_workers.get()).strip())
        except Exception:
            workers = 1
        return max(1, min(100, workers))

    def show_batch_complete(self, total, counts):
        success = counts.get("success", 0)
        failed = counts.get("failed", 0)
        skipped = counts.get("skipped", 0)
        message = (
            f"Batch da hoan tat.\n\n"
            f"Tong dong chay: {total}\n"
            f"Thanh cong: {success}\n"
            f"Loi: {failed}\n"
            f"Bo qua: {skipped}"
        )
        messagebox.showinfo("Batch complete", message)

    def pick_output_dir(self):
        path = filedialog.askdirectory()
        if path:
            self.output_dir.set(path)

    def edit_character(self):
        selected = self.char_tree.selection()
        values = self.char_tree.item(selected[0], "values") if selected else ("", self.provider.get(), self.voice_id.get(), self.model_id.get(), self.language_code.get())
        win = tk.Toplevel(self)
        win.title("Character voice")
        vars_ = [StringVar(value=v) for v in values]
        labels = ("Character", "Provider", "Voice ID", "Model ID", "Language")
        for idx, label in enumerate(labels):
            ttk.Label(win, text=label).grid(row=idx, column=0, sticky="w", padx=8, pady=4)
            ttk.Entry(win, textvariable=vars_[idx], width=48).grid(row=idx, column=1, padx=8, pady=4)

        def save():
            vals = tuple(v.get().strip() for v in vars_)
            if not vals[0] or not vals[2]:
                messagebox.showwarning("Missing", "Character and Voice ID are required.")
                return
            if selected:
                self.char_tree.item(selected[0], values=vals)
            else:
                self.char_tree.insert("", END, values=vals)
            win.destroy()

        ttk.Button(win, text="Save", command=save).grid(row=len(labels), column=1, sticky="e", padx=8, pady=8)

    def delete_character(self):
        for item in self.char_tree.selection():
            self.char_tree.delete(item)

    def get_character_map(self):
        out = []
        for iid in self.char_tree.get_children():
            char, provider, voice, model, lang = self.char_tree.item(iid, "values")
            out.append({"character": char, "provider": provider, "voice_id": voice, "model_id": model, "language_code": lang})
        return out

    def character_config(self, character):
        for item in self.get_character_map():
            if item["character"].strip().lower() == character.strip().lower():
                return item
        return {
            "character": character,
            "provider": self.provider.get(),
            "voice_id": self.voice_id.get(),
            "model_id": self.model_id.get(),
            "language_code": self.language_code.get(),
        }

    def run_batch_tts(self):
        path = Path(self.batch_file.get())
        if not path.exists() and not self.batch_rows:
            raise RuntimeError("TXT file not found.")
        output = Path(self.output_dir.get())
        output.mkdir(parents=True, exist_ok=True)
        workers = self.get_batch_worker_count()
        if self.batch_rows:
            rows = self.visible_batch_rows()
            self.log(f"Using current filtered rows without replacing imported list: {len(rows)} rows")
        else:
            rows = []
            for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
                line = line.strip()
                if not line:
                    continue
                parsed = parse_batch_line(line)
                if parsed:
                    rows.append((*parsed, line_no, "Waiting"))
                else:
                    self.log(f"Skip line {line_no}: wrong format")
            self.after(0, lambda r=rows: self.populate_batch_preview(r))
        settings = parse_json(self.voice_settings.get("1.0", END), {})
        character_items = self.get_character_map()
        character_map = {item["character"].strip().lower(): item for item in character_items}
        default_conf = {
            "provider": self.provider.get(),
            "voice_id": self.voice_id.get(),
            "model_id": self.model_id.get(),
            "language_code": self.language_code.get(),
        }
        export_transcript = self.export_srt.get()
        active_filter = self.batch_filter_character.get()
        self.log(f"Batch started: {len(rows)} lines, {workers} workers, filter: {active_filter}")

        def process_row(position, row):
            self.set_thread_api_key()
            file_name, character, text, line_no, _status = row
            self.after(0, lambda i=line_no: self.set_batch_status(i, "Running"))
            conf = character_map.get(character.strip().lower(), default_conf)
            if not conf["voice_id"]:
                self.log(f"Skip line {line_no}: missing voice_id for {character}")
                self.after(0, lambda i=line_no: self.set_batch_status(i, "Skipped: missing voice"))
                self.clear_thread_api_key()
                return "skipped"
            payload = {
                "text": text,
                "model_id": conf["model_id"] or default_conf["model_id"],
                "provider": conf["provider"] or default_conf["provider"],
                "language_code": conf["language_code"] or default_conf["language_code"],
                "voice_settings": settings,
                "export_transcript": export_transcript,
            }
            try:
                self.log(f"{position}/{len(rows)} submit line {line_no} {character}: {file_name}")
                self.after(0, lambda i=line_no: self.set_batch_status(i, "Submitted"))
                task = self.client.request("POST", f"/v1/text-to-speech/{conf['voice_id']}", json_body=payload)
                task_id = extract_task_id(task)
                if not task_id:
                    self.log(f"No task id: {task}")
                    self.after(0, lambda i=line_no: self.set_batch_status(i, "Failed: no task id"))
                    return "failed"
                self.after(0, lambda i=line_no, tid=task_id: self.set_batch_status(i, f"Processing {tid[:8]}"))
                detail = self.poll_task("/v1/history/{id}", task_id, row_index=line_no)
                url = result_url(detail)
                if not url:
                    self.log(f"No result URL for {task_id}: {json.dumps(detail, ensure_ascii=False)[:500]}")
                    self.after(0, lambda i=line_no: self.set_batch_status(i, "Failed: no result URL"))
                    return "failed"
                self.after(0, lambda i=line_no: self.set_batch_status(i, "Downloading"))
                ext = ".mp3"
                if ".wav" in url.lower():
                    ext = ".wav"
                clean_name = safe_filename(file_name)
                target = output / (clean_name if Path(clean_name).suffix else f"{clean_name}{ext}")
                self.client.download(url, target)
                self.log(f"Saved {target}")
                result = detail.get("result", {}) if isinstance(detail, dict) else {}
                if export_transcript and isinstance(result, dict) and result.get("srt_url"):
                    srt_target = output / f"{safe_filename(file_name)}.srt"
                    self.client.download(result["srt_url"], srt_target)
                    self.log(f"Saved {srt_target}")
                self.after(0, lambda i=line_no: self.set_batch_status(i, "Done"))
                self.refresh_credits_silent()
                self.clear_thread_api_key()
                return "success"
            except Exception as exc:
                self.log(f"Line {line_no} failed: {exc}")
                self.after(0, lambda i=line_no, e=exc: self.set_batch_status(i, f"Failed: {str(e)[:80]}"))
                self.refresh_credits_silent()
                self.clear_thread_api_key()
                return "failed"

        counts = Counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = []
            for position, row in enumerate(rows, 1):
                line_no = row[3]
                self.after(0, lambda i=line_no: self.set_batch_status(i, "Queued"))
                futures.append(executor.submit(process_row, position, row))
            for future in concurrent.futures.as_completed(futures):
                counts[future.result()] += 1
        self.log(f"Batch done: success={counts.get('success', 0)}, failed={counts.get('failed', 0)}, skipped={counts.get('skipped', 0)}")
        self.refresh_credits_silent()
        self.after(0, lambda total=len(rows), c=counts.copy(): self.show_batch_complete(total, c))

    def poll_task(self, detail_path_template, task_id, max_wait=900, row_index=None):
        started = time.time()
        last_log_state = None
        while True:
            detail = self.client.request("GET", detail_path_template.replace("{id}", task_id))
            status = str(detail.get("status", "")).lower() if isinstance(detail, dict) else ""
            progress = detail.get("progress", "") if isinstance(detail, dict) else ""
            elapsed = int(time.time() - started)
            log_state = (status, progress, elapsed // 30)
            if log_state != last_log_state:
                progress_text = f"{progress}%" if progress not in ("", None) else "no progress"
                self.log(f"Task {task_id}: {status or 'processing'} {progress_text}, waited {elapsed}s")
                last_log_state = log_state
            if row_index is not None:
                label = status.title() if status else "Processing"
                if progress not in ("", None, 0, "0"):
                    label = f"{label} {progress}%"
                else:
                    label = f"{label}, waited {elapsed}s"
                self.after(0, lambda i=row_index, s=label: self.set_batch_status(i, s))
            if status in ("completed", "failed", "done", "success"):
                if status == "failed":
                    raise RuntimeError(f"Task failed: {detail.get('error')}")
                return detail
            if time.time() - started > max_wait:
                raise RuntimeError(f"Timeout waiting for task {task_id}")
            time.sleep(3)

    def build_voices_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="Voices & Models")
        controls = ttk.Frame(tab)
        controls.pack(fill=X)
        self.voice_source = StringVar(value="/v1/shared-voices")
        values = ["/v1/shared-voices", "/v1/default-voices", "/v1/minimax/system-voices", "/v1/minimax/voices", "/v1/models", "/v1/languages"]
        ttk.Combobox(controls, textvariable=self.voice_source, values=values, state="readonly", width=30).pack(side=LEFT)
        self.voice_params = tk.Text(controls, height=3, width=70)
        self.voice_params.insert(END, '{"page_size": 30, "sort": "trending"}')
        self.voice_params.pack(side=LEFT, padx=6)
        ttk.Button(controls, text="Load", command=lambda: self.run_thread(self.load_voices)).pack(side=LEFT)
        self.voice_output = tk.Text(tab, wrap="none")
        self.voice_output.pack(fill=BOTH, expand=True, pady=6)

    def load_voices(self):
        data = self.client.request("GET", self.voice_source.get(), params=parse_params(self.voice_params.get("1.0", END)))
        self.set_text(self.voice_output, json.dumps(data, ensure_ascii=False, indent=2))

    def build_history_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="History")
        row = ttk.Frame(tab)
        row.pack(fill=X)
        self.history_type = StringVar(value="tts")
        ttk.Combobox(row, textvariable=self.history_type, values=("tts", "voice-changer", "dubbing"), state="readonly", width=18).pack(side=LEFT)
        self.history_id = StringVar()
        ttk.Entry(row, textvariable=self.history_id, width=44).pack(side=LEFT, padx=6)
        ttk.Button(row, text="List", command=lambda: self.run_thread(self.history_list)).pack(side=LEFT)
        ttk.Button(row, text="Detail", command=lambda: self.run_thread(self.history_detail)).pack(side=LEFT, padx=4)
        ttk.Button(row, text="Retry", command=lambda: self.run_thread(self.history_retry)).pack(side=LEFT)
        ttk.Button(row, text="Delete", command=lambda: self.run_thread(self.history_delete)).pack(side=LEFT, padx=4)
        self.history_output = tk.Text(tab, wrap="none")
        self.history_output.pack(fill=BOTH, expand=True, pady=6)

    def history_base(self):
        kind = self.history_type.get()
        if kind == "voice-changer":
            return "/v1/voice-changer/history"
        if kind == "dubbing":
            return "/v1/dubbing/history"
        return "/v1/history"

    def history_list(self):
        data = self.client.request("GET", self.history_base(), params={"page_size": 30, "page": 0})
        self.set_text(self.history_output, json.dumps(data, ensure_ascii=False, indent=2))

    def history_detail(self):
        task_id = self.history_id.get().strip()
        data = self.client.request("GET", f"{self.history_base()}/{task_id}")
        self.set_text(self.history_output, json.dumps(data, ensure_ascii=False, indent=2))

    def history_retry(self):
        task_id = self.history_id.get().strip()
        data = self.client.request("POST", f"{self.history_base()}/{task_id}/retry", json_body={})
        self.set_text(self.history_output, json.dumps(data, ensure_ascii=False, indent=2))

    def history_delete(self):
        task_id = self.history_id.get().strip()
        data = self.client.request("DELETE", f"{self.history_base()}/{task_id}")
        self.set_text(self.history_output, json.dumps(data, ensure_ascii=False, indent=2))

    def build_dialogue_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="Dialogue")
        self.dialogue_text = tk.Text(tab, height=9, wrap="word")
        self.dialogue_text.insert(END, "Alice: Hello, how are you?\nBob: I am doing great.")
        self.dialogue_text.pack(fill=X)
        ttk.Label(tab, text='Speakers JSON. Keys must match "Name:" in the script.').pack(anchor="w")
        self.dialogue_speakers = tk.Text(tab, height=12, wrap="none")
        self.dialogue_speakers.insert(END, json.dumps({
            "Alice": {"provider": "elevenlabs", "voice_id": "", "model_id": "eleven_multilingual_v2", "language_code": "en", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "speed": 1.0}},
            "Bob": {"provider": "minimax", "voice_id": "English_ManWithDeepVoice", "model_id": "speech-2.8-turbo", "language_code": "English", "voice_settings": {"speed": 1.0, "pitch": 0, "vol": 1.0}},
        }, ensure_ascii=False, indent=2))
        self.dialogue_speakers.pack(fill=BOTH, expand=True)
        row = ttk.Frame(tab)
        row.pack(fill=X, pady=6)
        self.pause_between = StringVar(value="0.5")
        ttk.Label(row, text="Pause").pack(side=LEFT)
        ttk.Entry(row, textvariable=self.pause_between, width=8).pack(side=LEFT, padx=4)
        ttk.Button(row, text="Create dialogue", command=lambda: self.run_thread(self.create_dialogue)).pack(side=LEFT)
        ttk.Button(row, text="Create + poll + download", command=lambda: self.run_thread(self.create_dialogue_download)).pack(side=LEFT, padx=4)
        self.dialogue_output = tk.Text(tab, height=8)
        self.dialogue_output.pack(fill=X)

    def create_dialogue_payload(self):
        return {
            "text": self.dialogue_text.get("1.0", END).strip(),
            "speakers": parse_json(self.dialogue_speakers.get("1.0", END), {}),
            "pause_between_turns": float(self.pause_between.get() or 0),
        }

    def create_dialogue(self):
        data = self.client.request("POST", "/v1/dialogue", json_body=self.create_dialogue_payload())
        self.set_text(self.dialogue_output, json.dumps(data, ensure_ascii=False, indent=2))

    def create_dialogue_download(self):
        data = self.client.request("POST", "/v1/dialogue", json_body=self.create_dialogue_payload())
        task_id = extract_task_id(data)
        detail = self.poll_task("/v1/history/{id}", task_id)
        url = result_url(detail)
        if not url:
            raise RuntimeError("No result URL.")
        output = Path(self.output_dir.get())
        output.mkdir(parents=True, exist_ok=True)
        target = output / f"dialogue_{task_id}.mp3"
        self.client.download(url, target)
        self.set_text(self.dialogue_output, json.dumps(detail, ensure_ascii=False, indent=2))
        self.log(f"Saved {target}")
        self.refresh_credits_silent()

    def build_stt_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="Speech To Text")
        row = ttk.Frame(tab)
        row.pack(fill=X)
        self.stt_file = StringVar()
        ttk.Entry(row, textvariable=self.stt_file).pack(side=LEFT, fill=X, expand=True)
        ttk.Button(row, text="Audio/video file", command=lambda: self.pick_file(self.stt_file)).pack(side=LEFT, padx=4)
        self.stt_options = tk.Text(tab, height=8)
        self.stt_options.insert(END, json.dumps({"language_code": "", "timestamps_granularity": "word", "diarize": False, "num_speakers": "", "no_verbatim": False, "additional_formats": ["srt", "txt"]}, indent=2))
        self.stt_options.pack(fill=X, pady=6)
        ttk.Button(tab, text="Transcribe", command=lambda: self.run_thread(self.speech_to_text)).pack(anchor="w")
        self.stt_output = tk.Text(tab, wrap="word")
        self.stt_output.pack(fill=BOTH, expand=True, pady=6)

    def speech_to_text(self):
        path = Path(self.stt_file.get())
        data_opts = parse_json(self.stt_options.get("1.0", END), {})
        form = []
        for key, value in data_opts.items():
            if value in ("", None):
                continue
            if isinstance(value, bool):
                form.append((key, "true" if value else "false"))
            elif isinstance(value, list):
                for item in value:
                    form.append((key, str(item)))
            else:
                form.append((key, str(value)))
        with open(path, "rb") as f:
            data = self.client.request("POST", "/v1/speech-to-text", files={"file": (path.name, f, mimetypes.guess_type(path)[0] or "application/octet-stream")}, data=form)
        self.set_text(self.stt_output, json.dumps(data, ensure_ascii=False, indent=2))
        self.refresh_credits_silent()
        output = Path(self.output_dir.get())
        output.mkdir(parents=True, exist_ok=True)
        if isinstance(data, dict) and data.get("text"):
            (output / f"{safe_filename(path.stem)}.txt").write_text(data["text"], encoding="utf-8")
        for fmt in data.get("additional_formats", []) if isinstance(data, dict) else []:
            ext = fmt.get("file_extension")
            content = fmt.get("content")
            if ext and content:
                (output / f"{safe_filename(path.stem)}.{ext}").write_text(content, encoding="utf-8")

    def build_audio_tools_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="Audio Tools")
        self.audio_action = StringVar(value="voice_changer")
        ttk.Combobox(tab, textvariable=self.audio_action, values=("voice_changer", "dubbing", "clone_minimax_voice"), state="readonly").pack(anchor="w")
        row = ttk.Frame(tab)
        row.pack(fill=X, pady=6)
        self.audio_file = StringVar()
        ttk.Entry(row, textvariable=self.audio_file).pack(side=LEFT, fill=X, expand=True)
        ttk.Button(row, text="Pick file", command=lambda: self.pick_file(self.audio_file)).pack(side=LEFT, padx=4)
        ttk.Label(tab, text="Options JSON").pack(anchor="w")
        self.audio_options = tk.Text(tab, height=13)
        self.audio_options.insert(END, json.dumps({
            "voice_changer": {"voice_id": "", "model_id": "eleven_multilingual_sts_v2", "remove_background_noise": "true", "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
            "dubbing": {"target_language": "vi", "source_language": "auto", "num_speakers": 0},
            "clone_minimax_voice": {"voice_name": "My Voice", "language_tag": "English", "gender": "Male", "need_noise_reduction": True, "preview_text": "Hello, this is a test"},
        }, ensure_ascii=False, indent=2))
        self.audio_options.pack(fill=X)
        ttk.Button(tab, text="Run", command=lambda: self.run_thread(self.run_audio_tool)).pack(anchor="w", pady=6)
        self.audio_output = tk.Text(tab, wrap="none")
        self.audio_output.pack(fill=BOTH, expand=True)

    def run_audio_tool(self):
        action = self.audio_action.get()
        path = Path(self.audio_file.get())
        opts_all = parse_json(self.audio_options.get("1.0", END), {})
        opts = opts_all.get(action, opts_all)
        endpoint = {"voice_changer": "/v1/voice-changer", "dubbing": "/v1/dubbing", "clone_minimax_voice": "/v1/minimax/voices/clone"}[action]
        file_field = "file" if action == "clone_minimax_voice" else "audio"
        data = {}
        for key, value in opts.items():
            if isinstance(value, (dict, list)):
                data[key] = json.dumps(value, ensure_ascii=False)
            elif isinstance(value, bool):
                data[key] = "true" if value else "false"
            else:
                data[key] = str(value)
        with open(path, "rb") as f:
            result = self.client.request("POST", endpoint, files={file_field: (path.name, f, mimetypes.guess_type(path)[0] or "application/octet-stream")}, data=data)
        self.set_text(self.audio_output, json.dumps(result, ensure_ascii=False, indent=2))
        self.refresh_credits_silent()

    def build_generic_tab(self):
        tab = ttk.Frame(self.tabs, padding=8)
        self.tabs.add(tab, text="Generic API")
        row = ttk.Frame(tab)
        row.pack(fill=X)
        self.generic_method = StringVar(value="GET")
        self.generic_path = StringVar(value="/v1/models")
        ttk.Combobox(row, textvariable=self.generic_method, values=("GET", "POST", "PUT", "DELETE", "PATCH"), width=8).pack(side=LEFT)
        ttk.Entry(row, textvariable=self.generic_path).pack(side=LEFT, fill=X, expand=True, padx=6)
        ttk.Button(row, text="Send", command=lambda: self.run_thread(self.generic_send)).pack(side=LEFT)
        endpoint_text = "\n".join(f"{m:6} {p:38} {d}" for m, p, d in ENDPOINTS)
        panes = ttk.PanedWindow(tab, orient=tk.HORIZONTAL)
        panes.pack(fill=BOTH, expand=True, pady=6)
        left = ttk.Frame(panes)
        right = ttk.Frame(panes)
        panes.add(left, weight=1)
        panes.add(right, weight=1)
        ttk.Label(left, text="Query params JSON or key=value lines").pack(anchor="w")
        self.generic_params = tk.Text(left, height=5)
        self.generic_params.pack(fill=X)
        ttk.Label(left, text="JSON body").pack(anchor="w")
        self.generic_body = tk.Text(left, height=12)
        self.generic_body.pack(fill=BOTH, expand=True)
        ttk.Label(left, text="File path for multipart upload (optional)").pack(anchor="w")
        file_row = ttk.Frame(left)
        file_row.pack(fill=X)
        self.generic_file = StringVar()
        self.generic_file_field = StringVar(value="file")
        ttk.Entry(file_row, textvariable=self.generic_file).pack(side=LEFT, fill=X, expand=True)
        ttk.Entry(file_row, textvariable=self.generic_file_field, width=10).pack(side=LEFT, padx=4)
        ttk.Button(file_row, text="Pick", command=lambda: self.pick_file(self.generic_file)).pack(side=LEFT)
        self.generic_output = tk.Text(right, wrap="none")
        self.generic_output.pack(fill=BOTH, expand=True)
        self.generic_output.insert(END, endpoint_text)

    def generic_send(self):
        params = parse_params(self.generic_params.get("1.0", END))
        body = parse_json(self.generic_body.get("1.0", END), None)
        file_path = self.generic_file.get().strip()
        if file_path:
            path = Path(file_path)
            data = {}
            if isinstance(body, dict):
                for key, value in body.items():
                    data[key] = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
            with open(path, "rb") as f:
                result = self.client.request(self.generic_method.get(), self.generic_path.get(), params=params, files={self.generic_file_field.get(): (path.name, f)}, data=data)
        else:
            result = self.client.request(self.generic_method.get(), self.generic_path.get(), params=params, json_body=body)
        self.set_text(self.generic_output, json.dumps(result, ensure_ascii=False, indent=2))
        if self.generic_method.get().upper() != "GET":
            self.refresh_credits_silent()

    def pick_file(self, var):
        path = filedialog.askopenfilename(filetypes=[("All files", "*.*")])
        if path:
            var.set(path)

    def set_text(self, widget, text):
        self.after(0, lambda: (widget.delete("1.0", END), widget.insert(END, text)))


if __name__ == "__main__":
    App().mainloop()
