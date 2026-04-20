<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: '📊' },
    { href: '/keys', label: 'License Keys', icon: '🔑' },
    { href: '/activations', label: 'Activations', icon: '💻' },
    { href: '/bans', label: 'Bans', icon: '🚫' },
  ];
</script>

{#if $page.url.pathname !== '/login'}
<div class="flex min-h-screen">
  <!-- Sidebar -->
  <aside class="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
    <div class="p-4 border-b border-gray-800">
      <h1 class="text-base font-bold text-pink-400">🔐 License Manager</h1>
    </div>
    <nav class="flex-1 p-3 space-y-1">
      {#each navItems as item}
        <a
          href={item.href}
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer
            {$page.url.pathname.startsWith(item.href)
              ? 'bg-pink-500/20 text-pink-400 font-medium'
              : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'}"
        >
          <span>{item.icon}</span>
          {item.label}
        </a>
      {/each}
    </nav>
    <div class="p-3 border-t border-gray-800">
      <form method="POST" action="/login?/logout">
        <button class="w-full text-left px-3 py-2 text-sm text-gray-400 hover:text-red-400 transition-colors cursor-pointer rounded-lg hover:bg-gray-800">
          🚪 Đăng xuất
        </button>
      </form>
    </div>
  </aside>

  <!-- Main content -->
  <main class="flex-1 overflow-auto bg-gray-950">
    <slot />
  </main>
</div>
{:else}
  <slot />
{/if}
