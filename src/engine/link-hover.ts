import type { Link } from './types'

/** Non-associated edges when a node or wire is focused (§2.4 260531). */
export const LINK_DIM_ALPHA = 0.15

export function linkTouchesNode(link: Link, nodeId: string | null): boolean {
  if (!nodeId) return false
  return link.from_node === nodeId || link.to_node === nodeId
}

export interface LinkFocusContext {
  hoverNodeId: string | null
  selectedNodeIds: ReadonlySet<string>
  selectedLinkId: string | null
  baseAlpha: number
}

export function linkFocusAlpha(link: Link, ctx: LinkFocusContext): number {
  const { hoverNodeId, selectedNodeIds, selectedLinkId, baseAlpha } = ctx

  if (selectedLinkId) {
    return link.id === selectedLinkId ? baseAlpha : LINK_DIM_ALPHA
  }

  if (hoverNodeId) {
    return linkTouchesNode(link, hoverNodeId) ? baseAlpha : LINK_DIM_ALPHA
  }

  if (selectedNodeIds.size > 0) {
    for (const id of selectedNodeIds) {
      if (linkTouchesNode(link, id)) return baseAlpha
    }
    return LINK_DIM_ALPHA
  }

  return baseAlpha
}

/** @deprecated Use linkFocusAlpha — kept for narrow imports */
export function linkHoverAlpha(link: Link, hoverNodeId: string | null, baseAlpha: number): number {
  return linkFocusAlpha(link, {
    hoverNodeId,
    selectedNodeIds: new Set(),
    selectedLinkId: null,
    baseAlpha,
  })
}
