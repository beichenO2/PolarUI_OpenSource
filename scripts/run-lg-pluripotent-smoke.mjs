#!/usr/bin/env node
/**
 * LG Pluripotent 分化 trace + run.json 落盘 smoke
 * 用法: npx tsx scripts/run-lg-pluripotent-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { persistLGRun } from '../src/engine/run-persistence.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'test-lg-pluripotent-smoke.lg.json')
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
if (!(await waitHealth())) fail('run-trace-bridge did not start')
else ok('run-trace-bridge up')

bootstrapHeadlessEngine()
ok('node-defs loaded')

const specRawBefore = readFileSync(WF, 'utf8')
const graph = loadWorkflowJson(specRawBefore)

const result = await executeLGSpec(graph)
const { runTrace, materialized_graph, unhealthy_nodes, steps } = result

if (unhealthy_nodes.length) fail(`unhealthy: ${JSON.stringify(unhealthy_nodes)}`)
else ok('executeLGSpec completed')

const diffs = runTrace?.differentiation_traces ?? []
if (diffs.length < 1) fail('no differentiation_traces')
else ok(`differentiation_traces: ${diffs.length}`)

const first = diffs[0] ?? {}
const STEM_CLASSES = new Set(['LG_Pluripotent', 'StemCell', 'PluripotentCell'])
if (!STEM_CLASSES.has(first.from_class)) fail(`from_class ${first.from_class}`)
else ok(`differentiated ${first.from_class} → ${first.to_class}`)

if (materialized_graph.nodes.length < 4) fail('materialized_graph too short')
else ok(`materialized nodes: ${materialized_graph.nodes.join(' → ')}`)

// 08 用户说：自己给自己建 workflow = Run 物化图衍生，不改 Spec 文件
const specRawAfter = readFileSync(WF, 'utf8')
if (specRawBefore !== specRawAfter) fail('Spec .lg.json mutated during execute (08: 不是改 Spec)')
else ok('Spec 文件 execute 前后不变')

if (materialized_graph.links.length < 1) fail('materialized_graph.links empty (自动往外分支)')
else ok(`materialized links appended: ${materialized_graph.links.length}`)

if ((steps?.length ?? 0) < 1) fail('steps[] empty (路由/步序展示)')
else ok(`steps[] recorded: ${steps.length} (08 用户说 路由/步序/State)`)

if (diffs.length < 1) fail('08: 无 differentiation — 未「自己给自己建 workflow」')
else ok('differentiation 事件 → Run 物化（非改 Spec JSON 文件）')

const paths = await persistLGRun(graph.name, result)
if (!paths?.run_path) fail('persistLGRun missing run_path')
else {
  const abs = join(ROOT, 'runs', runTrace?.run_id ?? '', 'run.json')
  if (!existsSync(abs)) fail(`run.json missing: ${abs}`)
  else {
    const raw = readFileSync(abs, 'utf8')
    if (!raw.includes('materialized_graph')) fail('run.json missing materialized_graph')
    else ok(`run.json → ${paths.run_path}`)
  }
}

try { process.kill(bridge.pid, 'SIGTERM') } catch { /* bridge already exited */ }
console.log(`\n--- lg-pluripotent smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
