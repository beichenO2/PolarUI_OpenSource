<template>
  <button
    id="polar-export-web-btn"
    type="button"
    class="export-web-btn"
    :disabled="exporting"
    @click="handleExport"
  >
    {{ exporting ? '导出中…' : '导出网站' }}
  </button>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const exporting = ref(false)

async function handleExport() {
  exporting.value = true
  try {
    const wf = window.prompt('workflow_id', 'taoci-outreach') || 'taoci-outreach'
    const res = await fetch('/api/export-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: wf, skip_preflight: true, compile_only: true }),
    })
    const data = await res.json()
    if (!data.ok) {
      throw new Error(data.errors?.join('; ') || data.error || String(res.status))
    }
    window.alert(`导出成功\n${data.release_path}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    window.alert(`导出失败: ${msg}`)
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.export-web-btn {
  position: fixed;
  bottom: 40px;
  right: 16px;
  z-index: 99999;
  padding: 8px 14px;
  background: var(--color-primary);
  color: #fff;
  border: 1px solid var(--color-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.export-web-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
</style>
