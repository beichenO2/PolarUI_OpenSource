/**
 * 浏览器侧规则触发（消费 public/rules-bundle.json）
 */
export interface BundledRule {
  id: string
  level: 'norm' | 'protocol'
  always: boolean
  triggers: string[]
  priority: number
  body: string
}

let _rules: BundledRule[] | null = null

export async function loadRulesBundle(): Promise<BundledRule[]> {
  if (_rules) return _rules
  const res = await fetch('/rules-bundle.json', { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`rules-bundle.json HTTP ${res.status}`)
  const data = (await res.json()) as { rules: BundledRule[] }
  _rules = data.rules ?? []
  return _rules
}

export function selectNormRules(rules: BundledRule[]): BundledRule[] {
  return rules.filter((r) => r.level === 'norm' && r.always).sort((a, b) => b.priority - a.priority)
}

export function selectProtocolRules(inputText: string, rules: BundledRule[]): BundledRule[] {
  const selected: BundledRule[] = []
  for (const r of rules) {
    if (r.level !== 'protocol') continue
    if (r.triggers.some((p) => {
      try {
        const normalized = String(p).replace(/\\\\/g, '\\')
        return new RegExp(normalized, 'i').test(inputText)
      } catch {
        return false
      }
    })) {
      selected.push(r)
    }
  }
  return selected.sort((a, b) => b.priority - a.priority)
}

export function mergeRulesText(rules: BundledRule[]): string {
  return rules.map((r) => `## ${r.id}\n\n${r.body}`).join('\n\n---\n\n')
}
