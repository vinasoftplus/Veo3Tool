# Hướng dẫn sử dụng VEO GEN AI

## Cài đặt & Khởi động

### 1. Cài thư viện

```bash
cd Veo3Hao
pip install fastapi "uvicorn[standard]" "pywebview>=5.3" playwright aiosqlite google-genai httpx aiofiles "PyJWT[crypto]" cryptography jinja2 python-multipart pydantic
playwright install chromium
```

### 2. Chạy phần mềm

```bash
python main.py
```

Cửa sổ desktop sẽ mở tự động tại `http://localhost:8765`.

> **Dev mode:** License check bị tắt mặc định (`_DEV_MODE = True` trong `services/license.py`). Để bật kiểm tra license thật, đổi thành `False`.

---

## Cài đặt lần đầu (Tab Cài đặt)

Trước khi dùng bất kỳ tính năng nào, vào **Cài đặt** ở thanh sidebar dưới cùng.

### API Keys

| Trường | Mô tả |
|---|---|
| YouTube Data API Key | Dùng cho tính năng YTB Key Hunter. Lấy tại Google Cloud Console |
| Gemini API Keys | Dùng cho Phụ đề, Script Analyzer, Workflow AI. Mỗi dòng 1 key. Lấy tại Google AI Studio |
| FFmpeg Path | Đường dẫn đến `ffmpeg.exe` nếu không cài sẵn trong PATH |

### Google Labs Accounts

Mỗi account cần:

| Trường | Mô tả |
|---|---|
| Project ID | ID project Google Labs (ví dụ: `my-project-123456`) |
| Access Token | Tự động lấy qua extension — không cần nhập thủ công |
| Tier | `NORMAL` / `PRO` / `ULTRA` — quyết định model được dùng |

### Cài Extension Chrome (bắt buộc)

Extension tự động lấy token và solve reCAPTCHA — **không cần làm gì thêm sau khi cài**.

1. Mở Chrome → vào `chrome://extensions`
2. Bật **Developer mode** (công tắc góc trên phải)
3. Click **Load unpacked** → chọn thư mục `Veo3Hao/extension/`
4. Đảm bảo Chrome **đã đăng nhập tài khoản Google** (ở bất kỳ tab nào)
5. Xong — extension tự động mở `labs.google` ở background, bắt token và đẩy về app mỗi 3 phút

> **Lưu ý:** Không cần mở labs.google thủ công, không cần đăng nhập riêng vào labs.google. Chỉ cần Chrome đang chạy và đã đăng nhập Google.

---

## Các tính năng

### Text to Video

Tạo video từ văn bản mô tả.

1. Nhập prompt vào ô text (mỗi dòng = 1 video riêng biệt)
2. Chọn tỷ lệ khung hình: `16:9` (ngang) / `9:16` (dọc) / `1:1` (vuông)
3. Chọn số video muốn tạo
4. Click **Tạo Video**
5. Kết quả hiện ở cột phải, video tải xong có thể xem và tải về

> **Tip:** Nhập nhiều dòng để tạo nhiều video cùng lúc (mỗi dòng chạy song song).

---

### Ảnh → Video (Image to Video)

Tạo video từ 1 ảnh tĩnh.

1. Kéo thả hoặc click chọn ảnh đầu vào
2. Nhập prompt mô tả chuyển động (tuỳ chọn)
3. Chọn tỷ lệ và số video
4. Click **Tạo Video**

---

### Start-End Video

Tạo video chuyển cảnh mượt từ ảnh bắt đầu đến ảnh kết thúc.

1. Upload **Ảnh đầu** (bắt buộc)
2. Upload **Ảnh cuối** (tuỳ chọn — bỏ trống để AI tự sinh)
3. Nhập prompt mô tả chuyển động
4. Click **Tạo Video**

---

### Video Đồng nhất (Consistent Video)

Tạo video giữ nguyên nhân vật từ ảnh tham chiếu.

**Bước 1 — Thêm nhân vật:**
1. Vào **Thư viện nhân vật** (sidebar dưới)
2. Upload ảnh chân dung rõ mặt
3. Đặt tên → Click **Upload**
4. Nhân vật được lưu và sync lên Google Labs

**Bước 2 — Tạo video:**
1. Vào **Video Đồng nhất**
2. Click chọn nhân vật (tối đa 3)
3. Nhập prompt cảnh quay
4. Chọn tỷ lệ dọc (9:16 cho consistent video)
5. Click **Tạo Video**

---

### Phụ đề (Subtitle)

Trích xuất và chèn phụ đề vào video bằng Gemini AI.

**Trích xuất phụ đề:**
1. Upload video cần tạo phụ đề
2. Chọn ngôn ngữ
3. Click **Trích xuất** — Gemini sẽ phân tích và tạo file SRT

**Chèn phụ đề (Burn):**
1. Sau khi trích xuất xong, click **Sửa & Burn**
2. Sửa nội dung SRT nếu cần
3. Click **Burn Subtitles** — FFmpeg sẽ chèn phụ đề vào video
4. Video đã burn tự động tải về

> **Yêu cầu:** Cần cài FFmpeg. Tải tại ffmpeg.org, giải nén rồi điền đường dẫn vào Cài đặt, hoặc thêm vào PATH hệ thống.

---

### Phòng Thử đồ ảo (Virtual Try-On)

Thử trang phục lên người mẫu bằng AI.

1. Upload **Ảnh người mẫu** (ảnh toàn thân hoặc nửa người)
2. Upload **Ảnh trang phục** (ảnh sản phẩm nền trắng cho kết quả tốt nhất)
3. Nhập prompt mô tả thêm (tuỳ chọn)
4. Click **Thử đồ**
5. Kết quả 2 ảnh hiển thị bên dưới

---

### Gen ảnh từ Whisk

Tạo ảnh sáng tạo kết hợp phong cách từ ảnh tham chiếu.

1. Nhập prompt mô tả ảnh
2. Upload ảnh tham chiếu (tuỳ chọn — dùng để lấy phong cách)
3. Chọn tỷ lệ và số ảnh
4. Click **Tạo ảnh**

---

### Ảnh theo kịch bản (Banana/Imagen)

Tạo nhiều ảnh theo danh sách prompt — phù hợp làm storyboard hoặc kịch bản.

1. Chọn model AI (Imagen 4 cho chất lượng cao nhất)
2. Nhập danh sách prompt, mỗi dòng 1 cảnh
3. Chọn tỷ lệ và số ảnh/cảnh
4. Click **Tạo ảnh** — toàn bộ cảnh được tạo lần lượt

---

### Cắt ảnh từ Video (Frame Cutter)

Trích xuất frame từ video để lấy ảnh tĩnh.

1. Upload video nguồn
2. Nhập thời gian bắt đầu và kết thúc (định dạng `HH:MM:SS`)
3. Chọn FPS (số ảnh cắt mỗi giây)
4. Click **Cắt frame**
5. Các ảnh hiển thị ở cột phải, click để xem full size

---

### YTB Key Hunter

Tìm video YouTube có nhiều lượt xem theo từ khoá.

1. Nhập từ khoá tìm kiếm
2. Chọn khu vực (VN, US, KR, JP...)
3. Chọn sắp xếp: Lượt xem / Liên quan / Mới nhất
4. Click **Tìm kiếm**
5. Kết quả hiển thị dạng bảng với lượt xem, like, ngày đăng

> **Yêu cầu:** Cần YouTube Data API Key trong Cài đặt.

---

### Lấy kịch bản YTB (Script Analyzer)

Tải transcript và phân tích nội dung video YouTube bằng Gemini.

1. Dán YouTube URL vào ô
2. Chọn ngôn ngữ phân tích
3. Nhập yêu cầu phân tích (tuỳ chọn — ví dụ: "phân tích hook đầu video")
4. Nhập khoảng thời gian nếu chỉ muốn phân tích đoạn cụ thể
5. Click **Phân tích**
6. Xem kết quả ở tab **Phân tích** (tóm tắt AI) hoặc **Transcript** (nội dung thô)

> **Yêu cầu:** Cần `yt-dlp` — cài bằng `pip install yt-dlp`. Video phải có phụ đề tự động (auto-generated captions).

---

### Workflow (PRO)

Xây dựng pipeline AI tự động kết nối nhiều bước xử lý.

**Tạo bằng AI:**
1. Nhập mô tả workflow muốn tạo (ví dụ: "viết lại prompt rồi tạo video")
2. Click **AI Tạo Workflow** — Gemini tự sinh sơ đồ node

**Tạo thủ công:**
- Click các node trong **Node Palette** để thêm vào workflow
- Các node tự động kết nối theo thứ tự thêm vào
- Mỗi node có ô config riêng (text, template, instruction...)

**Các loại node:**
| Node | Mô tả |
|---|---|
| Text Input | Nhập văn bản tĩnh |
| Prompt Template | Template với biến `{variable}` |
| Gemini Rewrite | Viết lại text bằng Gemini |
| Text → Video | Tạo video từ prompt |
| Image → Video | Tạo video từ media_id ảnh |
| Gen Image | Tạo ảnh từ prompt |

**Chạy workflow:**
1. Click **Chạy** — các node thực thi lần lượt theo thứ tự
2. Output của node trước tự động trở thành input của node sau
3. Kết quả hiển thị dạng JSON bên dưới

---

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| "Chưa có account có token" | Chưa lấy token hoặc token hết hạn | Vào Cài đặt → Lấy Token |
| "ffmpeg not found" | FFmpeg chưa cài | Cài FFmpeg và điền đường dẫn vào Cài đặt |
| "Chưa có Gemini API key" | Chưa nhập Gemini key | Vào Cài đặt → nhập API key |
| "Timeout chờ token" | Chrome không mở được labs.google | Kiểm tra internet, đăng nhập Google, thử lại |
| Video không tải được | Token hết hạn trong lúc tạo | Lấy lại token và thử tạo lại |
| "Không thể lấy transcript" | Video không có phụ đề tự động | Chọn video khác có captions |

---

## Cấu trúc thư mục dữ liệu

```
Veo3Hao/
├── config/
│   └── config.json          # Tất cả cài đặt (accounts, API keys)
└── data/
    ├── jobs.db              # SQLite database lưu lịch sử job
    ├── jobs/                # File video/ảnh/SRT đã tạo
    ├── characters/          # Ảnh nhân vật thư viện
    └── chrome_userdata/     # Chrome profile cho token collection
```

---

## Quản lý License (cho Admin)

```bash
# Tạo keypair (chạy 1 lần)
python services/license_keygen.py genkey

# Tạo license cho user (nhập UUID máy tính của user)
python services/license_keygen.py sign <BIOS_UUID> <số_ngày>

# Ví dụ: license 30 ngày
python services/license_keygen.py sign "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" 30

# Xác minh license
python services/license_keygen.py verify <token>
```

User lấy UUID máy bằng lệnh:
```cmd
wmic csproduct get uuid
```
