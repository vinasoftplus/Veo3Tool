import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const res = await fetch(`${BACKEND}/admin/update`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  const data = res?.ok ? await res.json() : { version: null };
  return { current: data.version || null };
};

export const actions: Actions = {
  upload: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');

    const form = await request.formData();
    const domain = request.headers.get('host') || '';

    // Forward multipart form lên Go backend
    const forwardForm = new FormData();
    forwardForm.append('version',   String(form.get('version') || ''));
    forwardForm.append('changelog', String(form.get('changelog') || ''));
    forwardForm.append('required',  String(form.get('required') || 'false'));
    forwardForm.append('domain',    domain);

    const file = form.get('file') as File | null;
    if (!file || file.size === 0) return fail(400, { error: 'Chưa chọn file EXE' });

    const fileBuffer = await file.arrayBuffer();
    forwardForm.append('file', new Blob([fileBuffer], { type: 'application/octet-stream' }), file.name);

    const res = await fetch(`${BACKEND}/admin/update/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: forwardForm,
    }).catch((e) => { console.error('upload error', e); return null; });

    if (!res?.ok) return fail(500, { error: 'Upload thất bại' });
    return { success: true };
  },
};
