<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';

  const navItems = [
    { href: '/admin-manage/dashboard', label: 'Dashboard', icon: '📊' },
    { href: '/admin-manage/keys', label: 'License Keys', icon: '🔑' },
    { href: '/admin-manage/activations', label: 'Activations', icon: '💻' },
    { href: '/admin-manage/bans', label: 'Bans', icon: '🚫' },
    { href: '/admin-manage/update', label: 'Update Manager', icon: '🚀' },
    { href: '/admin-manage/notifications', label: 'Thông báo', icon: '🔔' },
  ];

  let sidebarOpen = false;
  function closeSidebar() { sidebarOpen = false; }
</script>

{#if $page.url.pathname !== '/login'}
<div class="flex min-h-screen">
  <!-- Mobile overlay -->
  {#if sidebarOpen}
    <div class="fixed inset-0 bg-black/60 z-20 lg:hidden" on:click={closeSidebar}></div>
  {/if}

  <!-- Sidebar -->
  <aside class="
    fixed lg:static inset-y-0 left-0 z-30
    w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0
    transform transition-transform duration-200
    {sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
  ">
    <div class="p-4 border-b border-gray-800 flex items-center justify-between">
      <h1 class="text-base font-bold text-pink-400">🔐 License Manager</h1>
      <button class="lg:hidden text-gray-400 hover:text-gray-200 cursor-pointer" on:click={closeSidebar}>✕</button>
    </div>
    <nav class="flex-1 p-3 space-y-1">
      {#each navItems as item}
        <a
          href={item.href}
          on:click={closeSidebar}
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer
            {$page.url.pathname === item.href || $page.url.pathname.startsWith(item.href + '/')
              ? 'bg-pink-500/20 text-pink-400 font-medium'
              : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'}"
        >
          <span>{item.icon}</span>
          {item.label}
        </a>
      {/each}
    </nav>
    <div class="p-3 border-t border-gray-800">
      <form method="POST" action="/admin-manage/login?/logout">
        <button class="w-full text-left px-3 py-2 text-sm text-gray-400 hover:text-red-400 transition-colors cursor-pointer rounded-lg hover:bg-gray-800">
          🚪 Đăng xuất
        </button>
      </form>
    </div>
  </aside>

  <!-- Main content -->
  <div class="flex-1 flex flex-col min-w-0 bg-gray-950">
    <!-- Mobile topbar -->
    <header class="lg:hidden flex items-center gap-3 px-4 py-3 bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
      <button on:click={() => sidebarOpen = true} class="text-gray-400 hover:text-gray-200 cursor-pointer text-xl leading-none">☰</button>
      <span class="text-sm font-bold text-pink-400">🔐 License Manager</span>
    </header>
    <main class="flex-1 overflow-auto">
      <slot />
    </main>
  </div>
</div>
{:else}
  <slot />
{/if}
