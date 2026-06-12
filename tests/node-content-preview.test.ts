import { describe, it, expect, beforeAll } from 'vitest'
import { buildNodeContentPreviewLines, maxContentPreviewLines } from '../src/engine/node-content-preview'
import { registry } from '../src/engine/registry'
import type { NodeDef, NodeInstance } from '../src/engine/types'
import coreDefs from '../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

const wrap = (t: string) => (t.length > 20 ? [t.slice(0, 20), t.slice(20)] : [t])

describe('node-content-preview', () => {
  it('maxContentPreviewLines uses content band height', () => {
    expect(maxContentPreviewLines()).toBeGreaterThanOrEqual(5)
  })

  it('LLM shows model and temperature', () => {
    const node: NodeInstance = {
      id: '1',
      class_type: 'LLM',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      params: { model: 'qwen-plus', temperature: 0.3 },
    }
    const def = registry.get('LLM')!
    const lines = buildNodeContentPreviewLines(node, def, wrap)
    expect(lines.some(l => l.includes('qwen-plus'))).toBe(true)
    expect(lines.some(l => l.includes('0.3'))).toBe(true)
  })

  it('WhileLoop shows max_iterations and run iterations', () => {
    const node: NodeInstance = {
      id: '2',
      class_type: 'WhileLoop',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      params: { max_iterations: 5, condition_expr: 'done < 5' },
    }
    const def = registry.get('WhileLoop')!
    const lines = buildNodeContentPreviewLines(node, def, wrap, { outputs: { iterations: 3 } })
    expect(lines.some(l => l.includes('最大迭代'))).toBe(true)
    expect(lines.some(l => l.includes('已跑'))).toBe(true)
  })
})
