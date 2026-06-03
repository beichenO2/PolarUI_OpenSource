import type { Link, NodeInstance } from './types'
import type { ExecutionState } from './types'
import { registry } from './registry'
import { isRoutingBranchNode, routingOutletName } from './branch-outputs'

/** 稳定指纹：相同 payload → 同色连线 */
export function payloadFingerprint(value: unknown): string {
  if (value === undefined) return '__undefined__'
  if (value === null) return '__null__'
  if (typeof value === 'string') return `s:${value}`
  if (typeof value === 'number' || typeof value === 'boolean') return `p:${String(value)}`
  try {
    return `j:${JSON.stringify(value)}`
  } catch {
    return `x:${String(value)}`
  }
}

/** 读取连线上游输出槽在上次执行中的值 */
export function getLinkPayload(
  link: Link,
  nodes: NodeInstance[],
  results?: ExecutionState['results'],
): unknown {
  if (!results) return undefined
  const fromNode = nodes.find(n => n.id === link.from_node)
  if (!fromNode) return undefined
  const def = registry.get(fromNode.class_type)
  const slotName = fromNode && isRoutingBranchNode(fromNode.class_type)
    ? routingOutletName(fromNode, link.from_slot)
    : def?.outputs[link.from_slot]?.name
  if (!slotName) return undefined
  const nodeResult = results[link.from_node]
  if (!nodeResult || nodeResult.error) return undefined
  return nodeResult.outputs?.[slotName]
}

export function formatLinkPayloadPreview(value: unknown, maxLen = 4000): string {
  if (value === undefined) return '（尚无执行数据 — 运行工作流后可查看）'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value.length > maxLen ? value.slice(0, maxLen) + '…' : value
  }
  try {
    const text = JSON.stringify(value, null, 2)
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
  } catch {
    return String(value)
  }
}

export function describeLinkEndpoints(
  link: Link,
  nodes: NodeInstance[],
): {
  fromLabel: string
  toLabel: string
  outSlot: string
  inSlot: string
} {
  const fromNode = nodes.find(n => n.id === link.from_node)
  const toNode = nodes.find(n => n.id === link.to_node)
  const fromDef = fromNode ? registry.get(fromNode.class_type) : undefined
  const toDef = toNode ? registry.get(toNode.class_type) : undefined
  return {
    fromLabel: fromDef?.display_name ?? link.from_node,
    toLabel: toDef?.display_name ?? link.to_node,
    outSlot: fromNode && isRoutingBranchNode(fromNode.class_type)
      ? routingOutletName(fromNode, link.from_slot)
      : (fromDef?.outputs[link.from_slot]?.name ?? `#${link.from_slot}`),
    inSlot: toDef?.inputs[link.to_slot]?.name ?? `#${link.to_slot}`,
  }
}
