/**
 * ADR-013 — 项目依赖归一化 + 引用图构建
 */
import { Graph } from './graph'
import { registry } from './registry'
import { applyTopologicalLayout } from './auto-layout'
import { createGroup, type WorkflowGroup } from './graph-groups'
import type { NodeDef, NodeInstance } from './types'

export interface ProjectDep {
  project: string
  reason?: string
}

export interface ProjectMapEntry {
  name: string
  tier?: string
  status?: string
  polaris?: unknown
}

const COMMENT_SPLIT = /\s*[#—]\s*/

function ensureSsotProjectDef(): void {
  if (registry.get('SSoT_Project')) return
  const def: NodeDef = {
    class_type: 'SSoT_Project',
    category: 'ssot',
    display_name: 'SSoT Project',
    palette_hidden: true,
    inputs: [{ name: 'in', type: 'any', optional: true }],
    outputs: [{ name: 'out', type: 'any' }],
    params: {
      name: { type: 'string', default: '' },
      tier: { type: 'string', default: 'app' },
      status: { type: 'string', default: 'active' },
      label: { type: 'string', default: '' },
      description: { type: 'string', default: '' },
      version: { type: 'string', default: '' },
      reqCount: { type: 'number', default: 0 },
      missing: { type: 'boolean', default: false },
    },
  }
  registry.register(def)
}

function normalizeProjectToken(raw: string): string | null {
  const stripped = raw.split(COMMENT_SPLIT)[0]?.trim() ?? ''
  if (!stripped) return null
  const first = stripped.split('/')[0]?.trim() ?? ''
  return first || null
}

function pushDep(out: ProjectDep[], seen: Set<string>, project: string, reason?: string): void {
  if (!project || seen.has(project)) return
  seen.add(project)
  const dep: ProjectDep = { project }
  if (reason !== undefined && reason !== '') dep.reason = reason
  out.push(dep)
}

function readObjectDep(item: Record<string, unknown>): { project: string; reason?: string } | null {
  const projectRaw = item.project ?? item.name
  if (typeof projectRaw !== 'string') return null
  const project = normalizeProjectToken(projectRaw)
  if (!project) return null
  const reasonRaw = item.reason ?? item.role
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : undefined
  return { project, reason }
}

/**
 * Normalize polaris.json cross-project refs into a flat ProjectDep list.
 * Supports depends_on string[] / object[], and upstream object[] (downstream ignored).
 */
export function extractProjectDependencies(polaris: unknown): ProjectDep[] {
  if (!polaris || typeof polaris !== 'object') return []
  const obj = polaris as Record<string, unknown>
  const selfName =
    typeof obj.name === 'string' ? normalizeProjectToken(obj.name) : null

  const out: ProjectDep[] = []
  const seen = new Set<string>()

  const dependsOn = obj.depends_on
  if (Array.isArray(dependsOn)) {
    for (const item of dependsOn) {
      if (typeof item === 'string') {
        const project = normalizeProjectToken(item)
        if (!project) continue
        if (selfName && project === selfName) continue
        pushDep(out, seen, project)
      } else if (item && typeof item === 'object') {
        const parsed = readObjectDep(item as Record<string, unknown>)
        if (!parsed) continue
        if (selfName && parsed.project === selfName) continue
        pushDep(out, seen, parsed.project, parsed.reason)
      }
    }
  }

  const upstream = obj.upstream
  if (Array.isArray(upstream)) {
    for (const item of upstream) {
      if (!item || typeof item !== 'object') continue
      const parsed = readObjectDep(item as Record<string, unknown>)
      if (!parsed) continue
      if (selfName && parsed.project === selfName) continue
      pushDep(out, seen, parsed.project, parsed.reason)
    }
  }

  // downstream intentionally ignored — reverse edges expressed by peers' upstream/depends_on

  return out
}

/**
 * Build a canvas Graph of SSoT_Project nodes + dependency links.
 * Unknown targets become placeholder nodes (params.missing=true).
 * Layout via applyTopologicalLayout; groups by tier (default "other").
 */
export function buildDependencyGraph(entries: ProjectMapEntry[]): Graph {
  ensureSsotProjectDef()
  const graph = new Graph('项目引用图')

  const byName = new Map<string, NodeInstance>()

  const addProjectNode = (
    name: string,
    opts: { tier?: string; status?: string; missing?: boolean },
  ): NodeInstance | null => {
    if (byName.has(name)) return byName.get(name)!
    const node = graph.addNode('SSoT_Project', 0, 0)
    if (!node) return null
    const tier = opts.tier ?? 'other'
    const status = opts.status ?? (opts.missing ? 'missing' : 'active')
    node.params = {
      ...node.params,
      name,
      label: name,
      tier,
      status,
      missing: opts.missing === true,
    }
    node.width = 220
    node.height = 140
    byName.set(name, node)
    return node
  }

  for (const entry of entries) {
    if (!entry?.name) continue
    addProjectNode(entry.name, {
      tier: entry.tier,
      status: entry.status,
    })
  }

  for (const entry of entries) {
    if (!entry?.name) continue
    const from = byName.get(entry.name)
    if (!from) continue
    const deps = extractProjectDependencies(entry.polaris ?? { name: entry.name })
    for (const dep of deps) {
      if (dep.project === entry.name) continue
      let to = byName.get(dep.project)
      if (!to) {
        to = addProjectNode(dep.project, { missing: true, tier: 'other', status: 'missing' }) ?? undefined
      }
      if (!to) continue
      // Unique to_slot so fan-in edges are not collapsed by Graph.addLink
      const toSlot = graph.getNodeInputLinks(to.id).length
      const link = graph.addLink(from.id, 0, to.id, toSlot)
      if (link && dep.reason) {
        ;(link as { reason?: string }).reason = dep.reason
      }
    }
  }

  // Groups by tier
  const tierBuckets = new Map<string, string[]>()
  for (const node of graph.nodes) {
    const tier = String(node.params.tier ?? 'other') || 'other'
    const bucket = tierBuckets.get(tier) ?? []
    bucket.push(node.id)
    tierBuckets.set(tier, bucket)
  }
  const existing: WorkflowGroup[] = []
  for (const [tier, nodeIds] of tierBuckets) {
    if (nodeIds.length === 0) continue
    const g = createGroup({
      nodeIds,
      title: tier,
      existingGroups: existing,
      collapsed: false,
    })
    existing.push(g)
    graph.groups.push(g)
  }

  applyTopologicalLayout(graph)
  return graph
}
