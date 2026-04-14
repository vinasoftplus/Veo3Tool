# Hướng Dẫn Admin: License, Token User, Build Nuitka Onefile

Tài liệu này dành cho admin của `Veo3Hao`.

Mục tiêu:
- bật và quản lý license cho bản production
- tạo hoặc nạp token cho người dùng
- build app thành file `.exe` bằng Nuitka onefile

Lưu ý quan trọng:
- hiện tại `services/license.py` đang để `_DEV_MODE = True`
- nghĩa là bản dev đang bỏ qua kiểm tra license
- nếu muốn phát hành cho user, cần đổi sang `False`

---

## 1. Tổng Quan Flow Hiện Tại

Tool hiện có 2 phần chính liên quan đến tài khoản:

1. `License`
- dùng để khóa/mở phần mềm theo máy
- token license được ký bằng RSA
- license bind với `BIOS UUID`

2. `Google Labs Token`
- dùng để gọi API Veo / Flow
- token này đi cùng `PROJECT_ID`
- user có thể nạp bằng:
  - dán `ACCESS_TOKEN` + `PROJECT_ID` thủ công
  - hoặc dán cookie Google để tool tự lấy token

---

## 2. Chuẩn Bị Trước Khi Phát Hành

Kiểm tra các file chính:
- [services/license.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/license.py)
- [services/license_keygen.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/license_keygen.py)
- [routers/license_router.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/routers/license_router.py)
- [routers/settings.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/routers/settings.py)
- [services/cookie_token_service.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/cookie_token_service.py)
- [config/config.example.json](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/config/config.example.json)

Khuyến nghị:
- giữ `private_key.pem` chỉ ở máy admin
- không ship `private_key.pem` cho user
- chỉ embed `public key` vào app

---

## 3. Setup License Cho Admin

### 3.1. Tạo keypair RSA

Chạy trong thư mục `Veo3Hao`:

```bash
python services/license_keygen.py genkey
```

Kết quả:
- tạo `config/private_key.pem`
- tạo `config/public_key.pem`
- in ra public key để bạn copy

### 3.2. Nhúng public key vào app

Mở:
- [services/license.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/license.py)

Tìm biến:

```python
_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----"""
```

Thay toàn bộ public key placeholder bằng `public_key.pem` vừa tạo.

### 3.3. Tắt dev mode

Trong file:
- [services/license.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/license.py)

Đổi:

```python
_DEV_MODE = True
```

thành:

```python
_DEV_MODE = False
```

Nếu không đổi bước này thì license vẫn bị bypass.

---

## 4. Cách Tạo License Cho User

### 4.1. Lấy BIOS UUID của user

Yêu cầu user chạy:

```cmd
wmic csproduct get UUID
```

User gửi lại chuỗi UUID cho admin.

### 4.2. Ký license theo số ngày

Ví dụ cấp license 30 ngày:

```bash
python services/license_keygen.py sign "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" 30
```

Ví dụ cấp 365 ngày:

```bash
python services/license_keygen.py sign "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" 365
```

Kết quả:
- tool sẽ in ra `LICENSE TOKEN`
- gửi token này cho user

### 4.3. Verify token nếu cần

```bash
python services/license_keygen.py verify <LICENSE_TOKEN>
```

---

## 5. User Nhập License Như Thế Nào

UI license nằm trong:
- [templates/index.html](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/templates/index.html)

Flow hiện tại:
1. user mở app
2. nhập license key
3. app gọi:
   - `POST /api/license/validate`
4. nếu hợp lệ:
   - token được lưu vào `config.json` tại key `LICENSE_TOKEN`

Lưu ý thực tế:
- route validate có lưu token vào config
- nhưng code hiện tại **chưa có bước tự động đọc `LICENSE_TOKEN` từ config rồi validate lại lúc khởi động**
- tức là nếu bạn chuyển hẳn sang production, nên kiểm tra lại trải nghiệm startup

File liên quan:
- [routers/license_router.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/routers/license_router.py)
- [static/js/app.js](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/static/js/app.js)

---

## 6. Cách Tạo Token Cho Người Dùng

Tool hiện hỗ trợ 2 hướng thực tế.

### Cách 1: Admin điền thẳng token và project id

Điền vào account trong config:
- `ACCESS_TOKEN`
- `PROJECT_ID`

Ví dụ cấu trúc:

```json
{
  "account1": {
    "PROJECT_ID": "your-project-id",
    "ACCESS_TOKEN": "your-access-token",
    "TIER": "ULTRA",
    "TOKEN_EXPIRY": 0
  }
}
```

Tham chiếu:
- [config/config.example.json](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/config/config.example.json)

Khi dùng cách này:
- user không cần dán cookie
- app dùng luôn token đã cấp

### Cách 2: User dán cookie Google để tool tự lấy token

Route hiện tại:
- `POST /api/settings/cookie-to-token`

Code xử lý:
- [routers/settings.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/routers/settings.py)
- [services/cookie_token_service.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/cookie_token_service.py)

Flow:
1. user dán cookie `accounts.google.com`
2. tool lấy CSRF từ `labs.google`
3. tool follow OAuth redirect
4. tool extract `access_token`
5. tool thử lấy `project_id`
6. tool lưu lại vào account:
   - `ACCESS_TOKEN`
   - `COOKIE`
   - `EMAIL`
   - `PROJECT_ID`

Kết quả trả về hiện tại:
- `status = live`
- hoặc lỗi `die / error`

### Khi nào nên dùng cách nào

Dùng token thủ công khi:
- admin đã có sẵn token sạch
- muốn setup nhanh cho user

Dùng cookie-to-token khi:
- cần để user tự nạp token
- không muốn admin giữ token của user

---

## 7. Cách Admin Hướng Dẫn User Dán Cookie

Phần UI đã có modal trong:
- [static/js/tabs/settings.js](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/static/js/tabs/settings.js)

Tóm tắt cho user:
1. mở `https://accounts.google.com`
2. nhấn `F12`
3. vào tab `Application`
4. mở `Cookies`
5. copy toàn bộ cookie
6. dán vào ô `Lấy Token từ Cookie`

Lưu ý:
- cookie phải còn sống
- nếu Google trả `interaction_required` thì cookie không đủ cho silent OAuth
- lúc đó cần đăng nhập lại trong Chrome rồi copy cookie mới

---

## 8. Cách Check Token Và Credit

Trong backend hiện tại đã có route:

- `GET /api/settings/account-credits?account_index=0`

Route này gọi:

```text
GET https://aisandbox-pa.googleapis.com/v1/credits
Authorization: Bearer <ACCESS_TOKEN>
```

File:
- [routers/settings.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/routers/settings.py)

Ghi chú:
- trong file hiện có **2 route trùng tên `/account-credits`**
- về lâu dài nên giữ lại 1 bản duy nhất để tránh khó debug

---

## 9. Khuyến Nghị Cấu Hình Production

Trước khi build phát hành:

1. trong [services/license.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/services/license.py)
- embed public key thật
- đổi `_DEV_MODE = False`

2. trong `config.json`
- xóa token test
- xóa license test
- chỉ giữ cấu trúc mẫu

3. không ship:
- `config/private_key.pem`
- dữ liệu cookie thật
- token thật
- profile Chrome thật

---

## 10. Build Nuitka Onefile

Repo hiện không có script build Nuitka hoàn chỉnh sẵn, nên dưới đây là lệnh build đề xuất theo đúng entrypoint:
- [main.py](/d:/Downloads/VeoGenAI-v-6.1/Veo3Hao/main.py)

### 10.1. Cài dependency build

```bash
pip install -r requirements.txt
pip install nuitka ordered-set zstandard
```

Nếu chưa có WebView2 Runtime trên máy build hoặc máy user:
- cài Microsoft Edge WebView2 Runtime

### 10.2. Build onefile

Chạy trong thư mục `Veo3Hao`:

```bash
python -m nuitka ^
  --onefile ^
  --standalone ^
  --windows-console-mode=disable ^
  --enable-plugin=tk-inter ^
  --output-dir=build ^
  --output-filename=Veo3Hao.exe ^
  --include-data-dir=templates=templates ^
  --include-data-dir=static=static ^
  --include-data-dir=extension=extension ^
  --include-data-dir=google-cookie-extractor=google-cookie-extractor ^
  --include-data-dir=config=config ^
  --include-data-dir=ffmpeg=ffmpeg ^
  main.py
```

Nếu bạn build bằng CMD thay vì PowerShell, lệnh trên dùng dấu `^` là phù hợp.

Nếu muốn dùng một dòng:

```bash
python -m nuitka --onefile --standalone --windows-console-mode=disable --enable-plugin=tk-inter --output-dir=build --output-filename=Veo3Hao.exe --include-data-dir=templates=templates --include-data-dir=static=static --include-data-dir=extension=extension --include-data-dir=google-cookie-extractor=google-cookie-extractor --include-data-dir=config=config --include-data-dir=ffmpeg=ffmpeg main.py
```

### 10.3. Sau khi build

File output thường nằm ở:
- `build/Veo3Hao.exe`

Test tối thiểu:
1. app mở được cửa sổ desktop
2. backend lên được cổng `8765`
3. load được `templates` và `static`
4. vào được `Settings`
5. nhập được license
6. dán cookie hoặc token được

---

## 11. Những Thứ Không Nên Ship Cho User

Không nên đóng gói cùng bản phát hành:
- `config/private_key.pem`
- `data/jobs.db`
- `data/characters` nếu là dữ liệu riêng
- `chrome_user_data` thật
- token hoặc cookie thật

Nếu cần, chỉ ship:
- `config.example.json`
- thư mục `templates`
- `static`
- `extension`
- `google-cookie-extractor`
- `ffmpeg` nếu bạn muốn user dùng luôn bản nhúng

---

## 12. Checklist Admin Phát Hành

1. tạo RSA keypair
2. nhúng `public key` vào `services/license.py`
3. đổi `_DEV_MODE = False`
4. build `Nuitka onefile`
5. test app sạch trên máy khác
6. lấy `UUID` của user
7. ký `LICENSE TOKEN`
8. gửi user:
   - file `.exe`
   - license token
   - hướng dẫn dán cookie hoặc token

---

## 13. Gợi Ý Nâng Cấp Sau Này

Nếu muốn giống flow tool gốc hơn, nên bổ sung:
- `/api/accounts/import`
- `account_id` ổn định cho từng email
- trạng thái account:
  - `Live`
  - `Die`
  - `OutOfCredit`
- lưu cookie mới nhất để auto-import
- tự kiểm tra credit định kỳ

