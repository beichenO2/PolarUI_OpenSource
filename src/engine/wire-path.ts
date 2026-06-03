/**
 * ComfyUI 式 L 型直连 — 无 libavoid / 绕障。
 */
import type { Vec2 } from './node-geometry'

export const WIRE_STUB = 40

/** 正交 L 路径：出口水平 stub → 竖直 → 入口水平 stub */
export function buildFallbackPath(from: Vec2, to: Vec2): Vec2[] {
  const gap = WIRE_STUB
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
