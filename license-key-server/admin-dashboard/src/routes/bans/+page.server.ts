import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const res = await fetch(`${BACKEND}/admin/bans`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  const data = res?.ok ? await res.json() : { data: [] };
  return { bans: data.data || [] };
};

export const actions: Actions = {
  ban: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');

    const form = await request.formData();
    const machineId = form.get('machine_id')?.toString().trim();
    if (!machineId) return fail(400, { error: 'Machine ID là bắt buộc' });

    const res = await fetch(`${BACKEND}/admin/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        machine_id: machineId,
        ban_reason: String(form.get('ban_reason') || 'Vi phạm điều khoản sử dụng'),
      }),
    });
    if (!res.ok) return fail(400, { error: 'Ban thất bại — kiểm tra lại Machine ID' });
    return { banned: true };
  },

  unban: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();
    await fetch(`${BACKEND}/admin/bans/${form.get('id')}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { unbanned: true };
  },
};
