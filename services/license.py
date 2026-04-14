"""
License service — RS256 JWT + BIOS UUID machine binding.

Flow:
  Admin generates RSA keypair, signs JWT {token_uuid, exp, iat} with private key.
  Tool embeds public key, validates token on every protected route.
"""
from __future__ import annotations

import subprocess
import time
import uuid as _uuid
from datetime import datetime, timezone
from functools import wraps
from typing import Callable

import jwt
from cryptography.hazmat.primitives import serialization

# ---------------------------------------------------------------------------
# Public key — embedded. Replace with real public key after keygen.
# ---------------------------------------------------------------------------
_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0PLACEHOLDER0000000000
00000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000
AQAB
-----END PUBLIC KEY-----"""

# Set to True to bypass license check during development
_DEV_MODE = True

# Runtime state
_license_valid: bool = False
_license_payload: dict = {}
_runtime_key: str = str(_uuid.uuid4().hex)  # Anti-direct-call guard


# ---------------------------------------------------------------------------
# UUID helpers
# ---------------------------------------------------------------------------

def get_bios_uuid() -> str:
    """Get machine UUID via WMI chain (Windows). Fallback to all-F UUID."""
    # Method 1: Win32_ComputerSystemProduct UUID
    try:
        result = subprocess.run(
            ["wmic", "csproduct", "get", "UUID", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("UUID="):
                val = line.split("=", 1)[1].strip()
                if val and val != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF":
                    return val.upper()
    except Exception:
        pass

    # Method 2: Win32_BaseBoard SerialNumber
    try:
        result = subprocess.run(
            ["wmic", "baseboard", "get", "SerialNumber", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("SerialNumber="):
                val = line.split("=", 1)[1].strip()
                if val and val not in ("", "None", "Default string"):
                    return val.upper()
    except Exception:
        pass

    # Method 3: Win32_DiskDrive SerialNumber
    try:
        result = subprocess.run(
            ["wmic", "diskdrive", "get", "SerialNumber", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("SerialNumber="):
                val = line.split("=", 1)[1].strip()
                if val and val not in ("", "None"):
                    return val.upper()
    except Exception:
        pass

    return "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_license(token: str) -> tuple[bool, str]:
    """
    Validate license token.
    Returns (is_valid, message).
    """
    global _license_valid, _license_payload

    if _DEV_MODE:
        _license_valid = True
        _license_payload = {"token_uuid": "DEV", "exp": 9999999999, "iat": 0}
        return True, "Dev mode — license bypassed"

    if not token or not token.strip():
        _license_valid = False
        return False, "Chưa có license token"

    try:
        public_key = serialization.load_pem_public_key(_PUBLIC_KEY_PEM.encode())
        payload = jwt.decode(
            token.strip(),
            public_key,
            algorithms=["RS256"],
            options={"verify_exp": False},  # manual exp check below
        )
    except jwt.exceptions.InvalidSignatureError:
        _license_valid = False
        return False, "Token không hợp lệ (sai chữ ký)"
    except jwt.exceptions.DecodeError as e:
        _license_valid = False
        return False, f"Token không đọc được: {e}"
    except Exception as e:
        _license_valid = False
        return False, f"Lỗi kiểm tra token: {e}"

    # Check expiry
    exp = payload.get("exp", 0)
    if time.time() > exp:
        exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d")
        _license_valid = False
        return False, f"Token đã hết hạn từ {exp_dt}"

    # Check UUID binding
    token_uuid = str(payload.get("token_uuid", "")).strip().upper()
    machine_uuid = get_bios_uuid().upper()
    if token_uuid != machine_uuid:
        _license_valid = False
        return False, "Token không hợp lệ với máy này"

    _license_valid = True
    _license_payload = payload
    return True, "License hợp lệ"


def get_license_info() -> dict:
    """Return current license status info for UI display."""
    machine_uuid = get_bios_uuid()
    if not _license_valid:
        return {
            "valid": False,
            "machine_uuid": machine_uuid,
            "expires_at": None,
            "message": "Chưa có license hợp lệ",
            "dev_mode": _DEV_MODE,
        }
    exp = _license_payload.get("exp", 0)
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if exp else None
    return {
        "valid": True,
        "machine_uuid": machine_uuid,
        "expires_at": expires_at,
        "message": "License hợp lệ",
        "dev_mode": _DEV_MODE,
    }


def is_licensed() -> bool:
    return _license_valid or _DEV_MODE


def get_runtime_key() -> str:
    return _runtime_key


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def license_required(f: Callable) -> Callable:
    """FastAPI dependency or decorator to guard routes requiring license."""
    @wraps(f)
    async def wrapper(*args, **kwargs):
        from fastapi import HTTPException, Request
        # Find Request in kwargs or args
        request: Request | None = kwargs.get("request") or next(
            (a for a in args if hasattr(a, "headers")), None
        )
        # Check runtime key header
        if request:
            rk = request.headers.get("X-Runtime-Key", "")
            if rk != _runtime_key:
                raise HTTPException(status_code=403, detail="Unauthorized Access: Missing Runtime Key")
        if not is_licensed():
            raise HTTPException(status_code=403, detail="License không hợp lệ")
        return await f(*args, **kwargs)
    return wrapper
