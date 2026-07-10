import { Graph } from './graph'
import { registry } from './registry'
import { registerSsotLayoutKeys } from './layout-memory'
import { buildDependencyGraph, type ProjectMapEntry } from './project-deps'

interface PolarisJson {
  name?: string
  description?: string
  tier?: string
  status?: string
  version?: string
  requirements?: PolarisRequirement[]
}

interface PolarisRequirement {
  id?: string
  need?: string
  name?: string
  approach?: string
  features?: PolarisFeature[]
}

interface PolarisFeature {
  name?: string
  status?: string
  test_status?: string
  description?: string
  behavior?: string[]
}

interface EcosystemProject {
  name: string
  path: string
  tier: string
  status: string
  requirementCount: number
  doneCount: number
}

const KNOWN_PROJECTS = [
  'Agent_core', 'AutoOffice', 'Clock', 'KnowLever', 'PolarClaw',
  'PolarCopilot', 'PolarDesign', 'PolarMemory', 'PolarOps', 'PolarPilot',
  'PolarPort', 'PolarPrivate', 'PolarProcess', 'PolarSync', 'PolarUI',
  'SOTAgent', '_Polarisor', 'digist', 'wiki-core',
]

/**
 * Compile a polaris.json object into a PolarUI Graph with SSoT nodes laid out.
 * Each project → SSoT_Project node, each requirement → SSoT_Requirement, etc.
 */
export function compileSsotToGraph(data: Record<string, unknown>, projectName: string): Graph {
  const polaris = data as unknown as PolarisJson
  const graph = new Graph(`SSoT: ${projectName}`)

  const startX = 100
  const startY = 100
  const colSpacing = 380
  const rowSpacing = 220

  if (!registry.get('SSoT_Project')) {
    console.warn('[SSoT Compiler] SSoT nodes not registered! Available:', registry.getAll().map(n => n.class_type).join(', '))
    return graph
  }

  const requirements = polaris.requirements || []

  const projectNode = graph.addNode('SSoT_Project', startX, startY)
  if (projectNode) {
    projectNode.params = {
      name: polaris.name || projectName,
      tier: polaris.tier || 'app',
      status: polaris.status || 'active',
      description: polaris.description || '',
      version: polaris.version || '',
      reqCount: requirements.length,
    }
    projectNode.width = 260
    projectNode.height = 180
  }

  requirements.forEach((req, reqIdx) => {
    const reqX = startX + colSpacing
    const reqY = startY + reqIdx * rowSpacing * 2.5

    const reqNode = graph.addNode('SSoT_Requirement', reqX, reqY)
    if (!reqNode) return

    const features = req.features || []
    const doneFeatures = features.filter(f => f.status === 'done').length
    const needText = req.need || req.name || ''

    reqNode.params = {
      id: req.id || `R${reqIdx + 1}`,
      need: needText,
      approach: req.approach || '',
      featureCount: features.length,
      featureDone: doneFeatures,
    }
    reqNode.width = 280
    reqNode.height = 180

    if (projectNode) {
      graph.addLink(projectNode.id, 0, reqNode.id, 0)
    }

    features.forEach((feat, featIdx) => {
      const featX = reqX + colSpacing
      const featY = reqY + featIdx * rowSpacing

      const featNode = graph.addNode('SSoT_Feature', featX, featY)
      if (!featNode) return

      featNode.params = {
        name: feat.name || '',
        status: feat.status || 'planned',
        test_status: feat.test_status || 'pending',
        description: feat.description || '',
      }
      featNode.width = 220
      featNode.height = 180

      graph.addLink(reqNode.id, 0, featNode.id, 0)
    })
  })

  registerSsotLayoutKeys(graph)
  return graph
}

/**
 * Scan the ecosystem and return a list of projects with their SSoT summary.
 * Uses Vite proxy /api → Hub, or direct Hub URL in production/Electron.
 */
export async function scanEcosystem(hubUrl = ''): Promise<EcosystemProject[]> {
  const base = hubUrl || ''
  try {
    const res = await fetch(`${base}/api/polaris`, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = (await res.json()) as { projects: Array<PolarisJson & { _file?: string }> }
      return (data.projects || []).map(polaris => {
        const reqs = polaris.requirements || []
        let total = 0
        let done = 0
        for (const req of reqs) {
          for (const feat of req.features || []) {
            total++
            if (feat.status === 'done') done++
          }
        }
        return {
          name: polaris.name || 'unknown',
          path: polaris.name || '',
          tier: polaris.tier || 'app',
          status: polaris.status || 'active',
          requirementCount: total,
          doneCount: done,
        }
      })
    }
  } catch { /* fallback below */ }

  return KNOWN_PROJECTS.map(name => ({
    name,
    path: name,
    tier: 'app',
    status: 'active',
    requirementCount: 0,
    doneCount: 0,
  }))
}

/**
 * ADR-013 — load full ecosystem project reference map.
 * scanEcosystem → parallel GET /api/polaris/{name} (allSettled) → buildDependencyGraph.
 * Failed fetches degrade to isolated nodes (polaris undefined).
 */
export async function loadProjectMap(hubBase = ''): Promise<Graph> {
  const projects = await scanEcosystem(hubBase)
  const base = hubBase || ''
  const settled = await Promise.allSettled(
    projects.map(async (p): Promise<ProjectMapEntry> => {
      const res = await fetch(`${base}/api/polaris/${encodeURIComponent(p.name)}`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const polaris = await res.json()
      return {
        name: p.name,
        tier: p.tier,
        status: p.status,
        polaris,
      }
    }),
  )

  const entries: ProjectMapEntry[] = projects.map((p, i) => {
    const r = settled[i]
    if (r.status === 'fulfilled') return r.value
    return { name: p.name, tier: p.tier, status: p.status }
  })

  return buildDependencyGraph(entries)
}
