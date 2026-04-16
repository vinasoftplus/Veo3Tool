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
# Public key — embedded.
# ---------------------------------------------------------------------------
_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1RuZ4HJrabE6EWOy5FF6
4S1GrmNOVhBf8X59c6/TajGchyndLZCYs6Tnxt/kdFp7gLxImyTH6OVIpShidqFp
y6ECYSNb44GbnHsTRf1pDjYpHXNR2rRpd+QjFSzF3WMaRoLwrhOA8NhES2n23Lzn
BzAN/nTHPs8LRMRDWFjMonkbp3zHnymEHIoRHStF+mozL7ENuKoZFLlEq1ffA7jQ
EpXVxPn04UoADwAd5n7hJWDVHoF3m6Fjg2SPFfXoN4N8wo4EVTiICoBIXuYIxI72
L3TrliZVwSYCoaOkjn4JKj88kYThqXjOZLr+1x5vSmCTROEQI95Z7FZ89JMFSb6Q
AQIDAQAB
-----END PUBLIC KEY-----"""

# Runtime state — không có DEV_MODE, không có bypass
_license_valid: bool = False
_license_payload: dict = {}
_runtime_key: str = str(_uuid.uuid4().hex)


# ---------------------------------------------------------------------------
# UUID helpers
# ---------------------------------------------------------------------------

_INVALID_UUIDS = {
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "FEFEFEFE-FEFE-FEFE-FEFE-FEFEFEFEFEFE",
    "00000000-0000-0000-0000-000000000000",
    "03000200-0400-0500-0006-000700080009",
}

def _is_valid_uuid(val: str) -> bool:
    if not val:
        return False
    v = val.strip().upper()
    if v in ("", "NONE", "DEFAULT STRING", "TO BE FILLED BY O.E.M."):
        return False
    if v in _INVALID_UUIDS:
        return False
    # Loại UUID mà tất cả các byte đều giống nhau (ABABABAB-...) hoặc toàn 1 ký tự hex
    stripped = v.replace("-", "")
    if len(set(stripped)) <= 1:
        return False
    # Loại pattern lặp 2 ký tự như FEFEFEFE
    if len(stripped) == 32 and len(set(stripped[i:i+2] for i in range(0, 32, 2))) <= 1:
        return False
    return True

def _mac_based_uuid() -> str:
    """Tạo UUID ổn định từ MAC address của máy."""
    import hashlib
    mac = hex(_uuid.getnode()).upper().lstrip("0X").zfill(12)
    # Dùng SHA1 để map MAC → UUID v5-like
    h = hashlib.sha1(f"NOVAFRAME:{mac}".encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}".upper()

def get_bios_uuid() -> str:
    """Get machine UUID via WMI chain (Windows). Fallback to MAC-based UUID."""
    # 1. BIOS UUID
    try:
        result = subprocess.run(
            ["wmic", "csproduct", "get", "UUID", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("UUID="):
                val = line.split("=", 1)[1].strip()
                if _is_valid_uuid(val):
                    return val.upper()
    except Exception:
        pass

    # 2. Baseboard serial
    try:
        result = subprocess.run(
            ["wmic", "baseboard", "get", "SerialNumber", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("SerialNumber="):
                val = line.split("=", 1)[1].strip()
                if _is_valid_uuid(val):
                    return val.upper()
    except Exception:
        pass

    # 3. Disk serial
    try:
        result = subprocess.run(
            ["wmic", "diskdrive", "get", "SerialNumber", "/value"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("SerialNumber="):
                val = line.split("=", 1)[1].strip()
                if _is_valid_uuid(val):
                    return val.upper()
    except Exception:
        pass

    # 4. Fallback: MAC address hash (ổn định, không toàn F)
    return _mac_based_uuid()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_license(token: str) -> tuple[bool, str]:
    """Validate license token. Returns (is_valid, message)."""
    global _license_valid, _license_payload

    if not token or not token.strip():
        _license_valid = False
        return False, "Chưa có license token"

    try:
        public_key = serialization.load_pem_public_key(_PUBLIC_KEY_PEM.encode())
        payload = jwt.decode(
            token.strip(),
            public_key,
            algorithms=["RS256"],
            options={"verify_exp": False},
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
    """Return current license status for UI."""
    machine_uuid = get_bios_uuid()
    if not _license_valid:
        return {
            "valid": False,
            "machine_uuid": machine_uuid,
            "expires_at": None,
            "message": "Chưa có license hợp lệ",
        }
    exp = _license_payload.get("exp", 0)
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if exp else None
    return {
        "valid": True,
        "machine_uuid": machine_uuid,
        "expires_at": expires_at,
        "message": "License hợp lệ",
    }


def is_licensed() -> bool:
    return _license_valid


def get_runtime_key() -> str:
    return _runtime_key


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def license_required(f: Callable) -> Callable:
    """FastAPI decorator to guard routes requiring valid license."""
    @wraps(f)
    async def wrapper(*args, **kwargs):
        from fastapi import HTTPException, Request
        request: Request | None = kwargs.get("request") or next(
            (a for a in args if hasattr(a, "headers")), None
        )
        if request:
            rk = request.headers.get("X-Runtime-Key", "")
            if rk != _runtime_key:
                raise HTTPException(status_code=403, detail="Unauthorized")
        if not _license_valid:
            raise HTTPException(status_code=403, detail="License không hợp lệ hoặc đã hết hạn")
        return await f(*args, **kwargs)
    return wrapper
