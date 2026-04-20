import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies, url }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const licenseId = url.searchParams.get('license_id') || '';
  const res = await fetch(
    `${BACKEND}/admin/activations${licenseId ? `?license_id=${licenseId}` : ''}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null);

  const data = res?.ok ? await res.json() : { data: [] };
  return { activations: data.data || [] };
};

export const actions: Actions = {
  revoke: async ({ request, cookies }) => {
    const token = cookies.get('session');
    if (!token) throw redirect(302, '/login');
    const form = await request.formData();
    await fetch(`${BACKEND}/admin/activations/${form.get('id')}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { revoked: true };
  },
};
