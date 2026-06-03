/**
 * lg-runner.ts — LangGraph 式 step loop 执行器（LG Spec）
 */
import { Graph } from './graph'
import type { ExecutionResult, ExecutionContext, ExecutorFn } from './executor'
import { executeNode, getRegisteredExecutor } from './executor'
import { materializedToWorkflowJson } from './lg-export-wf'
import type { NodeInstance } from './types'

export interface LGRunResult {
  results: Map<string, ExecutionResult>
  steps: LGStepRecord[]
  merged_output?: unknown
  unhealthy_nodes: Array<{ node_id: string; class_type: string; error: string }>
  materialized_graph: { nodes: string[]; links: Array<{ from: string; to: string; when?: string }> }
  runTrace?: import('./executor').RunTraceEnvelope
}

export interface LGStepRecord {
  index: number
  node_id: string
  class_type: string
  routing?: { chosen: string; candidates: string[] }
  duration_ms: number
}

const MAX_LG_STEPS = 64

/** Claude Code 12 工具 — 与 claude-code-1to1 StaticData 名称级 1:1 */
const CLAUDE_CODE_TOOL_DEFS = [
  { name: 'FileRead', desc: 'Read file contents' },
  { name: 'FileWrite', desc: 'Create or overwrite files' },
  { name: 'ShellExec', desc: 'Execute shell commands' },
  { name: 'GlobSearch', desc: 'Find files by glob pattern' },
  { name: 'GrepSearch', desc: 'Search file contents with regex' },
  { name: 'WebSearch', desc: 'Search the web' },
  { name: 'WebFetch', desc: 'Fetch URL content' },
  { name: 'SubAgent', desc: 'Spawn sub-agent for subtask' },
  { name: 'GitCommit', desc: 'Commit code changes' },
  { name: 'MCPCall', desc: 'Call MCP server tool' },
  { name: 'Notification', desc: 'Send notification' },
  { name: 'CodeExec', desc: 'Execute code in sandbox' },
]

function claudeToolsForLlm() {
  const schemas: Record<string, Record<string, unknown>> = {
    FileRead: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to repo root' } }, required: ['path'] },
    FileWrite: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    ShellExec: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
    GlobSearch: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    GrepSearch: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    WebSearch: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    WebFetch: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  }
  return CLAUDE_CODE_TOOL_DEFS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.desc,
      parameters: schemas[t.name] ?? { type: 'object', properties: {} },
    },
  }))
}

/** LG palette 包装前快照 — 工具调度须调用 WF 原语，避免 wrap 递归 */
const lgWfExecutorSnapshot = new Map<string, ExecutorFn>()

function parseLastAssistantJson(state: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(state.messages) ? state.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: string }
    if (m?.role !== 'assistant' || !m.content) continue
    try {
      const match = String(m.content).match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0]) as Record<string, unknown>
    } catch { /* try earlier message */ }
  }
  return {}
}

function buildLGToolInputs(
  state: Record<string, unknown>,
  tool: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = parseLastAssistantJson(state)
  const fromState = (state.tool_args as Record<string, unknown> | undefined) ?? {}
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (fromState[k] !== undefined && fromState[k] !== '') return fromState[k]
      if (params[k] !== undefined && params[k] !== '') return params[k]
      if (parsed[k] !== undefined && parsed[k] !== '') return parsed[k]
    }
    return undefined
  }
  const base: Record<string, unknown> = { optional: true, headless_safe: true }
  switch (tool) {
    case 'ShellExec':
      return { ...base, command: pick('command') ?? '', cwd: pick('cwd') ?? '.' }
    case 'FileRead':
      return { ...base, path: pick('path') ?? '' }
    case 'FileWrite':
      return { ...base, path: pick('path') ?? '', content: pick('content') ?? '' }
    case 'GlobSearch':
      return { ...base, pattern: pick('pattern') ?? '*' }
    case 'GrepSearch':
      return { ...base, pattern: pick('pattern') ?? '', path: pick('path') ?? '.' }
    case 'WebSearch':
      return { ...base, query: pick('query') ?? 'polar' }
    case 'WebFetch':
      return { ...base, url: pick('url') ?? '' }
    case 'GitCommit':
      return { ...base, message: pick('message') ?? 'lg-headless' }
    case 'MCPCall':
      return { ...base, tool_name: pick('tool_name') ?? '', arguments: pick('arguments') ?? {} }
    case 'Notification':
      return { ...base, message: pick('message') ?? String(state.task ?? 'LG notification') }
    case 'CodeExec':
      return { ...base, code: pick('code') ?? 'print("lg")' }
    case 'SubAgent':
      return { ...base, task: pick('task') ?? state.task ?? 'delegate' }
    case 'SessionSearch':
      return { ...base, query: pick('query') ?? '' }
    case 'BrowserAction':
      return { ...base, action: pick('action') ?? 'noop', url: pick('url') ?? '' }
    case 'VLM':
      return { ...base, image_url: pick('image_url') ?? '' }
    case 'MemoryStore':
      return {
        ...base,
        key: pick('key') ?? 'MEMORY.md',
        content: pick('content') ?? String((state.memory_snapshot as Record<string, unknown>)?.['MEMORY.md'] ?? ''),
      }
    case 'KnowLeverSearch':
      return { ...base, query: pick('query') ?? '' }
    case 'EcosystemScanner':
      return { ...base }
    default:
      return { ...base, ...params }
  }
}

/** palette 工具组件在 LG Spec 中复用 LG_ToolNode 调度语义 */
const LG_PALETTE_TOOL_TYPES = [
  'ShellExec', 'FileRead', 'FileWrite', 'GlobSearch', 'GrepSearch', 'WebSearch', 'WebFetch',
  'GitCommit', 'MCPCall', 'Notification', 'CodeExec', 'SubAgent', 'SessionSearch', 'BrowserAction',
  'VLM', 'MemoryStore', 'KnowLeverSearch', 'EcosystemScanner',
] as const

async function executeLGToolDispatch(
  node: NodeInstance,
  state: Record<string, unknown>,
  ctx: ExecutionContext,
  fixedTool?: string,
): Promise<ExecutionResult> {
  const tool = fixedTool ?? resolveLGToolName(node.params, state)
  const messages = Array.isArray(state.messages) ? [...state.messages] : []
  const toolNode: NodeInstance = {
    id: `${node.id}_${tool}`,
    class_type: tool,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    params: { optional: true, headless_safe: true, ...node.params },
  }
  const toolInputs = buildLGToolInputs(state, tool, node.params)

  let toolResult: ExecutionResult
  if (tool === 'hub_send_prompt') {
    toolResult = await runHubSendPrompt({ ...state, ...toolInputs })
    } else {
      const executor = lgWfExecutorSnapshot.get(tool) ?? getRegisteredExecutor(tool)
      if (!executor) {
      toolResult = {
        outputs: { skipped: true, reason: `no executor for ${tool}` },
        duration_ms: 0,
      }
    } else {
      try {
        toolResult = await executor(toolNode, toolInputs, ctx)
      } catch (err) {
        toolResult = {
          outputs: { skipped: true },
          duration_ms: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  }

  const content = formatLGToolMessage(tool, toolResult, undefined)
  messages.push({ role: 'tool', content })
  return {
    outputs: {
      state: {
        ...state,
        messages,
        last_tool: tool,
        last_tool_result: toolResult.outputs,
        _lg_react_round: Number(state._lg_react_round ?? 0) + 1,
      },
      tool_outputs: toolResult.outputs,
      dispatched: true,
      response: content,
    },
    duration_ms: toolResult.duration_ms ?? 0,
  }
}

async function executeLGLlmStep(
  node: NodeInstance,
  state: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const model = String(node.params.model ?? 'GLM-5.1')
  const library = ctx.workflowLibrary ?? 'LG'
  const { wrapModeSystemPrompt } = await import('./mode-prompt')
  const { resolveSystemPromptBase } = await import('./resolve-system-prompt')
  const base = await resolveSystemPromptBase(node)
  const system = wrapModeSystemPrompt(library, base)
  const prior = Array.isArray(state.messages) ? (state.messages as Array<{ role: string; content: string }>) : []
  const reactRound = Number(state._lg_react_round ?? 0)
  const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (system) chatMessages.push({ role: 'system', content: system })
  for (const m of prior) {
    if (m?.role === 'tool') chatMessages.push({ role: 'user', content: `[tool result]\n${String(m.content ?? '')}` })
    else if (m?.role === 'user' || m?.role === 'assistant') chatMessages.push({ role: m.role, content: String(m.content ?? '') })
  }
  const task = String(state.task ?? '')
  if (task && (prior.length === 0 || prior[prior.length - 1]?.content !== task)) {
    chatMessages.push({ role: 'user', content: task })
  }
  const { getLLMClient } = await import('../sdk/llm-proxy')
  const forceFinish = reactRound >= 6
  const useTools = node.params.use_tools !== false && !forceFinish
  if (forceFinish) {
    chatMessages.push({
      role: 'user',
      content: 'Using the tool results above, provide the final concise answer to the original task. No more tools.',
    })
  }
  const res = await getLLMClient().chat(
    model,
    chatMessages,
    {
      temperature: 0.3,
      timeoutMs: 120_000,
      ...(useTools ? { tools: claudeToolsForLlm(), toolChoice: 'auto' } : {}),
    },
  )
  let branch: string | undefined
  let tool: string | undefined
  let tool_args: Record<string, unknown> | undefined
  const toolCalls = (res.toolCalls ?? []) as Array<{ function?: { name?: string; arguments?: string } }>
  if (toolCalls.length > 0 && !forceFinish) {
    branch = 'tool'
    const tc = toolCalls[0] as { function?: { name?: string; arguments?: string | Record<string, unknown> } }
    tool = tc.function?.name
    const rawArgs = tc.function?.arguments
    try {
      tool_args = typeof rawArgs === 'string'
        ? JSON.parse(rawArgs || '{}') as Record<string, unknown>
        : (rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {})
    } catch {
      tool_args = {}
    }
  } else {
    try {
      const m = res.content.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { branch?: string; tool?: string; tool_type?: string }
        branch = parsed.branch ?? 'finish'
        tool = parsed.tool
      }
    } catch { /* ignore */ }
    if (!branch) branch = 'finish'
  }
  const messages = [...prior]
  if (res.content) messages.push({ role: 'assistant', content: res.content })
  else if (tool) messages.push({ role: 'assistant', content: `[tool:${tool}]` })
  const nextState = {
    ...state,
    messages,
    branch,
    ...(tool ? { tool } : {}),
    ...(tool_args ? { tool_args } : {}),
    ...(branch === 'finish' && res.content ? { final_answer: res.content } : {}),
  }
  return {
    outputs: {
      state: nextState,
      response: res.content,
      content: res.content,
      branch,
    },
    duration_ms: 0,
  }
}

function initLGStateFromPromptInput(
  node: NodeInstance,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const text = String(base.task ?? node.params.prompt_text ?? node.params.content ?? '')
  const state: Record<string, unknown> = {
    messages: [],
    ...base,
    ...(text ? { task: text } : {}),
  }
  if (node.params.channel) state.channel = node.params.channel
  if (node.params.preload_memory !== false) {
    const prior = (state.memory_snapshot as Record<string, unknown> | undefined) ?? {}
    state.memory_snapshot = {
      'MEMORY.md': String(node.params.memory_md ?? prior['MEMORY.md'] ?? ''),
      'USER.md': String(node.params.user_md ?? prior['USER.md'] ?? ''),
      'CLAUDE.md': String(node.params.claude_md ?? prior['CLAUDE.md'] ?? ''),
    }
  }
  const snap = state.memory_snapshot as Record<string, unknown> | undefined
  if (node.params.claude_md !== undefined || snap?.['CLAUDE.md'] !== undefined) {
    state.claude_md = String(node.params.claude_md ?? snap?.['CLAUDE.md'] ?? '')
  }
  return state
}

function formatLGToolMessage(tool: string, result: ExecutionResult, softError?: string): string {
  if (softError) {
    return JSON.stringify({ tool, dispatched: true, status: 'unavailable', detail: softError.slice(0, 500) })
  }
  const status = result.error ? 'degraded' : 'ok'
  return JSON.stringify({
    tool,
    dispatched: true,
    status,
    outputs: result.outputs,
    ...(result.error ? { error: result.error } : {}),
  })
}

async function runHubSendPrompt(state: Record<string, unknown>): Promise<ExecutionResult> {
  const prompt = String(state.task ?? state.hub_message ?? 'ping')
  try {
    const { findPolarClawUrl, callPolarClawAgent } = await import('./polarclaw-client')
    const url = await findPolarClawUrl()
    const statusRes = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) })
    if (!statusRes.ok) throw new Error(`PolarClaw ${statusRes.status}`)
    const reply = await callPolarClawAgent(url, prompt)
    return { outputs: { reply, url }, duration_ms: 0 }
  } catch (err) {
    return {
      outputs: { skipped: true, mock: true, prompt },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const HERMES_TOOL_TYPE_MAP: Record<string, string> = {
  terminal: 'ShellExec',
  file: 'FileRead',
  web: 'WebSearch',
  browser: 'BrowserAction',
  memory: 'MemoryStore',
  delegate: 'SubAgent',
  mcp: 'MCPCall',
  execute_code: 'CodeExec',
  code: 'CodeExec',
  media: 'ImageGenerate',
  vision: 'VLM',
  vision_analyze: 'VLM',
  session_search: 'SessionSearch',
}

/** LLM state.tool / tool_type → executor class_type（单 LG_ToolNode 动态调度） */
export function resolveLGToolName(
  params: Record<string, unknown>,
  state: Record<string, unknown>,
): string {
  const fromState = state.tool ?? state.last_tool
  if (typeof fromState === 'string' && fromState.trim()) return fromState.trim()
  const toolType = String(state.tool_type ?? '')
  if (toolType && HERMES_TOOL_TYPE_MAP[toolType]) return HERMES_TOOL_TYPE_MAP[toolType]
  const paramTool = String(params.react_tool ?? params.tool ?? '')
  if (paramTool === 'dynamic' || paramTool === '__dynamic__') return 'ShellExec'
  if (paramTool) return paramTool
  return 'hub_send_prompt'
}

function pickNextNode(
  currentId: string,
  branch: string | undefined,
  lgEdges: Array<{ from: string; to: string; kind: string; when?: string }>,
): string | null {
  const outs = lgEdges.filter(e => e.from === currentId)
  if (outs.length === 0) return null
  if (outs.length === 1 && outs[0].kind === 'static') return outs[0].to
  if (branch) {
    const cond = outs.find(e => e.kind === 'conditional' && e.when === branch)
    if (cond) return cond.to
  }
  return outs.find(e => e.kind === 'conditional')?.to ?? outs[0]?.to ?? null
}

export async function executeLGSpec(
  graph: Graph,
  opts: {
    initialState?: Record<string, unknown>
    agentId?: string
    runContext?: import('./executor').RunContext
    externalInputs?: Record<string, unknown>
    /** Canvas / UI：每步回调（onLGStep 语义） */
    onStep?: (payload: {
      stepIndex: number
      nodeId: string
      classType: string
      materialized_graph: LGRunResult['materialized_graph']
    }) => void
  } = {},
): Promise<LGRunResult> {
  if (opts.externalInputs && Object.keys(opts.externalInputs).length > 0) {
    const { injectPipelineInputs } = await import('./workflow-runner')
    injectPipelineInputs(graph, opts.externalInputs)
  }
  const apiRaw = graph.toApiFormat() as Record<string, unknown>
  const entry = graph.lgEntry ?? String(apiRaw._entry ?? '1')
  const lgEdges = graph.lgEdges ?? (Array.isArray(apiRaw._lg_edges)
    ? (apiRaw._lg_edges as Array<{ from: string; to: string; kind: string; when?: string }>)
    : [])
  const allResults = new Map<string, ExecutionResult>()
  const steps: LGStepRecord[] = []
  const unhealthy_nodes: LGRunResult['unhealthy_nodes'] = []
  const materialized = { nodes: [] as string[], links: [] as LGRunResult['materialized_graph']['links'] }

  const runId = `lg_${Date.now()}`
  const startedAt = new Date().toISOString()
  const runTrace: import('./executor').RunTraceEnvelope = {
    run_id: runId,
    workflow_id: graph.name,
    started_at: startedAt,
    status: 'running',
    trigger: 'manual',
    node_traces: [],
    loop_traces: [],
    usage_traces: [],
    differentiation_traces: [],
  }

  let state: Record<string, unknown> = {
    ...(opts.initialState ?? {}),
    messages: [],
    ...(opts.runContext?.conversation_id ? { conversation_id: opts.runContext.conversation_id } : {}),
    ...(opts.runContext?.user_id ? { user_id: opts.runContext.user_id } : {}),
    ...(opts.runContext?.user_message ? { task: opts.runContext.user_message } : {}),
  }
  let currentId: string | null = entry
  let stepIndex = 0

  while (currentId && stepIndex < MAX_LG_STEPS) {
    const node = graph.nodes.find(n => n.id === currentId)
    if (!node) break

    materialized.nodes.push(currentId)
    const ctx: ExecutionContext = {
      getNodeOutput: (nodeId, slotIndex) => {
        const r = allResults.get(nodeId)
        if (!r) return undefined
        const keys = Object.keys(r.outputs)
        return r.outputs[keys[slotIndex] ?? keys[0]]
      },
      allResults,
      links: graph.links,
      agentId: opts.agentId,
      workflowLibrary: graph.library ?? 'LG',
      graph,
      runContext: opts.runContext,
      runTrace,
      lgAccumulatedState: state,
    }

    const start = Date.now()
    const result = await executeNode(node, ctx)
    result.duration_ms = Date.now() - start
    allResults.set(currentId, result)
    runTrace.node_traces.push({
      node_id: currentId,
      class_type: node.class_type,
      library: 'LG',
      duration_ms: result.duration_ms,
      ...(result.error ? { error: result.error } : {}),
    })

    if (result.error) {
      unhealthy_nodes.push({ node_id: currentId, class_type: node.class_type, error: result.error })
    }

    if (result.outputs.state && typeof result.outputs.state === 'object') {
      state = { ...state, ...(result.outputs.state as Record<string, unknown>) }
    }

    const branch = typeof result.outputs.branch === 'string' ? result.outputs.branch : undefined
    steps.push({
      index: stepIndex,
      node_id: currentId,
      class_type: node.class_type,
      routing: branch ? { chosen: branch, candidates: [] } : undefined,
      duration_ms: result.duration_ms,
    })

    opts.onStep?.({
      stepIndex,
      nodeId: currentId,
      classType: node.class_type,
      materialized_graph: {
        nodes: [...materialized.nodes],
        links: materialized.links.map(l => ({ ...l })),
      },
    })

    if (node.class_type === 'LG_End' || node.class_type === 'Output') break

    const nextId = pickNextNode(currentId, branch, lgEdges)
    if (nextId) materialized.links.push({ from: currentId, to: nextId, when: branch })
    currentId = nextId
    stepIndex++
  }

  let merged_output: unknown = state
  for (const [nodeId, result] of allResults) {
    const n = graph.nodes.find(x => x.id === nodeId)
    if (n?.class_type === 'Output' && result.outputs?.content != null) {
      merged_output = result.outputs.content
      break
    }
  }
  if (merged_output === state && state.final_answer) merged_output = state.final_answer
  else if (merged_output === state) {
    const msgs = Array.isArray(state.messages) ? state.messages as Array<{ role?: string; content?: string }> : []
    const last = [...msgs].reverse().find(m => m.role === 'assistant')
    if (last?.content) merged_output = last.content
  }
  runTrace.finished_at = new Date().toISOString()
  runTrace.status = unhealthy_nodes.length ? 'error' : 'completed'
  return { results: allResults, steps, merged_output, unhealthy_nodes, materialized_graph: materialized, runTrace }
}

export function registerLGExecutors(
  register: (classType: string, fn: ExecutorFn) => void,
): void {
  register('LG_Entry', async (node, inputs, _ctx) => {
    const base = (inputs.initial_state as Record<string, unknown>) ?? {}
    const state: Record<string, unknown> = {
      messages: [],
      ...base,
    }
    if (node.params.channel) state.channel = node.params.channel
    if (node.params.preload_memory !== false) {
      const prior = (state.memory_snapshot as Record<string, unknown> | undefined) ?? {}
      state.memory_snapshot = {
        'MEMORY.md': String(node.params.memory_md ?? prior['MEMORY.md'] ?? ''),
        'USER.md': String(node.params.user_md ?? prior['USER.md'] ?? ''),
        'CLAUDE.md': String(node.params.claude_md ?? prior['CLAUDE.md'] ?? ''),
      }
    }
    const snap = state.memory_snapshot as Record<string, unknown> | undefined
    if (node.params.claude_md !== undefined || snap?.['CLAUDE.md'] !== undefined) {
      state.claude_md = String(node.params.claude_md ?? snap?.['CLAUDE.md'] ?? '')
    }
    return { outputs: { state }, duration_ms: 0 }
  })

  register('LG_End', async (_node, inputs, _ctx) => ({
    outputs: { final_state: inputs.state ?? {} },
    duration_ms: 0,
  }))

  register('LG_LLM', async (node, inputs, ctx) => {
    const state = (inputs.state as Record<string, unknown>) ?? {}
    const model = String(node.params.model ?? 'GLM-5.1')
    const library = ctx.workflowLibrary ?? 'LG'
    const { wrapModeSystemPrompt } = await import('./mode-prompt')
    const { resolveSystemPromptBase } = await import('./resolve-system-prompt')
    const base = await resolveSystemPromptBase(node)
    const system = wrapModeSystemPrompt(library, base)
    const userContent = String(inputs.prompt ?? JSON.stringify(state))
    const { getLLMClient } = await import('../sdk/llm-proxy')
    const res = await getLLMClient().chat(
      model,
      [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user' as const, content: userContent },
      ],
      { temperature: 0.7, timeoutMs: 120_000 },
    )
    let branch: string | undefined
    let tool: string | undefined
    let tool_type: string | undefined
    try {
      const m = res.content.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { branch?: string; tool?: string; tool_type?: string }
        branch = parsed.branch
        tool = parsed.tool
        tool_type = parsed.tool_type
      }
    } catch { /* ignore */ }
    const messages = Array.isArray(state.messages) ? [...state.messages] : []
    messages.push({ role: 'assistant', content: res.content })
    return {
      outputs: {
        state: { ...state, messages, branch, ...(tool ? { tool } : {}), ...(tool_type ? { tool_type } : {}) },
        content: res.content,
        branch,
      },
      duration_ms: 0,
    }
  })

  register('LG_ConditionalEdge', async (_node, inputs, _ctx) => {
    const state = (inputs.state as Record<string, unknown>) ?? {}
    const branch = typeof state.branch === 'string' ? state.branch : 'finish'
    return { outputs: { state, branch }, duration_ms: 0 }
  })

  register('LG_ToolNode', async (node, inputs, ctx) => {
    const state = (inputs.state as Record<string, unknown>) ?? ctx.lgAccumulatedState ?? {}
    return executeLGToolDispatch(node, state, ctx)
  })

  /** WF/LG 共用 palette：LG Spec 内 PromptInput/LLM/Switch/ToolCall/Output 等走 ReAct 语义 */
  function wrapPaletteForLG(classType: string, lgFn: ExecutorFn): void {
    const wfFn = getRegisteredExecutor(classType)
    if (wfFn) lgWfExecutorSnapshot.set(classType, wfFn)
    if (!wfFn) {
      register(classType, lgFn)
      return
    }
    register(classType, async (node, inputs, ctx) => {
      if (ctx.workflowLibrary !== 'LG') return wfFn(node, inputs, ctx)
      return lgFn(node, inputs, ctx)
    })
  }

  wrapPaletteForLG('PromptInput', async (node, _inputs, ctx) => {
    const base = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
    const state = initLGStateFromPromptInput(node, base)
    const text = String(node.params.prompt_text ?? node.params.content ?? '')
    const expectedPattern = String(node.params.expected_output ?? node.params.expected_pattern ?? '')
    return {
      outputs: {
        prompt: text,
        expected_pattern: expectedPattern,
        context: { content: text },
        state,
        response: text,
      },
      duration_ms: 0,
    }
  })

  wrapPaletteForLG('LLM', async (node, _inputs, ctx) => {
    const state = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
    return executeLGLlmStep(node, state, ctx)
  })

  wrapPaletteForLG('Switch', async (_node, _inputs, ctx) => {
    const state = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
    const branch = typeof state.branch === 'string'
      ? state.branch
      : state.tool
        ? 'tool'
        : 'finish'
    return { outputs: { state, branch, selected: branch, value: branch }, duration_ms: 0 }
  })

  wrapPaletteForLG('ToolCall', async (node, _inputs, ctx) => {
    const state = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
    const tool = String(state.tool ?? resolveLGToolName(node.params, state))
    if (!tool || tool === 'hub_send_prompt') {
      return { outputs: { state, skipped: true, reason: 'no tool selected' }, duration_ms: 0 }
    }
    return executeLGToolDispatch(node, state, ctx, tool)
  })

  wrapPaletteForLG('Output', async (_node, inputs, ctx) => {
    const state = (ctx.lgAccumulatedState ?? inputs.content ?? {}) as Record<string, unknown>
    const msgs = Array.isArray(state.messages) ? state.messages as Array<{ role?: string; content?: string }> : []
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
    const text = String(state.final_answer ?? lastAssistant?.content ?? state.task ?? '')
    return { outputs: { content: text, final_state: state }, duration_ms: 0 }
  })

  const wfPermissionGate = getRegisteredExecutor('PermissionGate')
  wrapPaletteForLG('PermissionGate', async (node, inputs, ctx) => {
    const state = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
    const req = (inputs.permission_request ?? {}) as Record<string, unknown>
    const toolName = String(
      state.tool
      ?? state.last_tool
      ?? inputs.tool_name
      ?? inputs.action
      ?? req.tool_name
      ?? req.action
      ?? node.params.tool_name
      ?? '',
    )
    if (!wfPermissionGate) {
      return { outputs: { allowed: true, decision: 'allow' }, duration_ms: 0 }
    }
    return wfPermissionGate(node, {
      ...inputs,
      tool_name: toolName,
      action: toolName,
      skip_permissions: ctx.runContext?.skip_permissions === true,
    }, ctx)
  })

  for (const toolType of LG_PALETTE_TOOL_TYPES) {
    wrapPaletteForLG(toolType, async (node, _inputs, ctx) => {
      const state = (ctx.lgAccumulatedState ?? {}) as Record<string, unknown>
      return executeLGToolDispatch(node, state, ctx, toolType)
    })
  }

  register('LG_Pluripotent', async (node, inputs, ctx) => {
    const state = (inputs.state as Record<string, unknown>) ?? {}
    const allowed = String(node.params.allowed_types ?? 'LLM,LG_ToolNode')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const pick = allowed[0] ?? 'LG_ToolNode'
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
        branch: 'finish',
      },
      duration_ms: 0,
    }
  })

  register('LG_Differentiate', async (node, inputs, ctx) => {
    const state = (inputs.state as Record<string, unknown>) ?? {}
    const target = String(state.pending_class ?? 'LG_ToolNode')
    const nodeId = `diff_${Date.now()}`
    ctx.runTrace?.differentiation_traces?.push({
      from_node: node.id,
      from_class: node.class_type,
      to_node: nodeId,
      to_class: target,
      materialized_append: { node_id: nodeId, class_type: target },
    })
    return {
      outputs: { state: { ...state, differentiated: target, node_id: nodeId } },
      duration_ms: 0,
    }
  })

  register('LG_EvolutionGuard', async (node, inputs) => {
    const state = (inputs.state as Record<string, unknown>) ?? {}
    const max = Number(node.params.max_differentiations ?? 7)
    const count = Number(state.differentiation_count ?? 0)
    const allowed = count < max
    return {
      outputs: {
        state: { ...state, evolution_allowed: allowed },
        allowed,
      },
      duration_ms: 0,
    }
  })

  register('LG_Stop', async (_node, inputs) => ({
    outputs: { state: { ...(inputs.state as Record<string, unknown>), evolution_stopped: true } },
    duration_ms: 0,
  }))

  register('LGRunExportWF', async (node, inputs, ctx) => {
    let mat = inputs.materialized_graph as LGRunResult['materialized_graph'] | undefined
    if ((!mat?.nodes?.length) && inputs.state && typeof inputs.state === 'object') {
      const st = inputs.state as Record<string, unknown>
      mat = st.materialized_graph as LGRunResult['materialized_graph'] | undefined
    }
    if (!mat?.nodes?.length) {
      const nodeId = String(inputs.node_id ?? `mat_export_${node.id}`)
      mat = { nodes: [nodeId], links: [{ from: node.id, to: nodeId }] }
    }
    const specName = String(node.params.spec_name ?? ctx.runTrace?.workflow_id ?? 'LG Export')
    const stubGraph = new Graph(specName)
    for (const nid of [...new Set(mat.nodes)]) {
      stubGraph.addNode('StaticData', 0, 0, nid)
    }
    const wfJson = materializedToWorkflowJson(stubGraph, mat, String(node.params.output_name ?? `${specName} WF`))
    return { outputs: { wf_json: wfJson, node_count: mat.nodes.length }, duration_ms: 0 }
  })
}
