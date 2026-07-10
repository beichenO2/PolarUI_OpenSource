/**
 * 接线完整性校验：必填输入须连接；输出不要求接 Ground（已移除）。
 */
import type { Graph } from './graph'
import type { NodeInstance } from './types'
import { registry } from './registry'

export interface WiringIssue {
  nodeId: string
  slot: number
  direction: 'input' | 'output'
  slotName: string
  nodeLabel: string
}

export interface WiringValidationResult {
  valid: boolean
  errors: string[]
  issues: WiringIssue[]
}

/** 不参与「必须接线」规则的节点 */
export const WIRING_EXEMPT_CLASS_TYPES = new Set(['NoteCard'])

/**
 * 后台蒸馏采集会读取的输出槽：画布上可不画下游线，
 * 不标红圈。只列输出侧。
 */
export const DISTILL_SINK_OUTPUTS: Readonly<Record<string, readonly string[]>> = {
  LLM: ['usage'],
  VLM: ['usage'],
}

export function isDistillSinkOutput(classType: string, outputName: string): boolean {
  const names = DISTILL_SINK_OUTPUTS[classType]
  return names != null && names.includes(outputName)
}

export function isWiringCheckNode(node: NodeInstance): boolean {
  if (WIRING_EXEMPT_CLASS_TYPES.has(node.class_type)) return false
  return !!registry.get(node.class_type)
}

export function validateGraphWiring(graph: Graph): WiringValidationResult {
  const errors: string[] = []
  const issues: WiringIssue[] = []

  for (const node of graph.nodes) {
    if (!isWiringCheckNode(node)) continue
    const def = registry.get(node.class_type)!
    const label = def.display_name || node.class_type

    for (let i = 0; i < def.inputs.length; i++) {
      const inp = def.inputs[i]
      if (inp.optional) continue
      const linked = graph.links.some(l => l.to_node === node.id && l.to_slot === i)
      if (!linked) {
        const name = inp.name
        errors.push(`「${label}」输入「${name}」未连接`)
        issues.push({ nodeId: node.id, slot: i, direction: 'input', slotName: name, nodeLabel: label })
      }
    }
  }

  return { valid: errors.length === 0, errors, issues }
}

export function formatWiringErrors(result: WiringValidationResult, maxLines = 10): string {
  if (result.valid) return ''
  const lines = result.errors.slice(0, maxLines)
  if (result.errors.length > maxLines) {
    lines.push(`…还有 ${result.errors.length - maxLines} 处未连接`)
  }
  return lines.join('\n')
}
