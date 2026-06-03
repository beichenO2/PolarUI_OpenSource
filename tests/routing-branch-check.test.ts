import { describe, it, expect, beforeAll } from 'vitest'
import { Graph } from '../src/engine/graph'
import { registry } from '../src/engine/registry'
import { validateRoutingBranches } from '../src/engine/routing-branch-check'
import type { NodeDef } from '../src/engine/types'
import coreDefs from '../../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

describe('routing-branch-check', () => {
  it('Switch with one outgoing branch fails', () => {
    const g = new Graph('t')
    const sw = g.addNode('Switch', 0, 0)!
    const out = g.addNode('Output', 200, 0)!
    g.addLink(sw.id, 0, out.id, 0)
    const r = validateRoutingBranches(g)
    expect(r.errors.some(e => e.includes('多路分支'))).toBe(true)
  })

  it('Switch with two distinct outgoing branches passes branch rule', () => {
    const g = new Graph('t')
    const sw = g.addNode('Switch', 0, 0)!
    sw.params.cases = JSON.stringify([{ when: 'a' }, { when: 'b' }])
    const o0 = g.addNode('Output', 200, 0)!
    const o1 = g.addNode('Output', 200, 80)!
    g.addLink(sw.id, 0, o0.id, 0)
    g.addLink(sw.id, 1, o1.id, 0)
    const r = validateRoutingBranches(g)
    expect(r.errors.filter(e => e.includes('多路分支'))).toHaveLength(0)
  })
})
