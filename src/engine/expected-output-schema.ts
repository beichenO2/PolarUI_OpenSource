/**
 * PromptInput 输出预期：JSON 对象，键为分块字段名，值为该块须匹配的正则（function-calling 式多段 JSON 产出）。
 */
export function validateExpectedOutputBlocks(raw: unknown): { valid: boolean; message: string } {
  if (raw == null) {
    return { valid: false, message: '输出预期为空' }
  }
  let obj: Record<string, unknown>
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return { valid: false, message: '输出预期为空' }
    try {
      obj = JSON.parse(t) as Record<string, unknown>
    } catch {
      return {
        valid: false,
        message: '输出预期须为 JSON 对象，例如 {"summary":"\\"title\\"\\\\s*:" ,"body":"\\"sections\\"\\\\s*:"}',
      }
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  } else {
    return { valid: false, message: '输出预期须为 JSON 对象（非数组）' }
  }

  const keys = Object.keys(obj)
  if (keys.length < 1) {
    return { valid: false, message: '输出预期 JSON 至少包含 1 个分块字段名' }
  }
  for (const k of keys) {
    const v = obj[k]
    if (typeof v !== 'string' || !String(v).trim()) {
      return { valid: false, message: `输出预期.${k} 须为非空字符串（该块产出的匹配正则）` }
    }
  }
  return { valid: true, message: '' }
}
