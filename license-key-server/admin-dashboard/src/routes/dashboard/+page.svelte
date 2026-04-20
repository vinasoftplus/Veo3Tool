<script lang="ts">
  import type { PageData } from './$types';
  export let data: PageData;
  const { stats } = data;

  const statCards = [
    { label: 'Tổng keys', value: stats.total_licenses,      color: 'text-pink-400',   bg: 'bg-pink-500/10' },
    { label: 'Đang hoạt động', value: stats.active_licenses, color: 'text-green-400',  bg: 'bg-green-500/10' },
    { label: 'Hết hạn 30 ngày', value: stats.expiring_30d,  color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
    { label: 'Validations hôm nay', value: stats.validations_today, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: 'Thiết bị đang dùng', value: stats.active_activations, color: 'text-purple-400', bg: 'bg-purple-500/10' },
    { label: 'Bị thu hồi', value: stats.revoked_licenses,   color: 'text-red-400',    bg: 'bg-red-500/10' },
    { label: 'Đã hết hạn', value: stats.expired_licenses,   color: 'text-gray-400',   bg: 'bg-gray-700/30' },
    { label: 'Máy bị ban', value: stats.banned_machines,    color: 'text-red-300',    bg: 'bg-red-900/20' },
  ];
</script>

<div class="p-6">
  <div class="mb-6">
    <h2 class="text-xl font-bold text-gray-100">Dashboard</h2>
    <p class="text-gray-500 text-sm mt-1">Tổng quan hệ thống license</p>
  </div>

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    {#each statCards as card}
      <div class="card {card.bg} border-gray-700/50">
        <div class="text-3xl font-bold {card.color}">{card.value ?? 0}</div>
        <div class="text-sm text-gray-400 mt-1">{card.label}</div>
      </div>
    {/each}
  </div>

  <div class="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="card">
      <h3 class="text-sm font-medium text-gray-400 mb-3">Quick Links</h3>
      <div class="space-y-2">
        <a href="/keys" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors cursor-pointer">
          <span class="text-xl">🔑</span>
          <div>
            <div class="text-sm font-medium text-gray-200">Tạo License Key mới</div>
            <div class="text-xs text-gray-500">Quản lý và phân phối keys</div>
          </div>
        </a>
        <a href="/bans" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors cursor-pointer">
          <span class="text-xl">🚫</span>
          <div>
            <div class="text-sm font-medium text-gray-200">Quản lý Ban</div>
            <div class="text-xs text-gray-500">Ban/unban máy theo UUID</div>
          </div>
        </a>
        <a href="/activations" class="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-800 transition-colors cursor-pointer">
          <span class="text-xl">💻</span>
          <div>
            <div class="text-sm font-medium text-gray-200">Xem Activations</div>
            <div class="text-xs text-gray-500">Thiết bị đã kích hoạt</div>
          </div>
        </a>
      </div>
    </div>
    <div class="card">
      <h3 class="text-sm font-medium text-gray-400 mb-3">Trạng thái hệ thống</h3>
      <div class="space-y-3">
        <div class="flex justify-between items-center">
          <span class="text-sm text-gray-400">Keys còn hoạt động</span>
          <span class="text-sm font-medium text-green-400">
            {stats.active_licenses} / {stats.total_licenses}
          </span>
        </div>
        <div class="w-full bg-gray-800 rounded-full h-1.5">
          <div class="bg-green-500 h-1.5 rounded-full" style="width: {stats.total_licenses ? Math.round(stats.active_licenses / stats.total_licenses * 100) : 0}%"></div>
        </div>
        <div class="flex justify-between items-center mt-2">
          <span class="text-sm text-gray-400">Sắp hết hạn (30 ngày)</span>
          <span class="text-sm font-medium text-yellow-400">{stats.expiring_30d}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-sm text-gray-400">Máy bị ban</span>
          <span class="text-sm font-medium text-red-400">{stats.banned_machines}</span>
        </div>
      </div>
    </div>
  </div>
</div>
