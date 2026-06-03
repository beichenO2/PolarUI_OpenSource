import { describe, it, expect } from 'vitest'
import {
  formatSnippetCommentsInline,
  highlightExecutorSnippet,
} from '../src/engine/executor-code-display'

describe('formatSnippetCommentsInline', () => {
  it('passes through source unchanged (SSOT in executor.ts)', () => {
    const src = "const q = 1  // 行尾注释\n"
    expect(formatSnippetCommentsInline(src)).toBe(src)
  })
})

describe('highlightExecutorSnippet', () => {
  it('wraps keywords and comments', () => {
    const html = highlightExecutorSnippet('const x = 1  // n')
    expect(html).toContain('tok-keyword')
    expect(html).toContain('tok-comment')
    expect(html).toContain('tok-number')
  })
})
