#!/usr/bin/env python3
"""
First-time admin account setup.
Run once after DB is up: python scripts/setup-first-admin.py
Requires: pip install bcrypt psycopg2-binary
"""
import os
import sys
import getpass

try:
    import bcrypt
    import psycopg2
except ImportError:
    print("Install deps: pip install bcrypt psycopg2-binary")
    sys.exit(1)

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://licenseuser:changeme@localhost:5432/licenses"
)

print("=== License Manager — First Admin Setup ===\n")
email    = input("Admin email: ").strip()
password = getpass.getpass("Password (min 8 chars): ")
if len(password) < 8:
    print("Password too short.")
    sys.exit(1)

password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()

conn = psycopg2.connect(DATABASE_URL)
cur  = conn.cursor()
cur.execute(
    "INSERT INTO admin_users (email, password_hash, role) VALUES (%s, %s, 'admin') "
    "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash",
    (email, password_hash)
)
conn.commit()
cur.close()
conn.close()

print(f"\n✅ Admin account created: {email}")
print("You can now log in at: https://admin.yourdomain.com")
