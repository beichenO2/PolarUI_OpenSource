import type { Link, LgEdge, NodeInstance } from './types'
import type { ExecutionState } from './types'
import { isBackwardLink, isOutputTerminalNode } from './node-geometry'
import { isRoutingBranchNode } from './branch-outputs'
import { registry } from './registry'
import type { CrossingPoint } from './wire-crossings'
import type { Vec2 } from './node-geometry'
import { activeWireTheme } from './canvas-theme'

/** light 主题基准值（测试断言依赖）；运行时取 activeWireTheme() 支持 hermes */
export const SEMANTIC_OUTPUT_COLOR = '#059669'
export const SEMANTIC_CONTROL_FLOW_COLOR = '#4F46E5'
export const SEMANTIC_BACKWARD_BASE = '#dc2626'

/**
 * Forward palette — 14 maximally separated hues at high saturation.
 * Ordered so adjacent indices have large perceptual distance (≥120° hue gap
 * for first 6, then interleaved lighter/darker variants).
 */
export const FORWARD_EDGE_PALETTE = [
  '#e6194b', // red
  '#3cb44b', // green
  '#4363d8', // blue
  '#f58231', // orange
  '#911eb4', // purple
  '#42d4f4', // cyan
  '#f032e6', // magenta
  '#bfef45', // lime
  '#fabed4', // pink
  '#469990', // teal
  '#dcbeff', // lavender
  '#9A6324', // brown
  '#aaffc3', // mint
  '#ffe119', // yellow
] as const

/** Failure/feedback red family — lightness varies per parallel backward wire. */
export const BACKWARD_EDGE_PALETTE = [
  '#dc2626',
  '#ef4444',
  '#b91c1c',
  '#f87171',
  '#991b1b',
  '#fca5a5',
  '#7f1d1d',
  '#fecaca',
] as const

export interface SemanticWireGraphContext {
  nodes: NodeInstance[]
  backLinks?: Set<string>
  lgEdges?: LgEdge[]
}

function isControlFlowSource(node: NodeInstance | undefined): boolean {
  if (!node) return false
  if (isRoutingBranchNode(node.class_type)) return true
  const cat = registry.get(node.class_type)?.category?.toLowerCase() ?? ''
  return cat.includes('switch') || cat.includes('branch') || cat.includes('condition')
}

function isLgConditionalEdge(link: Link, lgEdges?: LgEdge[]): boolean {
  if (!lgEdges?.length) return false
  return lgEdges.some(
    e => e.kind === 'conditional' && e.from === link.from_node && e.to === link.to_node,
  )
}

/**
 * Semantic wire stroke override. `null` = fall through to proximity rainbow palette.
 * Backward wires are colored separately via BACKWARD_EDGE_PALETTE.
 */
export function semanticWireColor(link: Link, graphContext: SemanticWireGraphContext): string | null {
  const { nodes, backLinks, lgEdges } = graphContext
  if (isBackwardLink(link, nodes, backLinks)) return null

  const fromNode = nodes.find(n => n.id === link.from_node)
  const toNode = nodes.find(n => n.id === link.to_node)
  const theme = activeWireTheme()

  if (isOutputTerminalNode(toNode)) return theme.semanticOutput
  if (isControlFlowSource(fromNode) || isLgConditionalEdge(link, lgEdges)) {
    return theme.semanticControl
  }
  return null
}

export const EDGE_PENDING_COLOR = '#94a3b8'

export interface LinkColorMaps {
  forwardByLink: Map<string, string>
  backwardByLink: Map<string, string>
}

const PROXIMITY_THRESHOLD = 30

/**
 * Build an adjacency graph between source-groups based on three proximity
 * signals: crossing, parallel overlap, and segment nearness.  Then greedy-
 * color the graph so visually close wires always get different colors.
 */
function proximityAwareColoring(
  links: Link[],
  forwardLinkIds: string[],
  paths: Map<string, Vec2[]>,
  crossings: CrossingPoint[],
): Map<string, number> {
  const idSet = new Set(forwardLinkIds)
  const linkMap = new Map<string, Link>()
  for (const l of links) if (idSet.has(l.id)) linkMap.set(l.id, l)

  const sourceGroups = new Map<string, string[]>()
  const linkToGroup = new Map<string, string>()
  for (const id of forwardLinkIds) {
    const l = linkMap.get(id)
    if (!l) continue
    const key = `${l.from_node}:${l.from_slot}`
    if (!sourceGroups.has(key)) sourceGroups.set(key, [])
    sourceGroups.get(key)!.push(id)
    linkToGroup.set(id, key)
  }

  const groupAdj = new Map<string, Set<string>>()
  for (const key of sourceGroups.keys()) groupAdj.set(key, new Set())

  function addEdge(g1: string | undefined, g2: string | undefined) {
    if (g1 && g2 && g1 !== g2) {
      groupAdj.get(g1)?.add(g2)
      groupAdj.get(g2)?.add(g1)
    }
  }

  for (const c of crossings) {
    addEdge(linkToGroup.get(c.overLinkId), linkToGroup.get(c.underLinkId))
  }

  interface Seg { linkId: string; horizontal: boolean; fixed: number; lo: number; hi: number }
  const segs: Seg[] = []
  for (const [linkId, pts] of paths) {
    if (!idSet.has(linkId)) continue
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y)
      if (dx < 0.5 && dy > 0.5) {
        segs.push({ linkId, horizontal: false, fixed: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
      } else if (dy < 0.5 && dx > 0.5) {
        segs.push({ linkId, horizontal: true, fixed: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
      }
    }
  }

  for (let i = 0; i < segs.length; i++) {
    const a = segs[i]
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j]
      if (a.linkId === b.linkId) continue
      if (a.horizontal !== b.horizontal) continue
      if (Math.abs(a.fixed - b.fixed) > PROXIMITY_THRESHOLD) continue
      const overlapLo = Math.max(a.lo, b.lo)
      const overlapHi = Math.min(a.hi, b.hi)
      if (overlapHi - overlapLo < 1) continue
      addEdge(linkToGroup.get(a.linkId), linkToGroup.get(b.linkId))
    }
  }

  const groupKeys = [...sourceGroups.keys()]
  const degree = new Map<string, number>()
  for (const key of groupKeys) degree.set(key, groupAdj.get(key)?.size ?? 0)
  groupKeys.sort((a, b) => degree.get(b)! - degree.get(a)!)

  const groupColor = new Map<string, number>()
  for (const key of groupKeys) {
    const used = new Set<number>()
    for (const nb of groupAdj.get(key) ?? []) {
      const nc = groupColor.get(nb)
      if (nc !== undefined) used.add(nc)
    }
    let c = 0
    while (used.has(c)) c++
    groupColor.set(key, c)
  }

  const colorOf = new Map<string, number>()
  for (const [key, ids] of sourceGroups) {
    const ci = groupColor.get(key) ?? 0
    for (const id of ids) colorOf.set(id, ci)
  }
  return colorOf
}

export function buildLinkColorMaps(
  links: Link[],
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
  results?: ExecutionState['results'],
  crossings?: CrossingPoint[],
  paths?: Map<string, Vec2[]>,
  lgEdges?: LgEdge[],
): LinkColorMaps {
  return buildLinkColorMapsInternal(links, nodes, backLinks, crossings, paths, lgEdges, false)
}

/**
 * Rainbow/backward palette for parallel-segment offsets only.
 * Ignores semantic display colors so routing geometry stays stable.
 */
export function buildRoutingOffsetColorMap(
  links: Link[],
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
  crossings?: CrossingPoint[],
  paths?: Map<string, Vec2[]>,
): Map<string, string> {
  const maps = buildLinkColorMapsInternal(links, nodes, backLinks, crossings, paths, undefined, true)
  const colorOf = new Map<string, string>()
  for (const link of links) {
    colorOf.set(
      link.id,
      maps.backwardByLink.get(link.id)
        ?? maps.forwardByLink.get(link.id)
        ?? FORWARD_EDGE_PALETTE[0],
    )
  }
  return colorOf
}

function buildLinkColorMapsInternal(
  links: Link[],
  nodes: NodeInstance[],
  backLinks: Set<string> | undefined,
  crossings: CrossingPoint[] | undefined,
  paths: Map<string, Vec2[]> | undefined,
  lgEdges: LgEdge[] | undefined,
  routingOnly: boolean,
): LinkColorMaps {
  const forwardByLink = new Map<string, string>()
  const backwardByLink = new Map<string, string>()
  const backwardLinks: Link[] = []
  const forwardIds: string[] = []
  const graphContext: SemanticWireGraphContext = { nodes, backLinks, lgEdges }

  for (const link of links) {
    if (isBackwardLink(link, nodes, backLinks)) {
      backwardLinks.push(link)
    } else {
      if (!routingOnly) {
        const semantic = semanticWireColor(link, graphContext)
        if (semantic) {
          forwardByLink.set(link.id, semantic)
          continue
        }
      }
      forwardIds.push(link.id)
    }
  }

  const forwardPalette = activeWireTheme().forwardPalette
  const backwardPalette = activeWireTheme().backwardPalette
  if (paths && paths.size > 0) {
    const colorOf = proximityAwareColoring(links, forwardIds, paths, crossings ?? [])
    for (const id of forwardIds) {
      const ci = colorOf.get(id) ?? 0
      forwardByLink.set(id, forwardPalette[ci % forwardPalette.length])
    }
  } else {
    const sourceColor = new Map<string, string>()
    let sourceIdx = 0
    for (const link of links) {
      if (isBackwardLink(link, nodes, backLinks)) continue
      const key = `${link.from_node}:${link.from_slot}`
      if (!sourceColor.has(key)) {
        sourceColor.set(key, forwardPalette[sourceIdx++ % forwardPalette.length])
      }
      forwardByLink.set(link.id, sourceColor.get(key)!)
    }
  }

  backwardLinks.sort((a, b) => a.from_node.localeCompare(b.from_node) || a.to_node.localeCompare(b.to_node) || a.id.localeCompare(b.id))
  backwardLinks.forEach((link, index) => {
    backwardByLink.set(link.id, backwardPalette[index % backwardPalette.length])
  })

  return { forwardByLink, backwardByLink }
}

export function linkForwardColor(linkId: string, maps: LinkColorMaps): string {
  return maps.forwardByLink.get(linkId) ?? activeWireTheme().forwardPalette[0]
}

export function linkBackwardColor(linkId: string, maps: LinkColorMaps): string {
  return maps.backwardByLink.get(linkId) ?? activeWireTheme().backwardPalette[0]
}
