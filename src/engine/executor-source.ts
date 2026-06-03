import executorModule from './executor.ts?raw'

const cache = new Map<string, string | null>()

/** 提取 registerExecutor('ClassType', …) 完整函数体，供只读文档页展示 */
export function extractExecutorSource(classType: string): string | null {
  if (cache.has(classType)) return cache.get(classType) ?? null
  const src = executorModule
  const needle = `registerExecutor('${classType}'`
  const alt = `registerExecutor("${classType}"`
  let start = src.indexOf(needle)
  if (start < 0) start = src.indexOf(alt)
  if (start < 0) {
    cache.set(classType, null)
    return null
  }
  const braceStart = src.indexOf('{', start)
  if (braceStart < 0) {
    cache.set(classType, null)
    return null
  }
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const block = src.slice(start, end).trim()
  cache.set(classType, block)
  return block
}
