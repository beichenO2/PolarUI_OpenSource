/**
 * 用户回存的自定义 Agent Take 节点定义（R8）
 */
import type { NodeDef } from './types'
import { registry } from './registry'

const STORAGE_KEY = 'polarui_custom_agents_v1'

export interface CustomAgentRecord {
  class_type: string
  display_name: string
  description: string
  internal_workflow: string
  source_class_type?: string
  created_at: number
}

function readAll(): CustomAgentRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as CustomAgentRecord[]
  } catch {
    return []
  }
}

function writeAll(list: CustomAgentRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

export function listCustomAgents(): CustomAgentRecord[] {
  return readAll()
}

export function buildCustomNodeDef(rec: CustomAgentRecord): NodeDef {
  return {
    class_type: rec.class_type,
    category: 'Agentic/Custom',
    display_name: rec.display_name,
    description: rec.description,
    color: '#4a5568',
    expandable: true,
    internal_workflow: rec.internal_workflow,
    inputs: [{ name: 'brief', type: 'string' }],
    outputs: [{ name: 'result', type: 'any' }],
    params: {
      expandable: { type: 'boolean', default: true, label: '可展开' },
    },
  }
}

export function registerCustomAgent(rec: CustomAgentRecord): NodeDef {
  const def = buildCustomNodeDef(rec)
  registry.registerCustom(def)
  return def
}

export function saveCustomAgent(opts: {
  display_name: string
  internal_workflow: string
  source_class_type?: string
}): CustomAgentRecord {
  const slug = opts.display_name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '_')
    .slice(0, 32)
  const class_type = `Custom_${slug}_${Date.now().toString(36)}`
  const rec: CustomAgentRecord = {
    class_type,
    display_name: opts.display_name,
    description: `自定义 Agent Take（自 ${opts.source_class_type ?? '子图'} 回存）`,
    internal_workflow: opts.internal_workflow,
    source_class_type: opts.source_class_type,
    created_at: Date.now(),
  }
  const list = readAll()
  list.push(rec)
  writeAll(list)
  registerCustomAgent(rec)
  return rec
}

export function restoreCustomAgentsFromStorage(): number {
  let n = 0
  for (const rec of readAll()) {
    registerCustomAgent(rec)
    n++
  }
  return n
}
