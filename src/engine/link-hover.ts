import type { Link } from './types'

/** Non-associated edges when a node is hovered (§2.4 260531). */
export const LINK_DIM_ALPHA = 0.35

export function linkTouchesNode(link: Link, nodeId: string | null): boolean {
  if (!nodeId) return false
  return link.from_node === nodeId || link.to_node === nodeId
}

export function linkHoverAlpha(link: Link, hoverNodeId: string | null, baseAlpha: number): number {
  if (!hoverNodeId) return baseAlpha
  return linkTouchesNode(link, hoverNodeId) ? baseAlpha : LINK_DIM_ALPHA
}
