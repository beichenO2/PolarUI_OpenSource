<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  loadSuggestions,
  saveSuggestions,
  approveSuggestion,
  rejectSuggestion,
  deferSuggestion,
  updateTargetChecked,
  applyApprovedSuggestion,
  kindLabel,
  kindIcon,
  type EvolutionSuggestion,
  type SuggestionStatus,
} from '@/engine/suggestion-store'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; approved: [EvolutionSuggestion] }>()

const filter = ref<'all' | SuggestionStatus>('all')
const suggestions = ref<EvolutionSuggestion[]>(loadSuggestions())
const expandedId = ref<string | null>(null)
const confirmId = ref<string | null>(null)

watch(
  () => props.open,
  (v) => {
    if (v) suggestions.value = loadSuggestions()
  },
)

const filtered = computed(() => {
  if (filter.value === 'all') return suggestions.value
  return suggestions.value.filter(s => s.status === filter.value)
})

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function onCheck(sug: EvolutionSuggestion, targetId: string, ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked
  updateTargetChecked(sug.id, targetId, checked)
  suggestions.value = loadSuggestions()
}

function canApprove(sug: EvolutionSuggestion): boolean {
  return sug.status === 'pending' && sug.apply_targets.some(t => t.checked)
}

function askApprove(sug: EvolutionSuggestion) {
  if (!canApprove(sug)) return
  confirmId.value = sug.id
}

function doApprove() {
  const id = confirmId.value
  if (!id) return
  const result = approveSuggestion(id)
  confirmId.value = null
  suggestions.value = loadSuggestions()
  if (result) {
    void applyApprovedSuggestion(result).then(applied => {
      if (applied.length) console.info('[SuggestionInbox] applied:', applied)
    })
    emit('approved', result)
  }
}

function doReject(sug: EvolutionSuggestion) {
  if (!window.confirm(`拒绝建议「${sug.title}」？`)) return
  rejectSuggestion(sug.id)
  suggestions.value = loadSuggestions()
}

function doDefer(sug: EvolutionSuggestion) {
  deferSuggestion(sug.id)
  suggestions.value = loadSuggestions()
}

function prettyDiff(sug: EvolutionSuggestion): string {
  try {
    return JSON.stringify(sug.diff, null, 2)
  } catch {
    return String(sug.diff)
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="inbox-overlay" @click.self="emit('close')">
      <aside class="inbox-drawer">
        <header class="inbox-header">
          <h2>💡 进化建议</h2>
          <button class="btn btn-sm" @click="emit('close')">关闭</button>
        </header>

        <div class="inbox-filters">
          <button
            v-for="f in (['all', 'pending', 'approved', 'rejected'] as const)"
            :key="f"
            class="filter-btn"
            :class="{ active: filter === f }"
            @click="filter = f"
          >
            {{ f === 'all' ? '全部' : f === 'pending' ? '待处理' : f === 'approved' ? '已批准' : '已拒绝' }}
          </button>
        </div>

        <div class="inbox-list">
          <div v-if="filtered.length === 0" class="inbox-empty">暂无建议</div>
          <article
            v-for="sug in filtered"
            :key="sug.id"
            class="inbox-item"
            :class="{ 'inbox-item--danger': sug.kind.includes('REMOVE') }"
          >
            <div class="inbox-item-head" @click="toggleExpand(sug.id)">
              <span class="kind-icon">{{ kindIcon(sug.kind) }}</span>
              <div class="inbox-item-meta">
                <strong>{{ sug.title }}</strong>
                <span class="inbox-sub">{{ kindLabel(sug.kind) }} · {{ sug.source }} · {{ new Date(sug.created_at).toLocaleString() }}</span>
              </div>
              <span class="status-badge" :data-status="sug.status">{{ sug.status }}</span>
            </div>

            <div v-if="expandedId === sug.id" class="inbox-detail">
              <p class="rationale">{{ sug.rationale }}</p>
              <pre class="diff-preview">{{ prettyDiff(sug) }}</pre>
              <div class="apply-targets">
                <label v-for="t in sug.apply_targets" :key="t.id" class="target-row">
                  <input
                    type="checkbox"
                    :checked="t.checked"
                    :disabled="sug.status !== 'pending'"
                    @change="onCheck(sug, t.id, $event)"
                  />
                  {{ t.label }}
                </label>
              </div>
              <div v-if="sug.status === 'pending'" class="inbox-actions">
                <button class="btn btn-primary" :disabled="!canApprove(sug)" @click="askApprove(sug)">批准选中</button>
                <button class="btn" @click="doReject(sug)">全部拒绝</button>
                <button class="btn btn-sm" @click="doDefer(sug)">稍后处理</button>
              </div>
            </div>
          </article>
        </div>

        <div v-if="confirmId" class="inbox-confirm">
          <p>确定将选中项写入 registry / node-defs？（开发期仅更新建议状态 + audit）</p>
          <button class="btn btn-primary" @click="doApprove">确认批准</button>
          <button class="btn" @click="confirmId = null">取消</button>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.inbox-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 9000;
  display: flex;
  justify-content: flex-end;
}
.inbox-drawer {
  width: min(420px, 92vw);
  height: 100%;
  background: var(--color-surface);
  border-left: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  color: var(--color-text);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
}
.inbox-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}
.inbox-header h2 { margin: 0; font-size: 16px; }
.inbox-filters {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}
.filter-btn {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.filter-btn.active {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
.inbox-list { flex: 1; overflow-y: auto; padding: 8px; }
.inbox-empty { text-align: center; color: var(--color-text-muted); padding: 24px; font-size: 12px; }
.inbox-item {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  margin-bottom: 8px;
  overflow: hidden;
  background: #fff;
}
.inbox-item--danger { border-color: #fecaca; }
.inbox-item-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  cursor: pointer;
}
.inbox-item-head:hover { background: #f9fafb; }
.kind-icon { font-size: 18px; }
.inbox-item-meta { flex: 1; min-width: 0; }
.inbox-item-meta strong { display: block; font-size: 13px; }
.inbox-sub { font-size: 10px; color: var(--color-text-muted); }
.status-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  background: #f3f4f6;
  text-transform: uppercase;
}
.status-badge[data-status='pending'] { background: #fef3c7; color: #b45309; }
.status-badge[data-status='approved'] { background: #ecfdf5; color: var(--color-valid); }
.inbox-detail { padding: 0 10px 10px; border-top: 1px solid var(--color-border); }
.rationale { font-size: 12px; color: var(--color-text-muted); margin: 8px 0; }
.diff-preview {
  font-size: 10px;
  background: #f9fafb;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  max-height: 160px;
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
}
.apply-targets { margin: 8px 0; }
.target-row {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  margin: 4px 0;
}
.inbox-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.inbox-confirm {
  padding: 12px;
  border-top: 1px solid var(--color-border);
  background: #f9fafb;
  font-size: 12px;
}
</style>
