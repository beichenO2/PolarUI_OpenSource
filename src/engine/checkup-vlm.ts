/**
 * Checkup Triage VLM — screenshot understanding for @checkup-agent pipeline.
 * Prefers PolarPrivate L101 (Ollama proxy); falls back to direct Ollama chat API.
 */

const OLLAMA_CHAT = 'http://127.0.0.1:11434/api/chat'
const POLARPRIVATE_PORT = '12790'
const LLM_PROXY_V1 = `http://127.0.0.1:${POLARPRIVATE_PORT}/v1`

export type CheckupVlmInput = {
  screenshotB64: string
  userText?: string
  annotations?: unknown[]
  pageUrl?: string
  model?: string
  timeoutMs?: number
}

export type CheckupVlmResult = {
  visual_summary: string
  severity: 'low' | 'medium' | 'high' | 'unknown'
  vlm_backend: 'polarprivate' | 'ollama' | 'none'
  error?: string
}

function stripDataUri(b64: string): string {
  return b64.replace(/^data:image\/\w+;base64,/, '').trim()
}

function formatAnnotations(annotations: unknown[] | undefined): string {
  if (!annotations?.length) return '（无批注）'
  return annotations
    .slice(0, 12)
    .map((a, i) => {
      const o = a as Record<string, unknown>
      const label = o.label ?? o.text ?? o.note ?? ''
      const x = o.x ?? o.left
      const y = o.y ?? o.top
      return `#${i + 1} (${x ?? '?'},${y ?? '?'}) ${String(label).slice(0, 80)}`
    })
    .join('\n')
}

function buildTriagePrompt(input: CheckupVlmInput): string {
  return `你是检修分诊助手。根据截图、用户文字和批注坐标，用 3–5 句话说明：
1) 页面上可见的问题或异常
2) 严重度：低 / 中 / 高（必须在文中明确写出「严重度：低/中/高」之一）
3) 批注区域与问题的关联

不要编造截图中看不见的内容。若无法判断，说明原因。

用户描述：${input.userText?.trim() || '（无）'}
页面 URL：${input.pageUrl?.trim() || '（无）'}
批注列表：
${formatAnnotations(input.annotations)}`
}

function parseSeverity(text: string): CheckupVlmResult['severity'] {
  const m = text.match(/严重度[：:]\s*(低|中|高)/i)
  if (!m) return 'unknown'
  if (m[1] === '低') return 'low'
  if (m[1] === '中') return 'medium'
  return 'high'
}

async function describeViaPolarPrivate(
  cleanB64: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const dataUri = `data:image/png;base64,${cleanB64}`
  const res = await fetch(`${LLM_PROXY_V1}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'L101',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`PolarPrivate VLM ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

async function describeViaOllama(
  cleanB64: string,
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(OLLAMA_CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt, images: [cleanB64] }],
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Ollama VLM ${res.status}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content?.trim() ?? ''
}

/** Describe checkup screenshot; returns empty visual_summary when skipped or backends offline. */
export async function describeCheckupScreenshot(
  input: CheckupVlmInput,
): Promise<CheckupVlmResult> {
  const clean = stripDataUri(input.screenshotB64)
  if (!clean) {
    return { visual_summary: '', severity: 'unknown', vlm_backend: 'none' }
  }

  const prompt = buildTriagePrompt(input)
  const timeoutMs = input.timeoutMs ?? 90_000
  const model = input.model ?? 'qwen3-vl'
  const errors: string[] = []

  try {
    const text = await describeViaPolarPrivate(clean, prompt, timeoutMs)
    if (text) {
      return {
        visual_summary: text,
        severity: parseSeverity(text),
        vlm_backend: 'polarprivate',
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }

  try {
    const text = await describeViaOllama(clean, prompt, model, timeoutMs)
    if (text) {
      return {
        visual_summary: text,
        severity: parseSeverity(text),
        vlm_backend: 'ollama',
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }

  return {
    visual_summary: '',
    severity: 'unknown',
    vlm_backend: 'none',
    error: errors.join('; ') || 'VLM unavailable',
  }
}
