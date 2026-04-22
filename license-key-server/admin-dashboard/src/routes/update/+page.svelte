<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  let uploading = false;
  let fileName = '';
  let required = false;

  function onFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    fileName = input.files?.[0]?.name || '';
  }
</script>

<div class="p-6 max-w-2xl">
  <div class="mb-6">
    <h2 class="text-xl font-bold text-gray-100">Update Manager</h2>
    <p class="text-gray-500 text-sm mt-0.5">Publish bản cập nhật EXE cho người dùng</p>
  </div>

  <!-- Version hiện tại -->
  {#if data.current}
    <div class="card mb-6 border-green-500/20 bg-green-500/5">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs text-gray-500 uppercase tracking-wider mb-1">Bản hiện tại</div>
          <div class="text-lg font-bold text-green-400">v{data.current.version}</div>
          <div class="text-xs text-gray-500 mt-0.5">Released: {data.current.released_at?.slice(0, 10)}</div>
        </div>
        <div class="text-right">
          <div class="text-xs text-gray-500 mb-1">Download URL</div>
          <a href={data.current.download_url} target="_blank"
            class="text-xs text-pink-400 hover:underline break-all">{data.current.download_url}</a>
          <div class="mt-1">
            <span class="text-xs px-2 py-0.5 rounded-full {data.current.required ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-400'}">
              {data.current.required ? 'Bắt buộc update' : 'Tùy chọn'}
            </span>
          </div>
        </div>
      </div>
      {#if data.current.changelog}
        <div class="mt-3 pt-3 border-t border-gray-700/50">
          <div class="text-xs text-gray-500 mb-1">Changelog</div>
          <pre class="text-xs text-gray-300 whitespace-pre-wrap font-sans">{data.current.changelog}</pre>
        </div>
      {/if}
    </div>
  {:else}
    <div class="card mb-6 border-gray-700/50 text-center py-8">
      <div class="text-gray-500 text-sm">Chưa có bản nào được publish</div>
    </div>
  {/if}

  <!-- Upload form -->
  <div class="card">
    <h3 class="text-sm font-semibold text-gray-200 mb-4">Publish bản mới</h3>

    {#if form?.success}
      <div class="mb-4 px-4 py-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
        Upload thành công! Người dùng sẽ thấy thông báo update khi mở tool.
      </div>
    {/if}
    {#if form?.error}
      <div class="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
        {form.error}
      </div>
    {/if}

    <form method="POST" action="?/upload" enctype="multipart/form-data"
      use:enhance={() => {
        uploading = true;
        return async ({ update }) => { uploading = false; await update(); };
      }}>

      <div class="space-y-4">
        <!-- Version -->
        <div>
          <label class="block text-xs text-gray-400 mb-1">Version <span class="text-red-400">*</span></label>
          <input name="version" type="text" placeholder="1.8.0" required
            class="input w-full" />
        </div>

        <!-- File EXE -->
        <div>
          <label class="block text-xs text-gray-400 mb-1">File EXE <span class="text-red-400">*</span></label>
          <label class="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-700 bg-gray-800/50
            hover:border-pink-500/50 cursor-pointer transition-colors">
            <svg class="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <span class="text-sm text-gray-400">{fileName || 'Chọn file .exe...'}</span>
            <input name="file" type="file" accept=".exe" class="hidden" on:change={onFileChange} required />
          </label>
          <p class="text-xs text-gray-600 mt-1">Tối đa 300MB. File sẽ được lưu thành NovaFrame-latest.exe</p>
        </div>

        <!-- Changelog -->
        <div>
          <label class="block text-xs text-gray-400 mb-1">Changelog</label>
          <textarea name="changelog" rows="4" placeholder="- Fix bug X&#10;- Thêm tính năng Y"
            class="input w-full resize-none font-mono text-xs"></textarea>
        </div>

        <!-- Required -->
        <div class="flex items-center gap-3">
          <input type="hidden" name="required" value={required ? 'true' : 'false'} />
          <button type="button" on:click={() => required = !required}
            class="relative w-10 h-5 rounded-full transition-colors {required ? 'bg-red-500' : 'bg-gray-700'} cursor-pointer">
            <span class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform
              {required ? 'translate-x-5' : 'translate-x-0'}"></span>
          </button>
          <div>
            <div class="text-sm text-gray-300">Bắt buộc update</div>
            <div class="text-xs text-gray-500">Nếu bật, tool sẽ không cho dùng nếu chưa update</div>
          </div>
        </div>

        <button type="submit" disabled={uploading}
          class="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
          {#if uploading}
            <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
            Đang upload...
          {:else}
            Publish Update
          {/if}
        </button>
      </div>
    </form>
  </div>
</div>
