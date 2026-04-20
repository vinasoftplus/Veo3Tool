<script lang="ts">
  import { enhance } from '$app/forms';
  export let form: { error?: string } | undefined = undefined;
</script>

<div class="min-h-screen flex items-center justify-center bg-gray-950">
  <div class="w-full max-w-sm px-4">
    <div class="card">
      <div class="text-center mb-6">
        <div class="text-4xl mb-2">🔐</div>
        <h2 class="text-xl font-bold text-gray-100">License Manager</h2>
        <p class="text-gray-400 text-sm mt-1">Admin Dashboard</p>
      </div>

      {#if form?.error}
        <div class="bg-red-900/50 border border-red-700 text-red-300 rounded-lg px-3 py-2 text-sm mb-4">
          {form.error}
        </div>
      {/if}

      <form method="POST" action="?/login" use:enhance class="space-y-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1" for="email">Email</label>
          <input id="email" name="email" type="email" required class="input" placeholder="admin@example.com" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1" for="password">Mật khẩu</label>
          <input id="password" name="password" type="password" required class="input" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1" for="totp">Mã 2FA <span class="text-gray-600">(nếu có)</span></label>
          <input id="totp" name="totp" type="text" inputmode="numeric" class="input" placeholder="000000" maxlength="6" />
        </div>
        <button type="submit" class="btn-primary w-full flex justify-center">Đăng nhập</button>
      </form>
    </div>
  </div>
</div>
