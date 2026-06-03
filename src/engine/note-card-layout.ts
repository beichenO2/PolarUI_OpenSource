/**
 * NoteCard 布局 SSOT — params → node.width / node.height
 */
import type { NodeInstance } from './types'
import { HEADER_HEIGHT, NODE_DEFAULT_WIDTH } from './node-geometry'

export interface NoteCardLine {
  text: string
  heading?: 1 | 2
  bold?: boolean
  code?: boolean
}

export const NOTE_CARD_MIN_H = 48
export const NOTE_CARD_MAX_H = 900
export const NOTE_CARD_DEFAULT_BODY_FONT = 10

const MIN_W = 120
const MAX_W = 1200
const MIN_H = NOTE_CARD_MIN_H
const MAX_H = NOTE_CARD_MAX_H
const CONTENT_TOP = 24
const CONTENT_PAD_BOTTOM = 20

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

function paramNum(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = Number(params?.[key])
  return Number.isFinite(v) ? v : fallback
}

/** Markdown 行解析（与 canvas 绘制共用） */
export function stripInlineMarkdown(text: string): { text: string; bold: boolean; code: boolean } {
  const codeMatch = text.match(/^`([^`]+)`$/)
  if (codeMatch) return { text: codeMatch[1], bold: false, code: true }
  const boldMatch = text.match(/^\*\*(.+)\*\*$/)
  if (boldMatch) return { text: boldMatch[1], bold: true, code: false }
  return { text: text.replace(/\*\*(.+?)\*\*/g, '$1'), bold: false, code: false }
}

export function parseNoteCardMarkdown(content: string, maxLines: number): NoteCardLine[] {
  const out: NoteCardLine[] = []
  for (const raw of content.split('\n')) {
    if (out.length >= maxLines) break
    const trimmed = raw.trimEnd()
    if (!trimmed) {
      out.push({ text: '' })
      continue
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.*)/)
    if (heading) {
      const inline = stripInlineMarkdown(heading[2])
      out.push({
        text: inline.text,
        heading: Math.min(3, heading[1].length) as 1 | 2,
        bold: inline.bold,
        code: inline.code,
      })
      continue
    }
    const bullet = trimmed.match(/^[-*+]\s+(.*)/)
    if (bullet) {
      const inline = stripInlineMarkdown(bullet[1])
      out.push({ text: `• ${inline.text}`, bold: inline.bold, code: inline.code })
      continue
    }
    const inline = stripInlineMarkdown(trimmed)
    out.push({ text: inline.text, bold: inline.bold, code: inline.code })
  }
  return out
}

export function getNoteCardBodyFontSize(params: Record<string, unknown> | undefined): number {
  return clamp(paramNum(params, 'body_font_size', NOTE_CARD_DEFAULT_BODY_FONT), 7, 24)
}

/** 正文为基准，标题/代码等比例缩放 */
export function noteCardLineMetrics(
  line: NoteCardLine,
  bodySize: number,
): { fontSize: number; lineHeight: number } {
  if (line.heading === 1) {
    const fontSize = bodySize * 1.3
    return { fontSize, lineHeight: fontSize * (18 / 13) }
  }
  if (line.heading === 2) {
    const fontSize = bodySize * 1.2
    return { fontSize, lineHeight: fontSize * (16 / 12) }
  }
  if (line.code) {
    const fontSize = bodySize * 0.9
    return { fontSize, lineHeight: bodySize * 1.4 }
  }
  return { fontSize: bodySize, lineHeight: bodySize * 1.4 }
}

function lineHeight(line: NoteCardLine, bodySize: number): number {
  return noteCardLineMetrics(line, bodySize).lineHeight
}

/** 按内容估算展开高度（expanded_height=0 时自动增高） */
export function estimateNoteCardContentHeight(
  content: string,
  _cardWidth: number,
  bodySize = NOTE_CARD_DEFAULT_BODY_FONT,
): number {
  const lines = parseNoteCardMarkdown(content, 64)
  if (!lines.length) return HEADER_HEIGHT
  return lines.reduce((sum, line) => sum + lineHeight(line, bodySize), 0)
}

/** 将 params 中的宽高同步到 node.width / node.height */
export function applyNoteCardLayout(node: NodeInstance): void {
  if (node.class_type !== 'NoteCard') return

  const params = node.params ?? {}
  const expandedWidth = clamp(paramNum(params, 'expanded_width', 400), MIN_W, MAX_W)
  const collapsedHeight = clamp(paramNum(params, 'collapsed_height', 60), MIN_H, MAX_H)
  const collapsedWidthRaw = paramNum(params, 'collapsed_width', 0)
  const expandedHeightFixed = paramNum(params, 'expanded_height', 0)
  const collapsed = node.collapsed !== false

  if (collapsed) {
    node.width = collapsedWidthRaw > 0
      ? clamp(collapsedWidthRaw, MIN_W, MAX_W)
      : Math.min(NODE_DEFAULT_WIDTH, expandedWidth)
    node.height = collapsedHeight
    return
  }

  node.width = expandedWidth
  if (expandedHeightFixed > 0) {
    node.height = clamp(expandedHeightFixed, MIN_H, MAX_H)
  } else {
    const bodySize = getNoteCardBodyFontSize(params)
    const contentH = estimateNoteCardContentHeight(String(params.content ?? ''), expandedWidth, bodySize)
    node.height = clamp(
      Math.max(collapsedHeight, CONTENT_TOP + contentH + CONTENT_PAD_BOTTOM),
      MIN_H,
      MAX_H,
    )
  }
}

export function applyNoteCardLayoutAll(nodes: NodeInstance[]): void {
  for (const node of nodes) applyNoteCardLayout(node)
}
