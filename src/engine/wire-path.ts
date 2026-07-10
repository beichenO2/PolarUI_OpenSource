/**
 * Orthogonal wire paths — L-shape fallback and obstacle-aware perimeter routing.
 */
import type { Vec2, AABB } from './node-geometry'
import { DEFAULT_WIRE_ROUTING_OPTIONS } from './node-geometry'

export const WIRE_STUB = DEFAULT_WIRE_ROUTING_OPTIONS.stubSize * 2

const STUB = DEFAULT_WIRE_ROUTING_OPTIONS.stubSize
const BUFFER = DEFAULT_WIRE_ROUTING_OPTIONS.shapeBufferDistance

function inside(o: AABB, x: number, y: number): boolean {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h
}

function hSegBlocked(y: number, x1: number, x2: number, obs: AABB[]): boolean {
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2)
  for (const o of obs) {
    if (y <= o.y || y >= o.y + o.h) continue
    if (lo < o.x + o.w && hi > o.x) return true
  }
  return false
}

function vSegBlocked(x: number, y1: number, y2: number, obs: AABB[]): boolean {
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2)
  for (const o of obs) {
    if (x <= o.x || x >= o.x + o.w) continue
    if (lo < o.y + o.h && hi > o.y) return true
  }
  return false
}

function pathClear(pts: Vec2[], obs: AABB[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    if (Math.abs(a.y - b.y) < 0.5) {
      if (hSegBlocked(a.y, a.x, b.x, obs)) return false
    } else if (Math.abs(a.x - b.x) < 0.5) {
      if (vSegBlocked(a.x, a.y, b.y, obs)) return false
    } else {
      return false
    }
  }
  return true
}

function simplify(pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts
  const out: Vec2[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], curr = pts[i], next = pts[i + 1]
    const colX = Math.abs(prev.x - curr.x) < 0.5 && Math.abs(curr.x - next.x) < 0.5
    const colY = Math.abs(prev.y - curr.y) < 0.5 && Math.abs(curr.y - next.y) < 0.5
    if (!colX && !colY) out.push(curr)
  }
  out.push(pts[pts.length - 1])
  return out
}

/** 正交 L 路径（无绕障，仅 legacy 预览） */
export function buildFallbackPath(from: Vec2, to: Vec2): Vec2[] {
  const gap = STUB
  if (Math.abs(from.y - to.y) < 0.5 && to.x > from.x + gap) return [from, to]
  if (to.x <= from.x + gap) {
    const outX = from.x + gap
    const pastX = to.x - gap
    if (Math.abs(from.y - to.y) < 8) {
      return [from, { x: outX, y: from.y }, { x: pastX, y: from.y }, to]
    }
    return [from, { x: outX, y: from.y }, { x: outX, y: to.y }, { x: pastX, y: to.y }, to]
  }
  const midX = from.x + Math.max(gap, (to.x - from.x) * 0.5)
  return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to]
}

function buildExitPrefix(from: Vec2, obs: AABB[]): Vec2[] {
  const outX = from.x + STUB
  if (!hSegBlocked(from.y, from.x, outX, obs)) {
    return [from, { x: outX, y: from.y }]
  }
  for (const mag of [32, 64, 96, 128, 192, 256, 320]) {
    for (const sign of [-1, 1]) {
      const y = from.y + sign * mag
      if (vSegBlocked(from.x, from.y, y, obs)) continue
      if (hSegBlocked(y, from.x, outX, obs)) continue
      if (obs.some(o => inside(o, outX, y))) continue
      return [from, { x: from.x, y }, { x: outX, y }]
    }
  }
  return [from, { x: outX, y: from.y }]
}

function buildEntrySuffix(to: Vec2, obs: AABB[]): Vec2[] {
  const inX = to.x - STUB
  if (!hSegBlocked(to.y, inX, to.x, obs)) {
    return [{ x: inX, y: to.y }, to]
  }
  for (const mag of [32, 64, 96, 128, 192, 256, 320]) {
    for (const sign of [-1, 1]) {
      const y = to.y + sign * mag
      if (vSegBlocked(to.x, to.y, y, obs)) continue
      if (hSegBlocked(y, inX, to.x, obs)) continue
      if (obs.some(o => inside(o, inX, y))) continue
      return [{ x: inX, y }, { x: to.x, y }, to]
    }
  }
  return [{ x: inX, y: to.y }, to]
}

/**
 * A* 超限时的保底路径：沿障碍物外沿正交绕障，满足 I1。
 */
export function buildObstacleAvoidingPath(
  from: Vec2,
  to: Vec2,
  obstacles: AABB[],
): Vec2[] {
  const prefix = buildExitPrefix(from, obstacles)
  const suffix = buildEntrySuffix(to, obstacles)
  const exit = prefix[prefix.length - 1]
  const entry = suffix[0]

  let minTop = Math.min(exit.y, entry.y)
  let maxBot = Math.max(exit.y, entry.y)
  for (const o of obstacles) {
    minTop = Math.min(minTop, o.y)
    maxBot = Math.max(maxBot, o.y + o.h)
  }

  const channelCandidates = [
    minTop - BUFFER * 2,
    maxBot + BUFFER * 2,
    minTop - BUFFER * 4,
    maxBot + BUFFER * 4,
    minTop - BUFFER * 6,
    maxBot + BUFFER * 6,
  ]

  for (const channelY of channelCandidates) {
    const candidate = simplify([
      ...prefix,
      { x: exit.x, y: channelY },
      { x: entry.x, y: channelY },
      ...suffix,
    ])
    if (pathClear(candidate, obstacles)) return candidate
  }

  const farY = maxBot + BUFFER * 8
  return simplify([
    ...prefix,
    { x: exit.x, y: farY },
    { x: entry.x, y: farY },
    ...suffix,
  ])
}

/** Adjust stub X when the default stub point sits inside an obstacle. */
export function safeStubX(ax: number, ay: number, dx: number, obs: AABB[]): number {
  for (let d = dx; Math.abs(d) >= 4; d *= 0.5) {
    const x = ax + d
    if (!obs.some(o => inside(o, x, ay))) return x
  }
  return ax
}
