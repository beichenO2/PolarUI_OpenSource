/**
 * Wire Nudging — separates overlapping parallel wire segments.
 *
 * After the orthogonal router produces paths, multiple wires may share the
 * same horizontal or vertical corridor.  This pass detects collinear
 * overlapping segments from *different* links and nudges them apart so each
 * wire is visually distinct.
 */
import type { Vec2 } from './node-geometry'
import { DEFAULT_WIRE_ROUTING_OPTIONS } from './node-geometry'

const NUDGE = DEFAULT_WIRE_ROUTING_OPTIONS.idealNudgingDistance
const EPS = 0.5

interface Seg {
  linkId: string
  segIdx: number
  dir: 'h' | 'v'
  fixed: number
  lo: number
  hi: number
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1
}

function fullOverlap(a: Seg, b: Seg): boolean {
  if (a.dir !== b.dir) return false
  if (Math.abs(a.fixed - b.fixed) > EPS) return false
  const overlapLo = Math.max(a.lo, b.lo)
  const overlapHi = Math.min(a.hi, b.hi)
  const minLen = Math.min(a.hi - a.lo, b.hi - b.lo)
  return overlapHi - overlapLo >= minLen - 1
}

function collectInteriorSegments(paths: Map<string, Vec2[]>): Seg[] {
  const segs: Seg[] = []
  for (const [linkId, pts] of paths) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (i === 0 || i === pts.length - 2) continue
      const a = pts[i], b = pts[i + 1]
      if (Math.abs(a.y - b.y) < EPS) {
        segs.push({ linkId, segIdx: i, dir: 'h', fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
      } else if (Math.abs(a.x - b.x) < EPS) {
        segs.push({ linkId, segIdx: i, dir: 'v', fixed: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
      }
    }
  }
  return segs
}

export function nudgeParallelSegments(
  paths: Map<string, Vec2[]>,
): Map<string, Vec2[]> {
  const segs = collectInteriorSegments(paths)

  const used = new Set<number>()
  const groups: Seg[][] = []

  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue
    const group: Seg[] = [segs[i]]
    used.add(i)
    for (let j = i + 1; j < segs.length; j++) {
      if (used.has(j)) continue
      const si = segs[i], sj = segs[j]
      if (sj.linkId === si.linkId) continue
      if (sj.dir !== si.dir) continue
      const overlaps = fullOverlap(si, sj)
        || (Math.abs(sj.fixed - si.fixed) <= NUDGE && rangeOverlap(si.lo, si.hi, sj.lo, sj.hi))
      if (!overlaps) continue
      group.push(sj)
      used.add(j)
    }
    if (group.length > 1) groups.push(group)
  }

  if (groups.length === 0) return paths

  const deltas = new Map<string, { segIdx: number; delta: number; dir: 'h' | 'v' }[]>()

  for (const group of groups) {
    group.sort((a, b) => a.fixed - b.fixed || a.lo - b.lo)
    const center = group.reduce((s, g) => s + g.fixed, 0) / group.length
    const span = (group.length - 1) * NUDGE
    for (let k = 0; k < group.length; k++) {
      const seg = group[k]
      const target = center - span / 2 + k * NUDGE
      const delta = target - seg.fixed
      if (Math.abs(delta) < 0.5) continue
      if (!deltas.has(seg.linkId)) deltas.set(seg.linkId, [])
      deltas.get(seg.linkId)!.push({ segIdx: seg.segIdx, delta, dir: seg.dir })
    }
  }

  const result = new Map<string, Vec2[]>()
  for (const [linkId, pts] of paths) {
    const d = deltas.get(linkId)
    if (!d || d.length === 0) {
      result.set(linkId, pts)
      continue
    }
    const np: Vec2[] = pts.map(p => ({ ...p }))
    for (const { segIdx, delta, dir } of d) {
      if (dir === 'h') {
        np[segIdx].y += delta
        np[segIdx + 1].y += delta
      } else {
        np[segIdx].x += delta
        np[segIdx + 1].x += delta
      }
    }
    result.set(linkId, np)
  }

  for (const [linkId, pts] of paths) {
    if (!result.has(linkId)) result.set(linkId, pts)
  }
  return result
}
