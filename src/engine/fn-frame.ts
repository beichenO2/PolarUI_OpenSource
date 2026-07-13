/**
 * fn-frame.ts — R11 函数调用帧。
 *
 * 函数 = 带签名子图：node.fn_ref 指向 workflow JSON（_entry/PromptInput 为入参
 * 占位、Output 为返回值）或 node.subgraph 内联；def.fn_ref 为类型级默认（批4
 * def 迁移面）。执行器把 fn 节点当调用帧递归 executeGraph —— 同一引擎不分叉，
 * 子图自身是拓扑/步进/状态机哪种就按哪种跑。
 *
 * 防护：fnDepth 随帧 +1，超过 MAX_FN_DEPTH 判定为递归引用并报错；
 * 内联 subgraph 执行前深拷贝（injectPipelineInputs 会写 params，绝不回写原图）。
 *
 * 循环依赖说明：本模块静态面只依赖 types/registry；graph / workflow-loader /
 * workflow-runner 全部运行时动态 import（与 SubAgent/PetriDish 既有模式一致）。
 */
import type { NodeInstance, Workflow } from './types'
import type { ExecutionContext, ExecutionResult } from './executor'
import { registry } from './registry'

export const MAX_FN_DEPTH = 8

export type FnTarget =
  | { kind: 'ref'; ref: string }
  | { kind: 'inline'; workflow: Workflow }

/** 解析函数目标：实例 fn_ref > 实例 subgraph > def.fn_ref；均无则不是函数节点。 */
export function resolveFnTarget(node: NodeInstance): FnTarget | null {
  if (typeof node.fn_ref === 'string' && node.fn_ref.trim()) {
    return { kind: 'ref', ref: node.fn_ref.trim() }
  }
  if (node.subgraph && Array.isArray(node.subgraph.nodes) && node.subgraph.nodes.length > 0) {
    return { kind: 'inline', workflow: node.subgraph }
  }
  const defRef = registry.get(node.class_type)?.fn_ref
  if (typeof defRef === 'string' && defRef.trim()) {
    return { kind: 'ref', ref: defRef.trim() }
  }
  return null
}

/** 入参 = 已解析的输入槽（优先）+ 非下划线 params（模板占位可用 {name} 注入子图）。 */
function buildFnExternalInputs(
  node: NodeInstance,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const ext: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.params ?? {})) {
    if (k.startsWith('_') || v === undefined || v === null) continue
    ext[k] = v
  }
  for (const [k, v] of Object.entries(inputs)) {
    if (v !== undefined) ext[k] = v
  }
  return ext
}

/**
 * 返回值映射：按 def 声明的输出槽名装配（槽序 = outputs 键序，供 getNodeOutput
 * 按 index 取值）。首槽默认取 merged_output；其余槽按名从子图收集值/merged 对象取。
 */
function mapFnOutputs(
  node: NodeInstance,
  collected: Record<string, unknown>,
  merged: unknown,
): Record<string, unknown> {
  const declared = registry.get(node.class_type)?.outputs ?? []
  const outputs: Record<string, unknown> = {}
  const mergedObj =
    merged && typeof merged === 'object' && !Array.isArray(merged)
      ? (merged as Record<string, unknown>)
      : null

  if (declared.length === 0) {
    outputs.output = merged ?? collected.output
    return outputs
  }
  declared.forEach((slot, i) => {
    if (collected[slot.name] !== undefined) {
      outputs[slot.name] = collected[slot.name]
    } else if (mergedObj && slot.name in mergedObj) {
      outputs[slot.name] = mergedObj[slot.name]
    } else if (i === 0) {
      outputs[slot.name] = merged ?? collected.output
    }
  })
  return outputs
}

export async function executeFnFrame(
  node: NodeInstance,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
  target: FnTarget,
): Promise<ExecutionResult> {
  const start = Date.now()
  const depth = (ctx.fnDepth ?? 0) + 1
  const label = target.kind === 'ref' ? target.ref : `${node.class_type}#inline`

  if (depth > MAX_FN_DEPTH) {
    return {
      outputs: {},
      duration_ms: Date.now() - start,
      error: `fn 调用深度超限（>${MAX_FN_DEPTH}，at ${label}）：疑似函数递归引用`,
    }
  }

  let graph: import('./graph').Graph | null = null
  if (target.kind === 'inline') {
    const { Graph } = await import('./graph')
    graph = Graph.fromWorkflow(structuredClone(target.workflow))
  } else {
    const { loadWorkflowByRef } = await import('./workflow-loader')
    graph = await loadWorkflowByRef(target.ref)
  }
  if (!graph) {
    return {
      outputs: {},
      duration_ms: Date.now() - start,
      error: `fn_ref 无法解析："${label}"（workflows/ 与 custom/ 均未找到）`,
    }
  }

  const { executeGraph, collectPipelineOutputs } = await import('./workflow-runner')
  const sub = await executeGraph(graph, {
    fnDepth: depth,
    externalInputs: buildFnExternalInputs(node, inputs),
    agentId: ctx.agentId,
    role: ctx.role,
    runContext: ctx.runContext,
  })

  const collected = collectPipelineOutputs(graph, sub.results)
  const outputs = mapFnOutputs(node, collected, sub.merged_output)

  // 步进父图：merged 为对象时挂 state 槽，随 lgAccumulatedState 跨步合并
  if (
    ctx.lgAccumulatedState &&
    outputs.state === undefined &&
    sub.merged_output &&
    typeof sub.merged_output === 'object' &&
    !Array.isArray(sub.merged_output)
  ) {
    outputs.state = sub.merged_output
  }

  return {
    outputs,
    duration_ms: Date.now() - start,
    error: sub.unhealthy_nodes[0]
      ? `fn "${label}" 子图异常：${sub.unhealthy_nodes[0].class_type}#${sub.unhealthy_nodes[0].node_id} — ${sub.unhealthy_nodes[0].error}`
      : undefined,
  }
}
