#!/usr/bin/env node
/** 260526 批次 gate — 见 任务书/Done/260526_整理归档/260526/14 §2.1 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const steps = [
  ['tools-system-matrix', 'npx', ['tsx', 'scripts/run-tools-system-matrix-smoke.mjs']],
  ['demo-fileread-wf', 'npx', ['tsx', 'scripts/run-demo-fileread-smoke.mjs']],
  ['lg-mode-switch', 'npx', ['tsx', 'scripts/run-lg-mode-switch-smoke.mjs']],
  ['evolution-loop', 'node', ['scripts/run-evolution-loop-smoke.mjs']],
  ['evolution-hermes-align', 'npx', ['tsx', 'scripts/run-evolution-hermes-align-smoke.mjs']],
  ['loop-trace', 'npx', ['tsx', 'scripts/run-loop-trace-smoke.mjs']],
  ['skills-registry', 'npx', ['tsx', 'scripts/run-skills-registry-smoke.mjs']],
  ['260525-regression', 'node', ['scripts/run-260525-gate.mjs']],
]

let failed = 0
console.log('=== 260526 batch gate ===\n')

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

console.log(`\n--- 260526 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
