/* API helpers */
function _appHeaders(extra) {
  const h = Object.assign({ 'X-App-Token': window.__APP_TOKEN__ || '' }, extra || {});
  return h;
}

async function _apiJson(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.detail || data?.error || data?.message || `HTTP ${r.status}`);
  return data;
}

const API = {
  async get(path) {
    const r = await fetch(path, { headers: _appHeaders() });
    return _apiJson(r);
  },
  async post(path, data) {
    const r = await fetch(path, {
      method: 'POST',
      headers: _appHeaders({'Content-Type': 'application/json'}),
      body: JSON.stringify(data),
    });
    return _apiJson(r);
  },
  async postForm(path, formData) {
    const r = await fetch(path, { method: 'POST', headers: _appHeaders(), body: formData });
    return _apiJson(r);
  },
  async delete(path) {
    const r = await fetch(path, { method: 'DELETE', headers: _appHeaders() });
    return _apiJson(r);
  },
  async patch(path, data) {
    const r = await fetch(path, {
      method: 'PATCH',
      headers: _appHeaders({'Content-Type': 'application/json'}),
      body: JSON.stringify(data),
    });
    return _apiJson(r);
  },
};

function toast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✓', error: '✕', info: 'i' };
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function statusBadge(status) {
  const labels = { pending: 'Đợi', running: 'Đang chạy', completed: 'Xong', done: 'Xong', failed: 'Lỗi' };
  const pulse = status === 'running' ? ' pulse' : '';
  return `<span class="job-status ${status}${pulse}">${labels[status] || status}</span>`;
}

function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.click();
}

async function pollJob(jobId, apiPath, onUpdate, intervalMs = 3000) {
  let pollErrors = 0;
  while (true) {
    let job;
    try {
      const res = await API.get(`${apiPath}/${jobId}`);
      job = res.job || res;
      pollErrors = 0;
    } catch (e) {
      pollErrors++;
      if (pollErrors >= 3) {
        throw new Error(`Poll job failed after ${pollErrors} attempts: ${e.message || e}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    await onUpdate(job);
    if (['completed', 'done', 'failed'].includes(job.status)) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
