#!/usr/bin/env node
/**
 * evolution-loop 生产 Cron 守护 — 按间隔 headless 执行并追加 metrics
 *
 * 用法:
 *   npx tsx scripts/run-evolution-loop-cron-daemon.ts --ticks=7 --interval-ms=60000
 *   npx tsx scripts/run-evolution-loop-cron-daemon.ts --once
 *
 * 真实 7×24h：interval-ms=1800000（30min，对齐 workflow Cron 表达式）
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const METRICS_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'metrics')
const EXEC = join(ROOT, 'scripts', 'run-evolution-loop-execute.ts')

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1]! : fallback
}

const once = process.argv.includes('--once')
const ticks = once ? 1 : Number(arg('ticks', '7'))
const intervalMs = Number(arg('interval-ms', '1800000'))

mkdirSync(METRICS_DIR, { recursive: true })
const metricsPath = join(METRICS_DIR, 'cron-production.jsonl')

const runs: unknown[] = []

for (let i = 1; i <= ticks; i++) {
  console.log(`\n[cron-daemon] tick ${i}/${ticks}`)
  const r = spawnSync(
    'npx',
    ['tsx', EXEC, ...(process.env.POLAR_EVOLUTION_LIVE_LLM === '1' ? ['--live-llm'] : [])],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000 },
  )
  const entry = {
    tick: i,
    at: new Date().toISOString(),
    exit_code: r.status ?? 1,
    status: r.status === 0 ? 'pass' : 'fail',
    stdout_tail: (r.stdout ?? '').slice(-800),
    stderr_tail: (r.stderr ?? '').slice(-400),
  }
  runs.push(entry)
  writeFileSync(metricsPath, (existsSync(metricsPath) ? readFileSync(metricsPath, 'utf8') : '') + JSON.stringify(entry) + '\n')
  console.log(`[cron-daemon] tick ${i} → ${entry.status}`)
  if (!once && i < ticks) {
    console.log(`[cron-daemon] sleep ${intervalMs}ms …`)
    await new Promise(res => setTimeout(res, intervalMs))
  }
}

const passCount = runs.filter(r => (r as { status: string }).status === 'pass').length
console.log(`\n--- cron-daemon: ${passCount}/${ticks} passed → ${metricsPath} ---`)
process.exit(passCount >= Math.ceil(ticks * 0.7) ? 0 : 1)
