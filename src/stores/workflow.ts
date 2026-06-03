import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Graph } from '@/engine/graph'
import { hubApi } from '@/api/hub'
import type { ExecutionState } from '@/engine/types'
import { executeGraph, topologicalSort } from '@/engine/workflow-runner'
import { executeLGSpec, type LGRunResult } from '@/engine/lg-runner'
import { persistRunTrace, persistLGRun } from '@/engine/run-persistence'

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
    const isLG = graph.value.library === 'LG'

    try {
      const total = isLG
        ? graph.value.nodes.length
        : topologicalSort(graph.value).length

      execution.value.progress = 0
      const runPromise = isLG
        ? executeLGSpec(graph.value, {
            onStep: ({ stepIndex, nodeId, materialized_graph }) => {
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                lg_step: stepIndex,
                lg_run: {
                  steps: [],
                  materialized_graph,
                  differentiation_traces: [],
                },
              }
            },
          })
        : executeGraph(graph.value, {
            onStreamChunk: (nodeId, chunk) => {
              const prev = execution.value.streaming?.[nodeId] ?? ''
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                streaming: { ...(execution.value.streaming ?? {}), [nodeId]: prev + chunk },
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
        if (isLG) {
          const lgResult = runResult as LGRunResult
          const paths = await persistLGRun(graph.value.name, lgResult)
          if (paths?.log_path) execution.value.last_log_path = paths.log_path
          if (paths?.run_path) execution.value.last_run_path = paths.run_path
          execution.value.lg_run = {
            steps: lgResult.steps.map(s => ({
              index: s.index,
              node_id: s.node_id,
              class_type: s.class_type,
              routing: s.routing?.chosen,
            })),
            materialized_graph: {
              ...lgResult.materialized_graph,
              links: lgResult.materialized_graph.links.map((l, i) => ({ ...l, step: i })),
            },
            differentiation_traces: lgResult.runTrace?.differentiation_traces?.map(d => ({
              from_node: String((d as { from_node?: string }).from_node ?? ''),
              to_node: String((d as { to_node?: string }).to_node ?? ''),
            })),
          }
        } else {
          const logPath = await persistRunTrace(runTrace)
          if (logPath) execution.value.last_log_path = logPath
        }
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
          last_run_path: execution.value.last_run_path,
          lg_run: execution.value.lg_run,
          lg_step: execution.value.lg_step,
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
    const isLG = graph.value.library === 'LG'
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
      const runResult = isLG
        ? await executeLGSpec(graph.value, {
            runContext,
            externalInputs,
            onStep: ({ stepIndex, nodeId }) => {
              execution.value = {
                ...execution.value,
                status: 'running',
                current_node: nodeId,
                lg_step: stepIndex,
              }
            },
          })
        : await executeGraph(graph.value, {
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

