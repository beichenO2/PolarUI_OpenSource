import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ExecutionResult } from '@/engine/executor'

export type RunStatus = 'running' | 'completed' | 'error'
export type RunFilter = 'all' | 'completed' | 'error'

export interface RunNodeTrace {
  nodeId: string
  nodeName: string
  classType: string
  status: 'running' | 'completed' | 'error' | 'skipped'
  duration_ms?: number
  outputPreview?: string
}

export interface RunRecord {
  id: string
  workflowId: string
  startedAt: number
  finishedAt?: number
  status: RunStatus
  nodeTraces: RunNodeTrace[]
}

const STORAGE_KEY = 'polarui-runs-v1'
const MAX_RUNS = 50

function previewOutput(result: ExecutionResult): string | undefined {
  if (result.error) return result.error.slice(0, 120)
  const outs = result.outputs ?? {}
  const keys = Object.keys(outs)
  if (!keys.length) return undefined
  const val = outs[keys[0]]
  if (val == null) return undefined
  const text = typeof val === 'string' ? val : JSON.stringify(val)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function loadRuns(): RunRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RunRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRuns(runs: RunRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(0, MAX_RUNS)))
  } catch { /* headless / quota */ }
}

export const useRunsStore = defineStore('runs', () => {
  const runs = ref<RunRecord[]>(loadRuns())
  const selectedRunId = ref<string | null>(null)
  const liveRunId = ref<string | null>(null)
  const filter = ref<RunFilter>('all')
  const drawerExpanded = ref(false)
  const activeStepIndex = ref(-1)

  const selectedRun = computed(() =>
    runs.value.find(r => r.id === selectedRunId.value) ?? null,
  )

  const liveRun = computed(() =>
    runs.value.find(r => r.id === liveRunId.value) ?? null,
  )

  const displayRun = computed(() => {
    if (liveRun.value?.status === 'running') return liveRun.value
    return selectedRun.value ?? liveRun.value
  })

  const drawerVisible = computed(() =>
    !!displayRun.value && displayRun.value.nodeTraces.length > 0,
  )

  const filteredRuns = computed(() => {
    const list = [...runs.value].sort((a, b) => b.startedAt - a.startedAt)
    if (filter.value === 'completed') {
      return list.filter(r => r.status === 'completed')
    }
    if (filter.value === 'error') {
      return list.filter(r => r.status === 'error')
    }
    return list
  })

  function persist() {
    saveRuns(runs.value)
  }

  function startRun(workflowId: string): string {
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record: RunRecord = {
      id,
      workflowId,
      startedAt: Date.now(),
      status: 'running',
      nodeTraces: [],
    }
    runs.value = [record, ...runs.value].slice(0, MAX_RUNS)
    liveRunId.value = id
    selectedRunId.value = id
    drawerExpanded.value = true
    activeStepIndex.value = -1
    persist()
    return id
  }

  function onNodeStart(
    runId: string,
    payload: { nodeId: string; classType: string; nodeName: string },
  ) {
    const run = runs.value.find(r => r.id === runId)
    if (!run) return
    const existing = run.nodeTraces.find(t => t.nodeId === payload.nodeId)
    if (existing) {
      existing.status = 'running'
      return
    }
    run.nodeTraces.push({
      nodeId: payload.nodeId,
      nodeName: payload.nodeName,
      classType: payload.classType,
      status: 'running',
    })
    activeStepIndex.value = run.nodeTraces.length - 1
    persist()
  }

  function onNodeDone(
    runId: string,
    payload: {
      nodeId: string
      classType: string
      nodeName: string
      result: ExecutionResult
      duration_ms: number
    },
  ) {
    const run = runs.value.find(r => r.id === runId)
    if (!run) return
    let trace = run.nodeTraces.find(t => t.nodeId === payload.nodeId)
    if (!trace) {
      trace = {
        nodeId: payload.nodeId,
        nodeName: payload.nodeName,
        classType: payload.classType,
        status: 'running',
      }
      run.nodeTraces.push(trace)
    }
    trace.status = payload.result.error ? 'error' : 'completed'
    trace.duration_ms = payload.duration_ms
    trace.outputPreview = previewOutput(payload.result)
    activeStepIndex.value = run.nodeTraces.length - 1
    persist()
  }

  function onNodeSkipped(
    runId: string,
    payload: { nodeId: string; classType: string; nodeName: string; reason?: string },
  ) {
    const run = runs.value.find(r => r.id === runId)
    if (!run) return
    run.nodeTraces.push({
      nodeId: payload.nodeId,
      nodeName: payload.nodeName,
      classType: payload.classType,
      status: 'skipped',
      outputPreview: payload.reason,
    })
    activeStepIndex.value = run.nodeTraces.length - 1
    persist()
  }

  function finishRun(runId: string, status: 'completed' | 'error') {
    const run = runs.value.find(r => r.id === runId)
    if (!run) return
    run.status = status
    run.finishedAt = Date.now()
    if (liveRunId.value === runId) liveRunId.value = null
    persist()
  }

  function selectRun(runId: string) {
    selectedRunId.value = runId
    drawerExpanded.value = true
    const run = runs.value.find(r => r.id === runId)
    activeStepIndex.value = run && run.nodeTraces.length ? run.nodeTraces.length - 1 : -1
  }

  function setFilter(next: RunFilter) {
    filter.value = next
  }

  function setDrawerExpanded(expanded: boolean) {
    drawerExpanded.value = expanded
  }

  function setActiveStepIndex(index: number) {
    activeStepIndex.value = index
  }

  function runDuration(run: RunRecord): number | null {
    if (run.finishedAt) return run.finishedAt - run.startedAt
    if (run.status === 'running') return Date.now() - run.startedAt
    return null
  }

  return {
    runs,
    selectedRunId,
    liveRunId,
    filter,
    drawerExpanded,
    activeStepIndex,
    selectedRun,
    liveRun,
    displayRun,
    drawerVisible,
    filteredRuns,
    startRun,
    onNodeStart,
    onNodeDone,
    onNodeSkipped,
    finishRun,
    selectRun,
    setFilter,
    setDrawerExpanded,
    setActiveStepIndex,
    runDuration,
  }
})
