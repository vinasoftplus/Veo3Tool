/* other.js — Script Analyzer + YTB tools */

// ── Script Analyzer (existing tab) ──────────────────────────────────────────
window.init_script_analyzer = function () {
  const btn = document.getElementById('sa-submit');
  if (!btn || btn._bound) return;
  btn._bound = true;

  btn.addEventListener('click', async () => {
    const url = document.getElementById('sa-url')?.value.trim();
    if (!url) return toast('Vui lòng nhập YouTube URL', 'error');

    const lang = document.getElementById('sa-lang')?.value || 'vi';
    const instruction = document.getElementById('sa-instruction')?.value.trim() || '';
    const timeStart = document.getElementById('sa-start')?.value.trim() || null;
    const timeEnd = document.getElementById('sa-end')?.value.trim() || null;

    btn.disabled = true;
    btn.textContent = 'Đang phân tích...';
    document.getElementById('sa-result-card').style.display = 'none';

    try {
      const res = await API.post('/api/youtube/script', {
        youtube_url: url,
        language: lang,
        instruction,
        time_start: timeStart || undefined,
        time_end: timeEnd || undefined,
      });
      if (!res.ok) { toast(res.detail || 'Lỗi', 'error'); return; }
      pollScriptJob(res.job_id);
    } catch (e) {
      toast('Lỗi kết nối: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Phân tích';
    }
  });

  // Tab switcher inside result card
  document.querySelectorAll('#tab-script-analyzer .tab-btn').forEach(tb => {
    tb.addEventListener('click', () => {
      document.querySelectorAll('#tab-script-analyzer .tab-btn').forEach(b => b.classList.remove('active'));
      tb.classList.add('active');
      const target = tb.dataset.target;
      document.getElementById('sa-analysis').style.display = target === 'sa-analysis' ? '' : 'none';
      document.getElementById('sa-transcript').style.display = target === 'sa-transcript' ? '' : 'none';
    });
  });
};

async function pollScriptJob(jobId) {
  const statusEl = document.getElementById('sa-status');
  const analysisEl = document.getElementById('sa-analysis');
  const transcriptEl = document.getElementById('sa-transcript');
  const resultCard = document.getElementById('sa-result-card');
  resultCard.style.display = '';
  statusEl.textContent = 'Đang xử lý...';

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await API.get('/api/youtube/script/' + jobId);
      const job = res.job;
      if (job.status === 'done') {
        statusEl.textContent = '✅ Hoàn thành';
        analysisEl.textContent = job.outputs?.analysis || '';
        transcriptEl.textContent = job.outputs?.transcript || '';
        return;
      }
      if (job.status === 'failed') {
        statusEl.textContent = '❌ Lỗi: ' + (job.error || 'Không xác định');
        return;
      }
      statusEl.textContent = `Đang xử lý... (${job.progress || 0}%)`;
    } catch (e) { /* retry */ }
  }
  statusEl.textContent = '⚠️ Timeout — thử lại sau';
}


// ── Master Script (shared result card helpers) ───────────────────────────────
function _msShowResult(statusText, outputText) {
  const resultCard = document.getElementById('ms-result-card');
  const statusEl = document.getElementById('ms-status');
  const outputEl = document.getElementById('ms-output');
  resultCard.style.display = '';
  statusEl.textContent = statusText;
  outputEl.textContent = outputText || '';
}

function _msBindActions() {
  const copyBtn = document.getElementById('ms-copy-btn');
  const dlBtn = document.getElementById('ms-download-btn');
  if (copyBtn && !copyBtn._bound) {
    copyBtn._bound = true;
    copyBtn.addEventListener('click', () => {
      const text = document.getElementById('ms-output')?.textContent || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => toast('Đã copy vào clipboard', 'success'));
    });
  }
  if (dlBtn && !dlBtn._bound) {
    dlBtn._bound = true;
    dlBtn.addEventListener('click', async () => {
      const text = document.getElementById('ms-output')?.textContent || '';
      if (!text) return toast('Chưa có nội dung để tải', 'error');
      await _msSaveMarkdown(text);
    });
  }
}

async function _msSaveMarkdown(text) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date();
  const filename = `master_prompt_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`;
  const blob = new Blob(['\uFEFF' + text], { type: 'text/markdown;charset=utf-8' });

  try {
    if (window.showDirectoryPicker) {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const file = await dir.getFileHandle(filename, { create: true });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
      toast('Đã lưu file .md: ' + filename, 'success');
      return;
    }

    if (window.showSaveFilePicker) {
      const file = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
      toast('Đã lưu file .md', 'success');
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.warn('Save markdown via file picker failed, falling back to download', e);
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.init_master_script = function () {
  _msBindActions();

  // ── Auto Master Prompt ──
  const ampBtn = document.getElementById('amp-submit');
  if (ampBtn && !ampBtn._bound) {
    ampBtn._bound = true;
    ampBtn.addEventListener('click', async () => {
      const idea = document.getElementById('amp-idea')?.value.trim();
      const scenes = parseInt(document.getElementById('amp-scenes')?.value || '0', 10);
      const durationMins = parseInt(document.getElementById('amp-duration')?.value || '0', 10);
      const duration = durationMins * 60;
      const vtype = document.getElementById('amp-type')?.value || 'youtube_long';

      if (!idea) return toast('Vui lòng nhập Idea', 'error');
      if (!scenes || scenes < 1) return toast('Số Scenes phải ≥ 1', 'error');
      if (!durationMins || durationMins < 1) return toast('Độ dài video phải ≥ 1 phút', 'error');

      ampBtn.disabled = true;
      ampBtn.textContent = '⏳ Đang tạo...';
      _msShowResult('AI đang xử lí', '');
      document.getElementById('ms-actions').style.display = 'none';

      try {
        const ampModel = document.getElementById('amp-model')?.value || 'gemini-2.5-flash';
        const res = await API.post('/api/youtube/auto-master-prompt', {
          idea, scene_count: scenes, duration_seconds: duration, video_type: vtype, model: ampModel,
        });
        if (!res.ok) {
          _msShowResult('❌ ' + (res.detail || 'Lỗi'), '');
          toast(res.detail || 'Lỗi', 'error');
          return;
        }
        await pollMasterPromptJob(res.job_id, '/api/youtube/auto-master-prompt/', '✅ Master Prompt đã sẵn sàng');
      } catch (e) {
        _msShowResult('❌ Lỗi kết nối: ' + e.message, '');
        toast('Lỗi: ' + e.message, 'error');
      } finally {
        ampBtn.disabled = false;
        ampBtn.textContent = '✨ Tạo Master Prompt';
      }
    });
  }

  // ── Lấy kịch bản từ YTB ──
  const msBtn = document.getElementById('ms-submit');
  if (msBtn && !msBtn._bound) {
    msBtn._bound = true;
    msBtn.addEventListener('click', async () => {
      const url = document.getElementById('ms-url')?.value.trim();
      if (!url) return toast('Vui lòng nhập YouTube URL', 'error');

      msBtn.disabled = true;
      msBtn.textContent = '⏳ Đang phân tích...';
      _msShowResult('AI đang xử lí...', '');
      document.getElementById('ms-actions').style.display = 'none';

      try {
        const msModel = document.getElementById('ms-model')?.value || 'gemini-2.5-flash';
        const res = await API.post('/api/youtube/master-script', { youtube_url: url, model: msModel });
        if (!res.ok) {
          _msShowResult('❌ ' + (res.detail || 'Lỗi'), '');
          toast(res.detail || 'Lỗi', 'error');
          return;
        }
        await pollMasterPromptJob(res.job_id, '/api/youtube/master-script/', '✅ Hoàn thành — AI đã phân tích và điền kịch bản');
      } catch (e) {
        _msShowResult('❌ Lỗi kết nối: ' + e.message, '');
        toast('Lỗi: ' + e.message, 'error');
      } finally {
        msBtn.disabled = false;
        msBtn.textContent = '🎬 Lấy kịch bản';
      }
    });
  }
};

async function pollMasterPromptJob(jobId, apiBase, doneMsg) {
  const statusEl = document.getElementById('ms-status');
  const outputEl = document.getElementById('ms-output');

  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await API.get(apiBase + jobId);
      const job = res.job;
      if (job.status === 'done') {
        statusEl.textContent = doneMsg;
        outputEl.textContent = job.outputs?.md || '';
        document.getElementById('ms-actions').style.display = 'flex';
        return;
      }
      if (job.status === 'failed') {
        statusEl.textContent = '❌ Lỗi: ' + (job.error || 'Không xác định');
        toast('Lỗi: ' + (job.error || ''), 'error');
        return;
      }
      statusEl.textContent = `⏳ AI đang xử lý... (${job.progress || 0}%)`;
    } catch (e) { /* retry */ }
  }
  statusEl.textContent = '⚠️ Timeout — thử lại sau';
}

// legacy alias
async function pollMasterScriptJob(jobId) {
  return pollMasterPromptJob(jobId, '/api/youtube/master-script/', '✅ Hoàn thành — AI đã phân tích và điền kịch bản');
}


// ── YTB Key Hunter + Channel Analyzer ───────────────────────────────────────
window.init_view_hunter = function () {
  const btn = document.getElementById('vh-search-btn');
  if (!btn || btn._bound) return;
  btn._bound = true;

  // Channel Analyzer
  const caBtn = document.getElementById('ca-search-btn');
  if (caBtn && !caBtn._bound) {
    caBtn._bound = true;
    document.getElementById('ca-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') caBtn.click(); });
    caBtn.addEventListener('click', runChannelAnalyze);
  }

  // Enter key triggers search
  document.getElementById('vh-keyword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') btn.click();
  });

  btn.addEventListener('click', async () => {
    const keyword = document.getElementById('vh-keyword')?.value.trim();
    if (!keyword) return toast('Vui lòng nhập từ khóa', 'error');

    const region = document.getElementById('vh-region')?.value || 'VN';
    const order = document.getElementById('vh-order')?.value || 'viewCount';
    const maxResults = parseInt(document.getElementById('vh-max')?.value || '50', 10);

    btn.disabled = true;
    btn.textContent = 'Đang tìm...';
    const resultsEl = document.getElementById('vh-results');
    resultsEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text3);">⏳ Đang tìm kiếm...</div>`;

    try {
      const res = await API.post('/api/youtube/search', {
        keyword,
        region_code: region || null,
        order,
        max_results: maxResults,
      });

      if (!res.ok) {
        toast(res.detail || 'Lỗi tìm kiếm', 'error');
        resultsEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">❌ ${res.detail || 'Lỗi'}</div>`;
        return;
      }

      renderVHResults(res.results || []);
    } catch (e) {
      toast('Lỗi kết nối: ' + e.message, 'error');
      resultsEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">❌ Lỗi kết nối</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Tìm kiếm';
    }
  });
};

function renderVHResults(results) {
  const el = document.getElementById('vh-results');
  if (!results.length) {
    el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text3);">Không tìm thấy kết quả nào.</div>`;
    return;
  }

  const fmtNum = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
  const fmtDate = s => s ? new Date(s).toLocaleDateString('vi-VN') : '';
  const parseDuration = s => {
    if (!s) return '';
    const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return s;
    const h = m[1] || 0, min = m[2] || 0, sec = m[3] || 0;
    return h > 0 ? `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${min}:${String(sec).padStart(2, '0')}`;
  };

  el.innerHTML = `
    <div class="card vh-results-card" style="padding:0;overflow:hidden;">
      <div class="vh-results-head" style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);">
        <div style="font-weight:700;font-size:14px;">Kết quả — ${results.length} video</div>
        <button class="btn btn-secondary btn-sm vh-export-btn" onclick="exportVHCsv()" style="font-size:11px;">Export CSV</button>
      </div>
      <div class="vh-results-table-wrap" style="overflow-x:auto;">
        <table class="vh-results-table" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg3);color:var(--text2);">
              <th style="padding:10px 12px;text-align:left;font-weight:600;white-space:nowrap;">#</th>
              <th style="padding:10px 12px;text-align:left;font-weight:600;">Thumbnail</th>
              <th style="padding:10px 12px;text-align:left;font-weight:600;">Tiêu đề</th>
              <th style="padding:10px 12px;text-align:right;font-weight:600;white-space:nowrap;">Lượt xem</th>
              <th style="padding:10px 12px;text-align:right;font-weight:600;white-space:nowrap;">Like</th>
              <th style="padding:10px 12px;text-align:right;font-weight:600;white-space:nowrap;">Bình luận</th>
              <th style="padding:10px 12px;text-align:center;font-weight:600;white-space:nowrap;">Thời lượng</th>
              <th style="padding:10px 12px;text-align:left;font-weight:600;white-space:nowrap;">Ngày đăng</th>
              <th style="padding:10px 12px;text-align:center;font-weight:600;">Thao tác</th>
            </tr>
          </thead>
          <tbody id="vh-table-body">
            ${results.map((v, i) => `
              <tr class="vh-row" style="border-bottom:1px solid var(--border);transition:background .15s;" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
                <td style="padding:10px 12px;color:var(--text3);font-weight:700;">${i + 1}</td>
                <td style="padding:8px 12px;">
                  <a href="${v.url}" target="_blank">
                    <img src="${v.thumbnail}" alt="" style="width:80px;height:45px;object-fit:cover;border-radius:4px;display:block;">
                  </a>
                </td>
                <td style="padding:10px 12px;max-width:280px;">
                  <a href="${v.url}" target="_blank" class="vh-title-link" style="color:var(--text);font-weight:600;text-decoration:none;line-height:1.4;display:block;margin-bottom:4px;"
                    onmouseover="this.style.color='var(--pink)'" onmouseout="this.style.color='var(--text)'">${v.title}</a>
                  <div style="color:var(--text3);font-size:11px;">${v.channelTitle}</div>
                </td>
                <td style="padding:10px 12px;text-align:right;font-weight:700;color:var(--text);">${fmtNum(v.viewCount || 0)}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text2);">${fmtNum(v.likeCount || 0)}</td>
                <td style="padding:10px 12px;text-align:right;color:var(--text2);">${fmtNum(v.commentCount || 0)}</td>
                <td style="padding:10px 12px;text-align:center;color:var(--text2);white-space:nowrap;">${parseDuration(v.duration)}</td>
                <td style="padding:10px 12px;color:var(--text3);white-space:nowrap;">${fmtDate(v.publishedAt)}</td>
                <td style="padding:10px 12px;text-align:center;">
                  <div style="display:flex;gap:5px;justify-content:center;">
                    <button class="btn btn-secondary btn-sm vh-action-btn" onclick="window.open('${v.url}','_blank')" title="Mở video" style="padding:4px 8px;font-size:11px;">Mở</button>
                    <button class="btn btn-secondary btn-sm vh-action-btn" onclick="copyVHUrl('${v.url}')" title="Copy URL" style="padding:4px 8px;font-size:11px;">Copy</button>
                    <button class="btn btn-secondary btn-sm vh-action-btn" onclick="sendToAnalyzer('${v.url}')" title="Gửi sang Script Analyzer" style="padding:4px 8px;font-size:11px;">Phân tích</button>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  // Store results for CSV export
  window._vhResults = results;
}

function copyVHUrl(url) {
  navigator.clipboard.writeText(url).then(() => toast('Đã copy URL', 'success'));
}

function sendToAnalyzer(url) {
  document.querySelector('[data-tab="master-script"]')?.click();
  const inp = document.getElementById('ms-url');
  if (inp) { inp.value = url; inp.focus(); }
  toast('Đã điền URL vào Lấy kịch bản YTB', 'success');
}

function exportVHCsv() {
  const rows = window._vhResults;
  if (!rows?.length) return;
  const headers = ['#', 'Title', 'Channel', 'Views', 'Likes', 'Comments', 'Duration', 'Published', 'URL'];
  const parseDuration = s => {
    if (!s) return '';
    const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return s;
    const h = m[1] || 0, min = m[2] || 0, sec = m[3] || 0;
    return h > 0 ? `${h}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${min}:${String(sec).padStart(2, '0')}`;
  };
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.join(','), ...rows.map((v, i) => [
    i + 1, escape(v.title), escape(v.channelTitle),
    v.viewCount || 0, v.likeCount || 0, v.commentCount || 0,
    parseDuration(v.duration),
    v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('vi-VN') : '',
    v.url
  ].join(','))];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ytb_key_hunter.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}


// ── Channel Analyzer ─────────────────────────────────────────────────────────
async function runChannelAnalyze() {
  const caBtn = document.getElementById('ca-search-btn');
  const url = document.getElementById('ca-url')?.value.trim();
  if (!url) return toast('Vui lòng nhập URL kênh', 'error');

  caBtn.disabled = true;
  caBtn.textContent = 'Đang phân tích...';
  const el = document.getElementById('ca-results');
  el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text3);">⏳ Đang lấy dữ liệu kênh...</div>`;

  try {
    const res = await API.post('/api/youtube/channel-analyze', { channel_url: url, max_videos: 30 });
    if (!res.ok) {
      el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--red);">❌ ${res.detail || 'Lỗi'}</div>`;
      toast(res.detail || 'Lỗi phân tích kênh', 'error');
      return;
    }
    renderChannelAnalyze(res);
  } catch (e) {
    el.innerHTML = `<div style="text-align:center;padding:30px;color:var(--red);">❌ Lỗi kết nối</div>`;
    toast('Lỗi kết nối: ' + e.message, 'error');
  } finally {
    caBtn.disabled = false;
    caBtn.textContent = 'Phân tích kênh';
  }
}

function renderChannelAnalyze(data) {
  const el = document.getElementById('ca-results');
  const ch = data.channel;
  const ypp = data.ypp;
  const hashtags = data.top_hashtags || [];
  const videos = data.videos || [];

  const fmtNum = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
  const fmtDate = s => s ? new Date(s).toLocaleDateString('vi-VN') : '';

  const yppBadge = ypp.eligible
    ? `<span style="background:#16a34a;color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;">✓ Đủ điều kiện YPP</span>`
    : `<span style="background:#dc2626;color:#fff;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;">✗ Chưa đủ YPP</span>`;

  const hashtagsHtml = hashtags.length
    ? hashtags.map(h => `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;cursor:pointer;"
        onclick="navigator.clipboard.writeText('#${h.tag}').then(()=>toast('Copied','success'))"
        title="Copy #${h.tag}">#${h.tag} <span style="color:var(--text3);font-size:10px;">${h.count}</span></span>`).join('')
    : `<span style="color:var(--text3);font-size:12px;">Không tìm thấy hashtag</span>`;

  const topVideosHtml = videos.slice(0, 10).map((v, i) => `
    <tr style="border-bottom:1px solid var(--border);transition:background .15s;" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      <td style="padding:8px 12px;color:var(--text3);font-weight:700;">${i + 1}</td>
      <td style="padding:6px 12px;"><a href="${v.url}" target="_blank"><img src="${v.thumbnail}" style="width:72px;height:40px;object-fit:cover;border-radius:4px;display:block;"></a></td>
      <td style="padding:8px 12px;max-width:260px;">
        <a href="${v.url}" target="_blank" style="color:var(--text);font-weight:600;text-decoration:none;font-size:12px;line-height:1.4;display:block;"
          onmouseover="this.style.color='var(--pink)'" onmouseout="this.style.color='var(--text)'">${v.title}</a>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;">${fmtDate(v.publishedAt)} · ${v.duration}</div>
      </td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;">${fmtNum(v.viewCount)}</td>
      <td style="padding:8px 12px;text-align:right;color:var(--text2);">${fmtNum(v.likeCount)}</td>
      <td style="padding:8px 12px;text-align:right;color:var(--text2);">${fmtNum(v.commentCount)}</td>
      <td style="padding:8px 12px;text-align:center;">
        <button class="btn btn-secondary btn-sm" onclick="sendToAnalyzer('${v.url}')" title="Lấy kịch bản" style="padding:3px 8px;font-size:11px;">🎬</button>
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <!-- Channel Overview -->
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
        ${ch.thumbnail ? `<img src="${ch.thumbnail}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;flex-shrink:0;">` : ''}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
            <div style="font-size:18px;font-weight:700;">${ch.title}</div>
            ${yppBadge}
            ${ch.country ? `<span style="font-size:11px;color:var(--text3);background:var(--bg3);padding:2px 8px;border-radius:10px;">${ch.country}</span>` : ''}
          </div>
          ${ch.custom_url ? `<div style="font-size:12px;color:var(--text3);margin-bottom:8px;">youtube.com/${ch.custom_url}</div>` : ''}
          <div style="display:flex;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:20px;font-weight:700;color:var(--pink);">${ch.hidden_subs ? 'Ẩn' : fmtNum(ch.subscriber_count)}</div>
              <div style="font-size:11px;color:var(--text3);">Subscribers</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:20px;font-weight:700;">${fmtNum(ch.view_count)}</div>
              <div style="font-size:11px;color:var(--text3);">Tổng lượt xem</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:20px;font-weight:700;">${fmtNum(ch.video_count)}</div>
              <div style="font-size:11px;color:var(--text3);">Video</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:14px;font-weight:700;">${fmtDate(ch.published_at)}</div>
              <div style="font-size:11px;color:var(--text3);">Ngày tạo</div>
            </div>
          </div>
          ${!ypp.eligible ? `<div style="margin-top:8px;font-size:12px;color:#f59e0b;">⚠️ ${ypp.note} · Cần ≥1000 sub để mở kiếm tiền</div>` : ''}
        </div>
      </div>
    </div>

    <!-- Hashtags -->
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="font-weight:700;font-size:14px;">Top Hashtags (${hashtags.length})</div>
        ${hashtags.length ? `<button class="btn btn-secondary btn-sm" onclick="exportCaHashtags()" style="font-size:11px;">⬇ Copy tất cả</button>` : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;">${hashtagsHtml}</div>
    </div>

    <!-- Top Videos -->
    ${videos.length ? `
    <div class="card" style="padding:0;overflow:hidden;">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:700;font-size:14px;">Top ${Math.min(videos.length, 10)} Video (sắp xếp theo lượt xem)</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg3);color:var(--text2);">
              <th style="padding:10px 12px;text-align:left;">#</th>
              <th style="padding:10px 12px;text-align:left;">Thumb</th>
              <th style="padding:10px 12px;text-align:left;">Tiêu đề</th>
              <th style="padding:10px 12px;text-align:right;">Xem</th>
              <th style="padding:10px 12px;text-align:right;">Like</th>
              <th style="padding:10px 12px;text-align:right;">Bình luận</th>
              <th style="padding:10px 12px;text-align:center;">Kịch bản</th>
            </tr>
          </thead>
          <tbody>${topVideosHtml}</tbody>
        </table>
      </div>
    </div>` : ''}`;

  window._caHashtags = hashtags;
}

function exportCaHashtags() {
  const tags = window._caHashtags;
  if (!tags?.length) return;
  const text = tags.map(h => `#${h.tag}`).join(' ');
  navigator.clipboard.writeText(text).then(() => toast(`Đã copy ${tags.length} hashtags`, 'success'));
}
