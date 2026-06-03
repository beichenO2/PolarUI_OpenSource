/**
 * 节点碰撞消解 — 移植自 avoid-edge-routing-example / React Flow node-collisions
 * @see https://reactflow.dev/examples/layout/node-collisions
 */
import type { NodeInstance } from './types'
import {
  COLLISION_MARGIN,
  MIN_NODE_GAP,
  isNoteCardNode,
  nodeDrawBounds,
  nodesOverlap,
} from './node-geometry'

export type CollisionAlgorithmOptions = {
  maxIterations?: number
  overlapThreshold?: number
  margin?: number
  minGap?: number
}

type Box = {
  x: number
  y: number
  width: number
  height: number
  dx: number
  dy: number
  moved: boolean
  node: NodeInstance
}

function buildBoxes(nodes: NodeInstance[], margin: number): Box[] {
  return nodes.map(node => {
    const b = nodeDrawBounds(node)
    return {
      x: b.x - margin,
      y: b.y - margin,
      width: b.w + margin * 2,
      height: b.h + margin * 2,
      dx: b.x - node.x,
      dy: b.y - node.y,
      node,
      moved: false,
    }
  })
}

function resolveBoxes(boxes: Box[], maxIter: number, threshold: number): void {
  for (let iter = 0; iter <= maxIter; iter++) {
    let moved = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i]
        const B = boxes[j]
        const dx = (A.x + A.width * 0.5) - (B.x + B.width * 0.5)
        const dy = (A.y + A.height * 0.5) - (B.y + B.height * 0.5)
        const px = (A.width + B.width) * 0.5 - Math.abs(dx)
        const py = (A.height + B.height) * 0.5 - Math.abs(dy)

        if (px > threshold && py > threshold) {
          A.moved = B.moved = moved = true
          if (px < py) {
            const half = (px / 2) * (dx > 0 ? 1 : -1)
            A.x += half
            B.x -= half
          } else {
            const half = (py / 2) * (dy > 0 ? 1 : -1)
            A.y += half
            B.y -= half
          }
        }
      }
    }
    if (!moved) break
  }
}

function applyBoxPositions(boxes: Box[], margin: number): void {
  for (const box of boxes) {
    if (box.moved) {
      box.node.x = box.x + margin - box.dx
      box.node.y = box.y + margin - box.dy
    }
  }
}

/** 强制任意两节点 bbox 间距 ≥ minGap（布局后兜底） */
export function enforceMinimumGap(
  nodes: NodeInstance[],
  minGap = MIN_NODE_GAP,
  maxIterations = 120,
): void {
  const candidates = nodes.filter(n => !isNoteCardNode(n))
  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]
        const b = candidates[j]
        const ba = nodeDrawBounds(a)
        const bb = nodeDrawBounds(b)

        const overlapX = Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x)
        const overlapY = Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y)

        if (overlapX > 0 && overlapY > 0) {
          const dx = (ba.x + ba.w * 0.5) - (bb.x + bb.w * 0.5)
          const dy = (ba.y + ba.h * 0.5) - (bb.y + bb.h * 0.5)
          if (Math.abs(dx) >= Math.abs(dy)) {
            const push = (overlapX + minGap) * 0.5
            a.x += dx >= 0 ? push : -push
            b.x += dx >= 0 ? -push : push
          } else {
            const push = (overlapY + minGap) * 0.5
            a.y += dy >= 0 ? push : -push
            b.y += dy >= 0 ? -push : push
          }
          moved = true
          continue
        }

        const gapX = overlapX > 0
          ? overlapX
          : (ba.x + ba.w <= bb.x)
            ? bb.x - (ba.x + ba.w)
            : (bb.x + bb.w <= ba.x)
              ? ba.x - (bb.x + bb.w)
              : Infinity
        const gapY = overlapY > 0
          ? overlapY
          : (ba.y + ba.h <= bb.y)
            ? bb.y - (ba.y + ba.h)
            : (bb.y + bb.h <= ba.y)
              ? ba.y - (bb.y + bb.h)
              : Infinity

        if (gapX < minGap && overlapY > 0) {
          const need = minGap - gapX
          const dx = (ba.x + ba.w * 0.5) - (bb.x + bb.w * 0.5)
          a.x += dx >= 0 ? need * 0.5 : -need * 0.5
          b.x += dx >= 0 ? -need * 0.5 : need * 0.5
          moved = true
        } else if (gapY < minGap && overlapX > 0) {
          const need = minGap - gapY
          const dy = (ba.y + ba.h * 0.5) - (bb.y + bb.h * 0.5)
          a.y += dy >= 0 ? need * 0.5 : -need * 0.5
          b.y += dy >= 0 ? -need * 0.5 : need * 0.5
          moved = true
        }
      }
    }
    if (!moved) break
  }
}

export function resolveCollisions(
  nodes: NodeInstance[],
  options: CollisionAlgorithmOptions = {},
): NodeInstance[] {
  const candidates = nodes.filter(n => !isNoteCardNode(n))
  if (candidates.length < 2) return nodes

  const maxIter = options.maxIterations ?? 80
  const threshold = options.overlapThreshold ?? 0.5
  const margin = options.margin ?? COLLISION_MARGIN
  const minGap = options.minGap ?? MIN_NODE_GAP

  const boxes = buildBoxes(candidates, margin)
  resolveBoxes(boxes, maxIter, threshold)
  applyBoxPositions(boxes, margin)
  enforceMinimumGap(candidates, minGap)
  return nodes
}

/** 供 layout-memory 校验：记忆布局是否含重叠 */
export function graphHasOverlappingNodes(nodes: NodeInstance[]): boolean {
  return countNodeOverlaps(nodes) > 0
}

function countNodeOverlaps(nodes: NodeInstance[]): number {
  let n = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!isNoteCardNode(nodes[i]) && !isNoteCardNode(nodes[j]) && nodesOverlap(nodes[i], nodes[j])) n++
    }
  }
  return n
}
