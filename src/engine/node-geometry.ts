/**
 * 节点几何 SSOT — 绘制、命中测试、libavoid 障碍盒同源。
 * 对齐 avoid-edge-routing-example 的 edgeToNodeSpacing / handle 布局。
 */
import type { Link, NodeInstance } from './types'
import { registry } from './registry'

export const SLOT_RADIUS = 6
/** 260531：画布字号 +50% 后同步抬高标题区与正文区 */
export const HEADER_HEIGHT = 42
export const CONTENT_AREA_HEIGHT = 108
export const SLOT_HEIGHT = 24
export const SLOT_PADDING = 14
export const NODE_BOTTOM_PAD = 10
export const NODE_DEFAULT_WIDTH = 200
export const COLLISION_MARGIN = 16
/** Dify-style compact end card — single input, no content preview band */
export const OUTPUT_CARD_WIDTH = 176
export const WIRE_LOOP_MARGIN = 32
export const BACKWARD_LINK_LANE_SPACING = 14
export const DEFAULT_LINK_LINE_WIDTH = 1.5

/** 线碰撞管半径（中心线到边缘）— 平行线段中心距须 ≥ 2×radius + lineWidth */
export const WIRE_COLLISION_RADIUS = 7

/** 默认布线参数 — 对齐 avoid-edge-routing-example SettingsPanel */
export const DEFAULT_WIRE_ROUTING_OPTIONS = {
  shapeBufferDistance: 16,
  idealNudgingDistance: 14,
  cornerRadius: 0,
  reverseApproachOvershoot: 72,
  stubSize: 40,
} as const

/** 平行线最小中心距（px）— libavoid nudging + 后处理 resolveWireCollisions 共用 */
export function wireCollisionClearance(): number {
  return WIRE_COLLISION_RADIUS * 2 + DEFAULT_LINK_LINE_WIDTH
}

export const NODE_COLLISION_PAD = DEFAULT_WIRE_ROUTING_OPTIONS.shapeBufferDistance

export interface Vec2 { x: number; y: number }
export interface AABB { x: number; y: number; w: number; h: number }

export function calcNodeHeight(inputCount: number, outputCount: number): number {
  const slotCount = Math.max(inputCount, outputCount)
  return HEADER_HEIGHT + CONTENT_AREA_HEIGHT + SLOT_PADDING + slotCount * SLOT_HEIGHT + NODE_BOTTOM_PAD
}

/** Compact end card — header + one input row (aligns with Dify End node). */
export function calcOutputNodeHeight(inputCount = 1): number {
  return HEADER_HEIGHT + SLOT_PADDING + inputCount * SLOT_HEIGHT + NODE_BOTTOM_PAD
}

export function normalizeGraphNodeDimensions(nodes: NodeInstance[]): void {
  for (const node of nodes) {
    if (node.class_type === 'NoteCard') continue
    if (isOutputTerminalNode(node)) {
      normalizeOutputTerminalSize(node)
      continue
    }
    const def = registry.get(node.class_type)
    if (!def) continue
    node.width = NODE_DEFAULT_WIDTH
    node.height = calcNodeHeight(def.inputs.length, def.outputs.length)
  }
}

export function wireExtraNodeClearance(): number {
  return DEFAULT_LINK_LINE_WIDTH / 2 + DEFAULT_WIRE_ROUTING_OPTIONS.cornerRadius
}

export function wireEdgeClearance(): number {
  return wireCollisionClearance()
}

export function nodeDrawBounds(n: NodeInstance): AABB {
  return { x: n.x, y: n.y, w: n.width, h: n.height }
}

export function nodeRoutingObstacleBounds(n: NodeInstance): AABB {
  const b = nodeDrawBounds(n)
  const pad = NODE_COLLISION_PAD
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
}

export function isOutputTerminalNode(node: NodeInstance | undefined): boolean {
  return node?.class_type === 'Output'
}

export function normalizeOutputTerminalSize(node: NodeInstance): void {
  if (!isOutputTerminalNode(node)) return
  const def = registry.get(node.class_type)
  const inputCount = def?.inputs.length ?? 1
  node.width = OUTPUT_CARD_WIDTH
  node.height = calcOutputNodeHeight(inputCount)
}

export function normalizeAllOutputTerminals(nodes: NodeInstance[]): void {
  for (const node of nodes) normalizeOutputTerminalSize(node)
}

/** 布局引擎用的节点尺寸（含安全边距） */
export const LAYOUT_NODE_PAD = 24
export const MIN_NODE_GAP = 40

export function layoutNodeDimensions(node: NodeInstance): { w: number; h: number } {
  const b = nodeDrawBounds(node)
  return { w: b.w + LAYOUT_NODE_PAD * 2, h: b.h + LAYOUT_NODE_PAD * 2 }
}

export function nodesOverlap(a: NodeInstance, b: NodeInstance, margin = 0): boolean {
  const ba = nodeDrawBounds(a)
  const bb = nodeDrawBounds(b)
  return ba.x - margin < bb.x + bb.w
    && ba.x + ba.w + margin > bb.x
    && ba.y - margin < bb.y + bb.h
    && ba.y + ba.h + margin > bb.y
}

export function countNodeOverlaps(nodes: NodeInstance[], margin = 0): number {
  let n = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!isNoteCardNode(nodes[i]) && !isNoteCardNode(nodes[j]) && nodesOverlap(nodes[i], nodes[j], margin)) {
        n++
      }
    }
  }
  return n
}

export function slotGraphY(node: NodeInstance, slot: number): number {
  const contentOffset = isOutputTerminalNode(node) ? 0 : CONTENT_AREA_HEIGHT
  return node.y + HEADER_HEIGHT + contentOffset + SLOT_PADDING + slot * SLOT_HEIGHT
}

export function linkAnchor(node: NodeInstance, slot: number, side: 'in' | 'out'): Vec2 {
  const b = nodeDrawBounds(node)
  return {
    x: side === 'out' ? b.x + b.w : b.x,
    y: slotGraphY(node, slot),
  }
}

export function isNoteCardNode(node: NodeInstance | undefined): boolean {
  return node?.class_type === 'NoteCard'
}

export function isBackwardLink(
  link: Link,
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
): boolean {
  if (backLinks?.has(link.id)) return true
  if (backLinks && !backLinks.has(link.id)) return false
  const fromNode = nodes.find(n => n.id === link.from_node)
  const toNode = nodes.find(n => n.id === link.to_node)
  if (!fromNode || !toNode) return false
  const outX = fromNode.x + fromNode.width
  const inX = toNode.x
  return outX > inX
}

export function shouldRouteOrthogonal(
  link: Link,
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
): boolean {
  const fromNode = nodes.find(n => n.id === link.from_node)
  const toNode = nodes.find(n => n.id === link.to_node)
  if (!fromNode || !toNode) return false
  if (isNoteCardNode(fromNode) || isNoteCardNode(toNode)) return false
  return !isBackwardLink(link, nodes, backLinks)
}

export function computeBackwardLinkLanes(
  links: Link[],
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
): Map<string, number> {
  const backward = links.filter(l => isBackwardLink(l, nodes, backLinks))
  backward.sort((a, b) => {
    const fromA = nodes.find(n => n.id === a.from_node)
    const fromB = nodes.find(n => n.id === b.from_node)
    const toA = nodes.find(n => n.id === a.to_node)
    const toB = nodes.find(n => n.id === b.to_node)
    const keyA = `${fromA?.x ?? 0}:${toA?.x ?? 0}:${a.from_slot}:${a.to_slot}`
    const keyB = `${fromB?.x ?? 0}:${toB?.x ?? 0}:${b.from_slot}:${b.to_slot}`
    return keyA.localeCompare(keyB) || a.id.localeCompare(b.id)
  })
  const lanes = new Map<string, number>()
  backward.forEach((link, index) => lanes.set(link.id, index))
  return lanes
}

export function backwardLoopDropY(nodes: NodeInstance[], laneIndex: number): number {
  const baseBottom = nodes.length > 0
    ? Math.max(...nodes.map(n => {
      const b = nodeDrawBounds(n)
      return b.y + b.h
    }))
    : 0
  return baseBottom + WIRE_LOOP_MARGIN + 32 + laneIndex * BACKWARD_LINK_LANE_SPACING
}
