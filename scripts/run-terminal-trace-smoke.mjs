#!/usr/bin/env node
/** 260527 Phase 4 — run-trace-formatter terminal 语义 smoke */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatExecutionToTerminal,
  mockRunTraceLines,
  formatToolUse,
  formatToolResult,
  formatTextDelta,
} from '../src/engine/run-trace-formatter.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const mockLines = mockRunTraceLines()
if (mockLines.length < 3) fail(`mockRunTraceLines expected ≥3, got ${mockLines.length}`)
else ok(`mockRunTraceLines ${mockLines.length} lines`)

const kinds = new Set(mockLines.map(l => l.kind))
if (!kinds.has('step_start') || !kinds.has('tool_use') || !kinds.has('text')) {
  fail(`missing claude-stream kinds: ${[...kinds].join(',')}`)
} else ok('claude-stream block kinds present')

const execLines = formatExecutionToTerminal({
  status: 'completed',
  current_node: 'n1',
  streaming: { n2: 'hello stream' },
  results: {
    n1: { outputs: { text: 'done' }, duration_ms: 12 },
  },
  merged_output: 'final output',
})
if (execLines.length < 3) fail(`formatExecutionToTerminal expected ≥3, got ${execLines.length}`)
else ok(`formatExecutionToTerminal ${execLines.length} lines`)

const manual = [
  formatToolUse('FileRead', 'path=package.json'),
  formatToolResult('{"name":"polar-ui"}'),
  formatTextDelta('step complete'),
]
if (manual.some(l => !l.text)) fail('manual formatter empty text')
else ok('manual formatter lines OK')

console.log(`\n--- terminal-trace-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
