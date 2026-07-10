import type { NodeInstance, Link, Workflow, StateMachineConfig, LgEdge, WorkflowGroupMeta } from './types'
import { registry } from './registry'
import { calcNodeHeight, NODE_DEFAULT_WIDTH, normalizeOutputTerminalSize, normalizeAllOutputTerminals } from './node-geometry'
import { applyNoteCardLayout } from './note-card-layout'
import { defaultRoleDeclaration } from './role-prompt'

let nextId = 1
function genId(): string {
  return String(nextId++)
}

export class Graph {
  id: string
  name: string
  nodes: NodeInstance[] = []
  links: Link[] = []
  createdAt: number
  updatedAt: number
  /** View-layer groups (not seen by execution engine) */
  groups: WorkflowGroupMeta[] = []
  /** Stepwise entry node id (_entry schema field) */
  lgEntry?: string
  /** Stepwise routing edges (_lg_edges schema field) */
  lgEdges?: LgEdge[]
  /** State machine execution config (present when _execution === 'state_machine') */
  stateMachine?: StateMachineConfig

  constructor(name = 'Untitled Workflow') {
    this.id = genId()
    this.name = name
    this.createdAt = Date.now()
    this.updatedAt = Date.now()
  }

  addNode(classType: string, x: number, y: number, fixedId?: string): NodeInstance | null {
    const def = registry.get(classType)
    if (!def) return null

    const defaults: Record<string, unknown> = {}
    if (def.params) {
      for (const [key, param] of Object.entries(def.params)) {
        if (key === 'role_declaration' && (param as { type?: string }).type === 'object') {
          defaults[key] = defaultRoleDeclaration()
        } else {
          defaults[key] = (param as { default?: unknown }).default ?? null
        }
      }
    }

    const node: NodeInstance = {
      id: fixedId ?? genId(),
      class_type: classType,
      x,
      y,
      width: NODE_DEFAULT_WIDTH,
      height: calcNodeHeight(def.inputs.length, def.outputs.length),
      params: defaults,
    }
    if (classType === 'NoteCard') {
      node.collapsed = true
      applyNoteCardLayout(node)
    }
    if (classType === 'Output') {
      normalizeOutputTerminalSize(node)
    }
    this.nodes.push(node)
    this.updatedAt = Date.now()
    return node
  }

  removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter(n => n.id !== nodeId)
    this.links = this.links.filter(
      l => l.from_node !== nodeId && l.to_node !== nodeId
    )
    this.updatedAt = Date.now()
  }

  addLink(fromNode: string, fromSlot: number, toNode: string, toSlot: number): Link | null {
    const existing = this.links.find(
      l => l.to_node === toNode && l.to_slot === toSlot
    )
    if (existing) {
      this.links = this.links.filter(l => l.id !== existing.id)
    }

    const link: Link = {
      id: genId(),
      from_node: fromNode,
      from_slot: fromSlot,
      to_node: toNode,
      to_slot: toSlot,
    }
    this.links.push(link)
    this.updatedAt = Date.now()
    return link
  }

  removeLink(linkId: string): void {
    this.links = this.links.filter(l => l.id !== linkId)
    this.updatedAt = Date.now()
  }

  getNodeInputLinks(nodeId: string): Link[] {
    return this.links.filter(l => l.to_node === nodeId)
  }

  getNodeOutputLinks(nodeId: string): Link[] {
    return this.links.filter(l => l.from_node === nodeId)
  }

  toWorkflow(): Workflow {
    const wf: Workflow = {
      id: this.id,
      name: this.name,
      nodes: [...this.nodes],
      links: [...this.links],
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    }
    if (this.groups.length > 0) wf._groups = [...this.groups]
    return wf
  }

  toApiFormat(): Record<string, unknown> {
    const result: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}

    for (const node of this.nodes) {
      const { _inputBindings, ...cleanParams } = (node.params ?? {}) as Record<string, unknown> & { _inputBindings?: Record<string, unknown> }
      const inputs: Record<string, unknown> = { ...cleanParams }
      const def = registry.get(node.class_type)
      if (!def) continue

      const bindings = (_inputBindings ?? {}) as Record<string, unknown>
      const inLinks = this.getNodeInputLinks(node.id)
      for (const link of inLinks) {
        const slotDef = def.inputs[link.to_slot]
        if (slotDef) {
          if (bindings[slotDef.name]) {
            inputs[slotDef.name] = bindings[slotDef.name]
          } else {
            inputs[slotDef.name] = [link.from_node, link.from_slot]
          }
        }
      }

      result[node.id] = { class_type: node.class_type, inputs }
    }

    const out: Record<string, unknown> = { _name: this.name, ...result }
    if (this.lgEntry || (this.lgEdges && this.lgEdges.length > 0)) {
      out._entry = this.lgEntry ?? '1'
      out._lg_edges = this.lgEdges ?? []
    }
    if (this.groups.length > 0) out._groups = [...this.groups]
    return out
  }

  static fromWorkflow(wf: Workflow): Graph {
    const g = new Graph(wf.name)
    g.id = wf.id
    g.nodes = [...wf.nodes]
    g.links = [...wf.links]
    g.groups = Array.isArray(wf._groups) ? wf._groups.map(gr => ({ ...gr, node_ids: [...gr.node_ids] })) : []
    for (const node of g.nodes) {
      if (node.class_type === 'OutputDisplay') {
        node.class_type = 'Output'
      }
    }
    normalizeAllOutputTerminals(g.nodes)
    g.createdAt = wf.created_at
    g.updatedAt = wf.updated_at
    const layoutKeys = new Map<string, string>()
    for (const node of g.nodes) {
      layoutKeys.set(node.id, node.id)
    }
    ;(g as Graph & { _layoutKeys?: Map<string, string> })._layoutKeys = layoutKeys
    return g
  }
}
