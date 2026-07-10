import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../../src/engine/graph.ts'
import { executeStepwise } from '../../src/engine/stepwise-runner.ts'
import { registry } from '../../src/engine/registry.ts'
import type { NodeInstance } from '../../src/engine/types'
import '../../src/engine/executor.ts' // register StemCell + builtins

function ensureDefs(): void {
  for (const def of [
    {
      class_type: 'StemCell',
      category: 'Evolve',
      display_name: '干细胞',
      inputs: [
        { name: 'state', type: 'object' },
        { name: 'differentiation_signal', type: 'object', optional: true },
      ],
      outputs: [
        { name: 'state', type: 'object' },
        { name: 'materialized_class', type: 'string' },
        { name: 'node_id', type: 'string' },
        { name: 'graph_edit_granted', type: 'boolean' },
      ],
      params: {
        allowed_types: { type: 'text' as const, default: 'LLM,ToolCall,CodeExec,Switch,Output,StemCell,StaticData' },
        allow_graph_edit: { type: 'boolean' as const, default: true },
        max_mutations: { type: 'number' as const, default: 8 },
      },
    },
    {
      class_type: 'StaticData',
      category: 'Input',
      display_name: 'StaticData',
      inputs: [{ name: 'trigger', type: 'any', optional: true }],
      outputs: [{ name: 'data', type: 'any' }],
      params: {
        value: { type: 'text' as const, default: '' },
        type: { type: 'select' as const, default: 'string' },
      },
    },
    {
      class_type: 'Output',
      category: 'Output',
      display_name: 'Output',
      inputs: [{ name: 'content', type: 'any', optional: true }],
      outputs: [],
      params: {},
    },
  ]) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
}

function pushNode(graph: Graph, node: NodeInstance): void {
  graph.nodes.push(node)
}

/** StemCell → Output; signal materializes StaticData into the path. */
function buildStemCellFixture(signal: unknown, stemParams: Record<string, unknown> = {}) {
  const graph = new Graph('stemcell-fixture')
  graph.lgEntry = '1'
  graph.lgEdges = [{ from: '1', to: '2', kind: 'static' }]
  pushNode(graph, {
    id: '1',
    class_type: 'StemCell',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    params: {
      allowed_types: 'StaticData,Output,LLM',
      allow_graph_edit: true,
      max_mutations: 8,
      differentiation_signal: signal,
      state: { seed: true },
      ...stemParams,
    },
  })
  pushNode(graph, {
    id: '2',
    class_type: 'Output',
    x: 400,
    y: 0,
    width: 160,
    height: 60,
    params: {},
  })
  return graph
}

before(() => {
  ensureDefs()
})

describe('StemCell — runtime graph mutation', () => {
  it('materializes a node that the stepwise runner executes next', async () => {
    const signal = {
      materialize: 'StaticData',
      params: { value: 'from-stem', type: 'string' },
      wire_from: '1',
      wire_to: '2',
    }
    const graph = buildStemCellFixture(signal)
    const result = await executeStepwise(graph)

    const steps = result.steps ?? []
    const classTypes = steps.map(s => s.class_type)
    assert.ok(classTypes.includes('StemCell'), 'StemCell must run')
    assert.ok(
      classTypes.includes('StaticData'),
      `new StaticData must run in a later step; got ${JSON.stringify(classTypes)}`,
    )
    assert.ok(classTypes.includes('Output'), 'Output must still run')

    const stemIdx = steps.findIndex(s => s.class_type === 'StemCell')
    const staticIdx = steps.findIndex(s => s.class_type === 'StaticData')
    assert.ok(staticIdx > stemIdx, 'StaticData must execute after StemCell')

    const stemOut = result.results.get('1')?.outputs
    assert.equal(stemOut?.graph_edit_granted, true)
    assert.equal(stemOut?.materialized_class, 'StaticData')
    assert.ok(typeof stemOut?.node_id === 'string' && stemOut.node_id.length > 0)

    const newId = String(stemOut?.node_id)
    assert.ok(graph.nodes.some(n => n.id === newId && n.class_type === 'StaticData'))
    assert.ok(result.results.has(newId), 'engine must have executed the materialized node')
    assert.equal(result.results.get(newId)?.outputs?.data, 'from-stem')
  })

  it('rejects all ops when max_mutations budget is exceeded', async () => {
    const signal = {
      ops: [
        { op: 'add_node', node: { class_type: 'StaticData', id: 'n-a', params: { value: 'a' } } },
        { op: 'add_node', node: { class_type: 'StaticData', id: 'n-b', params: { value: 'b' } } },
      ],
    }
    const graph = buildStemCellFixture(signal, { max_mutations: 1 })
    const result = await executeStepwise(graph)

    const stemOut = result.results.get('1')?.outputs
    assert.equal(stemOut?.graph_edit_granted, false)
    assert.ok(!graph.nodes.some(n => n.id === 'n-a' || n.id === 'n-b'))
    const classTypes = (result.steps ?? []).map(s => s.class_type)
    assert.deepEqual(classTypes, ['StemCell', 'Output'])
  })

  it('rejects add_node outside allowed_types', async () => {
    const signal = {
      materialize: 'ShellExec',
      params: {},
      wire_from: '1',
      wire_to: '2',
    }
    const graph = buildStemCellFixture(signal, {
      allowed_types: 'StaticData,Output',
    })
    const result = await executeStepwise(graph)

    const stemOut = result.results.get('1')?.outputs
    assert.equal(stemOut?.graph_edit_granted, false)
    assert.ok(!graph.nodes.some(n => n.class_type === 'ShellExec'))
  })

  it('passthrough when no signal or allow_graph_edit=false', async () => {
    const graph = buildStemCellFixture(undefined, { allow_graph_edit: false })
    // clear signal
    graph.nodes[0].params.differentiation_signal = undefined
    const result = await executeStepwise(graph)
    const stemOut = result.results.get('1')?.outputs
    assert.equal(stemOut?.graph_edit_granted, false)
    assert.deepEqual(stemOut?.state, { seed: true })
    assert.equal((result.steps ?? []).length, 2)
  })
})
