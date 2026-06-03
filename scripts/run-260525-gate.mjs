#!/usr/bin/env node
/** 260525 批次 gate — 见 任务书/Done/260525_整理归档/260525/14 §2.1 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLAW = join(ROOT, '..', 'PolarClaw')

const steps = [
  ['session-memory-probe', 'npx', ['tsx', join(CLAW, 'scripts/run-session-memory-probe.mjs')]],
  ['working-memory-smoke', 'npx', ['tsx', 'scripts/run-working-memory-smoke.mjs']],
  ['multi-turn-smoke', 'npx', ['tsx', 'scripts/run-multi-turn-smoke.mjs']],
  ['deploy-manifest-smoke', 'node', ['scripts/run-deploy-manifest-smoke.mjs']],
  ['chat-runtime-probe', 'node', ['scripts/run-chat-runtime-probe.mjs']],
  ['260524_1-regression', 'node', ['scripts/run-260524_1-gate.mjs']],
]

let failed = 0
console.log('=== 260525 batch gate ===\n')

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

console.log(`\n--- 260525 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
