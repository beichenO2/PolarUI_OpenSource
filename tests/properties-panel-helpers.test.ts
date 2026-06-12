import { describe, it, expect, beforeAll } from 'vitest'
import { Graph } from '../src/engine/graph'
import { registry } from '../src/engine/registry'
import {
  buildComponentInputRows,
  buildComponentNextSteps,
  componentStatusFor,
} from '../src/engine/properties-panel-helpers'
import type { NodeDef } from '../src/engine/types'
import coreDefs from '../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

describe('properties-panel-helpers', () => {
  it('componentStatusFor reflects execution state', () => {
    expect(componentStatusFor('n1', { status: 'idle', results: {} }).kind).toBe('idle')
    expect(
      componentStatusFor('n1', {
        status: 'running',
        current_node: 'n1',
        results: {},
      }).kind,
    ).toBe('running')
  })

  it('buildComponentInputRows lists inputs without duplicating wire labels as main UI', () => {
    const g = new Graph('t')
    const llm = g.addNode('LLM', 0, 0)
    const out = g.addNode('Output', 200, 0)
    g.addLink(llm.id, 0, out.id, 0)
    const def = registry.get('Output')!
    const rows = buildComponentInputRows(g, out, def, {
      [llm.id]: { outputs: { response: 'hello' }, duration_ms: 1 },
    })
    expect(rows[0].name).toBe('content')
    expect(rows[0].valuePreview).toContain('hello')
  })

  it('buildComponentNextSteps lists downstream components', () => {
    const g = new Graph('t')
    const llm = g.addNode('LLM', 0, 0)
    const out = g.addNode('Output', 200, 0)
    g.addLink(llm.id, 0, out.id, 0)
    const steps = buildComponentNextSteps(g, llm.id, registry.get('LLM')!)
    expect(steps).toHaveLength(1)
    expect(steps[0].label).toContain('Output')
  })
})
