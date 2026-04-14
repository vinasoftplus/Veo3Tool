# Plan: Studio Features — Veo3Tool

**Date:** 2026-04-14  
**Stack:** Python FastAPI + Vanilla JS  
**Theme:** Dark (CSS variables in `static/css/app.css`)  
**Language:** Vietnamese UI

---

## Overview

Four independent phases, each self-contained. Recommended execution order:

| Phase | Feature | Effort | Risk |
|-------|---------|--------|------|
| 01 | Import Prompt (JSON/XLSX/TXT unified dialog) | Medium | Low |
| 02 | Card improvements (+ Card, Clone buttons) | Low | Low |
| 03 | New "Studio" sidebar tab | High | Medium |
| 04 | Remove Grok features | Low (none found) | None |

---

## Key Findings from Codebase Analysis

### Architecture
- `templates/index.html` — single-page app; all tab HTML lives here
- `static/js/app.js` — tab switcher; calls `window.init_<tab_id>()` once on first visit
- `static/js/tabs/t2v.js` — IIFE module; exposes `window.T2V`
- `static/js/api.js` — shared `API`, `toast`, `pollJob`, `downloadUrl` helpers
- `static/css/app.css` — single CSS file, CSS variables for theme
- `routers/image.py` — image generation/save endpoints (prefix `/api/image`)
- `services/job_store.py` — SQLite jobs table; `type` + `status` columns already filterable
- `services/config_service.py` — `DATA_DIR = data/`, `BASE_DIR`
- `app.py` — mounts `/jobs` and `/characters` static dirs; router registration

### Grok Audit
No `grok`/`Grok`/`GROK` strings found in any `.html`, `.js`, or `.py` file. Phase 04 is a no-op.

### Import Current State (t2v.js lines 381–498)
- `importPromptFile()` reads `.txt`, calls `showImportModeDialog()` for SCENE format
- `showImportModeDialog()` presents scene-vs-line choice
- `t2v-import-file` input accepts only `.txt` (line 280 of `index.html`)
- No JSON or XLSX support

### Card Header (t2v.js lines 113–134)
Current header HTML (built in `renderCard`):
```
#idx | statusDot | prompt-preview | [▶ Tạo Video] [🗑]
```
Need to add `[+ Card ▼]` and `[Nhân bản]` buttons before delete.

### Studio Tab Requirements
- New nav entry in sidebar (HÌNH ẢNH section)
- New `<div id="tab-studio" class="tab-panel">` in `index.html`
- New `static/js/tabs/studio.js` loaded via `<script>` tag
- Backend: `POST /api/image/studio/save-to-library` (save to `data/studio/`)
- `app.py`: mount `/studio` static dir, register no new router (endpoint in `image.py`)

---

## Files Modified Per Phase

| File | Ph01 | Ph02 | Ph03 | Ph04 |
|------|------|------|------|------|
| `templates/index.html` | yes | no | yes | no |
| `static/js/tabs/t2v.js` | yes | yes | no | no |
| `static/css/app.css` | no | yes | yes | no |
| `static/js/tabs/studio.js` | no | no | NEW | no |
| `routers/image.py` | no | no | yes | no |
| `app.py` | no | no | yes | no |

---

## Phases

- [phase-01-import-prompt.md](./phase-01-import-prompt.md)
- [phase-02-card-improvements.md](./phase-02-card-improvements.md)
- [phase-03-studio-tab.md](./phase-03-studio-tab.md)
- [phase-04-remove-grok.md](./phase-04-remove-grok.md)
