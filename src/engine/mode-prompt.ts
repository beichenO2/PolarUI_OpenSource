/**
 * WF 模式级 system prompt 框架。
 * Vite build 经 define 注入 globalThis；CLI smoke 由 headless-bootstrap 预置。
 */

function getFrame(): string {
  const g = globalThis as unknown as Record<string, string | undefined>
  return g.__POLARUI_WF_FRAME__ ?? ''
}

export function getModeFrame(): string {
  return getFrame()
}

export function wrapModeSystemPrompt(base: string): string {
  const frame = getFrame()
  const trimmed = base.trim()
  if (!trimmed) return frame
  return `${frame}\n\n---\n\n${trimmed}`
}
