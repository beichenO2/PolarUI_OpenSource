#!/usr/bin/env node
/**
 * 260523 批次门禁 — 聚合全部 CLI smoke + test:cross
 * 用法: node scripts/run-260523-gate.mjs
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const steps = [
  { name: 'build', cmd: 'npm', args: ['run', 'build'] },
  { name: 'benchmark-workflows', cmd: 'npx', args: ['tsx', 'scripts/run-benchmark-workflows.mjs'] },
  { name: 'seed-smoke', cmd: 'npx', args: ['tsx', 'scripts/run-seed-smoke.mjs'] },
  { name: 'evolution-loop-smoke', cmd: 'node', args: ['scripts/run-evolution-loop-smoke.mjs'] },
  { name: 'evolution-loop-execute', cmd: 'npx', args: ['tsx', 'scripts/run-evolution-loop-execute.ts'] },
  { name: 'recursion-guard', cmd: 'npx', args: ['tsx', 'scripts/run-recursion-guard-smoke.ts'] },
  { name: 'cron-sim-7d', cmd: 'npx', args: ['tsx', 'scripts/run-evolution-loop-cron-sim.ts'] },
  { name: 'loop-trace', cmd: 'npx', args: ['tsx', 'scripts/run-loop-trace-smoke.mjs'] },
  { name: 'plan-validator', cmd: 'npx', args: ['tsx', 'scripts/run-plan-validator-smoke.mjs'] },
  { name: 'sample-loop', cmd: 'npx', args: ['tsx', 'scripts/run-sample-loop-smoke.mjs'] },
  { name: 'ocr-g4-probe', cmd: 'npx', args: ['tsx', 'scripts/run-ocr-g4-probe.mjs'] },
  { name: 'history-smoke', cmd: 'node', args: ['scripts/run-history-smoke.mjs'] },
  { name: 'prompt-evolve', cmd: 'npx', args: ['tsx', 'scripts/run-prompt-evolve-smoke.mjs'] },
  { name: 'models-probe', cmd: 'npx', args: ['tsx', 'scripts/run-models-probe.mjs'] },
  { name: 'stream-smoke', cmd: 'npx', args: ['tsx', 'scripts/run-stream-smoke.mjs'] },
  { name: 'planner-smoke', cmd: 'npx', args: ['tsx', 'scripts/run-planner-smoke.mjs'] },
  { name: 'suggestion-remove', cmd: 'npx', args: ['tsx', 'scripts/run-suggestion-remove-smoke.mjs'] },
  { name: 'empty-shell-audit', cmd: 'npx', args: ['tsx', 'scripts/run-empty-shell-audit.mjs'] },
  { name: 'ecosystem-prewarm', cmd: 'node', args: ['scripts/ensure-ecosystem-services.mjs'] },
  { name: 'ecosystem-smoke', cmd: 'npx', args: ['tsx', 'scripts/run-ecosystem-smoke.mjs'] },
  { name: 'palette-smoke', cmd: 'npx', args: ['tsx', 'scripts/run-palette-smoke.mjs'] },
  { name: 'evolution-loop-live-llm', cmd: 'node', args: ['scripts/run-evolution-loop-live-llm.mjs'] },
  { name: 'test:cross', cmd: 'npm', args: ['run', 'test:cross'] },
]

let failed = 0
console.log('=== 260523 batch gate ===\n')

for (const step of steps) {
  process.stdout.write(`→ ${step.name} … `)
  let r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0 && (step.name === 'test:cross' || step.name === 'history-smoke')) {
    console.log('RETRY …')
    if (step.name === 'test:cross') {
      spawnSync('node', ['scripts/ensure-ecosystem-services.mjs'], { cwd: ROOT, stdio: 'ignore' })
    }
    r = spawnSync(step.cmd, step.args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' })
  }
  if (r.status === 0) {
    console.log('PASS')
  } else {
    console.log(`FAIL (exit ${r.status})`)
    if (r.stderr) console.error(r.stderr.slice(-500))
    failed++
  }
}

console.log(`\n--- 260523 gate: ${failed} failures / ${steps.length} steps ---`)
process.exit(failed ? 1 : 0)
