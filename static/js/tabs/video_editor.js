/* ── Video Editor Tab ── */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let files = [];          // { name, size, path (for backend) }
  let dragSrcIdx = null;
  let currentJobId = null;
  let pollTimer = null;
  let saveHandle = null;   // FileSystemDirectoryHandle (showDirectoryPicker)
  let saveFolder = '';     // fallback: path string từ prompt()

  // ── DOM refs (resolved on init) ──
  let $dropZone, $fileInput, $fileList, $countBadge;
  let $trimEnabled, $trimBody, $trimStart, $trimEnd, $unitStart, $unitEnd;
  let $mergeMode, $loopField, $loopDuration, $audioField, $audioPath, $audioInput;
  let $transition, $xfadeField, $xfadeDur;
  let $quality;
  let $outputName;
  let $mergeBtn;
  let $progressCard, $progressFill, $progressPct, $progressMsg, $cancelBtn;
  let $infoTotal, $infoMode, $infoTrans, $infoQuality, $infoTrim;
  let $log, $clearLog;
  let $clearAll;

  // ── Init ───────────────────────────────────────────────────
  window.init_video_editor = function () {
    _resolve();
    _bindEvents();
    _updateInfo();
    _log('Video Editor sẵn sàng.', 'ok');
  };

  // ── Log toggle (global so onclick can reach it) ──
  window._veToggleLog = function () {
    const log = document.getElementById('ve-log');
    const chevron = document.getElementById('ve-log-chevron');
    if (!log) return;
    const hidden = log.classList.toggle('ve-log-hidden');
    if (chevron) chevron.style.transform = hidden ? 'rotate(180deg)' : '';
  };

  function _resolve() {
    $dropZone    = document.getElementById('ve-drop-zone');
    $fileInput   = document.getElementById('ve-file-input');
    $fileList    = document.getElementById('ve-file-list');
    $countBadge  = document.getElementById('ve-count-badge');
    $trimEnabled = document.getElementById('ve-trim-enabled');
    $trimBody    = document.getElementById('ve-trim-body');
    $trimStart   = document.getElementById('ve-trim-start');
    $trimEnd     = document.getElementById('ve-trim-end');
    $unitStart   = document.getElementById('ve-unit-start');
    $unitEnd     = document.getElementById('ve-unit-end');
    $mergeMode   = document.getElementById('ve-merge-mode');
    $loopField   = document.getElementById('ve-loop-field');
    $loopDuration= document.getElementById('ve-loop-duration');
    $audioField  = document.getElementById('ve-audio-field');
    $audioPath   = document.getElementById('ve-audio-path');
    $audioInput  = document.getElementById('ve-audio-input');
    $transition  = document.getElementById('ve-transition');
    $xfadeField  = document.getElementById('ve-xfade-field');
    $xfadeDur    = document.getElementById('ve-xfade-dur');
    $quality     = document.getElementById('ve-quality');
    $outputName  = document.getElementById('ve-output-name');
    $mergeBtn    = document.getElementById('ve-merge-btn');
    $progressCard= document.getElementById('ve-progress-card');
    $progressFill= document.getElementById('ve-progress-fill');
    $progressPct = document.getElementById('ve-progress-pct');
    $progressMsg = document.getElementById('ve-progress-msg');
    $cancelBtn   = document.getElementById('ve-cancel-btn');
    $infoTotal   = document.getElementById('ve-info-total');
    $infoMode    = document.getElementById('ve-info-mode');
    $infoTrans   = document.getElementById('ve-info-trans');
    $infoQuality = document.getElementById('ve-info-quality');
    $infoTrim    = document.getElementById('ve-info-trim');
    $log         = document.getElementById('ve-log');
    $clearLog    = document.getElementById('ve-clear-log');
    $clearAll    = document.getElementById('ve-clear-all');
  }

  function _bindEvents() {
    // Drop zone
    $dropZone.addEventListener('dragover', e => { e.preventDefault(); $dropZone.classList.add('dragover'); });
    $dropZone.addEventListener('dragleave', () => $dropZone.classList.remove('dragover'));
    $dropZone.addEventListener('drop', e => {
      e.preventDefault();
      $dropZone.classList.remove('dragover');
      _addFiles(Array.from(e.dataTransfer.files));
    });
    $fileInput.addEventListener('change', () => _addFiles(Array.from($fileInput.files)));

    // Trim toggle
    $trimEnabled.addEventListener('change', () => {
      $trimBody.classList.toggle('ve-disabled', !$trimEnabled.checked);
      _updateInfo();
    });
    $trimBody.classList.add('ve-disabled');

    // Merge mode
    _segBind($mergeMode, val => {
      $loopField.style.display = val === 'loop' ? '' : 'none';
      $audioField.style.display = val === 'audio' ? '' : 'none';
      _updateInfo();
    });

    // Audio file pick
    $audioInput.addEventListener('change', () => {
      if ($audioInput.files[0]) $audioPath.value = $audioInput.files[0].name;
    });

    // Transition
    _segBind($transition, val => {
      if ((val === 'fade' || val === 'xfade') && _qualityVal() === 'copy') {
        // Revert to none
        $transition.querySelectorAll('.ve-seg-btn').forEach(b => b.classList.remove('active'));
        $transition.querySelector('.ve-seg-btn[data-val="none"]').classList.add('active');
        $xfadeField.style.display = 'none';
        toast('Để dùng Fade/Xfade, chọn chất lượng từ Fast trở lên.', 'info', 4000);
        _updateInfo();
        return;
      }
      $xfadeField.style.display = (val === 'xfade' || val === 'fade') ? '' : 'none';
      _updateInfo();
    });

    // Quality
    $quality.querySelectorAll('.ve-quality-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $quality.querySelectorAll('.ve-quality-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // If copy selected and transition is fade/xfade → reset transition to none
        if (btn.dataset.val === 'copy') {
          const trans = _segVal($transition);
          if (trans === 'fade' || trans === 'xfade') {
            $transition.querySelectorAll('.ve-seg-btn').forEach(b => b.classList.remove('active'));
            $transition.querySelector('.ve-seg-btn[data-val="none"]').classList.add('active');
            $xfadeField.style.display = 'none';
            toast('Transition đã đặt về None. Để dùng Fade/Xfade, chọn chất lượng từ Fast trở lên.', 'info', 4000);
          }
        }
        _updateInfo();
      });
    });

    // Merge
    $mergeBtn.addEventListener('click', _startMerge);

    // Cancel
    $cancelBtn.addEventListener('click', _cancelJob);

    // Log clear
    $clearLog.addEventListener('click', () => {
      $log.innerHTML = '<div class="ve-log-empty">Chưa có thao tác nào...</div>';
    });

    // Clear all
    $clearAll.addEventListener('click', () => {
      files = [];
      _renderFileList();
      _updateInfo();
      _log('Đã xoá tất cả video.', 'warn');
    });

    // Output folder picker
    document.getElementById('ve-pick-output').addEventListener('click', _chooseFolder);

    // Preview close
    const previewClose = document.getElementById('ve-preview-close');
    if (previewClose) previewClose.addEventListener('click', _closePreview);

    // Volume sliders
    const volOrig = document.getElementById('ve-vol-orig');
    const volBg   = document.getElementById('ve-vol-bg');
    if (volOrig) volOrig.addEventListener('input', () => {
      document.getElementById('ve-vol-orig-val').textContent = volOrig.value + '%';
    });
    if (volBg) volBg.addEventListener('input', () => {
      document.getElementById('ve-vol-bg-val').textContent = volBg.value + '%';
    });
  }

  // ── Segment control helper ──
  function _segBind(container, cb) {
    if (!container) return;
    container.querySelectorAll('.ve-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.ve-seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        cb(btn.dataset.val);
      });
    });
  }
  function _segVal(container) {
    const active = container && container.querySelector('.ve-seg-btn.active');
    return active ? active.dataset.val : null;
  }

  function _qualityVal() {
    const btn = $quality && $quality.querySelector('.ve-quality-btn.active');
    return btn ? btn.dataset.val : 'medium';
  }

  // ── File management ──────────────────────────────────────────
  function _addFiles(newFiles) {
    newFiles.forEach(f => {
      if (!f.type.startsWith('video/') && !/\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)$/i.test(f.name)) return;
      if (files.find(x => x.name === f.name)) return; // dedupe
      files.push({ name: f.name, size: f.size, file: f });
    });
    _renderFileList();
    _updateInfo();
    if (newFiles.length) _log(`Đã thêm ${newFiles.length} video.`);
  }

  function _renderFileList() {
    $countBadge.textContent = `${files.length} video`;
    if (files.length === 0) {
      $dropZone.style.display = '';
      $fileList.style.display = 'none';
      return;
    }
    $dropZone.style.display = 'none';
    $fileList.style.display = '';
    $fileList.innerHTML = files.map((f, i) => `
      <div class="ve-file-item" draggable="true" data-idx="${i}">
        <span class="ve-file-drag-handle">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>
          </svg>
        </span>
        <span class="ve-file-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
        <span class="ve-file-size">${_fmtSize(f.size)}</span>
        <button class="ve-file-remove" data-idx="${i}" title="Xoá" aria-label="Xoá video">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');

    // Remove buttons
    $fileList.querySelectorAll('.ve-file-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        files.splice(+btn.dataset.idx, 1);
        _renderFileList();
        _updateInfo();
      });
    });

    // Drag-to-reorder
    $fileList.querySelectorAll('.ve-file-item').forEach(item => {
      item.addEventListener('dragstart', () => {
        dragSrcIdx = +item.dataset.idx;
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', e => { e.preventDefault(); });
      item.addEventListener('drop', e => {
        e.preventDefault();
        const targetIdx = +item.dataset.idx;
        if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
        const moved = files.splice(dragSrcIdx, 1)[0];
        files.splice(targetIdx, 0, moved);
        dragSrcIdx = null;
        _renderFileList();
      });
    });
  }

  // ── Info panel update ──
  function _updateInfo() {
    $infoTotal.textContent = files.length;
    const mode = _segVal($mergeMode) || 'normal';
    const modeMap = { normal: 'Thường', loop: 'Loop', audio: 'Audio' };
    $infoMode.textContent = modeMap[mode] || mode;
    $infoTrans.textContent = _segVal($transition) || 'none';
    const qBtn = $quality && $quality.querySelector('.ve-quality-btn.active');
    $infoQuality.textContent = qBtn ? qBtn.dataset.val : 'medium';
    $infoTrim.textContent = $trimEnabled && $trimEnabled.checked ? 'Bật' : 'Tắt';
  }

  // ── Folder picker ─────────────────────────────────────────
  async function _chooseFolder() {
    if (window.showDirectoryPicker) {
      try {
        saveHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        saveFolder = saveHandle.name;
        _setFolderLabel(saveFolder);
        _log('Đã chọn thư mục: ' + saveFolder, 'ok');
        return;
      } catch (e) {
        if (e.name !== 'AbortError') _log('Không thể chọn thư mục.', 'err');
        return;
      }
    }
    // Fallback: manual path input
    const path = prompt('Nhập đường dẫn thư mục lưu (vd: D:\\Videos):', saveFolder || '');
    if (path && path.trim()) {
      saveHandle = null;
      saveFolder = path.trim();
      _setFolderLabel(saveFolder);
      _log('Đã lưu thư mục: ' + saveFolder, 'ok');
    }
  }

  function _setFolderLabel(path) {
    const btn = document.getElementById('ve-pick-output');
    const inp = document.getElementById('ve-output-folder-display');
    if (inp) inp.value = path || '';
    if (btn) btn.title = path || 'Chọn thư mục lưu';
  }

  // ── Merge ─────────────────────────────────────────────────
  async function _startMerge() {
    if (files.length < 2) {
      _log('Cần ít nhất 2 video để ghép.', 'err');
      return;
    }

    const mode      = _segVal($mergeMode) || 'normal';
    const transition= _segVal($transition) || 'none';
    const quality   = ($quality && $quality.querySelector('.ve-quality-btn.active')?.dataset.val) || 'medium';
    const trimUnit  = 'seconds';
    const trimEnabled = $trimEnabled.checked;
    const outputName = $outputName.value.trim() || 'output.mp4';

    const payload = {
      files: files.map(f => f.name),
      mode,
      transition,
      quality,
      output_name: outputName,
      output_folder: saveFolder || '',
      trim_enabled: trimEnabled,
      trim_unit: trimUnit,
      trim_start: trimEnabled ? parseFloat($trimStart.value) || 0 : 0,
      trim_end:   trimEnabled ? parseFloat($trimEnd.value) || 0 : 0,
      loop_duration: mode === 'loop' ? parseFloat($loopDuration.value) || 60 : null,
      xfade_duration: (transition === 'xfade' || transition === 'fade')
        ? parseFloat($xfadeDur.value) || 0.5 : null,
      vol_orig: mode === 'audio' ? (parseInt(document.getElementById('ve-vol-orig')?.value) || 100) : 100,
      vol_bg:   mode === 'audio' ? (parseInt(document.getElementById('ve-vol-bg')?.value)   || 80)  : 80,
    };

    // For browser-side File objects, upload them first
    if (files[0].file) {
      const form = new FormData();
      files.forEach(f => form.append('videos', f.file, f.name));
      // Attach audio file if mode=audio and user picked one
      if (mode === 'audio' && $audioInput && $audioInput.files[0]) {
        form.append('audio', $audioInput.files[0], $audioInput.files[0].name);
      }
      Object.entries(payload).forEach(([k, v]) => {
        if (v !== null && v !== undefined) form.append(k, v);
      });
      _setMerging(true);
      _log('Đang tải lên và ghép video...');
      try {
        const res = await fetch('/api/video-editor/merge', { method: 'POST', headers: _appHeaders(), body: form });
        const data = await res.json();
        if (!res.ok) { _log('Lỗi: ' + (data.error || res.status), 'err'); _setMerging(false); return; }
        currentJobId = data.job_id;
        _log(`Job #${currentJobId} đã tạo. Đang xử lý...`);
        _pollJob();
      } catch (e) {
        _log('Lỗi kết nối: ' + e.message, 'err');
        _setMerging(false);
      }
      return;
    }

    _setMerging(true);
    _log('Bắt đầu ghép video...');
    try {
      const res = await fetch('/api/video-editor/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { _log('Lỗi: ' + (data.error || res.status), 'err'); _setMerging(false); return; }
      currentJobId = data.job_id;
      _pollJob();
    } catch (e) {
      _log('Lỗi kết nối: ' + e.message, 'err');
      _setMerging(false);
    }
  }

  function _pollJob() {
    if (!currentJobId) return;
    pollTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/video-editor/job/${currentJobId}`, { headers: _appHeaders() });
        const data = await res.json();
        _setProgress(data.progress || 0, data.message || '');
        if (data.status === 'completed') {
          _log(`Hoàn tất! File: ${data.output || ''}`, 'ok');
          _setMerging(false);
          const jid = currentJobId;
          currentJobId = null;
          await _downloadOutput(jid, data.output_name || 'output.mp4');
        } else if (data.status === 'failed') {
          _log('Thất bại: ' + (data.error || ''), 'err');
          _setMerging(false);
          currentJobId = null;
        } else {
          _pollJob();
        }
      } catch {
        _pollJob();
      }
    }, 800);
  }

  function _closePreview() {
    const card = document.getElementById('ve-preview-card');
    const video = document.getElementById('ve-preview-video');
    if (video) { video.pause(); video.src = ''; }
    if (card) card.style.display = 'none';
  }

  async function _downloadOutput(jobId, filename) {
    const url = `/api/video-editor/download/${jobId}`;
    const resp = await fetch(url, { headers: _appHeaders() });
    if (!resp.ok) { _log('Tải file thất bại.', 'err'); return; }
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);

    // Show preview
    const previewCard = document.getElementById('ve-preview-card');
    const previewVideo = document.getElementById('ve-preview-video');
    if (previewCard && previewVideo) {
      previewVideo.src = objUrl;
      previewCard.style.display = '';
      previewVideo.play().catch(() => {});
    }

    // Save to folder if chosen
    if (saveHandle) {
      try {
        const fileHandle = await saveHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        _log(`Đã lưu vào: ${saveHandle.name}/${filename}`, 'ok');
        return;
      } catch (e) {
        _log('Không thể lưu vào thư mục: ' + e.message, 'err');
      }
    }
    // Fallback: browser download
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    if (saveFolder) _log(`Đã tải về. Thư mục đích: ${saveFolder}`, 'ok');
    else _log('Đã tải về thư mục Downloads.', 'ok');
  }

  async function _cancelJob() {
    if (currentJobId) {
      clearTimeout(pollTimer);
      try { await fetch(`/api/video-editor/job/${currentJobId}/cancel`, { method: 'POST', headers: _appHeaders() }); } catch {}
      _log('Đã huỷ.', 'warn');
    }
    _setMerging(false);
    currentJobId = null;
  }

  function _setMerging(on) {
    $mergeBtn.disabled = on;
    $progressCard.style.display = on ? '' : 'none';
    if (!on) _setProgress(0, '');
  }

  function _setProgress(pct, msg) {
    $progressFill.style.width = pct + '%';
    $progressPct.textContent = pct + '%';
    $progressMsg.textContent = msg;
  }

  // ── Log ──
  function _log(text, type = '') {
    const empty = $log.querySelector('.ve-log-empty');
    if (empty) empty.remove();
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    const line = document.createElement('div');
    line.className = 've-log-line' + (type ? ' ' + type : '');
    line.innerHTML = `<span class="ve-log-time">${time}</span><span class="ve-log-text">${_esc(text)}</span>`;
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  }

  // ── Utils ──
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/1024/1024).toFixed(1) + ' MB';
  }

})();
