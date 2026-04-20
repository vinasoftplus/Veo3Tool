import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ cookies, url }) => {
  const token = cookies.get('session');
  const isLoginPage = url.pathname === '/login';
  if (!token && !isLoginPage) {
    throw redirect(302, '/login');
  }
  return { authenticated: !!token };
};
