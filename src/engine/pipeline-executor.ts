/**
 * Agentic Pipeline 执行器 — 加载 internal_workflow 并按拓扑序跑完整子图
 */
import { registry } from './registry'
import { loadWorkflowByRef } from './workflow-loader'
import {
  executeGraph,
  injectPipelineInputs,
  collectPipelineOutputs,
} from './workflow-runner'
import type { NodeInstance } from './types'
import type { ExecutionResult } from './executor'

const PIPELINE_CLASS_TYPES = [  // 保留服务 B 范式管线（业务管线已按 ADR-011 D4 归档）
  'SelfHealUnit',
] as const

function mapExternalInputs(
  node: NodeInstance,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...inputs }

  for (const [slotName, val] of Object.entries(inputs)) {  // 遍历直至终止条件满足
    mapped[slotName] = val
  }

  if (mapped.brief === undefined && mapped.topic !== undefined) mapped.brief = mapped.topic  // 组件：条件分支
  if (mapped.brief === undefined && mapped.input !== undefined) mapped.brief = mapped.input  // 组件：条件分支
  if (mapped.keywords === undefined && typeof mapped.brief === 'string') {  // 组件：条件分支
    mapped.keywords = mapped.brief
  }

  return mapped
}

export async function executeInternalWorkflow(
  internalWorkflow: string,
  node: NodeInstance,
  inputs: Record<string, unknown>
): Promise<ExecutionResult> {
  const start = Date.now()  // start：本步业务中间量

  try {
    const graph = await loadWorkflowByRef(internalWorkflow)  // graph：本步业务中间量
    if (!graph) {  // 组件：条件分支
      throw new Error(`无法加载 internal_workflow: ${internalWorkflow}`)
    }
    injectPipelineInputs(graph, mapExternalInputs(node, inputs))

    if (typeof window === 'undefined') {
      for (const n of graph.nodes) {
        if (n.class_type === 'HumanApproval') {
          n.params.auto_approve = true
        }
      }
    }

    const { results, merged_output, unhealthy_nodes } = await executeGraph(graph, {
      role: 'master',
      agentId: `pipeline:${node.class_type}`,
    })

    const outputs = collectPipelineOutputs(graph, results)  // outputs：本步业务中间量
    if (merged_output !== undefined) outputs.merged_output = merged_output  // 组件：条件分支
    if (unhealthy_nodes.length) outputs.unhealthy_nodes = unhealthy_nodes  // 组件：条件分支

    const firstError = unhealthy_nodes[0]?.error  // firstError：本步业务中间量
    return {
      outputs,
      duration_ms: Date.now() - start,
      error: firstError,
    }
  } catch (err) {
    return {
      outputs: {},
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function registerPipelineExecutors(
  register: (classType: string, fn: import('./executor').ExecutorFn) => void
): void {
  for (const classType of PIPELINE_CLASS_TYPES) {  // 注册 internal_workflow 范式执行器
    register(classType, async (node, inputs) => {
      const def = registry.get(node.class_type)  // def：本步业务中间量
      const wf = def?.internal_workflow  // wf：本步业务中间量
      if (!wf) {  // 组件：条件分支
        return {
          outputs: {},
          duration_ms: 0,
          error: `${node.class_type} 缺少 internal_workflow 定义`,
        }
      }
      return executeInternalWorkflow(wf, node, inputs)
    })
  }

  register('AgentWorkflow', async (node, inputs) => {
    const wfId = String(node.params.workflow_id ?? node.params.workflow_name ?? '')  // 已注册工作流标识：优先 workflow_id，兼容填名称
    if (!wfId) {  // 组件：条件分支
      return { outputs: {}, duration_ms: 0, error: 'AgentWorkflow 缺少 workflow_id' }
    }
    const payload = inputs.input ?? inputs.pass_value  // 调用方传入的通用 input 桶
    if (payload === null || payload === undefined) {  // 空输入时跳过子工作流
      return {
        outputs: { skipped: true, reason: 'empty input blocked sub-workflow' },
        duration_ms: 0,
      }
    }
    const slug = wfId.replace(/\.json$/, '')  // 去掉 .json 后缀得到 workflows/ 下的 slug
    return executeInternalWorkflow(slug, node, inputs)
  })
}
