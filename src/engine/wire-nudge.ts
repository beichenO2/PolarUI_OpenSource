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

interface Seg {
  linkId: string
  segIdx: number
  dir: 'h' | 'v'
  fixed: number   // y for H, x for V
  lo: number
  hi: number
}

function rangeOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1
}

export function nudgeParallelSegments(
  paths: Map<string, Vec2[]>,
): Map<string, Vec2[]> {
  const segs: Seg[] = []

  for (const [linkId, pts] of paths) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (i === 0 || i === pts.length - 2) continue
      const a = pts[i], b = pts[i + 1]
      if (Math.abs(a.y - b.y) < 0.5) {
        segs.push({ linkId, segIdx: i, dir: 'h', fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
      } else if (Math.abs(a.x - b.x) < 0.5) {
        segs.push({ linkId, segIdx: i, dir: 'v', fixed: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
      }
    }
  }

  // Group overlapping parallel segments from different links
  const used = new Set<number>()
  const groups: Seg[][] = []

  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue
    const group: Seg[] = [segs[i]]
    used.add(i)
    for (let j = i + 1; j < segs.length; j++) {
      if (used.has(j)) continue
      const si = segs[i], sj = segs[j]
      if (sj.dir !== si.dir) continue
      if (sj.linkId === si.linkId) continue
      if (Math.abs(sj.fixed - si.fixed) > NUDGE) continue
      if (!rangeOverlap(si.lo, si.hi, sj.lo, sj.hi)) continue
      group.push(sj)
      used.add(j)
    }
    if (group.length > 1) groups.push(group)
  }

  if (groups.length === 0) return paths

  // Compute per-segment deltas
  const deltas = new Map<string, { segIdx: number; delta: number; dir: 'h' | 'v' }[]>()

  for (const group of groups) {
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

  // Apply deltas — nudging a segment also adjusts its connecting turns
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
