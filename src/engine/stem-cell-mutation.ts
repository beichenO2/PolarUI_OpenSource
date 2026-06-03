/**
 * StemCell 真分化 — 写入当前 Graph.nodes / Graph.links（WF 权柄入口）
 */
import type { Graph } from './graph'
import type { NodeInstance } from './types'

export interface StemCellMutationResult {
  node_id: string
  class_type: string
  links_added: number
  nodes_removed: number
}

function parseAllowed(classTypes: string): Set<string> {
  return new Set(
    classTypes
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )
}

function pickClassType(
  allowed: Set<string>,
  signal: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const fromSignal = String(signal?.class_type ?? signal?.add_class_type ?? '').trim()
  if (fromSignal && allowed.has(fromSignal)) return fromSignal
  if (allowed.has(fallback)) return fallback
  return [...allowed][0] ?? 'LLM'
}

/**
 * 在权柄节点处向工作流写入结构变更（默认：新增一个 allowed 类型节点并接线）。
 * 可选 signal：{ class_type, remove_node_id }
 */
export function applyStemCellToGraph(
  graph: Graph,
  stemNode: NodeInstance,
  options: {
    allowedTypes: string
    signal?: Record<string, unknown>
  },
): StemCellMutationResult {
  const allowed = parseAllowed(options.allowedTypes)
  let nodesRemoved = 0
  const removeId = String(options.signal?.remove_node_id ?? '').trim()
  if (removeId && removeId !== stemNode.id) {
    if (graph.nodes.some(n => n.id === removeId)) {
      graph.removeNode(removeId)
      nodesRemoved = 1
    }
  }

  const pick = pickClassType(allowed, options.signal, 'LLM')
  const nodeId = `stem_${stemNode.id}_${Date.now()}`
  const offsetY = 140
  const added = graph.addNode(
    pick,
    stemNode.x + 32,
    stemNode.y + offsetY,
    nodeId,
  )
  if (!added) {
    throw new Error(`StemCell: cannot add node type "${pick}" (not in registry or palette)`)
  }

  let linksAdded = 0
  const link = graph.addLink(stemNode.id, 0, nodeId, 0)
  if (link) linksAdded = 1

  graph.updatedAt = Date.now()
  return {
    node_id: nodeId,
    class_type: pick,
    links_added: linksAdded,
    nodes_removed: nodesRemoved,
  }
}
