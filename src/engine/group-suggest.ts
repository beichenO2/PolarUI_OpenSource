/**
 * Heuristic workflow group suggestions — pure function, no side effects.
 * Finds dense node clusters with stronger internal than external connectivity.
 */
import type { NodeInstance, Link } from './types'
import type { WorkflowGroup } from './graph-groups'

export interface SuggestedGroup {
  id: string
  title: string
  node_ids: string[]
  internal_edges: number
  external_edges: number
  internal_density: number
  external_density: number
}

export interface SuggestGroupsOptions {
  minMembers?: number
  minInternalDensity?: number
  minDensityRatio?: number
}

const DEFAULT_OPTS: Required<SuggestGroupsOptions> = {
  minMembers: 3,
  minInternalDensity: 0.25,
  minDensityRatio: 1.5,
}

function undirectedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function buildAdjacency(nodes: NodeInstance[], links: Link[]): Map<string, Set<string>> {
  const ids = new Set(nodes.map(n => n.id))
  const adj = new Map<string, Set<string>>()
  for (const id of ids) adj.set(id, new Set())
  for (const link of links) {
    if (!ids.has(link.from_node) || !ids.has(link.to_node)) continue
    if (link.from_node === link.to_node) continue
    adj.get(link.from_node)!.add(link.to_node)
    adj.get(link.to_node)!.add(link.from_node)
  }
  return adj
}

function connectedComponents(adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const stack = [start]
    const comp: string[] = []
    seen.add(start)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    components.push(comp)
  }
  return components
}

function countEdges(memberSet: Set<string>, links: Link[]): { internal: number; external: number } {
  const internalKeys = new Set<string>()
  let external = 0
  for (const link of links) {
    const fromIn = memberSet.has(link.from_node)
    const toIn = memberSet.has(link.to_node)
    if (fromIn && toIn) {
      internalKeys.add(undirectedEdgeKey(link.from_node, link.to_node))
    } else if (fromIn || toIn) {
      external++
    }
  }
  return { internal: internalKeys.size, external }
}

function internalDensity(n: number, internalEdges: number): number {
  if (n < 2) return 0
  const maxEdges = (n * (n - 1)) / 2
  return internalEdges / maxEdges
}

function externalDensity(n: number, externalEdges: number): number {
  if (n === 0) return 0
  return externalEdges / n
}

function scoreComponent(
  memberIds: string[],
  links: Link[],
): { internal: number; external: number; internal_density: number; external_density: number } | null {
  const set = new Set(memberIds)
  const { internal, external } = countEdges(set, links)
  const n = memberIds.length
  const id = internalDensity(n, internal)
  const ed = externalDensity(n, external)
  return { internal, external, internal_density: id, external_density: ed }
}

/** Greedy expand from seed: add neighbor that maximizes internal/external edge ratio. */
function growDenseCluster(
  seed: string,
  adj: Map<string, Set<string>>,
  links: Link[],
  opts: Required<SuggestGroupsOptions>,
  reserved: Set<string>,
): string[] | null {
  const cluster = new Set<string>([seed])
  let improved = true
  while (improved) {
    improved = false
    const border = new Set<string>()
    for (const id of cluster) {
      for (const nb of adj.get(id) ?? []) {
        if (!cluster.has(nb) && !reserved.has(nb)) border.add(nb)
      }
    }
    let best: string | null = null
    let bestRatio = -1
    for (const candidate of border) {
      const trial = [...cluster, candidate]
      const s = scoreComponent(trial, links)
      if (!s) continue
      const ratio = s.external > 0 ? s.internal / s.external : s.internal
      if (ratio > bestRatio) {
        bestRatio = ratio
        best = candidate
      }
    }
    if (best) {
      cluster.add(best)
      improved = true
    }
  }

  const ids = [...cluster]
  if (ids.length < opts.minMembers) return null
  const s = scoreComponent(ids, links)
  if (!s) return null
  if (s.internal_density < opts.minInternalDensity) return null
  const ratio = s.external > 0 ? s.internal_density / Math.max(s.external_density, 0.01) : s.internal_density * 10
  if (ratio < opts.minDensityRatio && s.external > 0) return null
  if (s.external === 0 && s.internal < opts.minMembers - 1) return null
  return ids
}

function overlaps(a: string[], reserved: Set<string>): boolean {
  return a.some(id => reserved.has(id))
}

function uniqueForwardEdges(links: Link[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const link of links) {
    if (link.from_node === link.to_node) continue
    if (!adj.has(link.from_node)) adj.set(link.from_node, new Set())
    adj.get(link.from_node)!.add(link.to_node)
  }
  return adj
}

/** Maximal forward chains (in-degree ≤1 within chain) of length ≥ minMembers. */
function suggestForwardChains(
  nodes: NodeInstance[],
  links: Link[],
  opts: Required<SuggestGroupsOptions>,
): SuggestedGroup[] {
  const nodeIds = new Set(nodes.map(n => n.id))
  const fwd = uniqueForwardEdges(links)
  const rev = new Map<string, Set<string>>()
  for (const [from, tos] of fwd) {
    for (const to of tos) {
      if (!rev.has(to)) rev.set(to, new Set())
      rev.get(to)!.add(from)
    }
  }

  const suggestions: SuggestedGroup[] = []
  let seq = 0

  for (const start of nodeIds) {
    if ((rev.get(start)?.size ?? 0) > 1) continue
    const chain = [start]
    let cur = start
    while (true) {
      const nexts = [...(fwd.get(cur) ?? [])].filter(id => nodeIds.has(id))
      if (nexts.length !== 1) break
      const next = nexts[0]
      if ((rev.get(next)?.size ?? 0) > 1 && next !== start) break
      if (chain.includes(next)) break
      chain.push(next)
      cur = next
    }
    if (chain.length < opts.minMembers) continue
    const s = scoreComponent(chain, links)
    if (!s) continue
    if (s.internal_density < opts.minInternalDensity * 0.5) continue
    suggestions.push({
      id: `chain_${++seq}`,
      title: `Chain ${seq}`,
      node_ids: chain,
      internal_edges: s.internal,
      external_edges: s.external,
      internal_density: s.internal_density,
      external_density: s.external_density,
    })
  }
  return suggestions
}

/** Nodes sharing a common merge sink (e.g. parallel SubAgents → Save). */
function suggestMergeClusters(
  nodes: NodeInstance[],
  links: Link[],
  opts: Required<SuggestGroupsOptions>,
): SuggestedGroup[] {
  const rev = new Map<string, string[]>()
  for (const link of links) {
    if (!rev.has(link.to_node)) rev.set(link.to_node, [])
    rev.get(link.to_node)!.push(link.from_node)
  }

  const suggestions: SuggestedGroup[] = []
  let seq = 0

  for (const [sink, sources] of rev) {
    const uniqueSources = [...new Set(sources)]
    if (uniqueSources.length < opts.minMembers - 1) continue
    const memberIds = [...uniqueSources, sink]
    if (memberIds.length < opts.minMembers) continue
    const s = scoreComponent(memberIds, links)
    if (!s) continue
    if (s.internal_density < opts.minInternalDensity * 0.3) continue
    suggestions.push({
      id: `merge_${++seq}`,
      title: `Merge ${seq}`,
      node_ids: memberIds,
      internal_edges: s.internal,
      external_edges: s.external,
      internal_density: s.internal_density,
      external_density: s.external_density,
    })
  }
  return suggestions
}

/**
 * Suggest non-overlapping groups from connectivity / density heuristics.
 */
export function suggestGroups(
  nodes: NodeInstance[],
  links: Link[],
  options: SuggestGroupsOptions = {},
): SuggestedGroup[] {
  const opts = { ...DEFAULT_OPTS, ...options }
  const adj = buildAdjacency(nodes, links)
  const components = connectedComponents(adj)
  const candidates: SuggestedGroup[] = []
  let seq = 0

  candidates.push(...suggestForwardChains(nodes, links, opts))
  candidates.push(...suggestMergeClusters(nodes, links, opts))

  for (const comp of components) {
    if (comp.length < opts.minMembers) continue

    const wholeScore = scoreComponent(comp, links)
    if (wholeScore) {
      const ratio =
        wholeScore.external > 0
          ? wholeScore.internal_density / Math.max(wholeScore.external_density, 0.01)
          : wholeScore.internal_density * 10
      if (
        wholeScore.internal_density >= opts.minInternalDensity &&
        (wholeScore.external === 0 || ratio >= opts.minDensityRatio)
      ) {
        candidates.push({
          id: `suggest_${++seq}`,
          title: `Suggested ${seq}`,
          node_ids: [...comp],
          internal_edges: wholeScore.internal,
          external_edges: wholeScore.external,
          internal_density: wholeScore.internal_density,
          external_density: wholeScore.external_density,
        })
      }
    }

    for (const seed of comp) {
      const grown = growDenseCluster(seed, adj, links, opts, new Set())
      if (!grown || grown.length < opts.minMembers) continue
      const s = scoreComponent(grown, links)!
      candidates.push({
        id: `suggest_${++seq}`,
        title: `Suggested ${seq}`,
        node_ids: grown,
        internal_edges: s.internal,
        external_edges: s.external,
        internal_density: s.internal_density,
        external_density: s.external_density,
      })
    }
  }

  candidates.sort((a, b) => {
    const scoreA = a.internal_density * a.node_ids.length - a.external_edges * 0.1
    const scoreB = b.internal_density * b.node_ids.length - b.external_edges * 0.1
    return scoreB - scoreA
  })

  const reserved = new Set<string>()
  const picked: SuggestedGroup[] = []
  for (const c of candidates) {
    if (overlaps(c.node_ids, reserved)) continue
    const densityOk =
      c.external_edges === 0
        ? c.internal_edges >= opts.minMembers - 1
        : c.internal_density > c.external_density
    if (!densityOk) continue
    picked.push(c)
    for (const id of c.node_ids) reserved.add(id)
  }

  return picked.map((g, i) => ({ ...g, title: `Suggested ${i + 1}` }))
}

/** Convert accepted suggestion to WorkflowGroup (preview → adopt). */
export function suggestionToGroup(s: SuggestedGroup, collapsed = true): WorkflowGroup {
  return {
    id: `grp_${s.id}`,
    title: s.title,
    node_ids: [...s.node_ids],
    collapsed,
  }
}

/** Layer-based fallback: consecutive topological layers with dense cross-links. */
export function suggestLayerClusters(
  nodes: NodeInstance[],
  links: Link[],
  layerOf: Map<string, number>,
  opts: SuggestGroupsOptions = {},
): SuggestedGroup[] {
  const merged = { ...DEFAULT_OPTS, ...opts }
  const byLayer = new Map<number, string[]>()
  for (const n of nodes) {
    const L = layerOf.get(n.id) ?? 0
    if (!byLayer.has(L)) byLayer.set(L, [])
    byLayer.get(L)!.push(n.id)
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const suggestions: SuggestedGroup[] = []
  let seq = 0
  for (let i = 0; i < layers.length - 1; i++) {
    const ids = [...(byLayer.get(layers[i]) ?? []), ...(byLayer.get(layers[i + 1]) ?? [])]
    if (ids.length < merged.minMembers) continue
    const s = scoreComponent(ids, links)
    if (!s) continue
    if (s.internal_density >= merged.minInternalDensity * 0.8) {
      suggestions.push({
        id: `layer_${++seq}`,
        title: `Layer ${i + 1}-${i + 2}`,
        node_ids: ids,
        internal_edges: s.internal,
        external_edges: s.external,
        internal_density: s.internal_density,
        external_density: s.external_density,
      })
    }
  }
  return suggestions
}
