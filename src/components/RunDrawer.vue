<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { useRunsStore, type RunNodeTrace } from '@/stores/runs'

const props = defineProps<{
  onHighlight?: (nodeIds: string[]) => void
}>()

const runsStore = useRunsStore()
const replayTimer = ref<ReturnType<typeof setInterval> | null>(null)
const replayIndex = ref(-1)

const run = computed(() => runsStore.displayRun)
const steps = computed(() => run.value?.nodeTraces ?? [])
const expanded = computed({
  get: () => runsStore.drawerExpanded,
  set: (v: boolean) => runsStore.setDrawerExpanded(v),
})

function chipClass(trace: RunNodeTrace, index: number): string {
  const active = runsStore.activeStepIndex === index
    || (replayIndex.value >= 0 && replayIndex.value === index)
  const base = ['run-step-chip']
  if (active) base.push('run-step-chip--active')
  if (trace.status === 'error') base.push('run-step-chip--error')
  else if (trace.status === 'skipped') base.push('run-step-chip--skipped')
  else if (trace.status === 'running') base.push('run-step-chip--running')
  return base.join(' ')
}

function formatStepDuration(ms?: number): string {
  if (ms == null) return '…'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function applyHighlight(index: number) {
  if (index < 0 || !steps.value.length) {
    props.onHighlight?.([])
    return
  }
  const trace = steps.value[index]
  if (trace) props.onHighlight?.([trace.nodeId])
}

function onStepClick(index: number) {
  stopReplay()
  replayIndex.value = -1
  runsStore.setActiveStepIndex(index)
  applyHighlight(index)
}

function stopReplay() {
  if (replayTimer.value) {
    clearInterval(replayTimer.value)
    replayTimer.value = null
  }
}

function startReplay() {
  stopReplay()
  if (!steps.value.length) return
  replayIndex.value = 0
  applyHighlight(0)
  replayTimer.value = setInterval(() => {
    if (replayIndex.value >= steps.value.length - 1) {
      stopReplay()
      replayIndex.value = -1
      return
    }
    replayIndex.value += 1
    applyHighlight(replayIndex.value)
  }, 500)
}

watch(
  () => runsStore.activeStepIndex,
  (idx) => {
    if (replayTimer.value) return
    applyHighlight(idx)
  },
)

watch(
  () => steps.value.length,
  () => {
    if (replayTimer.value) return
    const idx = runsStore.activeStepIndex
    if (idx >= 0) applyHighlight(idx)
  },
)

watch(
  () => runsStore.selectedRunId,
  () => {
    stopReplay()
    replayIndex.value = -1
  },
)

onUnmounted(() => {
  stopReplay()
  props.onHighlight?.([])
})
</script>

<template>
  <div
    v-if="runsStore.drawerVisible && run"
    class="run-drawer"
    :class="{ 'run-drawer--collapsed': !expanded }"
  >
    <button type="button" class="run-drawer-bar" @click="expanded = !expanded">
      <span class="run-drawer-bar-title">
        运行轨迹
        <span class="run-drawer-bar-meta">{{ run.workflowId }} · {{ steps.length }} 步</span>
      </span>
      <span class="run-drawer-bar-toggle">{{ expanded ? '▼' : '▲' }}</span>
    </button>

    <div v-if="expanded" class="run-drawer-body">
      <div class="run-timeline">
        <button
          v-for="(trace, i) in steps"
          :key="`${trace.nodeId}-${i}`"
          type="button"
          :class="chipClass(trace, i)"
          @click="onStepClick(i)"
        >
          <span class="run-step-name">{{ trace.nodeName }}</span>
          <span class="run-step-duration">{{ formatStepDuration(trace.duration_ms) }}</span>
        </button>
      </div>
      <div class="run-drawer-actions">
        <button type="button" class="run-replay-btn" :disabled="!steps.length" @click="startReplay">
          ▶ 回放
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.run-drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  height: 220px;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  box-shadow: 0 -4px 16px rgba(15, 23, 42, 0.08);
}

.run-drawer--collapsed {
  height: 28px;
}

.run-drawer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 12px;
  border: none;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}

.run-drawer-bar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.run-drawer-bar-meta {
  font-weight: 400;
  color: var(--color-text-muted);
}

.run-drawer-bar-toggle {
  color: var(--color-text-muted);
}

.run-drawer-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 10px;
  gap: 8px;
}

.run-timeline {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  flex: 1;
  align-items: flex-start;
}

.run-step-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 88px;
  max-width: 140px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  text-align: left;
}

.run-step-chip--active {
  border-color: var(--color-valid);
  box-shadow: 0 0 0 2px rgba(5, 150, 105, 0.2);
}

.run-step-chip--error {
  border-color: var(--color-error);
  background: #fef2f2;
}

.run-step-chip--skipped {
  opacity: 0.55;
}

.run-step-chip--running {
  border-color: #2563eb;
}

.run-step-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.run-step-duration {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.run-drawer-actions {
  flex-shrink: 0;
}

.run-replay-btn {
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 11px;
  cursor: pointer;
}

.run-replay-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.run-replay-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
