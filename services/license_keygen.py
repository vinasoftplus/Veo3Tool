"""
Admin-only keygen script — NOT shipped with end-user build.

Usage:
  python services/license_keygen.py genkey              # Generate RSA keypair
  python services/license_keygen.py sign <uuid> <days>  # Sign license token
  python services/license_keygen.py verify <token>       # Verify a token
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt


KEY_DIR = Path(__file__).parent.parent / "config"
PRIVATE_KEY_FILE = KEY_DIR / "private_key.pem"
PUBLIC_KEY_FILE = KEY_DIR / "public_key.pem"


def cmd_genkey():
    KEY_DIR.mkdir(parents=True, exist_ok=True)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    PRIVATE_KEY_FILE.write_bytes(private_pem)
    PUBLIC_KEY_FILE.write_bytes(public_pem)
    print(f"[OK] Private key: {PRIVATE_KEY_FILE}")
    print(f"[OK] Public key:  {PUBLIC_KEY_FILE}")
    print()
    print("=== Embed this public key in services/license.py ===")
    print(public_pem.decode())


def cmd_sign(machine_uuid: str, days: int):
    if not PRIVATE_KEY_FILE.exists():
        print("[ERR] Run 'genkey' first")
        sys.exit(1)
    private_key = serialization.load_pem_private_key(PRIVATE_KEY_FILE.read_bytes(), password=None)
    now = int(time.time())
    exp = now + int(days) * 86400
    payload = {
        "token_uuid": machine_uuid.strip().upper(),
        "iat": now,
        "exp": exp,
    }
    token = jwt.encode(payload, private_key, algorithm="RS256")
    exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d")
    print(f"[OK] Token for UUID: {machine_uuid.upper()}")
    print(f"[OK] Expires: {exp_dt}")
    print()
    print("=== LICENSE TOKEN ===")
    print(token)


def cmd_verify(token: str):
    if not PUBLIC_KEY_FILE.exists():
        print("[ERR] public_key.pem not found")
        sys.exit(1)
    public_key = serialization.load_pem_public_key(PUBLIC_KEY_FILE.read_bytes())
    try:
        payload = jwt.decode(token.strip(), public_key, algorithms=["RS256"], options={"verify_exp": False})
        exp = payload.get("exp", 0)
        exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        expired = time.time() > exp
        print(f"[OK] Signature valid")
        print(f"     UUID:    {payload.get('token_uuid')}")
        print(f"     Expires: {exp_dt} {'[EXPIRED]' if expired else '[OK]'}")
        print(f"     Payload: {json.dumps(payload, indent=2)}")
    except Exception as e:
        print(f"[FAIL] {e}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "genkey":
        cmd_genkey()
    elif args[0] == "sign" and len(args) == 3:
        cmd_sign(args[1], int(args[2]))
    elif args[0] == "verify" and len(args) == 2:
        cmd_verify(args[1])
    else:
        print(__doc__)
