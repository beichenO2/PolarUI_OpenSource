/**
 * 自动布局 — Dagre LR + network-simplex（ComfyUI 社区标准）
 * @see https://github.com/comfyanonymous/ComfyUI/discussions/1547
 * @see https://github.com/phineas-pta/comfyui-auto-nodes-layout
 * @see https://reactflow.dev/examples/layout/elkjs (ELK 备选)
 */
import dagre from 'dagre'
import Elk, { type ElkNode } from 'elkjs/lib/elk.bundled.js'
import type { Graph } from './graph'
import type { NodeInstance } from './types'
import {
  isNoteCardNode,
  layoutNodeDimensions,
  MIN_NODE_GAP,
  normalizeGraphNodeDimensions,
} from './node-geometry'
import { resolveCollisions } from './resolve-collisions'

export type LayoutDirection = 'TB' | 'LR' | 'BT' | 'RL'
export type LayoutAlgorithm = 'dagre' | 'elk'

export interface AutoLayoutOptions {
  direction?: LayoutDirection
  /** 同列节点垂直间距（ComfyUI nodesep，默认 100） */
  nodeSep?: number
  /** 列间水平间距（ComfyUI ranksep，默认 200） */
  rankSep?: number
  algorithm?: LayoutAlgorithm
  fixOverlaps?: boolean
}

const elk = new Elk()

/** ComfyUI auto-nodes-layout 默认间距 @see phineas-pta/comfyui-auto-nodes-layout */
const DEFAULT_OPTIONS: Required<AutoLayoutOptions> = {
  direction: 'LR',
  nodeSep: 80,
  rankSep: 120,
  algorithm: 'dagre',
  fixOverlaps: true,
}

const ORIGIN_X = 80
const ORIGIN_Y = 80

function getBackLinks(graph: Graph): Set<string> {
  return (graph as Graph & { _backLinks?: Set<string> })._backLinks ?? new Set()
}

interface LayoutEdge {
  id: string
  source: string
  target: string
}

export function buildLayoutEdges(graph: Graph): LayoutEdge[] {
  const backLinks = getBackLinks(graph)
  const edges: LayoutEdge[] = []
  const seen = new Set<string>()

  for (const link of graph.links) {
    if (backLinks.has(link.id)) continue
    const key = `${link.from_node}->${link.to_node}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: link.id, source: link.from_node, target: link.to_node })
  }
  return edges
}

function dagreRankDir(d: LayoutDirection): string {
  switch (d) {
    case 'TB': return 'TB'
    case 'LR': return 'LR'
    case 'BT': return 'BT'
    case 'RL': return 'RL'
  }
}

function dagreLayoutSync(
  nodes: NodeInstance[],
  edges: LayoutEdge[],
  options: Required<AutoLayoutOptions>,
): Map<string, { x: number; y: number }> {
  const routable = nodes.filter(n => !isNoteCardNode(n))
  if (routable.length === 0) return new Map()

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: dagreRankDir(options.direction),
    ranker: 'network-simplex',
    nodesep: options.nodeSep,
    ranksep: options.rankSep,
    edgesep: 20,
    marginx: 20,
    marginy: 20,
    align: 'UL',
  })

  for (const node of routable) {
    const dim = layoutNodeDimensions(node)
    g.setNode(node.id, { width: dim.w, height: dim.h })
  }
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const node of routable) {
    const pos = g.node(node.id)
    if (!pos) continue
    const dim = layoutNodeDimensions(node)
    positions.set(node.id, {
      x: pos.x - dim.w / 2,
      y: pos.y - dim.h / 2,
    })
  }
  return positions
}

function elkDirection(d: LayoutDirection): string {
  switch (d) {
    case 'TB': return 'DOWN'
    case 'LR': return 'RIGHT'
    case 'BT': return 'UP'
    case 'RL': return 'LEFT'
  }
}

async function elkLayoutAsync(
  nodes: NodeInstance[],
  edges: LayoutEdge[],
  options: Required<AutoLayoutOptions>,
): Promise<Map<string, { x: number; y: number }>> {
  const routable = nodes.filter(n => !isNoteCardNode(n))
  if (routable.length === 0) return new Map()

  const graph = {
    id: 'elk-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': elkDirection(options.direction),
      'elk.spacing.nodeNode': `${options.nodeSep}`,
      'elk.layered.spacing.nodeNodeBetweenLayers': `${options.rankSep}`,
      'elk.layered.spacing.edgeNodeBetweenLayers': '40',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: routable.map(node => {
      const dim = layoutNodeDimensions(node)
      return { id: node.id, width: dim.w, height: dim.h }
    }),
    edges: edges.map(e => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const root: ElkNode = await elk.layout(graph)
  const positions = new Map<string, { x: number; y: number }>()
  for (const child of root.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  return positions
}

function applyPositions(
  graph: Graph,
  positions: Map<string, { x: number; y: number }>,
  options: Required<AutoLayoutOptions>,
): void {
  for (const node of graph.nodes) {
    if (isNoteCardNode(node)) continue
    const pos = positions.get(node.id)
    if (pos) {
      node.x = ORIGIN_X + pos.x
      node.y = ORIGIN_Y + pos.y
    }
  }
  if (options.fixOverlaps) {
    resolveCollisions(graph.nodes, { margin: 20, maxIterations: 80, overlapThreshold: 0.5 })
  }
}

/** Dagre/ELK 自动排布（默认 Dagre，对齐 ComfyUI 社区方案） */
export async function applyAutoLayout(
  graph: Graph,
  opts: AutoLayoutOptions = {},
): Promise<void> {
  const options = { ...DEFAULT_OPTIONS, ...opts }
  normalizeGraphNodeDimensions(graph.nodes)
  const edges = buildLayoutEdges(graph)

  const positions = options.algorithm === 'elk'
    ? await elkLayoutAsync(graph.nodes, edges, options)
    : dagreLayoutSync(graph.nodes, edges, options)

  applyPositions(graph, positions, options)
}

/** 同步回退 — headless / 无 async 环境 */
export function applyTopologicalLayout(graph: Graph): void {
  const options = { ...DEFAULT_OPTIONS }
  normalizeGraphNodeDimensions(graph.nodes)
  const edges = buildLayoutEdges(graph)
  const positions = dagreLayoutSync(graph.nodes, edges, options)
  applyPositions(graph, positions, options)
}
