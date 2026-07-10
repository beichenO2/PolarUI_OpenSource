/**
 * 画布节点正文预览：优先展示关键参数与运行态，再展示说明文案。
 */
import type { NodeDef, NodeInstance } from './types'
import { CONTENT_AREA_HEIGHT } from './node-geometry'
import { getCachedRegistry } from './workflow-registry'

export const CONTENT_PREVIEW_LINE_PX = 18

export function maxContentPreviewLines(): number {
  return Math.max(5, Math.floor(CONTENT_AREA_HEIGHT / CONTENT_PREVIEW_LINE_PX))
}

type RunSlice = { outputs?: Record<string, unknown>; error?: string } | undefined

function fmtVal(v: unknown, maxLen = 28): string {
  if (v == null) return '—'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s
}

function pushLine(lines: string[], line: string, max: number): boolean {
  if (lines.length >= max || !line.trim()) return lines.length >= max
  lines.push(line)
  return lines.length >= max
}

function highlightParams(
  node: NodeInstance,
  run: RunSlice,
  max: number,
  lines: string[],
): void {
  const p = node.params || {}
  const o = run?.outputs ?? {}

  switch (node.class_type) {
    case 'LLM':
    case 'ToolCall':
    case 'VLM':
      pushLine(lines, `模型: ${fmtVal(p.model ?? 'GLM-5.1')}`, max)
      if (p.temperature != null) pushLine(lines, `温度: ${p.temperature}`, max)
      if (p.stream) pushLine(lines, '流式: 开', max)
      break
    case 'RetryLoop':
      pushLine(lines, `上限: ${p.max_retries ?? 7} 轮`, max)
      if (o.attempt != null) pushLine(lines, `当前: 第 ${o.attempt} 轮`, max)
      if (o.exhausted === true) pushLine(lines, '状态: 已用尽', max)
      else if (o.passed === true) pushLine(lines, '状态: 已通过', max)
      break
    case 'ForLoop':
      if (p.parallel) pushLine(lines, `并行 · 并发 ${p.max_concurrent ?? 3}`, max)
      if (o.index != null && o.count != null) {
        pushLine(lines, `进度: ${Number(o.index) + 1}/${o.count}`, max)
      } else if (o.count != null) {
        pushLine(lines, `条目: ${o.count} 项`, max)
      }
      break
    case 'WhileLoop':
      pushLine(lines, `最大迭代: ${p.max_iterations ?? 10}`, max)
      if (p.condition_expr && String(p.condition_expr).trim()) {
        pushLine(lines, `终止: ${fmtVal(p.condition_expr, 22)}`, max)
      }
      if (o.iterations != null) pushLine(lines, `已跑: ${o.iterations} 次`, max)
      break
    case 'SampleLoop':
      pushLine(lines, `抽样: ${p.sample_count ?? p.n ?? '?'} 次`, max)
      break
    case 'Switch': {
      let n = 0
      try {
        const cases = JSON.parse(String(p.cases ?? '[]'))
        if (Array.isArray(cases)) n = cases.length
      } catch { /* */ }
      pushLine(lines, `分支: ${n} 路`, max)
      break
    }
    case 'Condition':
      if (p.expression && String(p.expression).trim()) {
        pushLine(lines, `条件: ${fmtVal(p.expression, 24)}`, max)
      }
      break
    case 'Validator':
      if (p.purpose) pushLine(lines, `用途: ${fmtVal(p.purpose, 20)}`, max)
      if (p.expected_pattern) pushLine(lines, `期望: ${fmtVal(p.expected_pattern, 18)}`, max)
      break
    case 'StaticData': {
      const raw = p.value ?? p.data ?? '{}'
      const preview = typeof raw === 'string' ? raw : JSON.stringify(raw)
      pushLine(lines, `静态: ${fmtVal(preview, 36)}`, max)
      if (p.type) pushLine(lines, `类型: ${String(p.type)}`, max)
      break
    }
    case 'PromptInput':
      if (p.expected_output) pushLine(lines, `验收: ${fmtVal(p.expected_output, 20)}`, max)
      break
    case 'AgenticUnit':
      pushLine(lines, `工作: ${fmtVal(p.work_model ?? 'GLM-5.1')}`, max)
      pushLine(lines, `核验: ${fmtVal(p.verify_model ?? 'GLM-5.1')}`, max)
      pushLine(lines, `重试: ${p.max_retries ?? 7}`, max)
      break
    case 'AgenticChain':
      pushLine(lines, '串联多步 Agentic 单元', max)
      break
    default:
      break
  }
}

export function buildNodeContentPreviewLines(
  node: NodeInstance,
  def: NodeDef,
  wrap: (text: string) => string[],
  run?: RunSlice,
): string[] {
  const max = maxContentPreviewLines()
  const lines: string[] = []
  const params = node.params || {}

  highlightParams(node, run, max, lines)

  if (node.class_type === 'AgentWorkflow') {
    let desc = String(params.workflow_description ?? '').trim()
    if (!desc && params.workflow_id) {
      desc = getCachedRegistry().find(w => w.id === params.workflow_id)?.description?.trim() ?? ''
    }
    if (!desc) desc = String(def.description ?? '').trim()
    const descBudget = Math.max(1, max - lines.length - 1)
    for (const w of wrap(desc).slice(0, descBudget)) pushLine(lines, w, max)
    if (params.workflow_id) pushLine(lines, `ID: ${fmtVal(params.workflow_id, 24)}`, max)
    return lines.slice(0, max)
  }

  if (node.class_type === 'SSoT_Project') {
    if (params.tier) pushLine(lines, `层级: ${params.tier}`, max)
    if (params.status) pushLine(lines, `状态: ${params.status}`, max)
    if (params.description) for (const w of wrap(String(params.description)).slice(0, 2)) pushLine(lines, w, max)
    return lines.slice(0, max)
  }
  if (node.class_type === 'SSoT_Requirement') {
    if (params.featureCount != null) {
      pushLine(lines, `功能: ${params.featureDone ?? 0}/${params.featureCount}`, max)
    }
    if (params.approach) for (const w of wrap(String(params.approach)).slice(0, max - lines.length)) pushLine(lines, w, max)
    return lines.slice(0, max)
  }
  if (node.class_type === 'SSoT_Feature' && params.description) {
    for (const w of wrap(String(params.description)).slice(0, max)) pushLine(lines, w, max)
    return lines.slice(0, max)
  }

  const priorityFields = ['goal', 'prompt', 'content', 'query', 'command', 'message', 'target', 'name', 'need']
  for (const field of priorityFields) {
    if (lines.length >= max) break
    if (field in params && params[field]) {
      for (const w of wrap(String(params[field]))) {
        if (pushLine(lines, w, max)) break
      }
    }
  }

  if (lines.length < max) {
    const infoFields = ['model', 'strategy', 'mode', 'max_retries', 'max_iterations']
    for (const field of infoFields) {
      if (field in params && params[field] != null && !lines.some(l => l.startsWith(field))) {
        pushLine(lines, `${field}: ${fmtVal(params[field])}`, max)
      }
    }
  }

  if (lines.length < max && def.description) {
    for (const w of wrap(def.description).slice(0, max - lines.length)) {
      pushLine(lines, w, max)
    }
  }

  return lines.slice(0, max)
}
