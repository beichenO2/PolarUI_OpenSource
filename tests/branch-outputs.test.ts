import { describe, it, expect, beforeAll } from 'vitest'
import { Graph } from '../src/engine/graph'
import { registry } from '../src/engine/registry'
import {
  parseSwitchCases,
  routingOutletCount,
  routingOutletName,
  conditionBranchCount,
} from '../src/engine/branch-outputs'
import type { NodeDef } from '../src/engine/types'
import coreDefs from '../../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

describe('branch-outputs', () => {
  it('Switch defaults to 2 cases', () => {
    const g = new Graph('t')
    const sw = g.addNode('Switch', 0, 0)!
    const cases = parseSwitchCases(sw)
    expect(cases.length).toBe(2)
    expect(routingOutletCount(sw)).toBe(3)
    expect(routingOutletName(sw, 2)).toBe('default')
  })

  it('Switch grows outlets with cases JSON', () => {
    const g = new Graph('t')
    const sw = g.addNode('Switch', 0, 0)!
    sw.params.cases = JSON.stringify([
      { label: 'A' },
      { label: 'B' },
      { label: 'C' },
    ])
    expect(routingOutletCount(sw)).toBe(4)
    expect(routingOutletName(sw, 1)).toBe('B')
  })

  it('Condition branch_count affects outlet count', () => {
    const g = new Graph('t')
    const c = g.addNode('Condition', 0, 0)!
    c.params.branch_count = 4
    expect(conditionBranchCount(c)).toBe(4)
    expect(routingOutletCount(c)).toBe(4)
    expect(routingOutletName(c, 0)).toBe('branch_0')
    expect(routingOutletName(c, 1)).toBe('branch_1')
  })
})
