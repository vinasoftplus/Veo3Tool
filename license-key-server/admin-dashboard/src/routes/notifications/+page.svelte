<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  const TYPE_LABELS: Record<string, string> = {
    info: 'Thông tin',
    warning: 'Cảnh báo',
    error: 'Lỗi',
    success: 'Thành công',
  };
  const TYPE_COLORS: Record<string, string> = {
    info:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
    warning: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    error:   'bg-red-500/10 text-red-400 border-red-500/20',
    success: 'bg-green-500/10 text-green-400 border-green-500/20',
  };

  let showForm = false;
  let submitting = false;

  // form state
  let fTitle = '';
  let fMessage = '';
  let fType = 'info';
  let fTitleColor = '#1e293b';
  let fMsgColor = '#374151';
  let fBgColor = '#ffffff';
  let fExpiresHours = 0;

  function resetForm() {
    fTitle = ''; fMessage = ''; fType = 'info';
    fTitleColor = '#1e293b'; fMsgColor = '#374151'; fBgColor = '#ffffff';
    fExpiresHours = 0;
  }

  function fmt(dt: string | null) {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('vi-VN');
  }

  $: if (form?.success) { showForm = false; resetForm(); }
</script>

<div class="p-6 max-w-4xl">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold text-gray-100">Thông báo</h2>
      <p class="text-gray-500 text-sm mt-0.5">Gửi thông báo tới tất cả người dùng khi mở tool</p>
    </div>
    <button class="btn-primary" on:click={() => { showForm = !showForm; }}>
      {showForm ? '✕ Đóng' : '+ Tạo thông báo'}
    </button>
  </div>

  <!-- Create form -->
  {#if showForm}
    <div class="card mb-6 border-pink-500/20 bg-pink-500/5">
      <h3 class="text-sm font-semibold text-gray-200 mb-4">Tạo thông báo mới</h3>

      {#if form?.error}
        <div class="mb-4 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {form.error}
        </div>
      {/if}

      <form method="POST" action="?/create"
        use:enhance={() => {
          submitting = true;
          return async ({ update }) => { submitting = false; await update(); };
        }}
        class="space-y-4">

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Tiêu đề</label>
            <input name="title" type="text" bind:value={fTitle} class="input w-full" placeholder="Ví dụ: Bảo trì hệ thống..." />
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Loại thông báo</label>
            <select name="notif_type" bind:value={fType} class="input w-full">
              <option value="info">Thông tin</option>
              <option value="success">Thành công</option>
              <option value="warning">Cảnh báo</option>
              <option value="error">Lỗi / Khẩn cấp</option>
            </select>
          </div>
        </div>

        <div>
          <label class="block text-xs text-gray-400 mb-1">Nội dung <span class="text-red-400">*</span></label>
          <textarea name="message" rows="3" bind:value={fMessage} required
            class="input w-full resize-none" placeholder="Nhập nội dung thông báo..."></textarea>
        </div>

        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Màu tiêu đề</label>
            <div class="flex items-center gap-2">
              <input type="color" name="title_color" bind:value={fTitleColor}
                class="w-8 h-8 rounded cursor-pointer border border-gray-700 bg-transparent" />
              <input type="text" value={fTitleColor} on:input={(e) => fTitleColor = (e.target as HTMLInputElement).value}
                class="input flex-1 text-xs font-mono" />
              <input type="hidden" name="title_color" bind:value={fTitleColor} />
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Màu nội dung</label>
            <div class="flex items-center gap-2">
              <input type="color" name="message_color" bind:value={fMsgColor}
                class="w-8 h-8 rounded cursor-pointer border border-gray-700 bg-transparent" />
              <input type="text" value={fMsgColor} on:input={(e) => fMsgColor = (e.target as HTMLInputElement).value}
                class="input flex-1 text-xs font-mono" />
              <input type="hidden" name="message_color" bind:value={fMsgColor} />
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">Màu nền popup</label>
            <div class="flex items-center gap-2">
              <input type="color" name="bg_color" bind:value={fBgColor}
                class="w-8 h-8 rounded cursor-pointer border border-gray-700 bg-transparent" />
              <input type="text" value={fBgColor} on:input={(e) => fBgColor = (e.target as HTMLInputElement).value}
                class="input flex-1 text-xs font-mono" />
              <input type="hidden" name="bg_color" bind:value={fBgColor} />
            </div>
          </div>
        </div>

        <!-- Preview -->
        <div>
          <div class="text-xs text-gray-500 mb-2">Xem trước popup:</div>
          <div class="rounded-xl border border-gray-600 p-4 max-w-sm" style="background-color: {fBgColor};">
            {#if fTitle}
              <div class="font-semibold text-sm mb-1" style="color: {fTitleColor};">{fTitle}</div>
            {/if}
            <div class="text-sm" style="color: {fMsgColor};">{fMessage || '(nội dung thông báo)'}</div>
          </div>
        </div>

        <div>
          <label class="block text-xs text-gray-400 mb-1">Hết hạn sau (giờ) — 0 = không hết hạn</label>
          <input name="expires_hours" type="number" min="0" step="1" bind:value={fExpiresHours}
            class="input w-32" />
        </div>

        <div class="flex gap-3 pt-2">
          <button type="submit" disabled={submitting} class="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Đang tạo...' : 'Tạo thông báo'}
          </button>
          <button type="button" on:click={() => { showForm = false; resetForm(); }}
            class="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors cursor-pointer">
            Hủy
          </button>
        </div>
      </form>
    </div>
  {/if}

  <!-- List -->
  {#if data.notifications.length === 0}
    <div class="card text-center py-12 border-gray-700/50">
      <div class="text-gray-500 text-sm">Chưa có thông báo nào</div>
      <div class="text-gray-600 text-xs mt-1">Tạo thông báo để hiển thị cho người dùng khi mở tool</div>
    </div>
  {:else}
    <div class="space-y-3">
      {#each data.notifications as n}
        <div class="card border-gray-700/50 {!n.is_active ? 'opacity-50' : ''}">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1 flex-wrap">
                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs border {TYPE_COLORS[n.notif_type] || TYPE_COLORS.info}">
                  {TYPE_LABELS[n.notif_type] || n.notif_type}
                </span>
                {#if !n.is_active}
                  <span class="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">Tắt</span>
                {/if}
                <span class="text-xs text-gray-500">{fmt(n.created_at)}</span>
                {#if n.expires_at}
                  <span class="text-xs text-yellow-600">Hết hạn: {fmt(n.expires_at)}</span>
                {/if}
              </div>
              {#if n.title}
                <div class="text-sm font-medium text-gray-200 mb-0.5">{n.title}</div>
              {/if}
              <div class="text-sm text-gray-400">{n.message}</div>

              <!-- Color swatches -->
              <div class="flex items-center gap-3 mt-2">
                <div class="flex items-center gap-1">
                  <div class="w-3 h-3 rounded-full border border-gray-600" style="background-color: {n.bg_color};"></div>
                  <span class="text-xs text-gray-600">nền</span>
                </div>
                <div class="flex items-center gap-1">
                  <div class="w-3 h-3 rounded-full border border-gray-600" style="background-color: {n.title_color};"></div>
                  <span class="text-xs text-gray-600">tiêu đề</span>
                </div>
                <div class="flex items-center gap-1">
                  <div class="w-3 h-3 rounded-full border border-gray-600" style="background-color: {n.message_color};"></div>
                  <span class="text-xs text-gray-600">nội dung</span>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-2 shrink-0">
              <form method="POST" action="?/toggle" use:enhance>
                <input type="hidden" name="id" value={n.id} />
                <button type="submit" class="text-xs px-3 py-1 rounded border cursor-pointer transition-colors
                  {n.is_active
                    ? 'border-yellow-600/40 text-yellow-500 hover:bg-yellow-500/10'
                    : 'border-green-600/40 text-green-500 hover:bg-green-500/10'}">
                  {n.is_active ? 'Tắt' : 'Bật'}
                </button>
              </form>
              <form method="POST" action="?/delete" use:enhance>
                <input type="hidden" name="id" value={n.id} />
                <button type="submit"
                  on:click={(e) => { if (!confirm('Xóa thông báo này?')) e.preventDefault(); }}
                  class="text-xs px-3 py-1 rounded border border-red-600/40 text-red-500 hover:bg-red-500/10 cursor-pointer transition-colors">
                  Xóa
                </button>
              </form>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
