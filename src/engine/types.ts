export interface SlotDef {
  name: string
  type: string
  label?: string
  /** 侧栏/文档展示：该输入或输出变量的用途（对标 IDE 悬停说明） */
  description?: string
  /** 未接线时不触发完整性校验 */
  optional?: boolean
}

export type WorkflowLibrary = 'WF' | 'LG'

export interface NodeDef {
  class_type: string
  category: string
  display_name: string
  description?: string
  /** 不在左栏组件库展示（如 LG 运行时原语） */
  palette_hidden?: boolean
  /** REMOVE_NODE_DEF 建议批准后标记；executor 保留只读 */
  deprecated?: boolean
  /** 仅在某执行模式下展示（如 WF 培养皿 / LG 全能细胞） */
  execution_mode?: WorkflowLibrary
  inputs: SlotDef[]
  outputs: SlotDef[]
  params?: Record<string, ParamDef>
  color?: string
  /** Agentic 复合组件：双击/⤢ 可展开为内部工作流子图 */
  expandable?: boolean
  /** workflows/{name}.json，不含扩展名 */
  internal_workflow?: string
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'select' | 'text'
  default?: unknown
  options?: string[]
  label?: string
}

export interface NodeInstance {
  id: string
  class_type: string
  x: number
  y: number
  width: number
  height: number
  params: Record<string, unknown>
  collapsed?: boolean
}

export interface Link {
  id: string
  from_node: string
  from_slot: number
  to_node: string
  to_slot: number
}

export interface Workflow {
  id: string
  name: string
  nodes: NodeInstance[]
  links: Link[]
  created_at: number
  updated_at: number
}

export interface ExecutionState {
  status: 'idle' | 'running' | 'completed' | 'error'
  current_node?: string
  progress?: number
  error?: string
  results?: Record<string, { outputs?: Record<string, unknown>; error?: string; duration_ms?: number }>
  unhealthy_nodes?: { node_id: string; class_type: string; error: string }[]
  merged_output?: unknown
  /** 最近一次执行完成时间（结果保留在 results / merged_output） */
  last_run_at?: number
  /** History 落盘路径（run-trace-bridge 写入后） */
  last_log_path?: string
  /** LG Run 物化图路径（runs/{id}/run.json） */
  last_run_path?: string
  /** LG 执行步序（Canvas onLGStep） */
  lg_step?: number
  /** LLM stream:true 执行中的实时 token（nodeId → 累积文本） */
  streaming?: Record<string, string>
  /** LG Run 回放数据 */
  lg_run?: {
    steps: Array<{ index: number; node_id: string; class_type: string; routing?: string }>
    materialized_graph: { nodes: string[]; links: Array<{ from: string; to: string; when?: string; step?: number }> }
    differentiation_traces?: Array<{ from_node: string; to_node: string }>
  }
}
