/**
 * Workflow group (in-place collapse) — pure view-layer abstraction.
 * Execution engine ignores _groups; members + links stay in the graph JSON.
 */
import type { NodeInstance, Link } from './types'
import {
  HEADER_HEIGHT,
  CONTENT_AREA_HEIGHT,
  SLOT_HEIGHT,
  SLOT_PADDING,
  NODE_BOTTOM_PAD,
  NODE_DEFAULT_WIDTH,
  type AABB,
} from './node-geometry'

export const GROUP_BOX_CLASS = '__GroupBox'

export interface WorkflowGroup {
  id: string
  title: string
  node_ids: string[]
  collapsed: boolean
  color?: string
}

export interface GroupPortInput {
  key: string
  from_node: string
  from_slot: number
  view_slot: number
}

export interface GroupPortOutput {
  key: string
  to_node: string
  to_slot: number
  view_slot: number
}

export interface GroupPortProjection {
  groupId: string
  inputs: GroupPortInput[]
  outputs: GroupPortOutput[]
}

export interface ExpandedGroupFrame {
  groupId: string
  title: string
  bounds: AABB
  color?: string
}

export interface ViewGraphResult {
  nodes: NodeInstance[]
  links: Link[]
  hiddenNodeIds: Set<string>
  groupBoxes: Map<string, NodeInstance>
  portProjections: Map<string, GroupPortProjection>
  expandedFrames: ExpandedGroupFrame[]
}

const GROUP_FRAME_PAD = 24
const GROUP_TITLE_BAR = 28

export function groupBoxNodeId(groupId: string): string {
  return `__group__${groupId}`
}

export function nextGroupTitle(existing: WorkflowGroup[]): string {
  let max = 0
  for (const g of existing) {
    const m = /^Group\s+(\d+)$/i.exec(g.title.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Group ${max + 1}`
}

export function validateGroups(groups: WorkflowGroup[], nodes: NodeInstance[]): string[] {
  const errors: string[] = []
  const nodeIds = new Set(nodes.map(n => n.id))
  const seen = new Map<string, string>()

  for (const g of groups) {
    if (!g.id) errors.push('group missing id')
    for (const nid of g.node_ids) {
      if (!nodeIds.has(nid)) errors.push(`group ${g.id}: unknown node ${nid}`)
      if (seen.has(nid)) {
        errors.push(`node ${nid} overlap between groups ${seen.get(nid)} and ${g.id}`)
      } else {
        seen.set(nid, g.id)
      }
    }
  }
  return errors
}

export function createGroup(opts: {
  nodeIds: string[]
  title: string
  existingGroups: WorkflowGroup[]
  collapsed?: boolean
  color?: string
}): WorkflowGroup {
  const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    title: opts.title,
    node_ids: [...new Set(opts.nodeIds)],
    collapsed: opts.collapsed ?? true,
    color: opts.color,
  }
}

export function ungroupGroup(groups: WorkflowGroup[], groupId: string): WorkflowGroup[] {
  return groups.filter(g => g.id !== groupId)
}

export function moveGroupMembers(
  nodes: NodeInstance[],
  group: WorkflowGroup,
  dx: number,
  dy: number,
): void {
  const memberSet = new Set(group.node_ids)
  for (const node of nodes) {
    if (memberSet.has(node.id)) {
      node.x += dx
      node.y += dy
    }
  }
}

export function computeMemberBounds(nodes: NodeInstance[], memberIds: string[]): AABB | null {
  const set = new Set(memberIds)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let count = 0
  for (const n of nodes) {
    if (!set.has(n.id)) continue
    count++
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  if (count === 0) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function partitionLinksByGroup(
  links: Link[],
  members: Set<string>,
): { internal: Link[]; inbound: Link[]; outbound: Link[] } {
  const internal: Link[] = []
  const inbound: Link[] = []
  const outbound: Link[] = []
  for (const link of links) {
    const fromIn = members.has(link.from_node)
    const toIn = members.has(link.to_node)
    if (fromIn && toIn) internal.push(link)
    else if (!fromIn && toIn) inbound.push(link)
    else if (fromIn && !toIn) outbound.push(link)
  }
  return { internal, inbound, outbound }
}

export function buildPortProjection(
  group: WorkflowGroup,
  links: Link[],
  nodes: NodeInstance[],
): GroupPortProjection {
  const members = new Set(group.node_ids)
  const { inbound, outbound } = partitionLinksByGroup(links, members)

  const inputMap = new Map<string, GroupPortInput>()
  for (const link of inbound) {
    const key = `${link.from_node}:${link.from_slot}`
    if (!inputMap.has(key)) {
      inputMap.set(key, {
        key,
        from_node: link.from_node,
        from_slot: link.from_slot,
        view_slot: inputMap.size,
      })
    }
  }

  const outputMap = new Map<string, GroupPortOutput>()
  for (const link of outbound) {
    const key = `${link.to_node}:${link.to_slot}`
    if (!outputMap.has(key)) {
      outputMap.set(key, {
        key,
        to_node: link.to_node,
        to_slot: link.to_slot,
        view_slot: outputMap.size,
      })
    }
  }

  return {
    groupId: group.id,
    inputs: [...inputMap.values()],
    outputs: [...outputMap.values()],
  }
}

export function buildGroupBoxNode(
  group: WorkflowGroup,
  nodes: NodeInstance[],
  projection: GroupPortProjection,
): NodeInstance {
  const bounds = computeMemberBounds(nodes, group.node_ids)
  const pad = GROUP_FRAME_PAD
  const slotCount = Math.max(projection.inputs.length, projection.outputs.length, 1)
  const height =
    HEADER_HEIGHT + CONTENT_AREA_HEIGHT + SLOT_PADDING + slotCount * SLOT_HEIGHT + NODE_BOTTOM_PAD

  const x = bounds ? bounds.x - pad : 0
  const y = bounds ? bounds.y - pad : 0
  const width = Math.max(NODE_DEFAULT_WIDTH, (bounds?.w ?? NODE_DEFAULT_WIDTH) + pad * 2)

  return {
    id: groupBoxNodeId(group.id),
    class_type: GROUP_BOX_CLASS,
    x,
    y,
    width,
    height,
    params: {
      group_id: group.id,
      title: group.title,
      member_count: group.node_ids.length,
      collapsed: true,
      color: group.color,
      input_port_count: projection.inputs.length,
      output_port_count: projection.outputs.length,
    },
  }
}

function collapsedGroupMap(groups: WorkflowGroup[]): Map<string, WorkflowGroup> {
  const map = new Map<string, WorkflowGroup>()
  for (const g of groups) {
    if (g.collapsed) map.set(g.id, g)
  }
  return map
}

function nodeCollapsedGroup(
  nodeId: string,
  collapsed: Map<string, WorkflowGroup>,
): WorkflowGroup | undefined {
  for (const g of collapsed.values()) {
    if (g.node_ids.includes(nodeId)) return g
  }
  return undefined
}

export function deriveViewGraph(
  nodes: NodeInstance[],
  links: Link[],
  groups: WorkflowGroup[],
): ViewGraphResult {
  const collapsed = collapsedGroupMap(groups)
  const hiddenNodeIds = new Set<string>()
  const groupBoxes = new Map<string, NodeInstance>()
  const portProjections = new Map<string, GroupPortProjection>()
  const expandedFrames: ExpandedGroupFrame[] = []

  for (const g of groups) {
    if (g.collapsed) {
      for (const nid of g.node_ids) hiddenNodeIds.add(nid)
      const proj = buildPortProjection(g, links, nodes)
      portProjections.set(g.id, proj)
      groupBoxes.set(g.id, buildGroupBoxNode(g, nodes, proj))
    } else {
      const bounds = computeMemberBounds(nodes, g.node_ids)
      if (bounds) {
        expandedFrames.push({
          groupId: g.id,
          title: g.title,
          bounds: {
            x: bounds.x - GROUP_FRAME_PAD,
            y: bounds.y - GROUP_TITLE_BAR,
            w: bounds.w + GROUP_FRAME_PAD * 2,
            h: bounds.h + GROUP_FRAME_PAD + GROUP_TITLE_BAR,
          },
          color: g.color,
        })
      }
    }
  }

  const viewNodes: NodeInstance[] = []
  for (const n of nodes) {
    if (!hiddenNodeIds.has(n.id)) viewNodes.push(n)
  }
  for (const box of groupBoxes.values()) viewNodes.push(box)

  const viewLinks: Link[] = []
  for (const link of links) {
    const fromG = nodeCollapsedGroup(link.from_node, collapsed)
    const toG = nodeCollapsedGroup(link.to_node, collapsed)

    if (fromG && toG && fromG.id === toG.id) continue

    if (!fromG && !toG) {
      viewLinks.push({ ...link })
      continue
    }

    if (fromG && toG && fromG.id !== toG.id) {
      const fromProj = portProjections.get(fromG.id)!
      const toProj = portProjections.get(toG.id)!
      const outKey = `${link.to_node}:${link.to_slot}`
      const inKey = `${link.from_node}:${link.from_slot}`
      const outPort = fromProj.outputs.find(o => o.key === outKey)
      const inPort = toProj.inputs.find(i => i.key === inKey)
      if (outPort && inPort) {
        viewLinks.push({
          id: `view:${link.id}`,
          from_node: groupBoxNodeId(fromG.id),
          from_slot: outPort.view_slot,
          to_node: groupBoxNodeId(toG.id),
          to_slot: inPort.view_slot,
        })
      }
      continue
    }

    if (!fromG && toG) {
      const proj = portProjections.get(toG.id)!
      const key = `${link.from_node}:${link.from_slot}`
      const port = proj.inputs.find(i => i.key === key)
      if (port) {
        viewLinks.push({
          id: `view:${link.id}`,
          from_node: link.from_node,
          from_slot: link.from_slot,
          to_node: groupBoxNodeId(toG.id),
          to_slot: port.view_slot,
        })
      }
      continue
    }

    if (fromG && !toG) {
      const proj = portProjections.get(fromG.id)!
      const key = `${link.to_node}:${link.to_slot}`
      const port = proj.outputs.find(o => o.key === key)
      if (port) {
        viewLinks.push({
          id: `view:${link.id}`,
          from_node: groupBoxNodeId(fromG.id),
          from_slot: port.view_slot,
          to_node: link.to_node,
          to_slot: link.to_slot,
        })
      }
    }
  }

  return {
    nodes: viewNodes,
    links: viewLinks,
    hiddenNodeIds,
    groupBoxes,
    portProjections,
    expandedFrames,
  }
}
