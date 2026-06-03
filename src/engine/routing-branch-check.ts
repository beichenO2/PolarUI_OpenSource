/**
 * 多路路由节点：至少须有两种可走分支（不必全部输出都接线）。
 */
import type { Graph } from './graph'
import type { NodeInstance } from './types'
import { registry } from './registry'
import {
  MIN_ROUTING_BRANCHES,
  conditionBranchCount,
  parseSwitchCases,
  routingOutletCount,
} from './branch-outputs'

export interface BranchCheckIssue {
  nodeId: string
  classType: string
  label: string
  connectedBranches: number
  requiredBranches: number
}

const MIN_BRANCH_RULES: Record<string, number> = {
  Switch: MIN_ROUTING_BRANCHES,
  Condition: MIN_ROUTING_BRANCHES,
}

function nodeLabel(node: NodeInstance): string {
  const def = registry.get(node.class_type)
  return def?.display_name || node.class_type
}

/** 数据流连线槽位 + 可选 _lg_edges 条件出口（与 library 标签无关） */
function countDistinctOutgoingBranches(graph: Graph, nodeId: string): number {
  const keys = new Set<string | number>()
  for (const link of graph.links) {
    if (link.from_node === nodeId) keys.add(link.from_slot)
  }
  if (graph.lgEdges?.length) {
    for (const edge of graph.lgEdges) {
      if (edge.from !== nodeId) continue
      const key = edge.when != null && String(edge.when).trim() !== ''
        ? String(edge.when)
        : edge.to
      keys.add(key)
    }
  }
  return keys.size
}

function switchCaseCount(node: NodeInstance): number {
  return parseSwitchCases(node).length
}

export function validateRoutingBranches(graph: Graph): {
  errors: string[]
  issues: BranchCheckIssue[]
} {
  const errors: string[] = []
  const issues: BranchCheckIssue[] = []

  for (const node of graph.nodes) {
    const minBranches = MIN_BRANCH_RULES[node.class_type]
    if (!minBranches) continue

    const label = nodeLabel(node)
    const connected = countDistinctOutgoingBranches(graph, node.id)

    if (node.class_type === 'Switch') {
      const caseCount = switchCaseCount(node)
      if (caseCount < minBranches) {
        errors.push(
          `组件 "${node.id}" (${label}): Case 列表须至少 ${minBranches} 项，当前 ${caseCount} 项`,
        )
        issues.push({
          nodeId: node.id,
          classType: node.class_type,
          label,
          connectedBranches: caseCount,
          requiredBranches: minBranches,
        })
      }
      const requiredOutlets = routingOutletCount(node)
      if (connected < Math.min(requiredOutlets, minBranches)) {
        errors.push(
          `组件 "${node.id}" (${label}): 多路分支须至少接出 ${minBranches} 条不同出口连线，当前 ${connected} 条`,
        )
        issues.push({
          nodeId: node.id,
          classType: node.class_type,
          label,
          connectedBranches: connected,
          requiredBranches: minBranches,
        })
        continue
      }
      continue
    }

    if (node.class_type === 'Condition') {
      const required = conditionBranchCount(node)
      if (required < minBranches) {
        errors.push(
          `组件 "${node.id}" (${label}): 分支数须 ≥ ${minBranches}，当前 ${required}`,
        )
      }
    }

    if (connected < minBranches) {
      errors.push(
        `组件 "${node.id}" (${label}): 多路分支须至少接出 ${minBranches} 条不同出口连线，当前 ${connected} 条`,
      )
      issues.push({
        nodeId: node.id,
        classType: node.class_type,
        label,
        connectedBranches: connected,
        requiredBranches: minBranches,
      })
    }
  }

  return { errors, issues }
}
