#!/usr/bin/env python3
"""
Generate Ed25519 keypair for license server.
Run: python scripts/generate-keypair.py
Output: ed25519_private_b64.txt, ed25519_public.pem
"""
import base64
import sys

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PrivateFormat, PublicFormat, NoEncryption
    )
except ImportError:
    print("Installing cryptography...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "cryptography"])
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PrivateFormat, PublicFormat, NoEncryption
    )

# Generate keypair
private_key = Ed25519PrivateKey.generate()
public_key  = private_key.public_key()

# Private key PEM → base64 (1 line, for .env)
private_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
private_b64 = base64.b64encode(private_pem).decode()

# Public key PEM (for embedding in license.py)
public_pem = public_key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()

# Save files
with open("ed25519_private_b64.txt", "w") as f:
    f.write(private_b64)

with open("ed25519_public.pem", "w") as f:
    f.write(public_pem)

print("=" * 60)
print("Ed25519 Keypair generated successfully!")
print("=" * 60)
print()
print("1. Copy this into your .env file as ED25519_PRIVATE_KEY_B64:")
print()
print(private_b64)
print()
print("2. Copy this into NOVA FRAME/services/license.py as _PUBLIC_KEY_PEM:")
print()
print(public_pem)
print("=" * 60)
print("Files saved:")
print("  ed25519_private_b64.txt  <- add to .env, then DELETE this file")
print("  ed25519_public.pem       <- embed in license.py")
print()
print("WARNING: Never commit ed25519_private_b64.txt to git!")
