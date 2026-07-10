/**
 * Pure helpers for canvas node double-click handling.
 * GraphCanvas uses the native `dblclick` event; these helpers keep
 * timing / hit-policy decisions unit-testable without DOM.
 */
import type { NodeInstance } from './types'
import { isGroupBoxNode } from './canvas-group-layer'

export const NODE_DBLCLICK_THRESHOLD_MS = 300

export type ClickStamp = { nodeId: string; time: number }

/**
 * Detect same-node double-click when two clicks arrive within `thresholdMs`.
 * Returns whether a double-click fired and the stamp to keep for the next click.
 * After a double-click fires, `next` is null so a third click starts a new sequence.
 */
export function detectDoubleClick(
  prev: ClickStamp | null | undefined,
  nodeId: string,
  now: number,
  thresholdMs = NODE_DBLCLICK_THRESHOLD_MS,
): { fired: boolean; next: ClickStamp | null } {
  if (prev && prev.nodeId === nodeId && now - prev.time < thresholdMs) {
    return { fired: true, next: null }
  }
  return { fired: false, next: { nodeId, time: now } }
}

/**
 * Canvas-internal dblclick targets (NoteCard toggle, group expand) should not
 * also fire the generic `onNodeDblClick` callback.
 */
export function shouldInvokeNodeDblClick(hit: NodeInstance | null | undefined): hit is NodeInstance {
  if (!hit) return false
  if (hit.class_type === 'NoteCard') return false
  if (isGroupBoxNode(hit)) return false
  return true
}

/** Resolve SSoT_Project node params into a drill-down action. */
export function resolveSsotProjectDblClick(
  node: NodeInstance,
):
  | { action: 'drill'; projectName: string }
  | { action: 'missing'; projectName: string }
  | { action: 'ignore' } {
  if (node.class_type !== 'SSoT_Project') return { action: 'ignore' }
  const projectName = String(node.params?.name ?? node.params?.label ?? '').trim()
  if (!projectName) return { action: 'ignore' }
  if (node.params?.missing === true) return { action: 'missing', projectName }
  return { action: 'drill', projectName }
}
