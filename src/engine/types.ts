export interface SlotDef {
  name: string
  type: string
  label?: string
  /** 侧栏/文档展示：该输入或输出变量的用途（对标 IDE 悬停说明） */
  description?: string
  /** 未接线时不触发完整性校验 */
  optional?: boolean
}

export type WorkflowLibrary = 'WF'

export interface NodeDef {
  class_type: string
  category: string
  display_name: string
  description?: string
  /** 不在左栏组件库展示 */
  palette_hidden?: boolean
  /** REMOVE_NODE_DEF 建议批准后标记；executor 保留只读 */
  deprecated?: boolean
  /** 仅在某执行模式下展示 */
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

export interface NodeExecutionState {
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped'
  class_type: string
  started_at?: number
  duration_ms?: number
  output_keys?: string[]
  error?: string
  reason?: string
}

// ─── State Machine Execution ───────────────────────────────────────────

export interface ConditionalEdge {
  from: string
  to: string
  /** JS expression evaluated against node outputs; omit for unconditional */
  condition?: string
}

export interface StateMachineConfig {
  start: string
  edges: ConditionalEdge[]
  max_iterations?: number
}

// ─── Legacy Execution State ────────────────────────────────────────────

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
  /** LLM stream:true 执行中的实时 token（nodeId → 累积文本） */
  streaming?: Record<string, string>
  /** 每个节点的实时执行状态（用于可视化高亮） */
  node_states?: Record<string, NodeExecutionState>
}
