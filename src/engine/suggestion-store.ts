/**
 * 进化建议 inbox — localStorage 持久化 + 种子数据
 * SSOT schema: 任务书/Done/260523_整理归档/260523/11_进化建议与人审闸门.md §2
 */
import seedSuggestions from '../../data/evolution-suggestions.json'

export type SuggestionKind =
  | 'ADD_WORKFLOW'
  | 'ADD_NODE_DEF'
  | 'REMOVE_NODE_DEF'
  | 'MODIFY_WORKFLOW'
  | 'MODIFY_NODE_DEF'

export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'partial'

export interface ApplyTarget {
  id: string
  label: string
  checked: boolean
}

export interface EvolutionSuggestion {
  id: string
  kind: SuggestionKind
  status: SuggestionStatus
  created_at: string
  source: 'seed' | 'petri_dish' | 'pluripotent' | 'learning_capture' | 'skill_capture' | 'manual' | 'benchmark'
  title: string
  rationale: string
  diff: {
    path?: string
    before?: unknown
    after?: unknown
    patch?: string
  }
  apply_targets: ApplyTarget[]
}

const STORAGE_KEY = 'polarui-evolution-suggestions'
const AUDIT_KEY = 'polarui-suggestion-audit'

type AuditEntry = {
  ts: string
  action: 'approve' | 'reject' | 'defer'
  suggestion_id: string
  targets: string[]
}

function readStorage(): EvolutionSuggestion[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as EvolutionSuggestion[]
  } catch { /* ignore */ }
  return structuredClone(seedSuggestions) as EvolutionSuggestion[]
}

function writeStorage(list: EvolutionSuggestion[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

function appendAudit(entry: AuditEntry) {
  const prev = localStorage.getItem(AUDIT_KEY)
  const lines = prev ? prev.split('\n').filter(Boolean) : []
  lines.push(JSON.stringify(entry))
  localStorage.setItem(AUDIT_KEY, lines.join('\n') + '\n')
}

export function loadSuggestions(): EvolutionSuggestion[] {
  return readStorage()
}

export function saveSuggestions(list: EvolutionSuggestion[]) {
  writeStorage(list)
}

export function pendingCount(list: EvolutionSuggestion[]): number {
  return list.filter(s => s.status === 'pending').length
}

export function pushSuggestion(partial: Omit<EvolutionSuggestion, 'id' | 'created_at' | 'status'> & { id?: string }) {
  const list = readStorage()
  const item: EvolutionSuggestion = {
    ...partial,
    id: partial.id ?? `sug-${Date.now().toString(36)}`,
    created_at: new Date().toISOString(),
    status: 'pending',
    apply_targets: partial.apply_targets.map(t => ({ ...t, checked: false })),
  }
  list.unshift(item)
  writeStorage(list)
  return item
}

export function updateTargetChecked(suggestionId: string, targetId: string, checked: boolean) {
  const list = readStorage()
  const sug = list.find(s => s.id === suggestionId)
  if (!sug) return
  const t = sug.apply_targets.find(x => x.id === targetId)
  if (t) t.checked = checked
  writeStorage(list)
}

export function approveSuggestion(suggestionId: string): EvolutionSuggestion | null {
  const list = readStorage()
  const sug = list.find(s => s.id === suggestionId)
  if (!sug || sug.status !== 'pending') return null
  const checked = sug.apply_targets.filter(t => t.checked)
  if (checked.length === 0) return null
  sug.status = checked.length === sug.apply_targets.length ? 'approved' : 'partial'
  writeStorage(list)
  appendAudit({
    ts: new Date().toISOString(),
    action: 'approve',
    suggestion_id: suggestionId,
    targets: checked.map(t => t.id),
  })
  return sug
}

const SUGGESTION_BRIDGE = 'http://127.0.0.1:3921'

/** 批准后尝试经 suggestion-bridge 写盘（开发期） */
export async function applyApprovedSuggestion(sug: EvolutionSuggestion): Promise<string[]> {
  const checked = sug.apply_targets.filter(t => t.checked)
  if (!checked.length) return []
  try {
    const res = await fetch(`${SUGGESTION_BRIDGE}/api/suggestion/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion: sug, target_ids: checked.map(t => t.id) }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`bridge ${res.status}`)
    const data = (await res.json()) as { applied?: string[] }
    return data.applied ?? []
  } catch {
    return []
  }
}

export function rejectSuggestion(suggestionId: string) {
  const list = readStorage()
  const sug = list.find(s => s.id === suggestionId)
  if (!sug) return
  sug.status = 'rejected'
  writeStorage(list)
  appendAudit({ ts: new Date().toISOString(), action: 'reject', suggestion_id: suggestionId, targets: [] })
}

export function deferSuggestion(suggestionId: string) {
  appendAudit({ ts: new Date().toISOString(), action: 'defer', suggestion_id: suggestionId, targets: [] })
}

export function kindLabel(kind: SuggestionKind): string {
  const map: Record<SuggestionKind, string> = {
    ADD_WORKFLOW: '新增工作流',
    ADD_NODE_DEF: '新增组件',
    REMOVE_NODE_DEF: '删除组件',
    MODIFY_WORKFLOW: '修改工作流',
    MODIFY_NODE_DEF: '修改组件',
  }
  return map[kind] ?? kind
}

export function kindIcon(kind: SuggestionKind): string {
  const map: Record<SuggestionKind, string> = {
    ADD_WORKFLOW: '➕',
    ADD_NODE_DEF: '🧩',
    REMOVE_NODE_DEF: '➖',
    MODIFY_WORKFLOW: '✏️',
    MODIFY_NODE_DEF: '🔧',
  }
  return map[kind] ?? '💡'
}
