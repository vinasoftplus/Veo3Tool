# Phase 01 — Import Prompt: Unified Dialog (TXT / JSON / XLSX)

## Overview

Replace the existing single-file-type import with a unified dialog that supports three formats. The dialog shows a format selector first, then processes accordingly. SheetJS handles XLSX client-side — no backend changes needed.

---

## Requirements

1. Keep existing TXT/scene logic intact (backward-compatible)
2. Add JSON import: array `["p1","p2"]` or array of objects `[{"prompt":"..."},...]`
3. Add XLSX import via SheetJS (CDN, loaded lazily on first use): each non-empty row's first cell = 1 prompt
4. Single modal with 3 radio buttons at top: TXT / JSON / XLSX
5. File input's `accept` attribute switches based on selection
6. Import result: N new cards appended to existing cards array

---

## Files to Modify

### `templates/index.html`
- **Line 280**: Change `accept=".txt"` → `accept=".txt,.json,.xlsx,.xls"`
- **Line 272–278**: Update button tooltip text from "Import prompt từ file .txt" → "Import prompt từ file"
- Add SheetJS CDN before closing `</body>`:
  ```html
  <script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>
  ```
  Place after all other `<script>` tags (around line 620+).

### `static/js/tabs/t2v.js`

#### Step 1 — Replace `importPromptFile()` (lines 413–438)

Replace entire function with a dispatcher that opens the new unified dialog:

```js
function importPromptFile(file) {
  if (!file) return;
  openImportDialog(file);
}
```

#### Step 2 — Add `openImportDialog(file)` after `importPromptFile`

New function (insert after line 438):

```js
function openImportDialog(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  // Auto-select format based on extension
  const defaultFmt = ext === 'json' ? 'json' : (ext === 'xlsx' || ext === 'xls') ? 'xlsx' : 'txt';

  let modal = document.getElementById('import-unified-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'import-unified-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:3000;display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;width:480px;max-width:95vw;">
      <div style="font-size:15px;font-weight:600;margin-bottom:16px;">Import Prompt</div>
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px;">Định dạng file:</div>
        <div style="display:flex;gap:8px;">
          ${['txt','json','xlsx'].map(f => `
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:8px 14px;border:1px solid ${f===defaultFmt?'var(--accent)':'var(--border)'};border-radius:6px;font-size:13px;flex:1;justify-content:center;" id="fmt-label-${f}">
              <input type="radio" name="import-fmt" value="${f}" ${f===defaultFmt?'checked':''} style="display:none;">
              ${f.toUpperCase()}
            </label>`).join('')}
        </div>
      </div>
      <div id="import-fmt-desc" style="font-size:12px;color:var(--text2);margin-bottom:20px;min-height:40px;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('import-unified-modal').style.display='none'">Hủy</button>
        <button class="btn btn-primary" id="import-unified-confirm">Import</button>
      </div>
    </div>`;

  const fmtDescs = {
    txt: 'Mỗi dòng không trống = 1 card. Hỗ trợ định dạng SCENE XX:.',
    json: 'Array JSON: ["prompt1","prompt2",...] hoặc [{"prompt":"..."},...]',
    xlsx: 'Mỗi hàng = 1 card. Dữ liệu lấy từ cột đầu tiên có nội dung.',
  };

  function updateDesc() {
    const sel = modal.querySelector('input[name="import-fmt"]:checked')?.value || 'txt';
    modal.querySelectorAll('[id^="fmt-label-"]').forEach(l => {
      l.style.borderColor = l.id === `fmt-label-${sel}` ? 'var(--accent)' : 'var(--border)';
    });
    modal.querySelector('#import-fmt-desc').textContent = fmtDescs[sel] || '';
  }

  modal.querySelectorAll('input[name="import-fmt"]').forEach(r => r.addEventListener('change', updateDesc));
  updateDesc();

  modal.querySelector('#import-unified-confirm').addEventListener('click', () => {
    const fmt = modal.querySelector('input[name="import-fmt"]:checked')?.value || 'txt';
    modal.style.display = 'none';
    _doUnifiedImport(file, fmt);
  });

  modal.style.display = 'flex';
  modal.onclick = ev => { if (ev.target === modal) modal.style.display = 'none'; };
  window._importUnifiedFile = file;
}
```

#### Step 3 — Add `_doUnifiedImport(file, fmt)` after `openImportDialog`

```js
function _doUnifiedImport(file, fmt) {
  if (fmt === 'json') {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result || '[]');
        const items = Array.isArray(data) ? data : [data];
        const prompts = items.map(item => {
          if (typeof item === 'string') return item.trim();
          // Object: pick first string-valued key that looks like prompt
          return (item.prompt || item.text || item.content || Object.values(item).find(v => typeof v === 'string') || '').toString().trim();
        }).filter(Boolean);
        if (!prompts.length) { toast('Không tìm thấy prompt nào trong JSON', 'error'); return; }
        prompts.forEach(p => { const c = newCard(p); cards.push(c); renderCard(c, true); });
        refreshEmpty();
        toast(`Đã import ${prompts.length} prompt từ JSON`, 'success');
      } catch (err) {
        toast('JSON không hợp lệ: ' + err.message, 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
    return;
  }

  if (fmt === 'xlsx') {
    if (typeof XLSX === 'undefined') { toast('SheetJS chưa tải xong, thử lại sau', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const prompts = rows
          .map(row => (Array.isArray(row) ? row[0] : '') + '')
          .map(v => v.trim())
          .filter(Boolean);
        if (!prompts.length) { toast('Không tìm thấy dữ liệu trong sheet', 'error'); return; }
        prompts.forEach(p => { const c = newCard(p); cards.push(c); renderCard(c, true); });
        refreshEmpty();
        toast(`Đã import ${prompts.length} prompt từ XLSX`, 'success');
      } catch (err) {
        toast('Lỗi đọc file XLSX: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
    return;
  }

  // fmt === 'txt' — delegate to existing logic
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result || '';
    if (!text.trim()) { toast('File trống', 'error'); return; }
    const hasScenes = /^SCENE\s+\d+[:\s]/im.test(text);
    if (hasScenes) {
      showImportModeDialog(text);
    } else {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) { toast('File trống hoặc không hợp lệ', 'error'); return; }
      lines.forEach(line => { const c = newCard(line); cards.push(c); renderCard(c, true); });
      refreshEmpty();
      toast(`Đã import ${lines.length} prompt`, 'success');
    }
  };
  reader.readAsText(file, 'utf-8');
}
```

#### Step 4 — Update `init_text_to_video` import handler (lines ~702–706)

Current code (around line 702):
```js
$('t2v-import-prompt').addEventListener('click', () => $('t2v-import-file').click());
$('t2v-import-file').addEventListener('change', e => {
  if (e.target.files[0]) importPromptFile(e.target.files[0]);
  e.target.value = '';
});
```

No change needed — `importPromptFile` now calls `openImportDialog` automatically.

---

## Implementation Steps

1. Add SheetJS `<script>` tag at bottom of `index.html` (before `</body>`)
2. Update `accept` attr on `#t2v-import-file` input: `.txt,.json,.xlsx,.xls`
3. Update button title text
4. In `t2v.js`: replace `importPromptFile` body to call `openImportDialog(file)`
5. Add `openImportDialog` function
6. Add `_doUnifiedImport` function
7. Keep `showImportModeDialog` and `_doImport` unchanged (TXT/scene still uses them)

---

## Success Criteria

- [ ] Clicking "Import Prompt" → dialog appears with TXT/JSON/XLSX selector
- [ ] Extension auto-selects correct format based on file extension
- [ ] TXT import: existing scene and line behavior unchanged
- [ ] JSON import: `["a","b"]` → 2 cards; `[{"prompt":"a"}]` → 1 card
- [ ] XLSX import: first column, each non-empty row → 1 card
- [ ] Empty file or invalid JSON shows error toast
- [ ] Importing appends to existing cards, does not clear them
