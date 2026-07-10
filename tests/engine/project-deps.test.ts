import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { registry } from '../../src/engine/registry.ts'
import {
  extractProjectDependencies,
  buildDependencyGraph,
  type ProjectDep,
} from '../../src/engine/project-deps.ts'

function ensureSsotProjectDef(): void {
  if (registry.get('SSoT_Project')) return
  registry.register({
    class_type: 'SSoT_Project',
    category: 'ssot',
    display_name: 'SSoT Project',
    inputs: [{ name: 'in', type: 'any' }],
    outputs: [{ name: 'out', type: 'any' }],
    params: {
      name: { type: 'string', default: '' },
      tier: { type: 'string', default: 'app' },
      status: { type: 'string', default: 'active' },
      label: { type: 'string', default: '' },
    },
  })
}

before(() => {
  ensureSsotProjectDef()
})

describe('extractProjectDependencies — string[]', () => {
  it('parses plain project names', () => {
    const deps = extractProjectDependencies({ depends_on: ['PolarPrivate', 'Clock'] })
    assert.deepEqual(deps, [
      { project: 'PolarPrivate' },
      { project: 'Clock' },
    ])
  })

  it('strips # comment suffixes and trims', () => {
    const deps = extractProjectDependencies({
      depends_on: ['PolarPrivate  # LLM 网关', '  Clock  '],
    })
    assert.deepEqual(deps, [
      { project: 'PolarPrivate' },
      { project: 'Clock' },
    ])
  })

  it('strips — comment suffixes', () => {
    const deps = extractProjectDependencies({
      depends_on: ['SOTAgent — SDK 入口'],
    })
    assert.deepEqual(deps, [{ project: 'SOTAgent' }])
  })

  it('takes path first segment', () => {
    const deps = extractProjectDependencies({
      depends_on: ['SOTAgent/sdk-port', 'PolarClaw/tools'],
    })
    assert.deepEqual(deps, [
      { project: 'SOTAgent' },
      { project: 'PolarClaw' },
    ])
  })
})

describe('extractProjectDependencies — object[]', () => {
  it('reads project and reason', () => {
    const deps = extractProjectDependencies({
      depends_on: [
        { project: 'PolarPort', reason: 'allocate ports', endpoint: 'http://x' },
        { project: 'Clock', reason: 'time' },
      ],
    })
    assert.deepEqual(deps, [
      { project: 'PolarPort', reason: 'allocate ports' },
      { project: 'Clock', reason: 'time' },
    ])
  })

  it('skips objects missing project', () => {
    const deps = extractProjectDependencies({
      depends_on: [{ reason: 'orphan' }, { project: 'Clock' }],
    })
    assert.deepEqual(deps, [{ project: 'Clock' }])
  })
})

describe('extractProjectDependencies — upstream / downstream', () => {
  it('treats upstream as dependencies (project or name)', () => {
    const deps = extractProjectDependencies({
      upstream: [
        { name: 'open-design', role: '参考库' },
        { project: 'PolarPrivate', reason: 'LLM' },
      ],
      downstream: [{ name: 'PolarClaw', role: 'consumer' }],
    })
    assert.deepEqual(deps, [
      { project: 'open-design', reason: '参考库' },
      { project: 'PolarPrivate', reason: 'LLM' },
    ])
  })

  it('ignores downstream (reverse edges)', () => {
    const deps = extractProjectDependencies({
      downstream: [{ name: 'AutoOffice' }, { project: 'SOTAgent' }],
    })
    assert.deepEqual(deps, [])
  })
})

describe('extractProjectDependencies — edge cases', () => {
  it('returns [] for missing or wrong-typed fields', () => {
    assert.deepEqual(extractProjectDependencies(null), [])
    assert.deepEqual(extractProjectDependencies(undefined), [])
    assert.deepEqual(extractProjectDependencies({}), [])
    assert.deepEqual(extractProjectDependencies({ depends_on: 'PolarPrivate' }), [])
    assert.deepEqual(extractProjectDependencies({ depends_on: 42 }), [])
    assert.deepEqual(extractProjectDependencies({ upstream: 'x' }), [])
  })

  it('filters self-references via polaris.name', () => {
    const deps = extractProjectDependencies({
      name: 'PolarUI',
      depends_on: ['PolarUI', 'Clock', 'PolarUI/src'],
    })
    assert.deepEqual(deps, [{ project: 'Clock' }])
  })

  it('dedupes by project keeping first', () => {
    const deps = extractProjectDependencies({
      depends_on: [
        { project: 'Clock', reason: 'first' },
        'Clock # again',
        { project: 'Clock', reason: 'second' },
      ],
    })
    assert.deepEqual(deps, [{ project: 'Clock', reason: 'first' }])
  })
})

describe('buildDependencyGraph', () => {
  it('creates SSoT_Project nodes with tier/status/label', () => {
    const graph = buildDependencyGraph([
      { name: 'A', tier: 'app', status: 'active', polaris: { depends_on: [] } },
      { name: 'B', tier: 'lib', status: 'wip' },
    ])
    assert.equal(graph.nodes.length, 2)
    for (const n of graph.nodes) {
      assert.equal(n.class_type, 'SSoT_Project')
    }
    const a = graph.nodes.find(n => n.params.name === 'A' || n.params.label === 'A')
    assert.ok(a)
    assert.equal(a!.params.tier, 'app')
    assert.equal(a!.params.status, 'active')
    const b = graph.nodes.find(n => n.params.name === 'B' || n.params.label === 'B')
    assert.ok(b)
    assert.equal(b!.params.tier, 'lib')
    assert.equal(b!.params.status, 'wip')
  })

  it('adds links for dependencies and no dangling edges', () => {
    const graph = buildDependencyGraph([
      {
        name: 'PolarOps',
        tier: 'app',
        polaris: {
          name: 'PolarOps',
          depends_on: [{ project: 'PolarPort', reason: 'ports' }],
        },
      },
      { name: 'PolarPort', tier: 'infra' },
    ])
    assert.equal(graph.links.length, 1)
    const ids = new Set(graph.nodes.map(n => n.id))
    for (const link of graph.links) {
      assert.ok(ids.has(link.from_node), `dangling from ${link.from_node}`)
      assert.ok(ids.has(link.to_node), `dangling to ${link.to_node}`)
    }
    const from = graph.nodes.find(n => String(n.params.name ?? n.params.label) === 'PolarOps')
    const to = graph.nodes.find(n => String(n.params.name ?? n.params.label) === 'PolarPort')
    assert.ok(from && to)
    assert.equal(graph.links[0].from_node, from!.id)
    assert.equal(graph.links[0].to_node, to!.id)
  })

  it('adds placeholder nodes for unknown dependency targets', () => {
    const graph = buildDependencyGraph([
      {
        name: 'PolarClaw',
        polaris: { name: 'PolarClaw', depends_on: ['MissingThing/sdk'] },
      },
    ])
    const missing = graph.nodes.find(n => String(n.params.name ?? n.params.label) === 'MissingThing')
    assert.ok(missing)
    assert.equal(missing!.params.missing, true)
    assert.equal(graph.links.length, 1)
    const ids = new Set(graph.nodes.map(n => n.id))
    for (const link of graph.links) {
      assert.ok(ids.has(link.from_node))
      assert.ok(ids.has(link.to_node))
    }
  })

  it('groups nodes by tier (default other)', () => {
    const graph = buildDependencyGraph([
      { name: 'A', tier: 'app' },
      { name: 'B', tier: 'app' },
      { name: 'C', tier: 'lib' },
      { name: 'D' },
    ])
    assert.ok(graph.groups.length >= 2)
    const titles = graph.groups.map(g => g.title).sort()
    assert.ok(titles.includes('app'))
    assert.ok(titles.includes('lib'))
    assert.ok(titles.includes('other'))
    const appGroup = graph.groups.find(g => g.title === 'app')!
    assert.equal(appGroup.node_ids.length, 2)
  })

  it('filters self-links and dedupes edges', () => {
    const graph = buildDependencyGraph([
      {
        name: 'X',
        polaris: {
          name: 'X',
          depends_on: ['X', 'Y', 'Y # again'],
        },
      },
      { name: 'Y' },
    ])
    assert.equal(graph.links.length, 1)
  })
})
