/**
 * 组成代码面板：行尾注释整理 + VS Code Dark+ 风格轻量高亮（无 TextMate 依赖）。
 * 参考：vscode/extensions/theme-defaults/themes/dark_plus.json
 */

export const VSCODE_DARK_PLUS = {
  foreground: '#d4d4d4',
  comment: '#6a9955',
  string: '#ce9178',
  keyword: '#569cd6',
  number: '#b5cea8',
  type: '#4ec9b0',
  function: '#dcdcaa',
  identifier: '#9cdcfe',
  punctuation: '#d4d4d4',
} as const

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'super',
  'switch', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
])

const TYPES = new Set([
  'Record', 'Promise', 'Array', 'String', 'Number', 'Boolean', 'Object', 'Error', 'Map', 'Set',
])

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 源码已是行尾注释 SSOT；展示层不再二次改写 */
export function formatSnippetCommentsInline(source: string): string {
  return source
}

type Span = { start: number; end: number; cls: string }

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start < last.end) continue
    out.push(s)
  }
  return out
}

function collectSpans(line: string): Span[] {
  const spans: Span[] = []

  const commentRe = /(\/\/.*$|\/\*[\s\S]*?\*\/)/g
  let m: RegExpExecArray | null
  while ((m = commentRe.exec(line)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, cls: 'tok-comment' })
  }

  const strRe = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g
  while ((m = strRe.exec(line)) !== null) {
    if (!spans.some(s => m!.index >= s.start && m!.index < s.end)) {
      spans.push({ start: m.index, end: m.index + m[0].length, cls: 'tok-string' })
    }
  }

  const numRe = /\b\d+(?:\.\d+)?\b/g
  while ((m = numRe.exec(line)) !== null) {
    if (!spans.some(s => m!.index >= s.start && m!.index < s.end)) {
      spans.push({ start: m.index, end: m.index + m[0].length, cls: 'tok-number' })
    }
  }

  const wordRe = /\b[A-Za-z_$][\w$]*\b/g
  while ((m = wordRe.exec(line)) !== null) {
    if (spans.some(s => m!.index >= s.start && m!.index < s.end)) continue
    const w = m[0]
    const next = line[m.index + w.length]
    if (KEYWORDS.has(w)) {
      spans.push({ start: m.index, end: m.index + w.length, cls: 'tok-keyword' })
    } else if (TYPES.has(w)) {
      spans.push({ start: m.index, end: m.index + w.length, cls: 'tok-type' })
    } else if (next === '(') {
      spans.push({ start: m.index, end: m.index + w.length, cls: 'tok-fn' })
    } else if (/^[A-Z]/.test(w)) {
      spans.push({ start: m.index, end: m.index + w.length, cls: 'tok-type' })
    } else {
      spans.push({ start: m.index, end: m.index + w.length, cls: 'tok-ident' })
    }
  }

  return mergeSpans(spans)
}

function lineToHtml(line: string): string {
  const spans = collectSpans(line)
  if (!spans.length) return escapeHtml(line)
  let html = ''
  let pos = 0
  for (const s of spans) {
    html += escapeHtml(line.slice(pos, s.start))
    html += `<span class="${s.cls}">${escapeHtml(line.slice(s.start, s.end))}</span>`
    pos = s.end
  }
  html += escapeHtml(line.slice(pos))
  return html
}

/** 高亮为 HTML（按行，保留换行；注释与 executor.ts 同源） */
export function highlightExecutorSnippet(source: string): string {
  return formatSnippetCommentsInline(source)
    .split('\n')
    .map(l => lineToHtml(l))
    .join('\n')
}
