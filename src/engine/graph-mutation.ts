/**
 * graph-mutation.ts — Pure-function graph mutation kernel (ADR-014 D1).
 *
 * Applies MutationOp[] under MutationPolicy; never mutates the input workflow.
 * Violating ops go to `rejected` without aborting the batch.
 */
import type { Link, NodeInstance, Workflow } from './types'

export type MutationOp =
  | { op: 'add_node'; node: { class_type: string; params?: Record<string, unknown>; x?: number; y?: number; id?: string } }
  | { op: 'remove_node'; node_id: string }
  | { op: 'add_link'; link: { from_node: string; from_slot: number; to_node: string; to_slot: number; id?: string } }
  | { op: 'remove_link'; link_id: string }
  | { op: 'set_param'; node_id: string; key: string; value: unknown }

export interface MutationPolicy {
  allowedTypes?: string[]
  maxNodes?: number
  protectedNodeIds?: string[]
}

export interface MutationReject {
  op: MutationOp
  reason: string
}

export interface MutationResult {
  workflow: Workflow
  applied: MutationOp[]
  rejected: MutationReject[]
  audit: string[]
}

const DEFAULT_WIDTH = 200
const DEFAULT_HEIGHT = 80

function deepCloneWorkflow(wf: Workflow): Workflow {
  return structuredClone(wf)
}

function existingIds(nodes: NodeInstance[], links: Link[]): Set<string> {
  const ids = new Set<string>()
  for (const n of nodes) ids.add(n.id)
  for (const l of links) ids.add(l.id)
  return ids
}

function allocId(preferred: string | undefined, used: Set<string>, prefix: string): string {
  if (preferred && !used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  let n = 1
  let candidate = preferred ? `${preferred}_${n}` : `${prefix}${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = preferred ? `${preferred}_${n}` : `${prefix}${n}`
  }
  used.add(candidate)
  return candidate
}

function findNode(nodes: NodeInstance[], id: string): NodeInstance | undefined {
  return nodes.find(n => n.id === id)
}

function applyOne(
  wf: Workflow,
  op: MutationOp,
  policy: MutationPolicy,
  usedIds: Set<string>,
): { ok: true; audit: string } | { ok: false; reason: string } {
  switch (op.op) {
    case 'add_node': {
      const classType = op.node.class_type
      if (!classType) {
        return { ok: false, reason: 'add_node: class_type required' }
      }
      if (policy.allowedTypes && !policy.allowedTypes.includes(classType)) {
        return { ok: false, reason: `add_node: class_type "${classType}" not in allowedTypes whitelist` }
      }
      if (policy.maxNodes != null && wf.nodes.length >= policy.maxNodes) {
        return { ok: false, reason: `add_node: maxNodes budget exceeded (${policy.maxNodes})` }
      }
      const id = allocId(op.node.id, usedIds, 'n')
      const node: NodeInstance = {
        id,
        class_type: classType,
        x: op.node.x ?? 0,
        y: op.node.y ?? 0,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        params: { ...(op.node.params ?? {}) },
      }
      wf.nodes.push(node)
      wf.updated_at = Date.now()
      return { ok: true, audit: `add_node ${id} (${classType})` }
    }

    case 'remove_node': {
      const nodeId = op.node_id
      if (policy.protectedNodeIds?.includes(nodeId)) {
        return { ok: false, reason: `remove_node: node "${nodeId}" is protected` }
      }
      if (!findNode(wf.nodes, nodeId)) {
        return { ok: false, reason: `remove_node: node "${nodeId}" not found` }
      }
      wf.nodes = wf.nodes.filter(n => n.id !== nodeId)
      const before = wf.links.length
      wf.links = wf.links.filter(l => l.from_node !== nodeId && l.to_node !== nodeId)
      usedIds.delete(nodeId)
      wf.updated_at = Date.now()
      return {
        ok: true,
        audit: `remove_node ${nodeId} (cascaded ${before - wf.links.length} links)`,
      }
    }

    case 'add_link': {
      const { from_node, from_slot, to_node, to_slot } = op.link
      const from = findNode(wf.nodes, from_node)
      const to = findNode(wf.nodes, to_node)
      if (!from) {
        return { ok: false, reason: `add_link: from_node "${from_node}" not found` }
      }
      if (!to) {
        return { ok: false, reason: `add_link: to_node "${to_node}" not found` }
      }
      if (typeof from_slot !== 'number' || from_slot < 0) {
        return { ok: false, reason: `add_link: from_slot out of range` }
      }
      if (typeof to_slot !== 'number' || to_slot < 0) {
        return { ok: false, reason: `add_link: to_slot out of range` }
      }
      const id = allocId(op.link.id, usedIds, 'l')
      const link: Link = {
        id,
        from_node,
        from_slot,
        to_node,
        to_slot,
      }
      wf.links.push(link)
      wf.updated_at = Date.now()
      return { ok: true, audit: `add_link ${id} (${from_node}:${from_slot}→${to_node}:${to_slot})` }
    }

    case 'remove_link': {
      const idx = wf.links.findIndex(l => l.id === op.link_id)
      if (idx < 0) {
        return { ok: false, reason: `remove_link: link "${op.link_id}" not found` }
      }
      wf.links.splice(idx, 1)
      usedIds.delete(op.link_id)
      wf.updated_at = Date.now()
      return { ok: true, audit: `remove_link ${op.link_id}` }
    }

    case 'set_param': {
      const node = findNode(wf.nodes, op.node_id)
      if (!node) {
        return { ok: false, reason: `set_param: node "${op.node_id}" not found` }
      }
      node.params = { ...node.params, [op.key]: op.value }
      wf.updated_at = Date.now()
      return { ok: true, audit: `set_param ${op.node_id}.${op.key}` }
    }

    default: {
      const _exhaustive: never = op
      return { ok: false, reason: `unknown op: ${JSON.stringify(_exhaustive)}` }
    }
  }
}

/**
 * Apply a batch of mutation ops under policy. Input workflow is never mutated.
 */
export function applyMutations(
  workflow: Workflow,
  ops: MutationOp[],
  policy: MutationPolicy = {},
): MutationResult {
  const wf = deepCloneWorkflow(workflow)
  const applied: MutationOp[] = []
  const rejected: MutationReject[] = []
  const audit: string[] = []
  const usedIds = existingIds(wf.nodes, wf.links)

  for (const op of ops) {
    const result = applyOne(wf, op, policy, usedIds)
    if (result.ok) {
      applied.push(op)
      audit.push(result.audit)
    } else {
      rejected.push({ op, reason: result.reason })
      audit.push(`REJECT: ${result.reason}`)
    }
  }

  return { workflow: wf, applied, rejected, audit }
}
