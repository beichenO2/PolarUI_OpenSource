import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkI1NoNodeCrossings,
  checkI2OrthogonalEndpoints,
  checkI3FanOutSeparation,
  checkI4BackwardSeparation,
  checkI5Deterministic,
} from './helpers/wire-invariants.ts'
import { routeGraphWires } from './helpers/route-pipeline.ts'
import { linear3, fanOut6, react2Loops, denseCorridor } from './fixtures/synthetic-fixtures.ts'
import { loadTaociDenseFixture, loadHermesReactFixture } from './fixtures/workflow-fixtures.ts'
import { deriveViewGraph } from '../../src/engine/graph-groups.ts'
import type { NodeInstance, Link } from '../../src/engine/types'

interface Fixture {
  name: string
  nodes: NodeInstance[]
  links: Link[]
  backLinks: Set<string>
}

const FIXTURES: Fixture[] = [
  { name: 'linear-3', ...linear3 },
  { name: 'fan-out-6', ...fanOut6 },
  { name: 'react-3-loops', ...react2Loops },
  { name: 'dense-corridor', ...denseCorridor },
]

function runInvariants(f: Fixture) {
  const { paths } = routeGraphWires(f.nodes, f.links, f.backLinks)
  const run2 = routeGraphWires(f.nodes, f.links, f.backLinks).paths
  return {
    I1: checkI1NoNodeCrossings(f.nodes, f.links, paths),
    I2: checkI2OrthogonalEndpoints(f.nodes, f.links, paths),
    I3: checkI3FanOutSeparation(f.links, paths),
    I4: checkI4BackwardSeparation(f.links, paths, f.backLinks),
    I5: checkI5Deterministic(paths, run2),
  }
}

function hasFanOut(links: Link[]): boolean {
  const slots = new Map<string, number>()
  for (const l of links) {
    const k = `${l.from_node}:${l.from_slot}`
    slots.set(k, (slots.get(k) ?? 0) + 1)
  }
  return [...slots.values()].some(n => n > 1)
}

describe('wire routing invariants', () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      it('I1: no segment crosses node bbox', () => {
        const { I1 } = runInvariants(f)
        assert.equal(I1.length, 0, I1.map(v => v.detail).join('; '))
      })

      it('I2: orthogonal path with correct endpoints', () => {
        const { I2 } = runInvariants(f)
        assert.equal(I2.length, 0, I2.map(v => v.detail).join('; '))
      })

      it('I3: fan-out wires not fully overlapping', { skip: !hasFanOut(f.links) ? 'no fan-out in fixture' : false }, () => {
        const { I3 } = runInvariants(f)
        assert.equal(I3.length, 0, I3.map(v => v.detail).join('; '))
      })

      it('I4: backward edges not fully overlapping', { skip: f.backLinks.size === 0 ? 'no backward links' : false }, () => {
        const { I4 } = runInvariants(f)
        assert.equal(I4.length, 0, I4.map(v => v.detail).join('; '))
      })

      it('I5: deterministic routing', () => {
        const { I5 } = runInvariants(f)
        assert.equal(I5.length, 0, I5.map(v => v.detail).join('; '))
      })
    })
  }

  describe('taoci-outreach (auto-layout)', () => {
    const f = loadTaociDenseFixture()

    it('I1: no segment crosses node bbox', () => {
      const { I1 } = runInvariants({ name: 'taoci', ...f })
      assert.equal(I1.length, 0, `${I1.length} violations`)
    })

    it('I2: orthogonal endpoints', () => {
      const { I2 } = runInvariants({ name: 'taoci', ...f })
      assert.equal(I2.length, 0)
    })

    it('I5: deterministic', () => {
      const { I5 } = runInvariants({ name: 'taoci', ...f })
      assert.equal(I5.length, 0)
    })
  })

  describe('hermes (auto-layout)', () => {
    const f = loadHermesReactFixture()

    it('I1: no segment crosses node bbox', () => {
      const { I1 } = runInvariants({ name: 'hermes', ...f })
      assert.equal(I1.length, 0, `${I1.length} violations`)
    })

    it('I4: backward edges separated', () => {
      const { I4 } = runInvariants({ name: 'hermes', ...f })
      assert.equal(I4.length, 0, I4.map(v => v.detail).join('; '))
    })
  })

  describe('linear-3 collapsed group (view graph)', () => {
    const base = linear3
    const groups = [{ id: 'g1', title: 'Mid', node_ids: ['b'], collapsed: true }]
    const view = deriveViewGraph(base.nodes, base.links, groups)

    it('I1: no segment crosses node bbox', () => {
      const { I1 } = runInvariants({ name: 'linear-3-collapsed', nodes: view.nodes, links: view.links, backLinks: base.backLinks })
      assert.equal(I1.length, 0, I1.map(v => v.detail).join('; '))
    })

    it('I2: orthogonal endpoints', () => {
      const { I2 } = runInvariants({ name: 'linear-3-collapsed', nodes: view.nodes, links: view.links, backLinks: base.backLinks })
      assert.equal(I2.length, 0)
    })

    it('I5: deterministic routing', () => {
      const { I5 } = runInvariants({ name: 'linear-3-collapsed', nodes: view.nodes, links: view.links, backLinks: base.backLinks })
      assert.equal(I5.length, 0)
    })
  })
})

describe('wire routing stats probe', () => {
  it('prints post-fix metrics', () => {
    const report: Record<string, Record<string, number>> = {}
    for (const f of [
      ...FIXTURES,
      { name: 'taoci', ...loadTaociDenseFixture() },
      { name: 'hermes', ...loadHermesReactFixture() },
    ]) {
      const r = runInvariants(f)
      report[f.name] = {
        I1: r.I1.length,
        I2: r.I2.length,
        I3: r.I3.length,
        I4: r.I4.length,
        I5: r.I5.length,
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n=== Wire routing post-fix ===\n', JSON.stringify(report, null, 2))
    assert.ok(Object.values(report).every(v => v.I1 === 0 && v.I2 === 0 && v.I5 === 0))
  })
})
