import { describe, it, expect } from 'vitest'
import { validateExpectedOutputBlocks } from '../src/engine/expected-output-schema'

describe('validateExpectedOutputBlocks', () => {
  it('accepts JSON object with named block regexes', () => {
    const r = validateExpectedOutputBlocks({ summary: '"title"', body: '"sections"' })
    expect(r.valid).toBe(true)
  })

  it('rejects plain regex string', () => {
    const r = validateExpectedOutputBlocks('.*')
    expect(r.valid).toBe(false)
  })

  it('rejects empty object', () => {
    expect(validateExpectedOutputBlocks('{}').valid).toBe(false)
  })
})
