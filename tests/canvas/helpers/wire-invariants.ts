/**
 * Wire routing invariant checks — shared by wire-routing.test.ts and stats script.
 */
import type { NodeInstance, Link } from '../../../src/engine/types'
import type { Vec2, AABB } from '../../../src/engine/node-geometry'
import {
  linkAnchor,
  nodeDrawBounds,
  isNoteCardNode,
  DEFAULT_WIRE_ROUTING_OPTIONS,
} from '../../../src/engine/node-geometry'

const BUFFER = DEFAULT_WIRE_ROUTING_OPTIONS.shapeBufferDistance
const EPS = 0.5

export interface InvariantViolation {
  invariant: string
  linkId?: string
  detail: string
}

export interface RoutingStats {
  nodeCrossings: number
  fullOverlaps: number
  crossings: number
}

function obstacleBoxes(nodes: NodeInstance[]): AABB[] {
  return nodes
    .filter(n => !isNoteCardNode(n))
    .map(n => {
      const b = nodeDrawBounds(n)
      return { x: b.x - BUFFER, y: b.y - BUFFER, w: b.w + BUFFER * 2, h: b.h + BUFFER * 2 }
    })
}

function segIntersectsBox(
  x1: number, y1: number, x2: number, y2: number,
  box: AABB,
): boolean {
  const loX = Math.min(x1, x2), hiX = Math.max(x1, x2)
  const loY = Math.min(y1, y2), hiY = Math.max(y1, y2)
  const bx2 = box.x + box.w, by2 = box.y + box.h
  if (Math.abs(y1 - y2) < EPS) {
    const y = y1
    if (y <= box.y || y >= by2) return false
    return loX < bx2 && hiX > box.x
  }
  if (Math.abs(x1 - x2) < EPS) {
    const x = x1
    if (x <= box.x || x >= bx2) return false
    return loY < by2 && hiY > box.y
  }
  return false
}

/** I1 — segments must not pass through node obstacle boxes (with routing buffer). */
export function checkI1NoNodeCrossings(
  nodes: NodeInstance[],
  links: Link[],
  paths: Map<string, Vec2[]>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const boxes = obstacleBoxes(nodes)
  const nodeById = new Map(nodes.map(n => [n.id, n]))

  for (const link of links) {
    const pts = paths.get(link.id)
    if (!pts || pts.length < 2) continue
    const fromNode = nodeById.get(link.from_node)
    const toNode = nodeById.get(link.to_node)
    if (!fromNode || !toNode) continue

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      for (let oi = 0; oi < boxes.length; oi++) {
        const node = nodes.filter(n => !isNoteCardNode(n))[oi]
        if (node.id === link.from_node || node.id === link.to_node) continue
        if (segIntersectsBox(a.x, a.y, b.x, b.y, boxes[oi])) {
          violations.push({
            invariant: 'I1',
            linkId: link.id,
            detail: `segment ${i} crosses node ${node.id}`,
          })
        }
      }
    }
  }
  return violations
}

/** I2 — orthogonal path; endpoints match port anchors. */
export function checkI2OrthogonalEndpoints(
  nodes: NodeInstance[],
  links: Link[],
  paths: Map<string, Vec2[]>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const nodeById = new Map(nodes.map(n => [n.id, n]))

  for (const link of links) {
    const pts = paths.get(link.id)
    if (!pts || pts.length < 2) {
      violations.push({ invariant: 'I2', linkId: link.id, detail: 'path too short' })
      continue
    }
    const fromNode = nodeById.get(link.from_node)
    const toNode = nodeById.get(link.to_node)
    if (!fromNode || !toNode) continue

    const expectedFrom = linkAnchor(fromNode, link.from_slot, 'out')
    const expectedTo = linkAnchor(toNode, link.to_slot, 'in')
    if (Math.hypot(pts[0].x - expectedFrom.x, pts[0].y - expectedFrom.y) > 1) {
      violations.push({ invariant: 'I2', linkId: link.id, detail: 'start not at source port' })
    }
    const last = pts[pts.length - 1]
    if (Math.hypot(last.x - expectedTo.x, last.y - expectedTo.y) > 1) {
      violations.push({ invariant: 'I2', linkId: link.id, detail: 'end not at target port' })
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y)
      if (dx > EPS && dy > EPS) {
        violations.push({ invariant: 'I2', linkId: link.id, detail: `non-orthogonal segment ${i}` })
      }
    }
  }
  return violations
}

interface SegKey {
  linkId: string
  segIdx: number
  horizontal: boolean
  fixed: number
  lo: number
  hi: number
}

function interiorSegments(linkId: string, pts: Vec2[]): SegKey[] {
  const segs: SegKey[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    if (i === 0 || i === pts.length - 2) continue
    const a = pts[i], b = pts[i + 1]
    if (Math.abs(a.y - b.y) < EPS) {
      segs.push({ linkId, segIdx: i, horizontal: true, fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
    } else if (Math.abs(a.x - b.x) < EPS) {
      segs.push({ linkId, segIdx: i, horizontal: false, fixed: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
    }
  }
  return segs
}

function segmentsFullyOverlap(a: SegKey, b: SegKey): boolean {
  if (a.horizontal !== b.horizontal) return false
  if (Math.abs(a.fixed - b.fixed) > EPS) return false
  const overlapLo = Math.max(a.lo, b.lo)
  const overlapHi = Math.min(a.hi, b.hi)
  const minLen = Math.min(a.hi - a.lo, b.hi - b.lo)
  return overlapHi - overlapLo >= minLen - 1
}

/** I3 — same output slot fan-out: no full overlap outside shared trunk (first interior segment). */
export function checkI3FanOutSeparation(
  links: Link[],
  paths: Map<string, Vec2[]>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const groups = new Map<string, Link[]>()
  for (const link of links) {
    const key = `${link.from_node}:${link.from_slot}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(link)
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue
    const allSegs: SegKey[] = []
    for (const link of group) {
      const pts = paths.get(link.id)
      if (!pts) continue
      allSegs.push(...interiorSegments(link.id, pts))
    }
    for (let i = 0; i < allSegs.length; i++) {
      for (let j = i + 1; j < allSegs.length; j++) {
        const a = allSegs[i], b = allSegs[j]
        if (a.linkId === b.linkId) continue
        if (segmentsFullyOverlap(a, b)) {
          violations.push({
            invariant: 'I3',
            linkId: a.linkId,
            detail: `full overlap with ${b.linkId} on ${a.horizontal ? 'H' : 'V'}@${a.fixed}`,
          })
        }
      }
    }
  }
  return violations
}

/** I4 — backward / loop edges must not fully overlap each other. */
export function checkI4BackwardSeparation(
  links: Link[],
  paths: Map<string, Vec2[]>,
  backLinks: Set<string>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const backward = links.filter(l => backLinks.has(l.id))
  if (backward.length <= 1) return violations

  const allSegs: SegKey[] = []
  for (const link of backward) {
    const pts = paths.get(link.id)
    if (!pts) continue
    allSegs.push(...interiorSegments(link.id, pts))
  }
  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      const a = allSegs[i], b = allSegs[j]
      if (a.linkId === b.linkId) continue
      if (segmentsFullyOverlap(a, b)) {
        violations.push({
          invariant: 'I4',
          linkId: a.linkId,
          detail: `backward overlap with ${b.linkId}`,
        })
      }
    }
  }
  return violations
}

/** I5 — deterministic routing. */
export function checkI5Deterministic(
  run1: Map<string, Vec2[]>,
  run2: Map<string, Vec2[]>,
): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  if (run1.size !== run2.size) {
    violations.push({ invariant: 'I5', detail: 'path count differs' })
    return violations
  }
  for (const [linkId, pts1] of run1) {
    const pts2 = run2.get(linkId)
    if (!pts2 || pts1.length !== pts2.length) {
      violations.push({ invariant: 'I5', linkId, detail: 'waypoint count differs' })
      continue
    }
    for (let i = 0; i < pts1.length; i++) {
      if (Math.abs(pts1[i].x - pts2[i].x) > EPS || Math.abs(pts1[i].y - pts2[i].y) > EPS) {
        violations.push({ invariant: 'I5', linkId, detail: `waypoint ${i} differs` })
        break
      }
    }
  }
  return violations
}

export function countFullOverlaps(links: Link[], paths: Map<string, Vec2[]>): number {
  const allSegs: SegKey[] = []
  for (const link of links) {
    const pts = paths.get(link.id)
    if (!pts) continue
    allSegs.push(...interiorSegments(link.id, pts))
  }
  let count = 0
  for (let i = 0; i < allSegs.length; i++) {
    for (let j = i + 1; j < allSegs.length; j++) {
      if (allSegs[i].linkId === allSegs[j].linkId) continue
      if (segmentsFullyOverlap(allSegs[i], allSegs[j])) count++
    }
  }
  return count
}

export function computeRoutingStats(
  nodes: NodeInstance[],
  links: Link[],
  paths: Map<string, Vec2[]>,
  crossings: number,
): RoutingStats {
  return {
    nodeCrossings: checkI1NoNodeCrossings(nodes, links, paths).length,
    fullOverlaps: countFullOverlaps(links, paths),
    crossings,
  }
}
