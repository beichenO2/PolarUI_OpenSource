/**
 * R11 批4试点 — def.fn_ref 函数化 SchemaExtract / LogicChainDecompose。
 * 真实磁盘 workflows/ + node-defs/，不走 __POLARUI_NODE_FS__ 假文件系统。
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Graph } from '../../src/engine/graph.ts'
import { executeGraph } from '../../src/engine/workflow-runner.ts'
import { registry } from '../../src/engine/registry.ts'
import type { NodeDef, NodeInstance } from '../../src/engine/types'
import '../../src/engine/executor.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const NODE_DEFS = join(ROOT, 'node-defs')

function node(partial: Partial<NodeInstance> & { id: string; class_type: string }): NodeInstance {
  return { x: 0, y: 0, width: 200, height: 100, params: {}, ...partial }
}

function loadDefsFromDisk(...relPaths: string[]): void {
  for (const rel of relPaths) {
    const defs = JSON.parse(readFileSync(join(NODE_DEFS, rel), 'utf8')) as NodeDef[]
    for (const def of defs) {
      registry.register(def)
    }
  }
}

function ensurePilotDefs(): void {
  delete (globalThis as Record<string, unknown>).__POLARUI_NODE_FS__
  loadDefsFromDisk(
    'primitives/input.json',
    'primitives/output.json',
    'functions/core.json',
  )
  if (!registry.get('StaticData')) {
    registry.register({
      class_type: 'StaticData',
      category: 'Input',
      display_name: 'StaticData',
      inputs: [{ name: 'trigger', type: 'any', optional: true }],
      outputs: [{ name: 'data', type: 'any' }],
      params: {
        value: { type: 'text' as const, default: '' },
        type: { type: 'select' as const, default: 'string' },
      },
    })
  }
}

function linearGraph(nodes: NodeInstance[], links: Graph['links']): Graph {
  const g = new Graph('pilot')
  g.nodes.push(...nodes)
  g.links.push(...links)
  return g
}

describe('R11 batch4 def.fn_ref pilot', () => {
  before(() => ensurePilotDefs())

  it('registry loads SchemaExtract fn_ref from disk core.json', () => {
    assert.equal(registry.get('SchemaExtract')?.fn_ref, 'fn-schema-extract')
    assert.equal(registry.get('LogicChainDecompose')?.fn_ref, 'fn-logic-chain-decompose')
    assert.equal(registry.get('RegexMatch')?.fn_ref, 'fn-regex-match')
  })

  it('SchemaExtract embedded JSON → outputs.parsed', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: '前缀 {"name":"polar","n":1} 后缀', type: 'string' },
        }),
        node({ id: 'se', class_type: 'SchemaExtract', params: {} }),
        node({ id: 'o1', class_type: 'Output', params: {} }),
      ],
      [
        { id: 'l1', from_node: 's1', from_slot: 0, to_node: 'se', to_slot: 0 },
        { id: 'l2', from_node: 'se', from_slot: 0, to_node: 'o1', to_slot: 0 },
      ],
    )
    const { results, unhealthy_nodes } = await executeGraph(g)
    assert.equal(unhealthy_nodes.length, 0)
    assert.deepEqual(results.get('se')?.outputs.parsed, { name: 'polar', n: 1 })
  })

  it('SchemaExtract non-JSON text → JsonParse fallback empty object', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: 'not json at all', type: 'string' },
        }),
        node({ id: 'se', class_type: 'SchemaExtract', params: {} }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'se', to_slot: 0 }],
    )
    const { results } = await executeGraph(g)
    assert.deepEqual(results.get('se')?.outputs.parsed, {})
  })

  it('LogicChainDecompose splits on 。；; and newline', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: '目标A。目标B；目标C\n目标D', type: 'string' },
        }),
        node({ id: 'lcd', class_type: 'LogicChainDecompose', params: {} }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'lcd', to_slot: 0 }],
    )
    const { results, unhealthy_nodes } = await executeGraph(g)
    assert.equal(unhealthy_nodes.length, 0)
    assert.deepEqual(results.get('lcd')?.outputs.sub_goals, [
      '目标A',
      '目标B',
      '目标C',
      '目标D',
    ])
  })

  it('TextTransform split without pattern keeps newline semantics', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: 'line1\n\nline2\r\nline3', type: 'string' },
        }),
        node({
          id: 't1',
          class_type: 'TextTransform',
          params: { operation: 'split', pattern: '' },
        }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 't1', to_slot: 0 }],
    )
    const { results } = await executeGraph(g)
    assert.deepEqual(results.get('t1')?.outputs.result, ['line1', 'line2', 'line3'])
  })

  it('LogicChainDecompose long text without delimiters → single-element array (no legacy chunk fallback)', async () => {
    const longText = '这是一段没有任何句号分号或换行分隔符的超长目标描述用于验证新契约不再做固定宽度分块'
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: longText, type: 'string' },
        }),
        node({ id: 'lcd', class_type: 'LogicChainDecompose', params: {} }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'lcd', to_slot: 0 }],
    )
    const { results } = await executeGraph(g)
    // 旧 TS executor 在 steps.length<=1 && len>40 时会 .{1,120} 分块；函数化后仅按 pattern 切分
    assert.deepEqual(results.get('lcd')?.outputs.sub_goals, [longText])
  })

  it('RegexMatch case-insensitive match via Validator flags i', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: 'hello POLAR world', type: 'string' },
        }),
        node({ id: 'rm', class_type: 'RegexMatch', params: { pattern: 'polar' } }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'rm', to_slot: 0 }],
    )
    const { results, unhealthy_nodes } = await executeGraph(g)
    assert.equal(unhealthy_nodes.length, 0)
    assert.equal(results.get('rm')?.outputs.matched, true)
  })

  it('RegexMatch no match returns matched false', async () => {
    const g = linearGraph(
      [
        node({
          id: 's1',
          class_type: 'StaticData',
          params: { value: 'hello POLAR world', type: 'string' },
        }),
        node({ id: 'rm', class_type: 'RegexMatch', params: { pattern: 'xyz\\d+' } }),
      ],
      [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'rm', to_slot: 0 }],
    )
    const { results, unhealthy_nodes } = await executeGraph(g)
    assert.equal(unhealthy_nodes.length, 0)
    assert.equal(results.get('rm')?.outputs.matched, false)
  })

  it('ToolCall/RetryLoop internal_workflow drill-down defs without fn_ref hijack', async () => {
    const toolCall = registry.get('ToolCall')
    const retryLoop = registry.get('RetryLoop')
    assert.equal(toolCall?.internal_workflow, 'toolcall-internal')
    assert.equal(toolCall?.expandable, true)
    assert.equal(toolCall?.fn_ref, undefined)
    assert.equal(retryLoop?.internal_workflow, 'retryloop-internal')
    assert.equal(retryLoop?.expandable, true)
    assert.equal(retryLoop?.fn_ref, undefined)

    const g = linearGraph(
      [node({ id: 'rl', class_type: 'RetryLoop', params: { max_retries: 2 } })],
      [],
    )
    const { results, unhealthy_nodes } = await executeGraph(g)
    assert.equal(unhealthy_nodes.length, 0)
    const out = results.get('rl')
    assert.ok(out)
    assert.equal(out.error, undefined)
    assert.equal(out.outputs.passed, false)
    assert.equal(out.outputs.exhausted, false)
    assert.equal(out.outputs.should_retry, true)
  })
})
