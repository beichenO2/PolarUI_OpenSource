#!/usr/bin/env node
/** 260524 可选：Hermes LG live LLM（仅 POLAR_HERMES_LIVE_LLM=1） */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.POLAR_HERMES_LIVE_LLM !== '1') {
  console.log('SKIP: POLAR_HERMES_LIVE_LLM not set — headless mock covered by run-hermes-lg-smoke')
  process.exit(0)
}

console.log('→ hermes-lg live LLM path…')
const r = spawnSync('npx', ['tsx', 'scripts/run-hermes-lg-smoke.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  encoding: 'utf8',
  env: { ...process.env, POLAR_HERMES_LIVE_LLM: '1' },
})
process.exit(r.status ?? 1)
