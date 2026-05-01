import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const res = await fetch(`${BACKEND}/admin/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  const notifications = res?.ok ? (await res.json()).data ?? [] : [];
  return { notifications };
};

export const actions: Actions = {
  create: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');

    const data = await request.formData();
    const payload = {
      title: data.get('title') || '',
      message: data.get('message') || '',
      notif_type: data.get('notif_type') || 'info',
      title_color: data.get('title_color') || '#1e293b',
      message_color: data.get('message_color') || '#374151',
      bg_color: data.get('bg_color') || '#ffffff',
      expires_hours: parseFloat(data.get('expires_hours') as string) || 0,
    };

    if (!payload.message) return fail(400, { error: 'Nội dung thông báo không được trống' });

    const res = await fetch(`${BACKEND}/admin/notifications`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);

    if (!res?.ok) return fail(500, { error: 'Không thể tạo thông báo' });
    return { success: true };
  },

  toggle: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');

    const data = await request.formData();
    const id = data.get('id');
    await fetch(`${BACKEND}/admin/notifications/${id}/toggle`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    return { success: true };
  },

  delete: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');

    const data = await request.formData();
    const id = data.get('id');
    await fetch(`${BACKEND}/admin/notifications/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    return { success: true };
  },
};
