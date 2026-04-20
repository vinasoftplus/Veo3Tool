# License Key Server

A self-hosted license key management system with a Go Fiber API backend, SvelteKit admin dashboard, PostgreSQL storage, Redis caching, and Caddy reverse proxy.

## Tech Stack

| Layer | Technology |
|---|---|
| API | Go + Fiber (Ed25519-signed responses) |
| Admin UI | SvelteKit |
| Database | PostgreSQL 17 |
| Cache / Rate-limit | Redis 7 |
| Reverse Proxy | Caddy 2 (auto HTTPS) |
| Backup | Backblaze B2 (optional) |

## Quick Start

**1. Copy env and fill in secrets**

```bash
cp .env.example .env
```

Edit `.env` and set at minimum: `DB_USER`, `DB_PASS`, `JWT_SECRET`, `TOTP_ENCRYPT_KEY`, `DOMAIN`, and `ED25519_PRIVATE_KEY_B64`.

**2. Generate Ed25519 keypair**

```bash
# Generate private key (base64-encoded, paste into ED25519_PRIVATE_KEY_B64)
openssl genpkey -algorithm ed25519 | base64 -w0

# Derive public key for distribution to clients
openssl genpkey -algorithm ed25519 -out ed25519.pem
openssl pkey -in ed25519.pem -pubout -out ed25519_pub.pem
cat ed25519_pub.pem
```

The public key is embedded in your client application. The private key stays on the server.

**3. Generate other secrets**

```bash
# JWT_SECRET (64 hex chars)
openssl rand -hex 32

# TOTP_ENCRYPT_KEY (32 hex chars)
openssl rand -hex 16
```

**4. Start all services**

```bash
docker compose up -d
```

Database schema is applied automatically on first run via `docker/init.sql`.

## API Endpoints Overview

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/license/verify` | Verify a license key + machine ID |
| `POST` | `/api/v1/license/activate` | Activate a license on a machine |
| `POST` | `/api/v1/license/deactivate` | Deactivate a machine slot |
| `GET` | `/health` | Health check (used by Docker) |
| `POST` | `/admin/api/auth/login` | Admin login (returns JWT) |
| `GET` | `/admin/api/licenses` | List all licenses (paginated) |
| `POST` | `/admin/api/licenses` | Issue a new license key |
| `DELETE` | `/admin/api/licenses/:id` | Revoke a license |
| `GET` | `/admin/api/machines` | List activations |
| `POST` | `/admin/api/machines/ban` | Ban a machine UUID |
| `GET` | `/admin/api/audit` | Audit log |

## First Admin Setup

After `docker compose up -d`, create the first admin account:

```bash
docker compose exec license-server ./license-server create-admin \
  --email admin@yourdomain.com \
  --password "YourStrongPassword"
```

Then log in at `https://admin.yourdomain.com`.

## Machine Banning

Banned machine UUIDs are stored in the `banned_machines` table. Any verification or activation request from a banned machine returns `403 Forbidden` with a ban reason. Admins can ban/unban machines from the dashboard or via:

```bash
# Via API (requires admin JWT)
POST /admin/api/machines/ban
{ "machine_id": "...", "reason": "Piracy suspected" }
```

## Backup

If `B2_KEY_ID` and `B2_APP_KEY` are set in `.env`, the backup container runs `pg_dump` daily at 02:00 UTC and uploads compressed dumps to your Backblaze B2 bucket under `backups/`.

Manual backup:

```bash
docker compose exec backup /backup.sh
```
