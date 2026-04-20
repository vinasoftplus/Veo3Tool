import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { Stats } from '$lib/types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const load: PageServerLoad = async ({ cookies }) => {
  const token = cookies.get('session');
  if (!token) throw redirect(302, '/login');

  const res = await fetch(`${BACKEND}/admin/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);

  const stats: Stats = res?.ok ? await res.json() : {
    total_licenses: 0, active_licenses: 0, revoked_licenses: 0,
    expired_licenses: 0, expiring_30d: 0, active_activations: 0,
    validations_today: 0, banned_machines: 0,
  };
  return { stats };
};
