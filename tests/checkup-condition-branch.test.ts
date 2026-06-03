import { describe, it, expect, beforeAll } from 'vitest'
import { Graph } from '../src/engine/graph'
import {
  markInactiveConditionBranches,
  collectBranchNodes,
} from '../src/engine/workflow-runner'
import { executeNode } from '../src/engine/executor'
import '../src/engine/executor'
import { registry } from '../src/engine/registry'
import type { NodeInstance, Link } from '../src/engine/types'

function stubNode(id: string, classType: string): NodeInstance {
  return {
    id,
    class_type: classType,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    params: {},
  }
}

function buildBranchGraph(): { graph: Graph; condId: string; trueId: string; falseId: string; mergeId: string } {
  const graph = new Graph('condition-branch-test')
  const condId = 'cond'
  const trueId = 'true-branch'
  const falseId = 'false-branch'
  const mergeId = 'merge'
  graph.nodes = [
    stubNode(condId, 'Condition'),
    stubNode(trueId, 'CheckupFixChain'),
    stubNode(falseId, 'HumanApproval'),
    stubNode(mergeId, 'CheckupReport'),
  ]
  const links: Link[] = [
    { id: 'l0', from_node: condId, from_slot: 0, to_node: trueId, to_slot: 0 },
    { id: 'l1', from_node: condId, from_slot: 1, to_node: falseId, to_slot: 0 },
    { id: 'l2', from_node: trueId, from_slot: 0, to_node: mergeId, to_slot: 0 },
    { id: 'l3', from_node: falseId, from_slot: 0, to_node: mergeId, to_slot: 1 },
  ]
  graph.links = links
  return { graph, condId, trueId, falseId, mergeId }
}

describe('markInactiveConditionBranches', () => {
  it('skips false branch when condition is true', () => {
    const { graph, condId, trueId, falseId, mergeId } = buildBranchGraph()
    const mergeNodeIds = new Set([mergeId])
    const skipped = markInactiveConditionBranches(graph, condId, true, mergeNodeIds)
    expect(skipped.has(falseId)).toBe(true)
    expect(skipped.has(trueId)).toBe(false)
    expect(skipped.has(mergeId)).toBe(false)
  })

  it('skips true branch when condition is false', () => {
    const { graph, condId, trueId, falseId, mergeId } = buildBranchGraph()
    const mergeNodeIds = new Set([mergeId])
    const skipped = markInactiveConditionBranches(graph, condId, false, mergeNodeIds)
    expect(skipped.has(trueId)).toBe(true)
    expect(skipped.has(falseId)).toBe(false)
    expect(skipped.has(mergeId)).toBe(false)
  })

  it('collectBranchNodes stops at merge nodes', () => {
    const { graph, trueId, mergeId } = buildBranchGraph()
    const branch = collectBranchNodes(graph, trueId, new Set([mergeId]))
    expect(branch.has(trueId)).toBe(true)
    expect(branch.has(mergeId)).toBe(false)
  })
})

describe('Condition executor gte/lte', () => {
  beforeAll(() => {
    if (!registry.get('Condition')) {
      registry.register({
        class_type: 'Condition',
        category: 'Control',
        display_name: 'Condition',
        description: 'test',
        color: '#000',
        inputs: [{ name: 'data', type: 'any' }],
        outputs: [
          { name: 'true_branch', type: 'any' },
          { name: 'false_branch', type: 'any' },
        ],
        params: {},
      })
    }
  })

  async function runCondition(
    value: unknown,
    operator: string,
    compare: unknown,
  ) {
    const srcId = 'src'
    const nodeId = 'c1'
    const node: NodeInstance = {
      ...stubNode(nodeId, 'Condition'),
      params: { operator, compare_value: compare },
    }
    const ctx = {
      getNodeOutput: (nid: string, slot: number) =>
        nid === srcId && slot === 0 ? value : undefined,
      allResults: new Map([
        [srcId, { outputs: { data: value }, duration_ms: 0 }],
      ]),
      links: [
        {
          id: 'in',
          from_node: srcId,
          from_slot: 0,
          to_node: nodeId,
          to_slot: 0,
        },
      ] as Link[],
    }
    return executeNode(node, ctx)
  }

  it('gte passes at boundary', async () => {
    const r = await runCondition(0.7, 'gte', 0.7)
    expect(r.outputs.result).toBe(true)
    expect(r.outputs.true_branch).toBe(0.7)
    expect(r.outputs.false_branch).toBeUndefined()
  })

  it('gte fails below threshold', async () => {
    const r = await runCondition(0.69, 'gte', 0.7)
    expect(r.outputs.result).toBe(false)
    expect(r.outputs.false_branch).toBe(0.69)
  })

  it('lte passes at boundary', async () => {
    const r = await runCondition(3, 'lte', 3)
    expect(r.outputs.result).toBe(true)
    expect(r.outputs.true_branch).toBe(3)
  })

  it('lte fails above threshold', async () => {
    const r = await runCondition(4, 'lte', 3)
    expect(r.outputs.result).toBe(false)
    expect(r.outputs.false_branch).toBe(4)
  })
})
