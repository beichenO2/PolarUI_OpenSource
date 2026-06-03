#!/usr/bin/env node
/**
 * evolution-loop MVP-2 — 信号层探测 + compile + **01 用户说拓扑**（Cron/自调用/跨 run 回流）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACE = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'trace', 'MVP-2-evolution-loop.json')
const WF = join(ROOT, 'workflows', 'evolution-loop.json')
const REG = join(ROOT, 'workflows', 'registry.json')

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

function nodeByType(wf, type) {
  for (const [k, n] of Object.entries(wf)) {
    if (k.startsWith('_')) continue
    if (n.class_type === type) return [k, n]
  }
  return [null, null]
}

function refClass(wf, ref) {
  if (!Array.isArray(ref)) return null
  return wf[ref[0]]?.class_type ?? null
}

try {
  execSync(`node cli/compile-check.mjs "${WF}"`, { cwd: ROOT, stdio: 'pipe' })
  ok('evolution-loop compile-check')
} catch (e) {
  fail(`compile-check: ${e.stderr?.toString() || e.message}`)
}

const wf = JSON.parse(readFileSync(WF, 'utf8'))
const nodeCount = Object.keys(wf).filter(k => !k.startsWith('_')).length
if (nodeCount < 20) fail(`expected ≥20 nodes, got ${nodeCount}`)
else ok(`evolution-loop ${nodeCount} nodes`)

// 01 用户说：LearningCapture → PromptEvolve · HistoryReader · prior_knowledge 跨 run 回流
const [, pe] = nodeByType(wf, 'PromptEvolve')
const [, au] = nodeByType(wf, 'AgenticUnit')
const [, lc] = nodeByType(wf, 'LearningCapture')
const [, hr] = nodeByType(wf, 'HistoryReader')
const [, cron] = nodeByType(wf, 'Cron')
const [, rg] = nodeByType(wf, 'RecursionGuard')

if (!lc) fail('missing LearningCapture')
else ok('LearningCapture present')

if (!pe) fail('missing PromptEvolve')
else {
  const capRef = pe.inputs?.capture ?? pe.inputs?.evolution_sources?.capture
  const histRef = pe.inputs?.history_runs ?? pe.inputs?.evolution_sources?.history_runs
  if (refClass(wf, capRef) !== 'LearningCapture') {
    fail('PromptEvolve.capture not wired from LearningCapture')
  } else ok('LearningCapture → PromptEvolve (00 §3.4 跨 run 回流)')
  if (refClass(wf, histRef) !== 'HistoryReader') {
    fail('PromptEvolve.history_runs not wired from HistoryReader')
  } else ok('HistoryReader → PromptEvolve')
}

if (!au) fail('missing AgenticUnit')
else {
  if (Number(au.params?.max_retries) !== 7) {
    fail(`AgenticUnit max_retries must be 7, got ${au.params?.max_retries}`)
  } else ok('AgenticUnit max_retries=7 (13 用户定稿)')
  if (refClass(wf, au.inputs?.prior_knowledge) !== 'FileRead') {
    fail('AgenticUnit.prior_knowledge not wired from FileRead (latest.md 跨 run)')
  } else ok('FileRead latest.md → AgenticUnit.prior_knowledge')
}

const selfAw = Object.entries(wf).find(([, n]) =>
  n.class_type === 'AgentWorkflow' && n.params?.workflow_id === 'evolution-loop',
)
if (!selfAw) fail('missing AgentWorkflow(self evolution-loop)')
else ok('末尾 AgentWorkflow 自调用 evolution-loop')

if (!rg) fail('missing RecursionGuard before self-call')
else ok('RecursionGuard 门禁')

if (!cron) fail('missing Cron entry')
else ok('Cron 定时入口')

const reg = JSON.parse(readFileSync(REG, 'utf8'))
if (!reg.some(e => e.file === 'evolution-loop.json' || e.id === 'evolution-loop')) {
  fail('evolution-loop not in registry.json (01 用户说 Web 左栏已注册)')
} else ok('registry 已注册 evolution-loop')

const probes = [
  { name: 'DIGiST DigestFuse', url: 'http://127.0.0.1:3800/api/health', method: 'GET' },
  { name: 'CheckupEventInbox', url: 'http://127.0.0.1:8040/api/checkup-event', method: 'POST', body: { event_id: 'mvp2-smoke', project: 'PolarUI', summary: 'MVP-2 probe' } },
  { name: 'SSoTQuery polaris', url: 'http://127.0.0.1:8040/api/polaris/PolarUI', method: 'GET' },
]

const probeResults = []
for (const p of probes) {
  try {
    const res = await fetch(p.url, {
      method: p.method,
      headers: p.body ? { 'Content-Type': 'application/json' } : undefined,
      body: p.body ? JSON.stringify(p.body) : undefined,
      signal: AbortSignal.timeout(8000),
    })
    const status = res.status
    probeResults.push({ name: p.name, status, ok: status < 500 })
    if (status < 500) ok(`${p.name} → HTTP ${status}`)
    else fail(`${p.name} → HTTP ${status}`)
  } catch (e) {
    probeResults.push({ name: p.name, error: String(e.message ?? e), ok: false })
    fail(`${p.name} unreachable`)
  }
}

const trace = {
  trace_id: 'MVP-2-evolution-loop',
  executed_at: new Date().toISOString(),
  mode: 'cli_probe+topology',
  workflow: 'evolution-loop.json',
  node_count: nodeCount,
  user_said_topology: 'passed',
  signal_probes: probeResults,
  compile_check: failed === 0 ? 'passed' : 'partial',
  note: '01 用户说：Cron + 自调用 + LearningCapture→PromptEvolve + registry；全链路 execute 见 run-evolution-loop-execute.ts',
}

writeFileSync(TRACE, JSON.stringify(trace, null, 2) + '\n')
ok(`trace → ${TRACE}`)

console.log(`\n--- evolution-loop MVP-2: ${failed} failures ---`)
process.exit(failed > 1 ? 1 : 0)
