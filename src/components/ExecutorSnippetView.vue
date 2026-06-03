<script setup lang="ts">
import { computed } from 'vue'
import { highlightExecutorSnippet } from '@/engine/executor-code-display'

const props = defineProps<{
  source: string
  class?: string
}>()

const html = computed(() => highlightExecutorSnippet(props.source))
</script>

<template>
  <pre class="executor-snippet-pre" :class="props.class"><code v-html="html" /></pre>
</template>

<style scoped>
.executor-snippet-pre {
  margin: 0;
  padding: 10px;
  font-size: 10px;
  line-height: 1.5;
  font-family: ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', monospace;
  background: #1e1e1e;
  border: 1px solid #3c3c3c;
  border-radius: 6px;
  color: #d4d4d4;
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}
.executor-snippet-pre :deep(.tok-comment) { color: #6a9955; font-style: italic; }
.executor-snippet-pre :deep(.tok-string) { color: #ce9178; }
.executor-snippet-pre :deep(.tok-keyword) { color: #569cd6; }
.executor-snippet-pre :deep(.tok-number) { color: #b5cea8; }
.executor-snippet-pre :deep(.tok-type) { color: #4ec9b0; }
.executor-snippet-pre :deep(.tok-fn) { color: #dcdcaa; }
.executor-snippet-pre :deep(.tok-ident) { color: #9cdcfe; }
</style>
