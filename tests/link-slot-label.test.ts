import { describe, it, expect, beforeAll } from 'vitest'
import {
  formatLinkSlotLabel,
  shouldShowLinkSlotLabel,
  polylineMidpoint,
  polylinePointNearSource,
  polylinePointNearEnd,
  linkLabelAnchor,
  separateWireLabelPositions,
} from '../src/engine/link-slot-label'
import { registry } from '../src/engine/registry'
import type { Link, NodeInstance, NodeDef } from '../src/engine/types'

import coreDefs from '../../node-defs/core.json'

beforeAll(() => {
  for (const def of coreDefs as NodeDef[]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
})

const nodes: NodeInstance[] = [
  {
    id: 'a',
    class_type: 'LLM',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    params: {},
  },
  {
    id: 'b',
    class_type: 'Output',
    x: 300,
    y: 0,
    width: 200,
    height: 80,
    params: {},
  },
]

const link: Link = {
  id: 'l1',
  from_node: 'a',
  to_node: 'b',
  from_slot: 0,
  to_slot: 0,
}

describe('link-slot-label', () => {
  it('formats output → input slot names from registry', () => {
    const label = formatLinkSlotLabel(link, nodes)
    expect(label).toBe('response → content')
  })

  it('shows label when hovering a connected component or link selected', () => {
    expect(shouldShowLinkSlotLabel(link, 'a', null)).toBe(true)
    expect(shouldShowLinkSlotLabel(link, 'c', null)).toBe(false)
    expect(shouldShowLinkSlotLabel(link, null, 'l1')).toBe(true)
  })

  it('polylineMidpoint picks center along path', () => {
    const mid = polylineMidpoint([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
    expect(mid.x).toBeCloseTo(50, 0)
    expect(mid.y).toBe(0)
  })

  it('polylinePointNearSource stays near wire start', () => {
    const p = polylinePointNearSource(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      30,
    )
    expect(p.x).toBeCloseTo(30, 0)
  })

  it('linkLabelAnchor uses hover target end when focus is to_node', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]
    const nearTarget = linkLabelAnchor(
      { ...link, to_node: 'b' },
      'b',
      pts,
      30,
      0,
    )
    expect(nearTarget.x).toBeGreaterThan(150)
    expect(nearTarget.align).toBe('left')
  })

  it('linkLabelAnchor places label outside hovered node box', () => {
    const pts = [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ]
    const p = linkLabelAnchor(
      { ...link, to_node: 'b' },
      'b',
      pts,
      14,
      0,
      { to: { x: 200, y: 0, w: 120, h: 80 } },
      6,
    )
    expect(p.x).toBe(194)
    expect(p.align).toBe('left')
  })

  it('separateWireLabelPositions adds vertical gap', () => {
    const labels = [
      { screenX: 100, screenY: 50 },
      { screenX: 105, screenY: 52 },
    ]
    separateWireLabelPositions(labels, 20)
    expect(labels[1].screenY - labels[0].screenY).toBeGreaterThanOrEqual(20)
  })
})
