import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Graph } from '@/engine/graph'
import { hubApi } from '@/api/hub'
import type { ExecutionState } from '@/engine/types'
import { executeGraph, topologicalSort } from '@/engine/workflow-runner'
import { persistRunTrace } from '@/engine/run-persistence'

export const useWorkflowStore = defineStore('workflow', () => {
  const graph = ref<Graph>(new Graph('新工作流'))
  const dirty = ref(false)
  const execution = ref<ExecutionState>({ status: 'idle' })

  const currentName = computed(() => graph.value.name)

  function addNode(classType: string, screenX: number, screenY: number) {
    graph.value.addNode(classType, screenX, screenY)
    dirty.value = true
  }

  /** 已注册工作流拖到画布 → AgentWorkflow 单 in/out 调用节点 */
  function addRegistryWorkflowCall(
    entry: { id: string; name: string; description?: string },
    screenX: number,
    screenY: number,
  ) {
    const node = graph.value.addNode('AgentWorkflow', screenX, screenY)
    if (node) {
      node.params.workflow_id = entry.id
      node.params.workflow_name = entry.name
      if (entry.description) node.params.workflow_description = entry.description
      dirty.value = true
    }
    return node
  }

  function markDirty() {
    dirty.value = true
  }

  function newWorkflow(name = '新工作流') {
    graph.value = new Graph(name)
    dirty.value = false
    execution.value = { status: 'idle' }
  }

  function setGraph(newGraph: Graph) {
    graph.value = newGraph
    dirty.value = false
    execution.value = { status: 'idle' }
  }

  async function execute() {
    if (!graph.value.nodes.length) return

    execution.value = { status: 'running', progress: 0, streaming: {} }
    const apiFormat = graph.value.toApiFormat()

    try {
      const total = topologicalSort(graph.value).length

      execution.value.progress = 0
      const runPromise = executeGraph(graph.value, {
            onStreamChunk: (nodeId, chunk) => {
              const prev = execution.value.streaming?.[nodeId] ?? ''
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                streaming: { ...(execution.value.streaming ?? {}), [nodeId]: prev + chunk },
              }
            },
            onNodeStart: ({ nodeId, classType }) => {
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: { status: 'running', class_type: classType, started_at: Date.now() },
                },
              }
            },
            onNodeDone: ({ nodeId, classType, result, duration_ms }) => {
              execution.value = {
                ...execution.value,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: {
                    status: result.error ? 'error' : 'completed',
                    class_type: classType,
                    duration_ms,
                    output_keys: Object.keys(result.outputs ?? {}),
                    error: result.error,
                  },
                },
              }
            },
            onNodeSkipped: ({ nodeId, classType, reason }) => {
              execution.value = {
                ...execution.value,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: { status: 'skipped', class_type: classType, reason },
                },
              }
            },
          })
      const progressTimer = setInterval(() => {
        if (execution.value.status === 'running' && execution.value.progress !== undefined) {
          execution.value.progress = Math.min(95, (execution.value.progress ?? 0) + 100 / Math.max(total, 1))
        }
      }, 200)

      const runResult = await runPromise
      clearInterval(progressTimer)
      const allResults = runResult.results
      const { merged_output, unhealthy_nodes } = runResult
      const runTrace = 'runTrace' in runResult ? runResult.runTrace : undefined

      execution.value = {
        status: 'completed',
        progress: 100,
        results: Object.fromEntries(allResults),
        last_run_at: Date.now(),
      }

      if (unhealthy_nodes.length) {
        execution.value.unhealthy_nodes = unhealthy_nodes
        console.warn('[Executor] Unhealthy nodes:', unhealthy_nodes)
      }

      if (merged_output !== undefined) {
        execution.value.merged_output = merged_output
      }

      if (runTrace) {
        const logPath = await persistRunTrace(runTrace)
        if (logPath) execution.value.last_log_path = logPath
      }

      if (await hubApi.checkHealth()) {
        await hubApi.submitWorkflow(apiFormat)
      }
    } catch (err) {
      execution.value = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    setTimeout(() => {
      if (execution.value.status === 'completed') {
        execution.value = {
          status: 'idle',
          results: execution.value.results,
          merged_output: execution.value.merged_output,
          unhealthy_nodes: execution.value.unhealthy_nodes,
          last_run_at: execution.value.last_run_at,
          last_log_path: execution.value.last_log_path,
        }
      }
    }, 3000)
  }

  async function executeWithMessage(
    message: string,
    opts: { conversation_id: string; user_id?: string; turn_index?: number },
  ): Promise<{ content: string | null; error?: string }> {
    if (!graph.value.nodes.length) return { content: null, error: 'empty graph' }

    execution.value = { status: 'running', progress: 0, streaming: {} }
    const runContext = {
      conversation_id: opts.conversation_id,
      user_id: opts.user_id ?? 'chat-user',
      turn_index: opts.turn_index,
      user_message: message,
    }
    const externalInputs = {
      conversation_id: opts.conversation_id,
      user_id: opts.user_id ?? 'chat-user',
      message,
      user_message: message,
    }

    try {
      const runResult = await executeGraph(graph.value, {
            runContext,
            externalInputs,
            onStreamChunk: (nodeId, chunk) => {
              const prev = execution.value.streaming?.[nodeId] ?? ''
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                streaming: { ...(execution.value.streaming ?? {}), [nodeId]: prev + chunk },
              }
            },
            onNodeStart: ({ nodeId, classType }) => {
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: { status: 'running', class_type: classType, started_at: Date.now() },
                },
              }
            },
            onNodeDone: ({ nodeId, classType, result, duration_ms }) => {
              execution.value = {
                ...execution.value,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: {
                    status: result.error ? 'error' : 'completed',
                    class_type: classType,
                    duration_ms,
                    output_keys: Object.keys(result.outputs ?? {}),
                    error: result.error,
                  },
                },
              }
            },
            onNodeSkipped: ({ nodeId, classType, reason }) => {
              execution.value = {
                ...execution.value,
                node_states: {
                  ...(execution.value.node_states ?? {}),
                  [nodeId]: { status: 'skipped', class_type: classType, reason },
                },
              }
            },
          })

      execution.value = {
        status: runResult.unhealthy_nodes.length ? 'error' : 'completed',
        progress: 100,
        results: Object.fromEntries(runResult.results),
        merged_output: runResult.merged_output,
        unhealthy_nodes: runResult.unhealthy_nodes,
        last_run_at: Date.now(),
        error: runResult.unhealthy_nodes[0]?.error,
        streaming: execution.value.streaming,
      }

      const content = runResult.merged_output != null
        ? String(runResult.merged_output)
        : null
      return { content, error: runResult.unhealthy_nodes[0]?.error }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      execution.value = { status: 'error', error: msg }
      return { content: null, error: msg }
    }
  }

  function exportJson(): string {
    return JSON.stringify(graph.value.toApiFormat(), null, 2)
  }

  return {
    graph,
    dirty,
    execution,
    currentName,
    addNode,
    addRegistryWorkflowCall,
    markDirty,
    newWorkflow,
    setGraph,
    execute,
    executeWithMessage,
    exportJson,
  }
})

