/**
 * 画布主题 SSOT — light（PolarFlow 浅色）与 hermes（NousResearch 深 Teal）双套调色板。
 *
 * Canvas2D 无法低成本读 CSS 变量（60fps），这里维护与 CSS 主题平行的色表；
 * GraphCanvas 每帧 render 前调 activeCanvasTheme() 取当前表（读 dataset 是 O(1)）。
 * 无 document 环境（node 测试 / headless）恒为 light — golden 确定性。
 */

export type CanvasThemeName = 'light' | 'hermes'

export interface CanvasTheme {
  bg: string
  grid: string
  surface: string
  border: string
  text: string
  textMuted: string
  primary: string
  valid: string
  error: string
  nodeSelected: string
  link: string
  linkActive: string
  slotInput: string
  slotOutput: string
  slotOutputBorder: string
  running: string
  terminal: string
  terminalBorder: string
  shadow: string
  /* 节点状态填充 */
  stateError: string
  stateCompleted: string
  stateSkipped: string
  stateOutputDone: string
  /* 连线标签/chip */
  wireLabelBg: string
  wireLabelBgEmphasis: string
  wireLabelText: string
  wireLabelBorder: string
}

export const CANVAS_LIGHT: CanvasTheme = {
  bg: '#f8fafc',
  grid: '#e8ecf1',
  surface: '#ffffff',
  border: '#e5e7eb',
  text: '#111827',
  textMuted: '#6b7280',
  primary: '#7c3aed',
  valid: '#059669',
  error: '#dc2626',
  nodeSelected: '#faf5ff',
  link: '#94a3b8',
  linkActive: '#2563eb',
  slotInput: '#64748b',
  slotOutput: '#22c55e',
  slotOutputBorder: '#16a34a',
  running: '#22c55e',
  terminal: '#f0fdf4',
  terminalBorder: '#4ade80',
  shadow: 'rgba(15, 23, 42, 0.08)',
  stateError: '#fef2f2',
  stateCompleted: '#f0fdf4',
  stateSkipped: '#f1f5f9',
  stateOutputDone: '#dcfce7',
  wireLabelBg: '#475569',
  wireLabelBgEmphasis: '#2563eb',
  wireLabelText: '#ffffff',
  wireLabelBorder: '#e2e8f0',
}

export const CANVAS_HERMES: CanvasTheme = {
  bg: '#041c1c',
  grid: 'rgba(255, 230, 203, 0.06)',
  surface: '#0e2423',
  border: 'rgba(255, 230, 203, 0.15)',
  text: '#ffe6cb',
  textMuted: 'rgba(255, 230, 203, 0.65)',
  primary: '#ffe6cb',
  valid: '#4ade80',
  error: '#fb2c36',
  nodeSelected: 'rgba(255, 230, 203, 0.08)',
  link: 'rgba(255, 230, 203, 0.25)',
  linkActive: '#ffe6cb',
  slotInput: 'rgba(255, 230, 203, 0.55)',
  slotOutput: '#34d399',
  slotOutputBorder: '#4ade80',
  running: '#4ade80',
  terminal: 'rgba(52, 211, 153, 0.1)',
  terminalBorder: '#34d399',
  shadow: 'rgba(0, 0, 0, 0.4)',
  stateError: 'rgba(251, 44, 54, 0.15)',
  stateCompleted: 'rgba(74, 222, 128, 0.12)',
  stateSkipped: 'rgba(255, 230, 203, 0.06)',
  stateOutputDone: 'rgba(52, 211, 153, 0.18)',
  wireLabelBg: 'rgba(4, 28, 28, 0.92)',
  wireLabelBgEmphasis: '#ffe6cb',
  wireLabelText: '#ffe6cb',
  wireLabelBorder: 'rgba(255, 230, 203, 0.3)',
}

export function activeCanvasThemeName(): CanvasThemeName {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'hermes' ? 'hermes' : 'light'
}

export function activeCanvasTheme(): CanvasTheme {
  return activeCanvasThemeName() === 'hermes' ? CANVAS_HERMES : CANVAS_LIGHT
}

/* ── 原型 accent（描边/色条/pill）按主题 ── */

export interface ArchetypeThemeColors {
  color: string
  pillBg: string
  pillText: string
}

/** hermes 变体 — 亮色系描边适配深底；pill = 色 15% 透明底 + 亮字（Hermes badge 风格） */
export const HERMES_ARCHETYPE_COLORS: Record<string, ArchetypeThemeColors> = {
  input: { color: '#ffbd38', pillBg: 'rgba(255, 189, 56, 0.15)', pillText: '#ffbd38' },
  context: { color: '#2dd4bf', pillBg: 'rgba(45, 212, 191, 0.15)', pillText: '#2dd4bf' },
  llm: { color: '#c4b5fd', pillBg: 'rgba(196, 181, 253, 0.15)', pillText: '#c4b5fd' },
  route: { color: '#a5b4fc', pillBg: 'rgba(165, 180, 252, 0.15)', pillText: '#a5b4fc' },
  tool: { color: '#60a5fa', pillBg: 'rgba(96, 165, 250, 0.15)', pillText: '#60a5fa' },
  output: { color: '#34d399', pillBg: 'rgba(52, 211, 153, 0.15)', pillText: '#34d399' },
  evolve: { color: '#f472b6', pillBg: 'rgba(244, 114, 182, 0.15)', pillText: '#f472b6' },
  default: { color: 'rgba(255, 230, 203, 0.45)', pillBg: 'rgba(255, 230, 203, 0.1)', pillText: 'rgba(255, 230, 203, 0.75)' },
}

/* ── 连线语义色按主题 ── */

export interface WireThemeColors {
  semanticOutput: string
  semanticControl: string
  pending: string
  forwardPalette: readonly string[]
  backwardPalette: readonly string[]
}

export const WIRE_LIGHT: WireThemeColors = {
  semanticOutput: '#059669',
  semanticControl: '#4F46E5',
  pending: '#94a3b8',
  forwardPalette: [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
    '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#aaffc3', '#ffe119',
  ],
  backwardPalette: [
    '#dc2626', '#ef4444', '#b91c1c', '#f87171', '#991b1b', '#fca5a5', '#7f1d1d', '#fecaca',
  ],
}

export const WIRE_HERMES: WireThemeColors = {
  semanticOutput: '#34d399',
  semanticControl: '#a5b4fc',
  pending: 'rgba(255, 230, 203, 0.25)',
  /* 深底亮色系 — 保持相邻 hue 大间隔的区分度 */
  forwardPalette: [
    '#f87171', '#4ade80', '#60a5fa', '#fb923c', '#c4b5fd', '#22d3ee', '#f472b6',
    '#a3e635', '#fda4af', '#2dd4bf', '#e9d5ff', '#d6a05c', '#86efac', '#fde047',
  ],
  backwardPalette: [
    '#fb2c36', '#f87171', '#ef4444', '#fca5a5', '#dc2626', '#fecaca', '#b91c1c', '#fee2e2',
  ],
}

export function activeWireTheme(): WireThemeColors {
  return activeCanvasThemeName() === 'hermes' ? WIRE_HERMES : WIRE_LIGHT
}
