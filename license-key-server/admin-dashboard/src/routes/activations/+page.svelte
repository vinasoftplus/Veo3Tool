<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';

  export let data: PageData;

  let filterLicenseId = '';
  $: filtered = filterLicenseId
    ? (data.activations || []).filter((a: any) => String(a.license_id) === filterLicenseId)
    : (data.activations || []);
</script>

<div class="p-6">
  <div class="mb-6">
    <h2 class="text-xl font-bold text-gray-100">Activations</h2>
    <p class="text-gray-500 text-sm mt-0.5">Thiết bị đã kích hoạt</p>
  </div>

  <div class="flex gap-3 mb-4">
    <input bind:value={filterLicenseId} placeholder="Lọc theo License ID..." class="input max-w-xs text-sm" type="number" />
    <span class="text-gray-500 text-sm self-center">Hiển thị: {filtered.length}</span>
  </div>

  <div class="card p-0 overflow-hidden overflow-x-auto">
    <table class="w-full text-sm min-w-[700px]">
      <thead>
        <tr class="border-b border-gray-800 text-gray-400 text-left text-xs uppercase tracking-wider">
          <th class="px-4 py-3">Machine ID</th>
          <th class="px-4 py-3">Tên máy</th>
          <th class="px-4 py-3">License ID</th>
          <th class="px-4 py-3">Kích hoạt</th>
          <th class="px-4 py-3">Lần check</th>
          <th class="px-4 py-3">IP</th>
          <th class="px-4 py-3">Trạng thái</th>
          <th class="px-4 py-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as a}
          <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
            <td class="px-4 py-3 font-mono text-xs text-gray-300">{a.machine_id}</td>
            <td class="px-4 py-3 text-gray-300">{a.machine_name || '—'}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">
              <a href="/keys?search={a.license_id}" class="hover:text-pink-400 transition-colors">#{a.license_id}</a>
            </td>
            <td class="px-4 py-3 text-gray-400 text-xs">{a.activated_at?.slice(0, 10) || '—'}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{a.last_checked_at ? new Date(a.last_checked_at).toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—'}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{a.ip_address || '—'}</td>
            <td class="px-4 py-3">
              {#if a.is_revoked}
                <span class="badge-revoked">Revoked</span>
              {:else}
                <span class="badge-active">Active</span>
              {/if}
            </td>
            <td class="px-4 py-3">
              {#if !a.is_revoked}
                <form method="POST" action="?/revoke" use:enhance>
                  <input type="hidden" name="id" value={a.id} />
                  <button class="btn-danger" type="submit"
                    on:click|preventDefault={(e) => {
                      if (confirm('Thu hồi activation này?')) {
                        (e.currentTarget as HTMLButtonElement).closest('form')?.submit();
                      }
                    }}>
                    Thu hồi
                  </button>
                </form>
              {:else}
                <span class="text-gray-600 text-xs">—</span>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="8" class="px-4 py-10 text-center text-gray-500">
              {filterLicenseId ? 'Không tìm thấy activation nào cho license này' : 'Chưa có activation nào'}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
