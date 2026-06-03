#!/usr/bin/env node
/** 01 批次外：--live-llm 全路径（仅 POLAR_EVOLUTION_LIVE_LLM=1 时执行） */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.POLAR_EVOLUTION_LIVE_LLM !== '1') {
  console.log('SKIP: POLAR_EVOLUTION_LIVE_LLM not set — stub path covered by evolution-loop-execute')
  process.exit(0)
}

console.log('→ evolution-loop-execute --live-llm (optional full path)…')
const r = spawnSync('npx', ['tsx', 'scripts/run-evolution-loop-execute.ts', '--live-llm'], {
  cwd: ROOT,
  stdio: 'inherit',
  encoding: 'utf8',
})
process.exit(r.status ?? 1)
