#!/usr/bin/env node
/** 260524 批次 gate — 见 任务书/Done/260524_整理归档/260524/14 §2.1 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const steps = [
  ['hermes-lg', 'npx', ['tsx', 'scripts/run-hermes-lg-smoke.mjs']],
  ['claude-code-lg', 'npx', ['tsx', 'scripts/run-claude-code-lg-smoke.mjs']],
  ['polarcloud-lg', 'npx', ['tsx', 'scripts/run-polarcloud-lg-smoke.mjs']],
  ['hermes-wf', 'npx', ['tsx', 'scripts/run-hermes-wf-smoke.mjs']],
  ['claude-code-wf', 'npx', ['tsx', 'scripts/run-claude-code-wf-smoke.mjs']],
  ['evolution-hermes-align', 'npx', ['tsx', 'scripts/run-evolution-hermes-align-smoke.mjs']],
  ['260523-regression', 'node', ['scripts/run-260523-gate.mjs']],
  ['polarclaw-web-build', 'npm', ['run', 'build']],
]

let failed = 0
console.log('=== 260524 batch gate ===\n')

for (const [name, cmd, args] of steps) {
  process.stdout.write(`→ ${name} … `)
  const cwd = name === 'polarclaw-web-build' ? join(ROOT, '..', 'PolarClaw', 'web') : ROOT
  const r = spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
  if (r.status === 0) {
    console.log('PASS')
  } else {
    console.log('FAIL')
    if (r.stderr) console.error(r.stderr.slice(-400))
    failed++
  }
}

console.log(`\n--- 260524 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
