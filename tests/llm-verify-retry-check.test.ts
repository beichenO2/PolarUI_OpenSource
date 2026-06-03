import { describe, it, expect, beforeAll } from 'vitest'
import { Graph } from '../src/engine/graph'
import { registry } from '../src/engine/registry'
import { validateLlmValidatorRetryLoops } from '../src/engine/llm-verify-retry-check'
import type { NodeDef } from '../src/engine/types'
import coreDefs from '../../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

describe('validateLlmValidatorRetryLoops', () => {
  it('errors when LLM has no Validator→RetryLoop back-edge', () => {
    const g = new Graph('t')
    const llm = g.addNode('LLM', 0, 0, '1')!
    const v = g.addNode('Validator', 200, 0, '2')!
    g.addLink(llm.id, 0, v.id, 0)
    const errs = validateLlmValidatorRetryLoops(g)
    expect(errs.some(e => e.includes('RetryLoop'))).toBe(true)
  })

  it('passes with LLM → Validator → RetryLoop → LLM', () => {
    const g = new Graph('t')
    const llm = g.addNode('LLM', 0, 0, '1')!
    const v = g.addNode('Validator', 200, 0, '2')!
    const r = g.addNode('RetryLoop', 400, 0, '3')!
    g.addLink(llm.id, 0, v.id, 0)
    g.addLink(v.id, 0, r.id, 0)
    g.addLink(r.id, 0, llm.id, 0)
    expect(validateLlmValidatorRetryLoops(g)).toHaveLength(0)
  })
})
