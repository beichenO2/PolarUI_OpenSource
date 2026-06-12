/**
 * 画布节点布局记忆 — 用户手动调整后的位置写入 localStorage，再次打开同一工作流时恢复。
 */
import type { NodeInstance } from './types'
import type { Graph } from './graph'
import { normalizeGraphNodeDimensions, countNodeOverlaps } from './node-geometry'

const LAYOUT_STORAGE_KEY = 'polarui_layout_memory_v1'
const SESSION_STORAGE_KEY = 'polarui_last_session_v1'

export type LayoutScope =
  | { kind: 'registry'; id: string }
  | { kind: 'ssot'; project: string }
  | { kind: 'workflow-ref'; ref: string }
  | { kind: 'custom'; id: string }
  | { kind: 'builtin-subgraph'; classType: string }
  | { kind: 'graph'; graphId: string; name: string }

export interface NodeLayout {
  x: number
  y: number
  width?: number
  height?: number
  collapsed?: boolean
}

interface StoredLayout {
  nodes: Record<string, NodeLayout>
  updated_at: number
}

export interface LastSession {
  viewMode: 'workflow' | 'ssot' | 'health'
  registryId?: string
  ssotProject?: string
  libraryMode?: 'WF'
}

export function layoutScopeKey(scope: LayoutScope): string {
  switch (scope.kind) {
    case 'registry':
      return `registry:${scope.id}`
    case 'ssot':
      return `ssot:${scope.project}`
    case 'workflow-ref':
      return `wfref:${scope.ref}`
    case 'custom':
      return `custom:${scope.id}`
    case 'builtin-subgraph':
      return `subgraph:${scope.classType}`
    case 'graph':
      return `graph:${scope.graphId}:${scope.name}`
  }
}

function readAllLayouts(): Record<string, StoredLayout> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, StoredLayout>
  } catch {
    return {}
  }
}

function writeAllLayouts(map: Record<string, StoredLayout>): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(map))
}

function getLayoutKeyMap(graph: Graph): Map<string, string> | undefined {
  return (graph as Graph & { _layoutKeys?: Map<string, string> })._layoutKeys
}

/** 为图内节点注册稳定 layout key（API 节点 id、SSoT 语义 id、class_type 等） */
export function registerLayoutKey(graph: Graph, nodeId: string, stableKey: string): void {
  const g = graph as Graph & { _layoutKeys?: Map<string, string> }
  if (!g._layoutKeys) g._layoutKeys = new Map()
  g._layoutKeys.set(nodeId, stableKey)
}

export function getNodeLayoutKey(node: NodeInstance, graph?: Graph): string {
  const mapped = graph ? getLayoutKeyMap(graph)?.get(node.id) : undefined
  if (mapped) return mapped

  switch (node.class_type) {
    case 'SSoT_Project':
      return 'SSoT_Project:root'
    case 'SSoT_Requirement':
      return `SSoT_Requirement:${String(node.params.id ?? node.id)}`
    case 'SSoT_Feature': {
      const reqId = node.params._layout_req_id ?? '?'
      return `SSoT_Feature:${reqId}/${String(node.params.name ?? node.id)}`
    }
    default:
      return `${node.class_type}:${node.id}`
  }
}

export function loadStoredLayout(scope: LayoutScope): StoredLayout | null {
  const key = layoutScopeKey(scope)
  return readAllLayouts()[key] ?? null
}

export function applyStoredLayout(graph: Graph, scope: LayoutScope): boolean {
  const stored = loadStoredLayout(scope)
  if (!stored) return false

  let applied = 0
  for (const node of graph.nodes) {
    const stableKey = getNodeLayoutKey(node, graph)
    const pos = stored.nodes[stableKey]
    if (!pos) continue
    node.x = pos.x
    node.y = pos.y
    // 仅恢复 NoteCard 尺寸；普通组件宽高由 node-def 决定，避免旧缓存压成「小条+悬空端口」
    if (node.class_type === 'NoteCard') {
      if (pos.width != null) node.width = pos.width
      if (pos.height != null) node.height = pos.height
      if (pos.collapsed !== undefined) node.collapsed = pos.collapsed
    }
    applied++
  }
  normalizeGraphNodeDimensions(graph.nodes)
  if (countNodeOverlaps(graph.nodes) > 0) {
    console.warn('[PolarUI Layout] Stored layout has overlapping nodes — falling back to auto layout')
    return false
  }
  return applied > 0
}

export function clearStoredLayout(scope: LayoutScope): boolean {
  const scopeKey = layoutScopeKey(scope)
  const map = readAllLayouts()
  if (!map[scopeKey]) return false
  delete map[scopeKey]
  writeAllLayouts(map)
  return true
}

export function hasStoredLayout(scope: LayoutScope): boolean {
  return loadStoredLayout(scope) != null
}

export function saveStoredLayout(graph: Graph, scope: LayoutScope): void {
  const scopeKey = layoutScopeKey(scope)
  const nodes: Record<string, NodeLayout> = {}

  for (const node of graph.nodes) {
    const stableKey = getNodeLayoutKey(node, graph)
    nodes[stableKey] = {
      x: node.x,
      y: node.y,
      ...(node.class_type === 'NoteCard'
        ? { width: node.width, height: node.height, collapsed: node.collapsed }
        : {}),
    }
  }

  const map = readAllLayouts()
  map[scopeKey] = { nodes, updated_at: Date.now() }
  writeAllLayouts(map)
}

export function readLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as LastSession
  } catch {
    return null
  }
}

export function writeLastSession(session: LastSession): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

/** 注册 SSoT 编译图内各节点的稳定 key */
export function registerSsotLayoutKeys(graph: Graph): void {
  const project = graph.nodes.find((n: NodeInstance) => n.class_type === 'SSoT_Project')
  if (project) registerLayoutKey(graph, project.id, 'SSoT_Project:root')

  for (const reqNode of graph.nodes.filter((n: NodeInstance) => n.class_type === 'SSoT_Requirement')) {
    registerLayoutKey(graph, reqNode.id, `SSoT_Requirement:${String(reqNode.params.id ?? reqNode.id)}`)
    const reqId = String(reqNode.params.id ?? reqNode.id)
    for (const link of graph.links.filter(l => l.from_node === reqNode.id)) {
      const feat = graph.nodes.find(
        (n: NodeInstance) => n.id === link.to_node && n.class_type === 'SSoT_Feature',
      )
      if (feat) {
        registerLayoutKey(
          graph,
          feat.id,
          `SSoT_Feature:${reqId}/${String(feat.params.name ?? feat.id)}`,
        )
      }
    }
  }
}

/** 内置 Agentic 模板子图：每种 class_type 在模板内唯一 */
export function registerBuiltinSubgraphLayoutKeys(graph: Graph): void {
  for (const node of graph.nodes) {
    registerLayoutKey(graph, node.id, node.class_type)
  }
}

/** 恢复内置 Agentic 模板子图的默认坐标 */
export function applyBuiltinSubgraphDefaultLayout(graph: Graph, classType: string): void {
  const sx = 60
  const sy = 60
  const sp = 260
  const pos = (type: string, x: number, y: number) => {
    const node = graph.nodes.find(n => n.class_type === type)
    if (node) {
      node.x = x
      node.y = y
    }
  }

  if (classType === 'AgenticUnit') {
    pos('PromptInput', sx, sy)
    pos('PromptInject', sx, sy + 180)
    pos('LLM', sx + sp, sy)
    pos('Validator', sx + sp * 2, sy)
    pos('RetryLoop', sx + sp * 2, sy + 180)
    pos('Output', sx + sp * 3, sy)
  } else if (classType === 'AgenticChain') {
    pos('PromptInput', sx, sy)
    pos('LLM', sx + sp, sy)
    pos('Validator', sx + sp * 2, sy)
    pos('RetryLoop', sx + sp * 2, sy + 180)
    const llmNodes = graph.nodes.filter(n => n.class_type === 'LLM')
    const valNodes = graph.nodes.filter(n => n.class_type === 'Validator')
    if (llmNodes[1]) { llmNodes[1].x = sx + sp * 3; llmNodes[1].y = sy }
    if (valNodes[1]) { valNodes[1].x = sx + sp * 4; valNodes[1].y = sy }
    pos('Output', sx + sp * 5, sy)
  } else {
    pos('PromptInput', sx, sy)
    pos('LLM', sx + sp, sy)
    pos('Output', sx + sp * 2, sy)
  }
}

/** 恢复 SSoT 图的默认列式排布 */
export function applySsotDefaultLayout(graph: Graph): void {
  const startX = 100
  const startY = 100
  const colSpacing = 380
  const rowSpacing = 220

  const project = graph.nodes.find(n => n.class_type === 'SSoT_Project')
  if (project) {
    project.x = startX
    project.y = startY
  }

  const reqNodes = graph.nodes.filter(n => n.class_type === 'SSoT_Requirement')
  reqNodes.forEach((reqNode, reqIdx) => {
    reqNode.x = startX + colSpacing
    reqNode.y = startY + reqIdx * rowSpacing * 2.5

    const featIds = graph.links
      .filter(l => l.from_node === reqNode.id)
      .map(l => l.to_node)
    featIds.forEach((featId, featIdx) => {
      const feat = graph.nodes.find(n => n.id === featId && n.class_type === 'SSoT_Feature')
      if (feat) {
        feat.x = reqNode.x + colSpacing
        feat.y = reqNode.y + featIdx * rowSpacing
      }
    })
  })
}
