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
  /** cloud = upstream APIs; local = L000 8B / L100 32B / L101 VLM */
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

/** 3-bit QCS → opaque cloud id (no vendor model names). */
export function cloudCapabilityToModelId(code: string): string {
  return (code ?? '000').padEnd(3, '0').slice(0, 3).replace(/[^01]/g, '0')
}

/** 3-bit QCS → local L-code (L000 8B / L100 32B / L101 VLM). */
export function localCapabilityToModelId(code: string): string {
  const qcs = cloudCapabilityToModelId(code)
  if (qcs === '101') return 'L101'
  if (qcs === '100') return 'L100'
  return 'L000'
}

function resolveModelId(code: string, tier: 'cloud' | 'local'): string {
  return tier === 'local' ? localCapabilityToModelId(code) : cloudCapabilityToModelId(code)
}

/** Human-readable aliases → PolarPrivate capability codes */
const MODEL_ALIASES: Record<string, string> = {
  'GLM-5.1': '100',
  'GLM-5': '100',
  'GLM-5-TURBO': '001',
  'GLM-TURBO': '001',
  'ASTRON-CODE-LATEST': '100',
  'CLAUDE-SONNET': '100',
  'CLAUDE-3-SONNET': '100',
  'CLAUDE-3-5-SONNET': '100',
  'QWEN-PLUS': '100',
  'QWEN-MAX': '100',
}

/** Opaque codes: cloud 000–111; local L000/L100/L101; embed E000. */
export function toModelId(model: string, tier: 'cloud' | 'local' = 'cloud'): string {
  const raw = (model ?? '').trim()
  const aliased = MODEL_ALIASES[raw.toUpperCase()] ?? raw
  const m = aliased.toUpperCase()
  if (m === 'L000' || m === 'L100' || m === 'L101') return m
  if (m === 'E000') return 'E000'
  if (/^[01]{3}$/.test(m)) return tier === 'local' ? `L${m}` : m
  throw new Error(`Unknown model code "${m}". Cloud: 000–111. Local: L000, L100, L101. Embed: E000.`)
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

/** 天翼云 llm.ctyun.codingplan 不可达时，按 CAPABILITY_CODES 降级到可用云端码 */
const CTYUN_QUALITY_FALLBACK = ['001', '000'] as const

function isCtyunUpstreamFailure(status: number, text: string): boolean {
  return status === 502 && /ctyun|Cannot connect to upstream/i.test(text)
}

function qualityFallbackCodes(modelId: string): readonly string[] {
  if (modelId === '100' || modelId === '110' || modelId === '111') {
    return [modelId, ...CTYUN_QUALITY_FALLBACK]
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
          choices?: Array<{ delta?: { content?: string } }>
        }
        const delta = parsed.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          content += delta
          onChunk?.(delta)
        }
      } catch { /* skip malformed SSE line */ }
    }
  }

  return { content, toolCalls: [], usage: {}, model: modelId }
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
              if (isCtyunUpstreamFailure(res.status, text) && ci < codesToTry.length - 1) {
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
            if (isCtyunUpstreamFailure(502, lastErr.message) && ci < codesToTry.length - 1) break
            const retryable = /500006|并发|rate.?limit|429/i.test(lastErr.message)
            if (retryable && attempt < maxAttempts) {
              await new Promise(r => setTimeout(r, attempt * 5000))
              continue
            }
            if (ci < codesToTry.length - 1 && /502|ctyun|Cannot connect to upstream/i.test(lastErr.message)) break
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
