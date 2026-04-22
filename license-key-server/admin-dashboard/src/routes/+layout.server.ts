import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

function isJwtExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload.exp === 'number' && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export const load: LayoutServerLoad = async ({ cookies, url }) => {
  const token = cookies.get('session');
  const isLoginPage = url.pathname === '/login';

  if (!isLoginPage) {
    if (!token || isJwtExpired(token)) {
      cookies.delete('session', { path: '/' });
      throw redirect(302, '/login');
    }
  }

  return { authenticated: !!token };
};
