"""
License service — Google Sheets UUID lookup.

Flow:
  Admin thêm UUID + số ngày vào Google Sheets.
  Tool lấy machine UUID, gọi sheet để check còn hạn hay không.
  Cache kết quả 1 giờ để không spam sheet.
"""
from __future__ import annotations

import hashlib
import subprocess
import time
import uuid as _uuid
from datetime import datetime, timezone
from functools import wraps
from typing import Callable

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Google Sheets published as CSV (File > Share > Publish to web > CSV)
# Sheet có 2 cột: UUID | Days (số ngày tính từ ngày kích hoạt — dùng giá trị âm để tính ngày hết hạn tuyệt đối)
# Hoặc 3 cột: UUID | ExpireDate (YYYY-MM-DD) | Note
SHEET_CSV_URL = (
    "https://docs.google.com/spreadsheets/d/1zoHMSOYs95-QLf80CnDhR4wOcJvcpJfgHIkwYCw8fk0"
    "/export?format=csv&gid=0"
)

# Cache TTL
_CACHE_TTL = 900  # 15 phút

# ---------------------------------------------------------------------------
# Runtime state
# ---------------------------------------------------------------------------

_license_valid: bool = False
_license_expires_at: str | None = None
_license_message: str = "Chưa kiểm tra"
_cache_time: float = 0.0
_runtime_key: str = str(_uuid.uuid4().hex)


# ---------------------------------------------------------------------------
# Machine UUID — ổn định cho Win11, VM, VPS
# ---------------------------------------------------------------------------

_INVALID_UUIDS = {
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    "FEFEFEFE-FEFE-FEFE-FEFE-FEFEFEFEFEFE",
    "00000000-0000-0000-0000-000000000000",
    "03000200-0400-0500-0006-000700080009",
}

_INVALID_STRINGS = {"", "NONE", "DEFAULT STRING", "TO BE FILLED BY O.E.M.", "N/A", "NOT APPLICABLE"}


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


def _powershell(cmd: str) -> str:
    """Run powershell command, return stdout."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000
        )
        return r.stdout.strip()
    except Exception:
        return ""



def _get_volume_serial() -> str:
    """Volume Serial Number của ổ C: — ổn định trên Win11, VM, VPS."""
    val = _powershell("(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").VolumeSerialNumber")
    return val.strip().upper()


def _get_mac() -> str:
    """MAC của adapter có IP thật (loại loopback/virtual). Fallback Python getnode."""
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
    Machine ID = SHA256(VolumeSerial_C + MAC) → UUID format.
    Không lưu file, không có attack surface.
    Ổn định trên Win11/VM/VPS trừ khi format ổ C hoặc đổi NIC.
    """
    global _machine_id_cache
    if _machine_id_cache:
        return _machine_id_cache

    vol = _get_volume_serial()
    mac = _get_mac()

    if not vol and not mac:
        # Fallback cực kỳ hiếm — không có gì cả
        vol = "NOVOL"
        mac = "NOMAC"

    combined = f"NOVAFRAME|VOL:{vol}|MAC:{mac}"
    h = hashlib.sha256(combined.encode()).hexdigest()
    machine_id = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}".upper()
    _machine_id_cache = machine_id
    return machine_id


# Alias cho code cũ
get_bios_uuid = get_machine_id


# ---------------------------------------------------------------------------
# Google Sheets check
# ---------------------------------------------------------------------------

def _fetch_sheet_rows() -> list[list[str]]:
    """Fetch CSV từ Google Sheets, trả về list of rows."""
    import urllib.request
    try:
        req = urllib.request.Request(SHEET_CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8")
        rows = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            cols = [c.strip().strip('"') for c in line.split(",")]
            rows.append(cols)
        return rows
    except Exception as e:
        raise RuntimeError(f"Không thể tải dữ liệu license: {e}") from e


def _check_sheet(machine_id: str) -> tuple[bool, str | None, str]:
    """
    Tìm machine_id trong sheet.
    Sheet format (header row được bỏ qua nếu cột 0 không phải UUID):
      Col 0: UUID
      Col 1: ExpireDate (YYYY-MM-DD) HOẶC số ngày còn lại

    Returns: (valid, expires_at_str, message)
    """
    rows = _fetch_sheet_rows()
    mid = machine_id.strip().upper()

    for row in rows:
        if len(row) < 2:
            continue
        row_uuid = row[0].strip().upper()
        if row_uuid != mid:
            continue

        # Tìm thấy UUID — parse cột 1
        raw = row[1].strip()

        # Thử parse YYYY-MM-DD
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"):
            try:
                exp_date = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
                now = datetime.now(tz=timezone.utc)
                if now > exp_date:
                    return False, raw, f"License đã hết hạn từ {raw}"
                return True, raw, f"License hợp lệ · Hết hạn: {raw}"
            except ValueError:
                continue

        # Thử parse số ngày
        try:
            days = int(raw)
            # Nếu có cột 2 là ngày kích hoạt
            if len(row) >= 3:
                activated_raw = row[2].strip()
                for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
                    try:
                        activated = datetime.strptime(activated_raw, fmt).replace(tzinfo=timezone.utc)
                        from datetime import timedelta
                        exp_date = activated + timedelta(days=days)
                        exp_str = exp_date.strftime("%Y-%m-%d")
                        now = datetime.now(tz=timezone.utc)
                        if now > exp_date:
                            return False, exp_str, f"License đã hết hạn từ {exp_str}"
                        return True, exp_str, f"License hợp lệ · Hết hạn: {exp_str}"
                    except ValueError:
                        continue
            # Không có ngày kích hoạt — coi days là số ngày tính từ hôm nay (luôn valid nếu > 0)
            if days > 0:
                from datetime import timedelta
                exp_date = datetime.now(tz=timezone.utc) + timedelta(days=days)
                exp_str = exp_date.strftime("%Y-%m-%d")
                return True, exp_str, f"License hợp lệ · Còn {days} ngày"
            else:
                return False, None, "License đã hết hạn (0 ngày)"
        except ValueError:
            pass

        return False, None, f"Không đọc được hạn license: {raw!r}"

    return False, None, "UUID không tìm thấy trong danh sách license"


# ---------------------------------------------------------------------------
# Public validate API
# ---------------------------------------------------------------------------

def validate_license(_token: str = "") -> tuple[bool, str]:
    """
    Check license qua Google Sheets.
    Token param giữ để tương thích API cũ nhưng không dùng nữa.
    """
    global _license_valid, _license_expires_at, _license_message, _cache_time

    # Cache 1 giờ
    if time.time() - _cache_time < _CACHE_TTL and _cache_time > 0:
        return _license_valid, _license_message

    try:
        machine_id = get_machine_id()
        valid, expires_at, msg = _check_sheet(machine_id)
        _license_valid = valid
        _license_expires_at = expires_at
        _license_message = msg
        _cache_time = time.time()
        return valid, msg
    except Exception as e:
        # Nếu không kết nối được sheet — giữ trạng thái cũ nếu đang valid, không block user
        msg = f"Không thể kiểm tra license: {e}"
        if _license_valid:
            # Đang valid + mất mạng → cho qua, reset cache sau 5 phút
            _cache_time = time.time() - _CACHE_TTL + 300
            return True, f"License tạm thời (offline) · {_license_message}"
        _license_valid = False
        _license_message = msg
        return False, msg


def get_license_info() -> dict:
    machine_id = get_machine_id()
    if not _license_valid:
        return {
            "valid": False,
            "machine_uuid": machine_id,
            "expires_at": None,
            "message": _license_message or "Chưa có license hợp lệ",
        }
    return {
        "valid": True,
        "machine_uuid": machine_id,
        "expires_at": _license_expires_at,
        "message": _license_message,
    }


def is_licensed() -> bool:
    return _license_valid


def get_runtime_key() -> str:
    return _runtime_key


def force_recheck() -> tuple[bool, str]:
    """Xóa cache, check lại ngay."""
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
