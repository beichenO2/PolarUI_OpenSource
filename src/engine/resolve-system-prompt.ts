/** 从 node.params 解析 system prompt（inline 或 prompts/*.txt 文件） */
import { hubFileRead } from '@/api/tools'

async function readPromptFileHeadless(rel: string): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const polarUiRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const normalized = rel.replace(/^PolarUI\//, '').replace(/^prompts\//, 'prompts/')
  const full = join(
    polarUiRoot,
    normalized.startsWith('prompts/') ? normalized : `prompts/${normalized.split('/').pop()}`,
  )
  return readFileSync(full, 'utf8').trim()
}

export async function resolveSystemPromptBase(node: { params: Record<string, unknown> }): Promise<string> {
  const inline = String(node.params.system_prompt ?? '').trim()
  if (inline) return inline

  const file = String(node.params.system_prompt_file ?? '').trim()
  if (!file) return ''

  const hubPath = file.startsWith('PolarUI/') ? file : `PolarUI/${file.replace(/^\//, '')}`
  try {
    const data = await hubFileRead(hubPath)
    return data.content.trim()
  } catch {
    try {
      return await readPromptFileHeadless(file)
    } catch {
      return ''
    }
  }
}

/** 从 LLM 输出文本中提取 workflow JSON 对象 */
export function extractWorkflowJson(seed: unknown): Record<string, unknown> | null {
  const text = typeof seed === 'string' ? seed : seed != null ? JSON.stringify(seed) : ''
  if (!text.trim()) return null

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]
  const raw = (fenced ?? text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
