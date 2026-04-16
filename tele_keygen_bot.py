"""
Telegram Bot — Admin License Signer
Lệnh: /active <uuid> <số_ngày>
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import jwt
from cryptography.hazmat.primitives import serialization
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

# ── Cấu hình ────────────────────────────────────────────────────────────────
BOT_TOKEN = "8070686450:AAGubmcfTuV9v0REnpgN-LPnM-6ktziLC7k"  # Lấy từ @BotFather

ADMIN_IDS: set[int] = {
    5919920299,  # Thêm Telegram user ID của admin vào đây
}

# Private key nhúng thẳng vào code (không cần file)
PRIVATE_KEY_PEM = b"""-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDVG5ngcmtpsToR
Y7LkUXrhLUauY05WEF/xfn1zr9NqMZyHKd0tkJizpOfG3+R0WnuAvEibJMfo5Uil
KGJ2oWnLoQJhI1vjgZucexNF/WkONikdc1HatGl35CMVLMXdYxpGgvCuE4Dw2ERL
afbcvOcHMA3+dMc+zwtExENYWMyieRunfMefKYQcihEdK0X6ajMvsQ24qhkUuUSr
V98DuNASldXE+fThSgAPAB3mfuElYNUegXeboWODZI8V9eg3g3zCjgRVOIgKgEhe
5gjEjvYvdOuWJlXBJgKho6SOfgkqPzyRhOGpeM5kuv7XHm9KYJNE4RAj3lnsVnz0
kwVJvpABAgMBAAECggEACBA+C4nQyiRAUfmfgneZymzj5IPR6jw+4Ryb4xV3TqiX
Z17cZVW4DW4TLgl5M7TbwPR+283xuXx5efRT+3Cil+ec9y93Ed3s1SgsA8UxpS3D
8v8SzQ9wAS8S68FwsC6Ihzv7nt6SjaplNSRKiLImHLXDBcqF4njDkKPLd4uOnKQe
QrS58f7nS0j5mVY9fkNfbnrU7CZ2BggDrL7fOHP3HAIvoF85x62pStwrGGiV00Hh
IwSZfnKEJjwYb1IrZZ8nlbEa+o4LM5GhDQBP+VPXhm4gYiPeMrPmgx6KU6xDA12g
Ck2v0Xwxebxv5Wk6LbGXdVzYx9a0ko/PENGQrYM49QKBgQD5d0VwbgyAaoMy8KFX
NMDJvu5q5DzXNatJbZ/fi0RxfMWgcQRXtQUvj61hpSxo84hBisbs27CNqQsn13t5
BclWVbgm4kXXBWh754AdYK5wXJraiega2rwHYyZBfulqwZYSQUWVUasiPeLtXxcr
GXxBkJ3OSWpUHLWKkwICs+kaLQKBgQDasIpGeHB6D+RzWAstGcLxVyFqv6L/53bm
VbDGX4eXPSDzbnRsiGMrPWKWNGYjP1/nfi31dyHjbar33F4Fmutl9QKZrwd3lUei
5n6R2BaiPLR0zFBdX6ed99hRXBHGAzeJqNOIaKE1IK9GuoaMIQRo7+A9KamjJCpk
hXqo6qcVpQKBgFiRxBGawM2HA3W+gUnY7Omz5CoHRqKR53J2fWB8rZwtVG0WMxiA
qIquVDxqzE2mySWcA+xsQ07ISbGni6r4JveED5GenHUu8l2rX40OmmBCQKh+de2y
4zcsOJTgXjcM7B8nFXFiQYQyvLLSJAOlVLxif+SRpDKgzsOYVgpnnccxAoGARvBb
em6ZNc8v8QaPYYroxLbZ3THa4x4nYKJNXJwidLnclXqwA4DegmlAMK9ArpBhQMua
hvSlJowtmIeAbFsLnyAyPr4bMvxWp44TYqXw+aGte/HG4/MigUijgAjYrx3eByaf
r7EZEg3PLadV++C9+HhPiieYopYZtk/iMSclGg0CgYEAte6siSKTNo4iv1HtV8PZ
2ZS6BarhJB59PBJqyw+ODoiIAseju/9ozmuduzSiz/uJnSApBLLMMgo35pxkIVuA
s4ixa3g3oD2kbw5PEm7CXABfZIY1r5WoCptEVBSKOzDcnMU6lSyQMXEaWmIAeauJ
Qrq1jKUn42fRcU9rrs4vLUw=
-----END PRIVATE KEY-----"""

# ── Load key một lần ─────────────────────────────────────────────────────────
_private_key = serialization.load_pem_private_key(PRIVATE_KEY_PEM, password=None)

logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)


def sign_license(machine_uuid: str, days: int) -> tuple[str, str]:
    """Trả về (token, exp_date_str)."""
    now = int(time.time())
    exp = now + days * 86400
    payload = {
        "token_uuid": machine_uuid.strip().upper(),
        "iat": now,
        "exp": exp,
    }
    token = jwt.encode(payload, _private_key, algorithm="RS256")
    exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%d")
    return token, exp_dt


async def cmd_active(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    if user_id not in ADMIN_IDS:
        await update.message.reply_text("⛔ Không có quyền.")
        return

    args = context.args
    if len(args) != 2:
        await update.message.reply_text(
            "❌ Sai cú pháp.\nDùng: /active <uuid> <số_ngày>\n"
            "Ví dụ: /active A1B2C3D4-... 30"
        )
        return

    uuid_str, days_str = args
    if not days_str.isdigit() or int(days_str) <= 0:
        await update.message.reply_text("❌ Số ngày phải là số nguyên dương.")
        return

    days = int(days_str)
    try:
        token, exp_dt = sign_license(uuid_str, days)
    except Exception as e:
        await update.message.reply_text(f"❌ Lỗi ký: {e}")
        return

    msg = (
        f"✅ *License đã ký*\n\n"
        f"UUID: `{uuid_str.upper()}`\n"
        f"Ngày: *{days} ngày*\n"
        f"Hết hạn: *{exp_dt}*\n\n"
        f"*Token:*\n`{token}`"
    )
    await update.message.reply_text(msg, parse_mode="Markdown")


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_user.id not in ADMIN_IDS:
        return
    await update.message.reply_text(
        "🔑 *Nova Frame License Bot*\n\n"
        "/active `<uuid>` `<số_ngày>` — Ký license\n\n"
        "Ví dụ:\n`/active A1B2C3D4-XXXX-XXXX-XXXX-XXXXXXXXXXXX 30`",
        parse_mode="Markdown",
    )


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("active", cmd_active))
    app.add_handler(CommandHandler("start", cmd_help))
    app.add_handler(CommandHandler("help", cmd_help))
    print("[Bot] Đang chạy...")
    app.run_polling()


if __name__ == "__main__":
    main()
