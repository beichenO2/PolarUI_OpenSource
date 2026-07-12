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
  font-family: var(--font-mono);
  background: #f9fafb;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}
.executor-snippet-pre :deep(.tok-comment) { color: #6e7781; font-style: italic; }
.executor-snippet-pre :deep(.tok-string) { color: #0a3069; }
.executor-snippet-pre :deep(.tok-keyword) { color: #cf222e; }
.executor-snippet-pre :deep(.tok-number) { color: #0550ae; }
.executor-snippet-pre :deep(.tok-type) { color: #953800; }
.executor-snippet-pre :deep(.tok-fn) { color: #8250df; }
.executor-snippet-pre :deep(.tok-ident) { color: #24292f; }
</style>
