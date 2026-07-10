import type { Graph } from './graph'
import type { NodeDef, NodeInstance } from './types'
import type { ExecutionState } from './types'
import { registry } from './registry'
import { formatLinkPayloadPreview, getLinkPayload } from './link-payload'
import { extractExecutorSource } from './executor-source'

export interface ComponentIoRow {
  name: string
  type: string
  optional?: boolean
  slotDescription: string
  connected: boolean
  sourceHint: string
  valuePreview: string
}

export interface ComponentInputRow {
  name: string
  type: string
  optional?: boolean
  /** 来自 node-def.inputs[].description，对标 VS 参数说明 */
  slotDescription: string
  connected: boolean
  sourceHint: string
  valuePreview: string
}

export interface ComponentNextStep {
  linkId: string
  toNodeId: string
  label: string
  wireLabel: string
}

export type ComponentStatusKind = 'idle' | 'running' | 'ok' | 'error'

export function componentStatusFor(
  componentId: string,
  execution: Pick<ExecutionState, 'status' | 'current_node' | 'results'>,
): { kind: ComponentStatusKind; text: string } {
  if (execution.status === 'running' && execution.current_node === componentId) {
    return { kind: 'running', text: '执行中' }
  }
  const r = execution.results?.[componentId]
  if (r?.error) return { kind: 'error', text: '上次执行失败' }
  if (r) return { kind: 'ok', text: '上次执行成功' }
  return { kind: 'idle', text: '待执行' }
}

export function buildComponentInputRows(
  graph: Graph,
  component: NodeInstance,
  def: NodeDef,
  results?: ExecutionState['results'],
): ComponentInputRow[] {
  return def.inputs.map((inp, slot) => {
    const slotDescription =
      inp.description?.trim()
      || inp.label?.trim()
      || `${inp.name}（${inp.type}）`
    const link = graph.links.find(l => l.to_node === component.id && l.to_slot === slot)
    if (!link) {
      return {
        name: inp.name,
        type: inp.type,
        optional: inp.optional,
        slotDescription,
        connected: false,
        sourceHint: inp.optional ? '可选 · 未连线' : '未连线',
        valuePreview: '—',
      }
    }
    const fromNode = graph.nodes.find(n => n.id === link.from_node)
    const fromDef = fromNode ? registry.get(fromNode.class_type) : undefined
    const outName = fromDef?.outputs[link.from_slot]?.name ?? `#${link.from_slot}`
    const payload = getLinkPayload(link, graph.nodes, results)
    return {
      name: inp.name,
      type: inp.type,
      optional: inp.optional,
      slotDescription,
      connected: true,
      sourceHint: `${fromDef?.display_name ?? link.from_node} · ${outName}`,
      valuePreview: formatLinkPayloadPreview(payload, 1200),
    }
  })
}

export function buildComponentOutputRows(
  graph: Graph,
  component: NodeInstance,
  def: NodeDef,
  results?: ExecutionState['results'],
): ComponentIoRow[] {
  const last = results?.[component.id]
  return def.outputs.map((out, slot) => {
    const slotDescription =
      out.description?.trim()
      || out.label?.trim()
      || `${out.name}（${out.type}）`
    const linked = graph.links.some(l => l.from_node === component.id && l.from_slot === slot)
    const val = last?.outputs?.[out.name]
    return {
      name: out.name,
      type: out.type,
      optional: out.optional,
      slotDescription,
      connected: linked,
      sourceHint: linked ? '已有下游连线' : '可悬空（如 usage 蒸馏）',
      valuePreview: formatLinkPayloadPreview(val, 1200),
    }
  })
}

export function buildComponentNextSteps(
  graph: Graph,
  componentId: string,
  def: NodeDef | null,
): ComponentNextStep[] {
  return graph.links
    .filter(l => l.from_node === componentId)
    .map(l => {
      const to = graph.nodes.find(n => n.id === l.to_node)
      const toDef = to ? registry.get(to.class_type) : undefined
      const outName = def?.outputs[l.from_slot]?.name ?? `#${l.from_slot}`
      const inName = toDef?.inputs[l.to_slot]?.name ?? `#${l.to_slot}`
      return {
        linkId: l.id,
        toNodeId: l.to_node,
        label: toDef?.display_name ?? to?.class_type ?? l.to_node,
        wireLabel: `${outName} → ${inName}`,
      }
    })
}

export function executorSnippetReadonly(classType: string): string {
  const block = extractExecutorSource(classType)
  if (block) {
    const lines = block.split('\n')
    const preview = lines.length > 24 ? [...lines.slice(0, 22), '  // …', '  // 📖 查看完整实现'].join('\n') : block
    return preview
  }
  return [
    `// ${classType} — 未找到 registerExecutor 块`,
    '// 完整列表见 PolarUI/src/engine/executor.ts',
  ].join('\n')
}

function formatRegistryDocHeader(classType: string): string {
  const def = registry.get(classType)
  if (!def) return ''
  const lines = [
    '/**',
    ` * ${def.display_name}`,
    ` * ${def.description ?? ''}`,
  ]
  for (const inp of def.inputs) {
    const doc = inp.description || inp.label || inp.type
    lines.push(` * @param inputs.${inp.name} ${doc}`)
  }
  for (const out of def.outputs) {
    const doc = out.description || out.label || out.type
    lines.push(` * @returns outputs.${out.name} ${doc}`)
  }
  lines.push(' */', '')
  return lines.join('\n')
}

/** 全组件：registry 注释头 + executor 源码块（无块时仅头） */
export function executorSourceDocument(classType: string): string {
  const header = formatRegistryDocHeader(classType)
  const block = extractExecutorSource(classType)
  if (block) return `${header}${block}`
  if (header) return `${header}// （executor.ts 中无独立 registerExecutor 块，可能为内联或 meta 执行）`
  return `// 未找到 ${classType}\n// 请在 executor.ts / node-defs 中搜索`
}
