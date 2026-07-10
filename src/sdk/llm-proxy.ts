/**
 * PolarPrivate LLM Proxy SDK（PolarUI）
 *
 * 唯一信源：http://127.0.0.1:12790（PolarPrivate /v1 网关）
 * 调用方不配置端口、不直连上游厂商 API。
 */

export const LLM_PROXY_HOST = '127.0.0.1'
export const LLM_PROXY_PORT = 12790
export const LLM_PROXY_BASE = `http://${LLM_PROXY_HOST}:${LLM_PROXY_PORT}`
export const LLM_PROXY_V1 = `${LLM_PROXY_BASE}/v1`

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** cloud = upstream APIs; local = L0000 embedding */
  tier?: 'cloud' | 'local'
  temperature?: number
  maxTokens?: number
  tools?: unknown
  toolChoice?: string
  timeoutMs?: number
  /** stream:true 时逐 delta 回调 */
  onChunk?: (text: string) => void
  stream?: boolean
}

/** 4-bit QCSA or V-prefix → opaque cloud id (no vendor model names). */
export function cloudCapabilityToModelId(code: string): string {
  const c = (code ?? '').trim()
  if (c.toUpperCase().startsWith('V') && c.length === 5) return c.toUpperCase()
  if (/^[01]{4}$/.test(c)) return c
  return '0001'
}

/** Local: only L0000 (embedding). */
export function localCapabilityToModelId(_code: string): string {
  return 'L0000'
}

function resolveModelId(code: string, tier: 'cloud' | 'local'): string {
  return tier === 'local' ? localCapabilityToModelId(code) : cloudCapabilityToModelId(code)
}

/** Human-readable aliases → PolarPrivate 4-bit QCSA capability codes (SSoT: lib/llm-proxy/qcsa-model.mjs) */
const MODEL_ALIASES: Record<string, string> = {
  'GLM-5.1': '0000',
  'GLM-5': '1000',
  'GLM-5-TURBO': '0010',
  'GLM-TURBO': '0010',
  'ASTRON-CODE-LATEST': '0001',
  'CLAUDE-SONNET': '1000',
  'CLAUDE-3-SONNET': '1000',
  'CLAUDE-3-5-SONNET': '1000',
  'QWEN-PLUS': '1100',
  'QWEN-MAX': '1100',
  'DS-V4-FLASH': '0010',
  'DS-V4-PRO': '0100',
  'MINIMAX-M3': '0110',
  'QWEN3.7-PLUS': '1100',
}

const LEGACY_3BIT_TO_4BIT: Record<string, string> = {
  '000': '0000', '001': '0010', '010': '0100', '011': '0110',
  '100': '0000', '101': '0101', '110': '1100', '111': '1110',
}

/** Opaque codes: cloud 4-bit QCSA / V-prefix; local L0000; embed E000. */
export function toModelId(model: string, tier: 'cloud' | 'local' = 'cloud'): string {
  const raw = (model ?? '').trim()
  const aliased = MODEL_ALIASES[raw.toUpperCase()] ?? raw
  const m = aliased.toUpperCase()
  if (m === 'L0000') return m
  if (m === 'E000') return 'E000'
  if (m.startsWith('V') && m.length === 5) return m
  if (/^[01]{4}$/.test(m)) return tier === 'local' ? 'L0000' : m
  if (/^[01]{3}$/.test(m)) {
    const mapped = LEGACY_3BIT_TO_4BIT[m]
    if (mapped) return tier === 'local' ? `L${mapped}` : mapped
  }
  throw new Error(`Unknown model code "${m}". Cloud: 4-bit QCSA (0000–1111) or V-prefix (V0000). Local: L0000. Embed: E000.`)
}

export interface ChatResult {
  content: string
  toolCalls: unknown[]
  usage: Record<string, unknown>
  model: string
}

export interface LLMProxyClient {
  chat(model: string, messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>
  listModels(): Promise<Array<{ id: string; description?: string }>>
  healthCheck(): Promise<{ ok: boolean; vault_unlocked: boolean }>
}

function chatUrl(): string {
  return `${LLM_PROXY_V1}/chat/completions`
}

/** 上游 502 时降级到可用云端码 */
const QUALITY_FALLBACK = ['0010', '0000'] as const

function isUpstreamFailure(status: number, text: string): boolean {
  return status === 502 && /ctyun|Cannot connect to upstream/i.test(text)
}

function qualityFallbackCodes(modelId: string): readonly string[] {
  if (modelId === '1000' || modelId === '1100' || modelId === '1110' || modelId === '1001' || modelId === '1101') {
    return [modelId, ...QUALITY_FALLBACK]
  }
  if (modelId === '0001' || modelId === '0011' || modelId === '0101' || modelId === '1011') {
    return [modelId, '0000', '0010']
  }
  return [modelId]
}

async function readSseChatCompletion(
  body: ReadableStream<Uint8Array>,
  modelId: string,
  onChunk?: (text: string) => void,
): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  const toolCallAccum: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map()
  let usage: Record<string, unknown> = {}

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
            }
          }>
          usage?: Record<string, unknown>
        }
        const delta = parsed.choices?.[0]?.delta
        if (delta?.content) {
          content += delta.content
          onChunk?.(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, {
                id: tc.id ?? `call_${idx}`,
                type: tc.type ?? 'function',
                function: { name: tc.function?.name ?? '', arguments: '' },
              })
            }
            const existing = toolCallAccum.get(idx)!
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.function.name = tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }
        if (parsed.usage) usage = parsed.usage
      } catch { /* skip malformed SSE line */ }
    }
  }

  const toolCalls = [...toolCallAccum.values()]
  return { content, toolCalls, usage, model: modelId }
}

export function createLLMClient(): LLMProxyClient {
  return {
    async chat(model, messages, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000
      const tier = opts.tier ?? 'cloud'
      const modelId = toModelId(model, tier)
      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        temperature: opts.temperature ?? 0.7,
        stream: opts.stream === true,
      }
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
      if (opts.tools) {
        body.tools = opts.tools
        body.tool_choice = opts.toolChoice ?? 'auto'
      }

      const codesToTry = qualityFallbackCodes(modelId)
      let lastErr: Error | undefined

      for (let ci = 0; ci < codesToTry.length; ci++) {
        const code = codesToTry[ci]
        body.model = code
        const maxAttempts = 4

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const res = await fetch(chatUrl(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(timeoutMs),
            })

            if (!res.ok) {
              const text = await res.text().catch(() => '')
              if (isUpstreamFailure(res.status, text) && ci < codesToTry.length - 1) {
                lastErr = new Error(`LLM Proxy ${res.status}: ${text.slice(0, 400)}`)
                break
              }
              const retryable = /500006|并发|rate.?limit|429/i.test(text)
              if (retryable && attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, attempt * 5000))
                continue
              }
              throw new Error(`LLM Proxy ${res.status}: ${text.slice(0, 400)}`)
            }

            if (opts.stream && res.body) {
              return await readSseChatCompletion(res.body, code, opts.onChunk)
            }

            const data = await res.json() as {
              choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>
              usage?: Record<string, unknown>
              model?: string
            }
            const msg = data.choices?.[0]?.message
            return {
              content: msg?.content ?? '',
              toolCalls: msg?.tool_calls ?? [],
              usage: data.usage ?? {},
              model: data.model ?? code,
            }
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err))
            if (isUpstreamFailure(502, lastErr.message) && ci < codesToTry.length - 1) break
            const retryable = /500006|并发|rate.?limit|429/i.test(lastErr.message)
            if (retryable && attempt < maxAttempts) {
              await new Promise(r => setTimeout(r, attempt * 5000))
              continue
            }
            if (ci < codesToTry.length - 1 && /502|Cannot connect to upstream/i.test(lastErr.message)) break
            throw lastErr
          }
        }
      }
      throw lastErr ?? new Error('LLM Proxy: unknown failure')
    },

    async listModels() {
      const res = await fetch(`${LLM_PROXY_V1}/models`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`LLM Proxy models ${res.status}`)
      const data = await res.json() as { data?: Array<{ id: string; description?: string }> }
      return data.data ?? []
    },

    async healthCheck() {
      try {
        const res = await fetch(`${LLM_PROXY_BASE}/health`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return { ok: false, vault_unlocked: false }
        const data = await res.json() as { vault_unlocked?: boolean }
        return { ok: true, vault_unlocked: data.vault_unlocked === true }
      } catch {
        return { ok: false, vault_unlocked: false }
      }
    },
  }
}

/** 模块级单例，避免重复创建 */
let _client: LLMProxyClient | null = null

export function getLLMClient(): LLMProxyClient {
  if (!_client) _client = createLLMClient()
  return _client
}

/** 测试 / smoke 注入客户端（传 null 恢复默认单例） */
export function setLLMClient(client: LLMProxyClient | null): void {
  _client = client
}

/** 便捷：单轮文本补全 */
export async function chatCompletion(
  model: string,
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<string> {
  const result = await getLLMClient().chat(model, messages, opts)
  if (!result.content && !result.toolCalls.length) {
    throw new Error('LLM Proxy returned empty response')
  }
  return result.content
}

export async function listModels(): Promise<Array<{ id: string; description?: string }>> {
  return getLLMClient().listModels()
}

export async function isPrivPortalHealthy(): Promise<boolean> {
  const h = await getLLMClient().healthCheck()
  return h.ok && h.vault_unlocked
}
