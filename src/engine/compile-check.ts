/**
 * IDE 编译检查 — 与 cli/compile-check.mjs 规则对齐（Graph 侧）。
 */
import type { Graph } from './graph'
import { registry } from './registry'
import { validateRoutingBranches } from './routing-branch-check'
import { validateGraphWiring, WIRING_EXEMPT_CLASS_TYPES } from './wire-integrity'
import { validateLlmValidatorRetryLoops } from './llm-verify-retry-check'
import { validateExpectedOutputBlocks } from './expected-output-schema'

export interface CompileCheckResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface CompileChecklistItem {
  level: 'error' | 'warning'
  message: string
  nodeId?: string
}

const NODE_ID_RE = /组件 "([^"]+)"/

export function compileChecklistItems(result: CompileCheckResult): CompileChecklistItem[] {
  const items: CompileChecklistItem[] = []
  for (const message of result.errors) {
    items.push({ level: 'error', message, nodeId: NODE_ID_RE.exec(message)?.[1] })
  }
  for (const message of result.warnings) {
    items.push({ level: 'warning', message, nodeId: NODE_ID_RE.exec(message)?.[1] })
  }
  return items
}

export function compileCheckGraph(graph: Graph | null): CompileCheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!graph?.nodes.length) {
    return { valid: true, errors, warnings }
  }

  const nodeIds = new Set(graph.nodes.map(n => n.id))

  for (const node of graph.nodes) {
    if (!node.class_type) {
      errors.push(`组件 "${node.id}": 缺少 class_type`)
      continue
    }

    const def = registry.get(node.class_type)
    if (!def) {
      errors.push(`组件 "${node.id}": 未知类型 "${node.class_type}" — 未在组件库注册`)
      continue
    }

    if (def.palette_hidden) {
      errors.push(
        `组件 "${node.id}": "${node.class_type}" 为 Internal 组件（palette_hidden），工作流不可使用`,
      )
    } else if (def.category?.startsWith('Internal/')) {
      errors.push(`组件 "${node.id}": "${node.class_type}" 属于 Internal 分类，工作流不可使用`)
    }

    if (node.class_type === 'PromptInput') {
      const eo = node.params?.expected_output ?? node.params?.expected_pattern
      const blockCheck = validateExpectedOutputBlocks(eo)
      if (!blockCheck.valid) {
        errors.push(`组件 "${node.id}" (PromptInput): ${blockCheck.message}`)
      }
      const content = String(node.params?.content ?? node.params?.prompt_text ?? '').trim()
      if (!content) {
        warnings.push(`组件 "${node.id}" (PromptInput): content 为空，执行前请填写任务描述`)
      } else if (/描述要从原模型分化出的/i.test(content)) {
        warnings.push(`组件 "${node.id}" (PromptInput): content 仍为占位文案，请改为可执行任务`)
      }
    }
  }

  for (const link of graph.links) {
    if (!nodeIds.has(link.from_node)) {
      errors.push(`连线: 源组件 "${link.from_node}" 不存在`)
    }
    if (!nodeIds.has(link.to_node)) {
      errors.push(`连线: 目标组件 "${link.to_node}" 不存在`)
    }
    if (typeof link.from_slot !== 'number' || link.from_slot < 0) {
      warnings.push(`连线 "${link.id}": 源槽位 ${link.from_slot} 可能无效`)
    }
    if (typeof link.to_slot !== 'number' || link.to_slot < 0) {
      warnings.push(`连线 "${link.id}": 目标槽位 ${link.to_slot} 可能无效`)
    }
  }

  const wiring = validateGraphWiring(graph)
  errors.push(...wiring.errors)

  const routing = validateRoutingBranches(graph)
  errors.push(...routing.errors)

  errors.push(...validateLlmValidatorRetryLoops(graph))

  for (const node of graph.nodes) {
    if (WIRING_EXEMPT_CLASS_TYPES.has(node.class_type)) continue
    if (!registry.get(node.class_type)) continue
    const connected = graph.links.some(l => l.from_node === node.id || l.to_node === node.id)
    if (!connected && graph.nodes.length > 1) {
      warnings.push(`组件 "${node.id}" (${node.class_type}): 孤立组件，无连线`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

export function formatCompileCheckMessage(result: CompileCheckResult, maxLines = 12): string {
  if (result.valid && result.warnings.length === 0) {
    return '编译检查通过，未发现错误。'
  }
  const lines: string[] = []
  if (result.errors.length) {
    lines.push(`错误 (${result.errors.length}):`)
    for (const e of result.errors.slice(0, maxLines)) lines.push(`  • ${e}`)
    if (result.errors.length > maxLines) {
      lines.push(`  …还有 ${result.errors.length - maxLines} 处错误`)
    }
  }
  if (result.warnings.length) {
    lines.push(`警告 (${result.warnings.length}):`)
    for (const w of result.warnings.slice(0, maxLines)) lines.push(`  • ${w}`)
    if (result.warnings.length > maxLines) {
      lines.push(`  …还有 ${result.warnings.length - maxLines} 处警告`)
    }
  }
  return lines.join('\n')
}
