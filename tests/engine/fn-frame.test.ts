/**
 * R11 fn 调用帧 golden — 函数 = 带签名子图，递归 executeGraph 不分叉引擎。
 * 覆盖：内联 subgraph / fn_ref 磁盘引用 / def.fn_ref 回退 / 签名槽映射 /
 * 入参注入 / 深度护栏 / 非 fn 节点零扰动 / API 格式 round-trip。
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../../src/engine/graph.ts'
import { loadWorkflowJson } from '../../src/engine/loader.ts'
import { executeGraph } from '../../src/engine/workflow-runner.ts'
import { registry } from '../../src/engine/registry.ts'
import { resolveFnTarget, MAX_FN_DEPTH } from '../../src/engine/fn-frame.ts'
import type { NodeInstance, Workflow } from '../../src/engine/types'
import '../../src/engine/executor.ts' // register builtins

function ensureDefs(): void {
  const defs = [
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
      class_type: 'PromptInput',
      category: 'Input',
      display_name: 'PromptInput',
      inputs: [],
      outputs: [
        { name: 'prompt', type: 'string' },
        { name: 'expected_pattern', type: 'string' },
        { name: 'context', type: 'object' },
        { name: 'channel', type: 'string' },
      ],
      params: { prompt_text: { type: 'text' as const, default: '' } },
    },
    {
      class_type: 'Output',
      category: 'Output',
      display_name: 'Output',
      inputs: [{ name: 'content', type: 'any', optional: true }],
      outputs: [],
      params: {},
    },
    // fn 宿主：一个声明了输出签名的空白函数节点（无注册执行器 → 必须走调用帧）
    {
      class_type: 'FnHostTest',
      category: 'Tools',
      display_name: 'Fn 宿主',
      inputs: [{ name: 'input', type: 'any', optional: true }],
      outputs: [
        { name: 'result', type: 'any' },
        { name: 'extra', type: 'any' },
      ],
      params: {},
    },
    // def 级 fn_ref 宿主（批4 def 迁移面）
    {
      class_type: 'FnDefRefTest',
      category: 'Tools',
      display_name: 'Fn def 引用',
      inputs: [],
      outputs: [{ name: 'result', type: 'any' }],
      params: {},
      fn_ref: 'fn-const',
    },
  ]
  for (const def of defs) {
    if (!registry.get(def.class_type)) registry.register(def)
  }
}

function node(partial: Partial<NodeInstance> & { id: string; class_type: string }): NodeInstance {
  return { x: 0, y: 0, width: 200, height: 100, params: {}, ...partial }
}

/** 子图：StaticData(value) → Output —— 返回常量的最小函数体 */
function constWorkflow(value: string): Workflow {
  return {
    id: 'wf_const',
    name: 'fn-const',
    nodes: [
      node({ id: 's1', class_type: 'StaticData', params: { value, type: 'string' } }),
      node({ id: 'o1', class_type: 'Output', params: {} }),
    ],
    links: [{ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'o1', to_slot: 0 }],
    created_at: 0,
    updated_at: 0,
  }
}

/** 子图：PromptInput({input} 模板) → Output —— 验证入参注入 */
function echoWorkflow(): Workflow {
  return {
    id: 'wf_echo',
    name: 'fn-echo',
    nodes: [
      node({ id: 'p1', class_type: 'PromptInput', params: { prompt_text: 'echo:{input}' } }),
      node({ id: 'o1', class_type: 'Output', params: {} }),
    ],
    links: [{ id: 'l1', from_node: 'p1', from_slot: 0, to_node: 'o1', to_slot: 0 }],
    created_at: 0,
    updated_at: 0,
  }
}

/** 宿主图：单个 fn 节点（inline subgraph 或 fn_ref） */
function hostGraph(fnNode: NodeInstance): Graph {
  const g = new Graph('fn-host')
  g.nodes.push(fnNode)
  return g
}

/** 把 fn 引用体注入 workflow-loader 的 __POLARUI_NODE_FS__ 假文件系统 */
function installFakeWorkflowFs(files: Record<string, Workflow | Record<string, unknown>>): void {
  ;(globalThis as Record<string, unknown>).__POLARUI_NODE_FS__ = {
    existsSync: (p: string) => Object.keys(files).some(name => String(p).endsWith(`/${name}.json`)),
    readFileSync: (p: string) => {
      const hit = Object.keys(files).find(name => String(p).endsWith(`/${name}.json`))
      if (!hit) throw new Error(`fake fs miss: ${p}`)
      return JSON.stringify(files[hit])
    },
  }
}

describe('R11 fn call frame', () => {
  before(() => ensureDefs())

  it('inline subgraph executes as call frame; first declared slot gets merged_output', async () => {
    const fn = node({ id: 'f1', class_type: 'FnHostTest', subgraph: constWorkflow('CONST_42') })
    const { results, unhealthy_nodes } = await executeGraph(hostGraph(fn))
    assert.equal(unhealthy_nodes.length, 0)
    assert.equal(results.get('f1')?.outputs.result, 'CONST_42')
  })

  it('inline subgraph is deep-copied — stored workflow params never mutated', async () => {
    const wf = echoWorkflow()
    const fn = node({ id: 'f1', class_type: 'FnHostTest', subgraph: wf, params: { input: 'X' } })
    await executeGraph(hostGraph(fn))
    assert.equal(
      wf.nodes[0].params.prompt_text,
      'echo:{input}',
      'inline subgraph 原件被执行污染（应深拷贝）',
    )
  })

  it('external inputs inject into subgraph PromptInput placeholders', async () => {
    const fn = node({ id: 'f1', class_type: 'FnHostTest', subgraph: echoWorkflow(), params: { input: 'hello' } })
    const { results } = await executeGraph(hostGraph(fn))
    assert.equal(results.get('f1')?.outputs.result, 'echo:hello')
  })

  it('fn_ref resolves workflow from disk (injected fs) and wins over subgraph', async () => {
    installFakeWorkflowFs({ 'fn-const': constWorkflow('FROM_DISK') })
    try {
      const fn = node({
        id: 'f1',
        class_type: 'FnHostTest',
        fn_ref: 'fn-const',
        subgraph: constWorkflow('FROM_INLINE'),
      })
      const { results } = await executeGraph(hostGraph(fn))
      assert.equal(results.get('f1')?.outputs.result, 'FROM_DISK')
    } finally {
      delete (globalThis as Record<string, unknown>).__POLARUI_NODE_FS__
    }
  })

  it('def.fn_ref fallback makes every instance of the type a function (batch4 migration surface)', async () => {
    installFakeWorkflowFs({ 'fn-const': constWorkflow('DEF_LEVEL') })
    try {
      const fn = node({ id: 'f1', class_type: 'FnDefRefTest' })
      assert.ok(resolveFnTarget(fn), 'def.fn_ref 应被识别为函数目标')
      const { results } = await executeGraph(hostGraph(fn))
      assert.equal(results.get('f1')?.outputs.result, 'DEF_LEVEL')
    } finally {
      delete (globalThis as Record<string, unknown>).__POLARUI_NODE_FS__
    }
  })

  it('recursion depth guard rejects self-referencing fn beyond MAX_FN_DEPTH', async () => {
    // fn-loop 子图内含一个 fn_ref 指回 fn-loop 自身的节点 → 无限递归 → 深度护栏兜底
    const loopWf: Record<string, unknown> = {
      id: 'wf_loop',
      name: 'fn-loop',
      nodes: [
        node({ id: 'f1', class_type: 'FnHostTest', fn_ref: 'fn-loop' }),
        node({ id: 'o1', class_type: 'Output', params: {} }),
      ],
      links: [{ id: 'l1', from_node: 'f1', from_slot: 0, to_node: 'o1', to_slot: 0 }],
      created_at: 0,
      updated_at: 0,
    }
    installFakeWorkflowFs({ 'fn-loop': loopWf })
    try {
      const fn = node({ id: 'root', class_type: 'FnHostTest', fn_ref: 'fn-loop' })
      const { results } = await executeGraph(hostGraph(fn))
      const err = String(results.get('root')?.error ?? '')
      assert.match(err, new RegExp(`>${MAX_FN_DEPTH}`), `深度护栏未触发：${err || '(no error)'}`)
    } finally {
      delete (globalThis as Record<string, unknown>).__POLARUI_NODE_FS__
    }
  })

  it('non-fn nodes keep registered executors — zero behavior drift', async () => {
    const g = new Graph('plain')
    g.nodes.push(node({ id: 's1', class_type: 'StaticData', params: { value: 'PLAIN', type: 'string' } }))
    g.nodes.push(node({ id: 'o1', class_type: 'Output', params: {} }))
    g.links.push({ id: 'l1', from_node: 's1', from_slot: 0, to_node: 'o1', to_slot: 0 })
    const { results, merged_output } = await executeGraph(g)
    assert.equal(results.get('s1')?.outputs.data, 'PLAIN')
    assert.equal(merged_output, 'PLAIN')
    assert.equal(resolveFnTarget(g.nodes[0]), null)
  })

  it('fn_ref + inline subgraph round-trip through API format serialization', () => {
    const g = new Graph('rt')
    const fn = node({ id: '9', class_type: 'FnHostTest', fn_ref: 'fn-const', subgraph: constWorkflow('RT') })
    g.nodes.push(fn)
    const api = g.toApiFormat()
    const entry = api['9'] as { fn_ref?: string; subgraph?: Workflow }
    assert.equal(entry.fn_ref, 'fn-const')
    assert.equal(entry.subgraph?.nodes.length, 2)

    const reloaded = loadWorkflowJson(JSON.stringify(api))
    const rn = reloaded.nodes.find(n => n.class_type === 'FnHostTest')
    assert.ok(rn, 'round-trip 后 fn 节点存在')
    assert.equal(rn?.fn_ref, 'fn-const')
    assert.equal(rn?.subgraph?.nodes.length, 2)
  })
})
