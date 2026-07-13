/**
 * R11 批4 — GraphCanvas.refreshWireRouting 必须失效 viewGraphCache。
 * 外部 push 节点后不调 refresh → getNodeAt 点不中；调了则能命中。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../../src/engine/graph.ts'
import { GraphCanvas } from '../../src/engine/canvas.ts'
import { registry } from '../../src/engine/registry.ts'
import type { NodeDef } from '../../src/engine/types.ts'

function ensureWindowShim(): void {
  const g = globalThis as Record<string, unknown>
  if (!g.window) {
    g.window = globalThis
  }
  const w = g.window as Record<string, unknown>
  w.devicePixelRatio = 1
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number
  }
  if (typeof w.cancelAnimationFrame !== 'function') {
    w.cancelAnimationFrame = (id: number) => clearTimeout(id)
  }
  if (typeof w.addEventListener !== 'function') {
    w.addEventListener = () => {}
  }
  if (typeof w.removeEventListener !== 'function') {
    w.removeEventListener = () => {}
  }
}

function createFakeCanvas(): HTMLCanvasElement {
  const parentRect = {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    right: 800,
    bottom: 600,
    toJSON: () => ({}),
  }
  const parentElement = {
    getBoundingClientRect: () => parentRect,
  }

  const fakeCanvas = {
    width: 800,
    height: 600,
    style: {} as CSSStyleDeclaration,
    tabIndex: 0,
    parentElement,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => parentRect,
    focus: () => {},
    setAttribute: () => {},
    getContext: () =>
      new Proxy(
        {},
        {
          get: (_t, p) => {
            if (p === 'canvas') return fakeCanvas
            return typeof p === 'string' ? () => {} : undefined
          },
          set: () => true,
        },
      ),
  }

  return fakeCanvas as unknown as HTMLCanvasElement
}

function registerStaticDataStub(): void {
  if (registry.get('StaticData')) return
  registry.register({
    class_type: 'StaticData',
    category: 'Input',
    display_name: 'StaticData',
    inputs: [{ name: 'trigger', type: 'any', optional: true }],
    outputs: [{ name: 'data', type: 'any' }],
    params: {
      value: { type: 'text' as const, default: '' },
      type: { type: 'select' as const, default: 'string' },
    },
  } as NodeDef)
}

describe('GraphCanvas view cache invalidation', () => {
  let canvas: GraphCanvas | null = null

  before(() => {
    ensureWindowShim()
    registerStaticDataStub()
  })

  after(() => {
    canvas?.destroy()
    canvas = null
  })

  it('refreshWireRouting rebuilds view so getNodeAt hits externally added nodes', () => {
    const graph = new Graph('t')
    const fakeCanvas = createFakeCanvas()
    canvas = new GraphCanvas(fakeCanvas, graph)

    const getNodeAt = (canvas as unknown as { getNodeAt: (x: number, y: number) => { id: string } | null })
      .getNodeAt

    // Prime view cache
    getNodeAt.call(canvas, 0, 0)
    assert.equal(getNodeAt.call(canvas, 130, 76), null)

    graph.nodes.push({
      id: 'n1',
      class_type: 'StaticData',
      x: 100,
      y: 50,
      width: 200,
      height: 80,
      params: {},
    })

    // Without refresh — stale cache, still misses
    assert.equal(getNodeAt.call(canvas, 130, 76), null)

    canvas.refreshWireRouting()
    assert.equal(getNodeAt.call(canvas, 130, 76)?.id, 'n1')
  })
})
