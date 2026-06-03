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
import { isLgLayoutBackEdge } from './lg-canvas-utils'
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
  nodeSep: 150,
  rankSep: 200,
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

/**
 * 布局边 SSOT：
 * - LG：仅 _lg_edges 执行流（数据流连线不参与排布，避免交叉依赖拉乱层级）
 * - WF：forward data-flow links（排除回边）
 */
export function buildLayoutEdges(graph: Graph): LayoutEdge[] {
  const backLinks = getBackLinks(graph)
  const edges: LayoutEdge[] = []
  const seen = new Set<string>()

  const push = (source: string, target: string, id?: string) => {
    const key = `${source}->${target}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id: id ?? key, source, target })
  }

  if (graph.library === 'LG' && graph.lgEdges?.length) {
    for (const edge of graph.lgEdges) {
      if (isLgLayoutBackEdge(edge)) continue
      push(edge.from, edge.to)
    }
    return edges
  }

  for (const link of graph.links) {
    if (backLinks.has(link.id)) continue
    push(link.from_node, link.to_node, link.id)
  }
  return edges
}

/** LG：Dagre 未覆盖的可选工具节点 → 排在 Switch/Condition 下方 */
function placeLgOrphanNodes(graph: Graph): void {
  if (graph.library !== 'LG') return
  const layoutIds = new Set(buildLayoutEdges(graph).flatMap(e => [e.source, e.target]))
  const backLinks = getBackLinks(graph)

  for (const node of graph.nodes) {
    if (isNoteCardNode(node) || layoutIds.has(node.id)) continue

    const inLink = graph.links.find(l => l.to_node === node.id && !backLinks.has(l.id))
    const source = inLink ? graph.nodes.find(n => n.id === inLink.from_node) : undefined
    if (source?.class_type !== 'Switch' && source?.class_type !== 'Condition') continue

    const siblings = graph.nodes.filter(n =>
      graph.links.some(l =>
        l.from_node === source.id && l.to_node === n.id && !backLinks.has(l.id),
      ),
    )
    const idx = siblings.findIndex(n => n.id === node.id)
    const cols = 3
    const col = idx % cols
    const row = Math.floor(idx / cols)
    const cellW = node.width + MIN_NODE_GAP
    const cellH = node.height + MIN_NODE_GAP
    node.x = source.x + col * cellW
    node.y = source.y + source.height + MIN_NODE_GAP + row * cellH
  }
}

/** LG：Output 接地点紧贴上游节点右侧（Dagre 对小节点 rank 估算易重叠） */
function placeLgOutputTerminals(graph: Graph): void {
  if (graph.library !== 'LG') return
  for (const node of graph.nodes) {
    if (node.class_type !== 'Output') continue
    const lgIn = graph.lgEdges?.find(e => e.to === node.id && !isLgLayoutBackEdge(e))
    const predId = lgIn?.from
      ?? graph.links.find(l => l.to_node === node.id)?.from_node
    const pred = predId ? graph.nodes.find(n => n.id === predId) : undefined
    if (!pred) continue
    node.x = pred.x + pred.width + MIN_NODE_GAP
    node.y = pred.y + (pred.height - node.height) / 2
  }
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
  if (graph.library === 'LG') {
    placeLgOrphanNodes(graph)
    placeLgOutputTerminals(graph)
    if (options.fixOverlaps) {
      resolveCollisions(graph.nodes, { margin: 20, maxIterations: 80, overlapThreshold: 0.5 })
    }
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
