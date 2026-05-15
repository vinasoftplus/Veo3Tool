"""
License service — Ed25519 server-based validation.

Flow:
  Tool sends {key, machine_id, nonce, timestamp} to license server.
  Server checks key validity, machine ban, signs response with Ed25519.
  Tool verifies signature with embedded public key.
  Grace period: 72h offline cache.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import socket
import subprocess
import time
import uuid as _uuid

from functools import wraps
from pathlib import Path
from typing import Callable
import urllib.request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LICENSE_SERVER_URL = os.environ.get(
    "LICENSE_SERVER_URL", "https://haorrr.dev"
)

_CACHE_TTL   = 900          # 15 min in-memory cache
_GRACE_PERIOD = 24 * 3600   # 24h offline grace period

_PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn11SvnbCtrf/A/I/fCR7vQ10fmu/uKYytf5hPNkHvWY=
-----END PUBLIC KEY-----"""

_BASE_DIR = Path(__file__).parent.parent
_LICENSE_CACHE_FILE = _BASE_DIR / "config" / ".license_cache"

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

_license_valid: bool     = False
_license_expires_at: str | None = None
_license_message: str    = "Chưa kiểm tra"
_license_type: str       = ""
_cache_time: float       = 0.0
_runtime_key: str        = str(_uuid.uuid4().hex)

# Ban state
_is_banned: bool         = False
_ban_reason: str         = ""

# ---------------------------------------------------------------------------
# Machine UUID — keep UNCHANGED from original
# ---------------------------------------------------------------------------

_INVALID_UUIDS = {
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "FEFEFEFE-FEFE-FEFE-FEFE-FEFEFEFEFEFE",
    "00000000-0000-0000-0000-000000000000",
    "03000200-0400-0500-0006-000700080009",
}

_INVALID_STRINGS = {
    "",
    "NONE",
    "DEFAULT STRING",
    "TO BE FILLED BY O.E.M.",
    "TO BE FILLED BY OEM",
    "N/A",
    "NOT APPLICABLE",
}


def _is_valid_val(val: str) -> bool:
    if not val:
        return False
    v = val.strip().upper()
    if v in _INVALID_STRINGS or v in _INVALID_UUIDS:
        return False
    stripped = v.replace("-", "").replace(" ", "")
    if len(stripped) < 4:
        return False
    if len(set(stripped)) <= 1:
        return False
    return True


def _normalize_hw_value(val: str) -> str:
    """Trim/uppercase hardware identifiers and drop known OEM placeholder values."""
    v = (val or "").strip().upper()
    return v if _is_valid_val(v) else ""


def _powershell(cmd: str) -> str:
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        return r.stdout.strip()
    except Exception:
        return ""


def _cmd(command: str) -> str:
    try:
        r = subprocess.run(
            ["cmd", "/c", command],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        return r.stdout.strip()
    except Exception:
        return ""


def _parse_table_value(output: str, header: str) -> str:
    """Parse simple WMIC table output and return the first non-header value."""
    header_upper = header.strip().upper()
    for line in (output or "").splitlines():
        value = line.strip()
        if not value or value.upper() == header_upper:
            continue
        return value
    return ""


def _get_machine_guid() -> str:
    output = _cmd(r'reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid')
    for line in output.splitlines():
        if "MachineGuid" not in line:
            continue
        parts = line.split()
        if parts:
            return _normalize_hw_value(parts[-1])
    return ""


def _get_csproduct_uuid() -> str:
    output = _cmd("wmic csproduct get uuid")
    return _normalize_hw_value(_parse_table_value(output, "UUID"))


def _get_baseboard_serial() -> str:
    output = _cmd("wmic baseboard get serialnumber")
    return _normalize_hw_value(_parse_table_value(output, "SerialNumber"))


def _get_disk_serial() -> str:
    val = _powershell(
        "$partition = Get-CimAssociatedInstance "
        "-InputObject (Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\") "
        "-ResultClassName Win32_DiskPartition | Select-Object -First 1; "
        "if ($partition) { "
        "  $disk = Get-CimAssociatedInstance -InputObject $partition "
        "  -ResultClassName Win32_DiskDrive | Select-Object -First 1; "
        "  if ($disk) { $disk.SerialNumber } "
        "}"
    )
    val = _normalize_hw_value(val)
    if val:
        return val
    output = _cmd("wmic diskdrive where index=0 get serialnumber")
    return _normalize_hw_value(_parse_table_value(output, "SerialNumber"))


def _get_volume_serial() -> str:
    val = _powershell("(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").VolumeSerialNumber")
    return val.strip().upper()


def _get_mac() -> str:
    val = _powershell(
        "(Get-CimInstance Win32_NetworkAdapterConfiguration | "
        "Where-Object { $_.IPEnabled -eq $true } | "
        "Select-Object -First 1).MACAddress"
    )
    if val:
        return val.strip().upper().replace(":", "").replace("-", "")
    try:
        mac = hex(_uuid.getnode()).upper().lstrip("0X").zfill(12)
        if mac != "000000000000":
            return mac
    except Exception:
        pass
    return ""


_machine_id_cache: str = ""


def get_machine_id() -> str:
    """
    Machine ID = SHA256(MachineGuid + BIOS UUID + baseboard serial + disk serial)
    -> UUID format. Empty hardware fields are allowed after placeholder filtering.
    """
    global _machine_id_cache
    if _machine_id_cache:
        return _machine_id_cache

    machine_guid = _get_machine_guid()
    bios_uuid = _get_csproduct_uuid()
    board_serial = _get_baseboard_serial()
    disk_serial = _get_disk_serial()

    combined = (
        "DF_V2|"
        f"MG:{machine_guid}|"
        f"BIOS:{bios_uuid}|"
        f"BOARD:{board_serial}|"
        f"DISK:{disk_serial}"
    )
    h = hashlib.sha256(combined.encode()).hexdigest()
    machine_id = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}".upper()
    _machine_id_cache = machine_id
    return machine_id


# Alias for old code
get_bios_uuid = get_machine_id


# ---------------------------------------------------------------------------
# Ed25519 signature verification
# ---------------------------------------------------------------------------

def _verify_response_signature(resp: dict, sent_nonce: str) -> None:
    """Verify Ed25519 signature on server response. Raises ValueError if invalid."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        # cryptography not installed — skip verification (dev mode)
        return

    sig_b64 = resp.pop("signature", None)
    if not sig_b64:
        raise ValueError("No signature in server response")

    assert resp.get("nonce") == sent_nonce, "Nonce mismatch in response"

    payload_bytes = json.dumps(resp, sort_keys=True, separators=(',', ':')).encode()
    payload_hash = hashlib.sha256(payload_bytes).digest()

    pub_key = load_pem_public_key(_PUBLIC_KEY_PEM)
    sig = base64.b64decode(sig_b64)
    try:
        pub_key.verify(sig, payload_hash)
    except InvalidSignature:
        raise ValueError("Invalid server signature — possible MITM attack")
    finally:
        resp["signature"] = sig_b64  # restore


# ---------------------------------------------------------------------------
# Network call
# ---------------------------------------------------------------------------

def _call_license_server(key: str, machine_id: str, nonce: str, ts: int) -> dict:
    payload = json.dumps({
        "key": key,
        "machine_id": machine_id,
        "nonce": nonce,
        "timestamp": ts,
    }).encode()
    req = urllib.request.Request(
        f"{LICENSE_SERVER_URL}/api/v1/validate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
        # Check for ban (server returns 403 with error=machine_banned)
        return data


def _call_license_server_raw(key: str, machine_id: str, nonce: str, ts: int) -> tuple[int, dict]:
    """Returns (status_code, body) — handles HTTP errors without raising."""
    payload = json.dumps({
        "key": key,
        "machine_id": machine_id,
        "machine_name": socket.gethostname(),
        "nonce": nonce,
        "timestamp": ts,
    }).encode()
    req = urllib.request.Request(
        f"{LICENSE_SERVER_URL}/api/v1/validate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = {}
        try:
            body = json.loads(e.read())
        except Exception:
            pass
        return e.code, body


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _save_cache(resp: dict) -> None:
    try:
        _LICENSE_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LICENSE_CACHE_FILE.write_text(json.dumps({
            "response": resp,
            "cached_at": time.time(),
        }))
    except Exception:
        pass


def _load_cache() -> dict | None:
    try:
        data = json.loads(_LICENSE_CACHE_FILE.read_text())
        return data
    except Exception:
        return None


def _verify_grace_period(cached: dict) -> bool:
    age = time.time() - cached.get("cached_at", 0)
    if age > _GRACE_PERIOD:
        return False
    resp = dict(cached.get("response", {}))
    try:
        # Pass any nonce for cached verification (we skip nonce matching for cache)
        resp_nonce = resp.get("nonce", "")
        _verify_response_signature(resp, resp_nonce)
        return True
    except Exception:
        return False


def _load_key_from_config() -> str:
    try:
        from services.config_service import load_config
        return load_config().get("LICENSE_TOKEN", "").strip()
    except Exception:
        return ""


def _update_state(resp: dict) -> None:
    global _license_valid, _license_expires_at, _license_message, _license_type, _cache_time
    _license_valid    = resp.get("valid", False)
    _license_expires_at = resp.get("expires_at")
    _license_type     = resp.get("license_type", "")
    if _license_valid:
        exp = _license_expires_at or ""
        _license_message = f"License hợp lệ · Hết hạn: {exp[:10]}" if exp else "License hợp lệ"
    else:
        _license_message = "License không hợp lệ"
    _cache_time = time.monotonic()


# ---------------------------------------------------------------------------
# Public validate API
# ---------------------------------------------------------------------------

def validate_license(key: str = "") -> tuple[bool, str]:
    """
    Validate license against server. Returns (valid, message).
    Handles: ban detection, Ed25519 signature verify, 72h grace period.
    """
    global _license_valid, _license_expires_at, _license_message, _cache_time
    global _is_banned, _ban_reason

    # In-memory cache (15 min)
    if _cache_time > 0 and (time.monotonic() - _cache_time) < _CACHE_TTL:
        if _is_banned:
            return False, f"BAN:{_ban_reason}"
        return _license_valid, _license_message

    machine_id = get_machine_id()
    nonce = base64.b64encode(secrets.token_bytes(16)).decode()
    ts    = int(time.time())
    used_key = key or _load_key_from_config()

    if not used_key:
        _license_valid = False
        _license_message = "Chưa nhập license key"
        return False, _license_message

    try:
        status_code, resp = _call_license_server_raw(used_key, machine_id, nonce, ts)

        # Handle ban response (403 with error=machine_banned)
        if status_code == 403 and resp.get("error") == "machine_banned":
            _is_banned  = True
            _ban_reason = resp.get("ban_reason", "Tài khoản bị cấm")
            _license_valid   = False
            _license_message = f"BAN:{_ban_reason}"
            _cache_time = time.monotonic()
            return False, _license_message

        if status_code != 200:
            error = resp.get("error", "unknown")
            _license_valid   = False
            _license_message = _error_to_message(error)
            _cache_time = time.monotonic()
            return False, _license_message

        # Verify signature
        _verify_response_signature(resp, nonce)
        _save_cache(resp)
        _update_state(resp)
        _is_banned = False
        return _license_valid, _license_message

    except Exception:
        # Network failure — try offline grace period
        cached = _load_cache()
        if cached and _verify_grace_period(cached):
            _update_state(cached.get("response", {}))
            _license_message = f"Offline (grace) · {_license_message}"
            return _license_valid, _license_message

        _license_valid   = False
        _license_message = "Không thể kết nối máy chủ license"
        return False, _license_message


def _error_to_message(error: str) -> str:
    messages = {
        "invalid_key":          "License key không hợp lệ",
        "key_revoked":          "License key đã bị thu hồi",
        "key_expired":          "License key đã hết hạn",
        "machine_not_activated":"Thiết bị chưa được kích hoạt — liên hệ hỗ trợ",
        "device_revoked":       "Thiết bị đã bị thu hồi quyền truy cập",
        "max_devices_reached":  "Đã đạt giới hạn số thiết bị",
        "rate_limited":         "Quá nhiều yêu cầu, thử lại sau",
        "stale_timestamp":      "Đồng hồ hệ thống không đồng bộ",
    }
    return messages.get(error, f"Lỗi: {error}")


def is_banned() -> bool:
    return _is_banned


def get_ban_reason() -> str:
    return _ban_reason


def get_license_info() -> dict:
    machine_id = get_machine_id()
    return {
        "valid":       _license_valid,
        "machine_uuid": machine_id,
        "expires_at":  _license_expires_at,
        "message":     _license_message,
        "license_type": _license_type,
        "is_banned":   _is_banned,
        "ban_reason":  _ban_reason if _is_banned else None,
    }


def is_licensed() -> bool:
    return _license_valid


def get_runtime_key() -> str:
    return _runtime_key


def force_recheck() -> tuple[bool, str]:
    """Clear cache and recheck immediately."""
    global _cache_time
    _cache_time = 0.0
    return validate_license()


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------

def license_required(f: Callable) -> Callable:
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
