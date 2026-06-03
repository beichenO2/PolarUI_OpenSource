import { describe, it, expect } from 'vitest'
import {
  applyWheelToViewport,
  applyWheelZoom,
  normalizeWheelDelta,
} from '../src/engine/canvas-viewport'
import { nodeDrawBounds, normalizeOutputTerminalSize } from '../src/engine/node-geometry'
import type { NodeInstance } from '../src/engine/types'

describe('canvas-viewport wheel', () => {
  it('uses proportional zoom for pinch gestures instead of fixed 10% steps', () => {
    let viewport = { scale: 1, offset: { x: 0, y: 0 } }
    for (let i = 0; i < 20; i++) {
      viewport = applyWheelZoom(viewport, -0.5, { x: 100, y: 100 }, { smooth: true })
    }
    expect(viewport.scale).toBeLessThan(1.15)
  })

  it('old fixed-step behavior would have hit max zoom in ~20 trackpad ticks', () => {
    let scale = 1
    for (let i = 0; i < 20; i++) {
      scale = Math.min(4, scale * 1.1)
    }
    expect(scale).toBe(4)
  })

  it('zooms on wheel without ctrl modifier', () => {
    const next = applyWheelToViewport(
      { scale: 1, offset: { x: 0, y: 0 } },
      {
        deltaX: 0,
        deltaY: -32,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      },
      { x: 50, y: 50 },
    )
    expect(next.scale).toBeGreaterThan(1)
  })

  it('normalizes line-mode mouse wheel deltas', () => {
    const { dy } = normalizeWheelDelta({
      deltaX: 0,
      deltaY: 3,
      deltaMode: 1,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })
    expect(dy).toBe(48)
  })
})

describe('output end card bounds', () => {
  const outputNode: NodeInstance = {
    id: 'out1',
    class_type: 'Output',
    x: 100,
    y: 200,
    width: 20,
    height: 18,
    params: {},
  }

  it('normalizes to compact card dimensions', () => {
    normalizeOutputTerminalSize(outputNode)
    expect(outputNode.width).toBeGreaterThan(100)
    expect(outputNode.height).toBeGreaterThan(40)
  })

  it('uses rectangular card bounds for hit testing', () => {
    normalizeOutputTerminalSize(outputNode)
    const b = nodeDrawBounds(outputNode)
    expect(b.x).toBe(100)
    expect(b.y).toBe(200)
    expect(b.w).toBe(outputNode.width)
    expect(b.h).toBe(outputNode.height)
  })
})
