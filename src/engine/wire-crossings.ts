/**
 * Wire Crossing Detection — finds H-V intersection points for PCB-style bridges.
 *
 * Convention: horizontal wire bridges OVER vertical wire (semicircle arc upward).
 * The vertical wire gets a visual gap at the crossing point.
 */
import type { Vec2 } from './node-geometry'

export interface CrossingPoint {
  x: number
  y: number
  /** Link whose horizontal segment draws the bridge arc */
  overLinkId: string
  /** Link whose vertical segment gets the gap */
  underLinkId: string
}

interface Seg {
  linkId: string
  p1: Vec2
  p2: Vec2
}

export function detectCrossings(paths: Map<string, Vec2[]>): CrossingPoint[] {
  const hSegs: Seg[] = []
  const vSegs: Seg[] = []

  for (const [linkId, pts] of paths) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1]
      if (Math.abs(p1.y - p2.y) < 0.5) {
        hSegs.push({ linkId, p1, p2 })
      } else if (Math.abs(p1.x - p2.x) < 0.5) {
        vSegs.push({ linkId, p1, p2 })
      }
    }
  }

  const crossings: CrossingPoint[] = []
  for (const h of hSegs) {
    const hy = h.p1.y
    const hMin = Math.min(h.p1.x, h.p2.x)
    const hMax = Math.max(h.p1.x, h.p2.x)

    for (const v of vSegs) {
      if (v.linkId === h.linkId) continue
      const vx = v.p1.x
      const vMin = Math.min(v.p1.y, v.p2.y)
      const vMax = Math.max(v.p1.y, v.p2.y)

      if (vx > hMin + 1 && vx < hMax - 1 && hy > vMin + 1 && hy < vMax - 1) {
        crossings.push({ x: vx, y: hy, overLinkId: h.linkId, underLinkId: v.linkId })
      }
    }
  }

  return crossings
}
