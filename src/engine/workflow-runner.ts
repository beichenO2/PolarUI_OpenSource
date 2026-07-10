/**
 * workflow-runner.ts — 共享工作流图执行（拓扑序 + executeNode / 状态机）
 */
import type { Graph } from './graph'
import type { NodeInstance } from './types'
import { executeNode, type ExecutionContext, type ExecutionResult, type NodeTraceEntry, normalizeLoopItems } from './executor'
import { resolveWorkflowRole } from './role-protocol'
import { computeBackLinks } from './loader'
import { executeStateMachine } from './state-machine-runner'
import { executeStepwise, isStepwiseGraph } from './stepwise-runner'

export interface ExecuteGraphOptions {
  agentId?: string
  role?: 'master' | 'slave'
  skipClassTypes?: Set<string>
  onStreamChunk?: (nodeId: string, chunk: string) => void
  onNodeStart?: (payload: { nodeId: string; classType: string; attempt: number }) => void
  onNodeDone?: (payload: { nodeId: string; classType: string; result: ExecutionResult; attempt: number; duration_ms: number }) => void
  onNodeSkipped?: (payload: { nodeId: string; classType: string; reason: string }) => void
  /** 多轮 Chat：conversation_id / user_message 等 */
  runContext?: import('./executor').RunContext
  /** 注入 PromptInput / WorkingMemory / StaticData 占位符 */
  externalInputs?: Record<string, unknown>
}

export interface ExecuteGraphResult {
  results: Map<string, ExecutionResult>
  merged_output?: unknown
  unhealthy_nodes: { node_id: string; class_type: string; error: string }[]
  runTrace?: import('./executor').RunTraceEnvelope
}

/** Collect downstream nodes from a branch root, stopping at merge nodes. */
export function collectBranchNodes(
  graph: Graph,
  startNodeId: string,
  mergeNodeIds: Set<string>,
): Set<string> {
  const branch = new Set<string>()
  const queue = [startNodeId]
  while (queue.length) {
    const id = queue.shift()!
    if (mergeNodeIds.has(id) || branch.has(id)) continue
    branch.add(id)
    for (const link of graph.links) {
      if (link.from_node === id) queue.push(link.to_node)
    }
  }
  return branch
}

/** After Condition: skip inactive branch (from_slot 0=true, 1=false). */
export function markInactiveConditionBranches(
  graph: Graph,
  conditionNodeId: string,
  result: boolean,
  mergeNodeIds: Set<string>,
): Set<string> {
  const skipped = new Set<string>()
  for (const link of graph.links) {
    if (link.from_node !== conditionNodeId) continue
    const inactive = result ? link.from_slot === 1 : link.from_slot === 0
    if (!inactive) continue
    for (const id of collectBranchNodes(graph, link.to_node, mergeNodeIds)) {
      skipped.add(id)
    }
  }
  return skipped
}

/** After Switch: skip all branches except the matched slot. */
export function markInactiveSwitchBranches(
  graph: Graph,
  switchNodeId: string,
  matchedSlot: number,
  mergeNodeIds: Set<string>,
): Set<string> {
  const skipped = new Set<string>()
  for (const link of graph.links) {
    if (link.from_node !== switchNodeId) continue
    if (link.from_slot === matchedSlot) continue
    for (const id of collectBranchNodes(graph, link.to_node, mergeNodeIds)) {
      skipped.add(id)
    }
  }
  return skipped
}

export function topologicalSort(graph: Graph): string[] {
  const visited = new Set<string>()
  const result: string[] = []

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return
    visited.add(nodeId)

    const inputLinks = graph.getNodeInputLinks(nodeId)
    for (const link of inputLinks) {
      visit(link.from_node)
    }
    result.push(nodeId)
  }

  for (const node of graph.nodes) {
    visit(node.id)
  }
  return result
}

/** 将 Pipeline 外部输入注入 PromptInput / StaticData 占位符 */
export function injectPipelineInputs(
  graph: Graph,
  externalInputs: Record<string, unknown>
): void {
  const fallback = externalInputs.brief ?? externalInputs.topic ?? externalInputs.input ?? externalInputs.query

  for (const node of graph.nodes) {
    if (node.class_type === 'PromptInput') {
      let text = String(node.params.prompt_text ?? node.params.content ?? '')
      for (const [k, v] of Object.entries(externalInputs)) {
        if (v !== undefined && v !== null) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
      }
      if (fallback !== undefined && fallback !== null) {
        text = text.replace(/\{brief\}/g, String(fallback))
        text = text.replace(/\{input\}/g, String(fallback))
        text = text.replace(/\{query\}/g, String(fallback))
        text = text.replace(/\{topic\}/g, String(fallback))
      }
      node.params.prompt_text = text
      node.params.content = text
    }
    if (node.class_type === 'StaticData' && typeof node.params.value === 'string') {
      let val = String(node.params.value)
      for (const [k, v] of Object.entries(externalInputs)) {
        if (v !== undefined && v !== null) {
          val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), JSON.stringify(v))
        }
      }
      node.params.value = val
    }
    if (node.class_type === 'CheckupEventInbox' && externalInputs.event !== undefined) {
      node.params.event = externalInputs.event
    }
    if (node.class_type === 'WorkingMemory') {
      if (externalInputs.conversation_id != null) {
        node.params.conversation_id = String(externalInputs.conversation_id)
      }
      if (externalInputs.user_id != null) {
        node.params.user_id = String(externalInputs.user_id)
      }
      const msg = externalInputs.message ?? externalInputs.user_message
      if (msg != null) {
        node.params.new_message = String(msg)
      }
    }
  }
}

function getMaxRetries(graph: Graph): number {
  const rl = graph.nodes.find(n => n.class_type === 'RetryLoop')
  return Number(rl?.params.max_retries ?? 7)
}

function graphPassed(allResults: Map<string, ExecutionResult>, graph: Graph): boolean {
  for (const node of graph.nodes) {
    if (node.class_type === 'Validator') {
      if (allResults.get(node.id)?.outputs.passed === true) return true
    }
    if (node.class_type === 'RetryLoop') {
      if (allResults.get(node.id)?.outputs.passed === true) return true
    }
  }
  return false
}

function graphExhausted(allResults: Map<string, ExecutionResult>, graph: Graph): boolean {
  for (const node of graph.nodes) {
    if (node.class_type === 'RetryLoop' && allResults.get(node.id)?.outputs.exhausted === true) {
      return true
    }
  }
  return false
}

async function runForLoopExpansion(
  graph: Graph,
  forNode: NodeInstance,
  items: unknown[],
  ctx: ExecutionContext,
  allResults: Map<string, ExecutionResult>,
  mergeNodeIds: Set<string>,
): Promise<Set<string>> {
  const bodyNodeIds = new Set<string>()
  for (const link of graph.links) {
    if (link.from_node !== forNode.id) continue
    for (const id of collectBranchNodes(graph, link.to_node, mergeNodeIds)) {
      bodyNodeIds.add(id)
    }
  }

  const bodyOrder = topologicalSort(graph).filter(id => bodyNodeIds.has(id))
  const collected: unknown[] = []
  const llmNodes = graph.nodes.filter(n => bodyNodeIds.has(n.id) && n.class_type === 'LLM')

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    allResults.set(forNode.id, {
      outputs: {
        current_item: item,
        index,
        results: [...collected],
        items: [...collected],
        count: collected.length,
      },
      duration_ms: 0,
    })

    for (const nodeId of bodyOrder) {
      const node = graph.nodes.find(n => n.id === nodeId)
      if (!node) continue
      const result = await executeNode(node, ctx)
      allResults.set(nodeId, result)
      ctx.runTrace?.node_traces.push({
        node_id: nodeId,
        class_type: node.class_type,
        mode: 'topology',
        duration_ms: result.duration_ms ?? 0,
        loop_index: index,
        ...(result.error ? { error: result.error } : {}),
      })
    }

    const lastLlm = llmNodes[llmNodes.length - 1]
    if (lastLlm) {
      const r = allResults.get(lastLlm.id)
      collected.push(r?.outputs?.response ?? r?.outputs?.result ?? null)
    } else {
      collected.push(item)
    }
  }

  allResults.set(forNode.id, {
    outputs: {
      current_item: items[items.length - 1] ?? null,
      index: Math.max(0, items.length - 1),
      results: collected,
      items: collected,
      count: collected.length,
    },
    duration_ms: 0,
  })

  return bodyNodeIds
}

async function runForwardPass(
  graph: Graph,
  ctx: ExecutionContext,
  allResults: Map<string, ExecutionResult>,
  skip: Set<string>,
  mergeNodeIds: Set<string>,
  attempt: number,
  hooks?: Pick<ExecuteGraphOptions, 'onNodeStart' | 'onNodeDone' | 'onNodeSkipped'>,
): Promise<Set<string>> {
  const skippedNodes = new Set<string>()
  const forLoopBodyNodes = new Set<string>()
  const sorted = topologicalSort(graph)

  for (const node of graph.nodes) {
    if (node.class_type === 'RetryLoop') {
      node.params._attempt = attempt
    }
  }

  for (const nodeId of sorted) {
    const node = graph.nodes.find(n => n.id === nodeId)
    if (!node) continue
    if (skip.has(node.class_type) || skippedNodes.has(nodeId) || forLoopBodyNodes.has(nodeId)) {
      if (!allResults.has(nodeId)) {
        allResults.set(nodeId, { outputs: { skipped: true }, duration_ms: 0 })
      }
      const reason = skip.has(node.class_type) ? 'class_skip' : skippedNodes.has(nodeId) ? 'branch_skip' : 'loop_body'
      hooks?.onNodeSkipped?.({ nodeId, classType: node.class_type, reason })
      continue
    }

    if (node.class_type === 'ForLoop') {
      const itemsLink = ctx.links.find(l => l.to_node === nodeId && l.to_slot === 0)
      const itemsRaw = itemsLink ? ctx.getNodeOutput(itemsLink.from_node, itemsLink.from_slot) : undefined
      let items = normalizeLoopItems(itemsRaw)
      const maxItems = Number(node.params.max_items ?? node.params.max_iterations ?? 0)
      if (maxItems > 0) items = items.slice(0, maxItems)
      if (items.length === 0) {
        allResults.set(nodeId, {
          outputs: { current_item: null, results: [], count: 0 },
          duration_ms: 0,
          error: 'ForLoop: items is empty',
        })
        continue
      }
      const bodyIds = await runForLoopExpansion(graph, node, items, ctx, allResults, mergeNodeIds)
      for (const id of bodyIds) forLoopBodyNodes.add(id)
      continue
    }

    hooks?.onNodeStart?.({ nodeId, classType: node.class_type, attempt })
    const t0 = Date.now()
    const result = await executeNode(node, ctx)
    const duration_ms = Date.now() - t0
    result.duration_ms = result.duration_ms || duration_ms
    hooks?.onNodeDone?.({ nodeId, classType: node.class_type, result, attempt, duration_ms: result.duration_ms })
    allResults.set(nodeId, result)
    ctx.runTrace?.node_traces.push({
      node_id: nodeId,
      class_type: node.class_type,
      mode: 'topology',
      duration_ms: result.duration_ms ?? 0,
      ...(result.error ? { error: result.error } : {}),
    })

    if (node.class_type === 'Condition') {
      const branch = markInactiveConditionBranches(
        graph,
        nodeId,
        Boolean(result.outputs.result),
        mergeNodeIds,
      )
      for (const id of branch) skippedNodes.add(id)
    }

    if (node.class_type === 'Switch') {
      const matched = Number(result.outputs.matched_slot ?? result.outputs.active_branch ?? 0)
      const branch = markInactiveSwitchBranches(
        graph,
        nodeId,
        matched,
        mergeNodeIds,
      )
      for (const id of branch) skippedNodes.add(id)
    }
  }
  return skippedNodes
}

export async function executeGraph(
  graph: Graph,
  opts: ExecuteGraphOptions = {}
): Promise<ExecuteGraphResult> {
  // Dispatch: state machine mode if graph has stateMachine config
  if (graph.stateMachine) {
    return executeStateMachine(graph, graph.stateMachine, opts)
  }

  // Dispatch: stepwise single-path (_entry + _lg_edges)
  if (isStepwiseGraph(graph)) {
    return executeStepwise(graph, opts)
  }

  const skip = opts.skipClassTypes ?? new Set(['NoteCard'])
  const allResults = new Map<string, ExecutionResult>()

  if (opts.externalInputs && Object.keys(opts.externalInputs).length > 0) {
    injectPipelineInputs(graph, opts.externalInputs)
  }
  const mergeNodeIds = new Set(
    graph.nodes.filter(n =>
      n.class_type === 'CheckupReport' ||
      n.class_type === 'Output' ||
      n.class_type === 'Merge'
    ).map(n => n.id),
  )

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

  const graphIdMap = (graph as Graph & { _idMap?: Map<string, string> })._idMap
  if (graphIdMap) {
    ;(ctx as ExecutionContext & { _idMap?: Map<string, string> })._idMap = graphIdMap
  }

  const backLinks = computeBackLinks(graph)
  const maxAttempts = backLinks.size > 0 ? getMaxRetries(graph) : 1

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      ctx.allResults = allResults
    }
    await runForwardPass(graph, ctx, allResults, skip, mergeNodeIds, attempt, {
      onNodeStart: opts.onNodeStart,
      onNodeDone: opts.onNodeDone,
      onNodeSkipped: opts.onNodeSkipped,
    })
    if (backLinks.size === 0) break
    if (graphPassed(allResults, graph) || graphExhausted(allResults, graph)) break
    if (attempt >= maxAttempts) break
  }

  // Remove duplicate node traces from multi-pass — keep last occurrence per node
  if (ctx.runTrace && maxAttempts > 1) {
    const seen = new Map<string, NodeTraceEntry>()
    for (const t of ctx.runTrace.node_traces) seen.set(t.node_id, t)
    ctx.runTrace.node_traces = [...seen.values()]
  }

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
    const strategy = String(outputNodes[0]?.params?.merge_strategy ?? 'concat')
    const contents = outputNodes
      .map(n => allResults.get(n.id)?.outputs?.content)
      .filter(v => v !== undefined)
    if (strategy === 'first') {
      merged_output = contents[0]
    } else if (strategy === 'concat') {
      merged_output = contents.map(String).join('\n\n---\n\n')
    } else if (strategy === 'json_merge') {
      merged_output = contents.reduce(
        (acc, c) => ({
          ...(acc as object),
          ...(typeof c === 'object' && c ? (c as object) : { value: c }),
        }),
        {}
      )
    } else {
      merged_output = contents[contents.length - 1]
    }
  } else if (outputNodes.length === 1) {
    merged_output = allResults.get(outputNodes[0].id)?.outputs?.content
  }

  if (ctx.runTrace) {
    ctx.runTrace.finished_at = new Date().toISOString()
    ctx.runTrace.status = unhealthy_nodes.length ? 'error' : 'completed'
  }

  return { results: allResults, merged_output, unhealthy_nodes, runTrace: ctx.runTrace }
}

export function collectPipelineOutputs(
  graph: Graph,
  results: Map<string, ExecutionResult>
): Record<string, unknown> {
  const def = graph.nodes.find(n => n.class_type === 'Output')
  const outputs: Record<string, unknown> = {}

  if (def) {
    const r = results.get(def.id)
    if (r?.outputs?.content !== undefined) outputs.output = r.outputs.content
  }

  for (const node of graph.nodes) {
    if (node.class_type !== 'Output') continue
    const r = results.get(node.id)
    if (!r) continue
    for (const [k, v] of Object.entries(r.outputs)) {
      outputs[k] = v
    }
  }

  return outputs
}
