#!/usr/bin/env node
/**
 * History 落盘 smoke — run-trace-bridge + 模拟 trace 写入
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'scripts', 'run-trace-bridge.mjs')

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

async function waitHealth(maxMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch('http://127.0.0.1:3922/health')
      if (r.ok) return true
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const bridge = spawn('node', [BRIDGE], { stdio: 'ignore', detached: true })
bridge.unref()

if (!(await waitHealth())) {
  fail('run-trace-bridge did not start')
  process.exit(1)
}
ok('run-trace-bridge up')

const envelope = {
  run_id: `smoke_${Date.now()}`,
  workflow_id: 'history-smoke',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  status: 'completed',
  trigger: 'cli_smoke',
  node_traces: [{ node_id: '1', class_type: 'StaticData', library: 'WF', duration_ms: 0 }],
  loop_traces: [],
  usage_traces: [],
  differentiation_traces: [],
}

const writeRes = await fetch('http://127.0.0.1:3922/api/runs/write', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(envelope),
})
if (!writeRes.ok) fail(`write ${writeRes.status}`)
else {
  const data = await writeRes.json()
  const abs = data.abs_path
  if (!abs || !existsSync(abs)) fail(`file missing: ${abs}`)
  else {
    const raw = readFileSync(abs, 'utf8')
    if (!raw.includes(envelope.run_id)) fail('trace content mismatch')
    else ok(`trace written → ${data.log_path}`)
  }
}

const listRes = await fetch('http://127.0.0.1:3922/api/runs/list?limit=5')
if (!listRes.ok) fail('list runs')
else {
  const { runs } = await listRes.json()
  if (!runs?.length) fail('empty runs list')
  else ok(`runs/list → ${runs.length} entries`)
}

// History category in node-defs
const evolve = JSON.parse(readFileSync(join(ROOT, '..', 'node-defs', 'evolve.json'), 'utf8'))
const hist = evolve.filter(d => d.category === 'History')
if (hist.length < 2) fail('HistorySink/HistoryReader not category History')
else ok(`History nodes: ${hist.map(h => h.class_type).join(', ')}`)

try {
  if (bridge.pid) process.kill(bridge.pid, 'SIGTERM')
} catch { /* already exited */ }
console.log(`\n--- history smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
