/**
 * 节点经典原型（archetype）— 组件视觉分型 SSOT。
 *
 * 设计出发点：组件从 LLM 抽象而来，抽象程度低，视觉上归为若干经典款
 * （输入 / 上下文 / LLM / 路由控制 / 工具调用 / 输出 / 进化），
 * 而非按细分 category 杂乱配色。强调色对齐 PolarFlow nodeColors.ts。
 * hermes 主题下自动切换为亮色系变体（canvas-theme.ts）。
 */
import { activeCanvasThemeName, HERMES_ARCHETYPE_COLORS } from './canvas-theme'

export interface NodeArchetype {
  key: string
  /** 分类 pill 中文名 */
  label: string
  /** 左侧 accent bar 强调色 */
  color: string
  /** 分类 pill 浅底 */
  pillBg: string
  /** 分类 pill 深字 */
  pillText: string
}

const ARCHETYPES: Record<string, NodeArchetype> = {
  input: { key: 'input', label: '输入', color: '#D97706', pillBg: '#fef3c7', pillText: '#92400e' },
  context: { key: 'context', label: '上下文', color: '#0D9488', pillBg: '#ccfbf1', pillText: '#0f766e' },
  llm: { key: 'llm', label: 'LLM', color: '#7C3AED', pillBg: '#ede9fe', pillText: '#5b21b6' },
  route: { key: 'route', label: '路由控制', color: '#4F46E5', pillBg: '#e0e7ff', pillText: '#4338ca' },
  tool: { key: 'tool', label: '工具调用', color: '#2563EB', pillBg: '#dbeafe', pillText: '#1d4ed8' },
  output: { key: 'output', label: '输出', color: '#059669', pillBg: '#d1fae5', pillText: '#047857' },
  evolve: { key: 'evolve', label: '进化', color: '#DB2777', pillBg: '#fce7f3', pillText: '#be185d' },
  default: { key: 'default', label: '组件', color: '#6b7280', pillBg: '#f3f4f6', pillText: '#6b7280' },
}

/** class_type 显式归类（claude-code 26 组件 + 常用扩展） */
const CLASS_ARCHETYPE: Record<string, string> = {
  // 输入
  PromptInput: 'input',
  StaticData: 'input',
  PromptInject: 'input',
  NormInject: 'input',
  // 上下文
  ContextWindow: 'context',
  ReflectiveContext: 'context',
  // LLM
  LLM: 'llm',
  SubAgent: 'llm',
  VLM: 'llm',
  SchemaExtract: 'llm',
  // 路由控制
  Switch: 'route',
  RetryLoop: 'route',
  Validator: 'route',
  PermissionGate: 'route',
  // 工具调用
  ToolCall: 'tool',
  FileRead: 'tool',
  FileWrite: 'tool',
  GlobSearch: 'tool',
  GrepSearch: 'tool',
  WebSearch: 'tool',
  MCPCall: 'tool',
  CodeExec: 'tool',
  // 输出
  Output: 'output',
}

/**
 * registry category 兜底 — node-defs 其余组件按语义就近归类：
 * Memory → 上下文；Agentic（LLM 驱动的范式单元）→ LLM；
 * Control → 路由控制；Transform/Tools → 工具调用；Evolve → 进化。
 */
const CATEGORY_ARCHETYPE: Record<string, string> = {
  Input: 'input',
  Memory: 'context',
  LLM: 'llm',
  Agentic: 'llm',
  Control: 'route',
  Transform: 'tool',
  Tools: 'tool',
  'Internal/Legacy': 'tool',
  Output: 'output',
  Evolve: 'evolve',
}

export function nodeArchetype(classType: string, category?: string): NodeArchetype {
  const base = baseArchetype(classType, category)
  if (activeCanvasThemeName() === 'hermes') {
    const themed = HERMES_ARCHETYPE_COLORS[base.key] ?? HERMES_ARCHETYPE_COLORS.default
    return { ...base, ...themed }
  }
  return base
}

function baseArchetype(classType: string, category?: string): NodeArchetype {
  const byClass = CLASS_ARCHETYPE[classType]
  if (byClass) return ARCHETYPES[byClass]
  if (category) {
    const topCategory = category.split('/')[0]
    const byCategory = CATEGORY_ARCHETYPE[category] ?? CATEGORY_ARCHETYPE[topCategory]
    if (byCategory) return ARCHETYPES[byCategory]
  }
  return ARCHETYPES.default
}
