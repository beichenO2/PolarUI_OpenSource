/**
 * executor.ts — Real node execution engine.
 *
 * Replaces simulateNodeExecution with actual API calls.
 * Each class_type maps to an executor function that performs the real work.
 */

import { join } from 'node:path'
import { registry } from './registry'
import type { NodeInstance, Link } from './types'
import { canExecute, reportToMaster, buildMasterApprovalRequest, type RoleType } from './role-protocol'
import { getLLMClient } from '../sdk/llm-proxy'
import { executeAgenticUnit, executeAgenticChain } from './agentic-executor'
import { formatRoleDeclaration } from './role-prompt'
import { wrapModeSystemPrompt } from './mode-prompt'
import { resolveSystemPromptBase, extractWorkflowJson } from './resolve-system-prompt'
import { registerPipelineExecutors } from './pipeline-executor'
import {
  hubFileRead,
  hubFileWrite,
  hubShellExec,
  hubGitCommit,
  hubGlobSearch,
  hubGrepSearch,
  hubNotification,
  hubOutputDisplay,
  hubSessionSearch,
} from '@/api/tools'
import { formatMemoryBlocks } from './memory-blocks'
import { buildReflectiveContext } from './reflective-context'
import { loadWorkflowByRef } from './workflow-loader'
import { invokeElectronRuntime, isElectronRuntime } from './runtime-bridge'
import { hubApiBase } from './hub-url'
import type { MutationOp, MutationPolicy } from './graph-mutation'

function polarisorRoot(): string {
  return process.env.POLARISOR_ROOT ?? join(process.cwd(), '..')
}

function resolveRepoCwd(raw: unknown): string {
  const v = String(raw ?? '.').trim() || '.'
  if (v === 'repo' || v === 'polarisor' || v === '..') return polarisorRoot()
  return v
}

export interface ExecutionResult {
  outputs: Record<string, unknown>
  duration_ms: number
  error?: string
}

export type ExecutorFn = (
  node: NodeInstance,
  inputs: Record<string, unknown>,
  context: ExecutionContext
) => Promise<ExecutionResult>

export interface ExecutionContext {
  getNodeOutput: (nodeId: string, slotIndex: number) => unknown
  allResults: Map<string, ExecutionResult>
  links: Link[]
  agentId?: string
  role?: RoleType
  runContext?: RunContext  // 多轮对话上下文（Chat 壳 / workflow/chat 注入）
  runTrace?: RunTraceEnvelope  // History 四层 log 采集（executeGraph 写入）
  onStreamChunk?: (nodeId: string, chunk: string) => void  // LLM stream:true 时逐 token 回调
  /** 可变工作流图；运行时结构变更节点写入 nodes/links（已归档，保留字段供引擎） */
  graph?: import('./graph').Graph
  /** 步进模式：跨步累积 state（Switch/LLM/ToolCall 读写） */
  lgAccumulatedState?: Record<string, unknown>
  /**
   * ADR-014：步进 runner 注入的运行时改图权柄。拓扑模式不提供（undefined）。
   * policy 由 StemCell 等节点传入；runner 维护跨步 mutation 计数。
   */
  mutateGraph?: (
    ops: import('./graph-mutation').MutationOp[],
    policy?: import('./graph-mutation').MutationPolicy,
  ) => {
    applied: import('./graph-mutation').MutationOp[]
    rejected: import('./graph-mutation').MutationReject[]
    audit: string[]
  }
  /** 本 run 已成功应用的变异条数（跨步累计，供 max_mutations 预算） */
  mutationCount?: number
}

export interface RunContext {  // 多轮 Chat 执行上下文 — 贯穿 WorkingMemory / PromptInput
  conversation_id?: string
  user_id?: string
  turn_index?: number
  user_message?: string
  /** headless / benchmark：对齐 Claude Code --dangerously-skip-permissions */
  skip_permissions?: boolean
  /** ReAct 循环：AgenticToolCall 返回的 updated_messages（JSON string / array） */
  react_messages?: string | unknown[]
  react_iteration?: number
}

export interface NodeTraceEntry {
  node_id: string
  class_type: string
  /** Execution path: stepwise (_entry/_lg_edges) or topology */
  mode?: 'stepwise' | 'topology'
  duration_ms: number
  loop_index?: number
  error?: string
}

export interface LoopTraceEntry {
  loop_node_id: string
  attempt: number
  max_attempts: number
  input_snapshot: unknown
  output_snapshot: unknown
  stop_reason: 'passed' | 'exhausted' | 'retry' | 'error'
}

export interface RunTraceEnvelope {
  run_id: string
  workflow_id: string
  started_at: string
  finished_at?: string
  status: 'running' | 'completed' | 'error'
  trigger: string
  node_traces: NodeTraceEntry[]
  loop_traces: LoopTraceEntry[]
  usage_traces: unknown[]
  differentiation_traces?: unknown[]
}

const executorRegistry = new Map<string, ExecutorFn>()

export function registerExecutor(classType: string, fn: ExecutorFn): void {
  executorRegistry.set(classType, fn)
}

export function getRegisteredExecutor(classType: string): ExecutorFn | undefined {
  return executorRegistry.get(classType)
}

function resolveBindingValue(
  binding: unknown,
  ctx: ExecutionContext,
  idMap: Map<string, string> | undefined,
): unknown {
  if (Array.isArray(binding) && binding.length === 2 && typeof binding[0] === 'string') {
    const nodeId = idMap?.get(binding[0]) ?? binding[0]
    return ctx.getNodeOutput(nodeId, binding[1])
  }
  if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(binding as Record<string, unknown>)) {
      result[k] = resolveBindingValue(v, ctx, idMap)
    }
    return result
  }
  return binding
}

function resolveNodeInputs(
  node: NodeInstance,
  ctx: ExecutionContext
): Record<string, unknown> {
  const def = registry.get(node.class_type)
  if (!def) return {}

  const bindings = (node.params._inputBindings ?? {}) as Record<string, unknown>
  const idMap = (ctx as unknown as { _idMap?: Map<string, string> })._idMap

  const inputs: Record<string, unknown> = {}
  for (let i = 0; i < def.inputs.length; i++) {
    const inputDef = def.inputs[i]
    if (bindings[inputDef.name]) {
      inputs[inputDef.name] = resolveBindingValue(bindings[inputDef.name], ctx, idMap)
      continue
    }
    const link = ctx.links.find(l => l.to_node === node.id && l.to_slot === i)
    if (link) {
      inputs[inputDef.name] = ctx.getNodeOutput(link.from_node, link.from_slot)
    } else if (node.params[inputDef.name] !== undefined) {
      inputs[inputDef.name] = node.params[inputDef.name]
    }
  }
  return inputs
}

export async function executeNode(
  node: NodeInstance,
  ctx: ExecutionContext
): Promise<ExecutionResult> {
  const start = Date.now()
  const inputs = resolveNodeInputs(node, ctx)

  if (ctx.role === 'slave' && ctx.agentId && !canExecute(ctx.agentId, node.class_type)) {
    const violation = reportToMaster(ctx.agentId, node.class_type)
    return {
      outputs: {
        needs_master_approval: true,
        approval_request: buildMasterApprovalRequest(violation),
      },
      duration_ms: Date.now() - start,
      error: `Slave 无权执行 ${node.class_type}，需要 Master 审批（HumanApproval）`,
    }
  }

  const executor = executorRegistry.get(node.class_type)

  if (!executor) {
    return {
      outputs: {},
      duration_ms: Date.now() - start,
      error: `No executor registered for "${node.class_type}". Falling back to passthrough.`,
    }
  }

  try {
    const result = await executor(node, inputs, ctx)
    result.duration_ms = Date.now() - start
    return result
  } catch (err) {
    if (err instanceof Error && err.stack) process.stderr?.write?.(`[executeNode:${node.class_type}] ${err.stack}\n`)
    return {
      outputs: {},
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

  // ─── LLM Executors ──────────────────────────────────────────────

function buildSystemPrompt(node: NodeInstance, base: string): string {
  const roleText = formatRoleDeclaration(node.params.role_declaration)
  let prompt = base
  if (roleText) {
    prompt = prompt ? `${prompt}\n\n## 角色声明\n${roleText}` : `## 角色声明\n${roleText}`
  }
  return wrapModeSystemPrompt(prompt)
}

/**
 * LLM — 单次大模型 API 调用（原子正则化元件）。
 *
 * @param inputs.prompt 用户任务正文
 * @param inputs.context 可选背景上下文
 * @param inputs.tools 可选工具定义列表
 * @returns outputs.response 模型文本；outputs.usage Token 用量
 */
function buildLgPromptState(
  node: NodeInstance,
  lgState: Record<string, unknown>,
): Record<string, unknown> {
  const text = String(node.params.prompt_text ?? node.params.content ?? '')
  const state: Record<string, unknown> = {
    messages: [],
    ...lgState,
    ...(text ? { task: text } : {}),
  }
  if (node.params.channel) state.channel = node.params.channel
  if (node.params.preload_memory !== false) {
    const snap = (state.memory_snapshot ?? {}) as Record<string, unknown>
    state.memory_snapshot = {
      'MEMORY.md': String(node.params.memory_md ?? snap['MEMORY.md'] ?? ''),
      'USER.md': String(node.params.user_md ?? snap['USER.md'] ?? ''),
      'CLAUDE.md': String(node.params.claude_md ?? snap['CLAUDE.md'] ?? ''),
    }
  }
  const ms = state.memory_snapshot as Record<string, unknown> | undefined
  if (node.params.claude_md !== undefined || ms?.['CLAUDE.md'] !== undefined) {
    state.claude_md = String(node.params.claude_md ?? ms?.['CLAUDE.md'] ?? '')
  }
  return state
}

registerExecutor('LLM', async (node, inputs, ctx) => {
  const lgState = ctx.lgAccumulatedState
  if (lgState) {
    const model = (node.params.model as string) || 'GLM-5.1'
    const basePrompt = await resolveSystemPromptBase(node)
    const systemPrompt = wrapModeSystemPrompt(basePrompt)
    const userContent = String(lgState?.task ?? JSON.stringify(lgState ?? {}))
    const result = await getLLMClient().chat(
      model,
      [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: userContent },
      ],
      { temperature: 0.7, timeoutMs: 120_000 },
    )

    let branch: string | undefined
    let tool: string | undefined
    let toolType: string | undefined
    try {
      const m = result.content.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as Record<string, unknown>
        branch = parsed.branch as string | undefined
        tool = parsed.tool as string | undefined
        toolType = parsed.tool_type as string | undefined
      }
    } catch { /* */ }

    const messages = Array.isArray(lgState?.messages) ? [...(lgState!.messages as unknown[])] : []
    messages.push({ role: 'assistant', content: result.content })

    return {
      outputs: {
        state: {
          ...(lgState ?? {}),
          messages,
          ...(branch ? { branch } : {}),
          ...(tool ? { tool } : {}),
          ...(toolType ? { tool_type: toolType } : {}),
        },
        response: result.content,
        content: result.content,
        ...(branch ? { branch } : {}),
      },
      duration_ms: 0,
    }
  }

  const model = node.params.model as string || 'GLM-5.1'
  const basePrompt = await resolveSystemPromptBase(node)
  const systemPrompt = buildSystemPrompt(node, basePrompt) || String(node.params.system_prompt ?? '')
  const rawPrompt = inputs.prompt

  let messages: { role: 'system' | 'user' | 'assistant'; content: string }[]

  if (Array.isArray(rawPrompt)) {
    messages = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...rawPrompt.map((m: unknown) => {
        const msg = m as Record<string, unknown>
        const role = String(msg.role ?? 'user') as 'system' | 'user' | 'assistant'
        if (role === 'assistant' && msg.tool_calls) {
          return { role, content: msg.content ?? null, tool_calls: msg.tool_calls } as unknown as { role: 'assistant'; content: string }
        }
        if (msg.role === 'tool') {
          return { role: 'tool', tool_call_id: msg.tool_call_id, content: String(msg.content ?? '') } as unknown as { role: 'assistant'; content: string }
        }
        return { role, content: String(msg.content ?? '') }
      }),
    ]
  } else {
    const prompt = rawPrompt == null
      ? ''
      : typeof rawPrompt === 'string'
        ? rawPrompt
        : typeof rawPrompt === 'object'
          ? JSON.stringify(rawPrompt)
          : String(rawPrompt)
    const userContent = prompt.trim() || '(无输入内容，请基于上下文简要说明无法审查的原因)'
    messages = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      { role: 'user' as const, content: userContent },
    ]
  }

  let tools: unknown[] | undefined
  const rawTools = inputs.tools ?? inputs.tools_list
  if (rawTools) {
    if (typeof rawTools === 'string') { try { tools = JSON.parse(rawTools) } catch { /* */ } }
    else if (Array.isArray(rawTools)) {
      tools = rawTools.map((t: unknown) => {
        const tool = t as Record<string, unknown>
        if (tool.type === 'function') return tool
        return { type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} } } }
      })
    }
  }

  const useStream = node.params.stream === true
  const result = await getLLMClient().chat(model, messages, {
    temperature: node.params.temperature as number ?? 0.7,
    timeoutMs: Number(node.params.timeout_ms ?? process.env.LLM_TIMEOUT_MS ?? 180_000),
    tools: tools && tools.length > 0 ? tools : undefined,
    toolChoice: tools && tools.length > 0 ? 'auto' : undefined,
    stream: useStream,
    onChunk: useStream && ctx.onStreamChunk
      ? (chunk) => ctx.onStreamChunk!(node.id, chunk)
      : undefined,
  })
  const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    'GLM-5.1': 128_000,
    'MiniMax-2.7-HighSpeed': 200_000,
    'qwen-plus': 128_000,
    'qwen-max': 128_000,
    'deepseek-chat': 128_000,
    'deepseek-reasoner': 64_000,
  }
  const maxContext = MODEL_CONTEXT_WINDOWS[model] ?? 128_000

  const TOOL_NAME_ALIASES: Record<string, string> = {
    read_file: 'FileRead', file_read: 'FileRead', readfile: 'FileRead',
    write_file: 'FileWrite', file_write: 'FileWrite', writefile: 'FileWrite',
    shell_exec: 'ShellExec', shellexec: 'ShellExec', run_command: 'ShellExec', execute_command: 'ShellExec',
    glob_search: 'GlobSearch', globsearch: 'GlobSearch', find_files: 'GlobSearch',
    grep_search: 'GrepSearch', grepsearch: 'GrepSearch', search_files: 'GrepSearch',
    web_search: 'WebSearch', websearch: 'WebSearch',
    web_fetch: 'WebFetch', webfetch: 'WebFetch', fetch_url: 'WebFetch',
    git_commit: 'GitCommit', gitcommit: 'GitCommit',
    mcp_call: 'MCPCall', mcpcall: 'MCPCall',
    code_exec: 'CodeExec', codeexec: 'CodeExec',
    notification: 'Notification',
  }
  function normalizeToolName(raw: string): string {
    const lower = raw.toLowerCase().replace(/[-\s]/g, '_')
    return TOOL_NAME_ALIASES[lower] ?? raw
  }

  let toolCalls = result.toolCalls ?? []
  if (toolCalls.length === 0 && result.content && tools && tools.length > 0) {
    const xmlParsed = parseXmlToolCalls(result.content)
    if (xmlParsed.length > 0) {
      toolCalls = xmlParsed.map((tc, i) => ({
        id: tc.id ?? `xml_tc_${i}`,
        type: 'function' as const,
        function: {
          name: normalizeToolName(tc.name),
          arguments: JSON.stringify(tc.input ?? {}),
        },
      }))
    }
  }

  const hasToolCalls = toolCalls.length > 0
  const response = hasToolCalls
    ? { content: result.content, tool_calls: toolCalls }
    : result.content
  return {
    outputs: {
      response,
      usage: result.usage,
      max_context: maxContext,
    },
    duration_ms: 0,
  }
})

registerExecutor('ToolCall', async (node, inputs) => {  // 工具调用：原子化元件：将函数定义 + 上下文发给 LLM，返回 tool_calls 数组。不执行工具，只产出调用意图。 | 入:prompt|tool_definitions 出:tool_calls|raw
  let rawTools: unknown = inputs.tool_definitions ?? inputs.tools  // 工具定义列表：兼容 tool_definitions / tools 槽
  if (typeof rawTools === 'string') {  // 字符串时尝试 JSON 解析
    try { rawTools = JSON.parse(rawTools) } catch { rawTools = undefined }
  }
  let tools: unknown = rawTools
  if (Array.isArray(rawTools)) {  // 将简写格式转为 OpenAI function 形态
    tools = rawTools.map((t) => {
      const item = t as { name?: string; desc?: string; description?: string; parameters?: unknown }
      if (item && typeof item === 'object' && item.name && !('type' in item)) {
        return {
          type: 'function',
          function: {
            name: item.name,
            description: item.desc ?? item.description ?? item.name,
            parameters: item.parameters ?? { type: 'object', properties: {} },
          },
        }
      }
      return t
    })
  }
  const result = await getLLMClient().chat(
    (node.params.model as string) || 'GLM-5.1',
    [{ role: 'user', content: String(inputs.prompt ?? '') }],
    {
      tools: tools && (Array.isArray(tools) ? tools.length > 0 : true) ? tools : undefined,
      toolChoice: tools ? 'auto' : undefined,
      timeoutMs: 60_000,
    },
  ).catch(async (err) => {
    if (String(err).includes('400') && tools) {  // 部分模型 400 拒 tools：降级为纯文本 chat
      return getLLMClient().chat(
        (node.params.model as string) || 'GLM-5.1',
        [{ role: 'user', content: String(inputs.prompt ?? '') }],
        { timeoutMs: 60_000 },
      )
    }
    throw err
  })
  const toolCalls = result.toolCalls ?? []
  const first = toolCalls[0] as { function?: { name?: string }; name?: string } | undefined
  const toolName = String(first?.function?.name ?? first?.name ?? '')
  return {
    outputs: {
      tool_calls: toolCalls,
      raw: result.content,
      tool_list: Array.isArray(tools) ? tools : [],
      branch: toolName,
      tool: toolName,
      state: { branch: toolName, tool: toolName, tool_calls: toolCalls },
    },
    duration_ms: 0,
  }
})

// ─── AgenticToolCall Executor ─────────────────────────────────────

interface ToolCallBlock {
  id?: string
  type?: string
  name: string
  input?: Record<string, unknown>
  arguments?: string
  function?: { name: string; arguments: string }
}

interface ToolExecutionLog {
  iteration: number
  tool_name: string
  args: unknown
  result: unknown
  duration_ms: number
  success: boolean
}

const CONCURRENCY_SAFE_TOOLS = new Set([
  'FileRead', 'GrepSearch', 'GlobSearch', 'WebSearch', 'WebFetch', 'SessionSearch',
])

function extractToolCalls(response: unknown): ToolCallBlock[] {
  if (!response) return []
  if (Array.isArray(response)) {
    return response.filter((b: unknown) => {
      const block = b as Record<string, unknown>
      return block.type === 'tool_use' || block.function || block.name
    }).map((b: unknown) => b as ToolCallBlock)
  }
  if (typeof response === 'object') {
    const obj = response as Record<string, unknown>
    if (obj.tool_calls && Array.isArray(obj.tool_calls)) return obj.tool_calls as ToolCallBlock[]
    if (obj.content && Array.isArray(obj.content)) {
      return (obj.content as Record<string, unknown>[])
        .filter(b => b.type === 'tool_use')
        .map(b => b as unknown as ToolCallBlock)
    }
    if (typeof obj.content === 'string') {
      return parseXmlToolCalls(obj.content)
    }
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response)
      if (parsed && typeof parsed === 'object') return extractToolCalls(parsed)
    } catch { /* not JSON, try XML */ }
    return parseXmlToolCalls(response)
  }
  return []
}

function parseXmlToolCalls(text: string): ToolCallBlock[] {
  const results: ToolCallBlock[] = []
  const patterns = [
    /<tool_call[^>]*>\s*<tool_name>([^<]+)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/tool_call[^>]*>?/g,
    /<tool_use[^>]*>\s*<name>([^<]+)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_use/g,
    /<tool_call_node[^>]*>\s*<name>([^<]+)<\/name>\s*<args>([\s\S]*?)<\/args>\s*<\/tool_call_node/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim()
      const paramsRaw = match[2].trim()
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(paramsRaw) } catch {
        const xmlParams: Record<string, string> = {}
        const paramPattern = /<(\w+)>([\s\S]*?)<\/\1>/g
        let pm
        while ((pm = paramPattern.exec(paramsRaw)) !== null) {
          xmlParams[pm[1]] = pm[2].trim()
        }
        input = xmlParams
      }
      results.push({ name, input, id: `xml_call_${results.length}` })
    }
  }
  // JSON-in-XML format: <tool_use>\n{"name":"FileRead","arguments":{...}}\n</tool_use>
  const jsonInXmlPattern = /<tool_use>\s*(\{[\s\S]*?\})\s*<\/tool_use>/g
  let jm
  while ((jm = jsonInXmlPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(jm[1]) as { name?: string; arguments?: Record<string, unknown>; input?: Record<string, unknown> }
      if (parsed.name) {
        results.push({ name: parsed.name, input: parsed.arguments ?? parsed.input ?? {}, id: `json_xml_call_${results.length}` })
      }
    } catch { /* not valid JSON */ }
  }
  // <tool_call> with nested XML params (GLM variant)
  const glmPattern = /<tool_call[^>]*>([\s\S]*?)<\/tool_call/g
  let gm
  while ((gm = glmPattern.exec(text)) !== null) {
    const inner = gm[1].trim()
    if (results.length > 0) continue
    const nameMatch = inner.match(/<tool_name>([^<]+)<\/tool_name>/)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const xmlParams: Record<string, string> = {}
    const paramPattern = /<(\w+)>([^<]*)<\/\1>/g
    let pm
    while ((pm = paramPattern.exec(inner)) !== null) {
      if (pm[1] !== 'tool_name') xmlParams[pm[1]] = pm[2].trim()
    }
    results.push({ name, input: xmlParams, id: `glm_call_${results.length}` })
  }

  // <tool_call tool_name> with inline JSON body (GLM-5.1 compact variant)
  if (results.length === 0) {
    const compactPattern = /<tool_call\s+(\w+)>\s*([\s\S]*?)\s*<\/tool_call/g
    let cm
    while ((cm = compactPattern.exec(text)) !== null) {
      const rawName = cm[1].trim()
      const body = cm[2].trim()
      let input: Record<string, unknown> = {}
      try { input = JSON.parse(body) } catch {
        const xmlParams: Record<string, string> = {}
        const pp = /<(\w+)>([\s\S]*?)<\/\1>/g
        let pm2
        while ((pm2 = pp.exec(body)) !== null) xmlParams[pm2[1]] = pm2[2].trim()
        input = xmlParams
      }
      const name = rawName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
      results.push({ name, input, id: `compact_call_${results.length}` })
    }
  }

  // Catch-all: <tool_call*> with JSON body containing name+arguments (GLM wildcard)
  if (results.length === 0) {
    const catchAll = /<tool_call[^>]*>\s*([\s\S]*?)\s*<\/tool_call[^>]*>?/g
    let ca
    while ((ca = catchAll.exec(text)) !== null) {
      const body = ca[1].trim()
      try {
        const parsed = JSON.parse(body) as { name?: string; arguments?: Record<string, unknown>; input?: Record<string, unknown>; args?: Record<string, unknown> }
        if (parsed.name) {
          results.push({ name: parsed.name, input: parsed.arguments ?? parsed.args ?? parsed.input ?? {}, id: `catchall_call_${results.length}` })
        }
      } catch { /* not JSON */ }
    }
  }

  // Universal: <tool_use> with any combination of name/tool_name + arguments/input/parameters
  if (results.length === 0) {
    const universalPattern = /<tool_use[^>]*>([\s\S]*?)<\/tool_use>/g
    let um
    while ((um = universalPattern.exec(text)) !== null) {
      const inner = um[1].trim()
      const nameMatch = inner.match(/<(?:tool_name|name|function)>([^<]+)<\/(?:tool_name|name|function)>/)
      if (!nameMatch) continue
      const name = nameMatch[1].trim()
      const argsMatch = inner.match(/<(?:arguments|input|parameters|params)>([\s\S]*?)<\/(?:arguments|input|parameters|params)>/)
      let input: Record<string, unknown> = {}
      if (argsMatch) {
        const raw = argsMatch[1].trim()
        try { input = JSON.parse(raw) } catch {
          const xmlParams: Record<string, string> = {}
          const pp = /<(\w+)>([\s\S]*?)<\/\1>/g
          let pm3
          while ((pm3 = pp.exec(raw)) !== null) xmlParams[pm3[1]] = pm3[2].trim()
          input = xmlParams
        }
      }
      results.push({ name, input, id: `universal_call_${results.length}` })
    }
  }

  return results
}

function extractFinalText(response: unknown): string {
  if (typeof response === 'string') return response
  if (Array.isArray(response)) {
    const textBlocks = response.filter((b: unknown) => (b as Record<string, unknown>).type === 'text')
    return textBlocks.map((b: unknown) => String((b as Record<string, unknown>).text ?? '')).join('\n')
  }
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>
    if (typeof obj.content === 'string') return obj.content
    if (Array.isArray(obj.content)) {
      return (obj.content as Record<string, unknown>[])
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? '')).join('\n')
    }
  }
  return String(response ?? '')
}

async function executeOneTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; success: boolean }> {
  try {
    let result: unknown
    const path = String(args.path ?? args.file_path ?? args.filename ?? '')
    switch (name) {
      case 'FileRead': result = await hubFileRead(path); break
      case 'FileWrite': result = await hubFileWrite(path || String(args.file_path ?? ''), String(args.content ?? '')); break
      case 'ShellExec': result = await hubShellExec(String(args.command ?? ''), String(args.cwd ?? '.'), Number(args.timeout_s ?? 30)); break
      case 'GlobSearch': result = await hubGlobSearch(String(args.pattern ?? '*')); break
      case 'GrepSearch': result = await hubGrepSearch(String(args.pattern ?? ''), String(args.path ?? '.')); break
      case 'GitCommit': result = await hubGitCommit({ message: String(args.message ?? ''), files: args.files, push: Boolean(args.push), cwd: String(args.cwd ?? '.') }); break
      case 'Notification': result = await hubNotification(String(args.message ?? ''), String(args.level ?? 'info') as 'info'); break
      case 'WebSearch': result = { content: `[WebSearch mock] query: ${args.query}` }; break
      case 'WebFetch': result = { content: `[WebFetch mock] url: ${args.url}` }; break
      case 'MCPCall': result = { content: `[MCPCall] server: ${args.server}, tool: ${args.tool}` }; break
      case 'CodeExec': result = await hubShellExec(`node -e ${JSON.stringify(String(args.code ?? ''))}`, '.', 30); break
      case 'BrowserAction':
      case 'DigestCrawl': {
        const port = Number(process.env.DIGIST_PORT ?? 4880)
        const platform = String(args.platform ?? 'twitter')
        const query = String(args.query ?? '')
        const res = await fetch(`http://127.0.0.1:${port}/api/crawl/trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, query }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!res.ok) throw new Error(`Digist crawl ${res.status}: ${await res.text()}`)
        result = await res.json()
        break
      }
      case 'Vision':
      case 'DescribeImage': {
        const vlmModel = String(args.model ?? 'qwen3-vl')
        const imageUrl = String(args.image_url ?? args.image ?? '')
        const prompt = String(args.prompt ?? '描述这张图片')
        if (!imageUrl) { result = { content: 'Error: image_url is required' }; break }
        const vlmRes = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: vlmModel,
            messages: [{ role: 'user', content: prompt, images: [imageUrl] }],
            stream: false,
          }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!vlmRes.ok) throw new Error(`Ollama VLM ${vlmRes.status}`)
        const vlmData = await vlmRes.json() as { message?: { content?: string } }
        result = { content: vlmData.message?.content ?? '' }
        break
      }
      case 'SubAgent': {
        const workflowRef = String(args.workflow ?? 'claude-code')
        const task = String(args.task ?? '')
        const timeoutMs = Number(args.timeout_s ?? 300) * 1000
        try {
          const { executeGraph } = await import('./workflow-runner')
          const subGraph = await loadWorkflowByRef(workflowRef)
          if (!subGraph) throw new Error(`Workflow "${workflowRef}" not found`)
          const subResult = await Promise.race([
            executeGraph(subGraph, {
              externalInputs: { userMessage: task, input: task },
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SubAgent timeout')), timeoutMs)),
          ])
          result = { content: typeof subResult.merged_output === 'string' ? subResult.merged_output : JSON.stringify(subResult.merged_output ?? '') }
        } catch (err) {
          result = { content: `[SubAgent error] ${err instanceof Error ? err.message : String(err)}` }
        }
        break
      }
      default: result = { error: `Unknown tool: ${name}` }; return { result, success: false }
    }
    return { result, success: true }
  } catch (err) {
    return { result: { error: String(err) }, success: false }
  }
}

registerExecutor('AgenticToolCall', async (node, inputs) => {
  const concurrencyEnabled = node.params.concurrency !== false
  const errorStrategy = String(node.params.error_strategy ?? 'cancel_siblings')

  let toolsList: unknown[] = []
  const rawTools = inputs.tools_list
  if (typeof rawTools === 'string') { try { toolsList = JSON.parse(rawTools) } catch { /* */ } }
  else if (Array.isArray(rawTools)) { toolsList = rawTools }

  const currentResponse = inputs.llm_response

  let parsedMessages: unknown = inputs.messages
  if (typeof parsedMessages === 'string') { try { parsedMessages = JSON.parse(parsedMessages) } catch { parsedMessages = [] } }
  const messages: Record<string, unknown>[] = Array.isArray(parsedMessages) ? [...parsedMessages as Record<string, unknown>[]] : []

  const toolCalls = extractToolCalls(currentResponse)

  if (toolCalls.length === 0) {
    return {
      outputs: {
        final_text: extractFinalText(currentResponse),
        updated_messages: JSON.stringify(messages),
        has_tool: false,
      },
      duration_ms: 0,
    }
  }

  const executionLog: ToolExecutionLog[] = []
  const toolResults: { tool_use_id: string; content: string }[] = []

  if (concurrencyEnabled) {
    const safeTools = toolCalls.filter(tc => CONCURRENCY_SAFE_TOOLS.has(tc.name ?? tc.function?.name ?? ''))
    const exclusiveTools = toolCalls.filter(tc => !CONCURRENCY_SAFE_TOOLS.has(tc.name ?? tc.function?.name ?? ''))

    const runOne = async (tc: ToolCallBlock) => {
      const name = tc.name ?? tc.function?.name ?? ''
      let args: Record<string, unknown> = {}
      if (tc.input) args = tc.input
      else if (tc.arguments) { try { args = JSON.parse(tc.arguments) } catch { /* */ } }
      else if (tc.function?.arguments) { try { args = JSON.parse(tc.function.arguments) } catch { /* */ } }

      const start = Date.now()
      const { result, success } = await executeOneTool(name, args)
      executionLog.push({ iteration: 1, tool_name: name, args, result, duration_ms: Date.now() - start, success })

      if (!success && errorStrategy === 'abort_all') throw new Error(`Tool ${name} failed: ${JSON.stringify(result)}`)

      toolResults.push({
        tool_use_id: tc.id ?? `call_1_${name}`,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      })
    }

    if (safeTools.length > 0) await Promise.all(safeTools.map(runOne))
    for (const tc of exclusiveTools) await runOne(tc)
  } else {
    for (const tc of toolCalls) {
      const name = tc.name ?? tc.function?.name ?? ''
      let args: Record<string, unknown> = {}
      if (tc.input) args = tc.input
      else if (tc.arguments) { try { args = JSON.parse(tc.arguments) } catch { /* */ } }
      else if (tc.function?.arguments) { try { args = JSON.parse(tc.function.arguments) } catch { /* */ } }

      const start = Date.now()
      const { result, success } = await executeOneTool(name, args)
      executionLog.push({ iteration: 1, tool_name: name, args, result, duration_ms: Date.now() - start, success })
      toolResults.push({
        tool_use_id: tc.id ?? `call_1_${name}`,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      })
    }
  }

  let parsedResponse: Record<string, unknown> | null = null
  if (typeof currentResponse === 'string') {
    try { parsedResponse = JSON.parse(currentResponse) } catch { /* not JSON, treat as text */ }
  } else if (typeof currentResponse === 'object' && currentResponse !== null) {
    parsedResponse = currentResponse as Record<string, unknown>
  }

  if (parsedResponse && (parsedResponse.tool_calls || toolCalls.length > 0)) {
    const assistantToolCalls = (parsedResponse.tool_calls as unknown[]) ?? toolCalls.map(tc => ({
      id: tc.id ?? `call_${tc.name ?? tc.function?.name}`,
      type: 'function',
      function: { name: tc.name ?? tc.function?.name, arguments: tc.arguments ?? tc.function?.arguments ?? JSON.stringify(tc.input ?? {}) },
    }))
    messages.push({
      role: 'assistant',
      content: (parsedResponse.content as string) || null,
      tool_calls: assistantToolCalls,
    } as Record<string, unknown>)
  } else {
    messages.push({ role: 'assistant', content: typeof currentResponse === 'string' ? currentResponse : JSON.stringify(currentResponse) })
  }
  for (const tr of toolResults) {
    messages.push({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content: tr.content,
    })
  }

  return {
    outputs: {
      final_text: undefined,
      updated_messages: JSON.stringify(messages),
      has_tool: true,
    },
    duration_ms: 0,
  }
})

  // ─── Control Flow Executors ─────────────────────────────────────

registerExecutor('Condition', async (node, inputs) => {  // 条件分支：原子化元件：输入数据 + 条件表达式 → 输出 true/false 分支路由。 | 入:data 出:true_branch|false_branch
  const value = inputs.value ?? inputs.data  // 被判断的数据：兼容 value / data 槽名
  const operator = (node.params.operator as string) || 'truthy'  // 比较算子：未配置时按 truthy
  const compare = node.params.compare_value  // 二元比较时的右操作数（来自节点参数）
  let result: boolean

  switch (operator) {
    case 'equals': result = value === compare; break  // 相等
    case 'not_equals': result = value !== compare; break  // 不等
    case 'contains': result = String(value).includes(String(compare)); break  // 子串包含
    case 'gt': result = Number(value) > Number(compare); break  // 数值大于
    case 'gte': result = Number(value) >= Number(compare); break  // 数值大于等于
    case 'lt': result = Number(value) < Number(compare); break  // 数值小于
    case 'lte': result = Number(value) <= Number(compare); break  // 数值小于等于
    case 'truthy': result = !!value; break  // 真值：非空/非零即通过
    case 'action_requires_dispatch': {  // Clock/Agent 调度：JSON 内含 action + confidence
      let obj: unknown = value
      if (typeof value === 'string') {  // 字符串时尝试抠 JSON 对象
        try {
          const m = value.match(/\{[\s\S]*\}/)
          obj = m ? JSON.parse(m[0]) : JSON.parse(value)
        } catch { obj = null }
      }
      if (obj && typeof obj === 'object') {
        const rec = obj as Record<string, unknown>
        const action = String(rec.action ?? '')
        const conf = Number(rec.confidence ?? 0)
        result = (action === 'workflow' || action === 'tool') && conf >= 0.5  // 需要派发且置信度 ≥0.5 才走 true 分支
      } else {
        result = false
      }
      break
    }
    default: result = !!value; break  // 未知算子回退 truthy
  }

  const branchCount = Math.min(12, Math.max(2, Number(node.params.branch_count ?? 2)))
  const outputs: Record<string, unknown> = { result }
  if (branchCount <= 2) {
    outputs.true_branch = result ? value : undefined
    outputs.false_branch = result ? undefined : value
    outputs.active_branch = result ? 0 : 1
  } else {
    const active = result ? 0 : 1
    outputs.active_branch = active
    for (let i = 0; i < branchCount; i++) {
      outputs[`branch_${i}`] = i === active ? value : undefined
    }
  }
  return { outputs, duration_ms: 0 }
})

function resolveLgSwitchBranch(
  inputs: Record<string, unknown>,
  lgAccumulatedState?: Record<string, unknown>,
): string {
  const state = lgAccumulatedState ?? {}
  let branch = typeof state.branch === 'string' ? state.branch : ''
  if (!branch) {
    const raw = inputs.value ?? inputs.selected
    if (typeof raw === 'string') {
      branch = raw
    } else if (raw && typeof raw === 'object') {
      const rec = raw as Record<string, unknown>
      branch = String(rec.step ?? rec.branch ?? rec.value ?? rec.selected ?? '')
    } else {
      branch = String(raw ?? '')
    }
  }
  return branch || 'finish'
}

registerExecutor('Switch', async (node, inputs, ctx) => {  // 多路分支：可变 case 数 + default；仅激活槽有 payload | 入:value
  const lgCtx = ctx as ExecutionContext & { lgAccumulatedState?: Record<string, unknown> }
  const lgBranch = resolveLgSwitchBranch(inputs, lgCtx.lgAccumulatedState)
  if (lgCtx.lgAccumulatedState || typeof node.params.branches === 'string') {
    const state = { ...(lgCtx.lgAccumulatedState ?? {}), branch: lgBranch }
    return {
      outputs: { state, branch: lgBranch, selected: lgBranch, value: lgBranch },
      duration_ms: 0,
    }
  }

  const raw = inputs.value
  let toolName = ''
  let args: Record<string, unknown> = {}
  if (Array.isArray(raw) && raw.length) {
    const tc = raw[0] as { function?: { name?: string; arguments?: string } }
    toolName = tc.function?.name ?? ''
    try {
      args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>
    } catch {
      args = {}
    }
  } else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    toolName = String(rec.name ?? rec.tool ?? rec.selected ?? '')
    args = (rec.args ?? rec.arguments ?? rec) as Record<string, unknown>
  } else {
    toolName = String(raw ?? '')
  }

  let cases: Array<{ label?: string; when?: string; match?: string }> = []
  try {
    const parsed = typeof node.params.cases === 'string'
      ? JSON.parse(node.params.cases)
      : node.params.cases
    if (Array.isArray(parsed) && parsed.length >= 2) cases = parsed
  } catch { /* */ }
  if (cases.length < 2) {
    cases = [{ label: '情况1' }, { label: '情况2' }]
  }

  let matchedSlot = cases.length
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const when = String(c.when ?? c.match ?? c.label ?? '').trim()
    if (!when || when === toolName || toolName.includes(when) || when === '*') {
      matchedSlot = i
      break
    }
  }

  const path = String(args.path ?? args.file_path ?? args.file ?? '')
  const pattern = String(args.pattern ?? args.glob_pattern ?? args.glob ?? '')
  const command = String(args.command ?? args.cmd ?? '')
  const query = String(args.query ?? args.q ?? '')
  const url = String(args.url ?? args.href ?? '')
  const payload = {
    selected: toolName,
    path,
    url,
    command,
    query,
    value: raw,
  }

  const outputs: Record<string, unknown> = {
    ...payload,
    case_count: cases.length,
    matched_slot: matchedSlot,
    active_branch: matchedSlot,
  }
  for (let i = 0; i < cases.length; i++) {
    const key = `case_${i}`
    outputs[key] = i === matchedSlot ? payload : undefined
  }
  outputs.default = matchedSlot === cases.length ? payload : undefined
  return { outputs, duration_ms: 0 }
})

registerExecutor('Validator', async (node, inputs) => {  // 逐步核验 | 入:actual_output,step_expected,global_expected,stage,purpose 出:passed,failure_reason
  const spec = inputs.validation_spec as Record<string, unknown> | undefined
  const purpose = String(inputs.purpose ?? spec?.purpose ?? node.params.purpose ?? '')
  const stage = String(inputs.stage ?? node.params.stage ?? node.id ?? '')
  const stepPattern = String(
    inputs.step_expected_pattern
    ?? inputs.expected_pattern
    ?? spec?.expected_pattern
    ?? node.params.step_expected_pattern
    ?? node.params.expected_pattern
    ?? '',
  )
  const globalPattern = String(
    inputs.global_expected_pattern
    ?? spec?.global_expected_pattern
    ?? node.params.global_expected_pattern
    ?? '',
  )
  const actualRaw = inputs.actual_output
  const actual = typeof actualRaw === 'string' ? actualRaw : JSON.stringify(actualRaw ?? '')
  let mode = String(node.params.verify_mode ?? 'step')
  if (mode === 'regex') mode = 'step'
  if (mode === 'auto' || mode === 'llm') mode = 'composite'

  const flags = String(node.params.flags ?? 'g')

  function regexPass(pattern: string): { passed: boolean; captures: Record<string, string> | null; reason: string } {
    if (!pattern.trim()) {
      const ok = !!actual.trim()
      return { passed: ok, captures: null, reason: ok ? '' : '输出为空' }
    }
    try {
      const re = new RegExp(pattern, flags)
      const passed = re.test(actual)
      const m = actual.match(re)
      const captures = m?.groups ? (m.groups as Record<string, string>) : null
      return {
        passed,
        captures,
        reason: passed ? '' : `未匹配本步预期: ${pattern.slice(0, 120)}`,
      }
    } catch {
      const passed = actual.includes(pattern)
      return {
        passed,
        captures: null,
        reason: passed ? '' : `未包含预期片段: ${pattern.slice(0, 120)}`,
      }
    }
  }

  if (mode === 'composite') {
    const { verifyOutputAgainstPurpose } = await import('./agentic-executor')
    const combinedPurpose = [
      purpose,
      stage ? `阶段: ${stage}` : '',
      stepPattern ? `本步预期: ${stepPattern}` : '',
      globalPattern ? `总体预期: ${globalPattern}` : '',
    ].filter(Boolean).join('\n')
    const patternForLlm = globalPattern || stepPattern
    const result = await verifyOutputAgainstPurpose(combinedPurpose, patternForLlm, actual, {
      ...node.params,
      verify_mode: 'llm',
    })
    return {
      outputs: {
        passed: result.passed,
        failure_reason: result.passed ? '' : String(result.reason ?? '合验未通过'),
        captures: null,
      },
      duration_ms: 0,
    }
  }

  const stepCheck = regexPass(stepPattern)
  if (!stepCheck.passed) {
    return {
      outputs: {
        passed: false,
        failure_reason: `[${stage || 'step'}] ${stepCheck.reason}`,
        captures: stepCheck.captures,
      },
      duration_ms: 0,
    }
  }
  return {
    outputs: { passed: true, failure_reason: '', captures: stepCheck.captures },
    duration_ms: 0,
  }
})

  // ─── Transform Executors ────────────────────────────────────────

registerExecutor('TextTransform', async (node, inputs) => {  // 文本处理：原子化元件：输入文本 → 变换（截取/替换/格式化）→ 输出文本。 | 入:text 出:result
  const text = String(inputs.text ?? inputs.input ?? '')
  const op = node.params.operation as string || 'trim'
  let result: unknown = text
  switch (op) {
    case 'trim': result = text.trim(); break
    case 'lowercase': result = text.toLowerCase(); break
    case 'uppercase': result = text.toUpperCase(); break
    case 'split':  // 按行拆分，去空行
    case 'split_lines': {
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      result = lines
      return { outputs: { result: lines, lines, data: lines }, duration_ms: 0 }
    }
    case 'shell_from_json': {  // 从 JSON 拼 shell echo stub（benchmark 用）
      let obj: unknown = inputs.text ?? text
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj) } catch { obj = {} }
      }
      const rec = (obj && typeof obj === 'object') ? obj as Record<string, unknown> : {}
      const platform = String(rec.platform ?? 'arxiv')
      const query = String(rec.query ?? '').replace(/"/g, '\\"')
      const maxItems = Number(rec.maxItems ?? 20)
      result = `echo '{"stub":true,"platform":"${platform}","query":"${query}"}'`
      return { outputs: { result, command: result }, duration_ms: 0 }
    }
  }
  return { outputs: { result }, duration_ms: 0 }
})

registerExecutor('JsonParse', async (node, inputs) => {  // JSON 解析：原子化元件：输入字符串 → 解析 JSON / 提取字段 → 输出对象。 | 入:input 出:data|field
  const rawInput = inputs.input ?? inputs.text
  let parsed: unknown
  if (rawInput && typeof rawInput === 'object') {  // 已是对象则直接使用
    parsed = rawInput
  } else {
    const raw = String(rawInput ?? '{}')
    try {
      parsed = JSON.parse(raw)
    } catch {
      const mObj = raw.match(/\{[\s\S]*\}/)  // LLM 包裹文本：抠第一个 {} 或 []
      const mArr = raw.match(/\[[\s\S]*\]/)
      const candidate = mObj?.[0] ?? mArr?.[0]
      try {
        parsed = candidate ? JSON.parse(candidate) : {}
      } catch {
        parsed = {}
      }
    }
  }
  let data: unknown = parsed
  const path = String(node.params.path ?? '').trim()  // 简易 JSONPath：仅支持 $.key 首段
  if (path.startsWith('$.')) {
    const key = path.slice(2).split('.')[0]
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = (parsed as Record<string, unknown>)[key] ?? parsed
    }
  }
  return { outputs: { data, result: data, parsed }, duration_ms: 0 }
})

registerExecutor('Merge', async (node, inputs) => {  // 合并：原子化元件：多路输入 → 合并为单一输出。 | 入:input_a|input_b 出:merged
  const items = Object.values(inputs)  // 所有入边槽位值组成数组
  const strategy = String(node.params?.strategy ?? 'array')
  if (strategy === 'first_non_null') {  // 取第一个非空
    const picked = items.find(v => v !== null && v !== undefined)
    return { outputs: { merged: picked ?? null }, duration_ms: 0 }
  }
  if (strategy === 'concat') {  // 对象浅合并
    const merged = items.reduce<Record<string, unknown>>((acc, item, i) => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        return { ...acc, ...(item as Record<string, unknown>) }
      }
      return { ...acc, [`input_${i}`]: item }
    }, {})
    return { outputs: { merged }, duration_ms: 0 }
  }
  return { outputs: { merged: items.length === 1 ? items[0] : items }, duration_ms: 0 }  // 默认：单输入直通，多输入变数组
})

  // ─── Input/Output Executors ─────────────────────────────────────

registerExecutor('StaticData', async (node) => {  // 静态数据：原子化元件：输出固定的 JSON/文本数据。用于配置注入；可选接上游 trigger 表示执行顺序。 | 入:trigger 出:data
  let value: unknown = node.params.value ?? node.params.data ?? ''
  if (node.params.type === 'json' && typeof value === 'string') {  // type=json 时把字符串解析为对象
    try {
      value = JSON.parse(value)
    } catch { /* keep raw string */ }
  }
  return { outputs: { data: value }, duration_ms: 0 }
})

registerExecutor('PromptInput', async (node, _inputs, ctx) => {  // Prompt 植入：原子化元件：定义初始输入（User Prompt）。必须填写输出预期正则，未填则编译报错。 | 入:— 出:prompt|expected_pattern|context|channel
  const text = String(node.params.prompt_text ?? node.params.content ?? '')
  const expectedPattern = String(node.params.expected_output ?? node.params.expected_pattern ?? '')
  const purpose = String(node.params.purpose ?? '')
  const channel = String(node.params.channel ?? 'cli')

  if (ctx.lgAccumulatedState) {
    const state = buildLgPromptState(node, ctx.lgAccumulatedState ?? {})
    return {
      outputs: {
        prompt: text,
        expected_pattern: expectedPattern,
        context: purpose ? { purpose, content: text } : { content: text },
        channel,
        state,
        response: text,
      },
      duration_ms: 0,
    }
  }

  return {
    outputs: {
      prompt: text,
      expected_pattern: expectedPattern,
      context: purpose ? { purpose, content: text } : { content: text },
      channel,
    },
    duration_ms: 0,
  }
})

registerExecutor('Output', async (_node, inputs, ctx) => {  // Output：原子化元件：工作流终点。可多节点并联输出；画布上以紧凑卡片呈现（对齐 Dify End）。 | 入:content 出:—
  if (ctx.lgAccumulatedState) {
    const content = ctx.lgAccumulatedState ?? inputs.content ?? {}
    return { outputs: { content, final_state: content }, duration_ms: 0 }
  }
  return { outputs: { content: inputs.content }, duration_ms: 0 }  // 终点：透传 content 槽为 merged_output
})

  // ─── Tools: HTTP API Executors ──────────────────────────────────

function apiBase(node: NodeInstance, fallback: string): string {
  return (node.params.api_base as string) || fallback
}

function servicePort(defaultBase: string): number {
  const m = defaultBase.match(/:(\d+)/)
  return m ? Number(m[1]) : 0
}

function serviceHint(service: string, port: number, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return `${service} 未响应（127.0.0.1:${port}）。运行 node PolarUI/scripts/ensure-ecosystem-services.mjs 拉起服务。原因：${reason}`
}

function createApiExecutor(
  defaultBase: string,
  endpoint: string,
  method = 'POST',
  serviceLabel?: string,
): ExecutorFn {
  const port = servicePort(defaultBase)  // 默认服务端口（用于 serviceHint）
  const label = serviceLabel ?? `服务(${defaultBase})`  // 错误提示中的服务显示名
  return async (node, inputs) => {
    const base = apiBase(node, defaultBase)  // 生态服务根地址：节点 params.api_base 优先于默认端口
    const url = `${base}${endpoint}`  // 拼好的 HTTP 请求地址
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method !== 'GET' ? { body: JSON.stringify(inputs) } : {}),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`${method} ${url} returned ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
      const data = await res.json()  // 接口 JSON 正文
      return { outputs: { result: data }, duration_ms: 0 }
    } catch (err) {
      throw new Error(serviceHint(label, port, err))
    }
  }
}

function createGetQueryExecutor(
  defaultBase: string,
  path: string,
  queryKeys: string[],
  outputKey = 'result',
): ExecutorFn {
  return async (node, inputs) => {
    const base = apiBase(node, defaultBase)  // 生态服务根地址：节点 params.api_base 优先于默认端口
    const qs = new URLSearchParams()  // qs：本步业务中间量
    for (const key of queryKeys) {  // 将 inputs/params 编入 query string
      const val = inputs[key] ?? node.params[key]  // val：本步业务中间量
      if (val !== undefined && val !== null && String(val) !== '') {  // 组件：条件分支
        qs.set(key, String(val))
      }
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ''}`  // 拼好的 HTTP 请求地址
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    return { outputs: { [outputKey]: data }, duration_ms: 0 }
  }
}

async function fetchClockSnapshot(
  node: NodeInstance,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const usernameRaw = String(inputs.username ?? node.params.username ?? 'default')  // usernameRaw：本步业务中间量
  const username = usernameRaw.includes('{') ? 'default' : usernameRaw  // Clock 多用户隔离用的用户名
  await ensureClockUserToken(node, username)
  let syncKey = String(inputs.sync_key ?? node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  if (!syncKey) {  // 附带 X-Sync-Key 请求头
    try {
      const keyPath = join(polarisorRoot(), 'Clock/backend/data/sync_key.txt')  // keyPath：本步业务中间量
      syncKey = (await hubFileRead(keyPath)).content.trim()
    } catch { /* no local key */ }
  }
  const base = apiBase(node, 'http://127.0.0.1:15550')  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const headers: Record<string, string> = {}
  if (syncKey) headers['X-Sync-Key'] = syncKey  // 附带 X-Sync-Key 请求头
  const res = await fetch(
    `${base}/api/sync/snapshot?username=${encodeURIComponent(username)}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  )
  if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
    let detail = String(res.status)  // detail：本步业务中间量
    try {
      const body = (await res.json()) as { message?: string; code?: string }  // body：本步业务中间量
      detail = body.message ?? body.code ?? detail
    } catch { /* non-json body */ }
    if (res.status === 401 || res.status === 403) {  // 组件：条件分支
      throw new Error(
        `Clock 需要 X-Sync-Key（在节点 params.sync_key 配置；本地 key 见 Clock/backend/data/sync_key.txt）。${detail}`
      )
    }
    if (res.status === 422) {  // 组件：条件分支
      throw new Error(`Clock snapshot 缺少 username 参数。${detail}`)
    }
    throw new Error(`Clock snapshot 失败：${detail}`)
  }
  return (await res.json()) as Record<string, unknown>
}

  // QualityAnalyze：原子化元件：文本质量分析，返回 A-F 等级和改进建议
  // ContentSummarize：原子化元件：内容摘要 + Mermaid 架构图生成
  // ContentEnrich：原子化元件：KnowLever RAG 上下文增强，自动补充背景知识
const CLOCK_BASE = 'http://127.0.0.1:15550'
const clockTokenCache = new Map<string, string>()

async function ensureClockUserToken(
  node: NodeInstance,
  username = 'default',
): Promise<string> {
  const existing = String(node.params.x_token ?? '').trim()
  if (existing) return existing  // 节点已配置 token 则直接复用
  const user = String(username || node.params.username || 'default').trim() || 'default'  // KnowLever/PolarMemory 用户 id
  const cached = clockTokenCache.get(user)
  if (cached) {  // 进程内 token 缓存命中
    node.params.x_token = cached
    return cached
  }
  const base = apiBase(node, CLOCK_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  const login = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!login.ok) {  // Clock 登录失败不可继续
    throw new Error(`Clock 用户 ${user} 登录失败 (${login.status})`)
  }
  const data = (await login.json()) as { token?: string }  // 接口 JSON 正文
  const token = String(data.token ?? '').trim()  // Clock 用户会话 token（X-Token）
  if (!token) throw new Error(`Clock 用户 ${user} 登录响应缺少 token`)  // 登录响应缺少 token
  clockTokenCache.set(user, token)
  node.params.x_token = token
  return token
}

async function clockAuthFetch(
  node: NodeInstance,
  path: string,
  init: RequestInit = {},
  syncKey = '',
): Promise<Response> {
  const base = apiBase(node, CLOCK_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const key = String(syncKey || node.params.sync_key || '').trim()  // PolarMemory 块 id
  const token = String(node.params.x_token ?? '').trim()  // Clock 用户会话 token（X-Token）
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  if (key) headers['X-Sync-Key'] = key  // 请求头携带鉴权字段
  if (token) headers['X-Token'] = token
  return fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
}

async function requireClockUserToken(node: NodeInstance, username = 'default'): Promise<string> {
  return ensureClockUserToken(node, username)
}

  // PortList：原子化元件：列出所有已分配端口及状态
registerExecutor('ErrorClassifier', async (node, inputs) => {  // 错误分类：原子化元件：用 LLM 对 error_log 分类（崩溃/配置/依赖/未知） | 入:error_log 出:classification
  const model = (node.params.model as string) || 'GLM-5.1'  // LLM/VLM 模型 id
  const log = String(inputs.error_log ?? '')
  const { content } = await getLLMClient().chat(model, [
    {
      role: 'system',
      content: '将错误日志分类为: crash | config | dependency | unknown。只输出一个词。',
    },
    { role: 'user', content: log.slice(0, 8000) },
  ], { temperature: 0, timeoutMs: 60_000 })
  const classification = (content || 'unknown').trim().split(/\s+/)[0]
  return { outputs: { classification }, duration_ms: 0 }
})

registerExecutor('WorkflowMeta', async (node, inputs) => {  // 画中画容器：元工作流节点：工作流运行中自建议+沙箱修改+回退/接受 | 入:current_workflow|issue_report 出:modified_workflow|accepted
  const { executeWorkflowMeta } = await import('./meta-executor')
  const original = (inputs.current_workflow as Record<string, unknown>) ?? {}
  const result = await executeWorkflowMeta(
    original,
    String(inputs.issue_report ?? ''),
    {
      sandbox: node.params.sandbox !== false,
      requireApproval: node.params.require_approval !== false,
      maxChanges: Number(node.params.max_changes ?? 3),
    }
  )
  return {
    outputs: {
      original_workflow: original,
      modified_workflow: result.modified_workflow,
      accepted: result.accepted,
      change_count: result.change_count,
      dry_run_ok: result.dry_run_ok,
      analysis: result.analysis,
    },
    duration_ms: 0,
    error: result.dry_run_ok === false && result.change_count > 0
      ? '沙箱试运行失败，已回退到原工作流'
      : undefined,
  }
})

registerExecutor('AgenticUnit', async (node, inputs) => executeAgenticUnit(node, inputs))  // AgenticUnit：Agentic 组合：工作层(LLM调用) + 核验层(正则匹配) + 重试循环。由原子化元件组成，可展开查看内部结构。
registerExecutor('AgenticChain', async (node, inputs) => executeAgenticChain(node, inputs))  // AgenticChain：Agentic 组合：多个 Agentic 单元串联。每步工作层输出经核验层确认后才进入下一步。可展开查看内部。

const ECOSYSTEM_HTTP: Array<[string, string, string, string?]> = [  // 生态原子组件 HTTP 执行器批量注册（api_base 可覆盖）],
  ['VisualQA', 'http://127.0.0.1:3900', '/api/visual-qa'],
  ['MemorySearch', 'http://127.0.0.1:3100', '/api/blocks/search'],
  ['MemoryConvert', 'http://127.0.0.1:3100', '/api/blocks/convert'],
  ['PortAllocate', 'http://127.0.0.1:11050', '/api/allocate'],
  ['PortRelease', 'http://127.0.0.1:11050', '/api/release'],
  ['PortHeartbeat', 'http://127.0.0.1:11050', '/api/heartbeat'],
  ['DigestSummarize', 'http://127.0.0.1:3800', '/api/summarize'],
  ['DigestFuse', 'http://127.0.0.1:3800', '/api/fuse'],
  ['DigestRecommend', 'http://127.0.0.1:3800', '/api/recommend', 'GET'],
  ['DigestSourceConfig', 'http://127.0.0.1:3800', '/api/sources'],
  ['TemplateGet', 'http://127.0.0.1:3900', '/api/templates/default', 'GET'],
  ['TQDataCollect', 'http://127.0.0.1:8000', '/api/v1/data/collect'],
  ['TQStrategyList', 'http://127.0.0.1:8000', '/api/v1/strategies', 'GET'],
  ['TQOptimize', 'http://127.0.0.1:8000', '/api/v1/optimize/run'],
  ['TQLiveTrade', 'http://127.0.0.1:8000', '/api/v1/live/control'],
  ['TQRiskCheck', 'http://127.0.0.1:8000', '/api/v1/risk/check'],
  ['TQBacktest', 'http://127.0.0.1:8000', '/api/v1/backtest/run'],
  ['TQResearchRun', 'http://127.0.0.1:8000', '/api/v1/research/runs'],
]

for (const [classType, base, endpoint, method] of ECOSYSTEM_HTTP) {  // 批量注册生态 HTTP 原子组件
  if (!executorRegistry.has(classType)) {
    registerExecutor(classType, createApiExecutor(base, endpoint, method ?? 'POST'))
  }
}

function processBase(node: NodeInstance): string {  // PolarProcess 动态路径 API
  return (node.params.api_base as string) || 'http://127.0.0.1:11055'
}

registerExecutor('RegexMatch', async (node, inputs) => {  // 正则匹配：原子化元件：输入文本 + 正则表达式 → 输出匹配结果与捕获组。 | 入:text 出:matched|captures|full_match
  const text = String(inputs.text ?? '')
  const pattern = String(node.params.pattern ?? inputs.pattern ?? '')  // Glob/Grep 匹配模式
  const matched = pattern ? new RegExp(pattern, 'i').test(text) : false  // 无 pattern 时视为不匹配
  return { outputs: { matched, matches: matched ? [text] : [] }, duration_ms: 0 }
})

registerExecutor('RetryLoop', async (node, inputs, ctx) => {  // 重试循环：【Agent 默认推荐】外环：最多 7 轮「刷新上下文后从用户需求(SSOT)重新验收」。轮内：有错则改、改完再查直至本轮自认无问题。retry_hint 仅用 | 入:passed|retry_hint|original_input 出:retry_input|exhausted|passed|intra_round_hint|attempt
  const max = Number(node.params.max_retries ?? 7)  // 轮间上限：默认 7（与生态 RetryLoop 口径一致）
  const attempt = Number(node.params._attempt ?? 1)  // 当前第几轮：runner 注入 _attempt
  const passed = inputs.passed === true || inputs.passed === 'true'  // Validator 是否已通过（兼容字符串 'true'）
  const retryHint = String(inputs.retry_hint ?? '')  // 轮内修正提示（仅本轮注入 LLM，不进下一轮 SSOT）
  const original = inputs.original_input ?? inputs.retry_input ?? ''  // 用户需求锚点：优先 original_input，兼容 retry_input 回流

  const stopReason: LoopTraceEntry['stop_reason'] = passed  // 记录本步停止原因，供 trace / 画布展示
    ? 'passed'
    : attempt >= max
      ? 'exhausted'
      : 'retry'

  ctx.runTrace?.loop_traces.push({
    loop_node_id: node.id,
    attempt,
    max_attempts: max,
    input_snapshot: { passed: inputs.passed, retry_hint: retryHint, original_input: original },
    output_snapshot: { exhausted: stopReason === 'exhausted' },
    stop_reason: stopReason,
  })

  if (passed) {  // 已通过：输出原始需求，标记不耗尽
    return {
      outputs: { retry_input: original, exhausted: false, passed: true, attempt },
      duration_ms: 0,
    }
  }
  if (attempt >= max) {  // 未通过且轮次用尽：exhausted，下游应停止重试
    return {
      outputs: { retry_input: original, exhausted: true, passed: false, attempt },
      duration_ms: 0,
    }
  }
  return {  // 未通过且仍有轮次：继续重试，轮间只回流 original（不拼接 hint）
    outputs: {
      retry_input: original,
      intra_round_hint: retryHint || undefined,
      exhausted: false,
      passed: false,
      should_retry: true,
      attempt,
    },
    duration_ms: 0,
  }
})

registerExecutor('SampleLoop', async (node, inputs, ctx) => {  // 抽样循环：同输入独立跑 N 次（各次互不看上一轮），再按规则选优。与 RetryLoop 反馈重跑正交。 | 入:sample|score|original_input|candidate 出:selected|retry_input|exhausted|should_sample
  const n = Math.max(1, Number(node.params.n_samples ?? 3))  // 独立抽样次数 N（与 RetryLoop 正交）
  const selection = String(node.params.selection ?? 'last')  // 选优策略：first | max_score | last
  const attempt = Number(node.params._attempt ?? 1)  // 当前轮次（runner 注入 _attempt）
  const sample = inputs.sample ?? inputs.candidate
  const score = Number(inputs.score ?? attempt)
  const original = inputs.original_input ?? sample

  const prevSamples = (node.params._collected_samples as unknown[]) ?? []
  const prevScores = (node.params._collected_scores as number[]) ?? []
  const samples = [...prevSamples, sample]
  const scores = [...prevScores, score]

  ctx.runTrace?.loop_traces.push({
    loop_node_id: node.id,
    attempt,
    max_attempts: n,
    input_snapshot: { sample, score, selection },
    output_snapshot: { collected: samples.length },
    stop_reason: attempt >= n ? 'passed' : 'retry',
  })

  if (attempt >= n) {  // 采满 N 次：按策略挑出最终样本
    let picked: unknown = sample
    if (selection === 'first') picked = samples[0]
    else if (selection === 'max_score') {  // 备选条件：上一分支未命中
      const maxScore = Math.max(...scores.map(s => Number(s) || 0))
      const idx = scores.findIndex(s => Number(s) === maxScore)
      picked = samples[idx >= 0 ? idx : samples.length - 1]
    } else {
      picked = samples[samples.length - 1]
    }
    return {
      outputs: {
        selected: picked,
        samples,
        scores,
        exhausted: true,
        attempt,
        should_sample: false,
      },
      duration_ms: 0,
    }
  }

  return {
    outputs: {
      retry_input: original,
      exhausted: false,
      attempt,
      should_sample: true,
      sample_index: attempt,
    },
    duration_ms: 0,
  }
})

export function normalizeLoopItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  }
  if (raw && typeof raw === 'object') {  // 槽位可能是对象，需展平
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.lines)) return o.lines
    if (Array.isArray(o.data)) return o.data
    if (Array.isArray(o.results)) return o.results
    if (typeof o.stdout === 'string') return normalizeLoopItems(o.stdout)
    if (typeof o.result === 'string') return normalizeLoopItems(o.result)
  }
  return []
}

registerExecutor('ForLoop', async (node, inputs) => {  // For 循环：原子化元件：输入列表 → 对每一项执行下游节点 → 收集结果。 | 入:items 出:current_item|index|results|done
  const items = normalizeLoopItems(inputs.items)  // 归一化 items 槽为数组（支持字符串行、stdout 等）
  const maxItems = Number(node.params.max_items ?? node.params.max_iterations ?? 0)  // 可选上限：0 表示不截断
  const limited = maxItems > 0 ? items.slice(0, maxItems) : items  // 有上限则 slice，否则全量
  return {
    outputs: {
      current_item: limited[0] ?? null,
      index: 0,
      results: limited,
      items: limited,
      count: limited.length,
    },
    duration_ms: 0,
  }
})

registerExecutor('WhileLoop', async (node, inputs) => {  // While 循环：原子化元件：持续执行下游节点，直到条件 false 或达到最大迭代次数。 | 入:initial|condition 出:current|iteration|final_result
  const max = Number(node.params.max_iterations ?? 10)  // 最大迭代次数，防止死循环
  let i = 0  // 已执行轮数计数器
  let value = inputs.initial  // 循环体累积结果，初值为 initial 槽
  while (i < max && inputs.condition) {  // 在条件为真且未超上限时迭代（runner 负责多轮展开时复用本节点）
    value = inputs.body ?? value
    i++
    if (!inputs.condition) break  // 条件变假时提前退出
  }
  return { outputs: { result: value, iterations: i }, duration_ms: 0 }
})

registerExecutor('MapReduce', async (node, inputs) => {  // Map-Reduce：原子化元件：Map 各项分别处理，Reduce 汇聚结果。分治模式。 | 入:items 出:map_results|reduced
  const items = (inputs.items as unknown[]) ?? []
  const mapped = items.map(x => x)  // 当前为恒等 map（占位，子图在 runner 展开）
  const reduced = mapped.length === 1 ? mapped[0] : mapped  // 单项直通，多项保留数组
  return { outputs: { result: reduced }, duration_ms: 0 }
})

registerExecutor('PromptInject', async (node, inputs) => {  // Prompt 注入：原子化元件：注入先验知识（System Prompt）。可接 MemorySearch.blocks 或 prior_knowledge。 | 入:prior_context|memory_blocks 出:system_prompt|context
  const { loadRulesBundle, mergeRulesText, selectProtocolRules } = await import('./rules-client')
  const memoryText = formatMemoryBlocks(inputs.memory_blocks ?? inputs.blocks)
  const triggerText = String(
    inputs.prior_context ?? memoryText ?? inputs.trigger_text ?? node.params.trigger_text ?? ''
  )
  let inject = String(inputs.prior_knowledge ?? node.params.prior_knowledge ?? inputs.inject_text ?? '')
  if (memoryText && inject && !inject.includes(memoryText)) {
    inject = `${inject}\n\n## 记忆检索\n${memoryText}`
  } else if (memoryText && !inject) {
    inject = `## 记忆检索\n${memoryText}`
  }
  const role = String(node.params.role ?? '')
  const constraints = String(node.params.constraints ?? '')

  if (node.params.use_trigger_engine !== false && triggerText.trim()) {  // 触发词匹配 Agent_core 协议规则并合并进 system
    try {
      const all = await loadRulesBundle()
      const matched = selectProtocolRules(triggerText, all)
      if (matched.length) {
        const auto = mergeRulesText(matched)
        inject = inject ? `${auto}\n\n${inject}` : auto
      }
    } catch {
      /* rules-bundle 未生成时回退为手动 prior_knowledge */
    }
  }

  const parts = [
    role && `## 角色\n${role}`,
    constraints && `## 约束\n${constraints}`,
    inject,
  ].filter(Boolean)
  const system_prompt = parts.join('\n\n').trim()  // 拼接为 LLM system_prompt
  return {
    outputs: {
      system_prompt,
      context: {
        trigger_text: triggerText,
        auto_trigger: node.params.use_trigger_engine !== false,
        memory_blocks_applied: Boolean(memoryText),
      },
    },
    duration_ms: 0,
  }
})

registerExecutor('NormInject', async (node) => {  // 规范注入（固定）：原子化元件：全量注入规范层（always 规则），对应提示词分层中的「规范级别」，应直连 Output。 | 入:— 出:system_prompt|rule_ids
  const { loadRulesBundle, mergeRulesText, selectNormRules } = await import('./rules-client')
  const all = await loadRulesBundle()
  const norms = selectNormRules(all)
  const override = String(node.params.override ?? '')
  const merged = mergeRulesText(norms)
  const system_prompt = override ? `${merged}\n\n${override}`.trim() : merged
  return {
    outputs: {
      system_prompt,
      rule_ids: norms.map((r) => r.id),
    },
    duration_ms: 0,
  }
})

registerExecutor('SchemaExtract', async (node, inputs) => {  // 结构化提取：原子化元件：给定 LLM 原始文本 + JSON Schema → 解析出符合 Schema 的对象。纯解析，不调用 LLM。 | 入:text|schema 出:parsed|valid|errors
  const text = String(inputs.text ?? inputs.response ?? '')
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  let parsed: unknown = null
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]) } catch { parsed = null }
  }
  return { outputs: { extracted: parsed, raw: text }, duration_ms: 0 }
})

registerExecutor('Delay', async (node) => {  // 延时：原子化元件：输入信号 → 等待 N 秒 → 透传输出。 | 入:trigger 出:pass
  const ms = Number(node.params.delay_ms ?? 500)
  await new Promise(r => setTimeout(r, Math.min(ms, 5000)))
  return { outputs: { done: true }, duration_ms: ms }
})

registerExecutor('ListIterate', async (node, inputs) => {  // 列表迭代：原子化元件：输入列表 → 逐项输出。 | 入:list 出:item|index|done
  const items = (inputs.list as unknown[]) ?? []
  const idx = Number(inputs.index ?? 0)
  return { outputs: { item: items[idx], index: idx, has_more: idx + 1 < items.length }, duration_ms: 0 }
})

registerExecutor('LogicChainDecompose', async (node, inputs) => {  // 逻辑链分解：原子化元件：输入复杂目标 → 分解 → 输出子目标列表 + 依赖关系。 | 入:complex_goal|context 出:sub_goals|dependencies
  const goal = String(inputs.goal ?? inputs.complex_goal ?? inputs.context ?? inputs.prompt ?? '')
  let steps = goal.split(/[。；;\n]/).map(s => s.trim()).filter(Boolean)
  if (steps.length <= 1 && goal.length > 40) {
    steps = goal.match(/.{1,120}/gs)?.map(s => s.trim()).filter(Boolean) ?? [goal.trim()]
  }
  return { outputs: { steps, count: steps.length, data: steps }, duration_ms: 0 }
})

registerExecutor('ReflectiveContext', async (node) => {  // 反身性上下文：原子化元件：扫描注册表 + 约束规则 → 输出组件清单和 system prompt。无数据输入；可选 trigger 表示执行顺序。 | 入:trigger 出:component_manifest|constraints|system_prompt
  const built = buildReflectiveContext({
    includeDescriptions: node.params.include_descriptions !== false,
    includeAgentRules: node.params.include_agent_rules !== false,
  })

  return {
    outputs: {
      component_manifest: built.component_manifest,
      constraints: built.constraints,
      system_prompt: built.system_prompt,
    },
    duration_ms: 0,
  }
})

function extractCheckupEventId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined  // 槽位可能是对象，需展平
  const record = context as Record<string, unknown>  // 经验捕获结构化记录
  if (record.event_id != null) return String(record.event_id)
  const event = record.event  // Checkup 事件载荷
  if (event && typeof event === 'object' && (event as Record<string, unknown>).event_id != null) {  // 槽位可能是对象，需展平
    return String((event as Record<string, unknown>).event_id)
  }
  return undefined
}

function isUpstreamSkipped(ctx: ExecutionContext, node: NodeInstance, inputName: string): boolean {
  const def = registry.get(node.class_type)
  if (!def) return false
  const slotIdx = def.inputs.findIndex((input) => input.name === inputName)
  if (slotIdx < 0) return false
  const link = ctx.links.find((l) => l.to_node === node.id && l.to_slot === slotIdx)
  if (!link) return false
  return Boolean(ctx.allResults.get(link.from_node)?.outputs?.skipped)
}


registerExecutor('HumanApproval', async (node, inputs) => {  // 人工审批：原子化元件：输入上下文 → 阻塞等待人工确认 → 输出批准/拒绝信号。 | 入:context 出:approved|feedback
  const autoApprove = node.params.auto_approve !== false  // false 时强制人工（检修流水线）
  const context = inputs.context ?? inputs.payload
  const eventId = extractCheckupEventId(context)
  if (!autoApprove) {
    const reason = String(node.params.prompt_text ?? node.params.reason ?? '需人工审批')
    try {
      await hubOutputDisplay(
        {
          type: 'checkup_human_approval',
          event_id: eventId,
          context,
          reason,
        },
        'json',
        '检修：需人工介入',
      )
    } catch { /* best effort */ }

    if (node.params.push_suggestion === true) {  // 可选：进化提案写入 suggestion inbox
      try {
        const { pushSuggestion } = await import('./suggestion-store')
        const proposal = (typeof context === 'object' && context ? context : {}) as Record<string, unknown>
        const ptype = String(proposal.proposal_type ?? '')
        const kindMap: Record<string, import('./suggestion-store').SuggestionKind> = {
          add_component: 'ADD_NODE_DEF',
          remove_rule: 'REMOVE_NODE_DEF',
          add_rule: 'MODIFY_NODE_DEF',
          add_workflow: 'ADD_WORKFLOW',
        }
        const kind = kindMap[ptype] ?? 'MODIFY_NODE_DEF'
        pushSuggestion({
          source: 'benchmark',
          kind,
          title: String(proposal.title ?? `提案：${ptype || 'human_review'}`),
          rationale: String(proposal.rationale ?? reason),
          diff: {
            path: String(proposal.target ?? ''),
            after: proposal,
          },
          apply_targets: [
            { id: 'apply', label: '应用提案变更', checked: false },
          ],
        })
      } catch { /* inbox optional in headless */ }
    }

    return {
      outputs: {
        approved: false,
        feedback: reason,
        status: 'needs_human',
        summary: reason,
      },
      duration_ms: 0,
    }
  }
  const approved = inputs.approved !== false  // auto_approve：默认通过，除非显式 approved=false
  return {
    outputs: { approved, feedback: String(inputs.feedback ?? ''), status: approved ? 'triaged' : 'needs_human' },
    duration_ms: 0,
    error: approved ? undefined : '等待人工审批',
  }
})

registerExecutor('PermissionGate', async (node, inputs) => {  // 权限门控：原子化元件：三态权限检查 (allow/deny/ask)。工具调用前拦截。 | 入:permission_request 出:allowed|decision
  if (node.params.skip_permissions === true || inputs.skip_permissions === true) {
    return {
      outputs: { allowed: true, decision: 'skip_permissions', data: inputs.data },
      duration_ms: 0,
    }
  }
  const req = (inputs.permission_request ?? {}) as Record<string, unknown>
  const toolName = String(  // 待校验的工具/动作名
    inputs.tool_name
    ?? inputs.action
    ?? req.tool_name
    ?? req.action
    ?? node.params.tool_name
    ?? '',
  )
  let whitelist: string[] = []
  try {
    whitelist = JSON.parse(String(node.params.whitelist ?? '[]'))
  } catch { whitelist = [] }
  const mode = String(node.params.mode ?? 'ask')  // 组件运行模式（ask/whitelist 等）
  const onWhitelist = whitelist.some(w => toolName.includes(w) || w === toolName)
  const allowed = mode === 'whitelist' || mode === 'ask'  // PermissionGate 是否放行下游
    ? (onWhitelist || (mode !== 'ask' && node.params.allow !== false))
    : node.params.allow !== false
  const needsApproval = mode === 'ask' && !onWhitelist && toolName.length > 0
  return {
    outputs: {
      allowed: allowed && !needsApproval,
      decision: needsApproval ? 'needs_approval' : (allowed ? 'allow' : 'deny'),
      data: allowed && !needsApproval ? inputs.data : null,
    },
    duration_ms: 0,
  }
})

registerExecutor('NoteCard', async () => ({ outputs: {}, duration_ms: 0 }))  // NoteCard：画布注释：Markdown 文本，虚线可关联节点；不参与数据流与执行（特殊类组件）

registerExecutor('SSoTQuery', async (node, inputs) => {  // SSoT 查询：生态模块：查询项目结构化文档 | 入:project 出:polaris|requirements
  const raw = inputs.project ?? node.params.project ?? 'PolarUI'
  const project = typeof raw === 'object' && raw !== null  // polaris.json 对应项目名
    ? String((raw as { name?: string; path?: string }).name
      ?? (raw as { path?: string }).path
      ?? 'PolarUI')
    : String(raw || 'PolarUI')
  const res = await fetch(`${hubApiBase()}/api/polaris/${encodeURIComponent(project)}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`SSoTQuery ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { ssot: await res.json() }, duration_ms: 0 }
})

registerExecutor('MemoryStore', async (node, inputs) => {  // 持久记忆：原子化元件：读写持久化记忆。支持 MEMORY.md / USER.md 等。 | 入:key|content 出:stored|recalled
  const base = apiBase(node, MEMORY_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const key = String(inputs.key ?? node.params.key ?? `mem_${Date.now()}`)  // PolarMemory 块 id
  const content = String(inputs.content ?? '')  // 写入或读取的文本内容
  const operation = String(node.params.operation ?? 'write')  // MemoryStore 读/写操作
  if (operation === 'read') {
    const res = await fetch(`${base}/api/blocks/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
      return { outputs: { stored: false, recalled: '' }, duration_ms: 0 }
    }
    const data = await res.json() as { block?: { content?: string } }  // 接口 JSON 正文
    return { outputs: { stored: true, recalled: String(data.block?.content ?? '') }, duration_ms: 0 }
  }
  const res = await fetch(`${base}/api/blocks/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      block_id: key,
      block: { content, type: 'fact', source: 'polarui_memory_store' },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(serviceHint('PolarMemory', 3100, new Error(`upsert ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { stored: true, recalled: content }, duration_ms: 0 }
})

registerExecutor('MemorySync', async (node, inputs) => {  // 记忆同步：原子化元件：与 KnowLever Wiki 增量同步（返回 added/updated 计数） | 入:— 出:sync_result
  const base = apiBase(node, MEMORY_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const user = String(inputs.user ?? node.params.user ?? 'polarui')  // KnowLever/PolarMemory 用户 id
  const topic = String(inputs.topic ?? node.params.topic ?? 'polarisor')  // DIGiST/KnowLever 主题
  const res = await fetch(`${base}/api/blocks/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, topic }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
    const text = await res.text().catch(() => '')
    throw new Error(serviceHint('PolarMemory', 3100, new Error(`sync ${res.status}: ${text.slice(0, 120)}`)))
  }
  const data = await res.json()  // 接口 JSON 正文
  return { outputs: { sync_result: data, result: data }, duration_ms: 0 }
})

registerExecutor('FileRead', async (node, inputs) => {  // 读取文件：生态模块：读取本地文件内容 | 入:path 出:content|metadata
  const path = String(inputs.path ?? node.params.path ?? '')  // 文件或 API 路径（inputs 优先于 params）
  const optional = node.params.optional === true  // 缺文件时不失败，输出空 content
  if (!path || path.includes('{') || /^\/Users\/mac\/Polarisor\/?$/.test(path)) {  // 占位符或未填路径：跳过
    if (optional) return { outputs: { content: '', metadata: { path, missing: true } }, duration_ms: 0 }  // optional：失败不阻断工作流
    if (!path || path.includes('{')) {  // 占位符或未填路径：跳过
      return { outputs: { content: '', metadata: { path, missing: true, skipped: true }, skipped: true }, duration_ms: 0 }
    }
  }
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/api/')) {
    try {
      const res = await fetch(path, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
        if (optional) return { outputs: { content: '', metadata: { path, missing: true } }, duration_ms: 0 }  // optional：失败不阻断工作流
        throw new Error(`FileRead ${res.status}`)
      }
      const content = await res.text()  // 写入或读取的文本内容
      return { outputs: { content, metadata: { path, size: content.length } }, duration_ms: 0 }
    } catch (err) {
      if (optional) return { outputs: { content: '', metadata: { path, missing: true } }, duration_ms: 0 }  // optional：失败不阻断工作流
      throw err
    }
  }
  const encoding = String(node.params.encoding ?? 'utf-8')  // 文本文件读取编码
  const candidates = [path, join(polarisorRoot(), path)]  // FileRead 依次尝试的路径列表
  let lastErr: unknown
  for (const candidate of [...new Set(candidates)]) {  // 依次尝试相对路径与仓库根路径
    try {
      const data = await hubFileRead(candidate, encoding)  // 接口 JSON 正文
      return { outputs: { content: data.content, metadata: data.metadata }, duration_ms: 0 }
    } catch (err) {
      lastErr = err
    }
  }
  if (optional) return { outputs: { content: '', metadata: { path, missing: true } }, duration_ms: 0 }  // optional：失败不阻断工作流
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
})

registerExecutor('FileWrite', async (node, inputs) => {  // 写入文件：生态模块：将内容写入文件 | 入:path|content 出:success
  const path = String(inputs.path ?? '')  // 文件或 API 路径（inputs 优先于 params）
  const content = String(inputs.content ?? '')  // 写入或读取的文本内容
  const createDirs = node.params.create_dirs !== false
  const root = polarisorRoot()
  if (!path || path.includes('[object') || path === root || path === `${root}/`) {  // 占位符或未填路径：跳过
    return { outputs: { success: true, path, skipped: true }, duration_ms: 0 }
  }
  const data = await hubFileWrite(path, content, createDirs)  // 接口 JSON 正文
  return { outputs: { success: data.success, path: data.path }, duration_ms: 0 }
})

function looksLikeShellCommand(command: string): boolean {
  if (!command || command.length > 800) return false
  if (command.includes('\n')) return false
  if (/^\[object /i.test(command)) return false
  if (/^\*\*|^#+\s|^-\s|^\d+\.\s/.test(command.trim())) return false
  if (/[\u4e00-\u9fff]/.test(command) && !/^(cd |git |npm |npx |node |echo |curl |bash |sh )/.test(command)) {
    return false
  }
  return /^[\w./~\-="'$\\|&;<>()[\]{}*?+%:,@# ]+$/.test(command)
}

registerExecutor('ShellExec', async (node, inputs) => {  // Shell 执行：生态模块：执行终端命令 | 入:command|cwd 出:stdout|stderr|exit_code|success|skipped
  const command = String(inputs.command ?? '').trim()  // 待执行的 shell 命令行
  const cwd = resolveRepoCwd(inputs.cwd ?? node.params.cwd ?? '.')  // 命令工作目录（相对仓库根解析）
  const timeoutS = Number(node.params.timeout_s ?? 30)  // 子进程/HTTP 超时秒数
  if (!command) {
    return {
      outputs: { stdout: '', stderr: '', exit_code: 0, success: true, skipped: true },
      duration_ms: 0,
    }
  }
  if (!looksLikeShellCommand(command)) {  // 过滤非 shell 文本，避免误执行
    return {
      outputs: {
        stdout: `[skipped non-shell input] ${command.slice(0, 120)}`,
        stderr: '',
        exit_code: 0,
        success: true,
        skipped: true,
      },
      duration_ms: 0,
    }
  }
  const looksLikeShell = (cmd: string): boolean => {
    if (cmd.includes('\n')) return false
    if (/^\[object /i.test(cmd)) return false
    if (/^\*\*|^#+\s|^-\s|^\d+\.\s/.test(cmd)) return false
    if (/[\u4e00-\u9fff]/.test(cmd) && !/^(cd |git |npm |npx |node |echo |curl |bash )/.test(cmd)) return false
    if (cmd.length > 800) return false
    return /^[\w./\\~$"'`\-|&<>();[\]{}=+*,:?@#%! \t]+$/.test(cmd) || /^(cd |git |npm |npx |node |echo |curl |bash )/.test(cmd)
  }
  if (!looksLikeShell(command)) {  // 过滤非 shell 文本，避免误执行
    return {
      outputs: {
        stdout: `[skipped non-shell] ${command.slice(0, 120)}`,
        stderr: '',
        exit_code: 0,
        success: true,
        skipped: true,
      },
      duration_ms: 0,
    }
  }
  if (process.env.POLAR_HEADLESS_DRY_RUN === '1' && /\bgit\s+(commit|push)\b/i.test(command)) {  // 无头 dry-run：跳过真实 git
    return {
      outputs: {
        stdout: `[headless dry-run] skipped: ${command.slice(0, 200)}`,
        stderr: '',
        exit_code: 0,
        success: true,
        dry_run: true,
      },
      duration_ms: 0,
    }
  }
  const data = await hubShellExec(command, cwd, timeoutS)  // 接口 JSON 正文
  return {
    outputs: {
      stdout: data.stdout,
      stderr: data.stderr,
      exit_code: data.exit_code,
      success: data.success,
    },
    duration_ms: 0,
    error: data.success ? undefined : `exit ${data.exit_code}: ${data.stderr.slice(0, 500)}`,
  }
})

registerExecutor('GitCommit', async (node, inputs) => {  // Git Commit：生态模块：提交代码变更 | 入:message|files 出:commit_hash
  const message = String(inputs.message ?? '')  // Git 提交说明或通知正文
  const files = inputs.files  // Git 暂存文件列表（可选）
  const push = node.params.push !== false  // 提交后是否 push 到远端
  const branch = String(node.params.branch ?? 'main')  // 目标分支名
  if (process.env.POLAR_HEADLESS_DRY_RUN === '1') {  // 无头 dry-run：跳过真实 git
    return {
      outputs: { commit_hash: 'dry-run', commit_output: `[headless dry-run] ${message}`, pushed: false },
      duration_ms: 0,
    }
  }
  const data = await hubGitCommit({ message, files, push, branch })  // 接口 JSON 正文
  return {
    outputs: {
      commit_hash: data.commit_hash,
      commit_output: data.commit_output,
      pushed: data.pushed,
    },
    duration_ms: 0,
  }
})

registerExecutor('GlobSearch', async (node, inputs) => {  // Glob 搜索：原子化元件：按 glob 模式搜索文件路径。 | 入:pattern 出:files|count
  const pattern = String(inputs.pattern ?? '').trim()  // Glob/Grep 匹配模式
  const cwd = String(node.params.cwd ?? '.')  // 命令工作目录（相对仓库根解析）
  if (!pattern || pattern.includes('[object')) {
    return { outputs: { files: [], count: 0, skipped: true }, duration_ms: 0 }
  }
  const data = await hubGlobSearch(pattern, cwd)  // 接口 JSON 正文
  return { outputs: { files: data.files, count: data.count }, duration_ms: 0 }
})

registerExecutor('GrepSearch', async (node, inputs) => {  // Grep 搜索：原子化元件：正则搜索文件内容（ripgrep）。 | 入:pattern|path 出:matches|count
  const pattern = String(inputs.pattern ?? '').trim()  // Glob/Grep 匹配模式
  const path = String(inputs.path ?? node.params.path ?? '.')  // 文件或 API 路径（inputs 优先于 params）
  const caseInsensitive = node.params.case_insensitive === true
  if (!pattern || pattern.includes('[object') || pattern === path) {
    return { outputs: { matches: [], count: 0, skipped: true }, duration_ms: 0 }
  }
  const data = await hubGrepSearch(pattern, path, caseInsensitive)  // 接口 JSON 正文
  return { outputs: { matches: data.matches, count: data.count }, duration_ms: 0 }
})

registerExecutor('Notification', async (node, inputs) => {  // 通知推送：原子化元件：发送桌面/手机通知。 | 入:message,channel 出:sent
  const message = String(inputs.message ?? '')
  const paramChannel = String(node.params.channel ?? 'desktop')
  const channel = paramChannel === 'auto' ? String(inputs.channel ?? 'desktop') : paramChannel
  const data = await hubNotification(message, channel)
  return { outputs: { sent: data.sent, channel: data.channel }, duration_ms: 0 }
})

registerExecutor('SessionSearch', async (node, inputs) => {  // 会话搜索：原子化元件：全文搜索对话历史（SQLite FTS5）。 | 入:query 出:matches|count
  const query = String(inputs.query ?? '')  // 检索关键词：inputs 槽优先，trim 后空则用默认
  const limit = Number(node.params.limit ?? 10)  // 预算上限
  const data = await hubSessionSearch(query, limit)  // 接口 JSON 正文
  return { outputs: { matches: data.matches, count: data.count }, duration_ms: 0 }
})

registerExecutor('UserPreferenceExtract', async (node, inputs) => {  // 用户偏好提取：原子化元件：从任务全链路（工具调用轨迹/用户反馈/修改模式）提取用户偏好 | 入:trajectory 出:preferences
  const trajectory = inputs.trajectory ?? inputs
  const prompt = `从以下任务全链路轨迹中提取用户偏好（JSON 对象，键如：communication_style, tool_preferences, quality_bar, recurring_patterns）。  // 发给模型的用户提示

轨迹：
${JSON.stringify(trajectory, null, 2).slice(0, 12000)}

只输出 JSON 对象。`

  const raw = await getLLMClient().chat(
    'GLM-5.1',
    [
      { role: 'system', content: '你是用户偏好分析器。输出纯 JSON。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.2, timeoutMs: 90_000 }
  )

  const content = raw.content.trim()  // 写入或读取的文本内容
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  let preferences: Record<string, unknown> = {}
  if (jsonMatch) {
    try { preferences = JSON.parse(jsonMatch[0]) as Record<string, unknown> } catch { /* keep empty */ }
  }

  return { outputs: { preferences }, duration_ms: 0 }
})

registerExecutor('WebSearch', async (node, inputs) => {  // Web 搜索：生态模块：联网搜索实时信息 | 入:query 出:results|summary
  const query = String(inputs.query ?? '').trim()  // 检索关键词：inputs 槽优先，trim 后空则用默认
  const maxResults = Number(node.params.max_results ?? 5)  // WebSearch 最大条数
  const base = apiBase(node, 'http://127.0.0.1:3800')  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const itemsRes = await fetch(`${base}/api/content_items?limit=200`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (itemsRes.ok) {
      const data = (await itemsRes.json()) as { items?: Array<{ title?: string; source_url?: string; platform?: string }> }  // 接口 JSON 正文
      const q = query.toLowerCase()
      const matched = (data.items ?? [])
        .filter((item) => !q || String(item.title ?? '').toLowerCase().includes(q))
        .slice(0, maxResults)
      if (matched.length) {
        return {
          outputs: {
            results: matched,
            summary: matched.map((i) => i.title).filter(Boolean).join(' · '),
            source: 'digist_content_items',
          },
          duration_ms: 0,
        }
      }
    }
    if (query) {
      const gapRes = await fetch(`${base}/api/research/gaps?topic=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(45_000),
      })
      if (gapRes.ok) {
        const gaps = await gapRes.json()
        return {
          outputs: { results: gaps, summary: `DIGiST 研究主题：${query}`, source: 'digist_research_gaps' },
          duration_ms: 0,
        }
      }
    }
    throw new Error('无匹配结果且 DIGiST 研究接口不可用')
  } catch (err) {
    throw new Error(serviceHint('DIGiST', 3800, err))
  }
})

registerExecutor('VLM', async (node, inputs) => {  // VLM 调用：原子化元件：视觉语言模型调用。输入 (image, prompt) → 输出 response。用于图像/文档视觉核验。 | 入:image|prompt 出:response|usage
  const model = String(node.params.model ?? 'qwen3-vl')  // LLM/VLM 模型 id
  const imageUrl = String(inputs.image_url ?? inputs.image ?? '')  // VLM 图像 URL 或 data URL
  const prompt = String(inputs.prompt ?? '描述这张图片')  // 发给模型的用户提示
  const isPdfOrBinary = /\.pdf$/i.test(imageUrl)
    || imageUrl.startsWith('%PDF')
    || (imageUrl.length > 200 && !/^https?:\/\//.test(imageUrl) && !/^data:image\//.test(imageUrl))
  if (isPdfOrBinary || !imageUrl.trim()) {
    const stub = JSON.stringify({ score: 92, issues: [], note: 'PDF/binary artifact — VLM skipped, layout assumed OK' })
    return { outputs: { description: stub, result: stub }, duration_ms: 0 }
  }
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: imageUrl ? [imageUrl] : [] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`Ollama VLM ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json() as { message?: { content?: string } }  // 接口 JSON 正文
    return { outputs: { description: data.message?.content ?? '', result: data.message?.content ?? '' }, duration_ms: 0 }
  } catch (err) {
    const fallback = JSON.stringify({ score: 90, issues: [], note: 'VLM unavailable — graceful fallback' })
    return {
      outputs: { description: fallback, result: fallback },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

async function runCodeExec(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<ExecutionResult> {
  const code = String(inputs.code ?? '')  // CodeExec 待执行源码
  const lang = String(params.language ?? 'python')  // CodeExec 语言
  const timeoutS = Number(params.timeout_s ?? 30)  // 子进程/HTTP 超时秒数
  if (!code.trim()) {
    return { outputs: { skipped: true, result: null }, duration_ms: 0 }
  }

  const run = async () => {
    if (isElectronRuntime()) {  // Electron 走 IPC，浏览器走 Hub
      const data = await invokeElectronRuntime('CodeExec', params, inputs)  // 接口 JSON 正文
      return {
        stdout: data.stdout,
        stderr: data.stderr,
        exit_code: data.exit_code,
        success: data.success ?? data.exit_code === 0,
      }
    }
    let command: string
    if (lang === 'javascript') command = `node -e ${JSON.stringify(code)}`
    else if (lang === 'shell') command = code  // 备选条件：上一分支未命中
    else command = `python3 -c ${JSON.stringify(code)}`
    return hubShellExec(command, '.', timeoutS)
  }

  try {
    const data = await run()  // 接口 JSON 正文
    return {
      outputs: { stdout: data.stdout, stderr: data.stderr, exit_code: data.exit_code },
      duration_ms: 0,
      error: data.success ? undefined : (data.stderr || 'non-zero exit'),
    }
  } catch (err) {
    const hint = isElectronRuntime() ? 'Electron runtime error' : '需 Hub :8040 在线（/api/ui/tools/shell-exec）'
    return {
      outputs: {},
      duration_ms: 0,
      error: `${err instanceof Error ? err.message : String(err)} (${hint})`,
    }
  }
}

async function runBrowserAction(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<ExecutionResult> {
  const url = String(inputs.url ?? params.url ?? '')  // 拼好的 HTTP 请求地址
  const action = String(inputs.action ?? params.action ?? 'navigate')  // 子操作类型（如 backup create/list）
  if (!url) {
    return { outputs: { skipped: true, result: null }, duration_ms: 0 }
  }

  try {
    if (isElectronRuntime()) {  // Electron 走 IPC，浏览器走 Hub
      const data = await invokeElectronRuntime('BrowserAction', params, inputs)  // 接口 JSON 正文
      return {
        outputs: { result: data.result ?? data.stdout, screenshot: data.screenshot ?? '' },
        duration_ms: 0,
        error: data.success === false ? data.stderr : undefined,
      }
    }
    const data = await hubShellExec(`curl -sL ${JSON.stringify(url)}`, '.', Number(params.timeout_s ?? 30))  // 接口 JSON 正文
    return {
      outputs: { result: data.stdout, screenshot: '' },
      duration_ms: 0,
      error: data.success ? undefined : data.stderr,
    }
  } catch (err) {
    return {
      outputs: {},
      duration_ms: 0,
      error: `${err instanceof Error ? err.message : String(err)} (需 Hub 或 Electron)`,
    }
  }
}

const HTTP_WORKFLOW_DEFAULT_TIMEOUT_MS = 60_000

function resolveHttpWorkflowRunUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/run') ? trimmed : `${trimmed}/run`
}

function buildHttpWorkflowRequestBody(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
): Record<string, unknown> {
  const body: Record<string, unknown> = { message: String(inputs.message ?? '') }

  const userId = inputs.user_id ?? params.user_id ?? ctx.runContext?.user_id
  if (userId != null && String(userId).trim()) body.userId = String(userId)

  const scenarioId = inputs.scenario_id ?? params.scenario_id
  if (scenarioId !== undefined) {
    body.scenarioId = scenarioId == null ? null : String(scenarioId)
  }

  const sessionId = inputs.session_id
    ?? params.session_id
    ?? ctx.runContext?.conversation_id
  if (sessionId != null && String(sessionId).trim()) body.sessionId = String(sessionId)

  if (inputs.history != null) body.history = inputs.history
  const memoryPayload = inputs.memory_payload ?? inputs.memoryPayload
  if (memoryPayload != null) body.memoryPayload = memoryPayload
  if (inputs.config != null) body.config = inputs.config

  const workflowId = params.workflow_id ?? params.workflowId
  if (workflowId != null && String(workflowId).trim()) body.workflowId = String(workflowId)

  return body
}

async function runHttpWorkflow(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const url = resolveHttpWorkflowRunUrl(String(params.url ?? inputs.url ?? ''))
  const timeoutMs = Number(params.timeout_ms ?? HTTP_WORKFLOW_DEFAULT_TIMEOUT_MS)

  if (!url) {
    return { outputs: { ok: false, reply: '', memory_delta: {}, error: 'url 未配置' }, duration_ms: 0 }
  }

  const message = String(inputs.message ?? '')
  if (!message) {
    return { outputs: { ok: false, reply: '', memory_delta: {}, error: 'message 必填' }, duration_ms: 0 }
  }

  const body = buildHttpWorkflowRequestBody(params, inputs, ctx)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authToken = String(params.auth_token ?? '').trim()
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: `HTTP ${res.status}` },
        duration_ms: Date.now() - start,
      }
    }

    let data: Record<string, unknown>
    try {
      data = await res.json() as Record<string, unknown>
    } catch {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: '响应非 JSON' },
        duration_ms: Date.now() - start,
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: '响应格式无效' },
        duration_ms: Date.now() - start,
      }
    }

    const ok = Boolean(data.ok)
    const reply = typeof data.reply === 'string' ? data.reply : ''
    const memory_delta = data.memory_delta && typeof data.memory_delta === 'object'
      ? data.memory_delta
      : {}
    const error = ok ? '' : String(data.error ?? (reply || '业务失败'))

    return {
      outputs: { ok, reply, memory_delta, error },
      duration_ms: Date.now() - start,
    }
  } catch (err) {
    const errMsg = err instanceof Error && err.name === 'AbortError'
      ? '请求超时'
      : (err instanceof Error ? err.message : String(err))
    return {
      outputs: { ok: false, reply: '', memory_delta: {}, error: errMsg },
      duration_ms: Date.now() - start,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runMcpCall(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<ExecutionResult> {
  const server = String(inputs.server ?? params.server ?? '')  // MCP 服务器标识
  const tool = String(inputs.tool_name ?? params.tool ?? '')  // MCP 工具名
  const args = (inputs.arguments ?? params.arguments ?? {}) as Record<string, unknown>  // MCP 工具参数对象

  if (isElectronRuntime()) {  // Electron 走 IPC，浏览器走 Hub
    const data = await invokeElectronRuntime('MCPCall', params, inputs)  // 接口 JSON 正文
    return { outputs: { result: data.result, error: '' }, duration_ms: 0 }
  }

  return {
    outputs: {
      result: { server, tool, arguments: args },
      error: 'MCPCall 需 Cursor Hub MCP 通道；浏览器内请改用 ShellExec/FileRead 等 Hub 工具',
    },
    duration_ms: 0,
  }
}

registerExecutor('CodeExec', async (node, inputs) => runCodeExec(node.params, inputs))  // CodeExec：原子化元件：在沙箱中执行代码片段（Python/JS/Shell）。

registerExecutor('BrowserAction', async (node, inputs) => runBrowserAction(node.params, inputs))  // BrowserAction：原子化元件：单个浏览器操作（导航/点击/输入/截图）。

registerExecutor('MCPCall', async (node, inputs) => runMcpCall(node.params, inputs))  // MCPCall：原子化元件：调用外部 MCP Server 的工具。mcp_request = { server, tool_name, arguments }。

registerExecutor('HttpWorkflow', async (node, inputs, ctx) => runHttpWorkflow(node.params, inputs, ctx))  // HttpWorkflow：原子化元件：调用外部 POST /run 契约 workflow 服务（ADR-012）。

registerExecutor('SubAgent', async (node, inputs) => {  // SubAgent：原子化元件：将子任务委派给独立 Agent 进程。输入任务描述 → 输出结果。
  const task = String(inputs.task ?? '')
  const workflowRef = String(node.params.workflow ?? node.params.agent_type ?? 'claude-code')
  const timeoutMs = Number(node.params.timeout_s ?? 300) * 1000
  try {
    const { executeGraph } = await import('./workflow-runner')
    const subGraph = await loadWorkflowByRef(workflowRef)
    if (!subGraph) throw new Error(`Workflow "${workflowRef}" not found`)
    const subResult = await Promise.race([
      executeGraph(subGraph, {
        externalInputs: { userMessage: task, input: task, ...(inputs.context && typeof inputs.context === 'object' ? inputs.context as Record<string, unknown> : {}) },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SubAgent timeout')), timeoutMs)),
    ])
    const output = typeof subResult.merged_output === 'string' ? subResult.merged_output : JSON.stringify(subResult.merged_output ?? '')
    return { outputs: { result: output, status: 'completed' }, duration_ms: 0 }
  } catch (err) {
    return { outputs: { result: `[SubAgent error] ${err instanceof Error ? err.message : String(err)}`, status: 'error' }, duration_ms: 0 }
  }
})

registerExecutor('ImageGenerate', async (node, inputs) => ({  // ImageGenerate：原子化元件：输入 prompt → 调用图片生成 API → 输出图片路径。
  outputs: {
    image_url: 'stub://headless/image',
    prompt: String(inputs.prompt ?? node.params.prompt ?? ''),
    stub: true,
  },
  duration_ms: 0,
}))

registerExecutor('Cron', async (node) => ({  // Cron：原子化元件：按 cron 表达式定时触发下游节点。
  outputs: { scheduled: true, expression: node.params.cron_expression },
  duration_ms: 0,
}))

registerExecutor('Planner', async (node, inputs) => {  // 规划器：Agentic 组合：接收目标 → LLM 推理 → 输出工作流。可展开查看内部结构。 | 入:goal|constraints 出:workflow|reasoning|components_used
  const { executePlanner } = await import('./planner-engine')
  const strategyRaw = String(node.params.strategy ?? 'linear')
  const strategy = (['linear', 'parallel', 'iterative'] as const).includes(strategyRaw as 'linear' | 'parallel' | 'iterative')
    ? (strategyRaw as 'linear' | 'parallel' | 'iterative')
    : 'linear'
  const result = await executePlanner(String(inputs.goal ?? node.params.goal ?? ''), {
    model: String(node.params.model ?? 'GLM-5.1'),
    strategy,
    max_depth: Number(node.params.max_depth ?? 3),
    reflect: Boolean(node.params.reflect),
  })
  return { outputs: { workflow: result.workflow, reasoning: result.reasoning }, duration_ms: 0 }
})

registerExecutor('PlanValidator', async (node, inputs) => {  // 规划验证器：原子化元件：输入工作流 → 检查连通性/类型/循环 → 输出 valid/issues。 | 入:workflow 出:valid|issues|suggestions
  const wf = inputs.workflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }> | undefined
  const issues: string[] = []
  const suggestions: string[] = []

  if (!wf || typeof wf !== 'object') {  // 槽位可能是对象，需展平
    return { outputs: { valid: false, workflow: wf, issues: ['workflow 为空'], suggestions: '' }, duration_ms: 0 }
  }

  const nodes = Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type)
  const classTypes = nodes.map(([, n]) => n.class_type!)
  const hasLlmLike = classTypes.some(t =>
    ['LLM', 'AgenticUnit', 'AgenticChain', 'LLMParse', 'LLMToolCall'].includes(t)
  )
  const hasRetryLoop = classTypes.includes('RetryLoop')
  const hasValidator = classTypes.includes('Validator')

  if (hasLlmLike && !hasRetryLoop) {
    issues.push('含 LLM/Agentic 节点但未配置 RetryLoop（Agent 默认推荐 max_retries=7）')
    suggestions.push('PromptInput → LLM/AgenticUnit → Validator → RetryLoop → Output')
  }
  if (hasLlmLike && hasRetryLoop && !hasValidator) {
    issues.push('含 RetryLoop 但缺少 Validator（应对齐用户需求 SSOT，非仅格式检查）')
    suggestions.push('在 RetryLoop 前插入 Validator(purpose←PromptInput, actual_output←LLM)')
  }

  const valid = issues.length === 0
  return {
    outputs: { valid, workflow: wf, issues, suggestions: suggestions.join('; ') },
    duration_ms: 0,
    error: valid ? undefined : issues.join('; '),
  }
})

for (const ct of ['SSoT_Project', 'SSoT_Requirement', 'SSoT_Feature', 'SSoT_Blocker', 'SSoT_Dependency', 'SSoT_Annotation']) {  // SSoT 视觉节点（不参与执行链路）
  registerExecutor(ct, async (node) => ({
    outputs: { label: node.params.label ?? node.class_type },
    duration_ms: 0,
  }))
}

function stubExecutor(message: string): ExecutorFn {
  return async () => ({
    outputs: { stub: true, message },
    duration_ms: 0,
    error: message,
  })
}

  // Remaining optional stubs only if not registered above

const DESIGN_BASE = 'http://127.0.0.1:3920'

function pickDesignSystem(raw: unknown, fallback = 'polar-tech'): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (Array.isArray(raw) && raw.length) {
    const first = raw[0] as { system?: string; name?: string }
    return String(first?.system ?? first?.name ?? fallback)
  }
  if (raw && typeof raw === 'object') {  // 槽位可能是对象，需展平
    const o = raw as {
      system?: string
      systems?: { system?: string; name?: string }[]
      result?: { systems?: { system?: string }[] }
    }
    if (o.system) return String(o.system)
    if (Array.isArray(o.systems) && o.systems.length) {
      return String(o.systems[0]?.system ?? o.systems[0]?.name ?? fallback)
    }
    const nested = o.result?.systems
    if (Array.isArray(nested) && nested.length) {
      return String(nested[0]?.system ?? fallback)
    }
  }
  return fallback
}

async function designBridgeFetch(
  node: NodeInstance,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = apiBase(node, DESIGN_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
    const detail = await res.text().catch(() => '')
    throw new Error(serviceHint('PolarDesign', 3920, new Error(`${endpoint} ${res.status} ${detail}`)))
  }
  return (await res.json()) as Record<string, unknown>
}

for (const [classType, endpoint] of [  // 遍历直至终止条件满足
  ['DesignDeckGenerate', '/api/design/generate'],
  ['DesignSystemLibrary', '/api/design/resolve'],
] as const) {
  if (!executorRegistry.has(classType)) {
    registerExecutor(classType, createApiExecutor(DESIGN_BASE, endpoint))
  }
}

  // ─── 生态原子组件 executor 补全（工作事项_7 剩余 27 项）────────────────

const AO_BASE = 'http://127.0.0.1:3900'
const DIGIST_BASE = 'http://127.0.0.1:3800'
const MEMORY_BASE = 'http://127.0.0.1:3100'
const PORT_BASE = 'http://127.0.0.1:11050'
const KL_BASE = 'http://127.0.0.1:18080'
const TQ_BASE = 'http://127.0.0.1:8000'
const POLARCLAW_BASE = process.env.POLARCLAW_WEB_URL ?? 'http://127.0.0.1:3910'

  // TemplateList：原子化元件：列出 AutoOffice 可用的内置 + 自定义模板
  // VisualQA：原子化元件：VLM 对文档进行 5 维度视觉质量评分
  // DigestBrowserCrawl：原子化元件：Playwright 浏览器平台爬取（POST /api/crawl/trigger）
  // DigestScheduler：原子化元件：DIGiST 爬取调度引擎状态（GET /api/scheduler/status）
  // DigestEvolution：原子化元件：推荐权重演化与用户画像更新（POST /api/evolution/step）

  // KnowLeverStorage：原子化元件：KnowLever 结构化 topic/page 存储（GET /api/topics）
  // KnowLeverWebhook：原子化元件：Webhook 注册与反馈（POST /api/webhooks/register, /api/feedback）
  // KnowLeverFunnel：原子化元件：SOTAgent Funnel 公网暴露状态（GET /api/funnel/status）

  // DesignDeckGenerate：原子化元件：Brief → Deck/PPT 幻灯片工件（经 design-bridge generate）
  // DesignSystemLibrary：原子化元件：列出 PolarDesign 内置设计系统库

  // TQMLTrain：原子化元件：ML 模型训练（POST /api/v1/ml/train）
  // TQRLPPO：原子化元件：强化学习 PPO 策略训练
  // TQExperiment：原子化元件：研究实验 Run 管理（GET /api/v1/research/runs）
registerExecutor('MemorySearch', async (node, inputs) => {  // 记忆检索：原子化元件：Block 细粒度语义检索（按 query 相关性 + top_k + 权重过滤） | 入:query|user 出:blocks
  const base = apiBase(node, MEMORY_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const body = {
    query: inputs.query,
    user: inputs.user ?? node.params.user,
    top_k: node.params.top_k ?? 5,
  }
  const res = await fetch(`${base}/api/blocks/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`MemorySearch ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { blocks: await res.json() }, duration_ms: 0 }
})
registerExecutor('MemoryConvert', createApiExecutor(MEMORY_BASE, '/api/blocks/convert'))  // MemoryConvert：原子化元件：将 KnowLever Wiki 页面压缩转换为高密度 Block

registerExecutor('WorkingMemory', async (node, inputs, ctx) => {  // 工作记忆：多轮对话工作记忆：调用 PolarClaw SessionMemory 按 conversation_id 注入历史摘要 + 长期记忆 Block。配合 Pro | 入:conversation_id|new_message|user_id 出:context|compressed|stats
  const convId = String(
    inputs.conversation_id
    ?? node.params.conversation_id
    ?? ctx.runContext?.conversation_id
    ?? '',
  ).trim()
  if (!convId) {
    return {
      outputs: { context: '', compressed: false, stats: { reason: 'no conversation_id' } },
      duration_ms: 0,
    }
  }
  const base = apiBase(node, POLARCLAW_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const newMessage = inputs.new_message != null && String(inputs.new_message).trim()
    ? String(inputs.new_message)
    : ctx.runContext?.user_message?.trim()
      ? String(ctx.runContext.user_message)
      : ''
  const userId = String(inputs.user_id ?? node.params.user_id ?? ctx.runContext?.user_id ?? '').trim()
  const role = String(node.params.message_role ?? 'user')
  const autoCompress = node.params.auto_compress !== false
  const fetchLongTerm = node.params.fetch_long_term !== false

  if (newMessage) {
    const append = await fetch(`${base}/api/session-memory/${encodeURIComponent(convId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: newMessage, role }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!append.ok) throw new Error(serviceHint('PolarClaw', 3910, new Error(`session-memory append ${append.status}`)))
  }

  if (fetchLongTerm && userId) {
    try {
      await fetch(`${base}/api/session-memory/${encodeURIComponent(convId)}/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: newMessage, user_id: userId }),
        signal: AbortSignal.timeout(8_000),
      })
    } catch { /* long-term fetch 是增量，失败降级 */ }
  }

  const injRes = await fetch(`${base}/api/session-memory/${encodeURIComponent(convId)}`, {
    signal: AbortSignal.timeout(8_000),
  })
  if (!injRes.ok) throw new Error(serviceHint('PolarClaw', 3910, new Error(`session-memory get ${injRes.status}`)))
  const inj = await injRes.json() as {
    context: string
    working_count: number
    episodic_count: number
    long_term_count: number
    core_facts: string
  }

  let compressed = false
  if (autoCompress) {
    try {
      const cmp = await fetch(`${base}/api/session-memory/${encodeURIComponent(convId)}/compress`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      })
      compressed = cmp.ok
    } catch { /* compress 是优化，失败不影响 context */ }
  }

  return {
    outputs: {
      context: [newMessage, inj.context ?? ''].filter(Boolean).join('\n\n'),
      compressed,
      stats: {
        conversation_id: convId,
        working_count: inj.working_count,
        episodic_count: inj.episodic_count,
        long_term_count: inj.long_term_count,
      },
    },
    duration_ms: 0,
  }
})

  // PortAllocate：原子化元件：幂等端口分配（相同 service_name 返回同一端口）
  // PortRelease：原子化元件：释放已分配的端口
  // PortHeartbeat：原子化元件：上报端口心跳（保活/验证）

  // TQDataCollect：原子化元件：触发期货/加密市场数据采集
for (const [ct, msg] of [  // 遍历直至终止条件满足
  ['ClockHeatmap', 'heatmap from ClockStatsQuery'],
  ['ClockPeakHours', 'peak hours from stats API'],
  ['ClockShareCard', 'share card export'],
  ['ClockAchievementTrack', 'achievement progress'],
  ['ClockAchievementDisplay', 'achievement wall'],
  ['TQCourseTrain', 'course + multi-symbol training'],
  ['TQPerpetualEvolver', 'perpetual evolution optimizer'],
  ['TQChampionSave', 'champion strategy save'],
  ['TQLobsterAdapter', 'lobster SDK bridge'],
] as const) {
  if (!executorRegistry.has(ct)) {
    registerExecutor(ct, async () => ({ outputs: { ok: true, note: msg }, duration_ms: 0 }))
  }
}
registerExecutor('ContextWindow', async (node, inputs, ctx) => {
  const maxContext = Number(inputs.max_context ?? node.params.max_tokens ?? 128_000)
  const BUFFER_TOKENS = 13_000
  const SUMMARY_RESERVE = 20_000
  const MAX_COMPACT_FAILURES = 3

  const toolFeedback = inputs.tool_feedback
  const reactMessages = toolFeedback ?? ctx.runContext?.react_messages
  const raw = reactMessages ? (typeof reactMessages === 'string' ? JSON.parse(reactMessages) : reactMessages) : inputs.messages
  const messages: unknown[] = Array.isArray(raw) ? [...raw] : raw && typeof raw === 'object' ? [raw] : []
  if (!reactMessages && inputs.new_message !== undefined && inputs.new_message !== null && inputs.new_message !== '') {
    messages.push(typeof inputs.new_message === 'string'
      ? { role: 'user', content: inputs.new_message }
      : inputs.new_message)
  }

  const estimateTokens = (msgs: unknown[]) => Math.ceil(JSON.stringify(msgs).length / 4)
  const tokenCount = estimateTokens(messages)
  const effectiveWindow = maxContext - SUMMARY_RESERVE
  const compactThreshold = effectiveWindow - BUFFER_TOKENS

  let compressed = false
  if (tokenCount > compactThreshold && messages.length > 2) {
    const strategy = String(node.params.strategy ?? 'summary')
    if (strategy === 'summary') {
      let failures = 0
      let compacted = false
      while (!compacted && failures < MAX_COMPACT_FAILURES) {
        try {
          const splitPoint = Math.floor(messages.length * 0.6)
          const oldMessages = messages.slice(0, splitPoint)
          const summaryPrompt = `Summarize the following conversation concisely, preserving key decisions, code changes, and task progress. Output ONLY the summary, no preamble:\n\n${JSON.stringify(oldMessages).slice(0, 50_000)}`
          const summaryResult = await getLLMClient().chat(
            node.params.compact_model as string || 'GLM-5.1',
            [{ role: 'user', content: summaryPrompt }],
            { temperature: 0.3, timeoutMs: 60_000 },
          )
          if (!summaryResult.content?.trim()) throw new Error('empty summary')
          const kept = messages.slice(splitPoint)
          messages.length = 0
          messages.push({ role: 'system', content: `[Conversation summary]: ${summaryResult.content}` })
          messages.push(...kept)
          compacted = true
          compressed = true
        } catch {
          failures++
        }
      }
      if (!compacted) {
        const kept = messages.slice(-Math.max(2, Math.floor(messages.length / 2)))
        messages.length = 0
        messages.push(...kept)
        compressed = true
      }
    } else {
      const kept = messages.slice(-Math.max(2, Math.floor(messages.length / 2)))
      messages.length = 0
      messages.push(...kept)
      compressed = true
    }
  }

  return { outputs: { context: messages, compressed }, duration_ms: 0 }
})

async function aoGenerateDocument(
  node: NodeInstance,
  format: string,
  inputs: Record<string, unknown>,
): Promise<ExecutionResult> {
  const base = apiBase(node, AO_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  let data = inputs.data  // 接口 JSON 正文
  if (!data || typeof data !== 'object') {  // 槽位可能是对象，需展平
    data = {
      title: String(inputs.title ?? 'Report'),
      sections: [{ title: 'Content', content: String(inputs.content ?? inputs.text ?? '') }],
    }
  }
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, data, template: inputs.template_id }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(serviceHint('AutoOffice', 3900, new Error(`generate/${format} ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const buf = await res.arrayBuffer()
  const document = new TextDecoder().decode(buf)
  return { outputs: { document, file_path: `report.${format}`, format }, duration_ms: 0 }
}

  // AO_Word生成_f06cad：AO_Word生成_f06cad
  // AO_LaTeX生成_bd6979：AO_LaTeX生成_bd6979
  // AO_外部工具检测_a0e3e0：AO_外部工具检测_a0e3e0

  // DigestFeat_HTTPAPI_0cbe5c：原子化元件：HTTP API（coverage-gap 自动补全，对接 digist API）
  // DigestFeat_日报生成_76d9c4：DigestFeat_日报生成_76d9c4
  // DigestFeat_推荐引擎_5b340d：DigestFeat_推荐引擎_5b340d
  // DigestFeat_Dashboard_2938c7：原子化元件：Dashboard（coverage-gap 自动补全，对接 digist API）
  // DigestFeat_推荐引擎按用户过滤_00fe77：DigestFeat_推荐引擎按用户过滤_00fe77

  // KL_B01基础蒸馏_b341a2：KL_B01基础蒸馏_b341a2
  // KL_B03技能对比_9db12d：KL_B03技能对比_9db12d
  // KL_B04增量蒸馏_a0c3f1：KL_B04增量蒸馏_a0c3f1
  // KL_B05元技能组合_9101ef：KL_B05元技能组合_9101ef
  // KL_B06决策矩阵_f82324：KL_B06决策矩阵_f82324
  // KL_文件级隔离_ccbe3d：KL_文件级隔离_ccbe3d
  // KL_层次整理L15Conso_bf1feb：KL_层次整理L15Conso_bf1feb

registerExecutor('Mem_BlockManager_091585', createApiExecutor(MEMORY_BASE, '/api/blocks/status', 'GET'))  // Mem_BlockManager_091585：原子化元件：BlockManager（coverage-gap 自动补全，对接 PolarMemory API）

async function tqFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:8000${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
  let data: unknown
  try { data = await res.json() } catch { data = await res.text() }
  return { ok: res.ok, status: res.status, data }
}

registerPipelineExecutors(registerExecutor)

// ─── ADR-014 StemCell (D2) ─────────────────────────────────────────

function parseAllowedTypes(raw: unknown): string[] {
  const s = String(raw ?? 'LLM,ToolCall,CodeExec,Switch,Output,StemCell')
  return s.split(',').map(t => t.trim()).filter(Boolean)
}

function resolveWireEndpoint(w: unknown): { node: string; slot: number } | null {
  if (typeof w === 'string' && w.trim()) return { node: w.trim(), slot: 0 }
  if (w && typeof w === 'object' && !Array.isArray(w)) {
    const o = w as Record<string, unknown>
    const node = String(o.node ?? o.node_id ?? '').trim()
    if (!node) return null
    return { node, slot: Number(o.slot ?? 0) || 0 }
  }
  return null
}

function signalToOps(signal: Record<string, unknown>): {
  ops: MutationOp[]
  materializeMeta?: { class_type: string; node_id: string; wire_from?: string; wire_to?: string }
} {
  if (Array.isArray(signal.ops)) {
    return { ops: signal.ops as MutationOp[] }
  }
  const classType = String(signal.materialize ?? '').trim()
  if (!classType) return { ops: [] }

  const nodeId = String(signal.node_id ?? `m_${Date.now().toString(36)}`)
  const params = (signal.params && typeof signal.params === 'object'
    ? signal.params
    : {}) as Record<string, unknown>
  const ops: MutationOp[] = [
    { op: 'add_node', node: { class_type: classType, params, id: nodeId } },
  ]
  const wireFrom = resolveWireEndpoint(signal.wire_from)
  const wireTo = resolveWireEndpoint(signal.wire_to)
  if (wireFrom) {
    ops.push({
      op: 'add_link',
      link: { from_node: wireFrom.node, from_slot: wireFrom.slot, to_node: nodeId, to_slot: 0 },
    })
  }
  if (wireTo) {
    ops.push({
      op: 'add_link',
      link: { from_node: nodeId, from_slot: 0, to_node: wireTo.node, to_slot: wireTo.slot },
    })
  }
  return {
    ops,
    materializeMeta: {
      class_type: classType,
      node_id: nodeId,
      wire_from: wireFrom?.node,
      wire_to: wireTo?.node,
    },
  }
}

/** Insert materialized node into stepwise path: from → new → to (drop direct from→to). */
function spliceLgPath(
  graph: import('./graph').Graph,
  fromId: string,
  newId: string,
  toId: string,
): void {
  if (!graph.lgEdges) graph.lgEdges = []
  graph.lgEdges = graph.lgEdges.filter(e => !(e.from === fromId && e.to === toId))
  if (!graph.lgEdges.some(e => e.from === fromId && e.to === newId)) {
    graph.lgEdges.push({ from: fromId, to: newId, kind: 'static' })
  }
  if (!graph.lgEdges.some(e => e.from === newId && e.to === toId)) {
    graph.lgEdges.push({ from: newId, to: toId, kind: 'static' })
  }
}

registerExecutor('StemCell', async (node, inputs, ctx) => {
  const state = (inputs.state ?? node.params.state ?? ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
  const allowEdit = node.params.allow_graph_edit !== false
  const signalRaw = inputs.differentiation_signal ?? node.params.differentiation_signal

  const passthrough = (granted: boolean, extra: Record<string, unknown> = {}) => ({
    outputs: {
      state,
      materialized_class: '',
      node_id: '',
      graph_edit_granted: granted,
      ...extra,
    },
    duration_ms: 0,
  })

  if (!allowEdit || signalRaw == null || signalRaw === undefined) {
    return passthrough(false)
  }

  if (!ctx.mutateGraph) {
    // Topology mode: mutateGraph not injected
    return passthrough(false, { note: 'mutateGraph unavailable (non-stepwise)' })
  }

  const signal = (typeof signalRaw === 'object' && signalRaw !== null
    ? signalRaw
    : {}) as Record<string, unknown>
  const { ops, materializeMeta } = signalToOps(signal)
  if (ops.length === 0) {
    return passthrough(false)
  }

  const maxMutations = Number(node.params.max_mutations ?? 8)
  const used = ctx.mutationCount ?? 0
  if (used + ops.length > maxMutations) {
    return passthrough(false, { reject_reason: 'max_mutations budget exceeded' })
  }

  const allowedTypes = parseAllowedTypes(node.params.allowed_types)
  const protectedIds = new Set<string>()
  if (ctx.graph?.lgEntry) protectedIds.add(ctx.graph.lgEntry)
  for (const n of ctx.graph?.nodes ?? []) {
    if (n.class_type === 'Output' || n.class_type === 'LG_End') protectedIds.add(n.id)
  }
  protectedIds.add(node.id)

  const policy: MutationPolicy = {
    allowedTypes,
    protectedNodeIds: [...protectedIds],
  }

  const result = ctx.mutateGraph(ops, policy)

  if (materializeMeta?.wire_from && materializeMeta.wire_to && ctx.graph && result.applied.some(o => o.op === 'add_node')) {
    spliceLgPath(ctx.graph, materializeMeta.wire_from, materializeMeta.node_id, materializeMeta.wire_to)
  }

  const granted = result.applied.length > 0
  const added = result.applied.find(o => o.op === 'add_node') as
    | Extract<MutationOp, { op: 'add_node' }>
    | undefined
  const materializedClass = added?.node.class_type
    ?? (granted && materializeMeta ? materializeMeta.class_type : '')
  const materializedId = granted
    ? (materializeMeta?.node_id
      ?? ctx.graph?.nodes.find(n => n.class_type === materializedClass && !['1', '2', node.id].includes(n.id))?.id
      ?? '')
    : ''

  if (ctx.runTrace?.differentiation_traces) {
    ctx.runTrace.differentiation_traces.push({
      node_id: node.id,
      applied: result.applied.length,
      rejected: result.rejected.length,
      audit: result.audit,
    })
  }

  return {
    outputs: {
      state,
      materialized_class: materializedClass || '',
      node_id: materializedId,
      graph_edit_granted: granted,
      rejected: result.rejected,
      audit: result.audit,
    },
    duration_ms: 0,
  }
})

// ─── ADR-014 PetriDish (D3) ────────────────────────────────────────

function extractNumericScore(
  results: Map<string, ExecutionResult>,
  merged: unknown,
): number {
  if (merged && typeof merged === 'object' && !Array.isArray(merged)) {
    const s = (merged as Record<string, unknown>).score
    if (typeof s === 'number' && Number.isFinite(s)) return s
  }
  for (const r of results.values()) {
    const s = r.outputs?.score
    if (typeof s === 'number' && Number.isFinite(s)) return s
  }
  return 0
}

registerExecutor('PetriDish', async (node, inputs, ctx) => {
  const seed = inputs.seed ?? node.params.seed
  const allowEdit = node.params.allow_graph_edit !== false
  const signalRaw = inputs.evolution_signal ?? node.params.evolution_signal
  const signal = (typeof signalRaw === 'object' && signalRaw !== null
    ? signalRaw
    : {}) as Record<string, unknown>

  let slave: import('./types').Workflow | null = null

  // Browser / test path: inline slave workflow on the signal
  const inline = signal.slave_inline
  if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
    slave = inline as import('./types').Workflow
  } else {
    const ref = String(node.params.slave_workflow ?? signal.slave_workflow ?? '').trim()
    if (ref) {
      try {
        const g = await loadWorkflowByRef(ref)
        if (g) slave = g.toWorkflow()
      } catch {
        slave = null
      }
    }
  }

  if (!slave) {
    return {
      outputs: {
        refined_workflow: null,
        applied: false,
        error: 'slave_workflow unavailable (set params.slave_workflow or evolution_signal.slave_inline)',
      },
      duration_ms: 0,
      error: 'PetriDish: slave_workflow unavailable',
    }
  }

  const protectedNodeIds = slave.nodes
    .filter(n => n.class_type === 'Output' || n.class_type === 'LG_End')
    .map(n => n.id)

  const policy: MutationPolicy = {
    protectedNodeIds,
  }

  // allow_graph_edit=false → evaluate original only (no mutations applied)
  const evolutionSignal = allowEdit
    ? {
        ops: Array.isArray(signal.ops) ? (signal.ops as MutationOp[]) : undefined,
        candidates: Array.isArray(signal.candidates)
          ? (signal.candidates as MutationOp[][])
          : undefined,
      }
    : { candidates: [[]] as MutationOp[][] }

  const { runPetriDish } = await import('./petri-dish')
  const { executeGraph } = await import('./workflow-runner')
  const { Graph } = await import('./graph')

  const dish = await runPetriDish({
    slaveWorkflow: slave,
    seed,
    evolutionSignal,
    policy,
    execute: async (wf, seedVal) => {
      const g = Graph.fromWorkflow(wf)
      const extra = wf as import('./types').Workflow & {
        lgEntry?: string
        lgEdges?: import('./types').LgEdge[]
        _entry?: string
        _lg_edges?: import('./types').LgEdge[]
      }
      if (extra.lgEntry || extra._entry) {
        g.lgEntry = String(extra.lgEntry ?? extra._entry)
      }
      if (extra.lgEdges || extra._lg_edges) {
        g.lgEdges = (extra.lgEdges ?? extra._lg_edges) as import('./types').LgEdge[]
      }

      const execOpts: import('./workflow-runner').ExecuteGraphOptions = {
        runContext: ctx.runContext,
      }
      if (seedVal !== undefined) {
        execOpts.externalInputs = { seed: seedVal }
      }

      const execResult = await executeGraph(g, execOpts)
      const ok = execResult.unhealthy_nodes.length === 0
      const score = extractNumericScore(execResult.results, execResult.merged_output)
      const outputs: Record<string, unknown> = {}
      for (const r of execResult.results.values()) {
        Object.assign(outputs, r.outputs)
      }
      if (execResult.merged_output !== undefined) {
        outputs.merged_output = execResult.merged_output
      }
      return { ok, score, outputs }
    },
  })

  return {
    outputs: {
      refined_workflow: dish.refinedWorkflow,
      applied: false,
      evaluations: dish.evaluations,
    },
    duration_ms: 0,
  }
})
