import type { NodeInstance, Link, NodeDef } from './types'
import { applyWheelToViewport } from './canvas-viewport'
import { registry } from './registry'
import { buildNodeContentPreviewLines, maxContentPreviewLines } from './node-content-preview'
import { Graph } from './graph'
import { validateGraphWiring } from './wire-integrity'
import {
  applyNoteCardLayout,
  applyNoteCardLayoutAll,
  parseNoteCardMarkdown,
  getNoteCardBodyFontSize,
  noteCardLineMetrics,
  NOTE_CARD_MIN_H,
  NOTE_CARD_MAX_H,
} from './note-card-layout'
import {
  SLOT_RADIUS,
  HEADER_HEIGHT,
  CONTENT_AREA_HEIGHT,
  SLOT_HEIGHT,
  SLOT_PADDING,
  NODE_DEFAULT_WIDTH,
  COLLISION_MARGIN,
  WIRE_LOOP_MARGIN,
  BACKWARD_LINK_LANE_SPACING,
  DEFAULT_WIRE_ROUTING_OPTIONS,
  DEFAULT_LINK_LINE_WIDTH,
  calcNodeHeight,
  linkAnchor,
  nodeDrawBounds,
  slotGraphY,
  isBackwardLink,
  isNoteCardNode,
  isOutputTerminalNode,
  normalizeAllOutputTerminals,
  type Vec2,
} from './node-geometry'
import { buildFallbackPath } from './wire-path'
import { resolveCollisions } from './resolve-collisions'
import { buildLinkColorMaps, linkBackwardColor, linkForwardColor, type LinkColorMaps } from './wire-colors'
import { hitTestPolyline } from './link-hit'
import { routeAllLinks, routeSingleDrag, offsetParallelSegments } from './wire-router'

import { detectCrossings, type CrossingPoint } from './wire-crossings'
import type { ExecutionState } from './types'
import { outputNodeHasResult } from './output-result'
import {
  isStemCellClass,
  lgSpecEdgeKind,
  isLgMaterializedVirtualLink,
  type MaterializedLink,
} from './lg-canvas-utils'
import { buildCanvasRoutingLinks } from './wire-routing-links'
import { linkHoverAlpha } from './link-hover'
import {
  formatLinkSlotLabel,
  labelOffsetFromPath,
  linkLabelAnchor,
  separateWireLabelPositions,
  shouldShowLinkSlotLabel,
} from './link-slot-label'

export {
  SLOT_RADIUS,
  HEADER_HEIGHT,
  CONTENT_AREA_HEIGHT,
  SLOT_HEIGHT,
  SLOT_PADDING,
  NODE_DEFAULT_WIDTH,
  NODE_BOTTOM_PAD,
  COLLISION_MARGIN,
  calcNodeHeight,
} from './node-geometry'

/** Loop-channel margin for backward links (legacy export name). */
export { WIRE_LOOP_MARGIN as WIRE_ROUTE_MARGIN } from './node-geometry'

const COLORS = {
  bg: '#ffffff',
  grid: '#e2e8f0',
  node: '#f8fafc',
  nodeSelected: '#eff6ff',
  nodeHeader: '#64748b',
  nodeHeaderSelected: '#3b82f6',
  headerText: '#ffffff',
  headerTextMuted: '#e2e8f0',
  border: '#64748b',
  borderSelected: '#3b82f6',
  text: '#1e293b',
  textMuted: '#64748b',
  slotInput: '#64748b',
  slotOutput: '#22c55e',
  slotOutputBorder: '#16a34a',
  link: '#94a3b8',
  linkActive: '#2563eb',
  running: '#22c55e',
  error: '#ef4444',
  terminal: '#f0fdf4',
  terminalBorder: '#4ade80',
}

export class GraphCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private graph: Graph
  private offset: Vec2 = { x: 0, y: 0 }
  private scale = 1
  private selectedNode: string | null = null
  private selectedLink: string | null = null
  private draggingNode: string | null = null
  private dragStart: Vec2 = { x: 0, y: 0 }
  private panning = false
  private panStart: Vec2 = { x: 0, y: 0 }
  private linkDrag: { fromNode: string; fromSlot: number; pos: Vec2 } | null = null
  private runningNode: string | null = null
  private animFrame = 0
  private openSlotsCache: Set<string> | null = null
  private linkColorMaps: LinkColorMaps = { forwardByLink: new Map(), backwardByLink: new Map() }
  private routeCache: Map<string, Vec2[]> = new Map()
  private crossingCache: CrossingPoint[] = []
  private routeValid = false
  private executionResults: ExecutionState['results']
  private clickProbe: { nodeId: string; sx: number; sy: number } | null = null
  private dragMoved = false
  private noteCardResizing: { nodeId: string; startHeight: number; startMouseY: number } | null = null
  /** §2 260531：悬停节点 id，关联边高亮 */
  private hoverNodeId: string | null = null
  /** LG Run 物化 overlay（执行中 / 回放） */
  private lgMaterializedLinks: MaterializedLink[] = []
  private lgReplayStep: number | null = null
  private lgDifferentiatedNodes = new Set<string>()

  onNodeSelected?: (nodeId: string | null) => void
  onLinkSelected?: (linkId: string | null) => void
  onWorkflowChanged?: () => void
  onOutputPreview?: (nodeId: string) => void

  private onKeyDownBound = (e: KeyboardEvent) => this.onKeyDown(e)
  private onWheelBound = (e: WheelEvent) => this.onWheel(e)

  constructor(canvas: HTMLCanvasElement, graph: Graph) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.graph = graph
    normalizeAllOutputTerminals(this.graph.nodes)
    applyNoteCardLayoutAll(this.graph.nodes)
    this.setupEvents()
    this.resize()
    this.recomputeRouting()
    this.startRenderLoop()
  }

  setGraph(graph: Graph): void {
    this.graph = graph
    this.selectedNode = null
    this.selectedLink = null
    this.openSlotsCache = null
    normalizeAllOutputTerminals(graph.nodes)
    applyNoteCardLayoutAll(graph.nodes)
    this.rebuildLinkColors()
    this.recomputeRouting()
    this.resetView()
  }

  private rebuildLinkColors(): void {
    const links = buildCanvasRoutingLinks(this.graph, {
      materializedLinks: this.lgMaterializedLinks,
      replayStep: this.lgReplayStep,
    })
    this.linkColorMaps = buildLinkColorMaps(
      links,
      this.graph.nodes,
      this.getBackLinks(),
      this.executionResults,
      this.crossingCache,
      this.routeCache,
    )
  }

  private invalidateWiringCache(): void {
    this.openSlotsCache = null
  }

  private getBackLinks(): Set<string> | undefined {
    return (this.graph as Graph & { _backLinks?: Set<string> })._backLinks
  }

  refreshWireRouting(): void {
    this.recomputeRouting()
  }

  /** 视口中心（图坐标），用于插入注释等 */
  viewportGraphCenter(): Vec2 {
    const w = this.canvas.width / (window.devicePixelRatio || 1)
    const h = this.canvas.height / (window.devicePixelRatio || 1)
    return this.screenToGraph(w / 2, h / 2)
  }

  syncNoteCardLayouts(nodeId?: string): void {
    if (nodeId) {
      const node = this.graph.nodes.find(n => n.id === nodeId)
      if (node) applyNoteCardLayout(node)
    } else {
      applyNoteCardLayoutAll(this.graph.nodes)
    }
  }

  private recomputeRouting(): void {
    const links = buildCanvasRoutingLinks(this.graph, {
      materializedLinks: this.lgMaterializedLinks,
      replayStep: this.lgReplayStep,
    })
    const backLinks = this.getBackLinks()
    const paths = routeAllLinks(this.graph.nodes, links, backLinks)

    const crossings = detectCrossings(paths)
    this.crossingCache = crossings

    this.linkColorMaps = buildLinkColorMaps(
      links, this.graph.nodes, backLinks,
      this.executionResults, crossings, paths,
    )

    const colorOf = new Map<string, string>()
    for (const link of links) {
      colorOf.set(link.id,
        this.linkColorMaps.forwardByLink.get(link.id)
        ?? this.linkColorMaps.backwardByLink.get(link.id)
        ?? '',
      )
    }
    offsetParallelSegments(paths, colorOf)

    this.routeCache = paths
    this.routeValid = true
  }

  resetView(): void {
    this.offset = { x: 60, y: 40 }
    this.scale = 1
  }

  fitToContent(): void {
    if (this.graph.nodes.length === 0) {
      this.resetView()
      return
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const node of this.graph.nodes) {
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x + node.width)
      maxY = Math.max(maxY, node.y + node.height)
    }
    const contentW = maxX - minX
    const contentH = maxY - minY
    const canvasW = this.canvas.width / (window.devicePixelRatio || 1)
    const canvasH = this.canvas.height / (window.devicePixelRatio || 1)
    const pad = 60
    const scaleX = (canvasW - pad * 2) / contentW
    const scaleY = (canvasH - pad * 2) / contentH
    this.scale = Math.max(0.15, Math.min(1.5, Math.min(scaleX, scaleY)))
    this.offset = {
      x: pad - minX * this.scale + (canvasW - pad * 2 - contentW * this.scale) / 2,
      y: pad - minY * this.scale + (canvasH - pad * 2 - contentH * this.scale) / 2,
    }
  }

  setRunningNode(nodeId: string | null): void {
    this.runningNode = nodeId
  }

  /** LG Run 回放高亮节点（拖动 slider 时） */
  private lgReplayHighlightNode: string | null = null

  /** LG 执行步进 / Run 回放（08 §3.4 onLGStep） */
  setLGRunOverlay(opts: {
    materializedLinks?: MaterializedLink[]
    replayStep?: number | null
    differentiatedNodeIds?: string[]
    replayHighlightNodeId?: string | null
  }): void {
    this.lgMaterializedLinks = opts.materializedLinks ?? []
    this.lgReplayStep = opts.replayStep ?? null
    this.lgDifferentiatedNodes = new Set(opts.differentiatedNodeIds ?? [])
    this.lgReplayHighlightNode = opts.replayHighlightNodeId ?? null
  }

  clearLGRunOverlay(): void {
    this.lgMaterializedLinks = []
    this.lgReplayStep = null
    this.lgDifferentiatedNodes.clear()
    this.lgReplayHighlightNode = null
  }

  setExecutionResults(results: ExecutionState['results']): void {
    this.executionResults = results
    this.rebuildLinkColors()
  }

  getSelectedNode(): string | null {
    return this.selectedNode
  }

  /** Checklist / 外部跳转：选中画布节点 */
  focusNode(nodeId: string | null): void {
    this.selectedLink = null
    this.onLinkSelected?.(null)
    this.selectedNode = nodeId
    this.onNodeSelected?.(nodeId)
  }

  getSelectedLink(): string | null {
    return this.selectedLink
  }

  /** Delete 键：优先删选中连线，否则删选中组件 */
  deleteSelection(): boolean {
    if (this.selectedLink) {
      this.graph.removeLink(this.selectedLink)
      this.selectedLink = null
      this.onLinkSelected?.(null)
      this.invalidateWiringCache()
      this.rebuildLinkColors()
      this.recomputeRouting()
      this.onWorkflowChanged?.()
      return true
    }
    if (this.selectedNode) {
      this.graph.removeNode(this.selectedNode)
      this.selectedNode = null
      this.onNodeSelected?.(null)
      this.invalidateWiringCache()
      this.rebuildLinkColors()
      this.recomputeRouting()
      this.onWorkflowChanged?.()
      return true
    }
    return false
  }

  resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = rect.width * dpr
    this.canvas.height = rect.height * dpr
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private startRenderLoop(): void {
    const loop = () => {
      this.render()
      this.animFrame = requestAnimationFrame(loop)
    }
    loop()
  }

  destroy(): void {
    cancelAnimationFrame(this.animFrame)
    this.canvas.removeEventListener('keydown', this.onKeyDownBound)
    this.canvas.removeEventListener('wheel', this.onWheelBound)
  }

  private setupEvents(): void {
    this.canvas.tabIndex = 0
    this.canvas.style.outline = 'none'
    this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this))
    this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this))
    this.canvas.addEventListener('mouseleave', this.onMouseLeave.bind(this))
    this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this))
    this.canvas.addEventListener('wheel', this.onWheelBound, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDblClick.bind(this))
    this.canvas.addEventListener('keydown', this.onKeyDownBound)
    window.addEventListener('resize', () => this.resize())
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (this.deleteSelection()) {
      e.preventDefault()
    }
  }

  private screenToGraph(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.offset.x) / this.scale,
      y: (sy - this.offset.y) / this.scale,
    }
  }

  private graphToScreen(gx: number, gy: number): Vec2 {
    return {
      x: gx * this.scale + this.offset.x,
      y: gy * this.scale + this.offset.y,
    }
  }

  private getNodeAt(gx: number, gy: number): NodeInstance | null {
    for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
      const n = this.graph.nodes[i]
      const b = nodeDrawBounds(n)
      const hitPad = COLLISION_MARGIN / 2
      if (
        gx >= b.x - hitPad && gx <= b.x + b.w + hitPad &&
        gy >= b.y - hitPad && gy <= b.y + b.h + hitPad
      ) {
        return n
      }
    }
    return null
  }

  /** NoteCard 底边拖拽区（图坐标） */
  private hitNoteCardResizeHandle(node: NodeInstance, gx: number, gy: number): boolean {
    if (node.class_type !== 'NoteCard') return false
    const zone = 10 / this.scale
    const bottom = node.y + node.height
    return gx >= node.x && gx <= node.x + node.width && gy >= bottom - zone && gy <= bottom + zone / 2
  }

  private setNoteCardHeightParam(node: NodeInstance, height: number): void {
    const h = Math.round(Math.min(NOTE_CARD_MAX_H, Math.max(NOTE_CARD_MIN_H, height)))
    node.height = h
    if (!node.params) node.params = {}
    if (node.collapsed !== false) {
      node.params.collapsed_height = h
    } else {
      node.params.expanded_height = h
    }
  }

  private getOutputSlotAt(gx: number, gy: number): { node: NodeInstance; slot: number } | null {
    for (const node of this.graph.nodes) {
      const def = registry.get(node.class_type)
      if (!def) continue
      for (let i = 0; i < def.outputs.length; i++) {
        const anchor = linkAnchor(node, i, 'out')
        if (Math.hypot(gx - anchor.x, gy - anchor.y) < SLOT_RADIUS + 8) {
          return { node, slot: i }
        }
      }
    }
    return null
  }

  private getInputSlotAt(gx: number, gy: number): { node: NodeInstance; slot: number } | null {
    for (const node of this.graph.nodes) {
      const def = registry.get(node.class_type)
      if (!def) continue
      const hitR = SLOT_RADIUS + 8
      for (let i = 0; i < def.inputs.length; i++) {
        const anchor = linkAnchor(node, i, 'in')
        if (Math.hypot(gx - anchor.x, gy - anchor.y) < hitR) {
          return { node, slot: i }
        }
      }
    }
    return null
  }

  private getLinkScreenPoints(link: Link): Vec2[] {
    const graphPts = this.getRoutedPath(link)
    if (graphPts.length >= 2) {
      return graphPts.map(p => this.graphToScreen(p.x, p.y))
    }
    const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
    const toNode = this.graph.nodes.find(n => n.id === link.to_node)
    if (!fromNode || !toNode) return []
    const fromAnchor = linkAnchor(fromNode, link.from_slot, 'out')
    const toAnchor = linkAnchor(toNode, link.to_slot, 'in')
    return [
      this.graphToScreen(fromAnchor.x, fromAnchor.y),
      this.graphToScreen(toAnchor.x, toAnchor.y),
    ]
  }

  private getRoutedPath(
    link: Link,
  ): Vec2[] {
    if (this.routeValid) {
      const cached = this.routeCache.get(link.id)
      if (cached) return cached
    }
    const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
    const toNode = this.graph.nodes.find(n => n.id === link.to_node)
    if (!fromNode || !toNode) return []
    const from = linkAnchor(fromNode, link.from_slot, 'out')
    const to = linkAnchor(toNode, link.to_slot, 'in')
    return buildFallbackPath(from, to)
  }

  private getForwardGraphPath(link: Link): Vec2[] {
    return this.getRoutedPath(link)
  }

  private getLinkAt(sx: number, sy: number): Link | null {
    const links = buildCanvasRoutingLinks(this.graph, {
      materializedLinks: this.lgMaterializedLinks,
      replayStep: this.lgReplayStep,
    })
    const threshold = 8
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i]
      const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
      const toNode = this.graph.nodes.find(n => n.id === link.to_node)
      if (isNoteCardNode(fromNode) || isNoteCardNode(toNode)) continue
      const pts = this.getLinkScreenPoints(link)
      if (hitTestPolyline(sx, sy, pts, threshold)) return link
    }
    return null
  }

  private onMouseDown(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const gp = this.screenToGraph(sx, sy)

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.panning = true
      this.panStart = { x: sx - this.offset.x, y: sy - this.offset.y }
      return
    }

    const outputHit = this.getOutputSlotAt(gp.x, gp.y)
    if (outputHit) {
      const anchor = linkAnchor(outputHit.node, outputHit.slot, 'out')
      this.linkDrag = {
        fromNode: outputHit.node.id,
        fromSlot: outputHit.slot,
        pos: this.graphToScreen(anchor.x, anchor.y),
      }
      this.canvas.focus()
      return
    }

    const linkHit = this.getLinkAt(sx, sy)
    if (linkHit) {
      this.selectedLink = linkHit.id
      this.selectedNode = null
      this.onLinkSelected?.(linkHit.id)
      this.onNodeSelected?.(null)
      this.canvas.focus()
      return
    }

    const hit = this.getNodeAt(gp.x, gp.y)
    if (hit) {
      if (hit.class_type === 'NoteCard' && this.hitNoteCardResizeHandle(hit, gp.x, gp.y)) {
        this.selectedLink = null
        this.onLinkSelected?.(null)
        this.selectedNode = hit.id
        this.noteCardResizing = { nodeId: hit.id, startHeight: hit.height, startMouseY: gp.y }
        this.onNodeSelected?.(hit.id)
        this.canvas.focus()
        return
      }
      this.selectedLink = null
      this.onLinkSelected?.(null)
      this.selectedNode = hit.id
      this.draggingNode = hit.id
      this.dragStart = { x: gp.x - hit.x, y: gp.y - hit.y }
      this.clickProbe = { nodeId: hit.id, sx, sy }
      this.dragMoved = false
      const idx = this.graph.nodes.indexOf(hit)
      this.graph.nodes.splice(idx, 1)
      this.graph.nodes.push(hit)
      this.onNodeSelected?.(hit.id)
      this.canvas.focus()
    } else {
      this.selectedNode = null
      this.selectedLink = null
      this.onNodeSelected?.(null)
      this.onLinkSelected?.(null)
      this.panning = true
      this.panStart = { x: sx - this.offset.x, y: sy - this.offset.y }
    }
  }

  private onMouseMove(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    if (this.panning) {
      this.offset.x = sx - this.panStart.x
      this.offset.y = sy - this.panStart.y
      return
    }

    const gp = this.screenToGraph(sx, sy)

    if (this.noteCardResizing) {
      const node = this.graph.nodes.find(n => n.id === this.noteCardResizing!.nodeId)
      if (node) {
        const dy = gp.y - this.noteCardResizing.startMouseY
        this.setNoteCardHeightParam(node, this.noteCardResizing.startHeight + dy)
        this.dragMoved = true
        this.routeValid = false
      }
      this.canvas.style.cursor = 'ns-resize'
      return
    }

    if (this.draggingNode) {
      const gpDrag = gp
      const node = this.graph.nodes.find(n => n.id === this.draggingNode)
      if (node) {
        if (Math.hypot(sx - (this.clickProbe?.sx ?? sx), sy - (this.clickProbe?.sy ?? sy)) > 4) {
          this.dragMoved = true
          this.routeValid = false
        }
        node.x = gpDrag.x - this.dragStart.x
        node.y = gpDrag.y - this.dragStart.y
      }
      return
    }

    if (this.linkDrag) {
      this.linkDrag.pos = { x: sx, y: sy }
      return
    }

    const hover = this.getNodeAt(gp.x, gp.y)
    const nextHoverId = hover?.id ?? null
    if (nextHoverId !== this.hoverNodeId) {
      this.hoverNodeId = nextHoverId
    }
    if (hover?.class_type === 'NoteCard' && this.hitNoteCardResizeHandle(hover, gp.x, gp.y)) {
      this.canvas.style.cursor = 'ns-resize'
    } else {
      this.canvas.style.cursor = hover ? 'pointer' : ''
    }
  }

  private onMouseLeave(): void {
    if (this.hoverNodeId) {
      this.hoverNodeId = null
    }
    this.canvas.style.cursor = ''
  }

  private onMouseUp(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    if (this.linkDrag) {
      const gp = this.screenToGraph(sx, sy)
      const inputHit = this.getInputSlotAt(gp.x, gp.y)
      if (inputHit && inputHit.node.id !== this.linkDrag.fromNode) {
        this.graph.addLink(
          this.linkDrag.fromNode,
          this.linkDrag.fromSlot,
          inputHit.node.id,
          inputHit.slot
        )
        this.invalidateWiringCache()
        this.rebuildLinkColors()
        this.recomputeRouting()
        this.onWorkflowChanged?.()
      }
      this.linkDrag = null
    }

    if (this.noteCardResizing) {
      if (this.dragMoved) {
        this.onWorkflowChanged?.()
      }
      this.noteCardResizing = null
    }

    if (this.draggingNode) {
      const wasDragging = this.dragMoved
      this.draggingNode = null
      if (wasDragging) {
        resolveCollisions(this.graph.nodes, { maxIterations: 50, overlapThreshold: 0.5, margin: 20 })
        this.recomputeRouting()
        this.onWorkflowChanged?.()
      }
    }

    if (this.clickProbe && !this.dragMoved) {
      const node = this.graph.nodes.find(n => n.id === this.clickProbe!.nodeId)
      if (node && isOutputTerminalNode(node)) {
        this.onOutputPreview?.(node.id)
      }
    }
    this.clickProbe = null
    this.dragMoved = false

    this.panning = false
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    const next = applyWheelToViewport(
      { scale: this.scale, offset: this.offset },
      {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      },
      { x: sx, y: sy },
    )
    this.scale = next.scale
    this.offset = next.offset
  }

  onExpandNode?: (nodeId: string, classType: string) => void

  private onDblClick(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const gp = this.screenToGraph(sx, sy)

    const hit = this.getNodeAt(gp.x, gp.y)
    if (hit) {
      if (hit.class_type === 'NoteCard') {
        hit.collapsed = !hit.collapsed
        applyNoteCardLayout(hit)
        this.onWorkflowChanged?.()
        return
      }
      const def = registry.get(hit.class_type)
      if (def?.expandable === true || def?.params?.expandable?.default === true) {
        this.onExpandNode?.(hit.id, hit.class_type)
      }
    }
  }

  private render(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1)
    const h = this.canvas.height / (window.devicePixelRatio || 1)
    const ctx = this.ctx

    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, w, h)
    this.drawGrid(w, h)
    this.drawLinks()
    this.drawWireSlotLabels()
    this.drawNodes()
    if (this.linkDrag) this.drawLinkDrag()
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx
    const gridSize = 20 * this.scale
    const dotRadius = Math.max(0.8, 1 * this.scale)

    const startX = this.offset.x % gridSize
    const startY = this.offset.y % gridSize

    ctx.fillStyle = COLORS.grid
    for (let x = startX; x < w; x += gridSize) {
      for (let y = startY; y < h; y += gridSize) {
        ctx.beginPath()
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  private getOpenSlots(): Set<string> {
    if (!this.openSlotsCache) {
      this.openSlotsCache = new Set(
        validateGraphWiring(this.graph).issues.map(i => `${i.nodeId}:${i.direction}:${i.slot}`),
      )
    }
    return this.openSlotsCache
  }

  private drawNodes(): void {
    const openSlots = this.getOpenSlots()
    for (const node of this.graph.nodes) {
      this.drawNode(node, openSlots)
    }
  }

  private drawNode(node: NodeInstance, openSlots: Set<string> = new Set()): void {
    if (node.class_type === 'NoteCard') {
      this.drawNoteCard(node)
      return
    }

    const ctx = this.ctx
    const def = registry.get(node.class_type)
    if (!def) return

    const isOutputEnd = isOutputTerminalNode(node)
    const hasOutputResult = isOutputEnd && outputNodeHasResult(node.id, this.executionResults)

    const sp = this.graphToScreen(node.x, node.y)
    const sw = node.width * this.scale
    const sh = node.height * this.scale
    const isSelected = node.id === this.selectedNode
    const isRunning = node.id === this.runningNode
    const isReplayHighlight = node.id === this.lgReplayHighlightNode && !isRunning
    const isStemCell = isStemCellClass(node.class_type)
    const isDifferentiated = this.lgDifferentiatedNodes.has(node.id)

    ctx.save()

    // Body background (no shadow to avoid ghosting)
    ctx.fillStyle = isOutputEnd
      ? (hasOutputResult ? '#dcfce7' : '#f0fdf4')
      : isStemCell
        ? (isDifferentiated ? '#f3e8ff' : '#faf5ff')
        : (isSelected ? COLORS.nodeSelected : COLORS.node)
    const radius = 8 * this.scale
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.fill()

    // Selection/running/replay glow: outer stroke ring
    if (isSelected || isRunning || isReplayHighlight) {
      const glowColor = isRunning ? COLORS.running : isReplayHighlight ? '#f59e0b' : COLORS.borderSelected
      ctx.save()
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 3 * this.scale
      ctx.globalAlpha = 0.6
      this.roundRect(sp.x - 2 * this.scale, sp.y - 2 * this.scale, sw + 4 * this.scale, sh + 4 * this.scale, radius + 2 * this.scale)
      ctx.stroke()
      ctx.globalAlpha = 0.25
      ctx.lineWidth = 6 * this.scale
      this.roundRect(sp.x - 4 * this.scale, sp.y - 4 * this.scale, sw + 8 * this.scale, sh + 8 * this.scale, radius + 4 * this.scale)
      ctx.stroke()
      ctx.restore()
    }

    // Border
    ctx.strokeStyle = isOutputEnd
      ? (hasOutputResult ? '#16a34a' : '#4ade80')
      : isRunning ? COLORS.running : isReplayHighlight ? '#f59e0b' : (isSelected ? COLORS.borderSelected : (isStemCell ? '#9333ea' : COLORS.border))
    ctx.lineWidth = isSelected ? 2 : 1
    if (isStemCell && !isDifferentiated) ctx.setLineDash([6 * this.scale, 4 * this.scale])
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.stroke()
    ctx.setLineDash([])

    // Header
    ctx.fillStyle = isOutputEnd
      ? (def.color || '#166534')
      : (def.color || (isSelected ? COLORS.nodeHeaderSelected : COLORS.nodeHeader))
    const headerH = HEADER_HEIGHT * this.scale
    this.roundRectTop(sp.x, sp.y, sw, headerH, radius)
    ctx.fill()

    // Title — dynamic: show content value if available, fallback to display_name
    ctx.fillStyle = COLORS.headerText
    const refFont = 18
    const titlePx = refFont * this.scale
    const bodyPx = refFont * this.scale
    const lineH = refFont * this.scale
    const innerGraphW = node.width - 20
    ctx.font = `bold ${titlePx}px "SimSun", "宋体", "Songti SC", sans-serif`
    ctx.textBaseline = 'middle'
    const title = this.truncateGraphLines(this.getNodeTitle(node, def), innerGraphW, refFont, 'bold')
    ctx.fillText(title, sp.x + 10 * this.scale, sp.y + headerH / 2, sw - 20 * this.scale)

    // Category badge — for SSoT_Feature, show status as colored dot instead
    if (node.class_type === 'SSoT_Feature') {
      const status = String(node.params?.status || 'planned')
      const testStatus = String(node.params?.test_status || 'pending')
      let dotColor: string
      if (status === 'done' && testStatus === 'passed') {
        dotColor = '#2ea043'
      } else if (status === 'done' && testStatus === 'failed') {
        dotColor = '#f85149'
      } else if (status === 'done') {
        dotColor = '#a3d977'
      } else if (status === 'in_progress') {
        dotColor = '#58a6ff'
      } else if (status === 'blocked') {
        dotColor = '#f85149'
      } else {
        dotColor = '#d29922'
      }
      ctx.fillStyle = dotColor
      ctx.beginPath()
      ctx.arc(sp.x + sw - 12 * this.scale, sp.y + headerH / 2, 4 * this.scale, 0, Math.PI * 2)
      ctx.fill()
    } else if (isOutputEnd) {
      ctx.fillStyle = hasOutputResult ? '#bbf7d0' : 'rgba(255,255,255,0.35)'
      ctx.font = `bold ${titlePx}px "SimSun", "宋体", "Songti SC", sans-serif`
      ctx.textAlign = 'right'
      ctx.fillText(hasOutputResult ? '已出结果' : '输出', sp.x + sw - 8 * this.scale, sp.y + headerH / 2)
      ctx.textAlign = 'left'
    } else if (
      this.runningNode === node.id
      || this.executionResults?.[node.id]
    ) {
      /* 运行状态徽章在 drawComponentRunBadge */
    } else {
      ctx.fillStyle = COLORS.headerTextMuted
      ctx.font = `bold ${titlePx}px "SimSun", "宋体", "Songti SC", sans-serif`
      ctx.textAlign = 'right'
      ctx.fillText(def.category.split('/').pop() || '', sp.x + sw - 8 * this.scale, sp.y + headerH / 2)
      ctx.textAlign = 'left'
    }

    if (node.collapsed) {
      ctx.restore()
      return
    }

    // Content preview (show key params) — skip on compact Output end card
    if (!isOutputEnd) {
      const contentLines = buildNodeContentPreviewLines(
        node,
        def,
        (text) => this.wrapGraphLines(text, innerGraphW, refFont),
        this.executionResults?.[node.id],
      )
      if (contentLines.length > 0) {
        ctx.fillStyle = COLORS.text
        ctx.font = `bold ${bodyPx}px "SimSun", "宋体", "Songti SC", sans-serif`
        ctx.textBaseline = 'top'
        const contentY = sp.y + headerH + 6 * this.scale
        const maxLines = Math.min(contentLines.length, maxContentPreviewLines())
        for (let i = 0; i < maxLines; i++) {
          ctx.fillText(contentLines[i], sp.x + 10 * this.scale, contentY + i * lineH)
        }
      }
    }

    const slotScreenY = (slot: number) => this.graphToScreen(0, slotGraphY(node, slot)).y

    // Input slots
    for (let i = 0; i < def.inputs.length; i++) {
      const sy = slotScreenY(i)
      const isOpen = openSlots.has(`${node.id}:input:${i}`)
      if (isOpen) {
        ctx.strokeStyle = COLORS.error
        ctx.lineWidth = 2 * this.scale
        ctx.beginPath()
        ctx.arc(sp.x, sy, (SLOT_RADIUS + 4) * this.scale, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = isOpen ? COLORS.error : COLORS.slotInput
      ctx.beginPath()
      ctx.arc(sp.x, sy, SLOT_RADIUS * this.scale, 0, Math.PI * 2)
      ctx.fill()

    }

    // Output slots
    for (let i = 0; i < def.outputs.length; i++) {
      const sy = slotScreenY(i)
      const isOpen = openSlots.has(`${node.id}:output:${i}`)
      if (isOpen) {
        ctx.strokeStyle = COLORS.error
        ctx.lineWidth = 2 * this.scale
        ctx.beginPath()
        ctx.arc(sp.x + sw, sy, (SLOT_RADIUS + 4) * this.scale, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = isOpen ? COLORS.error : COLORS.slotOutput
      ctx.beginPath()
      ctx.arc(sp.x + sw, sy, SLOT_RADIUS * this.scale, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = COLORS.slotOutputBorder
      ctx.lineWidth = 1.5 * this.scale
      ctx.stroke()
    }

    this.drawComponentRunBadge(sp, sw, headerH, node.id)

    ctx.restore()
  }

  /** Dify 式：标题行右侧运行状态（非变量名） */
  private drawComponentRunBadge(sp: Vec2, sw: number, headerH: number, componentId: string): void {
    const r = this.executionResults?.[componentId]
    if (!r && this.runningNode !== componentId) return
    const ctx = this.ctx
    const x = sp.x + sw - 10 * this.scale
    const y = sp.y + headerH / 2
    ctx.font = `bold ${18 * this.scale}px "SimSun", "宋体", "Songti SC", sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    if (this.runningNode === componentId) {
      ctx.fillStyle = COLORS.running
      ctx.fillText('…', x, y)
    } else if (r?.error) {
      ctx.fillStyle = COLORS.error
      ctx.fillText('✕', x, y)
    } else if (r) {
      ctx.fillStyle = '#16a34a'
      ctx.fillText('✓', x, y)
    }
    ctx.textAlign = 'left'
  }

  private drawNoteCard(node: NodeInstance): void {
    const ctx = this.ctx
    const def = registry.get(node.class_type)
    if (!def) return

    if (node.height < 40) applyNoteCardLayout(node)

    const sp = this.graphToScreen(node.x, node.y)
    const sw = node.width * this.scale
    const sh = node.height * this.scale
    const cardColor = String(node.params.color ?? '#2d3748')
    const isSelected = node.id === this.selectedNode
    const radius = 6 * this.scale

    ctx.save()
    ctx.fillStyle = cardColor
    ctx.globalAlpha = 0.92
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.fill()
    ctx.globalAlpha = 1

    ctx.strokeStyle = isSelected ? COLORS.borderSelected : '#4a5568'
    ctx.lineWidth = isSelected ? 2 : 1
    ctx.setLineDash([4 * this.scale, 3 * this.scale])
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = '#e2e8f0'
    ctx.font = `bold ${11 * this.scale}px -apple-system, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillText('📝 注释', sp.x + 8 * this.scale, sp.y + 6 * this.scale)

    const content = String(node.params.content ?? '').trim()
    const bodySize = getNoteCardBodyFontSize(node.params)
    const preview = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, '') || '（双击展开编辑内容）'
    ctx.fillStyle = '#cbd5e0'
    if (node.collapsed) {
      ctx.font = `${bodySize * this.scale}px -apple-system, sans-serif`
      const line = preview.length > 48 ? preview.slice(0, 46) + '…' : preview
      ctx.fillText(line, sp.x + 8 * this.scale, sp.y + 24 * this.scale, sw - 16 * this.scale)
    } else {
      const avgLineH = bodySize * 1.4
      const maxLines = Math.max(8, Math.floor((node.height - 24 - 20) / avgLineH))
      const lines = parseNoteCardMarkdown(content, maxLines)
      let y = sp.y + 24 * this.scale
      for (const line of lines) {
        const metrics = noteCardLineMetrics(line, bodySize)
        const weight = line.heading || line.bold ? 'bold' : 'normal'
        ctx.font = `${weight} ${metrics.fontSize * this.scale}px ${line.code ? 'monospace' : '-apple-system, sans-serif'}`
        ctx.fillStyle = line.heading ? '#f7fafc' : line.code ? '#a0aec0' : '#cbd5e0'
        const display = line.text.length > 56 ? line.text.slice(0, 54) + '…' : line.text
        ctx.fillText(display, sp.x + 8 * this.scale, y, sw - 16 * this.scale)
        y += metrics.lineHeight * this.scale
      }
    }

    if (node.collapsed) {
      ctx.fillStyle = '#718096'
      ctx.font = `${8 * this.scale}px sans-serif`
      ctx.fillText('双击展开', sp.x + 8 * this.scale, sp.y + sh - 14 * this.scale)
    }

    if (isSelected) {
      const gripY = sp.y + sh - 5 * this.scale
      const gripW = 24 * this.scale
      const gripX = sp.x + (sw - gripW) / 2
      ctx.fillStyle = '#a0aec0'
      ctx.fillRect(gripX, gripY, gripW, 3 * this.scale)
    }

    ctx.restore()
  }

  private drawAnnotationLink(note: NodeInstance, target: NodeInstance): void {
    const ctx = this.ctx
    const noteCenter = this.graphToScreen(note.x + note.width / 2, note.y + note.height / 2)
    const targetCenter = this.graphToScreen(target.x + target.width / 2, target.y + target.height / 2)
    ctx.save()
    ctx.strokeStyle = '#718096'
    ctx.lineWidth = 1.5 * this.scale
    ctx.setLineDash([6 * this.scale, 4 * this.scale])
    ctx.globalAlpha = 0.75
    ctx.beginPath()
    ctx.moveTo(noteCenter.x, noteCenter.y)
    ctx.lineTo(targetCenter.x, targetCenter.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.restore()
  }

  private drawLinks(): void {
    this.rebuildLinkColors()
    const backLinks = this.getBackLinks()
    const links = buildCanvasRoutingLinks(this.graph, {
      materializedLinks: this.lgMaterializedLinks,
      replayStep: this.lgReplayStep,
    })
    for (const link of links) {
      this.drawLink(link, backLinks)
    }
  }

  private drawLink(
    link: Link,
    backLinks: Set<string> | undefined,
  ): void {
    const ctx = this.ctx
    const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
    const toNode = this.graph.nodes.find(n => n.id === link.to_node)
    if (!fromNode || !toNode) return

    if (isNoteCardNode(fromNode) || isNoteCardNode(toNode)) {
      this.drawAnnotationLink(
        isNoteCardNode(fromNode) ? fromNode : toNode,
        isNoteCardNode(fromNode) ? toNode : fromNode,
      )
      return
    }

    const fromAnchor = linkAnchor(fromNode, link.from_slot, 'out')
    const toAnchor = linkAnchor(toNode, link.to_slot, 'in')
    const from = this.graphToScreen(fromAnchor.x, fromAnchor.y)
    const to = this.graphToScreen(toAnchor.x, toAnchor.y)

    const isLinkSelected = link.id === this.selectedLink
    const isActive = this.runningNode === link.from_node || this.runningNode === link.to_node
    const isBackward = isBackwardLink(link, this.graph.nodes, backLinks)
    const lgMat = isLgMaterializedVirtualLink(link.id)
    const lgSpecKind = this.graph.library === 'LG'
      ? lgSpecEdgeKind(link.id, this.graph.lgEdges)
      : null
    const isLgConditional = lgSpecKind === 'conditional'

    const graphPts = this.getRoutedPath(link)
    const screenPts = graphPts.map(wp => this.graphToScreen(wp.x, wp.y))

    const dashed = isBackward || isLgConditional
    const strokeColor = isActive
      ? COLORS.linkActive
      : lgMat
        ? '#16a34a'
        : isLgConditional
          ? '#a78bfa'
          : isBackward
            ? linkBackwardColor(link.id, this.linkColorMaps)
            : linkForwardColor(link.id, this.linkColorMaps)
    const hovered = this.hoverNodeId != null
      && (link.from_node === this.hoverNodeId || link.to_node === this.hoverNodeId)
    const baseWidth =
      (lgMat ? 3 : isActive ? 2.5 : hovered ? DEFAULT_LINK_LINE_WIDTH + 0.75 : DEFAULT_LINK_LINE_WIDTH)
      * this.scale

    if (isLinkSelected && screenPts.length >= 2) this.drawLinkHighlight(screenPts, baseWidth + 4)
    const baseAlpha = isActive ? 1 : lgMat ? 0.9 : isLgConditional ? 0.55 : 0.95
    ctx.strokeStyle = hovered && !isActive ? COLORS.linkActive : strokeColor
    ctx.lineWidth = baseWidth
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    ctx.globalAlpha = linkHoverAlpha(link, this.hoverNodeId, baseAlpha)
    if (dashed) ctx.setLineDash([8 * this.scale, 4 * this.scale])

    this.drawOrthogonalPath(screenPts)
    ctx.setLineDash([])
    ctx.globalAlpha = 1

  }

  /** 连线变量名 — 与组件相同：Canvas + graphToScreen + fontPx∝scale */
  private drawWireSlotLabels(): void {
    if (!this.hoverNodeId && !this.selectedLink) return
    const ctx = this.ctx
    const fontPx = 12 * this.scale
    const pad = 4 * this.scale
    const edgeGap = 6
    const alongPx = 14 * this.scale
    const normalPx = 8 * this.scale
    const font = `bold ${fontPx}px "SimSun", "宋体", "Songti SC", sans-serif`

    const links = buildCanvasRoutingLinks(this.graph, {
      materializedLinks: this.lgMaterializedLinks,
      replayStep: this.lgReplayStep,
    })

    const placements: Array<{
      linkId: string
      text: string
      place: ReturnType<typeof linkLabelAnchor>
      emphasized: boolean
    }> = []

    for (const link of links) {
      const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
      const toNode = this.graph.nodes.find(n => n.id === link.to_node)
      if (!fromNode || !toNode) continue
      if (isNoteCardNode(fromNode) || isNoteCardNode(toNode)) continue
      if (!shouldShowLinkSlotLabel(link, this.hoverNodeId, this.selectedLink)) continue
      const graphPts = this.getRoutedPath(link)
      const screenPts = graphPts.map(wp => this.graphToScreen(wp.x, wp.y))
      if (screenPts.length < 2) continue
      const focusId =
        this.hoverNodeId
        ?? (link.id === this.selectedLink ? link.from_node : null)
      const fromSp = this.graphToScreen(fromNode.x, fromNode.y)
      const toSp = this.graphToScreen(toNode.x, toNode.y)
      const place = linkLabelAnchor(link, focusId, screenPts, alongPx, normalPx, {
        from: { x: fromSp.x, y: fromSp.y, w: fromNode.width * this.scale, h: fromNode.height * this.scale },
        to: { x: toSp.x, y: toSp.y, w: toNode.width * this.scale, h: toNode.height * this.scale },
      }, edgeGap)
      placements.push({
        linkId: link.id,
        text: formatLinkSlotLabel(link, this.graph.nodes),
        place,
        emphasized: link.id === this.selectedLink,
      })
    }

    const rows = placements
      .map(p => ({ screenX: p.place.x, screenY: p.place.y, p }))
      .sort((a, b) =>
        a.screenY - b.screenY
        || a.screenX - b.screenX
        || a.p.linkId.localeCompare(b.p.linkId),
      )
    separateWireLabelPositions(rows, fontPx * 1.5)
    for (const row of rows) row.p.place.y = row.screenY

    ctx.save()
    ctx.font = font
    for (const { text, place, emphasized } of rows.map(r => r.p)) {
      const tw = ctx.measureText(text).width
      const th = fontPx * 1.25
      const w = tw + pad * 2
      const h = th + pad * 2
      const bx = place.align === 'left' ? place.x - w : place.x
      const by = place.y - h / 2
      ctx.fillStyle = emphasized ? '#2563eb' : '#475569'
      this.roundRect(bx, by, w, h, 3 * this.scale)
      ctx.fill()
      ctx.strokeStyle = emphasized ? '#fff' : '#e2e8f0'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.textAlign = place.align === 'left' ? 'right' : 'left'
      const tx = place.align === 'left' ? place.x - pad : place.x + pad
      ctx.fillText(text, tx, place.y)
    }
    ctx.restore()
  }

  /** 选中连线白色外描边 */
  private drawLinkHighlight(screenPts: Vec2[], width: number): void {
    if (screenPts.length < 2) return
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = 0.95
    ctx.beginPath()
    ctx.moveTo(screenPts[0].x, screenPts[0].y)
    for (let i = 1; i < screenPts.length; i++) {
      ctx.lineTo(screenPts[i].x, screenPts[i].y)
    }
    ctx.stroke()
    ctx.restore()
  }

  /** 横平竖直 + 90° 圆角（arcTo） */
  private drawOrthogonalPath(pts: Vec2[]): void {
    if (pts.length < 2) return
    const ctx = this.ctx
    const r = DEFAULT_WIRE_ROUTING_OPTIONS.cornerRadius * this.scale

    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)

    if (r <= 0 || pts.length === 2) {
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y)
      }
      ctx.stroke()
      return
    }

    for (let i = 1; i < pts.length - 1; i++) {
      ctx.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r)
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    ctx.stroke()
  }

  private drawLinkDrag(): void {
    if (!this.linkDrag) return
    const ctx = this.ctx

    const toGraph = this.screenToGraph(this.linkDrag.pos.x, this.linkDrag.pos.y)
    const pts = routeSingleDrag(
      this.graph.nodes,
      this.linkDrag.fromNode,
      this.linkDrag.fromSlot,
      toGraph,
    )
    const screenPts = pts.map(p => this.graphToScreen(p.x, p.y))
    screenPts[screenPts.length - 1] = this.linkDrag.pos

    ctx.strokeStyle = COLORS.linkActive
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    this.drawOrthogonalPath(screenPts)
    ctx.setLineDash([])
  }

  private getNodeTitle(node: NodeInstance, def: NodeDef): string {
    const params = node.params || {}

    switch (node.class_type) {
      case 'SSoT_Project':
        return params.name ? String(params.name) : def.display_name
      case 'SSoT_Requirement': {
        const id = params.id ? String(params.id) : ''
        const need = params.need ? String(params.need) : ''
        if (id && need) {
          const combined = `${id}: ${need}`
          return combined.length > 30 ? combined.slice(0, 28) + '...' : combined
        }
        if (need) return need.length > 30 ? need.slice(0, 28) + '...' : need
        return def.display_name
      }
      case 'SSoT_Feature':
        return params.name ? String(params.name) : def.display_name
      case 'SSoT_Blocker':
        return params.description ? String(params.description).slice(0, 28) : def.display_name
      case 'Planner':
        return params.goal ? `规划: ${String(params.goal).slice(0, 22)}` : def.display_name
      case 'AgentWorkflow':
        return params.workflow_name
          ? String(params.workflow_name)
          : def.display_name
      default:
        return def.display_name
    }
  }

  /**
   * 在图坐标宽度下断行/截断（固定 refFont，不随 scale 变）。
   * 框与字同比缩放时，每行字数不变 → 缩放不跳行。
   */
  private truncateGraphLines(
    text: string,
    graphInnerWidth: number,
    refFontSize: number,
    weight = 'normal',
  ): string {
    const lines = this.wrapGraphLines(text, graphInnerWidth, refFontSize, weight, 1)
    if (lines.length <= 1) return lines[0] ?? text
    const first = lines[0]
    const ctx = this.ctx
    const prev = ctx.font
    ctx.font = `${weight} ${refFontSize}px "SimSun", "宋体", "Songti SC", sans-serif`
    const maxW = graphInnerWidth
    if (ctx.measureText(first).width <= maxW) {
      ctx.font = prev
      return `${first}…`
    }
    let s = first
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1)
    ctx.font = prev
    return `${s}…`
  }

  private wrapGraphLines(
    text: string,
    graphInnerWidth: number,
    refFontSize: number,
    weight = 'bold',
    maxLines = maxContentPreviewLines(),
  ): string[] {
    const maxW = graphInnerWidth
    if (maxW <= 0) return [text]
    const ctx = this.ctx
    const prev = ctx.font
    ctx.font = `${weight} ${refFontSize}px "SimSun", "宋体", "Songti SC", sans-serif`
    const result: string[] = []
    let remaining = text.trim()
    while (remaining.length > 0 && result.length < maxLines) {
      if (ctx.measureText(remaining).width <= maxW) {
        result.push(remaining)
        break
      }
      let lo = 1
      let hi = remaining.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (ctx.measureText(remaining.slice(0, mid)).width <= maxW) lo = mid
        else hi = mid - 1
      }
      let cut = lo
      const slice = remaining.slice(0, cut)
      const comma = slice.lastIndexOf('，')
      const sep = slice.lastIndexOf('、')
      const space = slice.lastIndexOf(' ')
      const bestBreak = Math.max(comma, sep, space)
      if (bestBreak > cut * 0.35) cut = bestBreak + 1
      result.push(remaining.slice(0, cut))
      remaining = remaining.slice(cut)
    }
    ctx.font = prev
    return result
  }

  /** 按像素宽度换行（避免 fillText maxWidth 把长行横向压扁） */
  private wrapTextToWidth(
    text: string,
    maxWidthPx: number,
    fontSizePx: number,
    weight = 'normal',
  ): string[] {
    const ctx = this.ctx
    const prev = ctx.font
    ctx.font = `${weight} ${fontSizePx}px "SimSun", "宋体", "Songti SC", sans-serif`
    const result: string[] = []
    let line = ''
    for (const ch of text) {
      const next = line + ch
      if (line && ctx.measureText(next).width > maxWidthPx) {
        result.push(line)
        line = ch
        if (result.length >= 5) break
      } else {
        line = next
      }
    }
    if (line && result.length < 5) result.push(line)
    ctx.font = prev
    return result
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }

  private roundRectTop(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }
}
