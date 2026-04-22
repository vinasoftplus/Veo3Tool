import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies, url }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const status = url.searchParams.get('status') || '';
  const page   = Number(url.searchParams.get('page') || 1);

  const res = await fetch(
    `${BACKEND}/admin/licenses?status=${status}&page=${page}&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null);

  const data = res?.ok ? await res.json() : { data: [], total: 0 };
  return { licenses: data.data || [], total: data.total || 0, page };
};

export const actions: Actions = {
  create: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();

    const res = await fetch(`${BACKEND}/admin/licenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        license_type:   Number(form.get('license_type') || 1),
        customer_name:  String(form.get('customer_name') || ''),
        customer_email: String(form.get('customer_email') || ''),
        expires_days:   Number(form.get('expires_days') || 365),
        max_devices:    Number(form.get('max_devices') || 1),
        count: 1,
      }),
    });
    if (!res.ok) return fail(400, { error: 'Tạo key thất bại' });
    const data = await res.json();
    return { newKey: data.key };
  },

  bulk: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();

    const count = Number(form.get('count') || 10);
    const res = await fetch(`${BACKEND}/admin/licenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        license_type:   Number(form.get('license_type') || 1),
        customer_name:  'Bulk',
        customer_email: 'bulk@admin.local',
        expires_days:   Number(form.get('expires_days') || 365),
        max_devices:    Number(form.get('max_devices') || 1),
        count,
      }),
    });
    if (!res.ok) return fail(400, { error: 'Tạo bulk thất bại' });
    const data = await res.json();
    return { bulkKeys: data.keys || (data.key ? [data.key] : []) };
  },

  revoke: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();
    const id = form.get('id');
    await fetch(`${BACKEND}/admin/licenses/${id}/revoke`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { revoked: true };
  },

  updateDevices: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();
    const id = form.get('id');
    const maxDevices = Number(form.get('max_devices') || 1);
    const res = await fetch(`${BACKEND}/admin/licenses/${id}/max-devices`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_devices: maxDevices }),
    });
    if (!res.ok) return fail(400, { error: 'Cập nhật thất bại' });
    return { updatedDevices: true };
  },
};
