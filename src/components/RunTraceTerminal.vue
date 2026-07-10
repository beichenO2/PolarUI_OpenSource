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
  background: #0a0e14;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.run-trace-header {
  padding: 4px 10px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6e7681;
  border-bottom: 1px solid #21262d;
}
.run-trace-body {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  color: #c9d1d9;
  flex: 1;
}
.run-trace-line {
  display: block;
}
.run-trace-line--step_start { color: #7ee8fa; }
.run-trace-line--tool_use { color: #ffa657; }
.run-trace-line--tool_result { color: #8b949e; padding-left: 2ch; }
.run-trace-line--text { color: #e6edf3; }
.run-trace-line--error { color: #f85149; }
.run-trace-line--step_done { color: #3fb950; }
.run-trace-empty {
  color: #484f58;
  font-style: italic;
}
</style>
