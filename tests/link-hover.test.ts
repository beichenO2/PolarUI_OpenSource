import { describe, it, expect } from 'vitest'
import { linkHoverAlpha, linkTouchesNode, LINK_DIM_ALPHA } from '../src/engine/link-hover'
import type { Link } from '../src/engine/types'

const link: Link = {
  id: 'l1',
  from_node: 'a',
  to_node: 'b',
  from_slot: 0,
  to_slot: 0,
}

describe('link-hover', () => {
  it('detects association with hovered node', () => {
    expect(linkTouchesNode(link, 'a')).toBe(true)
    expect(linkTouchesNode(link, 'c')).toBe(false)
    expect(linkTouchesNode(link, null)).toBe(false)
  })

  it('dims non-associated edges when hovering', () => {
    expect(linkHoverAlpha(link, 'a', 0.95)).toBe(0.95)
    expect(linkHoverAlpha(link, 'c', 0.95)).toBe(LINK_DIM_ALPHA)
    expect(linkHoverAlpha(link, null, 0.95)).toBe(0.95)
  })
})
