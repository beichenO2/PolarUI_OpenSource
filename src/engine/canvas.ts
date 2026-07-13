import type { NodeInstance, Link, NodeDef } from './types'
import { applyWheelToViewport } from './canvas-viewport'
import { registry } from './registry'
import { buildNodeContentPreviewLines, maxContentPreviewLines } from './node-content-preview'
import { nodeArchetype } from './node-archetype'
import {
  nodeShape,
  isFnCollapsed,
  keyParamLine,
  traceNodeShapePath,
  traceShapeDetail,
  cylinderRy,
  type NodeShapeKind,
} from './node-shape'
import { activeCanvasTheme, type CanvasTheme } from './canvas-theme'
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
  normalizeNodeDimension,
  slotGraphY,
  isBackwardLink,
  isNoteCardNode,
  isOutputTerminalNode,
  normalizeAllOutputTerminals,
  type Vec2,
} from './node-geometry'
import { buildFallbackPath } from './wire-path'
import { resolveCollisions } from './resolve-collisions'
import { buildLinkColorMaps, linkBackwardColor, linkForwardColor, buildRoutingOffsetColorMap, type LinkColorMaps } from './wire-colors'
import { hitTestPolyline } from './link-hit'
import { routeAllLinks, routeSingleDrag, offsetParallelSegments } from './wire-router'
import { nudgeParallelSegments } from './wire-nudge'

import { detectCrossings, type CrossingPoint } from './wire-crossings'
import type { ExecutionState } from './types'
import { outputNodeHasResult } from './output-result'
import { buildCanvasRoutingLinks, buildCanvasRoutingNodes, buildCanvasViewGraph } from './wire-routing-links'
import {
  createGroup,
  ungroupGroup,
  moveGroupMembers,
  nextGroupTitle,
  groupBoxNodeId,
  type ViewGraphResult,
} from './graph-groups'
import {
  drawExpandedGroupFrame,
  drawGroupBoxNode,
  drawSuggestionPreview,
  hitTestExpandedTitleBar,
  suggestionBounds,
  isGroupBoxNode,
} from './canvas-group-layer'
import type { SuggestedGroup } from './group-suggest'
import { suggestionToGroup } from './group-suggest'
import { shouldInvokeNodeDblClick } from './canvas-dblclick'
import { linkFocusAlpha } from './link-hover'
import {
  formatLinkSlotLabel,
  formatWireChipLabel,
  labelOffsetFromPath,
  linkLabelAnchor,
  nudgeOverlappingWireChips,
  pathNormalAtSegment,
  polylineMidpoint,
  polylineMidpointSegmentIndex,
  separateWireLabelPositions,
  shouldShowLinkSlotLabel,
  WIRE_CHIP_ZOOM_THRESHOLD,
  type WireChipRect,
} from './link-slot-label'
import { CANVAS_FONT_UI, CANVAS_FONT_MONO } from './canvas-fonts'

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

/**
 * Canvas2D color tokens — theme-aware（light / hermes）。
 * 每帧 render 前经 refreshCanvasTheme() 同步；SSOT 在 canvas-theme.ts。
 */
export { CANVAS_LIGHT as CANVAS_COLORS } from './canvas-theme'

let COLORS: CanvasTheme = activeCanvasTheme()

function refreshCanvasTheme(): void {
  COLORS = activeCanvasTheme()
}

export { CANVAS_FONT_UI, CANVAS_FONT_MONO } from './canvas-fonts'

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
  private dragRouteRaf = 0
  private executionResults: ExecutionState['results']
  private nodeStates: ExecutionState['node_states']
  private clickProbe: { nodeId: string; sx: number; sy: number } | null = null
  private dragMoved = false
  private noteCardResizing: { nodeId: string; startHeight: number; startMouseY: number } | null = null
  /** §2 260531：悬停节点 id，关联边高亮 */
  private hoverNodeId: string | null = null
  private selectedNodeIds: Set<string> = new Set()
  /** Run trace replay / scrubber highlight (green ring) */
  private traceHighlightNodeIds: Set<string> = new Set()
  private viewGraphCache: ViewGraphResult | null = null
  private draggingGroupId: string | null = null
  private groupDragStart: Vec2 = { x: 0, y: 0 }
  private groupSuggestionsPreview: SuggestedGroup[] = []

  onNodeSelected?: (nodeId: string | null) => void
  /** Fired on node double-click (after NoteCard / group-box internal handling). */
  onNodeDblClick?: (node: NodeInstance) => void
  onLinkSelected?: (linkId: string | null) => void
  onWorkflowChanged?: () => void
  onOutputPreview?: (nodeId: string) => void
  onNodeInspect?: (nodeId: string, outputs: Record<string, unknown>) => void

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
    this.selectedNodeIds = new Set()
    this.openSlotsCache = null
    this.viewGraphCache = null
    normalizeAllOutputTerminals(graph.nodes)
    applyNoteCardLayoutAll(graph.nodes)
    this.rebuildLinkColors()
    this.recomputeRouting()
    this.resetView()
  }

  private rebuildLinkColors(): void {
    const links = buildCanvasRoutingLinks(this.graph)
    this.linkColorMaps = buildLinkColorMaps(
      links,
      this.graph.nodes,
      this.getBackLinks(),
      this.executionResults,
      this.crossingCache,
      this.routeCache,
      this.graph.lgEdges,
    )
  }

  private invalidateViewGraph(): void {
    this.viewGraphCache = null
  }

  private getViewGraph(): ViewGraphResult {
    if (!this.viewGraphCache) {
      this.viewGraphCache = buildCanvasViewGraph(this.graph)
    }
    return this.viewGraphCache
  }

  getSelectedNodeIds(): string[] {
    if (this.selectedNodeIds.size > 0) return [...this.selectedNodeIds]
    return this.selectedNode ? [this.selectedNode] : []
  }

  collapseSelectionAsGroup(title?: string): boolean {
    const ids = this.getSelectedNodeIds().filter(id => {
      const n = this.graph.nodes.find(x => x.id === id)
      return n && !isGroupBoxNode(n)
    })
    if (ids.length < 2) return false
    const g = createGroup({
      nodeIds: ids,
      title: title ?? nextGroupTitle(this.graph.groups),
      existingGroups: this.graph.groups,
      collapsed: true,
    })
    this.graph.groups = [...this.graph.groups, g]
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
    return true
  }

  expandGroupById(groupId: string): void {
    const grp = this.graph.groups.find(x => x.id === groupId)
    if (!grp) return
    grp.collapsed = false
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
  }

  toggleGroupCollapsed(groupId: string): void {
    const grp = this.graph.groups.find(x => x.id === groupId)
    if (!grp) return
    grp.collapsed = !grp.collapsed
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
  }

  ungroupById(groupId: string): void {
    this.graph.groups = ungroupGroup(this.graph.groups, groupId)
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
  }

  setGroupSuggestionsPreview(suggestions: SuggestedGroup[]): void {
    this.groupSuggestionsPreview = suggestions
  }

  adoptGroupSuggestion(suggestionId: string): boolean {
    const s = this.groupSuggestionsPreview.find(x => x.id === suggestionId)
    if (!s) return false
    this.graph.groups = [...this.graph.groups, suggestionToGroup(s, true)]
    this.groupSuggestionsPreview = this.groupSuggestionsPreview.filter(x => x.id !== suggestionId)
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
    return true
  }

  private syncSelectionPrimary(): void {
    if (this.selectedNodeIds.size === 1) {
      this.selectedNode = [...this.selectedNodeIds][0]
    } else if (this.selectedNodeIds.size === 0) {
      this.selectedNode = null
    } else {
      this.selectedNode = [...this.selectedNodeIds].sort()[0]
    }
  }

  private toggleSelection(nodeId: string): void {
    const base = this.selectedNodeIds.size
      ? this.selectedNodeIds
      : (this.selectedNode ? new Set([this.selectedNode]) : new Set<string>())
    const next = new Set(base)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    this.selectedNodeIds = next
    this.syncSelectionPrimary()
  }

  private routingNodes(): NodeInstance[] {
    return buildCanvasRoutingNodes(this.graph)
  }

  private getBackLinks(): Set<string> | undefined {
    return (this.graph as Graph & { _backLinks?: Set<string> })._backLinks
  }

  refreshWireRouting(): void {
    // 外部（palette 拖放等）改图后必须失效视图缓存，否则 getNodeAt 用旧
    // 空视图命中失败——新节点画得出来但点不中（R11 批4实测修复）。
    this.invalidateViewGraph()
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

  private invalidateWiringCache(): void {
    this.openSlotsCache = null
    this.invalidateViewGraph()
  }

  private recomputeRouting(): void {
    const viewNodes = this.routingNodes()
    const links = buildCanvasRoutingLinks(this.graph)
    const backLinks = this.getBackLinks()
    const paths = routeAllLinks(viewNodes, links, backLinks)

    const crossings = detectCrossings(paths)
    this.crossingCache = crossings

    this.linkColorMaps = buildLinkColorMaps(
      links, viewNodes, backLinks,
      this.executionResults, crossings, paths,
      this.graph.lgEdges,
    )

    const colorOf = buildRoutingOffsetColorMap(links, viewNodes, backLinks, crossings, paths)
    offsetParallelSegments(paths, colorOf)
    const nudged = nudgeParallelSegments(paths)

    this.routeCache = nudged
    this.routeValid = true
  }

  private scheduleDragReroute(): void {
    if (this.dragRouteRaf) return
    this.dragRouteRaf = requestAnimationFrame(() => {
      this.dragRouteRaf = 0
      this.recomputeRouting()
    })
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

  setExecutionResults(results: ExecutionState['results']): void {
    this.executionResults = results
    this.rebuildLinkColors()
  }

  setNodeStates(states: ExecutionState['node_states']): void {
    this.nodeStates = states
    if (states) {
      const running = Object.entries(states).find(([, s]) => s.status === 'running')
      this.runningNode = running ? running[0] : null
    }
  }

  /** Highlight nodes during run trace scrubber / replay (#059669 ring). */
  setTraceHighlight(nodeIds: string[]): void {
    this.traceHighlightNodeIds = new Set(nodeIds)
  }

  getSelectedNode(): string | null {
    return this.selectedNode
  }

  /** Checklist / 外部跳转：选中画布节点 */
  focusNode(nodeId: string | null): void {
    this.selectedLink = null
    this.onLinkSelected?.(null)
    this.selectedNode = nodeId
    this.selectedNodeIds = nodeId ? new Set([nodeId]) : new Set()
    this.onNodeSelected?.(nodeId)
  }

  getSelectedLink(): string | null {
    return this.selectedLink
  }

  /** Delete 键：优先删选中连线，否则删选中组件 */
  /** Cmd/Ctrl+D — duplicate selected node(s), +24px offset, copy params, no links */
  duplicateSelection(): boolean {
    const ids = this.getSelectedNodeIds().filter(id => {
      const n = this.graph.nodes.find(x => x.id === id)
      return n && !isGroupBoxNode(n)
    })
    if (ids.length === 0) return false

    const OFFSET = 24
    const newIds: string[] = []

    for (const id of ids) {
      const source = this.graph.nodes.find(n => n.id === id)
      if (!source) continue

      const dup = this.graph.addNode(source.class_type, source.x + OFFSET, source.y + OFFSET)
      if (!dup) continue

      dup.params = structuredClone(source.params ?? {})
      dup.width = source.width
      dup.height = source.height
      if (source.collapsed !== undefined) dup.collapsed = source.collapsed
      if (source.class_type === 'NoteCard') applyNoteCardLayout(dup)

      newIds.push(dup.id)
    }

    if (newIds.length === 0) return false

    this.selectedNodeIds = new Set(newIds)
    this.syncSelectionPrimary()
    this.selectedLink = null
    this.onLinkSelected?.(null)
    this.onNodeSelected?.(this.selectedNode)
    this.invalidateWiringCache()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
    return true
  }

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

  /** Force one paint pass (e.g. after web fonts finish loading). */
  requestRender(): void {
    this.render()
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
    this.canvas.addEventListener('contextmenu', this.onContextMenu.bind(this))
    window.addEventListener('resize', () => this.resize())
  }

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        if (this.duplicateSelection()) {
          e.preventDefault()
          return
        }
      }
      if (e.key === 'g' || e.key === 'G') {
        const title = nextGroupTitle(this.graph.groups)
        if (this.collapseSelectionAsGroup(title)) {
          e.preventDefault()
          return
        }
      }
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (this.deleteSelection()) {
      e.preventDefault()
    }
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const gp = this.screenToGraph(e.clientX - rect.left, e.clientY - rect.top)
    for (const s of this.groupSuggestionsPreview) {
      const b = suggestionBounds(this.graph.nodes, s.node_ids)
      if (b && gp.x >= b.x && gp.x <= b.x + b.w && gp.y >= b.y && gp.y <= b.y + b.h) {
        this.adoptGroupSuggestion(s.id)
        return
      }
    }
    const ids = this.getSelectedNodeIds()
    if (ids.length >= 2) {
      const title = window.prompt('组名称', nextGroupTitle(this.graph.groups))
      if (title?.trim()) this.collapseSelectionAsGroup(title.trim())
    }
  }

  private hitExpandedGroupTitle(gp: Vec2): string | null {
    const view = this.getViewGraph()
    for (const frame of view.expandedFrames) {
      if (hitTestExpandedTitleBar(frame, gp.x, gp.y)) return frame.groupId
    }
    return null
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
    const view = this.getViewGraph()
    for (let i = view.nodes.length - 1; i >= 0; i--) {
      const n = view.nodes[i]
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

  /** fn 盒判定（图坐标热区共用） */
  private isFnNode(node: NodeInstance): boolean {
    return nodeShape(node.class_type, registry.get(node.class_type)) === 'fn'
  }

  /** fn 盒右上角 ▸/▾ 切换热区（图坐标） */
  private hitFnToggle(node: NodeInstance, gx: number, gy: number): boolean {
    if (!this.isFnNode(node)) return false
    const headerH = isFnCollapsed(node) ? node.height : HEADER_HEIGHT
    return gx >= node.x + node.width - 26 && gx <= node.x + node.width
      && gy >= node.y && gy <= node.y + headerH
  }

  /** fn 盒 header 区（双击切换收起/展开） */
  private hitFnHeader(node: NodeInstance, gy: number): boolean {
    if (!this.isFnNode(node)) return false
    const headerH = isFnCollapsed(node) ? node.height : HEADER_HEIGHT
    return gy >= node.y && gy <= node.y + headerH
  }

  /** 切换 fn 盒收起/展开 — 高度重算 + 连线重路由（可伸缩性） */
  toggleFnCollapsed(node: NodeInstance): void {
    node.collapsed = isFnCollapsed(node) ? false : true
    normalizeNodeDimension(node)
    this.invalidateViewGraph()
    this.recomputeRouting()
    this.onWorkflowChanged?.()
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
    for (const node of this.routingNodes()) {
      if (isGroupBoxNode(node)) {
        const outputCount = Math.max(Number(node.params.output_port_count ?? 0), 0)
        for (let i = 0; i < outputCount; i++) {
          const anchor = linkAnchor(node, i, 'out')
          if (Math.hypot(gx - anchor.x, gy - anchor.y) < SLOT_RADIUS + 8) {
            return { node, slot: i }
          }
        }
        continue
      }
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
    for (const node of this.routingNodes()) {
      if (isGroupBoxNode(node)) {
        const inputCount = Math.max(Number(node.params.input_port_count ?? 0), 0)
        for (let i = 0; i < inputCount; i++) {
          const anchor = linkAnchor(node, i, 'in')
          if (Math.hypot(gx - anchor.x, gy - anchor.y) < SLOT_RADIUS + 8) {
            return { node, slot: i }
          }
        }
        continue
      }
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
    const fromNode = this.routingNodes().find(n => n.id === link.from_node)
    const toNode = this.routingNodes().find(n => n.id === link.to_node)
    if (!fromNode || !toNode) return []
    const from = linkAnchor(fromNode, link.from_slot, 'out')
    const to = linkAnchor(toNode, link.to_slot, 'in')
    return buildFallbackPath(from, to)
  }

  private getForwardGraphPath(link: Link): Vec2[] {
    return this.getRoutedPath(link)
  }

  private getLinkAt(sx: number, sy: number): Link | null {
    const links = buildCanvasRoutingLinks(this.graph)
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
      this.selectedNodeIds = new Set()
      this.onLinkSelected?.(linkHit.id)
      this.onNodeSelected?.(null)
      this.canvas.focus()
      return
    }

    const groupTitleId = this.hitExpandedGroupTitle(gp)
    if (groupTitleId) {
      this.selectedLink = null
      this.onLinkSelected?.(null)
      this.selectedNodeIds = new Set()
      this.selectedNode = null
      this.draggingGroupId = groupTitleId
      this.groupDragStart = { ...gp }
      this.dragMoved = false
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
      if (this.hitFnToggle(hit, gp.x, gp.y)) {
        this.selectedLink = null
        this.onLinkSelected?.(null)
        this.selectedNodeIds = new Set([hit.id])
        this.selectedNode = hit.id
        this.onNodeSelected?.(hit.id)
        this.toggleFnCollapsed(hit)
        this.canvas.focus()
        return
      }
      this.selectedLink = null
      this.onLinkSelected?.(null)
      if (e.shiftKey) {
        this.toggleSelection(hit.id)
        this.onNodeSelected?.(this.selectedNode)
        this.canvas.focus()
        return
      }
      if (isGroupBoxNode(hit)) {
        this.selectedNodeIds = new Set([hit.id])
        this.selectedNode = hit.id
        this.onNodeSelected?.(hit.id)
        this.canvas.focus()
        return
      }
      this.selectedNodeIds = new Set([hit.id])
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
      this.selectedNodeIds = new Set()
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
        this.scheduleDragReroute()
      }
      this.canvas.style.cursor = 'ns-resize'
      return
    }

    if (this.draggingGroupId) {
      const grp = this.graph.groups.find(g => g.id === this.draggingGroupId)
      if (grp) {
        const dx = gp.x - this.groupDragStart.x
        const dy = gp.y - this.groupDragStart.y
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          moveGroupMembers(this.graph.nodes, grp, dx, dy)
          this.groupDragStart = { ...gp }
          this.dragMoved = true
          this.invalidateViewGraph()
          this.scheduleDragReroute()
        }
      }
      this.canvas.style.cursor = 'move'
      return
    }

    if (this.draggingNode) {
      const gpDrag = gp
      const node = this.graph.nodes.find(n => n.id === this.draggingNode)
      if (node) {
        if (Math.hypot(sx - (this.clickProbe?.sx ?? sx), sy - (this.clickProbe?.sy ?? sy)) > 4) {
          this.dragMoved = true
        }
        node.x = gpDrag.x - this.dragStart.x
        node.y = gpDrag.y - this.dragStart.y
        this.scheduleDragReroute()
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

    if (this.draggingGroupId) {
      if (this.dragMoved) {
        this.invalidateViewGraph()
        this.recomputeRouting()
        this.onWorkflowChanged?.()
      }
      this.draggingGroupId = null
    }

    if (this.draggingNode) {
      const wasDragging = this.dragMoved
      if (this.dragRouteRaf) {
        cancelAnimationFrame(this.dragRouteRaf)
        this.dragRouteRaf = 0
      }
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
      if (isGroupBoxNode(hit)) {
        const gid = String(hit.params.group_id ?? '')
        if (gid) this.expandGroupById(gid)
        return
      }
      // R11: 有内部结构可看的函数节点（实例 fn_ref / 内联 subgraph / def.fn_ref /
      // def.internal_workflow）双击任意处直接下钻内部线路图——与普通模块交互一致；
      // 收起/展开走右上角 ▸/▾ 热区（mousedown）。
      const hitDef = registry.get(hit.class_type)
      const hitIsFnTarget = Boolean(
        hit.fn_ref || hit.subgraph || hitDef?.fn_ref || hitDef?.internal_workflow,
      )
      // 无内部结构的 fn 盒（Agentic 合成范式等）：header 双击仍是收起/展开
      if (!hitIsFnTarget && this.hitFnHeader(hit, gp.y)) {
        this.toggleFnCollapsed(hit)
        return
      }
      // Generic node dblclick (e.g. SSoT project drill-down). When registered,
      // it owns the event so workflow inspect/expand stay unaffected.
      if (shouldInvokeNodeDblClick(hit) && this.onNodeDblClick) {
        this.onNodeDblClick(hit)
        return
      }
      const ns = this.nodeStates?.[hit.id]
      const r = this.executionResults?.[hit.id]
      if ((ns?.status === 'completed' || r) && this.onNodeInspect) {
        const outputs = r?.outputs ?? (typeof r === 'object' ? r : {})
        this.onNodeInspect(hit.id, outputs as Record<string, unknown>)
        return
      }
      const def = registry.get(hit.class_type)
      // R11 fn 函数节点（实例 fn_ref / 内联 subgraph / def.fn_ref）与 expandable 同走下钻
      const isFnNode = Boolean(hit.fn_ref || hit.subgraph || def?.fn_ref)
      if (isFnNode || def?.expandable === true || def?.params?.expandable?.default === true) {
        this.onExpandNode?.(hit.id, hit.class_type)
      }
    }
  }

  private render(): void {
    refreshCanvasTheme()
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
    this.drawExecutionProgress(w, h)
  }

  private drawExecutionProgress(w: number, h: number): void {
    if (!this.nodeStates) return
    const states = Object.values(this.nodeStates)
    if (states.length === 0) return
    const total = this.graph.nodes.filter(n => n.class_type !== 'NoteCard').length
    const completed = states.filter(s => s.status === 'completed').length
    const running = states.filter(s => s.status === 'running').length
    if (completed === 0 && running === 0) return

    const ctx = this.ctx
    const barH = 4
    const barY = h - barH - 8
    const barW = Math.min(200, w * 0.3)
    const barX = w - barW - 16

    ctx.save()
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(barX, barY, barW, barH)
    const progress = total > 0 ? completed / total : 0
    ctx.fillStyle = running > 0 ? COLORS.running : COLORS.valid
    ctx.fillRect(barX, barY, barW * progress, barH)

    ctx.font = '11px -apple-system, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = COLORS.textMuted
    const label = running > 0 ? `${completed}/${total} nodes` : `Done (${completed}/${total})`
    ctx.fillText(label, barX + barW, barY - 2)
    ctx.restore()
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
    const view = this.getViewGraph()
    let selectedExpandedGroupId: string | null = null
    for (const g of this.graph.groups) {
      if (!g.collapsed && g.node_ids.some(id => this.selectedNodeIds.has(id) || id === this.selectedNode)) {
        selectedExpandedGroupId = g.id
        break
      }
    }

    for (const frame of view.expandedFrames) {
      drawExpandedGroupFrame(
        this.ctx,
        frame,
        (gx, gy) => this.graphToScreen(gx, gy),
        this.scale,
        frame.groupId === selectedExpandedGroupId,
      )
    }

    for (const s of this.groupSuggestionsPreview) {
      const b = suggestionBounds(this.graph.nodes, s.node_ids)
      if (b) drawSuggestionPreview(this.ctx, b, s.title, (gx, gy) => this.graphToScreen(gx, gy), this.scale)
    }

    const openSlots = this.getOpenSlots()
    for (const node of this.graph.nodes) {
      if (view.hiddenNodeIds.has(node.id)) continue
      const multiSelected = this.selectedNodeIds.has(node.id)
      this.drawNode(node, openSlots, multiSelected || node.id === this.selectedNode)
    }
    for (const [gid, box] of view.groupBoxes) {
      const proj = view.portProjections.get(gid)
      const selected = box.id === this.selectedNode || this.selectedNodeIds.has(box.id)
      drawGroupBoxNode(this.ctx, box, (gx, gy) => this.graphToScreen(gx, gy), this.scale, selected, proj)
    }
  }

  private drawNode(node: NodeInstance, openSlots: Set<string> = new Set(), forceSelected = false): void {
    if (node.class_type === 'NoteCard') {
      this.drawNoteCard(node)
      return
    }
    const def = registry.get(node.class_type)
    if (!def) return

    const shape = nodeShape(node.class_type, def)
    if (shape === 'fn') {
      this.drawFnNode(node, def, openSlots, forceSelected)
    } else {
      this.drawSimpleNode(shape, node, def, openSlots, forceSelected)
    }
  }

  private nodeVisualState(node: NodeInstance, forceSelected: boolean) {
    const nodeState = this.nodeStates?.[node.id]
    return {
      isSelected: forceSelected || node.id === this.selectedNode || this.selectedNodeIds.has(node.id),
      isRunning: node.id === this.runningNode,
      isSkipped: nodeState?.status === 'skipped',
      isCompleted: nodeState?.status === 'completed',
      isError: nodeState?.status === 'error',
      isReplayHighlight: this.traceHighlightNodeIds.has(node.id),
    }
  }

  /** 经典流程图原子形状：轮廓 + 标题 + 至多一行关键参数。详情在右栏 inspector。 */
  private drawSimpleNode(
    shape: NodeShapeKind,
    node: NodeInstance,
    def: NodeDef,
    openSlots: Set<string>,
    forceSelected: boolean,
  ): void {
    const ctx = this.ctx
    const s = this.scale
    const sp = this.graphToScreen(node.x, node.y)
    const sw = node.width * s
    const sh = node.height * s
    const st = this.nodeVisualState(node, forceSelected)
    const archetype = nodeArchetype(node.class_type, def.category)
    const isOutputEnd = isOutputTerminalNode(node)
    const hasOutputResult = isOutputEnd && outputNodeHasResult(node.id, this.executionResults)

    ctx.save()
    if (st.isSkipped) ctx.globalAlpha = 0.4

    // Body + soft shadow
    ctx.save()
    ctx.shadowColor = COLORS.shadow
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 1.5 * s
    ctx.shadowBlur = 6 * s
    ctx.fillStyle = hasOutputResult
      ? COLORS.stateOutputDone
      : st.isError
        ? COLORS.stateError
        : st.isCompleted
          ? COLORS.stateCompleted
          : st.isSkipped
            ? COLORS.stateSkipped
            : st.isSelected
              ? COLORS.nodeSelected
              : COLORS.surface
    traceNodeShapePath(ctx, shape, sp.x, sp.y, sw, sh, s)
    ctx.fill()
    ctx.restore()

    // Selection / running ring — 同形状 path 外圈粗描边
    if (st.isSelected || st.isRunning || st.isReplayHighlight || st.isError || st.isCompleted) {
      const glowColor = st.isRunning
        ? COLORS.running
        : st.isError
          ? COLORS.error
          : st.isCompleted || st.isReplayHighlight
            ? COLORS.valid
            : COLORS.primary
      ctx.save()
      ctx.strokeStyle = glowColor
      ctx.lineWidth = 5 * s
      ctx.globalAlpha = st.isRunning ? 0.4 + 0.4 * Math.sin(Date.now() / 400) : 0.25
      traceNodeShapePath(ctx, shape, sp.x, sp.y, sw, sh, s)
      ctx.stroke()
      ctx.restore()
    }

    // Outline — 原型色描边（形状即语义，颜色即原型）
    ctx.strokeStyle = st.isRunning
      ? COLORS.running
      : st.isError
        ? COLORS.error
        : st.isReplayHighlight
          ? COLORS.valid
          : st.isSelected
            ? COLORS.primary
            : hasOutputResult
              ? COLORS.valid
              : archetype.color
    ctx.lineWidth = (st.isSelected ? 2 : 1.5) * s
    traceNodeShapePath(ctx, shape, sp.x, sp.y, sw, sh, s)
    ctx.stroke()

    // Shape detail (tool 双内竖线 / cylinder 顶弧)
    ctx.save()
    ctx.strokeStyle = archetype.color
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 1.2 * s
    if (traceShapeDetail(ctx, shape, sp.x, sp.y, sw, sh, s)) ctx.stroke()
    ctx.restore()

    // card 形状（LLM / SSoT）保留粗左色条签名
    if (shape === 'card') {
      ctx.save()
      traceNodeShapePath(ctx, shape, sp.x, sp.y, sw, sh, s)
      ctx.clip()
      ctx.fillStyle = archetype.color
      ctx.fillRect(sp.x, sp.y, 4 * s, sh)
      ctx.restore()
    }

    // Title + optional key-param line（居中，measureText 截断）
    const refFont = 16
    const innerPad = shape === 'stadium' ? 64 : shape === 'hexagon' ? 48 : 40
    const innerGraphW = node.width - innerPad
    const centerYOffset = shape === 'cylinder' ? cylinderRy(sh, s) * 0.5 : 0
    const param = keyParamLine(node, def)
    const cx = sp.x + sw / 2
    const cy = sp.y + sh / 2 + centerYOffset

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = COLORS.text
    ctx.font = `bold ${refFont * s}px ${CANVAS_FONT_UI}`
    const title = this.truncateGraphLines(this.getNodeTitle(node, def), innerGraphW, refFont, 'bold')
    if (param) {
      ctx.fillText(title, cx, cy - 10 * s)
      ctx.font = `${12 * s}px ${CANVAS_FONT_UI}`
      ctx.fillStyle = COLORS.textMuted
      const paramLine = this.truncateGraphLines(param, innerGraphW, 12)
      ctx.fillText(paramLine, cx, cy + 11 * s)
    } else {
      ctx.fillText(title, cx, cy)
    }
    ctx.textAlign = 'left'

    // SSoT_Feature 状态点（右上）
    if (node.class_type === 'SSoT_Feature') {
      const status = String(node.params?.status || 'planned')
      const testStatus = String(node.params?.test_status || 'pending')
      let dotColor = '#d97706'
      if (status === 'done' && testStatus === 'passed') dotColor = '#059669'
      else if (status === 'done' && testStatus === 'failed') dotColor = '#dc2626'
      else if (status === 'done') dotColor = '#65a30d'
      else if (status === 'in_progress') dotColor = '#2563eb'
      else if (status === 'blocked') dotColor = '#dc2626'
      ctx.fillStyle = dotColor
      ctx.beginPath()
      ctx.arc(sp.x + sw - 14 * s, sp.y + 14 * s, 4 * s, 0, Math.PI * 2)
      ctx.fill()
    }

    this.drawNodeSlots(node, def, openSlots)
    this.drawComponentRunBadge(sp, sw, 32 * s, node.id)
    ctx.restore()
  }

  /** 函数盒 — 复杂组件统一形态：方卡片 + fn 徽标，可收起（签名行）/展开（含参数预览）。 */
  private drawFnNode(
    node: NodeInstance,
    def: NodeDef,
    openSlots: Set<string>,
    forceSelected: boolean,
  ): void {
    const ctx = this.ctx
    const s = this.scale
    const sp = this.graphToScreen(node.x, node.y)
    const sw = node.width * s
    const sh = node.height * s
    const st = this.nodeVisualState(node, forceSelected)
    const archetype = nodeArchetype(node.class_type, def.category)
    const collapsed = isFnCollapsed(node)
    const radius = 12 * s
    const headerH = collapsed ? sh : HEADER_HEIGHT * s

    ctx.save()
    if (st.isSkipped) ctx.globalAlpha = 0.4

    // Body + shadow
    ctx.save()
    ctx.shadowColor = COLORS.shadow
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 2 * s
    ctx.shadowBlur = 8 * s
    ctx.fillStyle = st.isError
      ? COLORS.stateError
      : st.isCompleted
        ? COLORS.stateCompleted
        : st.isSkipped
          ? COLORS.stateSkipped
          : st.isSelected
            ? COLORS.nodeSelected
            : COLORS.surface
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.fill()
    ctx.restore()

    // Left accent bar
    ctx.save()
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.clip()
    ctx.fillStyle = archetype.color
    ctx.fillRect(sp.x, sp.y, 3 * s, sh)
    ctx.restore()

    // Ring
    if (st.isSelected || st.isRunning || st.isReplayHighlight || st.isError || st.isCompleted) {
      const glowColor = st.isRunning
        ? COLORS.running
        : st.isError
          ? COLORS.error
          : st.isCompleted || st.isReplayHighlight
            ? COLORS.valid
            : COLORS.primary
      ctx.save()
      ctx.strokeStyle = glowColor
      ctx.lineWidth = st.isRunning ? 3 * s : 2 * s
      ctx.globalAlpha = st.isRunning ? 0.4 + 0.4 * Math.sin(Date.now() / 400) : 0.25
      this.roundRect(sp.x - 2 * s, sp.y - 2 * s, sw + 4 * s, sh + 4 * s, radius + 2 * s)
      ctx.stroke()
      ctx.restore()
    }

    // Border
    ctx.strokeStyle = st.isRunning
      ? COLORS.running
      : st.isReplayHighlight
        ? COLORS.valid
        : st.isSelected
          ? COLORS.primary
          : COLORS.border
    ctx.lineWidth = (st.isSelected ? 2 : 1) * s
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.stroke()

    // Header separator（展开态）
    if (!collapsed) {
      ctx.strokeStyle = COLORS.border
      ctx.lineWidth = 1 * s
      ctx.beginPath()
      ctx.moveTo(sp.x, sp.y + headerH)
      ctx.lineTo(sp.x + sw, sp.y + headerH)
      ctx.stroke()
    }

    // fn 徽标（等宽字体，原型浅底深字）
    const fnW = 22 * s
    const fnH = 15 * s
    const fnX = sp.x + 8 * s
    const fnY = sp.y + headerH / 2 - fnH / 2
    ctx.fillStyle = archetype.pillBg
    this.roundRect(fnX, fnY, fnW, fnH, 4 * s)
    ctx.fill()
    ctx.fillStyle = archetype.pillText
    ctx.font = `bold ${10 * s}px ${CANVAS_FONT_MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('fn', fnX + fnW / 2, fnY + fnH / 2)
    ctx.textAlign = 'left'

    // Title
    const refFont = 16
    const titleGraphW = node.width - 36 - 110
    ctx.fillStyle = COLORS.text
    ctx.font = `bold ${refFont * s}px ${CANVAS_FONT_UI}`
    ctx.textBaseline = 'middle'
    const title = this.truncateGraphLines(this.getNodeTitle(node, def), titleGraphW, refFont, 'bold')
    ctx.fillText(title, fnX + fnW + 6 * s, sp.y + headerH / 2)

    // 收起/展开指示（右上角热区）
    ctx.fillStyle = COLORS.textMuted
    ctx.font = `${11 * s}px ${CANVAS_FONT_UI}`
    ctx.textAlign = 'center'
    ctx.fillText(collapsed ? '▸' : '▾', sp.x + sw - 13 * s, sp.y + headerH / 2)
    ctx.textAlign = 'left'

    // Archetype pill 或运行徽标（右端、指示符左侧）
    const badgeRight = sw - 24 * s
    if (this.runningNode === node.id || this.executionResults?.[node.id] || this.nodeStates?.[node.id]) {
      this.drawComponentRunBadge(sp, badgeRight, headerH, node.id)
    } else {
      this.drawCategoryPill(
        sp.x + badgeRight,
        sp.y + headerH / 2,
        archetype.label,
        archetype.pillBg,
        archetype.pillText,
        10 * s,
      )
    }

    // 展开态：参数预览
    if (!collapsed) {
      const innerGraphW = node.width - 20
      const contentLines = buildNodeContentPreviewLines(
        node,
        def,
        (text) => this.wrapGraphLines(text, innerGraphW, refFont),
        this.executionResults?.[node.id],
      )
      if (contentLines.length > 0) {
        ctx.fillStyle = COLORS.text
        ctx.font = `bold ${refFont * s}px ${CANVAS_FONT_UI}`
        ctx.textBaseline = 'top'
        const contentY = sp.y + headerH + 6 * s
        const maxLines = Math.min(contentLines.length, maxContentPreviewLines())
        for (let i = 0; i < maxLines; i++) {
          ctx.fillText(contentLines[i], sp.x + 10 * s, contentY + i * refFont * s)
        }
      }
    }

    this.drawNodeSlots(node, def, openSlots)
    ctx.restore()
  }

  /** 输入/输出 slot 圆点（锚点 y 来自 slotGraphY SSOT，side-aware） */
  private drawNodeSlots(node: NodeInstance, def: NodeDef, openSlots: Set<string>): void {
    const ctx = this.ctx
    const sp = this.graphToScreen(node.x, node.y)
    const sw = node.width * this.scale

    for (let i = 0; i < def.inputs.length; i++) {
      const sy = this.graphToScreen(0, slotGraphY(node, i, 'in')).y
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

    for (let i = 0; i < def.outputs.length; i++) {
      const sy = this.graphToScreen(0, slotGraphY(node, i, 'out')).y
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
  }

  private drawComponentRunBadge(sp: Vec2, sw: number, headerH: number, componentId: string): void {
    const ns = this.nodeStates?.[componentId]
    const r = this.executionResults?.[componentId]
    if (!ns && !r && this.runningNode !== componentId) return
    const ctx = this.ctx
    const x = sp.x + sw - 10 * this.scale
    const y = sp.y + headerH / 2
    ctx.font = `bold ${14 * this.scale}px ${CANVAS_FONT_UI}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    if (ns?.status === 'running' || this.runningNode === componentId) {
      ctx.fillStyle = COLORS.running
      ctx.fillText('…', x, y)
    } else if (ns?.status === 'error' || r?.error) {
      ctx.fillStyle = COLORS.error
      ctx.fillText('✕', x, y)
    } else if (ns?.status === 'skipped') {
      ctx.fillStyle = '#94a3b8'
      ctx.fillText('⊘', x, y)
    } else if (ns?.status === 'completed' || r) {
      ctx.fillStyle = COLORS.valid
      const dur = ns?.duration_ms ?? r?.duration_ms
      const badge = dur && dur > 100 ? `✓ ${(dur / 1000).toFixed(1)}s` : '✓'
      ctx.fillText(badge, x, y)
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

    ctx.strokeStyle = isSelected ? COLORS.primary : '#4a5568'
    ctx.lineWidth = isSelected ? 2 : 1
    ctx.setLineDash([4 * this.scale, 3 * this.scale])
    this.roundRect(sp.x, sp.y, sw, sh, radius)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = '#e2e8f0'
    ctx.font = `bold ${11 * this.scale}px ${CANVAS_FONT_UI}`
    ctx.textBaseline = 'top'
    ctx.fillText('📝 注释', sp.x + 8 * this.scale, sp.y + 6 * this.scale)

    const content = String(node.params.content ?? '').trim()
    const bodySize = getNoteCardBodyFontSize(node.params)
    const preview = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, '') || '（双击展开编辑内容）'
    ctx.fillStyle = '#cbd5e0'
    if (node.collapsed) {
      ctx.font = `${bodySize * this.scale}px ${CANVAS_FONT_UI}`
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
        ctx.font = `${weight} ${metrics.fontSize * this.scale}px ${line.code ? CANVAS_FONT_MONO : CANVAS_FONT_UI}`
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
    const links = buildCanvasRoutingLinks(this.graph)
    for (const link of links) {
      this.drawLink(link, backLinks)
    }
  }


  private drawLink(
    link: Link,
    backLinks: Set<string> | undefined,
  ): void {
    const ctx = this.ctx
    const viewNodes = this.routingNodes()
    const fromNode = viewNodes.find(n => n.id === link.from_node)
    const toNode = viewNodes.find(n => n.id === link.to_node)
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
    const isBackward = isBackwardLink(link, viewNodes, backLinks)

    const graphPts = this.getRoutedPath(link)
    const screenPts = graphPts.map(wp => this.graphToScreen(wp.x, wp.y))

    const dashed = isBackward
    const strokeColor = isActive
      ? COLORS.linkActive
      : isBackward
            ? linkBackwardColor(link.id, this.linkColorMaps)
            : linkForwardColor(link.id, this.linkColorMaps)
    const hovered = this.hoverNodeId != null
      && (link.from_node === this.hoverNodeId || link.to_node === this.hoverNodeId)
    const lineWidth = (isLinkSelected ? 3.5 : hovered ? 3 : DEFAULT_LINK_LINE_WIDTH) * this.scale

    if (isLinkSelected && screenPts.length >= 2) this.drawLinkHighlight(screenPts, lineWidth + 4)
    const baseAlpha = isActive ? 1 : 0.95
    ctx.strokeStyle = hovered && !isActive ? COLORS.linkActive : strokeColor
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    ctx.globalAlpha = linkFocusAlpha(link, {
      hoverNodeId: this.hoverNodeId,
      selectedNodeIds: this.selectedNodeIds,
      selectedLinkId: this.selectedLink,
      baseAlpha,
    })
    if (dashed) ctx.setLineDash([8 * this.scale, 4 * this.scale])

    this.drawOrthogonalPath(screenPts)
    ctx.setLineDash([])
    ctx.globalAlpha = 1

  }

  /** 连线变量名 — 与组件相同：Canvas + graphToScreen + fontPx∝scale */
  private drawWireSlotLabels(): void {
    const links = buildCanvasRoutingLinks(this.graph)
    const showMidpointChips = this.scale >= WIRE_CHIP_ZOOM_THRESHOLD
    if (!showMidpointChips && !this.hoverNodeId && !this.selectedLink) return

    if (this.hoverNodeId || this.selectedLink) {
      this.drawEmphasizedWireSlotLabels(links)
    }
    if (showMidpointChips) {
      this.drawWireMidpointChips(links)
    }
  }

  private linkStrokeColor(link: Link, backLinks: Set<string> | undefined): string {
    const viewNodes = this.routingNodes()
    const isActive = this.runningNode === link.from_node || this.runningNode === link.to_node
    if (isActive) return COLORS.linkActive
    const isBackward = isBackwardLink(link, viewNodes, backLinks)
    return isBackward
      ? linkBackwardColor(link.id, this.linkColorMaps)
      : linkForwardColor(link.id, this.linkColorMaps)
  }

  private linkDimAlpha(link: Link, baseAlpha = 0.95): number {
    return linkFocusAlpha(link, {
      hoverNodeId: this.hoverNodeId,
      selectedNodeIds: this.selectedNodeIds,
      selectedLinkId: this.selectedLink,
      baseAlpha,
    })
  }

  /** Hover/selection: larger labels anchored near the focused component. */
  private drawEmphasizedWireSlotLabels(links: Link[]): void {
    const ctx = this.ctx
    const fontPx = 12 * this.scale
    const pad = 4 * this.scale
    const edgeGap = 6
    const alongPx = 14 * this.scale
    const normalPx = 8 * this.scale
    const font = `bold ${fontPx}px ${CANVAS_FONT_MONO}`

    const placements: Array<{
      linkId: string
      text: string
      place: ReturnType<typeof linkLabelAnchor>
      emphasized: boolean
      alpha: number
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
        alpha: this.linkDimAlpha(link),
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
    for (const { text, place, emphasized, alpha } of rows.map(r => r.p)) {
      const tw = ctx.measureText(text).width
      const th = fontPx * 1.25
      const w = tw + pad * 2
      const h = th + pad * 2
      const bx = place.align === 'left' ? place.x - w : place.x
      const by = place.y - h / 2
      ctx.globalAlpha = alpha
      ctx.fillStyle = emphasized ? COLORS.wireLabelBgEmphasis : COLORS.wireLabelBg
      this.roundRect(bx, by, w, h, 3 * this.scale)
      ctx.fill()
      ctx.strokeStyle = emphasized ? COLORS.surface : COLORS.wireLabelBorder
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = emphasized ? COLORS.bg : COLORS.wireLabelText
      ctx.textBaseline = 'middle'
      ctx.textAlign = place.align === 'left' ? 'right' : 'left'
      const tx = place.align === 'left' ? place.x - pad : place.x + pad
      ctx.fillText(text, tx, place.y)
    }
    ctx.restore()
  }

  /** Zoom ≥ threshold: compact slot chips at each wire midpoint. */
  private drawWireMidpointChips(links: Link[]): void {
    const ctx = this.ctx
    const backLinks = this.getBackLinks()
    const fontPx = 10 * this.scale
    const padX = 6 * this.scale
    const padY = 3 * this.scale
    const radius = 4 * this.scale
    const font = `600 ${fontPx}px ${CANVAS_FONT_MONO}`

    const chips: Array<{
      linkId: string
      text: string
      rect: WireChipRect
      normal: Vec2
      fill: string
      alpha: number
    }> = []

    ctx.save()
    ctx.font = font
    for (const link of links) {
      const fromNode = this.graph.nodes.find(n => n.id === link.from_node)
      const toNode = this.graph.nodes.find(n => n.id === link.to_node)
      if (!fromNode || !toNode) continue
      if (isNoteCardNode(fromNode) || isNoteCardNode(toNode)) continue

      const graphPts = this.getRoutedPath(link)
      const screenPts = graphPts.map(wp => this.graphToScreen(wp.x, wp.y))
      if (screenPts.length < 2) continue

      const text = formatWireChipLabel(link, this.graph.nodes)
      const tw = ctx.measureText(text).width
      const th = fontPx * 1.2
      const w = tw + padX * 2
      const h = th + padY * 2
      const mid = polylineMidpoint(screenPts)
      const segIndex = polylineMidpointSegmentIndex(screenPts)
      const normal = pathNormalAtSegment(screenPts, segIndex)
      const rect: WireChipRect = {
        x: mid.x - w / 2,
        y: mid.y - h / 2,
        w,
        h,
      }
      chips.push({
        linkId: link.id,
        text,
        rect,
        normal,
        fill: this.linkStrokeColor(link, backLinks),
        alpha: this.linkDimAlpha(link),
      })
    }

    chips.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.linkId.localeCompare(b.linkId))
    nudgeOverlappingWireChips(chips)

    for (const chip of chips) {
      const { rect, text, fill, alpha } = chip
      ctx.globalAlpha = alpha
      ctx.fillStyle = fill
      this.roundRect(rect.x, rect.y, rect.w, rect.h, radius)
      ctx.fill()
      ctx.strokeStyle = COLORS.surface
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = COLORS.bg
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2)
    }
    ctx.restore()
  }

  /** 选中连线白色外描边 */
  private drawLinkHighlight(screenPts: Vec2[], width: number): void {
    if (screenPts.length < 2) return
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = COLORS.surface
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
    ctx.font = `${weight} ${refFontSize}px ${CANVAS_FONT_UI}`
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
    ctx.font = `${weight} ${refFontSize}px ${CANVAS_FONT_UI}`
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
    ctx.font = `${weight} ${fontSizePx}px ${CANVAS_FONT_UI}`
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

  /** 原型分类 pill — 浅底深字；超宽（极端 label）按 measureText 截断加省略号 */
  private drawCategoryPill(
    rightX: number,
    centerY: number,
    text: string,
    bg: string,
    fg: string,
    fontSize: number,
    maxTextW = 96 * this.scale,
  ): void {
    const ctx = this.ctx
    const padX = 8 * this.scale
    const padY = 2 * this.scale
    ctx.font = `bold ${fontSize}px ${CANVAS_FONT_UI}`
    let label = text
    if (ctx.measureText(label).width > maxTextW) {
      while (label.length > 1 && ctx.measureText(`${label}…`).width > maxTextW) {
        label = label.slice(0, -1)
      }
      label = `${label}…`
    }
    const tw = ctx.measureText(label).width
    const pw = tw + padX * 2
    const ph = fontSize + padY * 2
    const bx = rightX - pw
    const by = centerY - ph / 2
    const pillRadius = ph / 2

    ctx.fillStyle = bg
    this.roundRect(bx, by, pw, ph, pillRadius)
    ctx.fill()

    ctx.fillStyle = fg
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, rightX - padX, centerY)
    ctx.textAlign = 'left'
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
