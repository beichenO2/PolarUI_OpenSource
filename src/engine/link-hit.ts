import type { Vec2 } from './node-geometry'

export function hitTestPolyline(px: number, py: number, pts: Vec2[], threshold: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1e-6) {
      if (Math.hypot(px - a.x, py - a.y) <= threshold) return true
      continue
    }
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq))
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    if (Math.hypot(px - cx, py - cy) <= threshold) return true
  }
  return false
}
