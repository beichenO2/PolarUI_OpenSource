/**
 * state-machine-runner.ts — 状态机执行引擎
 *
 * 替代拓扑排序的线性执行，支持有环图、条件路由、运行时决策。
 * 灵感来源：LangGraph (状态机 + conditional edges)
 */
import type { Graph } from './graph'
import type { NodeInstance, ConditionalEdge, StateMachineConfig } from './types'
import { executeNode, type ExecutionContext, type ExecutionResult, type NodeTraceEntry } from './executor'
import type { ExecuteGraphOptions, ExecuteGraphResult } from './workflow-runner'
import { resolveWorkflowRole } from './role-protocol'
import { injectPipelineInputs } from './workflow-runner'

const END_TOKEN = '__END__'
const DEFAULT_MAX_ITERATIONS = 200

/** Evaluate a condition expression against node outputs + state machine context */
function evaluateCondition(expr: string, outputs: Record<string, unknown>, smCtx?: { visits: Map<string, number>; iteration: number }): boolean {
  try {
    const fn = new Function('outputs', 'visits', 'iteration', `return (${expr})`)
    return Boolean(fn(outputs, smCtx?.visits ?? new Map(), smCtx?.iteration ?? 0))
  } catch {
    return false
  }
}

/** Route: given outgoing edges from a node, determine the next node */
function route(
  edges: ConditionalEdge[],
  outputs: Record<string, unknown>,
  smCtx?: { visits: Map<string, number>; iteration: number },
): string {
  const unconditional = edges.find(e => !e.condition)

  if (edges.length === 1 && unconditional) {
    return unconditional.to
  }

  for (const edge of edges) {
    if (edge.condition && evaluateCondition(edge.condition, outputs, smCtx)) {
      return edge.to
    }
  }

  if (unconditional) return unconditional.to
  return END_TOKEN
}

/** Compile-time validation of a state machine workflow */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validateStateMachineWorkflow(
  graph: Graph,
  config: StateMachineConfig,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const nodeIds = new Set(graph.nodes.map(n => n.id))

  if (!nodeIds.has(config.start)) {
    errors.push(`_start node "${config.start}" not found in graph`)
  }

  for (const edge of config.edges) {
    if (!nodeIds.has(edge.from)) errors.push(`edge.from "${edge.from}" not found`)
    if (!nodeIds.has(edge.to)) errors.push(`edge.to "${edge.to}" not found`)
  }

  // Reachability: BFS from start
  const reachable = new Set<string>()
  const queue = [config.start]
  while (queue.length) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of config.edges) {
      if (edge.from === id && !reachable.has(edge.to)) {
        queue.push(edge.to)
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.class_type === 'NoteCard') continue
    if (!reachable.has(node.id)) {
      warnings.push(`node "${node.id}" (${node.class_type}) is unreachable from start`)
    }
  }

  // Termination: at least one path reaches Output
  const outputNodes = graph.nodes.filter(n => n.class_type === 'Output')
  const hasPathToOutput = outputNodes.some(n => reachable.has(n.id))
  if (!hasPathToOutput) {
    errors.push('no reachable path to any Output node')
  }

  // Condition coverage warning
  const nodeEdgeMap = new Map<string, ConditionalEdge[]>()
  for (const edge of config.edges) {
    const arr = nodeEdgeMap.get(edge.from) ?? []
    arr.push(edge)
    nodeEdgeMap.set(edge.from, arr)
  }
  for (const [nodeId, outEdges] of nodeEdgeMap) {
    if (outEdges.length > 1 && outEdges.every(e => e.condition)) {
      warnings.push(`node "${nodeId}": all outgoing edges are conditional — may deadlock if none match`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Execute a workflow graph using state machine semantics */
export async function executeStateMachine(
  graph: Graph,
  config: StateMachineConfig,
  opts: ExecuteGraphOptions = {},
): Promise<ExecuteGraphResult> {
  const maxIter = config.max_iterations ?? DEFAULT_MAX_ITERATIONS
  const allResults = new Map<string, ExecutionResult>()

  if (opts.externalInputs && Object.keys(opts.externalInputs).length > 0) {
    injectPipelineInputs(graph, opts.externalInputs)
  }

  const resolved = resolveWorkflowRole(
    graph.nodes.map(n => ({ class_type: n.class_type, params: n.params }))
  )

  const runId = `run_${Date.now()}`
  const startedAt = new Date().toISOString()
  const nodeTraces: NodeTraceEntry[] = []

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
    runContext: opts.runContext,
    onStreamChunk: opts.onStreamChunk,
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

  // Build edge lookup
  const edgesByFrom = new Map<string, ConditionalEdge[]>()
  for (const edge of config.edges) {
    const arr = edgesByFrom.get(edge.from) ?? []
    arr.push(edge)
    edgesByFrom.set(edge.from, arr)
  }

  let currentNodeId = config.start
  let iteration = 0
  const visitCounts = new Map<string, number>()

  while (currentNodeId !== END_TOKEN && iteration < maxIter) {
    iteration++
    visitCounts.set(currentNodeId, (visitCounts.get(currentNodeId) ?? 0) + 1)

    const node = graph.nodes.find(n => n.id === currentNodeId)
    if (!node) {
      break
    }

    opts.onNodeStart?.({ nodeId: currentNodeId, classType: node.class_type, attempt: iteration })

    const t0 = Date.now()
    const result = await executeNode(node, ctx)
    const duration_ms = Date.now() - t0
    result.duration_ms = result.duration_ms || duration_ms

    // Inject _attempt (visit count for this specific node) into outputs for condition evaluation
    result.outputs._attempt = visitCounts.get(currentNodeId) ?? 1

    allResults.set(currentNodeId, result)

    opts.onNodeDone?.({ nodeId: currentNodeId, classType: node.class_type, result, attempt: iteration, duration_ms: result.duration_ms })

    nodeTraces.push({
      node_id: currentNodeId,
      class_type: node.class_type,
      mode: 'topology',
      duration_ms: result.duration_ms,
      ...(result.error ? { error: result.error } : {}),
    })

    // If this is an Output node, we're done
    if (node.class_type === 'Output') {
      break
    }

    // Route to next node
    const outEdges = edgesByFrom.get(currentNodeId) ?? []
    if (outEdges.length === 0) {
      break
    }

    const smCtx = { visits: visitCounts, iteration }
    currentNodeId = route(outEdges, result.outputs, smCtx)
  }

  // Collect results
  const unhealthy_nodes: ExecuteGraphResult['unhealthy_nodes'] = []
  for (const [nodeId, result] of allResults) {
    if (result.error) {
      const node = graph.nodes.find(n => n.id === nodeId)
      unhealthy_nodes.push({
        node_id: nodeId,
        class_type: node?.class_type ?? '?',
        error: result.error,
      })
    }
  }

  const outputNodes = graph.nodes.filter(n => n.class_type === 'Output')
  let merged_output: unknown
  if (outputNodes.length > 1) {
    const contents = outputNodes
      .map(n => allResults.get(n.id)?.outputs?.content)
      .filter(v => v !== undefined)
    merged_output = contents.map(String).join('\n\n---\n\n')
  } else if (outputNodes.length === 1) {
    merged_output = allResults.get(outputNodes[0].id)?.outputs?.content
  }

  if (ctx.runTrace) {
    ctx.runTrace.finished_at = new Date().toISOString()
    ctx.runTrace.status = unhealthy_nodes.length ? 'error' : 'completed'
  }

  return { results: allResults, merged_output, unhealthy_nodes, runTrace: ctx.runTrace }
}
