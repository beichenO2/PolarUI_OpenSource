#!/usr/bin/env node
/** 260527 批次 gate — 见 任务书/Done/260527_整理归档/260527/14 §2.1 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const steps = [
  ['searchable-picker', 'node', ['scripts/run-searchable-picker-smoke.mjs']],
  ['all-workflows-matrix', 'npx', ['tsx', 'scripts/run-all-workflows-gate.mjs', '--compile-only']],
  ['live-workflow-audit', 'npx', ['tsx', 'scripts/run-live-workflow-audit.mjs', '--gate']],
  ['sidebar-chat', 'npx', ['tsx', 'scripts/run-sidebar-chat-smoke.mjs']],
  ['terminal-display', 'npx', ['tsx', 'scripts/run-terminal-trace-smoke.mjs']],
  ['chat-stream', 'npx', ['tsx', 'scripts/run-chat-stream-smoke.mjs']],
  ['260526-regression', 'node', ['scripts/run-260526-gate.mjs']],
]

let failed = 0
console.log('=== 260527 batch gate ===\n')

for (const [name, cmd, args] of steps) {
  process.stdout.write(`→ ${name} … `)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env: process.env })
  if (r.status === 0) {
    console.log('PASS')
  } else {
    console.log('FAIL')
    const tail = (r.stderr || r.stdout || '').slice(-800)
    if (tail) console.error(tail)
    failed++
  }
}

console.log(`\n--- 260527 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
