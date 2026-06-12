/** NDJSON chat stream events — 对齐 claude-stream 块类型 */

export type ChatStreamEvent =
  | { type: 'step_start'; node_id: string; class_type: string; attempt?: number }
  | { type: 'text_delta'; delta: string; node_id?: string }
  | { type: 'tool_use'; name: string; input?: unknown; node_id?: string }
  | { type: 'tool_result'; content: string; is_error?: boolean; node_id?: string }
  | { type: 'step_done'; node_id: string; class_type: string; duration_ms?: number; error?: string }
  | { type: 'data_flow'; from_node: string; to_node: string; from_class: string; to_class: string; slot: number; preview: string }
  | { type: 'node_output'; node_id: string; class_type: string; outputs: Record<string, string> }
  | { type: 'final'; content: string | null; status: string; unhealthy_nodes?: unknown[]; conversation_id?: string; workflow_id?: string }
  | { type: 'error'; message: string }

const TOOL_NODES = new Set([
  'FileRead', 'FileWrite', 'ShellExec', 'GlobSearch', 'GrepSearch', 'GitCommit',
  'BrowserAction', 'MCPCall', 'CodeExec', 'SSoTQuery', 'WebSearch', 'ToolCall',
  'HubFileRead', 'HubFileWrite', 'HubShellExec',
])

export function emitStreamLine(ev: ChatStreamEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n')
}

export function toolEventFromNode(classType: string, outputs: Record<string, unknown>, error?: string): ChatStreamEvent[] {
  const lines: ChatStreamEvent[] = []
  if (!TOOL_NODES.has(classType) && classType !== 'LLM') return lines
  if (classType === 'LLM') return lines
  lines.push({ type: 'tool_use', name: classType, input: outputs })
  const preview = error
    ? error
    : JSON.stringify(outputs).slice(0, 400)
  lines.push({ type: 'tool_result', content: preview, is_error: Boolean(error) })
  return lines
}
