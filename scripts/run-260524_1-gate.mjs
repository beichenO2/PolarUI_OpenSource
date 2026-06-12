#!/usr/bin/env node
/** 260524_1 批次 gate — 见 任务书/Done/260524_1_整理归档/260524_1/14 §2.1 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const steps = [
  ['vault-probe', 'npx', ['tsx', 'scripts/run-polarprivate-vault-probe.mjs']],
  ['seed-compile-wf', 'node', ['cli/compile-check.mjs', 'workflows/mvp-seed-wf.json']],
  ['seed-prompt', 'npx', ['tsx', 'scripts/run-seed-prompt-check.mjs']],
  ['seed-smoke', 'npx', ['tsx', 'scripts/run-seed-smoke.mjs']],
  ['mvp-seed-live', 'npx', ['tsx', 'scripts/run-mvp-seed-live-smoke.mjs']],
  ['260524-regression', 'node', ['scripts/run-260524-gate.mjs']],
]

let failed = 0
console.log('=== 260524_1 batch gate ===\n')

for (const [name, cmd, args] of steps) {
  process.stdout.write(`→ ${name} … `)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env: process.env })
  if (r.status === 0) {
    console.log('PASS')
  } else {
    console.log('FAIL')
    const tail = (r.stderr || r.stdout || '').slice(-500)
    if (tail) console.error(tail)
    failed++
  }
}

console.log(`\n--- 260524_1 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
