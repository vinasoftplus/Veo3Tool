<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { LICENSE_TYPE_LABELS } from '$lib/types';

  export let data: PageData;
  export let form: any;

  let showCreate = false;
  let showBulk = false;
  let createdKey = '';
  let bulkKeys: string[] = [];
  let filterStatus = '';
  let searchEmail = '';

  $: filteredLicenses = (data.licenses || []).filter((l: any) => {
    if (filterStatus && l.status !== filterStatus) return false;
    if (searchEmail && !l.customer_email?.toLowerCase().includes(searchEmail.toLowerCase())) return false;
    return true;
  });

  function exportCSV() {
    if (!data.licenses?.length) return;
    const headers = ['ID', 'Type', 'Customer', 'Email', 'Expires', 'Max Devices', 'UUID May', 'Status'];
    const rows = (data.licenses as any[]).map(l => [
      l.id,
      LICENSE_TYPE_LABELS[l.license_type] || 'Unknown',
      l.customer_name || '',
      l.customer_email || '',
      l.expires_at ? new Date(l.expires_at).toLocaleDateString('vi-VN') : '',
      l.max_devices,
      (l.machine_ids || []).join(' | '),
      l.status,
    ]);
    const BOM = '\uFEFF';
    const csv = BOM + [headers, ...rows].map(r => r.map((v: any) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `licenses-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }

  let editingDevices: number | null = null;
  let editDevicesVal: number = 1;
  function startEditDevices(l: any) { editingDevices = l.id; editDevicesVal = l.max_devices; }
  function cancelEditDevices() { editingDevices = null; }

  $: if (form?.newKey)        { createdKey = form.newKey; showCreate = false; }
  $: if (form?.bulkKeys)      { bulkKeys = form.bulkKeys; showBulk = false; }
  $: if (form?.updatedDevices){ editingDevices = null; }

  function confirmRevoke(e: Event) {
    if (!confirm('Thu hồi key này? Hành động không thể hoàn tác.')) {
      e.preventDefault();
    }
  }

  function confirmDelete(e: Event) {
    if (!confirm('Xóa vĩnh viễn key này khỏi database?')) {
      e.preventDefault();
    }
  }
</script>

<div class="p-6">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl font-bold text-gray-100">License Keys</h2>
      <p class="text-gray-500 text-sm mt-0.5">Tổng: {data.total ?? 0} keys</p>
    </div>
    <div class="flex gap-2">
      <button class="btn-secondary text-sm" on:click={exportCSV}>📥 Export CSV</button>
      <button class="btn-secondary text-sm" on:click={() => showBulk = true}>📦 Bulk Create</button>
      <button class="btn-primary text-sm" on:click={() => showCreate = true}>+ New Key</button>
    </div>
  </div>

  <!-- Filters -->
  <div class="flex gap-3 mb-4 flex-wrap">
    <input bind:value={searchEmail} placeholder="Tìm theo email..." class="input max-w-xs text-sm" />
    <select bind:value={filterStatus} class="input max-w-[160px] text-sm">
      <option value="">Tất cả trạng thái</option>
      <option value="active">Active</option>
      <option value="revoked">Revoked</option>
      <option value="expired">Expired</option>
    </select>
    <span class="text-gray-500 text-sm self-center">Hiển thị: {filteredLicenses.length}</span>
  </div>

  <!-- Created key flash -->
  {#if createdKey}
    <div class="bg-green-900/40 border border-green-700 rounded-xl p-4 mb-4">
      <p class="text-green-300 font-medium mb-2">✅ Key đã tạo — lưu ngay, chỉ hiện 1 lần!</p>
      <div class="flex items-center gap-3">
        <code class="text-green-200 text-lg font-mono tracking-widest bg-black/30 px-3 py-1.5 rounded">{createdKey}</code>
        <button class="btn-secondary text-sm" on:click={() => navigator.clipboard?.writeText(createdKey)}>Copy</button>
        <button class="text-gray-500 text-sm hover:text-gray-300 cursor-pointer" on:click={() => createdKey = ''}>✕</button>
      </div>
    </div>
  {/if}

  <!-- Bulk keys flash -->
  {#if bulkKeys.length}
    <div class="bg-green-900/40 border border-green-700 rounded-xl p-4 mb-4">
      <div class="flex items-center justify-between mb-2">
        <p class="text-green-300 font-medium">✅ {bulkKeys.length} keys đã tạo</p>
        <div class="flex gap-2">
          <button class="btn-secondary text-sm" on:click={() => navigator.clipboard?.writeText(bulkKeys.join('\n'))}>Copy All</button>
          <button class="text-gray-500 text-sm hover:text-gray-300 cursor-pointer" on:click={() => bulkKeys = []}>✕</button>
        </div>
      </div>
      <div class="font-mono text-sm text-green-200 max-h-40 overflow-y-auto space-y-1 bg-black/30 p-3 rounded-lg">
        {#each bulkKeys as k}<div class="tracking-wider">{k}</div>{/each}
      </div>
    </div>
  {/if}

  <!-- Table -->
  <div class="card p-0 overflow-hidden overflow-x-auto">
    <table class="w-full text-sm min-w-[800px]">
      <thead>
        <tr class="border-b border-gray-800 text-gray-400 text-left text-xs uppercase tracking-wider">
          <th class="px-4 py-3">ID</th>
          <th class="px-4 py-3">Key (masked)</th>
          <th class="px-4 py-3">Type</th>
          <th class="px-4 py-3">Customer</th>
          <th class="px-4 py-3">Expires</th>
          <th class="px-4 py-3">Devices</th>
          <th class="px-4 py-3">UUID Máy</th>
          <th class="px-4 py-3">Status</th>
          <th class="px-4 py-3">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredLicenses as l}
          <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
            <td class="px-4 py-3 text-gray-500 text-xs">{l.id}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-300">{l.key_hash}</td>
            <td class="px-4 py-3">
              <span class="badge-{['trial','standard','premium'][l.license_type] || 'trial'}">
                {LICENSE_TYPE_LABELS[l.license_type] || 'Unknown'}
              </span>
            </td>
            <td class="px-4 py-3">
              <div class="text-gray-200 text-sm">{l.customer_name || '—'}</div>
              <div class="text-gray-500 text-xs">{l.customer_email || ''}</div>
            </td>
            <td class="px-4 py-3 text-gray-300 text-sm">{l.expires_at?.slice(0, 10) || '—'}</td>
            <td class="px-4 py-3 text-center">
              {#if editingDevices === l.id}
                <form method="POST" action="?/updateDevices" use:enhance
                  on:submit={() => { l.max_devices = editDevicesVal; }}
                  class="flex items-center gap-1 justify-center">
                  <input type="hidden" name="id" value={l.id} />
                  <input type="number" name="max_devices" bind:value={editDevicesVal}
                    min="1" max="100"
                    class="w-14 text-center bg-gray-700 border border-pink-500 rounded px-1 py-0.5 text-white text-sm focus:outline-none" />
                  <button type="submit" class="text-green-400 hover:text-green-300 text-xs font-bold px-1">✓</button>
                  <button type="button" on:click={cancelEditDevices} class="text-gray-500 hover:text-gray-300 text-xs px-1">✕</button>
                </form>
              {:else}
                <span class="text-gray-300 cursor-pointer hover:text-pink-400 transition-colors"
                  title="Click để sửa"
                  on:click={() => startEditDevices(l)}>{l.max_devices} ✏️</span>
              {/if}
            </td>
            <td class="px-4 py-3">
              {#if l.machine_ids?.length}
                <div class="space-y-1">
                  {#each l.machine_ids as mid, i}
                    <div class="flex items-center gap-1">
                      <span class="text-gray-500 text-xs w-4">{i+1}.</span>
                      <div class="font-mono text-xs text-gray-400 cursor-pointer hover:text-pink-400 transition-colors"
                        title="Click để copy: {mid}"
                        on:click={() => navigator.clipboard.writeText(mid).then(() => alert('Đã copy UUID: ' + mid))}
                      >{mid}</div>
                    </div>
                  {/each}
                </div>
              {:else}
                <span class="text-gray-600 text-xs">Chưa kích hoạt</span>
              {/if}
            </td>
            <td class="px-4 py-3">
              <span class="badge-{l.status}">{l.status}</span>
            </td>
            <td class="px-4 py-3">
              {#if l.status === 'active'}
                <form method="POST" action="?/revoke" use:enhance>
                  <input type="hidden" name="id" value={l.id} />
                  <button class="btn-danger" type="submit" on:click={confirmRevoke}>Thu hồi</button>
                </form>
              {:else if l.status === 'revoked' || l.status === 'expired'}
                <form method="POST" action="?/delete" use:enhance={() => ({ async update() { await invalidateAll(); } })}>
                  <input type="hidden" name="id" value={l.id} />
                  <button class="btn-danger text-xs px-3 py-1.5" type="submit" on:click={confirmDelete}>Xóa</button>
                </form>
              {:else}
                <span class="text-gray-600 text-xs">—</span>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="8" class="px-4 py-10 text-center text-gray-500">
              {#if searchEmail || filterStatus}Không tìm thấy kết quả phù hợp{:else}Chưa có license key nào{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<!-- Create Key Modal -->
{#if showCreate}
  <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
    <div class="card w-full max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">Tạo License Key mới</h3>
        <button class="text-gray-400 hover:text-gray-200 cursor-pointer" on:click={() => showCreate = false}>✕</button>
      </div>
      <form method="POST" action="?/create" use:enhance class="space-y-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Loại key</label>
          <select name="license_type" class="input">
            <option value="0">Trial</option>
            <option value="1" selected>Standard</option>
            <option value="2">Premium</option>
          </select>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Tên khách hàng</label>
          <input name="customer_name" class="input" placeholder="Nguyễn Văn A" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Email</label>
          <input name="customer_email" type="email" class="input" placeholder="user@email.com" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm text-gray-400 mb-1">Số ngày</label>
            <input name="expires_days" type="number" value="365" min="1" max="3650" class="input" />
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Max thiết bị</label>
            <input name="max_devices" type="number" value="1" min="1" max="10" class="input" />
          </div>
        </div>
        <div class="flex gap-3 justify-end pt-2">
          <button type="button" class="btn-secondary" on:click={() => showCreate = false}>Hủy</button>
          <button type="submit" class="btn-primary">Tạo Key</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- Bulk Create Modal -->
{#if showBulk}
  <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
    <div class="card w-full max-w-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">Tạo nhiều Keys</h3>
        <button class="text-gray-400 hover:text-gray-200 cursor-pointer" on:click={() => showBulk = false}>✕</button>
      </div>
      <form method="POST" action="?/bulk" use:enhance class="space-y-4">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Số lượng (1–100)</label>
          <input name="count" type="number" value="10" min="1" max="100" class="input" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Loại key</label>
          <select name="license_type" class="input">
            <option value="0">Trial</option>
            <option value="1" selected>Standard</option>
            <option value="2">Premium</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm text-gray-400 mb-1">Số ngày</label>
            <input name="expires_days" type="number" value="365" min="1" class="input" />
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Max thiết bị</label>
            <input name="max_devices" type="number" value="1" min="1" max="10" class="input" />
          </div>
        </div>
        <div class="flex gap-3 justify-end pt-2">
          <button type="button" class="btn-secondary" on:click={() => showBulk = false}>Hủy</button>
          <button type="submit" class="btn-primary">Tạo tất cả</button>
        </div>
      </form>
    </div>
  </div>
{/if}
