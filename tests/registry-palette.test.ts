import { describe, expect, it } from 'vitest'

function isAgenticCategory(category: string): boolean {
  return category === 'Agentic' || category.startsWith('Agentic/')
}

const REGISTRY_DRAG_PREFIX = 'registry:'

describe('registry palette', () => {
  it('isAgenticCategory', () => {
    expect(isAgenticCategory('Agentic')).toBe(true)
    expect(isAgenticCategory('Agentic/Chain')).toBe(true)
    expect(isAgenticCategory('LLM')).toBe(false)
  })

  it('registry drag payload', () => {
    const id = 'mvp-seed-wf'
    expect(`${REGISTRY_DRAG_PREFIX}${id}`.startsWith(REGISTRY_DRAG_PREFIX)).toBe(true)
    expect(`${REGISTRY_DRAG_PREFIX}${id}`.slice(REGISTRY_DRAG_PREFIX.length)).toBe(id)
  })
})
