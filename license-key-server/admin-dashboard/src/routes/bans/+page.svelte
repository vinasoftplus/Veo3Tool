<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';

  export let data: PageData;
  export let form: any;

  let showBanForm = false;
  let machineIdInput = '';
  let banReasonInput = '';

  $: if (form?.banned) showBanForm = false;
</script>

<div class="p-6">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl font-bold text-gray-100">Banned Machines</h2>
      <p class="text-gray-500 text-sm mt-0.5">Quản lý danh sách máy bị cấm</p>
    </div>
    <button class="btn-primary" on:click={() => showBanForm = true}>🚫 Ban Machine</button>
  </div>

  {#if form?.error}
    <div class="bg-red-900/50 border border-red-700 text-red-300 rounded-lg p-3 mb-4 text-sm">{form.error}</div>
  {/if}
  {#if form?.banned}
    <div class="bg-green-900/50 border border-green-700 text-green-300 rounded-lg p-3 mb-4 text-sm">✅ Đã ban máy thành công</div>
  {/if}
  {#if form?.unbanned}
    <div class="bg-blue-900/50 border border-blue-700 text-blue-300 rounded-lg p-3 mb-4 text-sm">✅ Đã bỏ ban máy</div>
  {/if}

  <div class="card p-0 overflow-hidden">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-gray-800 text-gray-400 text-left text-xs uppercase tracking-wider">
          <th class="px-4 py-3">Machine ID</th>
          <th class="px-4 py-3">Lý do ban</th>
          <th class="px-4 py-3">Ngày ban</th>
          <th class="px-4 py-3">Trạng thái</th>
          <th class="px-4 py-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.bans || [] as b}
          <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
            <td class="px-4 py-3 font-mono text-xs text-gray-300 max-w-[200px] truncate" title={b.machine_id}>{b.machine_id}</td>
            <td class="px-4 py-3 text-gray-200">{b.ban_reason}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">{b.banned_at?.slice(0, 10) || '—'}</td>
            <td class="px-4 py-3">
              {#if b.is_active}
                <span class="badge-revoked">Đang ban</span>
              {:else}
                <span class="badge-expired">Đã bỏ ban</span>
              {/if}
            </td>
            <td class="px-4 py-3">
              {#if b.is_active}
                <form method="POST" action="?/unban" use:enhance>
                  <input type="hidden" name="id" value={b.id} />
                  <button class="btn-secondary text-sm px-3 py-1" type="submit">Bỏ ban</button>
                </form>
              {:else}
                <span class="text-gray-600 text-xs">—</span>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="5" class="px-4 py-10 text-center text-gray-500">Không có máy nào bị ban</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<!-- Ban Machine Modal -->
{#if showBanForm}
  <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
    <div class="card w-full max-w-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">Ban Machine</h3>
        <button class="text-gray-400 hover:text-gray-200 cursor-pointer" on:click={() => showBanForm = false}>✕</button>
      </div>
      <form method="POST" action="?/ban" use:enhance class="space-y-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Machine UUID</label>
          <input
            name="machine_id"
            bind:value={machineIdInput}
            class="input font-mono text-sm"
            placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            required
          />
          <p class="text-xs text-gray-500 mt-1">Tìm UUID trong tab Activations hoặc Settings của tool</p>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Lý do ban</label>
          <textarea
            name="ban_reason"
            bind:value={banReasonInput}
            class="input resize-none h-24 text-sm"
            placeholder="Vi phạm điều khoản sử dụng..."
          ></textarea>
          <p class="text-xs text-gray-500 mt-1">Lý do này sẽ hiển thị cho người dùng khi bị cấm</p>
        </div>
        <div class="flex gap-3 justify-end pt-2">
          <button type="button" class="btn-secondary" on:click={() => showBanForm = false}>Hủy</button>
          <button type="submit" class="bg-red-600 hover:bg-red-700 text-white font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer">
            🚫 Ban
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
