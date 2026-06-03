/**
 * 结构进化自动门 — compile + 轻量 execute（非人审；须跑通再落库）
 */
import type { Graph } from './graph'
import { loadWorkflowJson } from './loader'
import { compileCheckGraph } from './compile-check'
import { executeGraph } from './workflow-runner'
import { registerExecutor, type ExecutorFn } from './executor'

export interface EvolutionGateResult {
  passed: boolean
  errors: string[]
  stages: Array<{ stage: string; ok: boolean; detail?: string }>
}

function apiJsonFromRecord(data: Record<string, unknown>): string {
  return JSON.stringify(data)
}

/**
 * 对分化产出的 API 格式工作流跑自动门（编译 + 可选 headless 试跑）。
 */
export async function runEvolutionGate(
  apiData: Record<string, unknown>,
  opts: { runExecute?: boolean } = {},
): Promise<EvolutionGateResult> {
  const stages: EvolutionGateResult['stages'] = []
  const errors: string[] = []

  let graph: Graph
  try {
    graph = loadWorkflowJson(apiJsonFromRecord(apiData))
    stages.push({ stage: 'load', ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errors.push(`load: ${msg}`)
    stages.push({ stage: 'load', ok: false, detail: msg })
    return { passed: false, errors, stages }
  }

  const compile = compileCheckGraph(graph)
  stages.push({
    stage: 'compile',
    ok: compile.valid,
    detail: compile.errors.slice(0, 3).join('; ') || undefined,
  })
  if (!compile.valid) {
    errors.push(...compile.errors)
    return { passed: false, errors, stages }
  }

  if (opts.runExecute !== false && graph.nodes.some(n => n.class_type === 'LLM')) {
    const stubLlm: ExecutorFn = async () => ({
      outputs: { output: '{"ok":true}' },
      duration_ms: 0,
    })
    registerExecutor('LLM', stubLlm)
    try {
      await executeGraph(graph, { agentId: 'evolution-gate' })
      stages.push({ stage: 'execute_smoke', ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`execute: ${msg}`)
      stages.push({ stage: 'execute_smoke', ok: false, detail: msg })
      return { passed: false, errors, stages }
    }
  }

  return { passed: errors.length === 0, errors, stages }
}
