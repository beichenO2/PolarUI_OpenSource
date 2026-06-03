#!/usr/bin/env node
/**
 * RecursionGuard 5–10 层有界 smoke（MVP-3 信号层）
 * 用法: npx tsx scripts/run-recursion-guard-smoke.mjs
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'
import type { NodeInstance } from '../src/engine/types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const METRICS_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'metrics')

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const guardNode: NodeInstance = {
  id: 'rg1',
  class_type: 'RecursionGuard',
  params: { workflow_key: 'smoke-rg', max_depth: 10, cooldown_ms: 0, value: 'ok' },
  position: { x: 0, y: 0 },
}

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
}

let depthReached = 0
for (let i = 0; i < 12; i++) {
  const r = await executeNode(guardNode, ctx)
  if (r.outputs.stop_reason === 'depth_limit') {
    depthReached = i
    break
  }
  if (r.outputs.stop_reason !== 'ok') {
    fail(`unexpected stop at ${i}: ${r.outputs.stop_reason}`)
    break
  }
}

if (depthReached !== 10) fail(`depth_limit at ${depthReached}, expected 10`)
else ok('RecursionGuard depth_limit at 10')

mkdirSync(METRICS_DIR, { recursive: true })
const day = new Date().toISOString().slice(0, 10)
const metricsPath = join(METRICS_DIR, `${day}.json`)
const metrics = {
  date: day,
  mode: 'cli_smoke',
  recursion_guard: { max_depth: 10, depth_limit_at: depthReached, status: depthReached === 10 ? 'pass' : 'fail' },
  note: 'MVP-3 七天长跑占位；真实 Cron 指标待 evolution-loop 生产跑',
}
writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + '\n')
ok(`metrics → ${metricsPath}`)

console.log(`\n--- recursion-guard smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
