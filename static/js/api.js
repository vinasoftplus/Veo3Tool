/* API helpers */
function _appHeaders(extra) {
  const h = Object.assign({ 'X-App-Token': window.__APP_TOKEN__ || '' }, extra || {});
  return h;
}

const API = {
  async get(path) {
    const r = await fetch(path, { headers: _appHeaders() });
    return r.json();
  },
  async post(path, data) {
    const r = await fetch(path, {
      method: 'POST',
      headers: _appHeaders({'Content-Type': 'application/json'}),
      body: JSON.stringify(data),
    });
    return r.json();
  },
  async postForm(path, formData) {
    const r = await fetch(path, { method: 'POST', headers: _appHeaders(), body: formData });
    return r.json();
  },
  async delete(path) {
    const r = await fetch(path, { method: 'DELETE', headers: _appHeaders() });
    return r.json();
  },
  async patch(path, data) {
    const r = await fetch(path, {
      method: 'PATCH',
      headers: _appHeaders({'Content-Type': 'application/json'}),
      body: JSON.stringify(data),
    });
    return r.json();
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
  while (true) {
    try {
      const res = await API.get(`${apiPath}/${jobId}`);
      const job = res.job || res;
      onUpdate(job);
      if (['completed', 'done', 'failed'].includes(job.status)) break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
