/**
 * Execution / LG step → Claude Code CLI 风格 terminal 行
 * 对齐 PolarClaw/reference/open-design/.../claude-stream.ts 块类型语义
 */
import type { ExecutionState } from './types'

export type TerminalLineKind =
  | 'status'
  | 'step_start'
  | 'step_done'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'

export interface TerminalLine {
  kind: TerminalLineKind
  text: string
  timestamp?: number
}

export function formatNodeStepStart(nodeId: string, classType: string): TerminalLine {
  return {
    kind: 'step_start',
    text: `● ${classType} (${nodeId})`,
    timestamp: Date.now(),
  }
}

export function formatNodeStepDone(nodeId: string, classType: string, durationMs?: number): TerminalLine {
  const dur = durationMs != null ? ` · ${durationMs}ms` : ''
  return {
    kind: 'step_done',
    text: `✓ ${classType} (${nodeId})${dur}`,
    timestamp: Date.now(),
  }
}

export function formatToolUse(name: string, inputPreview?: string): TerminalLine {
  const args = inputPreview ? `(${inputPreview.slice(0, 120)}${inputPreview.length > 120 ? '…' : ''})` : '()'
  return { kind: 'tool_use', text: `● ${name}${args}`, timestamp: Date.now() }
}

export function formatToolResult(content: string, isError = false): TerminalLine {
  const prefix = isError ? '⎿ ✗ ' : '⎿ '
  return { kind: 'tool_result', text: `${prefix}${content.slice(0, 400)}`, timestamp: Date.now() }
}

export function formatTextDelta(chunk: string): TerminalLine {
  return { kind: 'text', text: chunk, timestamp: Date.now() }
}

export function formatExecutionError(message: string): TerminalLine {
  return { kind: 'error', text: message, timestamp: Date.now() }
}

/** 从 ExecutionState 快照生成 terminal 行（侧栏 / smoke 用） */
export function formatExecutionToTerminal(execution: ExecutionState): TerminalLine[] {
  const lines: TerminalLine[] = []

  if (execution.status === 'running' && execution.current_node) {
    lines.push(formatNodeStepStart(execution.current_node, 'running'))
  }

  if (execution.streaming) {
    for (const [nodeId, text] of Object.entries(execution.streaming)) {
      if (text) {
        lines.push(formatNodeStepStart(nodeId, 'LLM'))
        lines.push(formatTextDelta(text))
      }
    }
  }

  if (execution.results) {
    for (const [nodeId, result] of Object.entries(execution.results)) {
      const classType = result.outputs ? 'Node' : nodeId
      if (result.error) {
        lines.push(formatExecutionError(`${nodeId}: ${result.error}`))
      } else if (result.outputs) {
        lines.push(formatNodeStepDone(nodeId, classType, result.duration_ms))
        const preview = JSON.stringify(result.outputs).slice(0, 200)
        if (preview.length > 2) lines.push(formatToolResult(preview))
      }
    }
  }

  if (execution.lg_run?.steps?.length) {
    for (const step of execution.lg_run.steps) {
      lines.push(formatNodeStepStart(step.node_id, step.class_type))
      if (step.routing) lines.push(formatTextDelta(`routing: ${step.routing}`))
    }
  }

  if (execution.error) {
    lines.push(formatExecutionError(execution.error))
  }

  if (execution.merged_output != null && execution.status === 'completed') {
    const out = String(execution.merged_output)
    if (out) lines.push(formatTextDelta(out.slice(0, 500)))
  }

  return lines
}

/** mock run 探针 — gate smoke 用 */
export function mockRunTraceLines(): TerminalLine[] {
  return [
    formatNodeStepStart('n1', 'PromptInput'),
    formatToolUse('FileRead', 'path=package.json'),
    formatToolResult('{"name":"polar-ui"}'),
    formatTextDelta('workflow smoke OK'),
  ]
}
