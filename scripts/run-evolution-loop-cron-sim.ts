#!/usr/bin/env node
/**
 * MVP-3 加速 Cron 模拟 — 7 tick 信号探测 + metrics 落盘（非真实 7×24h）
 * 用法: npx tsx scripts/run-evolution-loop-cron-sim.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const METRICS_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'metrics')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'trace')
const WF = join(ROOT, 'workflows', 'evolution-loop.json')

let failed = 0
function ok(m: string) { console.log('OK:', m) }
function fail(m: string) { console.error('FAIL:', m); failed++ }

try {
  execSync(`node cli/compile-check.mjs "${WF}"`, { cwd: ROOT, stdio: 'pipe' })
  ok('evolution-loop compile-check')
} catch (e) {
  fail(`compile-check: ${(e as { message?: string }).message}`)
}

const probes = [
  { name: 'DIGiST', url: 'http://127.0.0.1:3800/api/health' },
  { name: 'Checkup', url: 'http://127.0.0.1:8040/api/checkup-event', method: 'POST' as const, body: { event_id: 'cron-sim', project: 'PolarUI', summary: 'tick' } },
  { name: 'SSoT', url: 'http://127.0.0.1:8040/api/polaris/PolarUI' },
]

const days: Array<{ tick: number; date: string; probes: unknown[]; status: string }> = []

for (let tick = 1; tick <= 7; tick++) {
  const tickResults = []
  for (const p of probes) {
    try {
      const res = await fetch(p.url, {
        method: p.method ?? 'GET',
        headers: p.body ? { 'Content-Type': 'application/json' } : undefined,
        body: p.body ? JSON.stringify({ ...p.body, event_id: `cron-sim-d${tick}` }) : undefined,
        signal: AbortSignal.timeout(6000),
      })
      tickResults.push({ name: p.name, status: res.status, ok: res.status < 500 })
    } catch (e) {
      tickResults.push({ name: p.name, ok: false, error: String((e as Error).message ?? e) })
    }
  }
  const allOk = tickResults.every(r => (r as { ok?: boolean }).ok)
  days.push({
    tick,
    date: new Date(Date.now() - (7 - tick) * 86400000).toISOString().slice(0, 10),
    probes: tickResults,
    status: allOk ? 'pass' : 'degraded',
  })
  ok(`cron tick ${tick}/7 → ${allOk ? 'pass' : 'degraded'}`)
}

mkdirSync(METRICS_DIR, { recursive: true })
mkdirSync(TRACE_DIR, { recursive: true })

const metricsPath = join(METRICS_DIR, 'cron-sim-7d.json')
const metrics = {
  mode: 'accelerated_cron_sim',
  ticks: 7,
  executed_at: new Date().toISOString(),
  days,
  note: 'CLI 加速模拟；生产 7×24h Cron 仍待 evolution-loop 部署',
}
writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + '\n')
ok(`metrics → ${metricsPath}`)

const tracePath = join(TRACE_DIR, 'MVP-3-cron-sim-7d.json')
writeFileSync(tracePath, JSON.stringify({ trace_id: 'MVP-3-cron-sim-7d', ...metrics, status: failed ? 'partial' : 'pass' }, null, 2) + '\n')
ok(`trace → ${tracePath}`)

const passTicks = days.filter(d => d.status === 'pass').length
if (passTicks < 5) fail(`only ${passTicks}/7 ticks passed signal probes`)
else ok(`${passTicks}/7 ticks signal-ok`)

console.log(`\n--- evolution-loop cron-sim: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
