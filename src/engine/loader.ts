import { Graph } from './graph'
import { registry } from './registry'
import type { NodeInstance, Link, Workflow, ConditionalEdge, StateMachineConfig, LgEdge, WorkflowGroupMeta } from './types'
import { normalizeGraphNodeDimensions } from './node-geometry'
import { applyNoteCardLayoutAll } from './note-card-layout'
import { applyAutoLayout, applyTopologicalLayout } from './auto-layout'

/** 检测反馈回边 link id（WF data-flow） */
export function computeBackLinks(graph: Graph): Set<string> {
  const cached = (graph as Graph & { _backLinks?: Set<string> })._backLinks
  if (cached?.size) return cached

  const allIds = new Set(graph.nodes.map(n => n.id))

  const outgoing = new Map<string, Array<{ toNode: string; linkId: string }>>()
  for (const node of graph.nodes) outgoing.set(node.id, [])
  for (const link of graph.links) {
    if (!allIds.has(link.from_node) || !allIds.has(link.to_node)) continue
    outgoing.get(link.from_node)!.push({ toNode: link.to_node, linkId: link.id })
  }

  const backLinkIds = new Set<string>()
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  for (const id of allIds) color.set(id, WHITE)

  function dfs(id: string) {
    color.set(id, GRAY)
    for (const edge of outgoing.get(id) || []) {
      if (color.get(edge.toNode) === GRAY) {
        backLinkIds.add(edge.linkId)
      } else if (color.get(edge.toNode) === WHITE) {
        dfs(edge.toNode)
      }
    }
    color.set(id, BLACK)
  }
  for (const id of allIds) { if (color.get(id) === WHITE) dfs(id) }

  ;(graph as Graph & { _backLinks?: Set<string> })._backLinks = backLinkIds
  return backLinkIds
}

/** ReAct / RetryLoop back-edge labels in _lg_edges */
function isStepwiseBackEdge(edge: LgEdge): boolean {
  const label = edge.label ?? ''
  return label.includes('ReAct') || label.includes('回环') || label.includes('RetryLoop') || label.includes('回边')
}

function markStepwiseBackEdges(graph: Graph, lgEdges: LgEdge[]): void {
  const backLinkIds = (graph as Graph & { _backLinks?: Set<string> })._backLinks ?? new Set<string>()
  for (const edge of lgEdges) {
    if (isStepwiseBackEdge(edge)) {
      backLinkIds.add(`lg-spec:${edge.from}:${edge.to}:${edge.when ?? 'static'}`)
    }
  }
  ;(graph as Graph & { _backLinks?: Set<string> })._backLinks = backLinkIds
}

/**
 * Load a workflow JSON file (as written by an Agent) into a Graph.
 *
 * Supports two formats:
 * 1. PolarUI native format: { id, name, nodes: NodeInstance[], links: Link[] }
 * 2. API format (ComfyUI-style): { "1": { class_type, inputs }, "2": { class_type, inputs } }
 */
export function loadWorkflowJson(json: string): Graph {
  const data = JSON.parse(json)

  let graph: Graph
  const isStepwise = data._entry != null || Array.isArray(data._lg_edges)
  if (data.nodes && Array.isArray(data.nodes)) {
    graph = Graph.fromWorkflow(data as Workflow)
  } else {
    graph = fromApiFormat(data, (data._name as string) || 'Imported Workflow', {
      preserveNodeIds: isStepwise,
      lgEdges: Array.isArray(data._lg_edges) ? (data._lg_edges as LgEdge[]) : undefined,
    })
  }

  if (data._entry != null || Array.isArray(data._lg_edges)) {
    graph.lgEntry = String(data._entry ?? '1')
    graph.lgEdges = Array.isArray(data._lg_edges) ? (data._lg_edges as LgEdge[]) : []
  }

  // Parse state machine config if present
  if (data._execution === 'state_machine' && Array.isArray(data._edges)) {
    const idMap = (graph as Graph & { _idMap?: Map<string, string> })._idMap
    const edges: ConditionalEdge[] = (data._edges as Array<{ from: string; to: string; condition?: string }>).map(e => ({
      from: idMap?.get(e.from) ?? e.from,
      to: idMap?.get(e.to) ?? e.to,
      condition: e.condition,
    }))
    const startRaw: string = data._start ?? Object.keys(data).find(k => !k.startsWith('_')) ?? ''
    graph.stateMachine = {
      start: idMap?.get(startRaw) ?? startRaw,
      edges,
      max_iterations: data._max_iterations ?? undefined,
    }
  }

  if (graph.lgEdges?.length) {
    markStepwiseBackEdges(graph, graph.lgEdges)
  }

  if (Array.isArray(data._groups)) {
    graph.groups = (data._groups as WorkflowGroupMeta[]).map(g => ({
      ...g,
      node_ids: [...g.node_ids],
    }))
  }

  normalizeGraphNodeDimensions(graph.nodes)
  applyNoteCardLayoutAll(graph.nodes)

  return graph
}

const COL_SPACING = 300
const ROW_SPACING = 140

/** 按 Dagre 自动布局恢复工作流图默认排布（不改动连线与节点） */
export async function applyGraphAutoLayout(graph: Graph): Promise<void> {
  computeBackLinks(graph)
  await applyAutoLayout(graph)
}

/** 同步拓扑回退（headless / 无 ELK 环境） */
export function applyGraphTopologicalLayout(graph: Graph): void {
  applyTopologicalLayout(graph)
}

function isNodeEntry(key: string, value: unknown): value is { class_type: string; inputs: Record<string, unknown> } {
  if (key.startsWith('_')) return false
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.class_type === 'string'
}

function isWireRef(val: unknown): val is [string, number] {
  return Array.isArray(val) && val.length === 2 && typeof val[0] === 'string'
}

function collectWireRefIds(val: unknown, out: string[]): void {
  if (isWireRef(val)) {
    out.push(val[0])
  } else if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const v of Object.values(val as Record<string, unknown>)) {
      collectWireRefIds(v, out)
    }
  }
}

function collectWireRefs(val: unknown, out: Array<{ refId: string; fromSlot: number }>): void {
  if (isWireRef(val)) {
    out.push({ refId: val[0], fromSlot: val[1] })
  } else if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const v of Object.values(val as Record<string, unknown>)) {
      collectWireRefs(v, out)
    }
  }
}

function hasWireRefs(val: unknown): boolean {
  if (isWireRef(val)) return true
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return Object.values(val as Record<string, unknown>).some(v => hasWireRefs(v))
  }
  return false
}

function fromApiFormat(
  apiData: Record<string, unknown>,
  name: string,
  opts?: { preserveNodeIds?: boolean; lgEdges?: LgEdge[] },
): Graph {
  const preserveNodeIds = opts?.preserveNodeIds === true
  const graph = new Graph(name)

  const nodeEntries: [string, { class_type: string; inputs: Record<string, unknown> }][] = []
  for (const [id, value] of Object.entries(apiData)) {
    if (isNodeEntry(id, value)) {
      const node = value as { class_type: string; inputs: Record<string, unknown> }
      if (!node.inputs) node.inputs = {}
      nodeEntries.push([id, node])
    }
  }

  const allIds = nodeEntries.map(([id]) => id)
  const forwardDeps = new Map<string, string[]>()
  const backEdges = new Set<string>()

  for (const [id, node] of nodeEntries) {
    const inputRefs: string[] = []
    for (const val of Object.values(node.inputs)) {
      collectWireRefIds(val, inputRefs)
    }
    forwardDeps.set(id, inputRefs)
  }

  // Detect back edges via DFS to break cycles for topological ordering
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  allIds.forEach(id => color.set(id, WHITE))

  function dfs(id: string) {
    color.set(id, GRAY)
    for (const dep of (forwardDeps.get(id) || [])) {
      if (!color.has(dep)) continue
      if (color.get(dep) === GRAY) {
        backEdges.add(`${id}->${dep}`)
      } else if (color.get(dep) === WHITE) {
        dfs(dep)
      }
    }
    color.set(id, BLACK)
  }
  allIds.forEach(id => { if (color.get(id) === WHITE) dfs(id) })

  // Stepwise ReAct back edges from _lg_edges (for canvas / layout)
  const lgBackPairs = new Set<string>()
  const lgEdges = opts?.lgEdges
    ?? (Array.isArray(apiData._lg_edges) ? apiData._lg_edges as LgEdge[] : undefined)
  if (lgEdges) {
    for (const edge of lgEdges) {
      if (isStepwiseBackEdge(edge)) lgBackPairs.add(`${edge.from}->${edge.to}`)
    }
  }

  // Compute levels ignoring back edges
  const levels = new Map<string, number>()
  function getLevel(id: string, visited = new Set<string>()): number {
    if (levels.has(id)) return levels.get(id)!
    if (visited.has(id)) return 0
    visited.add(id)
    const d = (forwardDeps.get(id) || []).filter(dep =>
      !backEdges.has(`${id}->${dep}`)
    )
    const lvl = d.length === 0 ? 0 : Math.max(...d.map(dep => getLevel(dep, visited))) + 1
    levels.set(id, lvl)
    return lvl
  }

  for (const id of allIds) getLevel(id)

  const levelGroups = new Map<number, string[]>()
  for (const [id, lvl] of levels) {
    if (!levelGroups.has(lvl)) levelGroups.set(lvl, [])
    levelGroups.get(lvl)!.push(id)
  }

  const nodePositions = new Map<string, { x: number; y: number }>()
  for (const [lvl, ids] of levelGroups) {
    ids.forEach((id, idx) => {
      nodePositions.set(id, {
        x: 100 + lvl * COL_SPACING,
        y: 80 + idx * ROW_SPACING,
      })
    })
  }

  const idMap = new Map<string, string>()
  const backLinkPairs = new Set<string>()
  const skippedTypes = new Set<string>()
  const layoutKeys = new Map<string, string>()

  for (const [origId, nodeData] of nodeEntries) {
    const pos = nodePositions.get(origId) || { x: 100, y: 100 }
    const added = graph.addNode(nodeData.class_type, pos.x, pos.y, preserveNodeIds ? origId : undefined)
    if (added) {
      idMap.set(origId, added.id)
      layoutKeys.set(added.id, origId)
      const nonRefParams: Record<string, unknown> = {}
      const inputBindings: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(nodeData.inputs)) {
        if (!hasWireRefs(val)) {
          nonRefParams[key] = val
        } else if (val && typeof val === 'object' && !isWireRef(val)) {
          inputBindings[key] = val
        }
      }
      added.params = { ...added.params, ...((nodeData as { params?: Record<string, unknown> }).params ?? {}), ...nonRefParams }
      if (Object.keys(inputBindings).length > 0) {
        added.params._inputBindings = inputBindings
      }
    } else {
      skippedTypes.add(nodeData.class_type)
    }
  }

  if (skippedTypes.size > 0) {
    console.warn(`[PolarUI Loader] Skipped unregistered node types: ${[...skippedTypes].join(', ')}`)
  }

  for (const [origId, nodeData] of nodeEntries) {
    const def = registry.get(nodeData.class_type)
    if (!def) continue

    let slotIdx = 0
    for (const [key, val] of Object.entries(nodeData.inputs)) {
      if (isWireRef(val)) {
        const inputIdx = def.inputs.findIndex(inp => inp.name === key)
        const toSlot = inputIdx >= 0 ? inputIdx : slotIdx
        const fromNewId = idMap.get(val[0])
        const toNewId = idMap.get(origId)
        if (fromNewId && toNewId) {
          const link = graph.addLink(fromNewId, val[1], toNewId, toSlot)
          if (link && (backEdges.has(`${origId}->${val[0]}`) || lgBackPairs.has(`${val[0]}->${origId}`))) {
            backLinkPairs.add(link.id)
          }
        }
        slotIdx++
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        const refs: Array<{ refId: string; fromSlot: number }> = []
        collectWireRefs(val, refs)
        if (refs.length > 0) {
          const inputIdx = def.inputs.findIndex(inp => inp.name === key)
          const toSlot = inputIdx >= 0 ? inputIdx : slotIdx
          const first = refs[0]
          const fromNewId = idMap.get(first.refId)
          const toNewId = idMap.get(origId)
          if (fromNewId && toNewId) {
            const link = graph.addLink(fromNewId, first.fromSlot, toNewId, toSlot)
            if (link && (backEdges.has(`${origId}->${first.refId}`) || lgBackPairs.has(`${first.refId}->${origId}`))) {
              backLinkPairs.add(link.id)
            }
          }
          slotIdx++
        }
      }
    }
  }

  // Tag back-edge links for the canvas renderer
  ;(graph as Graph & { _backLinks?: Set<string>; _layoutKeys?: Map<string, string>; _idMap?: Map<string, string> })._backLinks = backLinkPairs
  ;(graph as Graph & { _layoutKeys?: Map<string, string> })._layoutKeys = layoutKeys
  ;(graph as Graph & { _idMap?: Map<string, string> })._idMap = idMap

  return graph
}
