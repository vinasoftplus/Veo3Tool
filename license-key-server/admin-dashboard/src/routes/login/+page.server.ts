import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';

const BACKEND = process.env.VITE_BACKEND_URL || 'http://license-server:8080';

export const actions: Actions = {
  login: async ({ request, cookies }) => {
    const data = await request.formData();
    const res = await fetch(`${BACKEND}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: data.get('email'),
        password: data.get('password'),
        totp_code: data.get('totp') || '',
      }),
    }).catch(() => null);

    if (!res || !res.ok) {
      return fail(401, { error: 'Email/mật khẩu không đúng hoặc mã 2FA không hợp lệ' });
    }

    const { token } = await res.json();
    cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 8,
    });
    throw redirect(302, '/dashboard');
  },

  logout: async ({ cookies }) => {
    cookies.delete('session', { path: '/' });
    throw redirect(302, '/login');
  },
};
