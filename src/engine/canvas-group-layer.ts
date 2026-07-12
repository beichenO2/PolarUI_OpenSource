/**
 * Canvas rendering helpers for workflow groups (view layer only).
 */
import type { NodeInstance } from './types'
import {
  HEADER_HEIGHT,
  SLOT_HEIGHT,
  SLOT_PADDING,
  SLOT_RADIUS,
  NODE_BOTTOM_PAD,
  CONTENT_AREA_HEIGHT,
  slotGraphY,
  type AABB,
} from './node-geometry'
import {
  GROUP_BOX_CLASS,
  type ExpandedGroupFrame,
  type GroupPortProjection,
} from './graph-groups'
import type { SuggestedGroup } from './group-suggest'
import { CANVAS_FONT_UI } from './canvas-fonts'
import { activeCanvasThemeName } from './canvas-theme'

export const GROUP_TITLE_BAR_H = 28

export function isGroupBoxNode(node: NodeInstance | undefined): boolean {
  return node?.class_type === GROUP_BOX_CLASS
}

export function hitTestExpandedTitleBar(frame: ExpandedGroupFrame, gx: number, gy: number): boolean {
  return (
    gx >= frame.bounds.x &&
    gx <= frame.bounds.x + frame.bounds.w &&
    gy >= frame.bounds.y &&
    gy <= frame.bounds.y + GROUP_TITLE_BAR_H
  )
}

export function suggestionBounds(
  nodes: NodeInstance[],
  nodeIds: string[],
  pad = 20,
): AABB | null {
  const set = new Set(nodeIds)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let n = 0
  for (const node of nodes) {
    if (!set.has(node.id)) continue
    n++
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  if (n === 0) return null
  return { x: minX - pad, y: minY - pad - GROUP_TITLE_BAR_H, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 + GROUP_TITLE_BAR_H }
}

export interface GroupDrawColors {
  bg: string
  border: string
  header: string
  headerText: string
  badge: string
}

const LIGHT_GROUP_COLORS: GroupDrawColors = {
  bg: '#f1f5f9',
  border: '#64748b',
  header: '#475569',
  headerText: '#ffffff',
  badge: '#3b82f6',
}

const HERMES_GROUP_COLORS: GroupDrawColors = {
  bg: 'rgba(255, 230, 203, 0.05)',
  border: 'rgba(255, 230, 203, 0.35)',
  header: 'rgba(255, 230, 203, 0.12)',
  headerText: '#ffe6cb',
  badge: '#60a5fa',
}

function groupColors(): GroupDrawColors {
  return activeCanvasThemeName() === 'hermes' ? HERMES_GROUP_COLORS : LIGHT_GROUP_COLORS
}

export function drawExpandedGroupFrame(
  ctx: CanvasRenderingContext2D,
  frame: ExpandedGroupFrame,
  toScreen: (gx: number, gy: number) => { x: number; y: number },
  scale: number,
  selected: boolean,
): void {
  const sp = toScreen(frame.bounds.x, frame.bounds.y)
  const sw = frame.bounds.w * scale
  const sh = frame.bounds.h * scale
  const color = frame.color ?? groupColors().border

  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = 0.08
  ctx.fillRect(sp.x, sp.y, sw, sh)
  ctx.globalAlpha = 1

  ctx.strokeStyle = selected ? '#3b82f6' : color
  ctx.lineWidth = selected ? 2 : 1
  ctx.setLineDash([6 * scale, 4 * scale])
  ctx.strokeRect(sp.x, sp.y, sw, sh)
  ctx.setLineDash([])

  const titleH = GROUP_TITLE_BAR_H * scale
  ctx.fillStyle = selected ? '#3b82f6' : groupColors().header
  ctx.globalAlpha = 0.85
  ctx.fillRect(sp.x, sp.y, sw, titleH)
  ctx.globalAlpha = 1

  ctx.fillStyle = groupColors().headerText
  ctx.font = `bold ${12 * scale}px ${CANVAS_FONT_UI}`
  ctx.textBaseline = 'middle'
  ctx.fillText(frame.title, sp.x + 8 * scale, sp.y + titleH / 2, sw - 16 * scale)
  ctx.restore()
}

export function drawGroupBoxNode(
  ctx: CanvasRenderingContext2D,
  node: NodeInstance,
  toScreen: (gx: number, gy: number) => { x: number; y: number },
  scale: number,
  selected: boolean,
  projection?: GroupPortProjection,
): void {
  const sp = toScreen(node.x, node.y)
  const sw = node.width * scale
  const sh = node.height * scale
  const title = String(node.params.title ?? 'Group')
  const memberCount = Number(node.params.member_count ?? 0)
  const color = String(node.params.color ?? groupColors().header)
  const radius = 8 * scale

  ctx.save()

  ctx.fillStyle = groupColors().bg
  ctx.beginPath()
  roundRect(ctx, sp.x, sp.y, sw, sh, radius)
  ctx.fill()

  if (selected) {
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 3 * scale
    ctx.globalAlpha = 0.5
    roundRect(ctx, sp.x - 2 * scale, sp.y - 2 * scale, sw + 4 * scale, sh + 4 * scale, radius + 2 * scale)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  ctx.strokeStyle = selected ? '#3b82f6' : groupColors().border
  ctx.lineWidth = selected ? 2 : 1
  roundRect(ctx, sp.x, sp.y, sw, sh, radius)
  ctx.stroke()

  const headerH = HEADER_HEIGHT * scale
  ctx.fillStyle = color
  roundRectTop(ctx, sp.x, sp.y, sw, headerH, radius)
  ctx.fill()

  ctx.fillStyle = groupColors().headerText
  ctx.font = `bold ${14 * scale}px ${CANVAS_FONT_UI}`
  ctx.textBaseline = 'middle'
  ctx.fillText(title, sp.x + 10 * scale, sp.y + headerH / 2, sw - 50 * scale)

  const badgeR = 10 * scale
  const badgeX = sp.x + sw - 14 * scale
  const badgeY = sp.y + headerH / 2
  ctx.fillStyle = groupColors().badge
  ctx.beginPath()
  ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${10 * scale}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(String(memberCount), badgeX, badgeY)
  ctx.textAlign = 'left'

  const inputCount = projection?.inputs.length ?? Number(node.params.input_port_count ?? 0)
  const outputCount = projection?.outputs.length ?? Number(node.params.output_port_count ?? 0)
  for (let i = 0; i < inputCount; i++) {
    const sy = toScreen(0, slotGraphY(node, i)).y
    ctx.fillStyle = groupColors().border
    ctx.beginPath()
    ctx.arc(sp.x, sy, SLOT_RADIUS * scale, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 0; i < outputCount; i++) {
    const sy = toScreen(0, slotGraphY(node, i)).y
    ctx.fillStyle = '#22c55e'
    ctx.beginPath()
    ctx.arc(sp.x + sw, sy, SLOT_RADIUS * scale, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

export function drawSuggestionPreview(
  ctx: CanvasRenderingContext2D,
  bounds: AABB,
  title: string,
  toScreen: (gx: number, gy: number) => { x: number; y: number },
  scale: number,
): void {
  const sp = toScreen(bounds.x, bounds.y)
  const sw = bounds.w * scale
  const sh = bounds.h * scale
  ctx.save()
  ctx.strokeStyle = '#8b5cf6'
  ctx.lineWidth = 2 * scale
  ctx.setLineDash([8 * scale, 6 * scale])
  ctx.strokeRect(sp.x, sp.y, sw, sh)
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(139, 92, 246, 0.06)'
  ctx.fillRect(sp.x, sp.y, sw, sh)
  ctx.fillStyle = '#6d28d9'
  ctx.font = `bold ${11 * scale}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText(`? ${title}`, sp.x + 6 * scale, sp.y + 4 * scale)
  ctx.restore()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function roundRectTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

export type { SuggestedGroup }
