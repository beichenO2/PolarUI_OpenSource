/**
 * 用户自定义工作流（R8 子图回存）— localStorage 持久化
 */
import type { Workflow } from './types'

const STORAGE_KEY = 'polarui_custom_workflows_v1'

export interface CustomWorkflowRecord {
  id: string
  name: string
  workflow: Workflow
  source_class_type?: string
  created_at: number
  updated_at: number
}

function readAll(): Record<string, CustomWorkflowRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, CustomWorkflowRecord>
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, CustomWorkflowRecord>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function listCustomWorkflows(): CustomWorkflowRecord[] {
  return Object.values(readAll()).sort((a, b) => b.updated_at - a.updated_at)
}

export function getCustomWorkflow(id: string): CustomWorkflowRecord | null {
  return readAll()[id] ?? null
}

/** internal_workflow 引用：custom/<id> */
export function isCustomWorkflowRef(ref: string): boolean {
  return ref.startsWith('custom/')
}

export function customWorkflowIdFromRef(ref: string): string {
  return ref.replace(/^custom\//, '')
}

export function saveCustomWorkflow(
  name: string,
  workflow: Workflow,
  opts?: { id?: string; source_class_type?: string },
): CustomWorkflowRecord {
  const map = readAll()
  const slug =
    opts?.id ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) + `-${Date.now().toString(36)}`

  const now = Date.now()
  const existing = map[slug]
  const rec: CustomWorkflowRecord = {
    id: slug,
    name,
    workflow: { ...workflow, name, updated_at: now },
    source_class_type: opts?.source_class_type,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
  map[slug] = rec
  writeAll(map)
  return rec
}

export function deleteCustomWorkflow(id: string): boolean {
  const map = readAll()
  if (!map[id]) return false
  delete map[id]
  writeAll(map)
  return true
}

export function workflowToApiJson(wf: Workflow): Record<string, unknown> {
  const g = wf
  const result: Record<string, unknown> = { _name: wf.name }
  for (const node of g.nodes) {
    const inputs: Record<string, unknown> = { ...node.params }
    for (const link of g.links.filter(l => l.to_node === node.id)) {
      const fromNode = g.nodes.find(n => n.id === link.from_node)
      if (fromNode) {
        const defInputs = node.params
        // slot name resolution deferred — store link refs by index
        inputs[`__link_${link.to_slot}`] = [link.from_node, link.from_slot]
      }
    }
    result[node.id] = { class_type: node.class_type, inputs, params: node.params }
  }
  return result
}
