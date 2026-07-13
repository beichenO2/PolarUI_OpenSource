/**
 * 节点形状系统 — 画布回归经典流程图语言。
 *
 * 简单原子组件用几个经典几何形状（信息密度：形状 + 标题 + 至多一行关键参数）；
 * 复杂组件统一"函数盒 fn box"（方卡片 + fn 徽标，可收起/展开 = 可伸缩性）。
 * 形状与原型（node-archetype 配色）正交：形状表达简单/复杂与流程语义，颜色表达原型。
 */
import type { NodeDef, NodeInstance } from './types'
import { nodeArchetype } from './node-archetype'

export type NodeShapeKind =
  | 'stadium' // 输入/输出 — 流程图起止符（胶囊）
  | 'hexagon' // 路由控制 — 决策/守卫（左右垂直边的横置六边形）
  | 'cylinder' // 上下文/记忆 — 数据库圆柱
  | 'card' // LLM（画布主角）与 SSoT 数据卡 — 圆角矩形 + 粗左色条
  | 'tool' // 工具调用 — 双边矩形（flowchart predefined-process）
  | 'fn' // 复杂组件 — 函数盒（可伸缩）

/**
 * 复杂组件判定（fn box）：
 * 1. Agentic 范式（Planner/AgentWorkflow/AgenticUnit/…）
 * 2. Evolve（StemCell/PetriDish）
 * 3. SubAgent
 * 4. def.expandable === true（可展开为子图的天然复合体）
 * 5. def.params 键数 ≥ 5（如 HumanApproval、PromptInject）
 * 6. 任一 param 声明为 object 或默认值为对象/数组（嵌套配置）
 * SSoT 视觉节点显式排除（数据卡语义，不折叠）。
 */
export function isComplexNodeDef(classType: string, def: NodeDef | null | undefined): boolean {
  if (classType.startsWith('SSoT_')) return false
  if (classType === 'SubAgent') return true
  if (!def) return false
  // R11: def 级函数引用节点天然是函数盒（紧凑收起 + fn 徽标 + 双击下钻）
  if (typeof def.fn_ref === 'string' && def.fn_ref.trim()) return true
  const topCategory = def.category.split('/')[0]
  if (topCategory === 'Agentic' || topCategory === 'Evolve') return true
  if (def.expandable === true) return true
  const params = def.params ?? {}
  const keys = Object.keys(params)
  if (keys.length >= 5) return true
  for (const p of Object.values(params)) {
    const t = (p as { type?: string }).type
    if (t === 'object' || t === 'json') return true
    const d = (p as { default?: unknown }).default
    if (d !== null && (Array.isArray(d) || typeof d === 'object')) return true
  }
  return false
}

/** class_type + def → 形状。def 缺失（测试 Stub 等）回退 card。 */
export function nodeShape(classType: string, def: NodeDef | null | undefined): NodeShapeKind {
  if (classType.startsWith('SSoT_')) return 'card'
  if (!def) return 'card'
  if (isComplexNodeDef(classType, def)) return 'fn'
  const archetype = nodeArchetype(classType, def.category)
  switch (archetype.key) {
    case 'input':
    case 'output':
      return 'stadium'
    case 'route':
      return 'hexagon'
    case 'context':
      return 'cylinder'
    case 'tool':
      return 'tool'
    case 'evolve':
      return 'fn'
    case 'llm':
    default:
      return 'card'
  }
}

/** fn 盒收起态判定 — collapsed 未显式 false 即收起（默认收起）。 */
export function isFnCollapsed(node: NodeInstance): boolean {
  return node.collapsed !== false
}

const KEY_PARAM_PRIORITY = [
  'model', 'path', 'file_path', 'pattern', 'query', 'url', 'tool', 'server',
  'language', 'format', 'mode', 'command', 'channel',
] as const

/**
 * 简单形状的"至多一行关键参数"。没有就返回 null（不画）。
 * 详情全部留给右栏 inspector。
 */
export function keyParamLine(node: NodeInstance, def: NodeDef): string | null {
  const p = node.params ?? {}
  switch (node.class_type) {
    case 'Switch': {
      let n = def.outputs.length
      try {
        const cases = JSON.parse(String(p.cases ?? '[]')) as unknown[]
        if (Array.isArray(cases) && cases.length > 0) n = cases.length
      } catch { /* 保持 def.outputs */ }
      return `分支 × ${n}`
    }
    case 'Condition':
      return `分支 × ${Math.max(Number(p.branch_count ?? 2), 2)}`
    case 'SSoT_Project':
      return p.tier ? `tier: ${String(p.tier)}` : null
    case 'SSoT_Requirement': {
      const done = Number(p.featureDone ?? 0)
      const total = Number(p.featureCount ?? 0)
      return total > 0 ? `features ${done}/${total}` : null
    }
    case 'SSoT_Feature':
      return p.status ? String(p.status) : null
  }
  for (const key of KEY_PARAM_PRIORITY) {
    const v = p[key]
    if (typeof v === 'string' && v.trim()) return `${key}: ${v.trim()}`
    if (typeof v === 'number') return `${key}: ${v}`
  }
  return null
}

/**
 * 形状轮廓 path（屏幕坐标；调用方负责 fill/stroke）。
 * 所有形状左右边缘在 x / x+w — slot 锚点 SSOT（linkAnchor）不变。
 * scale：画布缩放，让固定细节尺寸（切角/圆角/椭圆高）随视图缩放。
 */
export function traceNodeShapePath(
  ctx: CanvasRenderingContext2D,
  kind: NodeShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  scale = 1,
): void {
  ctx.beginPath()
  switch (kind) {
    case 'stadium': {
      const r = h / 2
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y)
      ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
      ctx.lineTo(x + r, y + h)
      ctx.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2)
      ctx.closePath()
      return
    }
    case 'hexagon': {
      // 横置六边形：上下浅尖顶 + 左右垂直边（slot 锚点贴垂直边，不悬空）
      const ch = Math.min(12 * scale, h * 0.18)
      ctx.moveTo(x, y + ch)
      ctx.lineTo(x + w / 2, y)
      ctx.lineTo(x + w, y + ch)
      ctx.lineTo(x + w, y + h - ch)
      ctx.lineTo(x + w / 2, y + h)
      ctx.lineTo(x, y + h - ch)
      ctx.closePath()
      return
    }
    case 'cylinder': {
      const ry = cylinderRy(h, scale)
      ctx.moveTo(x, y + ry)
      ctx.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0)
      ctx.lineTo(x + w, y + h - ry)
      ctx.ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, 0, Math.PI)
      ctx.closePath()
      return
    }
    case 'tool': {
      roundRectPath(ctx, x, y, w, h, Math.min(8 * scale, h * 0.16))
      return
    }
    case 'card': {
      roundRectPath(ctx, x, y, w, h, Math.min(10 * scale, h * 0.2))
      return
    }
    case 'fn': {
      // 有棱有角的直角块——区别于原语系的圆角/胶囊/六边形族
      ctx.rect(x, y, w, h)
      return
    }
  }
}

export function cylinderRy(h: number, scale = 1): number {
  return Math.min(9 * scale, h * 0.16)
}

/** 形状细节线（轮廓 fill/stroke 之后再画）：tool 双内竖线、cylinder 顶部椭圆。 */
export function traceShapeDetail(
  ctx: CanvasRenderingContext2D,
  kind: NodeShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
  scale = 1,
): boolean {
  ctx.beginPath()
  switch (kind) {
    case 'tool': {
      const inset = 7 * scale
      ctx.moveTo(x + inset, y + 1)
      ctx.lineTo(x + inset, y + h - 1)
      ctx.moveTo(x + w - inset, y + 1)
      ctx.lineTo(x + w - inset, y + h - 1)
      return true
    }
    case 'cylinder': {
      const ry = cylinderRy(h, scale)
      ctx.ellipse(x + w / 2, y + ry, w / 2, ry, 0, 0, Math.PI)
      return true
    }
    default:
      return false
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
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

export { nodeArchetype }
