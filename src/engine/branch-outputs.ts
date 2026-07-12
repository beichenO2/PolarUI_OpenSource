/**
 * 多路分支（Condition / Switch）可变出口 SSOT — 画布槽位、几何、编译、执行共用。
 */
import type { NodeDef, NodeInstance } from './types'
import { simpleShapeHeight, NODE_DEFAULT_WIDTH } from './node-geometry'

export const MIN_ROUTING_BRANCHES = 2
export const MAX_ROUTING_BRANCHES = 12

export interface SwitchCaseDef {
  label?: string
  when?: string
  match?: string
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

export function isRoutingBranchNode(classType: string): boolean {
  return classType === 'Switch' || classType === 'Condition'
}

export function parseSwitchCases(node: NodeInstance): SwitchCaseDef[] {
  try {
    const raw = node.params?.cases
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed) && parsed.length >= MIN_ROUTING_BRANCHES) {
      return parsed.map((c, i) => {
        if (c && typeof c === 'object') return c as SwitchCaseDef
        return { label: String(c ?? `情况${i + 1}`) }
      })
    }
  } catch {
    /* fall through */
  }
  return [
    { label: '情况1', when: '' },
    { label: '情况2', when: '' },
  ]
}

export function conditionBranchCount(node: NodeInstance): number {
  const n = Number(node.params?.branch_count ?? 2)
  return clampInt(n, MIN_ROUTING_BRANCHES, MAX_ROUTING_BRANCHES)
}

/** 含 default 出口的总出口数 */
export function routingOutletCount(node: NodeInstance, def?: NodeDef | null): number {
  if (node.class_type === 'Switch') {
    return parseSwitchCases(node).length + 1
  }
  if (node.class_type === 'Condition') {
    return conditionBranchCount(node)
  }
  return def?.outputs.length ?? 0
}

export function routingOutletName(node: NodeInstance, slot: number): string {
  if (node.class_type === 'Switch') {
    const cases = parseSwitchCases(node)
    if (slot < cases.length) {
      const label = cases[slot]?.label ?? cases[slot]?.when
      return label ? String(label) : `case_${slot}`
    }
    if (slot === cases.length) return 'default'
    return `case_${slot}`
  }
  if (node.class_type === 'Condition') {
    const n = conditionBranchCount(node)
    if (n === 2 && slot === 0) return 'true_branch'
    if (n === 2 && slot === 1) return 'false_branch'
    return `branch_${slot}`
  }
  return `#${slot}`
}

export function syncRoutingNodeGeometry(node: NodeInstance, def?: NodeDef | null): void {
  if (!isRoutingBranchNode(node.class_type)) return
  const d = def ?? null
  const inCount = d?.inputs.length ?? 1
  const outCount = routingOutletCount(node, d)
  node.width = NODE_DEFAULT_WIDTH
  // 路由分支组件（Switch/Condition）是简单六边形 — 高度随出口数
  node.height = simpleShapeHeight(Math.max(inCount, outCount, 1))
}

export function normalizeRoutingBranchParams(node: NodeInstance): void {
  if (node.class_type === 'Switch') {
    const cases = parseSwitchCases(node)
    node.params.cases = JSON.stringify(cases, null, 0)
  }
  if (node.class_type === 'Condition') {
    node.params.branch_count = conditionBranchCount(node)
  }
}
