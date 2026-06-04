"""
Config service - load/save config.json and settings.json.
Adapted from RUN_VEO_4.0 SettingsManager.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import Any


def _resolve_base_dir() -> Path:
    nuitka_parent = os.environ.get("NUITKA_ONEFILE_PARENT", "")
    if nuitka_parent:
        base = Path(nuitka_parent).resolve().parent
        print(f"[config] Nuitka onefile -> BASE_DIR={base!r}", flush=True)
        return base

    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
        print(f"[config] PyInstaller frozen -> BASE_DIR={base!r}", flush=True)
        return base

    base = Path(__file__).resolve().parent.parent
    print(f"[config] Dev mode -> BASE_DIR={base!r}", flush=True)
    return base


BASE_DIR = _resolve_base_dir()
CONFIG_DIR = BASE_DIR / "config"
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = CONFIG_DIR / "config.json"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
CHROME_USER_DATA_ROOT = BASE_DIR / "chrome_user_data"
CLOAK_USER_DATA_ROOT = BASE_DIR / "cloak_user_data"
_CONFIG_LOCK = threading.RLock()

# Ensure dirs exist at import time
for _p in (
    CONFIG_DIR,
    DATA_DIR,
    DATA_DIR / "jobs",
    DATA_DIR / "characters",
    DATA_DIR / "media_cache",
    CHROME_USER_DATA_ROOT,
    CLOAK_USER_DATA_ROOT,
):
    _p.mkdir(parents=True, exist_ok=True)


_DEFAULT_CONFIG: dict = {
    "account1": {
        "TYPE_ACCOUNT": "ULTRA",
        "ACCESS_TOKEN": "",
        "COOKIE": "",
        "PROJECT_ID": "",
        "PROFILE_NAME": "PROFILE_1",
        "ENABLED": True,
    },
    "GEMINI_API_KEY": "",
    "YOUTUBE_API_KEY": "",
    "SEED_MODE": "Random",
    "SEED_VALUE": 9797,
    "CREATE_IMAGE_MODEL": "Imagen 4",
    "TOKEN_OPTION": "Option 1",
    "LICENSE_TOKEN": "",
    "FFMPEG_PATH": "",
    "MAX_CONCURRENT": 2,
    "MAX_CONCURRENT_IMAGE": 2,
    "MAX_CONCURRENT_GROK": 2,
}

_DEFAULT_SETTINGS: dict = {
    "current_profile": "PROFILE_1",
    "theme": "dark",
    "language": "vi",
}


def load_config() -> dict:
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                # Merge missing defaults
                merged = dict(_DEFAULT_CONFIG)
                merged.update(data)
                return merged
    except Exception:
        pass
    return dict(_DEFAULT_CONFIG)


def save_config(config: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def get_config_value(key: str, default: Any = None) -> Any:
    return load_config().get(key, default)


def set_config_value(key: str, value: Any) -> None:
    cfg = load_config()
    cfg[key] = value
    save_config(cfg)


def load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return dict(_DEFAULT_SETTINGS)


def save_settings(settings: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def get_account(index: int = 1) -> dict:
    """Get account by 1-based index."""
    cfg = load_config()
    return cfg.get(f"account{index}", {})


def get_all_accounts(max_accounts: int = 10) -> list[dict]:
    """Return list of all configured accounts with index."""
    cfg = load_config()
    accounts = []
    for i in range(1, max_accounts + 1):
        key = f"account{i}"
        if key in cfg:
            acc = dict(cfg[key])
            acc["_index"] = i
            acc["_key"] = key
            accounts.append(acc)
    return accounts


def get_active_accounts() -> list[dict]:
    """Return accounts that have an ACCESS_TOKEN."""
    return [
        a for a in get_all_accounts()
        if a.get("ENABLED", True) is not False and a.get("ACCESS_TOKEN", "").strip()
    ]


def save_account(index: int, account_data: dict) -> None:
    with _CONFIG_LOCK:
        cfg = load_config()
        cfg[f"account{index}"] = account_data
        save_config(cfg)


def get_gemini_keys() -> list[str]:
    """Return list of Gemini API keys (support multiple keys, newline-separated)."""
    cfg = load_config()
    raw = cfg.get("GEMINI_API_KEYS") or cfg.get("GEMINI_API_KEY") or ""
    return [k.strip() for k in str(raw).splitlines() if k.strip()]


def get_chrome_userdata_path(profile_name: str | None = None) -> str:
    settings = load_settings()
    profile = profile_name or settings.get("current_profile", "PROFILE_1")
    path = CHROME_USER_DATA_ROOT / str(profile)
    path.mkdir(parents=True, exist_ok=True)
    return str(path)
