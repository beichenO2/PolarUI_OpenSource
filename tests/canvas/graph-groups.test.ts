import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateGroups,
  createGroup,
  ungroupGroup,
  moveGroupMembers,
  computeMemberBounds,
  partitionLinksByGroup,
  buildPortProjection,
  buildGroupBoxNode,
  deriveViewGraph,
  nextGroupTitle,
  GROUP_BOX_CLASS,
  groupBoxNodeId,
  type WorkflowGroup,
} from '../../src/engine/graph-groups.ts'
import { makeNode, makeLink } from './fixtures/synthetic-fixtures.ts'
import type { NodeInstance, Link } from '../../src/engine/types'

function memberSet(ids: string[]): Set<string> {
  return new Set(ids)
}

describe('graph-groups validateGroups', () => {
  const nodes = [
    makeNode('a', 0, 0),
    makeNode('b', 200, 0),
    makeNode('c', 400, 0),
  ]

  it('accepts valid non-overlapping groups', () => {
    const groups: WorkflowGroup[] = [
      { id: 'g1', title: 'G1', node_ids: ['a', 'b'], collapsed: true },
    ]
    assert.deepEqual(validateGroups(groups, nodes), [])
  })

  it('rejects missing member nodes', () => {
    const groups: WorkflowGroup[] = [
      { id: 'g1', title: 'G1', node_ids: ['a', 'missing'], collapsed: true },
    ]
    const errs = validateGroups(groups, nodes)
    assert.ok(errs.some(e => e.includes('missing')))
  })

  it('rejects overlapping membership', () => {
    const groups: WorkflowGroup[] = [
      { id: 'g1', title: 'G1', node_ids: ['a', 'b'], collapsed: true },
      { id: 'g2', title: 'G2', node_ids: ['b', 'c'], collapsed: true },
    ]
    const errs = validateGroups(groups, nodes)
    assert.ok(errs.some(e => e.includes('overlap') || e.includes('b')))
  })
})

describe('graph-groups create / ungroup', () => {
  it('createGroup assigns id and defaults collapsed true', () => {
    const g = createGroup({ nodeIds: ['a', 'b'], title: 'My Group', existingGroups: [] })
    assert.equal(g.title, 'My Group')
    assert.equal(g.collapsed, true)
    assert.deepEqual(g.node_ids.sort(), ['a', 'b'])
    assert.ok(g.id.length > 0)
  })

  it('nextGroupTitle increments', () => {
    assert.equal(nextGroupTitle([]), 'Group 1')
    assert.equal(nextGroupTitle([{ id: '1', title: 'Group 3', node_ids: [], collapsed: false }]), 'Group 4')
  })

  it('ungroupGroup removes entry', () => {
    const groups: WorkflowGroup[] = [
      { id: 'g1', title: 'G1', node_ids: ['a'], collapsed: true },
      { id: 'g2', title: 'G2', node_ids: ['b'], collapsed: false },
    ]
    const next = ungroupGroup(groups, 'g1')
    assert.equal(next.length, 1)
    assert.equal(next[0].id, 'g2')
  })
})

describe('graph-groups moveGroupMembers', () => {
  it('translates all member nodes', () => {
    const nodes: NodeInstance[] = [
      makeNode('a', 10, 20),
      makeNode('b', 30, 40),
      makeNode('c', 100, 100),
    ]
    const group: WorkflowGroup = { id: 'g1', title: 'G', node_ids: ['a', 'b'], collapsed: false }
    moveGroupMembers(nodes, group, 5, -3)
    assert.equal(nodes.find(n => n.id === 'a')!.x, 15)
    assert.equal(nodes.find(n => n.id === 'a')!.y, 17)
    assert.equal(nodes.find(n => n.id === 'b')!.x, 35)
    assert.equal(nodes.find(n => n.id === 'c')!.x, 100)
  })
})

describe('graph-groups computeMemberBounds', () => {
  it('returns union bbox of members', () => {
    const nodes = [
      makeNode('a', 10, 20, { w: 100, h: 80 }),
      makeNode('b', 150, 50, { w: 120, h: 90 }),
    ]
    const b = computeMemberBounds(nodes, ['a', 'b'])
    assert.ok(b)
    assert.equal(b!.x, 10)
    assert.equal(b!.y, 20)
    assert.equal(b!.w, 260)
    assert.equal(b!.h, 120)
  })
})

describe('graph-groups partitionLinksByGroup', () => {
  const links: Link[] = [
    makeLink('l1', 'ext', 0, 'a', 0),
    makeLink('l2', 'a', 0, 'b', 0),
    makeLink('l3', 'b', 0, 'ext2', 0),
  ]

  it('classifies internal / inbound / outbound', () => {
    const { internal, inbound, outbound } = partitionLinksByGroup(links, memberSet(['a', 'b']))
    assert.equal(internal.length, 1)
    assert.equal(internal[0].id, 'l2')
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0].id, 'l1')
    assert.equal(outbound.length, 1)
    assert.equal(outbound[0].id, 'l3')
  })
})

describe('graph-groups port projection', () => {
  const nodes = [
    makeNode('ext1', 0, 100),
    makeNode('a', 300, 80),
    makeNode('b', 300, 260),
    makeNode('ext2', 600, 100),
  ]
  const links: Link[] = [
    makeLink('in1', 'ext1', 0, 'a', 0),
    makeLink('in2', 'ext1', 0, 'b', 0),
    makeLink('internal', 'a', 0, 'b', 0),
    makeLink('out1', 'a', 0, 'ext2', 0),
    makeLink('out2', 'b', 0, 'ext2', 1),
  ]
  const group: WorkflowGroup = {
    id: 'g1',
    title: 'Core',
    node_ids: ['a', 'b'],
    collapsed: true,
  }

  it('dedupes inbound ports by external source slot', () => {
    const proj = buildPortProjection(group, links, nodes)
    assert.equal(proj.inputs.length, 1)
    assert.equal(proj.inputs[0].from_node, 'ext1')
    assert.equal(proj.inputs[0].from_slot, 0)
  })

  it('dedupes outbound ports by external target slot', () => {
    const proj = buildPortProjection(group, links, nodes)
    assert.equal(proj.outputs.length, 2)
    const slots = proj.outputs.map(o => `${o.to_node}:${o.to_slot}`).sort()
    assert.deepEqual(slots, ['ext2:0', 'ext2:1'])
  })

  it('buildGroupBoxNode has synthetic class and port counts', () => {
    const proj = buildPortProjection(group, links, nodes)
    const box = buildGroupBoxNode(group, nodes, proj)
    assert.equal(box.class_type, GROUP_BOX_CLASS)
    assert.equal(box.id, groupBoxNodeId('g1'))
    assert.ok(box.height >= 100)
    assert.equal(box.params.member_count, 2)
  })
})

describe('graph-groups deriveViewGraph collapsed', () => {
  const nodes = [
    makeNode('ext1', 0, 100),
    makeNode('a', 300, 80),
    makeNode('b', 300, 260),
    makeNode('ext2', 600, 100),
  ]
  const links: Link[] = [
    makeLink('in1', 'ext1', 0, 'a', 0),
    makeLink('internal', 'a', 0, 'b', 0),
    makeLink('out1', 'b', 0, 'ext2', 0),
  ]
  const groups: WorkflowGroup[] = [
    { id: 'g1', title: 'Core', node_ids: ['a', 'b'], collapsed: true },
  ]

  it('hides members and omits internal links', () => {
    const view = deriveViewGraph(nodes, links, groups)
    assert.ok(view.hiddenNodeIds.has('a'))
    assert.ok(view.hiddenNodeIds.has('b'))
    assert.ok(!view.links.some(l => l.id === 'internal'))
    const visibleIds = new Set(view.nodes.map(n => n.id))
    assert.ok(visibleIds.has(groupBoxNodeId('g1')))
    assert.ok(visibleIds.has('ext1'))
    assert.ok(visibleIds.has('ext2'))
  })

  it('projects cross-boundary links to group box', () => {
    const view = deriveViewGraph(nodes, links, groups)
    const boxId = groupBoxNodeId('g1')
    const inbound = view.links.find(l => l.from_node === 'ext1')
    const outbound = view.links.find(l => l.to_node === 'ext2')
    assert.ok(inbound)
    assert.equal(inbound!.to_node, boxId)
    assert.ok(outbound)
    assert.equal(outbound!.from_node, boxId)
  })

  it('expanded group keeps members visible', () => {
    const expanded: WorkflowGroup[] = [{ ...groups[0], collapsed: false }]
    const view = deriveViewGraph(nodes, links, expanded)
    assert.equal(view.hiddenNodeIds.size, 0)
    assert.ok(!view.nodes.some(n => n.class_type === GROUP_BOX_CLASS))
    assert.equal(view.links.length, links.length)
    assert.equal(view.expandedFrames.length, 1)
  })
})
