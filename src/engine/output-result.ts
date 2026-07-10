import type { ExecutionState } from './types'

export function formatOutputPreview(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

export function getOutputResultContent(
  nodeId: string,
  results?: ExecutionState['results'],
): unknown | null {
  const r = results?.[nodeId]
  if (!r || r.error) return null
  const content = r.outputs?.content ?? r.outputs?.result ?? r.outputs?.displayed
  if (content === undefined || content === null) return null
  if (typeof content === 'string' && content.trim() === '') return null
  return content
}

export function outputNodeHasResult(
  nodeId: string,
  results?: ExecutionState['results'],
): boolean {
  return getOutputResultContent(nodeId, results) !== null
}
