<script setup lang="ts">
import { computed } from 'vue'
import { useRunsStore, type RunRecord } from '@/stores/runs'

const runsStore = useRunsStore()

const filterOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'completed' as const, label: '成功' },
  { value: 'error' as const, label: '失败' },
]

const empty = computed(() => runsStore.filteredRuns.length === 0)

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDuration(run: RunRecord): string {
  const ms = runsStore.runDuration(run)
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusDotClass(status: RunRecord['status']): string {
  if (status === 'completed') return 'runs-dot runs-dot--ok'
  if (status === 'error') return 'runs-dot runs-dot--fail'
  return 'runs-dot runs-dot--running'
}

function onSelectRun(runId: string) {
  runsStore.selectRun(runId)
}
</script>

<template>
  <div class="runs-panel">
    <div class="runs-panel-header">
      <span class="runs-panel-title">运行记录</span>
      <select
        class="runs-filter"
        :value="runsStore.filter"
        @change="runsStore.setFilter(($event.target as HTMLSelectElement).value as 'all' | 'completed' | 'error')"
      >
        <option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </div>

    <div v-if="empty" class="runs-empty">
      还没有运行记录 — 点击「执行」运行当前工作流。
    </div>

    <ul v-else class="runs-list">
      <li
        v-for="run in runsStore.filteredRuns"
        :key="run.id"
        class="runs-item"
        :class="{ 'runs-item--selected': runsStore.selectedRunId === run.id }"
        @click="onSelectRun(run.id)"
      >
        <div class="runs-item-row">
          <span :class="statusDotClass(run.status)" />
          <span class="runs-item-workflow" :title="run.workflowId">{{ run.workflowId }}</span>
          <span class="runs-item-time">{{ formatTime(run.startedAt) }}</span>
        </div>
        <div class="runs-item-meta">
          <span>{{ formatDuration(run) }}</span>
          <span>{{ run.nodeTraces.length }} 节点</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.runs-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 12px;
}

.runs-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.runs-panel-title {
  font-weight: 600;
  font-size: 13px;
}

.runs-filter {
  font-size: 11px;
  padding: 3px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg);
  color: var(--color-text);
}

.runs-empty {
  padding: 24px 16px;
  color: var(--color-text-muted);
  line-height: 1.5;
  text-align: center;
}

.runs-list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
  flex: 1;
}

.runs-item {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border);
  transition: background 0.12s;
}

.runs-item:hover {
  background: var(--color-bg);
}

.runs-item--selected {
  background: #ede9fe;
}

.runs-item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.runs-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.runs-dot--ok { background: var(--color-valid); }
.runs-dot--fail { background: var(--color-error); }
.runs-dot--running { background: #2563eb; }

.runs-item-workflow {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.runs-item-time {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.runs-item-meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  padding-left: 16px;
  color: var(--color-text-muted);
  font-size: 11px;
}
</style>
