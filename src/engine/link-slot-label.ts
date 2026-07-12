import type { Link, NodeInstance } from './types'
import { describeLinkEndpoints } from './link-payload'
import { linkTouchesNode } from './link-hover'
import type { Vec2 } from './node-geometry'

/** 连线上展示的变量名：`outputSlot → inputSlot` */
export function formatLinkSlotLabel(link: Link, nodes: NodeInstance[]): string {
  const { outSlot, inSlot } = describeLinkEndpoints(link, nodes)
  return `${outSlot} → ${inSlot}`
}

export const WIRE_CHIP_ZOOM_THRESHOLD = 0.7
export const WIRE_CHIP_MAX_CHARS = 18

/** Midpoint chip: source slot, or `out→in` when names differ and fit. */
export function formatWireChipLabel(
  link: Link,
  nodes: NodeInstance[],
  maxChars = WIRE_CHIP_MAX_CHARS,
): string {
  const { outSlot, inSlot } = describeLinkEndpoints(link, nodes)
  if (outSlot === inSlot) return outSlot
  const pair = `${outSlot}→${inSlot}`
  if (pair.length <= maxChars) return pair
  return outSlot.length <= maxChars ? outSlot : `${outSlot.slice(0, maxChars - 1)}…`
}

export interface WireChipRect {
  x: number
  y: number
  w: number
  h: number
}

export function rectsIntersect(a: WireChipRect, b: WireChipRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Segment index containing the path midpoint (for perpendicular chip nudge). */
export function polylineMidpointSegmentIndex(pts: Vec2[]): number {
  if (pts.length < 2) return 0
  let total = 0
  const segLens: number[] = []
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    segLens.push(d)
    total += d
  }
  if (total <= 0) return Math.max(0, Math.floor(pts.length / 2) - 1)
  let half = total / 2
  for (let i = 0; i < segLens.length; i++) {
    if (half <= segLens[i]) return i
    half -= segLens[i]
  }
  return Math.max(0, segLens.length - 1)
}

export function pathNormalAtSegment(pts: Vec2[], segIndex: number): Vec2 {
  if (pts.length < 2) return { x: 0, y: -1 }
  const i = Math.min(Math.max(segIndex, 0), pts.length - 2)
  const dx = pts[i + 1].x - pts[i].x
  const dy = pts[i + 1].y - pts[i].y
  const len = Math.hypot(dx, dy) || 1
  return { x: -dy / len, y: dx / len }
}

/** Single-pass overlap mitigation: nudge later chips perpendicular to the wire. */
export function nudgeOverlappingWireChips(
  chips: Array<{ rect: WireChipRect; normal: Vec2 }>,
): void {
  for (let i = 1; i < chips.length; i++) {
    for (let j = 0; j < i; j++) {
      if (rectsIntersect(chips[i].rect, chips[j].rect)) {
        const shift = chips[i].rect.h
        chips[i].rect.x += chips[i].normal.x * shift
        chips[i].rect.y += chips[i].normal.y * shift
        break
      }
    }
  }
}

export function shouldShowLinkSlotLabel(
  link: Link,
  hoverComponentId: string | null,
  selectedLinkId: string | null,
): boolean {
  if (selectedLinkId === link.id) return true
  if (!hoverComponentId) return false
  return linkTouchesNode(link, hoverComponentId)
}

function pointAlongPath(pts: Vec2[], offset: number, fromEnd: boolean): Vec2 {
  if (pts.length < 2) return { ...(pts[0] ?? { x: 0, y: 0 }) }
  let remaining = offset
  if (fromEnd) {
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i + 1]
      const b = pts[i]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len <= 0) continue
      if (remaining <= len) {
        const t = remaining / len
        return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
      }
      remaining -= len
    }
    return { ...pts[0] }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len <= 0) continue
    if (remaining <= len) {
      const t = remaining / len
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
    }
    remaining -= len
  }
  return { ...pts[pts.length - 1] }
}

/** 距路径起点固定弧长 */
export function polylinePointNearSource(pts: Vec2[], offsetFromStart: number): Vec2 {
  return pointAlongPath(pts, offsetFromStart, false)
}

/** 距路径终点固定弧长（悬停目标组件一侧） */
export function polylinePointNearEnd(pts: Vec2[], offsetFromEnd: number): Vec2 {
  return pointAlongPath(pts, offsetFromEnd, true)
}

export interface NodeScreenBox {
  x: number
  y: number
  w: number
  h: number
}

export type WireLabelAlign = 'left' | 'right'

export interface WireLabelPlacement {
  x: number
  y: number
  /** left=标签右缘贴 x；right=标签左缘贴 x */
  align: WireLabelAlign
}

/** 标签锚点：靠近悬停端，标签边与组件边对齐（不压组件） */
export function linkLabelAnchor(
  link: Link,
  focusComponentId: string | null,
  screenPts: Vec2[],
  alongPx: number,
  normalPx: number,
  nodeBoxes?: { from?: NodeScreenBox; to?: NodeScreenBox },
  edgeGap = 6,
): WireLabelPlacement {
  const nearEnd = focusComponentId === link.to_node
  let anchor = nearEnd
    ? polylinePointNearEnd(screenPts, alongPx)
    : polylinePointNearSource(screenPts, alongPx)
  anchor = labelOffsetFromPath(anchor, screenPts, normalPx)

  const box = nearEnd ? nodeBoxes?.to : nodeBoxes?.from
  if (box) {
    const portY = anchor.y
    const yMin = box.y + 14
    const yMax = box.y + box.h - 14
    const y = Math.max(yMin, Math.min(yMax, portY))
    if (nearEnd) {
      return { x: box.x - edgeGap, y, align: 'left' }
    }
    return { x: box.x + box.w + edgeGap, y, align: 'right' }
  }
  return { x: anchor.x, y: anchor.y, align: nearEnd ? 'left' : 'right' }
}

/** 多个连线标签：保持最小间距，避免上下叠在一起 */
export function separateWireLabelPositions(
  labels: Array<{ screenX: number; screenY: number }>,
  minGap = 20,
): void {
  if (labels.length < 2) return
  labels.sort((a, b) => a.screenY - b.screenY || a.screenX - b.screenX)
  for (let i = 1; i < labels.length; i++) {
    const prev = labels[i - 1]
    const cur = labels[i]
    const dx = Math.abs(cur.screenX - prev.screenX)
    if (dx < 72 && cur.screenY - prev.screenY < minGap) {
      cur.screenY = prev.screenY + minGap
    }
  }
}

/** 沿路径法线外扩，避免标签压在组件或连线上 */
export function labelOffsetFromPath(mid: Vec2, pts: Vec2[], offsetPx: number): Vec2 {
  if (pts.length < 2) return { x: mid.x, y: mid.y - offsetPx }
  const seg = Math.min(Math.floor((pts.length - 1) / 2), pts.length - 2)
  const dx = pts[seg + 1].x - pts[seg].x
  const dy = pts[seg + 1].y - pts[seg].y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  return { x: mid.x + nx * offsetPx, y: mid.y + ny * offsetPx }
}

/** 折线路径中点（用于标签锚点） */
export function polylineMidpoint(pts: Vec2[]): Vec2 {
  if (pts.length === 0) return { x: 0, y: 0 }
  if (pts.length === 1) return { ...pts[0] }
  let total = 0
  const segLens: number[] = []
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    segLens.push(d)
    total += d
  }
  if (total <= 0) return { ...pts[Math.floor(pts.length / 2)] }
  let half = total / 2
  for (let i = 0; i < segLens.length; i++) {
    if (half <= segLens[i]) {
      const t = segLens[i] > 0 ? half / segLens[i] : 0
      return {
        x: pts[i].x + t * (pts[i + 1].x - pts[i].x),
        y: pts[i].y + t * (pts[i + 1].y - pts[i].y),
      }
    }
    half -= segLens[i]
  }
  return { ...pts[pts.length - 1] }
}
