/**
 * WF / LG 两套模式级 system prompt 框架。
 * Vite build 经 define 注入 globalThis；CLI smoke 由 headless-bootstrap 预置。
 */
import type { WorkflowLibrary } from './types'

function frames(): { wf: string; lg: string } {
  const g = globalThis as unknown as Record<string, string | undefined>
  return {
    wf: g.__POLARUI_WF_FRAME__ ?? '',
    lg: g.__POLARUI_LG_FRAME__ ?? '',
  }
}

export function getModeFrame(library: WorkflowLibrary): string {
  const { wf, lg } = frames()
  return library === 'LG' ? lg : wf
}

export function wrapModeSystemPrompt(library: WorkflowLibrary, base: string): string {
  const frame = getModeFrame(library)
  const trimmed = base.trim()
  if (!trimmed) return frame
  return `${frame}\n\n---\n\n${trimmed}`
}
