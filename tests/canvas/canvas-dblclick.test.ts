import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectDoubleClick,
  shouldInvokeNodeDblClick,
  resolveSsotProjectDblClick,
  NODE_DBLCLICK_THRESHOLD_MS,
} from '../../src/engine/canvas-dblclick.ts'
import type { NodeInstance } from '../../src/engine/types.ts'

function node(partial: Partial<NodeInstance> & Pick<NodeInstance, 'class_type'>): NodeInstance {
  return {
    id: partial.id ?? 'n1',
    class_type: partial.class_type,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    params: partial.params ?? {},
    collapsed: partial.collapsed,
  }
}

describe('detectDoubleClick', () => {
  it('fires on same node within threshold', () => {
    const first = detectDoubleClick(null, 'a', 1000)
    assert.equal(first.fired, false)
    assert.deepEqual(first.next, { nodeId: 'a', time: 1000 })

    const second = detectDoubleClick(first.next, 'a', 1000 + NODE_DBLCLICK_THRESHOLD_MS - 1)
    assert.equal(second.fired, true)
    assert.equal(second.next, null)
  })

  it('does not fire across different nodes or after threshold', () => {
    const first = detectDoubleClick(null, 'a', 1000)
    const other = detectDoubleClick(first.next, 'b', 1100)
    assert.equal(other.fired, false)

    const late = detectDoubleClick(first.next, 'a', 1000 + NODE_DBLCLICK_THRESHOLD_MS)
    assert.equal(late.fired, false)
  })
})

describe('shouldInvokeNodeDblClick', () => {
  it('skips NoteCard and group-box nodes', () => {
    assert.equal(shouldInvokeNodeDblClick(null), false)
    assert.equal(shouldInvokeNodeDblClick(node({ class_type: 'NoteCard' })), false)
    assert.equal(
      shouldInvokeNodeDblClick(node({ class_type: '__GroupBox', params: { group_id: 'g1' } })),
      false,
    )
    assert.equal(shouldInvokeNodeDblClick(node({ class_type: 'SSoT_Project' })), true)
  })
})

describe('resolveSsotProjectDblClick', () => {
  it('drills via params.name (fallback label)', () => {
    assert.deepEqual(
      resolveSsotProjectDblClick(node({ class_type: 'SSoT_Project', params: { name: 'PolarUI' } })),
      { action: 'drill', projectName: 'PolarUI' },
    )
    assert.deepEqual(
      resolveSsotProjectDblClick(node({ class_type: 'SSoT_Project', params: { label: 'Clock' } })),
      { action: 'drill', projectName: 'Clock' },
    )
  })

  it('flags missing placeholders and ignores non-project nodes', () => {
    assert.deepEqual(
      resolveSsotProjectDblClick(
        node({ class_type: 'SSoT_Project', params: { name: 'Ghost', missing: true } }),
      ),
      { action: 'missing', projectName: 'Ghost' },
    )
    assert.deepEqual(
      resolveSsotProjectDblClick(node({ class_type: 'SSoT_Requirement', params: { id: 'R1' } })),
      { action: 'ignore' },
    )
  })
})
