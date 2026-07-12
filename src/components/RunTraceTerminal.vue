<script setup lang="ts">
import { computed } from 'vue'
import type { TerminalLine } from '@/engine/run-trace-formatter'

const props = defineProps<{
  lines: TerminalLine[]
}>()

const displayLines = computed(() => props.lines.slice(-100))
</script>

<template>
  <div class="run-trace-terminal">
    <div class="run-trace-header">Terminal</div>
    <pre class="run-trace-body"><span
      v-for="(line, i) in displayLines"
      :key="i"
      class="run-trace-line"
      :class="`run-trace-line--${line.kind}`"
    >{{ line.text }}
</span><span v-if="displayLines.length === 0" class="run-trace-empty">等待运行…</span></pre>
  </div>
</template>

<style scoped>
.run-trace-terminal {
  display: flex;
  flex-direction: column;
  background: #f9fafb;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  font-family: var(--font-mono);
}
.run-trace-header {
  padding: 4px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.run-trace-body {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text);
  flex: 1;
}
.run-trace-line {
  display: block;
}
.run-trace-line--step_start { color: #1d4ed8; }
.run-trace-line--tool_use { color: #c2410c; }
.run-trace-line--tool_result { color: var(--color-text-muted); padding-left: 2ch; }
.run-trace-line--text { color: var(--color-text); }
.run-trace-line--error { color: #b91c1c; }
.run-trace-line--step_done { color: #047857; }
.run-trace-empty {
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
