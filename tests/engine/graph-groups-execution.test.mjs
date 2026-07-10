import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadFixture, runFixture } from './helpers/run-fixture.mjs'

describe('engine ignores _groups metadata', () => {
  it('collapsed _groups does not change execution traces', async () => {
    const base = await runFixture('wf-linear.json')
    const raw = loadFixture('wf-linear.json')
    raw._groups = [
      {
        id: 'g_mid',
        title: 'Transform chain',
        node_ids: ['2', '3'],
        collapsed: true,
      },
    ]
    const grouped = await runFixture(raw)

    const baseTypes = base.traces.filter(t => !t.skipped).map(t => t.classType)
    const groupedTypes = grouped.traces.filter(t => !t.skipped).map(t => t.classType)
    assert.deepEqual(groupedTypes, baseTypes)

    assert.deepEqual(grouped.merged, base.merged)
  })
})
