<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useWorkflowStore } from '@/stores/workflow'
import {
  formatExecutionError,
  formatExecutionToTerminal,
  formatNodeStepStart,
  formatTextDelta,
  type TerminalLine,
} from '@/engine/run-trace-formatter'
import RunTraceTerminal from './RunTraceTerminal.vue'

const emit = defineEmits<{
  traceLines: [lines: TerminalLine[]]
}>()

const workflowStore = useWorkflowStore()
const conversationId = ref(`sidebar_${Date.now()}`)
const messages = ref<Array<{ id: string; role: 'user' | 'assistant'; content: string }>>([])
const input = ref('')
const sending = ref(false)
const turnIndex = ref(0)
const traceLines = ref<TerminalLine[]>([])

const running = computed(() => workflowStore.execution.status === 'running')
const currentNode = computed(() => workflowStore.execution.current_node)
const streamPreview = computed(() => {
  const s = workflowStore.execution.streaming
  if (!s) return ''
  return Object.values(s).join('')
})

watch(
  () => workflowStore.execution,
  (ex) => {
    const lines = formatExecutionToTerminal(ex)
    if (lines.length) {
      traceLines.value = [...traceLines.value, ...lines].slice(-200)
      emit('traceLines', traceLines.value)
    }
  },
  { deep: true },
)

async function sendMessage() {
  const text = input.value.trim()
  if (!text || sending.value) return

  messages.value.push({ id: `u_${Date.now()}`, role: 'user', content: text })
  input.value = ''
  sending.value = true
  traceLines.value.push(formatNodeStepStart('chat', 'UserMessage'))
  traceLines.value.push(formatTextDelta(text))

  const { content, error } = await workflowStore.executeWithMessage(text, {
    conversation_id: conversationId.value,
    turn_index: turnIndex.value++,
  })

  if (error) {
    traceLines.value.push(formatExecutionError(error))
    messages.value.push({ id: `a_${Date.now()}`, role: 'assistant', content: `错误：${error}` })
  } else {
    messages.value.push({ id: `a_${Date.now()}`, role: 'assistant', content: content ?? '（无回复）' })
  }
  emit('traceLines', traceLines.value)
  sending.value = false
}
</script>

<template>
  <div class="chat-sidebar">
    <div class="chat-sidebar-header">
      <span class="chat-sidebar-title">Chat</span>
      <span class="chat-sidebar-wf">{{ workflowStore.currentName }}</span>
    </div>

    <div v-if="running && currentNode" class="chat-run-progress">
      运行中 · {{ currentNode }}
    </div>
    <div v-if="streamPreview" class="chat-stream-preview">{{ streamPreview }}</div>

    <div class="chat-messages">
      <div
        v-for="m in messages"
        :key="m.id"
        class="chat-msg"
        :class="`chat-msg--${m.role}`"
      >
        {{ m.content }}
      </div>
      <div v-if="sending && !streamPreview" class="chat-msg chat-msg--assistant chat-msg--pending">
        执行中…
      </div>
    </div>

    <div class="chat-composer">
      <textarea
        v-model="input"
        rows="2"
        placeholder="发消息测试当前工作流…"
        :disabled="sending"
        @keydown.enter.exact.prevent="sendMessage"
      />
      <button class="btn btn-run btn-sm" :disabled="sending || !input.trim()" @click="sendMessage">
        发送
      </button>
    </div>

    <RunTraceTerminal :lines="traceLines" class="chat-terminal" />
  </div>
</template>

<style scoped>
.chat-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d1117;
  border-left: 1px solid #30363d;
  min-width: 320px;
  max-width: 420px;
}
.chat-sidebar-header {
  padding: 10px 12px;
  border-bottom: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chat-sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: #e6edf3;
}
.chat-sidebar-wf {
  font-size: 11px;
  color: #8b949e;
  truncate: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}
.chat-run-progress {
  padding: 6px 12px;
  font-size: 11px;
  color: #7ee8fa;
  background: #161b22;
  border-bottom: 1px solid #21262d;
}
.chat-stream-preview {
  padding: 6px 12px;
  font-size: 11px;
  color: #c9d1d9;
  max-height: 80px;
  overflow: auto;
  border-bottom: 1px solid #21262d;
}
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-msg {
  font-size: 12px;
  line-height: 1.45;
  padding: 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg--user {
  align-self: flex-end;
  background: #1f4a7a;
  color: #e6edf3;
  max-width: 92%;
}
.chat-msg--assistant {
  align-self: flex-start;
  background: #21262d;
  color: #c9d1d9;
  max-width: 92%;
}
.chat-msg--pending {
  opacity: 0.7;
  font-style: italic;
}
.chat-composer {
  padding: 8px 10px;
  border-top: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-composer textarea {
  width: 100%;
  resize: vertical;
  min-height: 48px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 12px;
  font-family: inherit;
}
.chat-terminal {
  max-height: 180px;
  border-top: 1px solid #30363d;
}
</style>
