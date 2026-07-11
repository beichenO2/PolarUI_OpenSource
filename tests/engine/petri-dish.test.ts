import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runPetriDish } from '../../src/engine/petri-dish.ts'
import { savePetriResult } from '../../lib/save-petri-result.mjs'
import type { MutationOp, MutationPolicy } from '../../src/engine/graph-mutation.ts'
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

function makeLink(id: string, from: string, to: string): Link {
  return { id, from_node: from, from_slot: 0, to_node: to, to_slot: 0 }
}

function baseSlave(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'slave-1',
    name: 'slave',
    nodes: [makeNode('1', 'StaticData'), makeNode('2', 'Output')],
    links: [makeLink('l1', '1', '2')],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

const policy: MutationPolicy = {
  allowedTypes: ['StaticData', 'Output', 'LLM'],
  maxNodes: 8,
  protectedNodeIds: ['2'],
}

describe('runPetriDish — candidate selection', () => {
  it('picks the ok candidate with the highest score', async () => {
    const slave = baseSlave()
    const before = JSON.stringify(slave)
    const candidates: MutationOp[][] = [
      [{ op: 'set_param', node_id: '1', key: 'value', value: 'low' }],
      [{ op: 'set_param', node_id: '1', key: 'value', value: 'high' }],
      [{ op: 'set_param', node_id: '1', key: 'value', value: 'mid' }],
    ]

    const result = await runPetriDish({
      slaveWorkflow: slave,
      evolutionSignal: { candidates },
      policy,
      execute: async (wf) => {
        const v = String(wf.nodes.find(n => n.id === '1')?.params.value ?? '')
        const scores: Record<string, number> = { low: 1, mid: 5, high: 10 }
        return { ok: true, score: scores[v] ?? 0, outputs: { score: scores[v] ?? 0 } }
      },
    })

    assert.equal(result.applied, false)
    assert.equal(result.evaluations.length, 3)
    assert.ok(result.evaluations.every(e => e.ok))
    assert.equal(result.refinedWorkflow.nodes.find(n => n.id === '1')?.params.value, 'high')
    assert.equal(JSON.stringify(slave), before, 'slaveWorkflow must remain immutable')
  })

  it('treats evolutionSignal.ops as a single candidate', async () => {
    const slave = baseSlave()
    const ops: MutationOp[] = [
      { op: 'set_param', node_id: '1', key: 'tag', value: 'from-ops' },
    ]
    const result = await runPetriDish({
      slaveWorkflow: slave,
      evolutionSignal: { ops },
      policy,
      execute: async (wf) => ({
        ok: true,
        score: wf.nodes.find(n => n.id === '1')?.params.tag === 'from-ops' ? 3 : 0,
      }),
    })
    assert.equal(result.evaluations.length, 1)
    assert.equal(result.refinedWorkflow.nodes.find(n => n.id === '1')?.params.tag, 'from-ops')
  })

  it('falls back to original workflow when all candidates fail', async () => {
    const slave = baseSlave()
    const before = JSON.stringify(slave)
    const result = await runPetriDish({
      slaveWorkflow: slave,
      evolutionSignal: {
        candidates: [
          [{ op: 'set_param', node_id: '1', key: 'value', value: 'a' }],
          [{ op: 'set_param', node_id: '1', key: 'value', value: 'b' }],
        ],
      },
      policy,
      execute: async () => ({ ok: false, score: 99 }),
    })

    assert.equal(result.applied, false)
    assert.ok(result.evaluations.every(e => !e.ok))
    assert.equal(JSON.stringify(result.refinedWorkflow.nodes), JSON.stringify(slave.nodes))
    assert.equal(JSON.stringify(slave), before)
  })

  it('evaluates the original graph when no ops/candidates given', async () => {
    const slave = baseSlave()
    let seenNodes = 0
    const result = await runPetriDish({
      slaveWorkflow: slave,
      policy,
      execute: async (wf) => {
        seenNodes = wf.nodes.length
        return { ok: true, score: 0 }
      },
    })
    assert.equal(result.evaluations.length, 1)
    assert.equal(seenNodes, 2)
    assert.equal(result.refinedWorkflow.nodes.length, 2)
  })
})

describe('runPetriDish — immutability', () => {
  it('never mutates the input slaveWorkflow (JSON.stringify stable)', async () => {
    const slave = baseSlave()
    const snap = JSON.stringify(slave)
    await runPetriDish({
      slaveWorkflow: slave,
      evolutionSignal: {
        candidates: [
          [{ op: 'add_node', node: { class_type: 'StaticData', id: 'n3', params: { value: 'x' } } }],
          [{ op: 'set_param', node_id: '1', key: 'value', value: 'mutated' }],
        ],
      },
      policy,
      execute: async () => ({ ok: true, score: 1 }),
    })
    assert.equal(JSON.stringify(slave), snap)
    assert.equal(slave.nodes.length, 2)
    assert.equal(slave.nodes[0].params.value, undefined)
  })
})

describe('savePetriResult — human-gated persistence', () => {
  it('writes workflows/<name>.petri.json and does not create registry-entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'petri-'))
    const wf = baseSlave({ name: 'refined-candidate' })
    const path = savePetriResult(wf, 'candidate-a', dir)

    assert.ok(path.endsWith('candidate-a.petri.json'))
    assert.ok(existsSync(path))
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Workflow
    assert.equal(parsed.name, 'refined-candidate')
    assert.ok(!existsSync(join(dir, 'registry-entry.json')))
    assert.deepEqual(
      readdirSync(dir).filter(n => n.includes('registry')),
      [],
      'no registry artifacts alongside .petri.json',
    )
  })

  it('sync-workflows.mjs excludes *.petri.json from copy/registry intake', () => {
    const syncPath = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/sync-workflows.mjs')
    const src = readFileSync(syncPath, 'utf8')
    assert.match(src, /\.petri\.json/, 'sync-workflows must mention .petri.json exclusion')
    assert.match(
      src,
      /endsWith\(['"]\.petri\.json['"]\)|petri\.json/,
      'sync must skip *.petri.json so they never enter dist as registered workflows',
    )
  })
})
