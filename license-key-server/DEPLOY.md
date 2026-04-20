# Hướng dẫn Deploy — License Key Server lên Ubuntu VPS

**Domain:** `haorrr.dev`  
**Admin dashboard:** `https://haorrr.dev/admin-manage`  
**License API:** `https://haorrr.dev/api/v1/validate`

---

## Mục lục

1. [Yêu cầu](#1-yêu-cầu)
2. [Chuẩn bị VPS](#2-chuẩn-bị-vps)
3. [Cài Docker](#3-cài-docker)
4. [Upload code lên VPS](#4-upload-code-lên-vps)
5. [Generate Ed25519 Keypair](#5-generate-ed25519-keypair)
6. [Cấu hình file .env](#6-cấu-hình-file-env)
7. [Trỏ DNS](#7-trỏ-dns)
8. [Deploy lần đầu](#8-deploy-lần-đầu)
9. [Tạo tài khoản admin đầu tiên](#9-tạo-tài-khoản-admin-đầu-tiên)
10. [Nhúng Public Key vào tool](#10-nhúng-public-key-vào-tool)
11. [Kiểm tra hoạt động](#11-kiểm-tra-hoạt-động)
12. [Update code (lần sau)](#12-update-code-lần-sau)
13. [Xem logs / debug](#13-xem-logs--debug)
14. [Backup & restore](#14-backup--restore)

---

## 1. Yêu cầu

| Thứ | Yêu cầu tối thiểu |
|-----|-------------------|
| VPS | Ubuntu 22.04 LTS, 1 vCPU, 1GB RAM (Hetzner CX11 ~$4.5/mo hoặc tương đương) |
| Quyền | Root hoặc sudo |
| Domain | `haorrr.dev` đã mua, có thể chỉnh DNS |
| Local | Git, SSH client (Terminal / PuTTY) |

---

## 2. Chuẩn bị VPS

### 2.1 SSH vào VPS

```bash
ssh root@<IP_VPS>
# Ví dụ: ssh root@65.21.100.200
```

### 2.2 Cập nhật hệ thống

```bash
apt update && apt upgrade -y
```

### 2.3 Tạo user deploy (không dùng root để chạy app)

```bash
adduser deploy
# Nhập password khi được hỏi

usermod -aG sudo deploy
usermod -aG docker deploy   # sẽ có hiệu lực sau khi cài docker

# Copy SSH key sang user deploy để login không cần password
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

### 2.4 Cấu hình firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp    # HTTP/3 (QUIC)
ufw --force enable
ufw status
```

---

## 3. Cài Docker

```bash
# Cài Docker Engine chính thức
curl -fsSL https://get.docker.com | sh

# Khởi động Docker
systemctl enable docker
systemctl start docker

# Kiểm tra
docker --version
docker compose version
```

---

## 4. Upload code lên VPS

Có 2 cách: **Git clone** (khuyên dùng) hoặc **SCP**.

### Cách A — Git clone (khuyên dùng)

Nếu code đang trên GitHub/GitLab:

```bash
# Trên VPS (đăng nhập bằng user deploy)
ssh deploy@<IP_VPS>

mkdir -p ~/app
cd ~/app
git clone https://github.com/haorrr/license-key-server.git .
# Hoặc git clone <URL_repo_của_bạn> .
```

### Cách B — SCP từ máy local (nếu chưa có git remote)

Chạy lệnh này trên **máy local** của bạn (Windows Git Bash / PowerShell):

```bash
# Windows Git Bash
scp -r "C:/Users/PC/Desktop/Veo3Tool/license-key-server" deploy@<IP_VPS>:~/app

# Hoặc dùng rsync (nhanh hơn khi update)
rsync -avz --exclude 'node_modules' --exclude '.svelte-kit' \
  "C:/Users/PC/Desktop/Veo3Tool/license-key-server/" \
  deploy@<IP_VPS>:~/app/
```

Sau khi upload xong, SSH vào VPS và kiểm tra:

```bash
ssh deploy@<IP_VPS>
ls ~/app/
# Phải thấy: docker-compose.yml  docker/  license-server/  admin-dashboard/  scripts/
```

---

## 5. Generate Ed25519 Keypair

> **Quan trọng:** Làm bước này **trên máy local** của bạn, không phải VPS.  
> Private key KHÔNG được commit lên git.

### Trên máy local (cần openssl):

**Windows Git Bash / Linux / macOS:**
```bash
cd "C:/Users/PC/Desktop/Veo3Tool/license-key-server"

# Tạo private key
openssl genpkey -algorithm ed25519 -out ed25519_private.pem

# Xuất public key
openssl pkey -in ed25519_private.pem -pubout -out ed25519_public.pem

# Encode private key sang base64 (1 dòng, không có newline)
openssl base64 -in ed25519_private.pem -out ed25519_private_b64.txt -A

# Xem kết quả
cat ed25519_private_b64.txt   # → chuỗi base64, sẽ dùng cho ED25519_PRIVATE_KEY_B64
cat ed25519_public.pem        # → PEM public key, sẽ nhúng vào license.py
```

**Lưu lại 2 file này ở chỗ an toàn (không commit lên git).**

---

## 6. Cấu hình file .env

Trên VPS:

```bash
cd ~/app
cp .env.example .env
nano .env
```

Điền đầy đủ như sau:

```env
# Database
DB_USER=licenseuser
DB_PASS=<mật_khẩu_mạnh_ví_dụ: Xk9#mP2$vL8nQ>

# Ed25519 private key (paste toàn bộ nội dung ed25519_private_b64.txt)
ED25519_PRIVATE_KEY_B64=<paste_nội_dung_ed25519_private_b64.txt_vào_đây>

# JWT secret (tạo ngẫu nhiên)
JWT_SECRET=<chạy: openssl rand -hex 32>

# TOTP encrypt key (tạo ngẫu nhiên)
TOTP_ENCRYPT_KEY=<chạy: openssl rand -hex 16>

# Domain của bạn (KHÔNG có https://, KHÔNG có dấu /)
DOMAIN=haorrr.dev

# Port nội bộ Go server (giữ nguyên)
PORT=8080

# Backblaze B2 backup (để trống nếu chưa dùng)
B2_BUCKET=
B2_KEY_ID=
B2_APP_KEY=
```

> **Cách tạo secret nhanh trên VPS:**
> ```bash
> openssl rand -hex 32   # dùng cho JWT_SECRET
> openssl rand -hex 16   # dùng cho TOTP_ENCRYPT_KEY
> ```

Lưu file: `Ctrl+O` → `Enter` → `Ctrl+X`

### Bảo vệ file .env

```bash
chmod 600 ~/app/.env
```

---

## 7. Trỏ DNS

Đăng nhập vào trang quản lý DNS của domain `haorrr.dev` (Cloudflare, Namecheap, GoDaddy...).

Thêm record sau:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` (hoặc `haorrr.dev`) | `<IP_VPS>` | Auto |
| A | `www` | `<IP_VPS>` | Auto (tùy chọn) |

> Nếu dùng **Cloudflare**: tắt proxy (icon mây cam → mây xám) trong lúc setup lần đầu để Caddy lấy SSL. Bật lại sau nếu muốn.

Chờ DNS propagate (thường 1–5 phút với Cloudflare, tối đa 48h với DNS khác):

```bash
# Kiểm tra DNS đã trỏ đúng chưa (chạy trên máy local hoặc VPS)
nslookup haorrr.dev
# Phải trả về IP của VPS
```

---

## 8. Deploy lần đầu

### 8.1 Build và khởi động tất cả services

```bash
cd ~/app

# Build images (lần đầu mất 3-10 phút do build Go + Node)
docker compose build

# Khởi động tất cả (detached mode)
docker compose up -d

# Xem trạng thái
docker compose ps
```

Kết quả mong đợi — tất cả status phải là `running (healthy)`:

```
NAME                STATUS
app-license-server-1    running (healthy)
app-admin-dashboard-1   running
app-postgres-1          running (healthy)
app-redis-1             running (healthy)
app-caddy-1             running
app-backup-1            running
```

### 8.2 Caddy tự lấy SSL

Caddy sẽ tự động lấy certificate từ Let's Encrypt cho `haorrr.dev`.  
Quá trình này mất 10–30 giây lần đầu.

Kiểm tra Caddy logs:

```bash
docker compose logs caddy -f
# Đợi thấy: certificate obtained successfully
# Hoặc: serving initial configuration
```

---

## 9. Tạo tài khoản admin đầu tiên

```bash
cd ~/app

# Cài deps Python cần thiết
pip3 install bcrypt psycopg2-binary 2>/dev/null || \
  apt install -y python3-pip && pip3 install bcrypt psycopg2-binary

# Chạy script setup
DATABASE_URL="postgres://$(grep DB_USER .env | cut -d= -f2):$(grep DB_PASS .env | cut -d= -f2)@localhost:5432/licenses" \
  python3 scripts/setup-first-admin.py
```

> **Lưu ý:** PostgreSQL expose port 5432 ra localhost (không ra internet) nên kết nối được từ VPS.  
> Nếu báo lỗi kết nối, chạy: `docker compose exec postgres psql -U licenseuser -d licenses`

Ví dụ output:
```
=== License Manager — First Admin Setup ===

Admin email: admin@haorrr.dev
Password (min 8 chars): ••••••••••

✅ Admin account created: admin@haorrr.dev
```

---

## 10. Nhúng Public Key vào tool

Trên **máy local**, mở file `NOVA FRAME/services/license.py` và thay placeholder bằng public key thật:

```bash
# Xem nội dung public key
cat ed25519_public.pem
```

Output sẽ như thế này:
```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VdAyEA<...base64...>
-----END PUBLIC KEY-----
```

Mở file `NOVA FRAME/services/license.py`, tìm dòng `_PUBLIC_KEY_PEM` và thay:

```python
_PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VdAyEA<nội_dung_public_key_thật_của_bạn>
-----END PUBLIC KEY-----"""
```

Cũng cập nhật `LICENSE_SERVER_URL`:

```python
LICENSE_SERVER_URL = os.environ.get(
    "LICENSE_SERVER_URL", "https://haorrr.dev"
)
```

---

## 11. Kiểm tra hoạt động

### 11.1 Health check API

```bash
curl https://haorrr.dev/health
# Kết quả mong đợi:
# {"status":"ok","db":true,"redis":true}
```

### 11.2 Truy cập admin dashboard

Mở trình duyệt: **https://haorrr.dev/admin-manage**

Đăng nhập bằng email/mật khẩu vừa tạo ở bước 9.

Nếu thấy trang login → **thành công** ✅

### 11.3 Test validate endpoint

```bash
curl -X POST https://haorrr.dev/api/v1/validate \
  -H "Content-Type: application/json" \
  -d '{"key":"TEST-INVALID","machine_id":"test","nonce":"dGVzdA==","timestamp":'$(date +%s)'}'

# Kết quả mong đợi:
# {"error":"invalid_key"}
```

### 11.4 Tạo key test và kích hoạt

Vào dashboard → **Keys** → **+ New Key** → điền info → nhấn **Tạo Key** → copy key hiện ra.

---

## 12. Update code (lần sau)

Khi có thay đổi code, upload lên VPS rồi:

```bash
cd ~/app

# Cách A: nếu dùng git
git pull origin main

# Cách B: nếu dùng rsync từ local
# Chạy lệnh rsync ở máy local (xem bước 4)

# Rebuild và restart
docker compose build
docker compose up -d

# Chỉ restart 1 service cụ thể (không rebuild)
docker compose restart license-server
```

---

## 13. Xem logs / debug

```bash
# Xem log tất cả services (realtime)
docker compose logs -f

# Chỉ xem log license server
docker compose logs -f license-server

# Chỉ xem log admin dashboard
docker compose logs -f admin-dashboard

# Chỉ xem log Caddy (SSL issues)
docker compose logs -f caddy

# Xem log 100 dòng gần nhất
docker compose logs --tail=100 license-server

# Vào shell trong container (debug)
docker compose exec license-server sh
docker compose exec postgres psql -U licenseuser -d licenses
```

### Các lỗi thường gặp

| Lỗi | Nguyên nhân | Cách fix |
|-----|-------------|----------|
| `certificate obtain error` | DNS chưa trỏ đúng | Chờ DNS propagate, kiểm tra `nslookup haorrr.dev` |
| `ED25519_PRIVATE_KEY_B64 is not set` | Thiếu env var | Kiểm tra file `.env`, chạy `docker compose up -d` lại |
| `DB init failed` | Postgres chưa ready | Chạy `docker compose restart license-server` sau 10s |
| `/admin-manage` trả 404 | Caddy chưa reload | `docker compose restart caddy` |
| Build Go thất bại | Thiếu internet hoặc proxy | Kiểm tra `curl google.com` từ VPS |

---

## 14. Backup & restore

### Backup thủ công

```bash
cd ~/app

# Dump database
docker compose exec postgres pg_dump -U licenseuser licenses > backup_$(date +%Y%m%d).sql

# Copy backup về máy local
scp deploy@<IP_VPS>:~/app/backup_*.sql ./
```

### Restore từ backup

```bash
# Đưa file backup lên VPS
scp backup_20260420.sql deploy@<IP_VPS>:~/app/

# Restore
docker compose exec -T postgres psql -U licenseuser -d licenses < backup_20260420.sql
```

### Backup tự động (đã cấu hình sẵn)

Container `backup` chạy cron lúc 02:00 UTC hàng ngày.  
Nếu muốn bật backup lên Backblaze B2, điền `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY` vào file `.env` rồi:

```bash
docker compose restart backup
```

---

## Tổng kết URL sau khi deploy

| URL | Mô tả |
|-----|-------|
| `https://haorrr.dev/admin-manage` | Admin dashboard |
| `https://haorrr.dev/api/v1/validate` | Tool gọi để validate key |
| `https://haorrr.dev/api/v1/activate` | Tool gọi để kích hoạt lần đầu |
| `https://haorrr.dev/health` | Health check (public) |
| `https://haorrr.dev/admin/stats` | Stats API (cần JWT) |

---

## Bảo mật sau deploy

```bash
# Đổi SSH port (tùy chọn)
nano /etc/ssh/sshd_config
# Port 22 → Port 2222
systemctl restart sshd
ufw allow 2222/tcp
ufw delete allow OpenSSH

# Disable root SSH login
# PermitRootLogin no

# Cài fail2ban chống brute-force SSH
apt install fail2ban -y
systemctl enable fail2ban
```

---

*Liên hệ hỗ trợ: cập nhật file này nếu có thay đổi domain hoặc cấu hình.*
