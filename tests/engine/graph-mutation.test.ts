import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMutations,
  type MutationOp,
  type MutationPolicy,
} from '../../src/engine/graph-mutation.ts'
import type { Workflow, NodeInstance, Link } from '../../src/engine/types'

function makeNode(id: string, classType = 'StaticData', extra: Partial<NodeInstance> = {}): NodeInstance {
  return {
    id,
    class_type: classType,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    params: {},
    ...extra,
  }
}

function makeLink(id: string, from: string, to: string, fromSlot = 0, toSlot = 0): Link {
  return { id, from_node: from, from_slot: fromSlot, to_node: to, to_slot: toSlot }
}

function baseWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf1',
    name: 'test',
    nodes: [makeNode('1', 'StaticData'), makeNode('2', 'Output')],
    links: [makeLink('l1', '1', '2')],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('applyMutations — policy guards', () => {
  it('rejects add_node when class_type not in allowedTypes', () => {
    const wf = baseWorkflow()
    const policy: MutationPolicy = { allowedTypes: ['LLM', 'Output'] }
    const ops: MutationOp[] = [{ op: 'add_node', node: { class_type: 'ShellExec' } }]
    const r = applyMutations(wf, ops, policy)
    assert.equal(r.applied.length, 0)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /allowedTypes|whitelist|not allowed/i)
    assert.equal(r.workflow.nodes.length, 2)
  })

  it('rejects add_node when maxNodes budget exceeded', () => {
    const wf = baseWorkflow()
    const policy: MutationPolicy = { maxNodes: 2 }
    const ops: MutationOp[] = [{ op: 'add_node', node: { class_type: 'LLM' } }]
    const r = applyMutations(wf, ops, policy)
    assert.equal(r.applied.length, 0)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /maxNodes|budget|limit/i)
  })

  it('rejects remove_node for protectedNodeIds', () => {
    const wf = baseWorkflow()
    const policy: MutationPolicy = { protectedNodeIds: ['1'] }
    const ops: MutationOp[] = [{ op: 'remove_node', node_id: '1' }]
    const r = applyMutations(wf, ops, policy)
    assert.equal(r.applied.length, 0)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /protected/i)
    assert.ok(r.workflow.nodes.some(n => n.id === '1'))
    assert.equal(r.workflow.links.length, 1)
  })
})

describe('applyMutations — cascade & dangling edges', () => {
  it('remove_node cascades link deletion with no dangling edges', () => {
    const wf = baseWorkflow({
      nodes: [makeNode('1'), makeNode('2'), makeNode('3')],
      links: [makeLink('l1', '1', '2'), makeLink('l2', '2', '3')],
    })
    const r = applyMutations(wf, [{ op: 'remove_node', node_id: '2' }], {})
    assert.equal(r.applied.length, 1)
    assert.equal(r.workflow.nodes.length, 2)
    assert.equal(r.workflow.links.length, 0)
    const ids = new Set(r.workflow.nodes.map(n => n.id))
    for (const link of r.workflow.links) {
      assert.ok(ids.has(link.from_node))
      assert.ok(ids.has(link.to_node))
    }
  })
})

describe('applyMutations — batch partial reject', () => {
  it('rejected op does not abort subsequent ops', () => {
    const wf = baseWorkflow()
    const policy: MutationPolicy = { allowedTypes: ['LLM', 'Output', 'StaticData'] }
    const ops: MutationOp[] = [
      { op: 'add_node', node: { class_type: 'ShellExec' } }, // reject
      { op: 'add_node', node: { class_type: 'LLM', id: 'new-llm' } }, // apply
      { op: 'set_param', node_id: '1', key: 'value', value: 'ok' }, // apply
    ]
    const r = applyMutations(wf, ops, policy)
    assert.equal(r.rejected.length, 1)
    assert.equal(r.applied.length, 2)
    assert.ok(r.workflow.nodes.some(n => n.id === 'new-llm'))
    assert.equal(r.workflow.nodes.find(n => n.id === '1')?.params.value, 'ok')
  })
})

describe('applyMutations — immutability', () => {
  it('does not mutate the input workflow', () => {
    const wf = baseWorkflow()
    const snapshot = JSON.stringify(wf)
    applyMutations(wf, [
      { op: 'add_node', node: { class_type: 'LLM', id: 'x' } },
      { op: 'set_param', node_id: '1', key: 'value', value: 'changed' },
      { op: 'remove_link', link_id: 'l1' },
    ], {})
    assert.equal(JSON.stringify(wf), snapshot)
    assert.equal(wf.nodes.length, 2)
    assert.equal(wf.links.length, 1)
    assert.equal(wf.nodes[0].params.value, undefined)
  })
})

describe('applyMutations — id collision', () => {
  it('generates unique id when add_node id collides', () => {
    const wf = baseWorkflow()
    const r = applyMutations(wf, [
      { op: 'add_node', node: { class_type: 'LLM', id: '1' } },
    ], {})
    assert.equal(r.applied.length, 1)
    assert.equal(r.workflow.nodes.length, 3)
    const ids = r.workflow.nodes.map(n => n.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.includes('1'))
    assert.ok(ids.some(id => id !== '1' && id !== '2'))
  })
})

describe('applyMutations — link & param guards', () => {
  it('rejects add_link when endpoint node missing', () => {
    const wf = baseWorkflow()
    const r = applyMutations(wf, [{
      op: 'add_link',
      link: { from_node: '1', from_slot: 0, to_node: 'missing', to_slot: 0 },
    }], {})
    assert.equal(r.applied.length, 0)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /missing|not found|exist/i)
  })

  it('rejects remove_link when link_id missing', () => {
    const wf = baseWorkflow()
    const r = applyMutations(wf, [{ op: 'remove_link', link_id: 'nope' }], {})
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /not found|exist|missing/i)
  })

  it('rejects set_param when node missing', () => {
    const wf = baseWorkflow()
    const r = applyMutations(wf, [{ op: 'set_param', node_id: 'ghost', key: 'a', value: 1 }], {})
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /not found|exist|missing/i)
  })

  it('applies add_link when both endpoints exist', () => {
    const wf = baseWorkflow({
      nodes: [makeNode('1'), makeNode('2'), makeNode('3')],
      links: [],
    })
    const r = applyMutations(wf, [{
      op: 'add_link',
      link: { from_node: '1', from_slot: 0, to_node: '3', to_slot: 0 },
    }], {})
    assert.equal(r.applied.length, 1)
    assert.equal(r.workflow.links.length, 1)
    assert.equal(r.workflow.links[0].from_node, '1')
    assert.equal(r.workflow.links[0].to_node, '3')
  })
})
