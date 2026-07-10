/**
 * WorkflowMeta 画中画执行：沙箱内 LLM 修改工作流 → 验证 → 审批/回退
 */
import { Graph } from './graph'
import { loadWorkflowJson } from './loader'
import { executeNode, type ExecutionContext, type ExecutionResult } from './executor'
import { getLLMClient } from '../sdk/llm-proxy'

export interface MetaExecuteOptions {
  sandbox: boolean
  requireApproval: boolean
  maxChanges: number
}

export interface MetaExecuteResult {
  modified_workflow: Record<string, unknown>
  accepted: boolean
  sandbox_graph?: Graph
  change_count: number
  analysis?: string
  dry_run_ok?: boolean
}

interface WorkflowPatch {
  action: 'update_params' | 'replace_class_type' | 'remove_node'
  node_id: string
  params?: Record<string, unknown>
  class_type?: string
}

function cloneWorkflow(wf: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(wf))
}

async function proposePatches(
  issue: string,
  workflow: Record<string, unknown>,
  maxChanges: number
): Promise<{ patches: WorkflowPatch[]; analysis: string }> {
  const prompt = `你是 Master 工作流架构师。根据问题报告，对以下 PolarUI 工作流 JSON 提出最多 ${maxChanges} 处修改。

问题报告：
${issue}

当前工作流（API 格式）：
${JSON.stringify(workflow, null, 2)}

只输出 JSON（无 markdown）：
{
  "analysis": "简要分析",
  "patches": [
    { "action": "update_params", "node_id": "3", "params": { "temperature": 0.2 } },
    { "action": "replace_class_type", "node_id": "5", "class_type": "ContentRender" },
    { "action": "remove_node", "node_id": "9" }
  ]
}`

  const raw = await getLLMClient().chat(
    'GLM-5.1',
    [
      { role: 'system', content: '你是 Polarisor 工作流修改器。输出纯 JSON。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3, timeoutMs: 120_000 }
  )

  const content = raw.content.trim()
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { patches: [], analysis: content.slice(0, 500) }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { analysis?: string; patches?: WorkflowPatch[] }
    return {
      analysis: String(parsed.analysis ?? ''),
      patches: (parsed.patches ?? []).slice(0, maxChanges),
    }
  } catch {
    return { patches: [], analysis: content.slice(0, 500) }
  }
}

function applyPatches(
  workflow: Record<string, unknown>,
  patches: WorkflowPatch[]
): { workflow: Record<string, unknown>; count: number } {
  const out = cloneWorkflow(workflow)
  let count = 0

  for (const p of patches) {
    const node = out[p.node_id] as Record<string, unknown> | undefined
    if (!node || typeof node !== 'object') continue

    if (p.action === 'remove_node') {
      delete out[p.node_id]
      count++
      continue
    }
    if (p.action === 'replace_class_type' && p.class_type) {
      node.class_type = p.class_type
      count++
      continue
    }
    if (p.action === 'update_params' && p.params) {
      const inputs = (node.inputs as Record<string, unknown>) ?? {}
      node.inputs = { ...inputs, ...p.params }
      count++
    }
  }

  return { workflow: out, count }
}

/** 在沙箱图上试运行前 N 个节点 */
export async function dryRunSandbox(
  graph: Graph,
  maxNodes = 5
): Promise<{ results: Map<string, ExecutionResult>; ok: boolean }> {
  const results = new Map<string, ExecutionResult>()
  const ctx: ExecutionContext = {
    getNodeOutput: (id, slot) => {
      const r = results.get(id)
      if (!r) return undefined
      const keys = Object.keys(r.outputs)
      return r.outputs[keys[slot] ?? keys[0]]
    },
    allResults: results,
    links: graph.links,
    role: 'master',
    agentId: 'meta-executor',
  }

  let ok = true
  for (const node of graph.nodes.slice(0, maxNodes)) {
    const result = await executeNode(node, ctx)
    results.set(node.id, result)
    if (result.error) ok = false
  }
  return { results, ok }
}

export async function executeWorkflowMeta(
  currentWorkflow: Record<string, unknown>,
  issueReport: string,
  opts: MetaExecuteOptions
): Promise<MetaExecuteResult> {
  const original = cloneWorkflow(currentWorkflow)

  if (!issueReport.trim()) {
    return {
      modified_workflow: original,
      accepted: false,
      change_count: 0,
      analysis: 'empty issue_report',
      dry_run_ok: false,
    }
  }

  const { patches, analysis } = await proposePatches(issueReport, original, opts.maxChanges)
  const { workflow: patched, count } = applyPatches(original, patches)

  let sandboxGraph: Graph | undefined
  let dryRunOk = false

  try {
    sandboxGraph = loadWorkflowJson(JSON.stringify(patched))
    const dry = await dryRunSandbox(sandboxGraph, 5)
    dryRunOk = dry.ok
  } catch (err) {
    return {
      modified_workflow: original,
      accepted: false,
      change_count: 0,
      analysis: `${analysis}\n沙箱加载失败: ${err instanceof Error ? err.message : String(err)}`,
      dry_run_ok: false,
    }
  }

  if (!opts.sandbox) {
    return {
      modified_workflow: patched,
      accepted: dryRunOk && !opts.requireApproval,
      sandbox_graph: sandboxGraph,
      change_count: count,
      analysis,
      dry_run_ok: dryRunOk,
    }
  }

  const accepted = dryRunOk && count > 0 && !opts.requireApproval

  return {
    modified_workflow: accepted ? patched : original,
    accepted,
    sandbox_graph: sandboxGraph,
    change_count: count,
    analysis,
    dry_run_ok: dryRunOk,
  }
}
