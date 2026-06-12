/**
 * Workflow Registry — loads registered workflows from registry.json
 * and provides search/access for the UI.
 * 
 * Workflows are registered via CLI: node cli/register-workflow.mjs <file>
 * The registry.json file is the source of truth.
 */

import type { NodeDef, WorkflowLibrary } from './types'
import { registry } from './registry'

export function isAgenticNodeCategory(category: string): boolean {
  return category === 'Agentic' || category.startsWith('Agentic/')
}

export interface WorkflowEntry {
  id: string
  name: string
  description: string
  category: string
  nodeCount: number
  file: string
  library?: WorkflowLibrary
  registeredAt: string
  updatedAt: string
  /** 范式组件：拖拽/展示用 class_type（SSOT 在 registry.json 的 node_def） */
  paradigm_class_type?: string
  node_def?: NodeDef
  skills_ref?: string
}

let cache: WorkflowEntry[] | null = null

export async function loadRegistry(): Promise<WorkflowEntry[]> {
  if (cache) return cache
  try {
    const res = await fetch('/workflows/registry.json', { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      cache = await res.json() as WorkflowEntry[]
      for (const entry of cache) {
        const def = entry.node_def as NodeDef | undefined
        if (def?.class_type && !registry.get(def.class_type)) {
          registry.register(def)
        }
      }
      return cache
    }
  } catch { /* not available */ }
  return []
}

export function getCachedRegistry(): WorkflowEntry[] {
  return cache || []
}

export function filterRegistryByLibrary(entries: WorkflowEntry[], library: WorkflowLibrary): WorkflowEntry[] {
  return entries.filter(e => (e.library ?? 'WF') === library)
}

export function isParadigmRegistryEntry(entry: WorkflowEntry): boolean {
  return !!entry.paradigm_class_type || entry.id.startsWith('paradigm-')
}

export function classTypeFromRegistryEntry(entry: WorkflowEntry): string | null {
  if (entry.paradigm_class_type) return entry.paradigm_class_type
  if (entry.id.startsWith('paradigm-')) return entry.id.slice('paradigm-'.length) || null
  return null
}

/** 已注册列表（含 paradigm 条目）；Skill 库单独过滤 */
export function filterRegistryPaletteEntries(
  entries: WorkflowEntry[],
  _library?: WorkflowLibrary,
): WorkflowEntry[] {
  return entries.filter(e => (e.library as string | undefined) !== 'Skill')
}

export function searchWorkflows(query: string, library?: WorkflowLibrary): WorkflowEntry[] {
  let entries = getCachedRegistry()
  if (library) entries = filterRegistryByLibrary(entries, library)
  if (!query) return entries
  const q = query.toLowerCase()
  return entries.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.category.toLowerCase().includes(q)
  )
}

export async function loadWorkflowFile(entry: WorkflowEntry): Promise<string | null> {
  try {
    const res = await fetch(`/workflows/${entry.file}`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) return await res.text()
  } catch { /* not available */ }
  return null
}

