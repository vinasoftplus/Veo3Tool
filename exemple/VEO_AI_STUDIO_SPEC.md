# VEO AI Studio - Comprehensive Feature Specification

## 1. Application Overview

**Application Name:** Veo AI Automation Studio  
**Technology Stack:** SvelteKit (frontend), Tauri (desktop), Rust (backend)  
**Language:** Vietnamese UI, English APIs  
**Architecture:** Desktop app with local API server backend

---

## 2. Pages/Routes

- **Main Dashboard/Studio** (`/`) - Primary workspace
- **Settings Page** - App configuration
- **Account Management** - User accounts
- **Workflow/Batch Management** - Workflow documents

---

## 3. Core Features

### 3.1 Account Management

**Account Types:**
- Veo AI Accounts (Google AI Studio for Veo models)
- Grok Accounts (X/Twitter API for image generation)

**Tauri Commands:**
- `initialize_accounts` - Init all accounts on startup
- `sync_accounts_from_frontend` - Sync account data from UI
- `get_backend_accounts_count` - Get total account count
- `open_account_browser` - Open browser for auth
- `delete_account` - Remove account
- `import_accounts_from_file` - Import from JSON/CSV
- `import_accounts_from_text` - Paste accounts as text
- `reload_account` - Refresh individual account
- `reload_all_accounts` - Refresh all accounts
- `reload_all_accounts_with_delay` - Staggered refresh
- `delete_all_accounts` - Remove all accounts
- `set_account_proxy` - Configure per-account proxy
- `set_proxies_bulk` - Batch proxy configuration
- `toggle_disable_account` - Enable/disable account
- `mark_account_timeout` - Mark account as timed out
- `get_info_account` - Get general account info
- `get_info_veo_account` - Get Veo-specific details
- `get_info_grok_account` - Get Grok-specific details
- `get_upload_token` - Get token for image uploads

---

### 3.2 Prompt Management

**Commands:**
- `import_prompts_from_file` - Load prompts from Excel/CSV
- `run_prompt` - Execute single prompt
- `run_prompt_with_custom_content` - Run with custom image/text
- `run_all_prompts` - Execute all prompts in batch
- `run_selected_prompts` - Execute selected prompts
- `set_prompt_status_to_submitted` - Mark as submitted
- `cancel_prompt` - Cancel individual prompt
- `cancel_all_prompts` - Cancel all running prompts
- `update_prompt_content` - Modify prompt parameters
- `create_empty_prompts` - Create blank prompts
- `clear_cache` - Clear system cache
- `clear_all_prompts` - Clear entire prompt DB
- `parse_excel_prompts` - Parse Excel format
- `parse_text_prompts` - Parse text-based prompts

**Prompt Data Model:**
```
Prompt {
  id: string (uuid)
  content: string
  status: "submitted" | "pending" | "processing" | "completed" | "failed" | "cancelled" | "waiting"
  media_id: string
  scene_id: string
  account_id: string
  model: string
  aspect_ratio: string
  resolution: number
  context_images: Array[base64]
  style_image: base64
  generated_paths: Array[string]
}
```

---

### 3.3 Image Generation

#### Grok Image Generation (Google AI Studio)
- `generate_grok_images` - Text-to-image
- `generate_grok_image_to_video` - Image to video
- `generate_grok_text_to_video` - Text to video
- `preview_grok_video_payload` - Preview params

**Variants:**
- `generate_images_from_prompt`
- `generate_images_from_prompt_and_image`
- `generate_images_from_text`
- `generate_images_from_text_and_image`
- `generate_images_from_text_image_and_style`
- `generate_images_with_multiple_context_and_style`
- `generate_images_with_two_context`
- `generate_images_default`
- `generate_images_default2`

#### Dreamina Image Generation
- `generate_dreamina_image`
- `generate_dreamina_image_with_images`
- `poll_dreamina_result`
- `upload_image_for_reference`
- `upload_image_to_imagex`

---

### 3.4 Video Generation Models

#### Text-to-Video (T2V) - Veo 3.1
- `veo_3_1_t2v` - Base
- `veo_3_1_t2v_portrait` - Portrait
- `veo_3_1_t2v_fast` - Fast
- `veo_3_1_t2v_fast_portrait`
- `veo_3_1_t2v_fast_ultra`
- `veo_3_1_t2v_fast_portrait_ultra`
- `veo_3_1_t2v_fast_ultra_relaxed`
- `veo_3_1_t2v_fast_portrait_ultra_relaxed`

#### Text-to-Video (T2V) - Veo 3.0
- `veo_3_0_t2v`, `veo_3_0_t2v_portrait`
- `veo_3_0_t2v_pro`, `veo_3_0_t2v_pro_portrait`
- `veo_3_0_t2v_fast`, `veo_3_0_t2v_fast_portrait`
- `veo_3_0_t2v_fast_ultra`, `veo_3_0_t2v_fast_portrait_ultra`

#### Legacy
- `veo_2_1_fast_d_15_t2v`

#### Image-to-Video (I2V) - Veo 3.1
- `veo_3_1_i2v_s`
- `veo_3_1_i2v_s_portrait`
- `veo_3_1_i2v_s_fast_ultra`
- `veo_3_1_i2v_s_fast_portrait_ultra`
- `veo_3_1_i2v_s_fast_portrait_ultra_relaxed`
- `veo_3_1_i2v_s_fast_ultra_fl`
- `veo_3_1_i2v_s_fast_portrait_ultra_fl`
- `veo_3_1_i2v_s_fast_fl`
- `veo_3_1_i2v_s_fast_portrait_fl`
- `veo_3_1_i2v_s_fast_fl_ultra_relaxed`

#### Image-to-Video (I2V) - Veo 3.0 Legacy
- `veo_3_i2v_s_fast_ultra`
- `veo_3_i2v_s_fast_portrait_ultra`
- `veo_3_i2v_s_fast`
- `veo_3_i2v_s_fast_portrait`

#### Reference-to-Video (R2V) - Veo 3.1
- `veo_3_1_r2v_landscape`, `veo_3_1_r2v_portrait`
- `veo_3_1_r2v_landscape_ultra`, `veo_3_1_r2v_portrait_ultra`
- `veo_3_1_r2v_landscape_ultra_relaxed`, `veo_3_1_r2v_portrait_ultra_relaxed`
- `veo_3_1_r2v_fast_landscape`, `veo_3_1_r2v_fast_portrait`
- `veo_3_1_r2v_fast_landscape_ultra`, `veo_3_1_r2v_fast_portrait_ultra`
- `veo_3_1_r2v_fast_landscape_ultra_relaxed`, `veo_3_1_r2v_fast_portrait_ultra_relaxed`

#### R2V - Veo 3.0 Legacy
- `veo_3_0_r2v_fast_ultra_relaxed`

**Video Commands:**
- `run_i2v_from_image`
- `run_i2v_from_image_for_generation`
- `create_i2v_image_gen_prompt_pending`
- `run_frame_by_frame_video`

---

### 3.5 Video Enhancement & Processing

**Upscaling:**
- `upscale_banana_pro_image_4k` - 4K upscale
- `upscale_banana_pro_image_2k` - 2K upscale
- `upscale_video` - Video upscaling

**Video Processing:**
- `extract_video_screenshot` - Extract frame
- `extract_video_screenshot_hq` - High-quality frame
- `set_ffmpeg_directory` - Configure FFmpeg path
- `merge_videos_concat` - Concatenate videos
- `merge_audio_image_to_video` - Combine audio + image
- `merge_audio_image_to_video_with_transition` - With transition
- `remove_background_from_base64` - Remove background

**File Operations:**
- `save_completed_videos`, `save_i2v_videos`
- `save_i2v_videos_with_mappings`
- `save_video`, `save_video_blob`
- `save_generated_images`, `save_single_image`, `save_single_video`
- `copy_video_files`, `fetch_image_from_url`
- `list_images_in_directory`, `list_files_by_extension`

---

### 3.6 Batch/Cluster Processing

**Commands:**
- `run_uniform_video_cluster` - Execute uniform batch
- `run_all_uniform_video_clusters` - Execute all clusters
- `import_storyboard_from_excel` - Import clip sequences from Excel

**Vietnamese Terms:**
- "Cụm" = Cluster/Batch
- "Tạo tất cả hình" = Generate All Images
- "Xóa hình khỏi cụm" = Remove image from cluster
- "Xóa tất cả cụm" = Delete all clusters

---

### 3.7 Workflow Management

- `create_workflow_document`
- `rename_workflow_document`
- `delete_workflow_document`
- `load_workflow_snapshots`
- `save_workflow_snapshot`
- `export_workflow_db`
- `import_workflow_db`
- `migrate_legacy_workflow_storage`
- `duplicate_workflow_document`

---

### 3.8 Data Import/Export

- `import_accounts_from_file` / `import_accounts_from_text`
- `import_prompts_from_file`
- `import_storyboard_from_excel`
- `import_workflow_db` / `export_workflow_db`
- `download_url_as_base64` / `download_url_to_file`
- `fetch_url_text`
- `http_proxy_json` / `http_proxy_multipart`
- `proxy_deepseek_request`

---

### 3.9 System & Utilities

- `get_api_port` - Get backend API port
- `check_api_server_health` - Check API server
- `write_frontend_log` - Write to log file
- `validate_license_key` - Verify license
- `logout` - Logout user
- `update_app` - Update application
- `save_temp_file`, `write_binary_file`, `copy_video_files`

---

## 4. UI Components

### 4.1 Top Navigation Bar
| Button | Action |
|--------|--------|
| Tạo tất cả hình | Generate all images |
| Setting (⚙) | Open settings |
| Import Image | Import image file |
| Export Prompts | Export prompts |
| Import Prompts | Import prompts |

### 4.2 Main Tabs
1. **Cài đặt chung** - General Settings
2. **Model** (Veo3.1 Fast) - Model selection
3. **Kho Lưu Trữ** - Storage/Archive
4. **Auto Prompt** - Auto prompt generation
5. **Thêm cụm** - Add Cluster

### 4.3 Settings Fields
| Field | Options |
|-------|---------|
| TỶ LỆ KHUNG HÌNH | 16:9, 9:16, 4:3, 1:1, custom |
| ẢNH / CỤM | 1, 2, 3, 4, 5 ảnh |
| MODAL GEN HÌNH ẢNH | Banana PRO, others |

### 4.4 Sidebar Status Filter
```
Tất cả cụm (All clusters)
VIDEO:
  ● Chờ (Waiting)
  ● Đang chạy (Running)
  ● Đang xử lý (Processing)
  ● Xong (Completed)
  ● Lỗi (Error)
HÌNH ẢNH:
  ● Ảnh đang xử lý (Processing)
  ● Ảnh hoàn tất (Completed)
  ● Ảnh lỗi (Failed)
```

### 4.5 Bottom Controls
- "Xóa hình khỏi cụm" button
- "Xóa tất cả cụm" button
- BỘ LỌC dropdown (advanced filter)

---

## 5. Data Models

### 5.1 Account
```typescript
Account {
  id: string
  type: "veo" | "grok"
  email: string
  status: "active" | "inactive" | "error" | "timeout"
  proxy?: ProxyConfig
  cookies?: string
  access_token?: string
  refresh_token?: string
  quota_remaining: number
  last_synced: timestamp
}

ProxyConfig { host, port, username?, password? }
```

### 5.2 Cluster
```typescript
Cluster {
  id: string
  name: string
  status: "pending" | "running" | "completed" | "failed" | "mixed"
  prompts: Prompt[]
  settings: { model, aspect_ratio, images_per_cluster }
  stats: { total, completed, failed, processing }
}
```

### 5.3 Workflow
```typescript
Workflow {
  id: string
  name: string
  clusters: Cluster[]
  snapshots: WorkflowSnapshot[]
  settings: { auto_save, parallel_processing, max_concurrent_jobs }
}
```

---

## 6. API Integrations

| Service | Purpose | Endpoint |
|---------|---------|----------|
| Google AI Studio | Veo video generation | `https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideo` |
| Local API Server | IPC bridge | `localhost:{port}` |
| ImageX | Image processing | External |
| Banana API | 4K/2K upscaling | External |
| DeepSeek | AI proxy | External |
| FFmpeg | Video processing | Local binary |

---

## 7. Status States

| Status | Vietnamese | Description |
|--------|-----------|-------------|
| submitted | Đã gửi | Sent to API |
| pending | Chờ xử lý | Awaiting processing |
| processing | Đang xử lý | Generating |
| completed | Hoàn tất | Done |
| failed | Lỗi | Failed |
| cancelled | Đã hủy | User cancelled |
| waiting | Đang chờ | Queued |

---

## 8. Error Messages (Vietnamese)

- "Grok không trả về hình ảnh nào" - Grok returned no images
- "Không thể ghi file tạm Grok reference" - Cannot write temp file
- "Ảnh base64 Grok reference không hợp lệ" - Invalid base64 image
- "Cookie die vui lòng thay cookie và thử lại" - Cookie expired

---

## 9. Tech Stack

### Frontend
- **Framework:** SvelteKit
- **Build:** Vite (immutable asset bundling)
- **Assets:** PNG logos, CSS

### Backend (Tauri/Rust)
- IPC command bridge
- Windows native menus
- Fine-grained permissions

### External Services
- Google AI Studio (Veo)
- ImageX
- DeepSeek proxy
- Banana API (upscaling)
- FFmpeg (video)

---

## 10. File Types Supported

| Type | Extension | Use |
|------|-----------|-----|
| Excel | .xlsx, .xls | Prompt/storyboard import |
| Text | .txt | Prompt definitions |
| Images | .png, .jpg, .jpeg | Reference & output |
| Video | .mp4 | Generation output |
| JSON | .json | Account/workflow export |
| CSV | .csv | Batch import |

---

## 11. UI Flow

```
Launch App
  ├─ Initialize Accounts (Veo + Grok)
  ├─ Check API Server Health
  └─ Load Last Workflow

Main Interface
  ├─ Tab Navigation (5 tabs)
  ├─ Settings: Model, Aspect Ratio, Cluster, Quality
  ├─ Sidebar Filter: Status per cluster
  └─ Top Controls: Generate All, Import/Export, Settings

Generation Workflow
  ├─ Create/Load Prompts
  ├─ Configure Parameters (model, ratio, quality)
  ├─ Submit Batch
  ├─ Monitor Status (real-time)
  └─ Download Results
```

---

## 12. Feature Matrix

| Feature | Count | Status |
|---------|-------|--------|
| Account Management | 18 commands | Full |
| Prompt Management | 14 commands | Full |
| Image Generation | 12+ variants | Grok + Dreamina |
| Video Generation | 30+ model variants | Veo 3.1/3.0/2.1 |
| Video Enhancement | 5+ operations | Upscale + merge |
| Batch Processing | 3 cluster ops | Full |
| Workflow Management | 8 CRUD ops | Full + snapshots |
| Import/Export | 8+ ops | Excel/JSON/CSV/Text |
| System | API health, logs, updates | Full |
