/** 记忆/Prompt 进化 — capture 蒸馏与 MemorySearch blocks 格式化（00 §3.4） */

export function formatMemoryBlocks(blocks: unknown): string {
  if (blocks == null) return ''
  if (typeof blocks === 'string') return blocks.trim()

  const obj = blocks as { blocks?: unknown[]; results?: unknown[]; items?: unknown[] }
  const arr = Array.isArray(blocks)
    ? blocks
    : obj.blocks ?? obj.results ?? obj.items ?? []

  if (!Array.isArray(arr) || arr.length === 0) {
    if (typeof blocks === 'object') {
      return JSON.stringify(blocks).slice(0, 1500)
    }
    return ''
  }

  return arr
    .map((b, i) => {
      const item = b as { content?: string; text?: string; block?: string; title?: string; id?: string }
      const title = item.title ?? item.id ?? `block-${i + 1}`
      const body = item.content ?? item.text ?? item.block ?? JSON.stringify(item)
      return `### ${title}\n${body}`
    })
    .join('\n\n')
}

export function distillCapture(capture: unknown, maxChars = 2000): string {
  if (capture == null) return ''
  if (typeof capture === 'string') return capture.slice(0, maxChars)
  if (typeof capture !== 'object') return String(capture).slice(0, maxChars)

  const c = capture as Record<string, unknown>
  const lines: string[] = []

  if (c.capture_id) lines.push(`- capture_id: ${c.capture_id}`)
  if (c.trigger) lines.push(`- trigger: ${c.trigger}`)
  if (c.decision != null) lines.push(`- decision: ${JSON.stringify(c.decision)}`)
  if (c.result != null) lines.push(`- result: ${JSON.stringify(c.result)}`)
  if (c.validation_report != null) lines.push(`- validation: ${JSON.stringify(c.validation_report)}`)
  if (c.context != null) lines.push(`- context: ${JSON.stringify(c.context)}`)
  if (c.auto_applied != null) lines.push(String(c.auto_applied))

  const body = lines.length ? lines.join('\n') : JSON.stringify(capture)
  return `## 蒸馏经验（PromptEvolve）\n${body}`.slice(0, maxChars)
}

export const PROMPT_EVOLVE_AUTO_APPLY_PATH = 'PolarUI/.data/prompt-evolve/auto-apply.latest.md'
export const PROMPT_EVOLVE_LATEST_PATH = 'PolarUI/.data/prompt-evolve/latest.md'
