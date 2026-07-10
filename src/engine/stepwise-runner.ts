/**
 * stepwise-runner.ts — 步进单路径执行（_entry + _lg_edges 路由）
 *
 * 语义对齐 dist bundle S4t：逐步执行、条件边 when 匹配 branch、
 * lgAccumulatedState 跨步合并、ReAct 回环、步数上限。
 * ADR-014：每步从活图重读节点与 lgEdges；注入 context.mutateGraph。
 */
import type { Graph } from './graph'
import type { LgEdge, Workflow } from './types'
import {
  executeNode,
  type ExecutionContext,
  type ExecutionResult,
  type NodeTraceEntry,
} from './executor'
import { resolveWorkflowRole } from './role-protocol'
import type { ExecuteGraphOptions, ExecuteGraphResult } from './workflow-runner'
import { injectPipelineInputs } from './workflow-runner'
import {
  applyMutations,
  type MutationOp,
  type MutationPolicy,
} from './graph-mutation'

const MAX_STEPS = 64

export function isStepwiseGraph(graph: Graph): boolean {
  if (graph.lgEntry) return true
  return !!(graph.lgEdges && graph.lgEdges.length > 0)
}

/** Route next node via _lg_edges (static / conditional when=branch). */
export function routeLgEdges(
  fromNodeId: string,
  branch: string | undefined,
  edges: LgEdge[],
): string | null {
  const out = edges.filter(e => e.from === fromNodeId)
  if (out.length === 0) return null
  if (out.length === 1 && out[0].kind === 'static') return out[0].to
  if (branch) {
    const matched = out.find(e => e.kind === 'conditional' && e.when === branch)
    if (matched) return matched.to
  }
  return out.find(e => e.kind === 'conditional')?.to ?? out[0]?.to ?? null
}

export interface StepwiseRunResult extends ExecuteGraphResult {
  steps?: Array<{
    index: number
    node_id: string
    class_type: string
    routing?: { chosen: string; candidates: string[] }
    duration_ms: number
  }>
  materialized_graph?: { nodes: string[]; links: Array<{ from: string; to: string; when?: string }> }
}

function graphToWorkflow(graph: Graph): Workflow {
  return {
    id: graph.id,
    name: graph.name,
    nodes: graph.nodes.map(n => ({ ...n, params: { ...n.params } })),
    links: graph.links.map(l => ({ ...l })),
    created_at: graph.createdAt,
    updated_at: graph.updatedAt,
  }
}

/** Write mutation result back onto the live Graph (in-place array refs). */
function applyWorkflowToGraph(graph: Graph, wf: Workflow, applied: MutationOp[]): void {
  graph.nodes.length = 0
  graph.nodes.push(...wf.nodes)
  graph.links.length = 0
  graph.links.push(...wf.links)
  graph.updatedAt = wf.updated_at

  if (!graph.lgEdges) graph.lgEdges = []

  for (const op of applied) {
    if (op.op === 'add_link') {
      const { from_node, to_node } = op.link
      if (!graph.lgEdges.some(e => e.from === from_node && e.to === to_node)) {
        graph.lgEdges.push({ from: from_node, to: to_node, kind: 'static' })
      }
    } else if (op.op === 'remove_node') {
      graph.lgEdges = graph.lgEdges.filter(
        e => e.from !== op.node_id && e.to !== op.node_id,
      )
    }
  }
}

export async function executeStepwise(
  graph: Graph,
  opts: ExecuteGraphOptions = {},
): Promise<StepwiseRunResult> {
  if (opts.externalInputs && Object.keys(opts.externalInputs).length > 0) {
    injectPipelineInputs(graph, opts.externalInputs)
  }

  const apiFmt = graph.toApiFormat()
  const entryNodeId = graph.lgEntry ?? String((apiFmt as { _entry?: string })._entry ?? '1')
  // Seed lgEdges onto the live graph once; subsequent steps re-read graph.lgEdges (活引用).
  if (!graph.lgEdges) {
    graph.lgEdges = Array.isArray((apiFmt as { _lg_edges?: LgEdge[] })._lg_edges)
      ? (apiFmt as { _lg_edges: LgEdge[] })._lg_edges
      : []
  }

  const allResults = new Map<string, ExecutionResult>()
  const steps: NonNullable<StepwiseRunResult['steps']> = []
  const materialized = { nodes: [] as string[], links: [] as Array<{ from: string; to: string; when?: string }> }

  const resolved = resolveWorkflowRole(
    graph.nodes.map(n => ({ class_type: n.class_type, params: n.params })),
  )

  const runId = `step_${Date.now()}`
  const startedAt = new Date().toISOString()
  const nodeTraces: NodeTraceEntry[] = []

  let lgAccumulatedState: Record<string, unknown> = {
    ...(opts as ExecuteGraphOptions & { initialState?: Record<string, unknown> }).initialState ?? {},
    messages: [],
    ...(opts.runContext?.conversation_id ? { conversation_id: opts.runContext.conversation_id } : {}),
    ...(opts.runContext?.user_id ? { user_id: opts.runContext.user_id } : {}),
    ...(opts.runContext?.user_message ? { task: opts.runContext.user_message } : {}),
  }

  const ctx: ExecutionContext = {
    getNodeOutput: (nodeId: string, slotIndex: number) => {
      const r = allResults.get(nodeId)
      if (!r) return undefined
      const keys = Object.keys(r.outputs)
      return r.outputs[keys[slotIndex] ?? keys[0]]
    },
    allResults,
    links: graph.links,
    agentId: opts.agentId ?? resolved.agentId,
    role: opts.role ?? resolved.role,
    graph,
    runContext: opts.runContext,
    onStreamChunk: opts.onStreamChunk,
    mutationCount: 0,
    runTrace: {
      run_id: runId,
      workflow_id: graph.name,
      started_at: startedAt,
      status: 'running',
      trigger: 'manual',
      node_traces: nodeTraces,
      loop_traces: [],
      usage_traces: [],
      differentiation_traces: [],
    },
  }

  ctx.mutateGraph = (ops: MutationOp[], policy: MutationPolicy = {}) => {
    const wf = graphToWorkflow(graph)
    const result = applyMutations(wf, ops, policy)
    applyWorkflowToGraph(graph, result.workflow, result.applied)
    ctx.mutationCount = (ctx.mutationCount ?? 0) + result.applied.length
    return {
      applied: result.applied,
      rejected: result.rejected,
      audit: result.audit,
    }
  }

  const graphIdMap = (graph as Graph & { _idMap?: Map<string, string> })._idMap
  if (graphIdMap) {
    ;(ctx as ExecutionContext & { _idMap?: Map<string, string> })._idMap = graphIdMap
  }

  let currentNodeId: string | null = entryNodeId
  let stepIndex = 0
  const unhealthy_nodes: ExecuteGraphResult['unhealthy_nodes'] = []

  while (currentNodeId && stepIndex < MAX_STEPS) {
    // Live lookup — StemCell may have mutated graph.nodes mid-run.
    const node = graph.nodes.find(n => n.id === currentNodeId)
    if (!node) break

    materialized.nodes.push(currentNodeId)

    const stepCtx = ctx as ExecutionContext & { lgAccumulatedState?: Record<string, unknown> }
    stepCtx.lgAccumulatedState = lgAccumulatedState

    opts.onNodeStart?.({ nodeId: currentNodeId, classType: node.class_type, attempt: stepIndex + 1 })

    const t0 = Date.now()
    const result = await executeNode(node, stepCtx)
    result.duration_ms = result.duration_ms || Date.now() - t0

    allResults.set(currentNodeId, result)
    nodeTraces.push({
      node_id: currentNodeId,
      class_type: node.class_type,
      mode: 'stepwise',
      duration_ms: result.duration_ms,
      ...(result.error ? { error: result.error } : {}),
    })

    if (result.error) {
      unhealthy_nodes.push({
        node_id: currentNodeId,
        class_type: node.class_type,
        error: result.error,
      })
    }

    if (result.outputs.state && typeof result.outputs.state === 'object') {
      lgAccumulatedState = {
        ...lgAccumulatedState,
        ...(result.outputs.state as Record<string, unknown>),
      }
    }

    const branch = typeof result.outputs.branch === 'string' ? result.outputs.branch : undefined
    steps.push({
      index: stepIndex,
      node_id: currentNodeId,
      class_type: node.class_type,
      routing: branch ? { chosen: branch, candidates: [] } : undefined,
      duration_ms: result.duration_ms,
    })

    opts.onNodeDone?.({
      nodeId: currentNodeId,
      classType: node.class_type,
      result,
      attempt: stepIndex + 1,
      duration_ms: result.duration_ms,
    })

    if (node.class_type === 'LG_End' || node.class_type === 'Output') {
      break
    }

    // Re-read live lgEdges after possible StemCell mutation.
    const liveEdges = graph.lgEdges ?? []
    const nextId = routeLgEdges(currentNodeId, branch, liveEdges)
    if (nextId) {
      materialized.links.push({ from: currentNodeId, to: nextId, when: branch })
    }
    currentNodeId = nextId
    stepIndex++
  }

  if (ctx.runTrace) {
    ctx.runTrace.finished_at = new Date().toISOString()
    ctx.runTrace.status = unhealthy_nodes.length ? 'error' : 'completed'
  }

  return {
    results: allResults,
    merged_output: lgAccumulatedState,
    unhealthy_nodes,
    runTrace: ctx.runTrace,
    steps,
    materialized_graph: materialized,
  }
}
