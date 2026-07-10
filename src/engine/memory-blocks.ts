/** MemorySearch blocks → prompt text formatting */

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
