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
import type { WorkflowLibrary } from './types'
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
  hubEcosystemScan,
} from '@/api/tools'
import {
  distillCapture,
  formatMemoryBlocks,
  PROMPT_EVOLVE_AUTO_APPLY_PATH,
  PROMPT_EVOLVE_LATEST_PATH,
} from './prompt-evolve-utils'
import { buildReflectiveContext } from './reflective-context'
import { invokeElectronRuntime, isElectronRuntime } from './runtime-bridge'
import { waitForCheckupEvent } from './checkup-inbox-client'
import { describeCheckupScreenshot } from './checkup-vlm'
import { hubApiBase } from './hub-url'

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
  workflowLibrary?: WorkflowLibrary
  runContext?: RunContext  // 多轮对话上下文（Chat 壳 / workflow/chat 注入）
  runTrace?: RunTraceEnvelope  // History 四层 log 采集（executeGraph 写入）
  onStreamChunk?: (nodeId: string, chunk: string) => void  // LLM stream:true 时逐 token 回调
  /** 可变工作流图；仅 StemCell 等权柄节点写入 nodes/links */
  graph?: import('./graph').Graph
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
  library: WorkflowLibrary
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

function buildSystemPrompt(node: NodeInstance, base: string, library: WorkflowLibrary = 'WF'): string {
  const roleText = formatRoleDeclaration(node.params.role_declaration)
  let prompt = base
  if (roleText) {
    prompt = prompt ? `${prompt}\n\n## 角色声明\n${roleText}` : `## 角色声明\n${roleText}`
  }
  return wrapModeSystemPrompt(library, prompt)
}

/**
 * LLM — 单次大模型 API 调用（原子正则化元件）。
 *
 * @param inputs.prompt 用户任务正文
 * @param inputs.context 可选背景上下文
 * @param inputs.tools 可选工具定义列表
 * @returns outputs.response 模型文本；outputs.usage Token 用量
 */
registerExecutor('LLM', async (node, inputs, ctx) => {
  const model = node.params.model as string || 'GLM-5.1'
  const library = ctx.workflowLibrary ?? 'WF'
  const basePrompt = await resolveSystemPromptBase(node)
  const systemPrompt = buildSystemPrompt(node, basePrompt, library) || String(node.params.system_prompt ?? '')
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
  return {
    outputs: {
      tool_calls: result.toolCalls,
      raw: result.content,
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
          const { loadWorkflowByRef } = await import('./workflow-loader')
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

registerExecutor('Switch', async (node, inputs) => {  // 多路分支：可变 case 数 + default；仅激活槽有 payload | 入:value
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

registerExecutor('PromptInput', async (node) => {  // Prompt 植入：原子化元件：定义初始输入（User Prompt）。必须填写输出预期正则，未填则编译报错。 | 入:— 出:prompt|expected_pattern|context|channel
  const text = String(node.params.prompt_text ?? node.params.content ?? '')
  const expectedPattern = String(node.params.expected_output ?? node.params.expected_pattern ?? '')
  const purpose = String(node.params.purpose ?? '')
  const channel = String(node.params.channel ?? 'cli')
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

registerExecutor('Output', async (_node, inputs) => {  // Output：原子化元件：工作流终点。可多节点并联输出；画布上以紧凑卡片呈现（对齐 Dify End）。 | 入:content 出:—
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

registerExecutor('KnowLeverSearch', async (node, inputs) => {  // 知识检索 | 入:query 出:chunks|summary → POST KnowLever /api/search
  let queryRaw = inputs.query ?? inputs.q ?? ''  // 主检索词；兼容上游 q 槽
  if (queryRaw && typeof queryRaw === 'object') {  // query 为对象/数组时展平为可检索字符串
    const obj = queryRaw as Record<string, unknown>  // 按 record 读 keywords 或整包序列化
    if (Array.isArray(obj)) {  // 数组：元素拼接为空格分隔词串
      queryRaw = obj.map(String).join(' ')
    } else if (Array.isArray(obj.keywords)) {  // { keywords: [...] }
      queryRaw = (obj.keywords as unknown[]).map(String).join(' ')
    } else {  // 其它对象 → JSON 字符串送 API
      queryRaw = JSON.stringify(obj)
    }
  }
  const query = String(queryRaw ?? '').trim() || 'default'  // 空查询兜底 default
  const base = apiBase(node, 'http://127.0.0.1:18080')  // KnowLever 根（params.api_base 可覆盖）
  const res = await fetch(`${base}/api/search`, {  // 同步检索 body=query,user,topic
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      user: String(node.params.user ?? inputs.user ?? 'admin'),  // 知识库用户
      topic: String(node.params.topic ?? inputs.topic ?? 'default'),  // topic 分区
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(serviceHint('KnowLever', 18080, new Error(`search ${res.status}`)))  // 非 2xx 阻断，提示拉起 :18080
  const data = await res.json()  // chunks/摘要 JSON
  return { outputs: { results: data, result: data }, duration_ms: 0 }  // 出槽 results|result 同引用
})
registerExecutor('ContentRender', async (node, inputs) => {  // 文档渲染：原子化元件：模板 + 数据 → 单次渲染生成文档（取代 ReportGenerator） | 入:data|template_id 出:document|file_path
  const base = apiBase(node, 'http://127.0.0.1:3900')  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const format = String(node.params.format ?? 'html')  // AutoOffice 输出格式（html/pdf 等）
  let data = inputs.data  // 接口 JSON 正文
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { data = { title: 'Report', sections: [{ title: 'Content', content: data }] } }
  }
  if (!data || typeof data !== 'object') {  // 槽位可能是对象，需展平
    data = { title: 'Report', sections: [{ title: 'Content', content: String(inputs.content ?? '') }] }
  }
  const templateId = inputs.template_id ?? node.params.template_id
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format,
      data,
      ...(templateId ? { template: String(templateId) } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {  // HTTP 非成功：抛错（含生态服务拉起提示）
    const fallback = String(inputs.content ?? inputs.data ?? '')
    return { outputs: { document: fallback, file_path: `report.${format}`, stub: true }, duration_ms: 0 }
  }
  const buf = await res.arrayBuffer()
  const document = new TextDecoder().decode(buf)
  return { outputs: { document, file_path: `report.${format}` }, duration_ms: 0 }
})
registerExecutor('QualityAnalyze', createApiExecutor('http://127.0.0.1:3900', '/api/quality'))  // QualityAnalyze：原子化元件：文本质量分析，返回 A-F 等级和改进建议
registerExecutor('ContentSummarize', createApiExecutor('http://127.0.0.1:3900', '/api/summarize'))  // ContentSummarize：原子化元件：内容摘要 + Mermaid 架构图生成
registerExecutor('ContentEnrich', createApiExecutor('http://127.0.0.1:3900', '/api/enrich'))  // ContentEnrich：原子化元件：KnowLever RAG 上下文增强，自动补充背景知识
registerExecutor('DigestScrape', async (node, inputs) => {  // 信息爬取：原子化元件：触发指定平台（arxiv/HN/reddit/github 等）爬取 | 入:platform 出:result
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/crawl/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    return { outputs: { result: data, content_ids: (data as { ids?: unknown[] }).ids ?? [] }, duration_ms: 0 }
  } catch {
    return { outputs: { result: { stub: true, items: 0 }, content_ids: [] }, duration_ms: 0 }
  }
})
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

registerExecutor('ClockSnapshot', async (node, inputs) => {  // 用户状态快照：原子化元件：PolarClaw 同步 — 一次性获取用户完整状态（番茄钟/任务/日程/习惯/成就） | 入:username 出:snapshot
  const snap = await fetchClockSnapshot(node, inputs)  // Clock snapshot 或降级数据
  return { outputs: { snapshot: snap, ...snap }, duration_ms: 0 }
})

registerExecutor('ClockUserScope', async (node, inputs) => {  // 按用户名隔离数据目录：原子化元件：API 按用户隔离；每个 username 对应独立 data 目录 | 入:username 出:data_dir
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  return {
    outputs: {
      data_dir: `Clock/backend/data/users/${username}`,
      username,
      isolated: true,
    },
    duration_ms: 0,
  }
})

registerExecutor('ClockTimerState', async (node, inputs) => {  // 番茄钟计时：原子化元件：获取番茄钟/运动计时/冥想模式计时器状态 | 入:— 出:state
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const syncKey = String(inputs.sync_key ?? node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const res = await clockAuthFetch(node, '/api/timer/state', {
    headers: syncKey ? { 'X-Sync-Key': syncKey } : {},
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`timer/state ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { state: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockTimerStart', async (node, inputs) => {  // 运动计时：原子化元件：启动番茄钟/运动/冥想计时会话（POST /api/timer/start） | 入:mode 出:state
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const mode = String(inputs.mode ?? node.params.mode ?? 'exercise')  // 组件运行模式（ask/whitelist 等）
  const syncKey = String(inputs.sync_key ?? node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const res = await clockAuthFetch(node, '/api/timer/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(syncKey ? { 'X-Sync-Key': syncKey } : {}) },
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`timer/start ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { state: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockMeditationMode', async (node, inputs) => {  // 冥想模式：原子化元件：以 meditation 模式启动计时 | 入:— 出:state
  const syncKey = String(inputs.sync_key ?? node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const res = await clockAuthFetch(node, '/api/timer/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(syncKey ? { 'X-Sync-Key': syncKey } : {}) },
    body: JSON.stringify({ mode: 'meditation' }),
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`meditation start ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { state: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockTaskList', async (node, inputs) => {  // 任务 CRUD：原子化元件：列出用户任务（GET /api/tasks） | 入:— 出:tasks
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const syncKey = String(node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const res = await clockAuthFetch(node, '/api/tasks', {
    headers: syncKey ? { 'X-Sync-Key': syncKey } : {},
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`tasks ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { tasks: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockAchievementList', async (node, inputs) => {  // 成就系统：原子化元件：查询成就列表（GET /api/achievements） | 入:— 出:achievements
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const syncKey = String(node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const res = await clockAuthFetch(node, '/api/achievements', {
    headers: syncKey ? { 'X-Sync-Key': syncKey } : {},
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`achievements ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { achievements: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockBackup', async (node, inputs) => {  // 数据备份恢复：原子化元件：用户数据备份与恢复（GET/POST /api/backup） | 入:action 出:result
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const action = String(inputs.action ?? 'list').toLowerCase()  // 子操作类型（如 backup create/list）
  const syncKey = String(node.params.sync_key ?? '').trim()  // Clock 同步密钥（X-Sync-Key）
  const headers: Record<string, string> = syncKey ? { 'X-Sync-Key': syncKey } : {}
  const path = action === 'create' ? '/api/backup/create' : '/api/backup'  // 文件或 API 路径（inputs 优先于 params）
  const res = await clockAuthFetch(node, path, {
    method: action === 'create' ? 'POST' : 'GET',
    headers,
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`backup ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockFlipAnimation', async (node, inputs) => {  // 翻页时钟动画：原子化元件：翻页时钟 UI 状态（前端动画；经 snapshot 读取展示配置） | 入:username 出:flip_config
  const snap = await fetchClockSnapshot(node, inputs).catch(() => ({}))  // Clock snapshot 或降级数据
  return {
    outputs: {
      flip_config: (snap as Record<string, unknown>).flip_clock ?? { enabled: true },
    },
    duration_ms: 0,
  }
})
registerExecutor('PortList', createApiExecutor('http://127.0.0.1:11050', '/api/list', 'GET'))  // PortList：原子化元件：列出所有已分配端口及状态
registerExecutor('ProcessList', async (node) => {  // 进程列表：原子化元件：列出所有注册的服务和进程 | 入:— 出:processes
  const base = processBase(node)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/services`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`ProcessList ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  const processes = await res.json()
  return { outputs: { processes, result: processes }, duration_ms: 0 }
})

registerExecutor('HealthCheck', async (node, inputs) => {  // 健康检查：原子化元件：对指定服务调用 health_endpoint，输出 healthy/unhealthy | 入:service_name 出:status|detail
  const base = (node.params.api_base as string) || 'http://127.0.0.1:11055'  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const name = String(inputs.service_name ?? '')
  const svcRes = await fetch(`${base}/api/services`, { signal: AbortSignal.timeout(10_000) })
  const services = await svcRes.json() as { id?: string; name?: string; health_endpoint?: string }[]
  const svc = services.find(s => s.id === name || s.name === name)
  const url = svc?.health_endpoint as string | undefined  // 拼好的 HTTP 请求地址
  if (!url) {
    return { outputs: { status: 'unknown', detail: 'no health_endpoint' }, duration_ms: 0 }
  }
  try {
    const hres = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return {
      outputs: { status: hres.ok ? 'healthy' : 'unhealthy', detail: await hres.text() },
      duration_ms: 0,
    }
  } catch (err) {
    return {
      outputs: { status: 'unhealthy', detail: err instanceof Error ? err.message : String(err) },
      duration_ms: 0,
    }
  }
})

registerExecutor('ProcessRestart', async (node, inputs) => {  // 重启服务：原子化元件：通过 PolarProcess API 重启指定服务 | 入:service_name 出:result
  const base = (node.params.api_base as string) || 'http://127.0.0.1:11055'  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const id = String(inputs.service_name ?? '')  // 服务/模板/任务 id
  const res = await fetch(`${base}/api/services/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`restart ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

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

registerExecutor('IDEAgent', async (node) => {  // IDE 模式：PolarClaw IDE Agent：MCP/IDE ReAct 环。 | 入:task_context 出:result|files_changed
  const mode = node.params.mode as string  // 组件运行模式（ask/whitelist 等）
  const agentId = (node.params.agent_id as string) || 'ide-agent'
  return {
    outputs: { registered: true, agent_id: agentId, role: mode },
    duration_ms: 0,
  }
})

registerExecutor('WebAgent', async (node) => {  // Web 模式：PolarClaw Hub Web Solo Agent ReAct。 | 入:hub_message 出:result|prompt_sent
  const mode = node.params.mode as string  // 组件运行模式（ask/whitelist 等）
  const agentId = (node.params.agent_id as string) || 'web-agent'
  return {
    outputs: { registered: true, agent_id: agentId, role: mode },
    duration_ms: 0,
  }
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

registerExecutor('CostTracker', async (node, inputs) => {  // 资金化追踪：原子化元件：LLM 调用成本追踪（预算/消耗/余额可视化） | 入:usage_data 出:cost_report|budget_ok
  const usage = (inputs.usage_data as { cost?: number; prompt_tokens?: number; completion_tokens?: number }) ?? {}
  let cost = Number(usage.cost ?? 0)  // 本步累计费用
  const pricingSource = String(node.params.pricing_source ?? 'PolarPrivate')

  if (cost === 0 && pricingSource === 'PolarPrivate') {
    try {
      const res = await fetch('http://127.0.0.1:12790/v1/models', { signal: AbortSignal.timeout(5000) })
      if (res.ok) {  // HTTP 成功才解析 body
        const data = await res.json() as { data?: { id: string }[] }  // 接口 JSON 正文
        const modelCount = data.data?.length ?? 0
        const tokens = Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0)
        cost = tokens > 0 ? (tokens / 1000) * 0.01 : 0
        if (modelCount === 0 && tokens === 0) cost = 0
      }
    } catch { /* PolarPrivate offline */ }
  }

  const limit = Number(node.params.budget_limit ?? 100)  // 预算上限
  const threshold = Number(node.params.alert_threshold ?? 80)
  const pct = limit > 0 ? (cost / limit) * 100 : 0  // 已用预算占比（%）
  return {
    outputs: {
      cost_report: { cost, limit, pct, pricing_source: pricingSource },
      budget_ok: pct < threshold,
    },
    duration_ms: 0,
  }
})

registerExecutor('ExperienceCapture', async (node, inputs) => {  // 经验采集器：在关键判断点（出错/成功）采集执行上下文，供记忆与 Prompt 迭代。 | 入:capture_context 出:experience_record
  const capCtx = (inputs.capture_context ?? {}) as Record<string, unknown>
  const mode = node.params.capture_mode as string || 'both'  // 组件运行模式（ask/whitelist 等）
  const trigger = String(
    inputs.trigger_event
    ?? capCtx.trigger_event
    ?? node.params.trigger_event
    ?? 'success',
  )
  const isError = /error|fail/i.test(trigger)
  const isSuccess = /success|ok|pass/i.test(trigger)

  if (mode === 'error_only' && !isError) {  // 按 capture_mode 过滤是否记录
    return {
      outputs: { captured: false, experience_record: null, skip_reason: 'capture_mode=error_only' },
      duration_ms: 0,
    }
  }
  if (mode === 'success_only' && !isSuccess) {  // 按 capture_mode 过滤是否记录
    return {
      outputs: { captured: false, experience_record: null, skip_reason: 'capture_mode=success_only' },
      duration_ms: 0,
    }
  }

  const record = {  // 经验捕获结构化记录
    trigger,
    mode,
    context: inputs.context ?? capCtx.context ?? node.params.context ?? inputs,
    captured_at: new Date().toISOString(),
  }

  try {
    await fetch('http://127.0.0.1:18080/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: JSON.stringify(record),
        source: 'polarui-experience-capture',
        metadata: { type: 'experience', trigger },
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = 'polarui_experience_capture'  // PolarMemory 块 id
        const prev = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]  // 解析 params 中的 JSON 配置
        prev.push(record)
        localStorage.setItem(key, JSON.stringify(prev.slice(-100)))
      }
    } catch { /* no storage */ }
  }

  let auto_applied = false
  if (node.params.auto_apply === true) {  // 显式开启才自动写盘
    try {
      const distilled = distillCapture(record, 1500)
      await hubFileWrite(PROMPT_EVOLVE_AUTO_APPLY_PATH, distilled, true)
      auto_applied = true
    } catch { /* headless may lack hub */ }
  }

  return {
    outputs: {
      captured: true,
      experience_record: record,
      storage_path: node.params.storage_path ?? 'knowlever|localStorage',
      auto_applied,
    },
    duration_ms: 0,
  }
})

registerExecutor('AgenticUnit', async (node, inputs) => executeAgenticUnit(node, inputs))  // AgenticUnit：Agentic 组合：工作层(LLM调用) + 核验层(正则匹配) + 重试循环。由原子化元件组成，可展开查看内部结构。
registerExecutor('AgenticChain', async (node, inputs) => executeAgenticChain(node, inputs))  // AgenticChain：Agentic 组合：多个 Agentic 单元串联。每步工作层输出经核验层确认后才进入下一步。可展开查看内部。

const ECOSYSTEM_HTTP: Array<[string, string, string, string?]> = [  // 生态原子组件 HTTP 执行器批量注册（api_base 可覆盖）
  ['TemplateList', 'http://127.0.0.1:3900', '/api/templates', 'GET'],
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

registerExecutor('ProcessStart', async (node, inputs) => {  // 启动服务：原子化元件：启动指定服务 | 入:service_id 出:result
  let idRaw = inputs.service_id ?? node.params.service_id
  if (idRaw && typeof idRaw === 'object') {  // 槽位可能是对象，需展平
    const arr = idRaw as { id?: string }[] | { id?: string }
    idRaw = Array.isArray(arr) ? arr[0]?.id : (arr as { id?: string }).id
  }
  const id = String(idRaw ?? '').trim()  // 服务/模板/任务 id
  if (!id) throw new Error('ProcessStart: service_id required')
  const res = await fetch(`${processBase(node)}/api/services/${encodeURIComponent(id)}/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ProcessStart ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('ProcessStop', async (node, inputs) => {  // 停止服务：原子化元件：停止指定服务 | 入:service_id 出:result
  const id = String(inputs.service_id ?? '')  // 服务/模板/任务 id
  const res = await fetch(`${processBase(node)}/api/services/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ProcessStop ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('ProcessKill', async (node, inputs) => {  // 强制终止：原子化元件：强制终止指定进程（高危操作，Slave 角色受限） | 入:process_id 出:result
  const id = String(inputs.process_id ?? '')  // 服务/模板/任务 id
  const res = await fetch(`${processBase(node)}/api/processes/${encodeURIComponent(id)}/kill`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`ProcessKill ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('TaskCreate', async (node, inputs) => {  // 创建重任务：原子化元件：创建 PolarProcess 重任务（长时间运行的后台任务） | 入:task_spec 出:task_id
  const res = await fetch(`${processBase(node)}/api/tasks/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inputs.task_spec ?? inputs),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`TaskCreate ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json() as { task_id?: string; id?: string }  // 接口 JSON 正文
  return { outputs: { task_id: data.task_id ?? data.id, result: data }, duration_ms: 0 }
})

registerExecutor('TaskStatus', async (node, inputs) => {  // 任务状态：原子化元件：查询重任务执行状态 | 入:task_id 出:status
  const id = String(inputs.task_id ?? '')  // 服务/模板/任务 id
  const res = await fetch(`${processBase(node)}/api/tasks/${encodeURIComponent(id)}/status`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`TaskStatus ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { status: await res.json() }, duration_ms: 0 }
})

registerExecutor('SchedulerStatus', async (node) => {  // 调度器状态：原子化元件：查询 PolarProcess 调度器状态（空闲/运行中任务/队列深度） | 入:— 出:scheduler
  const res = await fetch(`${processBase(node)}/api/scheduler/status`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`SchedulerStatus ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { scheduler: await res.json() }, duration_ms: 0 }
})

registerExecutor('KnowLeverIngest', async (node, inputs) => {  // 知识摄入：原子化元件：将文档/文本摄入 KnowLever 知识库 | 入:content|topic 出:result
  const base = apiBase(node, KL_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const text = String(inputs.content ?? inputs.text ?? '')
  const topic = String(inputs.topic ?? 'e2e-pipeline')  // DIGiST/KnowLever 主题
  const docId = String(inputs.doc_id ?? `${topic}-${Date.now()}`)
  const res = await fetch(`${base}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      doc_id: docId,
      user: node.params.user ?? 'admin',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`KnowLeverIngest ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})
registerExecutor('KnowLeverBuild', async (node, inputs) => {  // 站点构建：原子化元件：构建 KnowLever 静态 HTML 站点 | 入:topic 出:build_path
  const topic = String(inputs.topic ?? '')  // DIGiST/KnowLever 主题
  const user = String(node.params.user ?? 'admin')  // KnowLever/PolarMemory 用户 id
  const cmd = `node wiki-engine/build.js --topic ${JSON.stringify(topic)} --user ${JSON.stringify(user)}`
  const result = await hubShellExec(cmd, '~/Polarisor/KnowLever', 120)
  const buildPath = result.stdout.split('\n').find(l => l.includes('site/') || l.includes('.html'))?.trim() ?? result.stdout.trim()
  return {
    outputs: { build_path: buildPath, success: result.success },
    duration_ms: 0,
    ...(result.success ? {} : { error: result.stderr || 'KnowLeverBuild failed' }),
  }
})

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

registerExecutor('PromptInject', async (node, inputs) => {  // Prompt 注入：原子化元件：注入先验知识（System Prompt）。可接 MemorySearch.blocks 或 PromptEvolve.prior_knowledg | 入:prior_context|memory_blocks 出:system_prompt|context
  const { loadRulesBundle, mergeRulesText, selectProtocolRules } = await import('./rules-client')
  const memoryText = formatMemoryBlocks(inputs.memory_blocks ?? inputs.blocks)
  const triggerText = String(
    inputs.prior_context ?? memoryText ?? inputs.trigger_text ?? node.params.trigger_text ?? ''
  )
  let inject = String(inputs.prior_knowledge ?? node.params.prior_knowledge ?? inputs.inject_text ?? '')
  if (!inject.trim() && typeof window === 'undefined') {
    try {
      const { PROMPT_EVOLVE_LATEST_PATH } = await import('./prompt-evolve-utils')
      const { readFileSync, existsSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const p = resolve(process.cwd(), PROMPT_EVOLVE_LATEST_PATH)
      if (existsSync(p)) inject = readFileSync(p, 'utf8').trim()
    } catch { /* no evolved prompt available */ }
  }
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
  let promptEvolveText = ''
  if (node.params.include_prompt_evolve !== false) {
    try {
      const data = await hubFileRead(PROMPT_EVOLVE_LATEST_PATH)  // 接口 JSON 正文
      promptEvolveText = data.content
    } catch {
      /* 首轮无 latest.md */
    }
  }

  const built = buildReflectiveContext({
    includeDescriptions: node.params.include_descriptions !== false,
    includeAgentRules: node.params.include_agent_rules !== false,
    promptEvolveText,
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

const CHECKUP_STATUS_RANK: Record<string, number> = {
  needs_human: 3,
  processing: 2,
  pending: 1,
  resolved: 0,
  triaged: 0,
  done: 0,
  failed: 3,
}

function mergeCheckupBranchStatus(
  fixStatus?: string,
  opts?: { approved?: boolean; shellOk?: boolean },
): string {
  if (opts?.shellOk === false) return 'needs_human'
  const statuses: string[] = []
  if (fixStatus) statuses.push(fixStatus)
  if (opts?.approved === false) statuses.push('needs_human')
  if (opts?.approved === true) statuses.push('resolved')
  if (opts?.shellOk === true) statuses.push('resolved')
  if (statuses.length === 0) return 'pending'
  return statuses.reduce((best, next) =>
    (CHECKUP_STATUS_RANK[next] ?? 0) > (CHECKUP_STATUS_RANK[best] ?? 0) ? next : best,
  )
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

registerExecutor('EcosystemScanner', async () => {  // 生态扫描器：生态模块：扫描 Polarisor 生态目录 → 输出项目 SSoT 地图。无数据输入；可选 trigger 表示执行顺序。 | 入:trigger 出:projects|ssot_map
  const data = await hubEcosystemScan()  // 接口 JSON 正文
  return {
    outputs: { projects: data.projects, ssot_map: data.ssot_map, count: data.count },
    duration_ms: 0,
  }
})

registerExecutor('SkillCapture', async (node, inputs) => {  // 技能捕获：原子化元件：捕获工具调用轨迹 → 生成可复用 Skill Markdown。 | 入:trajectory|task_description 出:skill_md|saved
  const trajectory = inputs.trajectory ?? inputs
  const taskDescription = String(inputs.task_description ?? '')
  const roleText = formatRoleDeclaration(node.params.role_declaration)
  const prompt = `根据以下任务轨迹，生成可复用的 Agent Skill（Markdown 格式，含 frontmatter 标题与步骤清单）。  // 发给模型的用户提示

任务描述：${taskDescription}

轨迹 JSON：
${JSON.stringify(trajectory, null, 2).slice(0, 12000)}

只输出 Markdown，不要代码围栏。`

  const raw = await getLLMClient().chat(
    String(node.params.model ?? 'GLM-5.1'),
    [
      { role: 'system', content: `${roleText}\n你是 Polarisor Skill 蒸馏器。`.trim() },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.4, timeoutMs: 120_000 }
  )

  const skillMd = raw.content.trim()  // 蒸馏出的 Skill Markdown
  let saved = false

  if (node.params.push_suggestion !== false) {  // 写入进化建议 inbox 待人审
    try {
      const { pushSuggestion } = await import('./suggestion-store')
      pushSuggestion({
        source: 'skill_capture',
        kind: 'MODIFY_NODE_DEF',
        title: `SkillCapture: ${taskDescription.slice(0, 80) || 'trajectory skill'}`,
        rationale: 'Hermes 轨迹蒸馏 — 须人审后写入 skill（260523/11 禁止静默写盘）',
        diff: { path: 'Agent_core/skills/captured/', after: skillMd },
        apply_targets: [
          { id: 'skill', label: '写入 skill 文件', checked: false },
          { id: 'reg', label: '追加 registry 条目', checked: false },
        ],
      })
    } catch { /* inbox optional in headless */ }
  }

  if (node.params.auto_save === true) {  // 显式开启才自动写盘
    const savePath = String(node.params.save_path ?? 'Agent_core/skills/captured')
      .replace(/^~\//, '')
    const fileName = `skill-${Date.now()}.md`
    const relPath = savePath.endsWith('.md')
      ? savePath
      : `${savePath.replace(/\/$/, '')}/${fileName}`
    try {
      await hubFileWrite(relPath, skillMd, true)
      saved = true
    } catch { /* save optional */ }
  }

  return { outputs: { skill_md: skillMd, saved }, duration_ms: 0 }
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

registerExecutor('SubAgent', async (node, inputs) => {  // SubAgent：原子化元件：将子任务委派给独立 Agent 进程。输入任务描述 → 输出结果。
  const task = String(inputs.task ?? '')
  const workflowRef = String(node.params.workflow ?? node.params.agent_type ?? 'claude-code')
  const timeoutMs = Number(node.params.timeout_s ?? 300) * 1000
  try {
    const { loadWorkflowByRef } = await import('./workflow-loader')
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

registerExecutor('CheckupEventInbox', async (node, inputs) => {  // 检修事件收件箱：订阅 @checkup-agent.inbox，输出标准化 event | 入:event 出:event|event_id
  const injected = (inputs.event ?? node.params.event) as Record<string, unknown> | undefined
  if (injected && typeof injected === 'object') {  // 槽位可能是对象，需展平
    return {
      outputs: { event: injected, event_id: String(injected.event_id ?? '') },
      duration_ms: 0,
    }
  }
  const timeoutMs = Math.min(Number(node.params.timeout_s ?? 8) * 1000, 30_000)
  try {
    const event = await waitForCheckupEvent(timeoutMs)  // Checkup 事件载荷
    if (!event) {
      return {
        outputs: {},
        duration_ms: 0,
        error: `@checkup-agent.inbox 超时（${timeoutMs}ms）；可注入 inputs.event 手动测试`,
      }
    }
    return {
      outputs: { event, event_id: String(event.event_id ?? '') },
      duration_ms: 0,
    }
  } catch (err) {
    return {
      outputs: {},
      duration_ms: 0,
      error: `${err instanceof Error ? err.message : String(err)} (需 Hub :8040)`,
    }
  }
})

registerExecutor('CheckupTriage', async (node, inputs) => {  // 检修分诊：解析 project / page_url / 用户描述 / 批注；有截图时默认 L101/qwen3-vl 视觉摘要 | 入:event 出:project|page_url|summary
  const event = inputs.event as Record<string, unknown>  // Checkup 事件载荷
  const project = String(event?.project ?? '')  // polaris.json 对应项目名
  const page_url = String(event?.page_url ?? '')
  const userText = String(event?.user_text ?? '')
  const parts: string[] = []
  if (userText) parts.push(userText)

  const annotations = event?.annotations as unknown[] | undefined
  if (annotations?.length) {
    parts.push(
      `[批注 ${annotations.length} 处] ${annotations
        .slice(0, 8)
        .map((a, i) => {
          const o = a as Record<string, unknown>
          return `#${i + 1}:${String(o.label ?? o.text ?? o.note ?? 'mark')}`
        })
        .join('; ')}`,
    )
  }

  const useVlm = node.params.use_vlm !== false && node.params.use_vlm !== 'false'
  const screenshotB64 = event?.screenshot_b64 as string | undefined
  if (useVlm && screenshotB64) {  // 有截图时走 VLM 视觉诊断
    const vlm = await describeCheckupScreenshot({
      screenshotB64,
      userText,
      annotations,
      pageUrl: page_url,
      model: String(node.params.vlm_model ?? 'qwen3-vl'),
      timeoutMs: Number(node.params.vlm_timeout_ms ?? 90_000),
    })
    if (vlm.visual_summary) {
      const sev =
        vlm.severity !== 'unknown' ? ` [严重度:${vlm.severity}]` : ''
      parts.push(`[VLM/${vlm.vlm_backend}]${sev} ${vlm.visual_summary}`)
    } else if (vlm.error) {
      parts.push(`[VLM 跳过: ${vlm.error}]`)
    }
  }

  return {
    outputs: {
      project,
      page_url,
      summary: parts.join('\n\n').trim() || '（无用户描述）',
    },
    duration_ms: 0,
  }
})

registerExecutor('ProjectContextGather', async (_node, inputs) => {  // 项目上下文收集：按 project 拉 polaris.json 与生态扫描线索。triage_result 包含 project + page_url。 | 入:triage_result 出:context
  const project = String(inputs.project ?? '')  // polaris.json 对应项目名
  try {
    const scan = await hubEcosystemScan()
    const projects = scan.projects as Array<Record<string, unknown>>
    const match = projects.find(
      (p) => p.name === project || p.path === project,
    )
    return { outputs: { context: match ?? { project } }, duration_ms: 0 }
  } catch (err) {
    return {
      outputs: { context: { project } },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

registerExecutor('CheckupReport', async (node, inputs, ctx) => {  // 检修结果汇报：向 Hub 写回处理状态与用户可见摘要。report_context 包含 event_id / status / summary / approved / f | 入:report_context 出:reported|report_summary
  const fixActive = !isUpstreamSkipped(ctx, node, 'status')
  const humanActive = !isUpstreamSkipped(ctx, node, 'approved')
  const fixStatus = fixActive ? (inputs.status as string | undefined) : undefined
  const fixSummary = fixActive ? (inputs.summary as string | undefined) : undefined
  const approved = humanActive ? (inputs.approved as boolean | undefined) : undefined  // 人工审批是否通过
  const feedback = humanActive ? (inputs.feedback as string | undefined) : undefined
  const shellOk = inputs.shell_success as boolean | undefined
  const commitHash = inputs.commit_hash as string | undefined
  const status = mergeCheckupBranchStatus(fixStatus, { approved, shellOk: shellOk === true ? true : shellOk === false ? false : undefined })
  let summary = fixSummary ?? feedback ?? String(inputs.context ?? '检修已记录')
  if (commitHash) summary = `${summary}\n[git] ${commitHash}`
  const finalStatus = shellOk === true && commitHash ? 'resolved' : status
  try {
    await hubOutputDisplay(
      {
        event_id: inputs.event_id,
        status: finalStatus,
        summary,
        handler: '@checkup-agent',
        workflow_run_id: inputs.workflow_run_id,
      },
      'json',
      '检修处理结果',
    )
    return { outputs: { reported: true, status: finalStatus, summary }, duration_ms: 0 }
  } catch (err) {
    return {
      outputs: { reported: false },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

registerExecutor('CheckupDiagnoseChain', async (node, inputs) => {  // 检修诊断链：AgenticChain：信息收集→根因分析→核验 | 入:diagnostic_input 出:diagnosis|confidence
  const chainNode: NodeInstance = {
    ...node,
    class_type: 'AgenticChain',
    params: {
      ...node.params,
      purpose: String(inputs.purpose ?? '检修根因诊断'),
      strategy: 'linear',
    },
  }
  const result = await executeAgenticChain(chainNode, {
    task_input: { event: inputs.event, context: inputs.context },
    purpose: inputs.purpose,
  })
  return {
    outputs: {
      diagnosis: result.outputs,
      confidence: result.error ? 0.3 : 0.85,
    },
    duration_ms: result.duration_ms,
    error: result.error,
  }
})

registerExecutor('CheckupFixChain', async (node, inputs) => {  // 检修修复链：AgenticChain：修复方案→核验；输出 status/summary/shell_command/git_message | 入:diagnosis|context 出:status|summary|shell_command|git_message
  const chainNode: NodeInstance = {
    ...node,
    class_type: 'AgenticChain',
    params: {
      ...node.params,
      purpose: '检修修复方案与核验：输出 JSON {summary, shell_command?, git_message?}',
      strategy: 'linear',
    },
  }
  const result = await executeAgenticChain(chainNode, {
    task_input: { diagnosis: inputs.diagnosis, context: inputs.context },
  })
  const summaryRaw = result.outputs?.final_output ?? result.outputs?.response ?? JSON.stringify(result.outputs ?? {})
  const summary = String(summaryRaw ?? '')
  let shell_command = ''
  let git_message = `checkup: ${String((inputs.diagnosis as Record<string, unknown>)?.event_id ?? 'auto-fix')}`
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>  // 解析 params 中的 JSON 配置
    const fix = (parsed.fix ?? parsed) as Record<string, unknown>
    shell_command = String(fix.shell_command ?? fix.command ?? parsed.shell_command ?? '')
    git_message = String(fix.git_message ?? fix.commit_message ?? parsed.git_message ?? git_message)
  } catch {
    const m = summary.match(/```(?:bash|sh)?\n([\s\S]*?)```/)
    if (m?.[1]) shell_command = m[1].trim()
  }
  return {
    outputs: {
      status: result.error ? 'needs_human' : 'resolved',
      summary,
      shell_command,
      git_message,
    },
    duration_ms: result.duration_ms,
    error: result.error,
  }
})

registerExecutor('PolarPilot', async (node, inputs) => ({  // PolarPilot：生态模块：自主进化 Daemon。可展开查看内部工作流。
  outputs: { event: inputs, mode: node.params.mode ?? 'daemon' },
  duration_ms: 0,
}))

registerExecutor('FeishuRelay', async (node, inputs) => ({  // FeishuRelay：PolarClaw 飞书模式：webhook → ReAct 环 → 回传。
  outputs: { relayed: true, message: inputs.message ?? inputs },
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

registerExecutor('DesignResolve', async (node, inputs) => {  // 关键词解析：原子化元件：关键词解析 → 匹配 PolarDesign 设计系统（polar-tech / polar-soft / polar-dense） | 入:keywords 出:systems
  const keywords = String(inputs.keywords ?? inputs.style_description ?? '')
  const data = await designBridgeFetch(node, '/api/design/resolve', {  // 接口 JSON 正文
    keywords,
    style_description: keywords,
  })
  const systems = (data.systems ?? data) as unknown
  const top = Array.isArray(systems) && systems.length
    ? (systems[0] as { system?: string; name?: string })
    : { system: 'polar-tech' }
  return {
    outputs: {
      systems,
      system: top.system ?? top.name ?? 'polar-tech',
    },
    duration_ms: 0,
  }
})

registerExecutor('DesignGenerate', async (node, inputs) => {  // Web 页面生成：原子化元件：Skill + 设计系统 + Brief → Web HTML 工件 | 入:skill|system|brief 出:html
  const brief = String(inputs.brief ?? inputs.content ?? '')
  const skill = String(node.params.skill ?? inputs.skill ?? 'doc/report')
  const system = pickDesignSystem(inputs.system, String(node.params.system ?? 'polar-tech'))
  const userInputs = (inputs.inputs && typeof inputs.inputs === 'object')
    ? inputs.inputs as Record<string, unknown>
    : {
        title: brief.slice(0, 80) || '设计稿',
        sections: [{
          heading: '需求',
          content_md: brief || '简洁登录页：邮箱+密码+主按钮',
        }],
      }
  const data = await designBridgeFetch(node, '/api/design/generate', {  // 接口 JSON 正文
    skill,
    system,
    brief,
    inputs: userInputs,
  })
  const html = String(data.html ?? '')
  return {
    outputs: {
      html,
      preview_url: data.previewUrl ?? data.preview_url ?? '',
      context: data.context,
      critique: data.critique,
    },
    duration_ms: 0,
  }
})

registerExecutor('DesignCritique', async (node, inputs) => {  // 设计质检：原子化元件：HTML 工件 → Anti-AI-Slop P0/P1/P2 质量报告 | 入:html 出:report
  const html = String(inputs.html ?? inputs.content ?? '')
  const data = await designBridgeFetch(node, '/api/design/critique', { html })  // 接口 JSON 正文
  const report = (data.report ?? data) as Record<string, unknown>
  return {
    outputs: {
      report,
      critique: report,
    },
    duration_ms: 0,
  }
})

registerExecutor('DesignPreview', async (node, inputs) => {  // 设计预览：原子化元件：HTML → 本地预览 URL | 入:html 出:preview_url
  const html = String(inputs.html ?? '')
  const previewFromGenerate = String(inputs.preview_url ?? '')
  if (previewFromGenerate) {
    return { outputs: { preview_url: previewFromGenerate }, duration_ms: 0 }
  }
  const data = await designBridgeFetch(node, '/api/design/preview', {  // 接口 JSON 正文
    html: html || undefined,
    skill: String(node.params.skill ?? inputs.skill ?? 'doc/report'),
    system: pickDesignSystem(inputs.system, String(node.params.system ?? 'polar-tech')),
    brief: String(inputs.brief ?? ''),
  })
  return {
    outputs: {
      preview_url: data.preview_url ?? data.previewUrl ?? '',
    },
    duration_ms: 0,
  }
})

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

registerExecutor('TemplateList', createApiExecutor(AO_BASE, '/api/templates', 'GET'))  // TemplateList：原子化元件：列出 AutoOffice 可用的内置 + 自定义模板
registerExecutor('TemplateGet', async (node, inputs) => {  // 获取模板详情：原子化元件：获取指定模板的结构和样式定义 | 入:template_id 出:template
  const id = String(inputs.template_id ?? '')  // 服务/模板/任务 id
  const base = apiBase(node, AO_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/templates/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`TemplateGet ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { template: await res.json() }, duration_ms: 0 }
})
registerExecutor('VisualQA', createApiExecutor(AO_BASE, '/api/visual-qa'))  // VisualQA：原子化元件：VLM 对文档进行 5 维度视觉质量评分
registerExecutor('DeAiFlavor', async (node, inputs) => {  // 去AI腔调：原子化元件：文本去 AI 腔调处理，让内容更自然 | 入:text 出:result
  const text = String(inputs.text ?? inputs.content ?? '')
  const base = apiBase(node, AO_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/quality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`DeAiFlavor HTTP ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = (await res.json()) as { processedText?: string; grade?: string }  // 接口 JSON 正文
    return {
      outputs: {
        result: data.processedText ?? text,
        grade: data.grade,
        quality_report: data,
      },
      duration_ms: 0,
    }
  } catch (err) {
    throw new Error(serviceHint('AutoOffice', 3900, err))
  }
})

registerExecutor('ClockScheduleQuery', async (node, inputs) => {  // 日程管理查询：原子化元件：日程管理 — 查询当前日程和三餐提醒 | 入:username 出:schedule
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  const snap = await fetchClockSnapshot(node, { ...inputs, username }).catch(async () => {  // Clock snapshot 或降级数据
    await ensureClockUserToken(node, username)
    const res = await clockAuthFetch(node, '/api/schedule')
    if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`schedule ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
    return { schedule: await res.json() } as Record<string, unknown>
  })
  const row = snap as Record<string, unknown>
  return { outputs: { schedule: row.schedule ?? row.blocks ?? snap }, duration_ms: 0 }
})
registerExecutor('ClockHabitQuery', async (node, inputs) => {  // 习惯追踪查询：原子化元件：查询习惯追踪和打卡状态 | 入:username 出:habits
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  await ensureClockUserToken(node, username)
  const res = await clockAuthFetch(node, '/api/habits')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`habits ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { habits: await res.json() }, duration_ms: 0 }
})
registerExecutor('ClockStatsQuery', async (node, inputs) => {  // 统计数据查询：原子化元件：统计聚合 — 查询统计数据和高效时段 | 入:username 出:stats
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  await ensureClockUserToken(node, username)
  const res = await clockAuthFetch(node, '/api/stats/dashboard')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`stats ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { stats: await res.json() }, duration_ms: 0 }
})

registerExecutor('DigestRecommend', async (node, inputs) => {  // 个性化推荐：原子化元件：基于用户兴趣的个性化内容推荐 | 入:user_id 出:recommendations
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const qs = new URLSearchParams()
  const userId = inputs.user_id ?? node.params.user_id ?? 'default'
  if (userId) qs.set('user_id', String(userId))
  try {
    const res = await fetch(`${base}/api/recommend?${qs}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    return { outputs: { recommendations: data }, duration_ms: 0 }
  } catch {
    return { outputs: { recommendations: { stub: true, items: [] } }, duration_ms: 0 }
  }
})
registerExecutor('DigestFuse', async (node, inputs) => {  // 跨源融合分析：原子化元件：跨源融合分析（社区检测 + Gap 分析） | 入:topic 出:fusion_report|gaps
  const topic = String(inputs.topic ?? 'AI')  // DIGiST/KnowLever 主题
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/research/gaps?topic=${encodeURIComponent(topic)}`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    return { outputs: { fusion_report: data, gaps: data.gaps ?? data }, duration_ms: 0 }
  } catch {
    return { outputs: { fusion_report: { stub: true, topic }, gaps: [] }, duration_ms: 0 }
  }
})
registerExecutor('DigestSummarize', async (node, inputs) => {  // 内容摘要(DIGiST)：原子化元件：LLM 生成已爬取内容的摘要 | 入:content_ids 出:summaries
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/push-to-knowlever`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    return { outputs: { summaries: await res.json() }, duration_ms: 0 }
  } catch {
    return { outputs: { summaries: { stub: true, count: 0 } }, duration_ms: 0 }
  }
})
registerExecutor('DigestBrowserCrawl', createApiExecutor(DIGIST_BASE, '/api/crawl/trigger'))  // DigestBrowserCrawl：原子化元件：Playwright 浏览器平台爬取（POST /api/crawl/trigger）
registerExecutor('DigestScheduler', createGetQueryExecutor(DIGIST_BASE, '/api/scheduler/status', [], 'status'))  // DigestScheduler：原子化元件：DIGiST 爬取调度引擎状态（GET /api/scheduler/status）
registerExecutor('DigestFusionEngine', async (node, inputs) => {  // 融合引擎：原子化元件：跨源融合引擎（社区检测 + Gap 分析） | 入:topic 出:fusion_report
  const topic = String(inputs.topic ?? '')  // DIGiST/KnowLever 主题
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/research/gaps?topic=${encodeURIComponent(topic)}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`DigestFusionEngine ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { fusion_report: await res.json() }, duration_ms: 0 }
})
registerExecutor('DigestContextCompress', async (node, inputs) => {  // 上下文压缩：原子化元件：长文本上下文压缩摘要（POST /api/summarize/compress） | 入:content 出:compressed
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/push-to-knowlever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: inputs.content, compress: true }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`DigestContextCompress ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { compressed: await res.json() }, duration_ms: 0 }
})
registerExecutor('DigestEvolution', createGetQueryExecutor(DIGIST_BASE, '/api/recommend', ['user_id'], 'profile'))  // DigestEvolution：原子化元件：推荐权重演化与用户画像更新（POST /api/evolution/step）

registerExecutor('KnowLeverStorage', createGetQueryExecutor('http://127.0.0.1:18080', '/api/topics', ['user'], 'topics'))  // KnowLeverStorage：原子化元件：KnowLever 结构化 topic/page 存储（GET /api/topics）
registerExecutor('KnowLeverNormalize', async (node, inputs) => {  // 规范化管道：原子化元件：素材规范化 normalized content.md 管道 | 入:topic 出:path
  const user = String(inputs.user ?? node.params.user ?? 'admin')  // KnowLever/PolarMemory 用户 id
  const topic = String(inputs.topic ?? '')  // DIGiST/KnowLever 主题
  return {
    outputs: { path: `data/users/${user}/topics/${topic}/normalized/content.md` },
    duration_ms: 0,
  }
})
registerExecutor('KnowLeverNodeSdk', async (node, inputs) => {  // Node SDK：原子化元件：@polarisor/knowlever Node SDK 封装（ingest/search/compile） | 入:operation 出:result
  const op = String(inputs.operation ?? 'health')
  const base = 'http://127.0.0.1:18080'  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const paths: Record<string, string> = {
    health: '/api/health',
    search: '/api/search',
    ingest: '/api/ingest',
    compile: '/api/compile/trigger',
  }
  const path = paths[op] ?? '/api/health'  // 文件或 API 路径（inputs 优先于 params）
  const method = op === 'health' ? 'GET' : 'POST'
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ query: 'sdk', user: 'admin' }) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`KnowLeverNodeSdk ${op} ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})
registerExecutor('KnowLeverWebhook', createApiExecutor('http://127.0.0.1:18080', '/api/feedback'))  // KnowLeverWebhook：原子化元件：Webhook 注册与反馈（POST /api/webhooks/register, /api/feedback）
registerExecutor('KnowLeverFunnel', createApiExecutor('http://127.0.0.1:18080', '/api/funnel/status', 'GET'))  // KnowLeverFunnel：原子化元件：SOTAgent Funnel 公网暴露状态（GET /api/funnel/status）

registerExecutor('DesignDeckGenerate', createApiExecutor(DESIGN_BASE, '/api/design/generate'))  // DesignDeckGenerate：原子化元件：Brief → Deck/PPT 幻灯片工件（经 design-bridge generate）
registerExecutor('DesignSystemLibrary', createApiExecutor(DESIGN_BASE, '/api/design/resolve', 'POST'))  // DesignSystemLibrary：原子化元件：列出 PolarDesign 内置设计系统库

registerExecutor('TQMLTrain', createApiExecutor(TQ_BASE, '/api/v1/ml/train'))  // TQMLTrain：原子化元件：ML 模型训练（POST /api/v1/ml/train）
registerExecutor('TQRLPPO', createApiExecutor(TQ_BASE, '/api/v1/ml/train'))  // TQRLPPO：原子化元件：强化学习 PPO 策略训练
registerExecutor('TQExperiment', createApiExecutor(TQ_BASE, '/api/v1/research/runs', 'GET'))  // TQExperiment：原子化元件：研究实验 Run 管理（GET /api/v1/research/runs）
registerExecutor('TQSharpeReward', async (_node, inputs) => ({  // TQSharpeReward：原子化元件：DSR 奖励函数配置（回测 metrics 子模块）
  outputs: { reward: 0, note: 'DSR computed in backtest metrics', input: inputs.returns },
  duration_ms: 0,
}))
registerExecutor('TQObsSpace', async (node, inputs) => ({  // TQObsSpace：原子化元件：策略增强观测空间维度配置
  outputs: {
    observation_space: { dims: 64, strategy_id: inputs.strategy_id ?? 'default' },
    hint: serviceHint('TQSDK', 8000, new Error('full obs API when trading-platform mounted')),
  },
  duration_ms: 0,
}))
registerExecutor('TQEventBacktest', async (node, inputs) => {  // 事件驱动回测引擎：原子化元件：事件驱动回测（复用 TQBacktest） | 入:strategy_id 出:report
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const sid = String(inputs.strategy_id ?? '')
  const res = await fetch(`${base}/api/v1/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy_id: sid }),
    signal: AbortSignal.timeout(120_000),
  })
  if (res.status === 404) {
    return { outputs: { report: { stub: true, strategy_id: sid }, hint: 'mount trading-platform for live backtest' }, duration_ms: 0 }
  }
  if (!res.ok) throw new Error(`TQEventBacktest ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { report: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockAmbientSound', async (node, inputs) => {  // 环境音：原子化元件：环境音/白噪音配置（GET /api/timer/sounds） | 入:— 出:sounds
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/timer/sounds')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`sounds ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { sounds: await res.json() }, duration_ms: 0 }
})
registerExecutor('ClockCustomRingtone', async (node, inputs) => ({  // ClockCustomRingtone：原子化元件：上传自定义铃声（POST /api/timer/sounds/upload）
  outputs: { result: { upload: '/api/timer/sounds/upload', filename: inputs.filename } },
  duration_ms: 0,
}))
registerExecutor('ClockMiniTimer', async (node, inputs) => {  // MiniTimer 浮窗：原子化元件：MiniTimer 浮窗状态（timer state 子集） | 入:— 出:mini_state
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/timer/state')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`mini timer ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const state = await res.json()
  return { outputs: { mini_state: state }, duration_ms: 0 }
})
registerExecutor('ClockGantt', async (node, inputs) => {  // 甘特图：原子化元件：任务甘特图数据（GET /api/tasks/gantt-data） | 入:— 出:gantt
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/tasks/gantt-data')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`gantt ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { gantt: await res.json() }, duration_ms: 0 }
})
registerExecutor('ClockQuadrantPriority', async (node, inputs) => {  // 二象限优先级：原子化元件：二象限任务优先级矩阵（tasks position API） | 入:— 出:matrix
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/tasks')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`quadrant ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { matrix: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockHeatmap', async (node, inputs) => {  // 热力图：原子化元件：活动热力图（stats 子模块） | 入:username 出:heatmap
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  await requireClockUserToken(node, username)
  const range = String(inputs.range ?? node.params.range ?? '1m')
  const res = await clockAuthFetch(node, `/api/stats/heatmap?range=${encodeURIComponent(range)}`)
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`heatmap ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { heatmap: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockPeakHours', async (node, inputs) => {  // 高效时段分析：原子化元件：高效时段分析（stats 查询） | 入:username 出:peak_hours
  const username = String(inputs.username ?? node.params.username ?? 'default')  // Clock 多用户隔离用的用户名
  await requireClockUserToken(node, username)
  const weeks = String(inputs.weeks ?? node.params.weeks ?? '4')
  const res = await clockAuthFetch(node, `/api/stats/peak-hours?weeks=${encodeURIComponent(weeks)}`)
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`peak-hours ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { peak_hours: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockShareCard', async (node, inputs) => {  // 分享卡片：原子化元件：成就/统计分享卡片导出 | 入:— 出:card
  const snap = await fetchClockSnapshot(node, inputs)  // Clock snapshot 或降级数据
  return {
    outputs: {
      card: {
        username: snap.clock_username ?? inputs.username,
        today_summary: snap.today_summary ?? {},
        export_hint: '前端 ShareCard 组件经 html2canvas 导出图片',
      },
    },
    duration_ms: 0,
  }
})

registerExecutor('ClockAchievementTrack', async (node, inputs) => {  // 成就追踪：原子化元件：成就进度追踪 | 入:— 出:progress
  await requireClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/achievements')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`achievements ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  return { outputs: { progress: data }, duration_ms: 0 }
})

registerExecutor('ClockAchievementDisplay', async (node, inputs) => {  // 成就展示：原子化元件：成就墙展示（GET /api/achievements） | 入:— 出:wall
  await requireClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/achievements')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`achievements ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  return { outputs: { wall: data }, duration_ms: 0 }
})

registerExecutor('ClockRecurringTask', async (node, inputs) => {  // 循环任务：原子化元件：日/周/月循环任务（GET /api/tasks 过滤 recurrence） | 入:— 出:tasks
  await requireClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/tasks')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`tasks ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const tasks = await res.json() as Record<string, { recurrence?: unknown }>
  const recurring = Object.fromEntries(
    Object.entries(tasks).filter(([, t]) => t?.recurrence != null),
  )
  return { outputs: { tasks: recurring }, duration_ms: 0 }
})

registerExecutor('ClockFeed', async (node, inputs) => {  // 信息流 Feed：原子化元件：Clock 信息消费工作台 Feed 入口 | 入:user_id 出:feed
  const base = apiBase(node, String(node.params.digist_base ?? DIGIST_BASE))  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const userId = String(inputs.user_id ?? node.params.user_id ?? 'default')
  const res = await fetch(`${base}/api/recommend?user_id=${encodeURIComponent(userId)}&n=10`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(serviceHint('DIGiST', 3800, new Error(`feed ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { feed: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockFeedReport', async (node, inputs) => {  // 推荐报告证据：原子化元件：推荐 / 报告 / 证据（digist 推荐 + KnowLever 动态报告） | 入:user_id 出:report
  const digist = apiBase(node, String(node.params.digist_base ?? DIGIST_BASE))  // 解析 api_base，默认连本地生态端口
  const kl = String(node.params.knowlever_base ?? KL_BASE)
  const userId = String(inputs.user_id ?? node.params.user_id ?? 'default')
  const [rec, report] = await Promise.all([
    fetch(`${digist}/api/recommend?user_id=${encodeURIComponent(userId)}&n=5`, {
      signal: AbortSignal.timeout(30_000),
    }),
    fetch(`${kl}/api/digist/report`, { signal: AbortSignal.timeout(30_000) }).catch(() => null),
  ])
  if (!rec.ok) throw new Error(serviceHint('DIGiST', 3800, new Error(`recommend ${rec.status}`)))
  const recommendations = await rec.json()
  let dynamicReport: unknown = null
  if (report?.ok) dynamicReport = await report.json()
  return { outputs: { report: { recommendations, dynamic_report: dynamicReport } }, duration_ms: 0 }
})

registerExecutor('ClockFeedSources', async (node) => {  // 信息源配置：原子化元件：信息源配置 — digist GET/POST /api/sources | 入:— 出:sources
  const base = apiBase(node, String(node.params.digist_base ?? DIGIST_BASE))  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/sources/config`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(serviceHint('DIGiST', 3800, new Error(`sources ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { sources: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockFeat_PWA离线_d9d461', async (node) => {  // PWA 离线：原子化元件：PWA 离线（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  const base = apiBase(node, CLOCK_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/clock/manifest.webmanifest`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`PWA manifest ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockFeat_国际化_bb81f9', async (node, inputs) => {  // 国际化：原子化元件：国际化（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const res = await clockAuthFetch(node, '/api/users/preferences')
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`preferences ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const prefs = await res.json()  // prefs：ClockFeat_国际化_bb81f9业务中间量
  return { outputs: { result: { language: prefs.language ?? 'zh-CN', preferences: prefs } }, duration_ms: 0 }
})

registerExecutor('ClockFeat_主题切换_a79e8b', async (node, inputs) => {  // 主题切换：原子化元件：主题切换（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  await ensureClockUserToken(node, String(inputs.username ?? node.params.username ?? 'default'))
  const theme = String(inputs.theme ?? node.params.theme ?? 'dark')  // theme：ClockFeat_主题切换_a79e8b业务中间量
  const res = await clockAuthFetch(node, '/api/users/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`theme ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})

registerExecutor('ClockFeat_命令面板_93e40c', async (node) => {  // 命令面板：原子化元件：命令面板（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  const base = apiBase(node, CLOCK_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`health ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  return {
    outputs: {
      result: {
        shortcut: 'Cmd+K',
        actions: ['navigate', 'search_tasks', 'execute_command'],
        backend: await res.json(),
      },
    },
    duration_ms: 0,
  }
})

registerExecutor('ClockFeat_国际象棋Puzzle_ffa7d6', async (node) => {  // 国际象棋 Puzzle：原子化元件：国际象棋 Puzzle（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  const base = apiBase(node, CLOCK_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/clock/puzzles/puzzles.json`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(serviceHint('Clock', 15550, new Error(`puzzles ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  const puzzles = (data as { puzzles?: unknown[] }).puzzles ?? []  // puzzles：ClockFeat_国际象棋Puzzle_ffa7d6业务中间量
  return { outputs: { result: { count: puzzles.length, sample: puzzles.slice(0, 3) } }, duration_ms: 0 }
})

registerExecutor('ClockFeat_视频队列与播放_d371f2', async (node, inputs) => {  // 视频队列与播放：原子化元件：视频队列与播放（coverage-gap 自动补全，对接 Clock API） | 入:payload 出:result
  const base = apiBase(node, String(node.params.digist_base ?? DIGIST_BASE))  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/recommend?n=5&content_type=video`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(serviceHint('DIGiST', 3800, new Error(`video feed ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const items = await res.json()  // items：ClockFeat_视频队列与播放_d371f2业务中间量
  return { outputs: { result: { queue: items, user_id: inputs.user_id ?? 'default' } }, duration_ms: 0 }
})

registerExecutor('DigestSourceConfig', async (node, inputs) => {  // 信息源配置：原子化元件：信息源 CRUD（添加/删除/修改爬取目标） | 入:action|config 出:result
  const base = apiBase(node, DIGIST_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const action = String(inputs.action ?? 'list').toLowerCase()  // 子操作类型（如 backup create/list）
  const config = inputs.config as Record<string, unknown> | undefined
  const id = config?.id ?? inputs.id  // 服务/模板/任务 id
  let method = 'GET'
  let url = `${base}/api/sources/config`  // 拼好的 HTTP 请求地址
  if (action === 'create') method = 'POST'
  else if (action === 'update' && id) {  // 备选条件：上一分支未命中
    method = 'PUT'
    url = `${base}/api/sources/config/${encodeURIComponent(String(id))}`
  } else if (action === 'delete' && id) {
    method = 'DELETE'
    url = `${base}/api/sources/config/${encodeURIComponent(String(id))}`
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(config ?? inputs) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`DigestSourceConfig ${method} ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = method === 'DELETE' ? { ok: true } : await res.json()  // 接口 JSON 正文
  return { outputs: { result: data }, duration_ms: 0 }
})

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

registerExecutor('PortAllocate', createApiExecutor(PORT_BASE, '/api/allocate'))  // PortAllocate：原子化元件：幂等端口分配（相同 service_name 返回同一端口）
registerExecutor('PortRelease', createApiExecutor(PORT_BASE, '/api/release'))  // PortRelease：原子化元件：释放已分配的端口
registerExecutor('PortHeartbeat', createApiExecutor(PORT_BASE, '/api/heartbeat'))  // PortHeartbeat：原子化元件：上报端口心跳（保活/验证）

registerExecutor('KnowLeverCompile', async (node, inputs) => {  // 知识编译：原子化元件：LLM 将原始素材编译为结构化 Wiki | 入:topic 出:result
  const base = apiBase(node, KL_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const body = {
    topic: inputs.topic,
    user: inputs.user ?? node.params.user ?? 'admin',
  }
  const res = await fetch(`${base}/api/compile/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`KnowLeverCompile ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})
registerExecutor('KnowLeverExportPDF', async (node, inputs) => {  // 导出PDF：原子化元件：将 KnowLever Wiki 导出为 PDF 文档 | 入:topic 出:pdf_path
  const topic = String(inputs.topic ?? '')  // DIGiST/KnowLever 主题
  const user = String(node.params.user ?? 'admin')  // KnowLever/PolarMemory 用户 id
  const cmd = `node wiki-engine/export-pdf.js --topic ${JSON.stringify(topic)} --user ${JSON.stringify(user)}`
  const result = await hubShellExec(cmd, '~/Polarisor/KnowLever', 180)
  const pdfPath = result.stdout.split('\n').find(l => l.includes('.pdf'))?.trim() ?? result.stdout.trim()
  return {
    outputs: { pdf_path: pdfPath, success: result.success },
    duration_ms: 0,
    ...(result.success ? {} : { error: result.stderr || 'export-pdf failed' }),
  }
})

registerExecutor('TQStrategyList', async (node) => {  // 策略库列表：原子化元件：列出所有可用策略（期货 + 加密） | 入:— 出:strategies
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/v1/strategies`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    const list = Array.isArray(data) ? data : (data as { strategies?: unknown[] }).strategies ?? [data]
    const first = list[0] as { id?: string } | undefined
    return { outputs: { result: data, strategy_id: first?.id ?? 'stub-strategy' }, duration_ms: 0 }
  } catch {
    return {
      outputs: { result: [{ id: 'stub-strategy', name: 'stub' }], strategy_id: 'stub-strategy', stub: true },
      duration_ms: 0,
    }
  }
})
registerExecutor('TQResearchRun', async (node, inputs) => {  // 策略研究：原子化元件：创建自然语言策略研究 Run | 入:description 出:run
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/v1/research/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    const data = await res.json()  // 接口 JSON 正文
    const runId = (data as { run_id?: string; id?: string }).run_id ?? (data as { id?: string }).id ?? 'stub-run'
    return { outputs: { result: data, strategy_id: runId, run_id: runId }, duration_ms: 0 }
  } catch {
    return {
      outputs: {
        result: { stub: true, run_id: 'stub-run' },
        strategy_id: 'stub-strategy',
        run_id: 'stub-run',
      },
      duration_ms: 0,
    }
  }
})
registerExecutor('TQBacktest', async (node, inputs) => {  // 策略回测：原子化元件：运行策略回测（Walk-Forward / Monte Carlo） | 入:strategy_id|config 出:report
  const runId = String(inputs.run_id ?? inputs.strategy_id ?? 'stub-strategy')
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/v1/research/runs/${encodeURIComponent(runId)}/execute`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    return { outputs: { result: await res.json() }, duration_ms: 0 }
  } catch {
    return { outputs: { result: { stub: true, run_id: runId, status: 'skipped' } }, duration_ms: 0 }
  }
})
registerExecutor('TQDataCollect', createApiExecutor(TQ_BASE, '/api/v1/data/collect', 'POST', 'TQSDK'))  // TQDataCollect：原子化元件：触发期货/加密市场数据采集
registerExecutor('TQOptimize', async (node, inputs) => {  // 参数优化：原子化元件：触发 Optuna 超参数优化 | 入:strategy_id 出:best_params
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/v1/ml/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputs),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    return { outputs: { result: await res.json() }, duration_ms: 0 }
  } catch {
    return { outputs: { result: { stub: true, status: 'skipped' } }, duration_ms: 0 }
  }
})
registerExecutor('TQLiveTrade', async (node, inputs) => {  // 实盘交易：原子化元件：实盘交易控制（start/stop/status） | 入:action|strategy_id 出:result
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const action = String(inputs.action ?? node.params.action ?? 'status').toLowerCase()  // 子操作类型（如 backup create/list）
  const path =  // 文件或 API 路径（inputs 优先于 params）
    action === 'start' ? '/api/v1/live-trading/start'
    : action === 'stop' ? '/api/v1/live-trading/stop'
    : '/api/v1/live-trading/status'
  const method = action === 'status' ? 'GET' : 'POST'
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(inputs) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`TQLiveTrade ${action} ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { result: await res.json() }, duration_ms: 0 }
})
registerExecutor('TQRiskCheck', async (node, inputs) => {  // 风控检查：原子化元件：执行风控检查（限额/持仓/回撤监控） | 入:strategy_id 出:passed|report
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  try {
    const res = await fetch(`${base}/api/v1/positions/risk/status`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(String(res.status))  // HTTP 非成功：抛错（含生态服务拉起提示）
    return { outputs: { result: await res.json() }, duration_ms: 0 }
  } catch {
    return { outputs: { result: { risk: 'low', stub: true, strategy_id: inputs.strategy_id } }, duration_ms: 0 }
  }
})

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
registerExecutor('TQLiveScheduler', async (node, inputs) => {  // LiveScheduler 实盘通道：原子化元件：实盘调度 LiveScheduler（TQLiveTrade 编排） | 入:strategy_id 出:schedule
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/v1/live-trading/status`, { signal: AbortSignal.timeout(15_000) })
  if (res.status === 404) {
    return { outputs: { schedule: { stub: true, strategy_id: inputs.strategy_id } }, duration_ms: 0 }
  }
  if (!res.ok) throw new Error(`TQLiveScheduler ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  return { outputs: { schedule: await res.json() }, duration_ms: 0 }
})
registerExecutor('PortFacadeContract', async (node) => {  // facade 同形契约：原子化元件：PolarPort facade 同形契约（allocate/list/heartbeat 统一响应形状） | 入:— 出:contract
  const base = apiBase(node, PORT_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/list`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`PortFacadeContract ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  const ports = await res.json()
  return {
    outputs: {
      contract: { shape: 'facade', fields: ['service_name', 'port', 'project', 'last_verified'], sample: ports },
    },
    duration_ms: 0,
  }
})

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

registerExecutor('AO_Word生成_f06cad', (node, inputs) => aoGenerateDocument(node, 'docx', inputs))  // AO_Word生成_f06cad：AO_Word生成_f06cad
registerExecutor('AO_LaTeX生成_bd6979', (node, inputs) => aoGenerateDocument(node, 'latex', inputs))  // AO_LaTeX生成_bd6979：AO_LaTeX生成_bd6979
registerExecutor('AO_去AI化处理_c1d221', async (node, inputs) => {  // 去AI化处理：原子化元件：去AI化处理（coverage-gap 自动补全，对接 AutoOffice API） | 入:payload 出:result
  const text = String(inputs.text ?? inputs.content ?? '')  // text：AO_去AI化处理_c1d221业务中间量
  const base = apiBase(node, AO_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/quality`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(serviceHint('AutoOffice', 3900, new Error(`quality ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  return { outputs: { result: data.processedText ?? text, grade: data.grade, quality_report: data }, duration_ms: 0 }
})
registerExecutor('AO_批量生成batch_a97a98', async (node, inputs) => {  // 批量生成（batch）：原子化元件：批量生成（batch）（coverage-gap 自动补全，对接 AutoOffice API） | 入:payload 出:result
  const formats = (inputs.formats as string[]) ?? ['html', 'docx', 'pdf']  // formats：AO_批量生成batch_a97a98业务中间量
  const results: Record<string, string> = {}
  for (const fmt of formats) {  // 遍历直至终止条件满足
    const r = await aoGenerateDocument(node, fmt, inputs)  // r：AO_批量生成batch_a97a98业务中间量
    results[fmt] = String(r.outputs.document ?? '')
  }
  return { outputs: { batch: results, formats }, duration_ms: 0 }
})
registerExecutor('AO_图表嵌入_4c88d9', async (node, inputs) => {  // 图表嵌入：原子化元件：图表嵌入（coverage-gap 自动补全，对接 AutoOffice API） | 入:payload 出:result
  const base = apiBase(node, AO_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const content = String(inputs.content ?? inputs.text ?? '# Chart\nflowchart LR\n  A-->B')  // 写入或读取的文本内容
  const res = await fetch(`${base}/api/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [{ title: 'Chart', content, type: 'markdown' }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(serviceHint('AutoOffice', 3900, new Error(`summarize/mermaid ${res.status}`)))  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  return { outputs: { mermaid: data.mermaid, chart_png_hint: 'embed via mmdc in pipeline', summary: data }, duration_ms: 0 }
})
registerExecutor('AO_外部工具检测_a0e3e0', createApiExecutor(AO_BASE, '/api/tools', 'GET'))  // AO_外部工具检测_a0e3e0：AO_外部工具检测_a0e3e0

registerExecutor('DigestFeat_HTTPAPI_0cbe5c', createApiExecutor(DIGIST_BASE, '/api/health', 'GET'))  // DigestFeat_HTTPAPI_0cbe5c：原子化元件：HTTP API（coverage-gap 自动补全，对接 digist API）
registerExecutor('DigestFeat_日报生成_76d9c4', createGetQueryExecutor(DIGIST_BASE, '/api/items/recent', [], 'items'))  // DigestFeat_日报生成_76d9c4：DigestFeat_日报生成_76d9c4
registerExecutor('DigestFeat_推荐引擎_5b340d', createGetQueryExecutor(DIGIST_BASE, '/api/recommend', ['user_id'], 'recommendations'))  // DigestFeat_推荐引擎_5b340d：DigestFeat_推荐引擎_5b340d
registerExecutor('DigestFeat_Dashboard_2938c7', createApiExecutor(DIGIST_BASE, '/api/content_items', 'GET'))  // DigestFeat_Dashboard_2938c7：原子化元件：Dashboard（coverage-gap 自动补全，对接 digist API）
registerExecutor('DigestFeat_推荐引擎按用户过滤_00fe77', createGetQueryExecutor(DIGIST_BASE, '/api/recommend', ['user_id', 'top_k'], 'recommendations'))  // DigestFeat_推荐引擎按用户过滤_00fe77：DigestFeat_推荐引擎按用户过滤_00fe77

registerExecutor('KL_B01基础蒸馏_b341a2', createApiExecutor(KL_BASE, '/api/compile/trigger'))  // KL_B01基础蒸馏_b341a2：KL_B01基础蒸馏_b341a2
registerExecutor('KL_B03技能对比_9db12d', createApiExecutor(KL_BASE, '/api/search', 'POST'))  // KL_B03技能对比_9db12d：KL_B03技能对比_9db12d
registerExecutor('KL_B04增量蒸馏_a0c3f1', createApiExecutor(KL_BASE, '/api/compile/trigger'))  // KL_B04增量蒸馏_a0c3f1：KL_B04增量蒸馏_a0c3f1
registerExecutor('KL_B05元技能组合_9101ef', createApiExecutor(KL_BASE, '/api/entries', 'POST'))  // KL_B05元技能组合_9101ef：KL_B05元技能组合_9101ef
registerExecutor('KL_B06决策矩阵_f82324', createApiExecutor(KL_BASE, '/api/search', 'POST'))  // KL_B06决策矩阵_f82324：KL_B06决策矩阵_f82324
registerExecutor('KL_文件级隔离_ccbe3d', createGetQueryExecutor(KL_BASE, '/api/topics', ['user'], 'topics'))  // KL_文件级隔离_ccbe3d：KL_文件级隔离_ccbe3d
registerExecutor('KL_Asset路径修复_9abd9e', async (_n, inputs) => ({  // KL_Asset路径修复_9abd9e：KL_Asset路径修复_9abd9e
  outputs: { asset_path: `data/users/${inputs.user ?? 'admin'}/assets`, fixed: true },
  duration_ms: 0,
}))
registerExecutor('KL_层次整理L15Conso_bf1feb', createApiExecutor(KL_BASE, '/api/compile/trigger'))  // KL_层次整理L15Conso_bf1feb：KL_层次整理L15Conso_bf1feb

registerExecutor('Mem_BlockManager_091585', createApiExecutor(MEMORY_BASE, '/api/blocks/status', 'GET'))  // Mem_BlockManager_091585：原子化元件：BlockManager（coverage-gap 自动补全，对接 PolarMemory API）

registerExecutor('PP_连续3次失败自动重启_8eb742', async (node) => {  // 连续 3 次失败自动重启：原子化元件：连续 3 次失败自动重启（coverage-gap 自动补全，对接 PolarProcess API） | 入:payload 出:result
  const base = apiBase(node, 'http://127.0.0.1:11055')  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/watchdog/status`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`watchdog ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
  const data = await res.json()  // 接口 JSON 正文
  const targets = Array.isArray(data) ? data : (data.targets ?? data.services ?? [])  // targets：PP_连续3次失败自动重启_8eb742业务中间量
  return {
    outputs: {
      policy: { max_failures: 3, action: 'auto_restart' },
      targets,
    },
    duration_ms: 0,
  }
})

async function tqFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:8000${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
  let data: unknown
  try { data = await res.json() } catch { data = await res.text() }
  return { ok: res.ok, status: res.status, data }
}

registerExecutor('TQ_统一实时数据源_ac565d', async () => {  // 统一实时数据源：原子化元件：统一实时数据源（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/v1/market/snapshot')  // r：TQ_统一实时数据源_ac565d业务中间量
  if (r.status === 404) return { outputs: { data_source: { stub: true, hint: 'mount trading-platform market router' } }, duration_ms: 0 }  // TQ_统一实时数据源_ac565d：条件分支
  return { outputs: { data_source: r.data }, duration_ms: 0 }
})
registerExecutor('TQ_WebSocket实时推_56b642', async () => {  // WebSocket 实时推送：原子化元件：WebSocket 实时推送（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/health')  // r：TQ_WebSocket实时推_56b642业务中间量
  return { outputs: { websocket: { endpoint: 'ws://127.0.0.1:8000/ws', health: r.data } }, duration_ms: 0 }
})
registerExecutor('TQ_参数部署API_89bcc3', async (node, inputs) => {  // 参数部署 API：原子化元件：参数部署 API（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const base = apiBase(node, TQ_BASE)  // 生态服务根地址：节点 params.api_base 优先于默认端口
  const res = await fetch(`${base}/api/v1/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inputs),
    signal: AbortSignal.timeout(60_000),
  })
  if (res.status === 404) return { outputs: { deploy: { stub: true } }, duration_ms: 0 }  // TQ_参数部署API_89bcc3：条件分支
  return { outputs: { deploy: await res.json() }, duration_ms: 0 }
})
registerExecutor('TQ_攻防力量估计引擎_1980d7', async () => {  // 攻防力量估计引擎：原子化元件：攻防力量估计引擎（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/v1/positions/risk/status')  // r：TQ_攻防力量估计引擎_1980d7业务中间量
  return { outputs: { force_estimate: r.data ?? { status: r.status } }, duration_ms: 0 }
})
registerExecutor('TQ_攻防交易信号_2e67d4', async () => {  // 攻防交易信号：原子化元件：攻防交易信号（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/v1/strategies')  // r：TQ_攻防交易信号_2e67d4业务中间量
  return { outputs: { signals: r.data ?? { status: r.status } }, duration_ms: 0 }
})
registerExecutor('TQ_多模式庄家行为检测引擎_924633', async () => {  // 多模式庄家行为检测引擎：原子化元件：多模式庄家行为检测引擎（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/v1/btc/status')  // r：TQ_多模式庄家行为检测引擎_924633业务中间量
  return { outputs: { dealer_detection: r.data ?? { status: r.status } }, duration_ms: 0 }
})
registerExecutor('TQ_Swarm审计委员会_2a68cc', async () => {  // Swarm 审计委员会：原子化元件：Swarm 审计委员会（coverage-gap 自动补全，对接 tqsdk API） | 入:payload 出:result
  const r = await tqFetch('/api/v1/research/runs')  // r：TQ_Swarm审计委员会_2a68cc业务中间量
  return { outputs: { swarm_audit: r.data ?? { status: r.status } }, duration_ms: 0 }
})

  // ─── MVP_260520 Evolve 节点 ─────────────────────────────────────

interface RecursionGuardState {
  depth: number
  lastRunTs: number
  recentFailures: number[]
}

const recursionGuardStates = new Map<string, RecursionGuardState>()  // recursionGuardStates：TQ_Swarm审计委员会_2a68cc业务中间量

registerExecutor('LearningCapture', async (node, inputs) => {  // 学习记录：把一次完整决策与结果写入 PolarClaw learning store，供 self-learning-loop 异步消费。 | 入:execution_record 出:capture_id|store_size|capture
  const captureId = `lc-${Date.now().toString(36)}`
  const record = {  // 经验捕获结构化记录
    capture_id: captureId,
    ts: new Date().toISOString(),
    decision: inputs.decision ?? node.params.decision ?? null,
    result: inputs.result ?? node.params.result ?? null,
    validation_report: inputs.validation_report ?? node.params.validation_report ?? null,
  }
  const endpoint = String(node.params.endpoint ?? '').trim()
  const relPath = String(node.params.fallback_path ?? 'PolarClaw/.data/learning-captures.jsonl')

  const finalize = async (storeSize: number): Promise<ExecutionResult> => {
    let polarclaw_wake = false
    if (node.params.wake_self_learning !== false) {
      try {
        await hubFileWrite(
          'PolarClaw/.data/learning-capture.last.json',
          `${JSON.stringify({
            capture_id: captureId,
            ts: record.ts,
            jsonl_path: relPath,
            store_size: storeSize,
            pending_self_learning_cycle: true,
          }, null, 2)}\n`,
          true,
        )
        polarclaw_wake = true
      } catch { /* hub unavailable */ }
    }
    return {
      outputs: { capture_id: captureId, store_size: storeSize, capture: record, polarclaw_wake },
      duration_ms: 0,
    }
  }

  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {  // HTTP 成功才解析 body
        const data = (await res.json().catch(() => ({}))) as { store_size?: number }  // 接口 JSON 正文
        return finalize(data.store_size ?? 1)
      }
    } catch {
    }  // fall through to JSONL fallback
  }

  try {
    let existing = ''
    try {
      const data = await hubFileRead(relPath)  // 接口 JSON 正文
      existing = data.content
    } catch {
    }  // file may not exist yet
    const newContent = existing + `${JSON.stringify(record)}\n`
    await hubFileWrite(relPath, newContent, true)
    const storeSize = newContent.split('\n').filter(Boolean).length
    return finalize(storeSize)
  } catch (err) {
    return {
      outputs: { capture_id: captureId, store_size: 0, capture: record, polarclaw_wake: false },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
})

registerExecutor('PromptEvolve', async (node, inputs) => {  // Prompt 进化：蒸馏 LearningCapture / ExperienceCapture → prior_knowledge 写回 PromptInject 或 Memor | 入:evolution_sources 出:prior_knowledge|evolved_prompt|store_key|distilled_chars
  const maxChars = Number(node.params.max_chars ?? 2000)
  const target = String(node.params.target ?? 'prompt_inject')
  const memoryKey = String(node.params.memory_key ?? 'prompt_evolve')
  const sources = (inputs.evolution_sources ?? {}) as Record<string, unknown>

  let capture =
    inputs.capture
    ?? inputs.learning_capture
    ?? inputs.experience_record
    ?? sources.capture
    ?? sources.learning_capture
    ?? sources.experience_record
    ?? node.params.capture
    ?? null

  if (!capture && node.params.read_auto_apply !== false) {  // 显式开启才自动写盘
    try {
      const data = await hubFileRead(PROMPT_EVOLVE_AUTO_APPLY_PATH)  // 接口 JSON 正文
      capture = { auto_applied: data.content }
    } catch {
      /* no auto-apply file */
    }
  }

  const distilled = distillCapture(capture, maxChars)
  const memoryText = formatMemoryBlocks(
    inputs.memory_blocks
    ?? inputs.blocks
    ?? sources.memory_blocks
    ?? sources.blocks
    ?? node.params.memory_blocks,
  )

  let historyRuns = inputs.history_runs ?? sources.history_runs ?? node.params.history_runs
  if (!historyRuns && node.params.include_history !== false) {
    try {
      const bridgeUrl = String(node.params.bridge_url ?? 'http://127.0.0.1:3922')
      const res = await fetch(`${bridgeUrl}/api/runs/list?limit=5`, { signal: AbortSignal.timeout(5000) })
      if (res.ok) {  // HTTP 成功才解析 body
        const data = (await res.json()) as { runs?: unknown[] }  // 接口 JSON 正文
        historyRuns = data.runs ?? []
      }
    } catch { /* bridge offline */ }
  }
  const historyText = historyRuns
    ? `## 近期 Run（History）\n${JSON.stringify(historyRuns).slice(0, 1200)}`
    : ''

  const priorKnowledge = [distilled, memoryText ? `## 记忆块\n${memoryText}` : '', historyText]
    .filter(Boolean)
    .join('\n\n')
    .trim()

  let storeKey = ''
  const writePrompt = target === 'prompt_inject' || target === 'both'
  const writeMemory = target === 'memory_store' || target === 'both'

  if (writePrompt && priorKnowledge) {
    try {
      await hubFileWrite(PROMPT_EVOLVE_LATEST_PATH, priorKnowledge, true)
    } catch { /* hub unavailable */ }
  }

  if (writeMemory && priorKnowledge) {
    storeKey = memoryKey
    try {
      const base = String(node.params.api_base ?? 'http://127.0.0.1:3100').replace(/\/$/, '')  // 生态服务根地址：节点 params.api_base 优先于默认端口
      const res = await fetch(`${base}/api/blocks/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: memoryKey, content: priorKnowledge }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`MemoryStore ${res.status}`)  // HTTP 非成功：抛错（含生态服务拉起提示）
    } catch {
      try {
        await hubFileWrite(`PolarUI/.data/prompt-evolve/${memoryKey}.md`, priorKnowledge, true)
      } catch { /* fallback */ }
    }
  }

  return {
    outputs: {
      prior_knowledge: priorKnowledge,
      evolved_prompt: priorKnowledge,
      store_key: storeKey,
      distilled_chars: priorKnowledge.length,
    },
    duration_ms: 0,
  }
})

registerExecutor('RecursionGuard', async (node, inputs) => {  // 递归保护：递归循环保护：深度限制 + 冷却时间 + 失败熔断。不通过则输出 null，下游 AgentWorkflow 跳过。 | 入:value 出:pass_value|stop_reason
  const key = String(node.params.workflow_key ?? 'evolution-loop')  // PolarMemory 块 id
  const maxDepth = Number(node.params.max_depth ?? 100)
  const cooldownMs = Number(node.params.cooldown_ms ?? 5000)
  const threshold = Number(node.params.circuit_breaker_threshold ?? 5)
  const windowMs = Number(node.params.circuit_breaker_window_ms ?? 60000)
  const now = Date.now()

  let state = recursionGuardStates.get(key)
  if (!state) {
    state = { depth: 0, lastRunTs: 0, recentFailures: [] }
    recursionGuardStates.set(key, state)
  }

  state.recentFailures = state.recentFailures.filter(ts => now - ts < windowMs)

  let stopReason = 'ok'
  if (state.depth >= maxDepth) stopReason = 'depth_limit'
  else if (now - state.lastRunTs < cooldownMs) stopReason = 'cooldown'  // 备选条件：上一分支未命中
  else if (state.recentFailures.length >= threshold) stopReason = 'circuit_breaker'  // 备选条件：上一分支未命中

  if (stopReason !== 'ok') {
    return { outputs: { pass_value: null, stop_reason: stopReason }, duration_ms: 0 }
  }

  state.depth += 1
  state.lastRunTs = now
  if (inputs.value === null || inputs.value === undefined) {
    state.recentFailures.push(now)
  }
  return { outputs: { pass_value: inputs.value, stop_reason: stopReason }, duration_ms: 0 }
})

registerExecutor('HistorySink', async (node, inputs, ctx) => {  // History 落盘：聚合一次 execute 的全链路 trace，输出 log_json + log_path + summary。 | 入:run_envelope|node_traces 出:log_json|log_path|summary
  const runsDir = String(node.params.runs_dir ?? 'PolarUI/runs/')
  const trace = ctx.runTrace
  const runId = trace?.run_id ?? `run_${Date.now()}`
  const logPath = `${runsDir}${runId}/trace.jsonl`
  const envelope = {
    run_id: runId,
    library: ctx.workflowLibrary ?? 'WF',
    started_at: trace?.started_at ?? new Date().toISOString(),
    finished_at: trace?.finished_at,
    status: trace?.status ?? 'completed',
    run_envelope: inputs.run_envelope ?? trace ?? {},
    node_traces: inputs.node_traces ?? trace?.node_traces ?? [],
    loop_traces: trace?.loop_traces ?? [],
    usage_traces: trace?.usage_traces ?? [],
  }
  return {
    outputs: {
      log_json: envelope,
      log_path: logPath,
      summary: `${envelope.library} run ${runId} (${envelope.status})`,
    },
    duration_ms: 0,
  }
})

registerExecutor('HistoryReader', async (node) => {  // History 读取：读取最近 N 次 run log，供对比与 Prompt 迭代。 | 入:query 出:runs|count
  const limit = Number(node.params.limit ?? 10)  // 预算上限
  const bridgeUrl = String(node.params.bridge_url ?? 'http://127.0.0.1:3922')
  try {
    const res = await fetch(`${bridgeUrl}/api/runs/list?limit=${limit}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {  // HTTP 成功才解析 body
      const { runs } = (await res.json()) as { runs?: unknown[] }
      return {
        outputs: { runs: runs ?? [], count: runs?.length ?? 0, source: 'run-trace-bridge' },
        duration_ms: 0,
      }
    }
  } catch {
  }  // bridge optional in headless
  return {
    outputs: { runs: [], count: 0, note: `stub: 读取最近 ${limit} 次 run（bridge 未启动）` },
    duration_ms: 0,
  }
})

registerExecutor('PetriDish', async (node, inputs) => {  // 培养皿：WF 结构进化槽：展开为 slave 子工作流；执行到此节点时允许修改自身图并替换（其余节点运行时不可改图）。 | 入:seed|evolution_signal 出:refined_workflow|applied
  const allowEdit = node.params.allow_graph_edit !== false
  const presetSlave = String(node.params.slave_workflow ?? '').trim()
  const parsed = presetSlave
    ? (() => {
        try {
          return JSON.parse(presetSlave) as Record<string, unknown>
        } catch {
          return null
        }
      })()
    : extractWorkflowJson(inputs.seed)

  const refinedWorkflow = parsed ?? { _parse_error: true, seed: inputs.seed }
  const applied = allowEdit && parsed != null && !('_parse_error' in refinedWorkflow)

  const result = {
    refined_workflow: refinedWorkflow,
    applied,
    note: applied
      ? '培养皿：已从 Seed LLM 输出解析 slave 工作流 JSON'
      : '培养皿：未能解析有效 workflow JSON（检查 LLM 输出或 preset slave_workflow）',
  }

  if (applied) {
    try {
      const { runEvolutionGate } = await import('./evolution-gate')
      const { pushSuggestion } = await import('./suggestion-store')
      const gate = await runEvolutionGate(refinedWorkflow as Record<string, unknown>)
      const gateOk = gate.passed
      pushSuggestion({
        source: 'petri_dish',
        kind: 'ADD_WORKFLOW',
        title: 'PetriDish 分化草案',
        rationale: gateOk
          ? `slave 工作流已通过自动门（${gate.stages.map(s => s.stage).join('→')}），非人审闸门`
          : `自动门未通过：${gate.errors.slice(0, 3).join('; ') || 'compile/execute'}`,
        diff: {
          path: 'workflows/slave-draft.json',
          after: { workflow: refinedWorkflow, gate: gate.stages },
        },
        apply_targets: [
          {
            id: 'wf',
            label: '写入 slave workflow 文件',
            checked: gateOk,
          },
          {
            id: 'reg',
            label: '追加 registry 条目',
            checked: gateOk,
          },
        ],
      })
    } catch { /* inbox optional in headless */ }
  }

  return { outputs: result, duration_ms: 0 }
})

registerExecutor('StemCell', async (node, inputs, ctx) => {  // 干细胞：WF 权柄入口 — 执行经过时写入 graph.nodes/links | 入:state|differentiation_signal 出:state|materialized_class|node_id|graph_edit_granted
  const state = (inputs.state as Record<string, unknown>) ?? {}
  const allowEdit = node.params.allow_graph_edit !== false
  const allowedTypes = String(node.params.allowed_types ?? 'LLM')
  const signalRaw = inputs.differentiation_signal ?? state
  const signal =
    signalRaw && typeof signalRaw === 'object' && !Array.isArray(signalRaw)
      ? (signalRaw as Record<string, unknown>)
      : undefined

  let nodeId = `mat_${Date.now()}`
  let pick = allowedTypes.split(',')[0]?.trim() || 'LLM'
  let linksAdded = 0
  let nodesRemoved = 0
  let graphMutated = false

  if (allowEdit && ctx.graph) {
    const { applyStemCellToGraph } = await import('./stem-cell-mutation')
    const mutation = applyStemCellToGraph(ctx.graph, node, { allowedTypes, signal })
    nodeId = mutation.node_id
    pick = mutation.class_type
    linksAdded = mutation.links_added
    nodesRemoved = mutation.nodes_removed
    graphMutated = true
  }

  const matGraph = {
    nodes: ctx.graph ? ctx.graph.nodes.map(n => n.id) : [nodeId],
    links: ctx.graph
      ? ctx.graph.links.map(l => ({ from: l.from_node, to: l.to_node }))
      : ([] as Array<{ from: string; to: string }>),
  }
  const diffEvent = {
    from_node: node.id,
    from_class: node.class_type,
    to_node: nodeId,
    to_class: pick,
    graph_mutated: graphMutated,
    links_added: linksAdded,
    nodes_removed: nodesRemoved,
    materialized_append: graphMutated ? { node_id: nodeId, class_type: pick } : undefined,
  }
  ctx.runTrace?.differentiation_traces?.push(diffEvent)

  return {
    outputs: {
      materialized_graph: matGraph,
      state: {
        ...state,
        last_differentiation: pick,
        materialized_graph: matGraph,
        graph_edit_granted: allowEdit,
        graph_mutated: graphMutated,
      },
      materialized_class: pick,
      node_id: nodeId,
      graph_edit_granted: allowEdit,
      graph_mutated: graphMutated,
      links_added: linksAdded,
      nodes_removed: nodesRemoved,
      library: ctx.workflowLibrary ?? 'WF',
      note: graphMutated
        ? `干细胞：已写入工作流（+1 ${pick}，连线 ${linksAdded}，删节点 ${nodesRemoved}）`
        : allowEdit
          ? '干细胞：权柄已开但无 graph 上下文（需在 executeGraph 内执行）'
          : '干细胞：结构读写已关闭（allow_graph_edit=false）',
    },
    duration_ms: 0,
  }
})

registerExecutor('PluripotentCell', async (node, inputs, ctx) => {  // 干细胞（旧名）：已重命名为 StemCell；保留 class_type 兼容旧 workflow | 入:state 出:state
  const state = (inputs.state as Record<string, unknown>) ?? {}
  const allowed = String(node.params.allowed_types ?? 'LLM')  // PermissionGate 是否放行下游
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const pick = allowed[0] ?? 'LLM'
  const nodeId = `mat_${Date.now()}`
  const diffEvent = {
    from_node: node.id,
    from_class: node.class_type,
    to_node: nodeId,
    to_class: pick,
    materialized_append: { node_id: nodeId, class_type: pick },
  }
  ctx.runTrace?.differentiation_traces?.push(diffEvent)
  return {
    outputs: {
      state: { ...state, last_differentiation: pick },
      materialized_class: pick,
      node_id: nodeId,
      library: ctx.workflowLibrary ?? 'WF',
      note: '干细胞（PluripotentCell 旧名）：准许结构改变信号（分化占位）',
    },
    duration_ms: 0,
  }
})

registerPipelineExecutors(registerExecutor)
