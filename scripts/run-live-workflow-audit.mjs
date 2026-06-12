#!/usr/bin/env node
/**
 * 260527 Phase 2 — live LLM 工作流审计
 * Usage:
 *   npx tsx scripts/run-live-workflow-audit.mjs [--pending] [--file workflows/foo.json]
 * trace: 任务书/Done/260527_整理归档/260527/trace/live-workflow-audit.jsonl
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { isPrivPortalHealthy } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF_DIR = join(ROOT, 'workflows')
const TRACE = join(ROOT, '..', '任务书', 'Done', '260527_整理归档', '260527', 'trace', 'live-workflow-audit.jsonl')
const TIMEOUT_MS = Number(process.env.LIVE_WF_TIMEOUT_MS ?? 600_000)

const ENV_SKIP = [/process-watchdog/, /ocr-g4/]
const PENDING_ONLY = process.argv.includes('--pending')
const FAIL_ONLY = process.argv.includes('--fail-only')
const GATE_MODE = process.argv.includes('--gate')
const MAX_ARG = (() => {
  const i = process.argv.indexOf('--max')
  return i >= 0 ? Number(process.argv[i + 1]) : undefined
})()
const fileArg = (() => {
  const i = process.argv.indexOf('--file')
  return i >= 0 ? process.argv[i + 1] : undefined
})()

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

function collectFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) { collectFiles(abs, acc); continue }
    if (name.endsWith('.json') && name !== 'registry.json') acc.push(abs)
  }
  return acc
}

function loadAuditIndex() {
  const map = new Map()
  if (!existsSync(TRACE)) return map
  for (const line of readFileSync(TRACE, 'utf8').split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line)
      if (row.workflow) map.set(row.workflow, row)
    } catch { /* skip */ }
  }
  return map
}

function needsRun(rel, index) {
  if (ENV_SKIP.some(re => re.test(rel))) return false
  if (!PENDING_ONLY) return true
  const prev = index.get(rel.replace(/\.json$/, ''))
  if (!prev) return true
  const live = String(prev.live ?? '')
  return live === 'PENDING' || live === 'PARTIAL' || live.startsWith('PARTIAL')
}

async function runOne(abs) {
  const rel = relative(WF_DIR, abs)
  const wfKey = rel.replace(/\.json$/, '')
  if (ENV_SKIP.some(re => re.test(rel))) {
    appendFileSync(TRACE, JSON.stringify({
      ts: new Date().toISOString(),
      workflow: wfKey,
      library: 'WF',
      compile: 'PASS',
      live: 'SKIP',
      note: 'env dependency',
      agent_verdict: 'ENV_SKIP',
    }) + '\n')
    ok(`${wfKey} SKIP env`)
    return
  }

  const graph = loadWorkflowJson(readFileSync(abs, 'utf8'))
  const ctrl = AbortSignal.timeout(TIMEOUT_MS)
  const run = executeGraph(graph, { agentId: 'live-audit' })

  let live = 'PASS'
  let note = ''
  try {
    const result = await Promise.race([
      run,
      new Promise((_, reject) => {
        ctrl.addEventListener('abort', () => reject(new Error(`timeout ${TIMEOUT_MS}ms`)))
      }),
    ])
    if (result.unhealthy_nodes?.length) {
      live = 'FAIL'
      note = result.unhealthy_nodes.map(u => u.error).join('; ').slice(0, 300)
      fail(`${wfKey} unhealthy: ${note}`)
    } else {
      ok(`${wfKey} live PASS`)
    }
  } catch (e) {
    live = 'FAIL'
    note = e instanceof Error ? e.message : String(e)
    fail(`${wfKey} ${note}`)
  }

  appendFileSync(TRACE, JSON.stringify({
    ts: new Date().toISOString(),
    workflow: wfKey,
    library: 'WF',
    compile: 'PASS',
    live,
    note,
    agent_verdict: live === 'PASS' ? 'live execute OK' : `needs fix: ${note.slice(0, 120)}`,
  }) + '\n')
}

mkdirSync(dirname(TRACE), { recursive: true })
if (!existsSync(TRACE)) writeFileSync(TRACE, '')

if (!(await isPrivPortalHealthy())) {
  console.log('SKIP: PolarPrivate vault not unlocked — live audit requires vault')
  console.log('Set POLAR_LIVE_AUDIT=1 after vault unlock to force gate step')
  process.exit(process.env.POLAR_LIVE_AUDIT === '1' ? 1 : 0)
}

bootstrapHeadlessEngine()
process.env.POLAR_HEADLESS_DRY_RUN = process.env.POLAR_HEADLESS_DRY_RUN ?? '1'
const index = loadAuditIndex()

if (GATE_MODE) {
  const gateFiles = [
    join(WF_DIR, 'test-demo-fileread.json'),
    join(WF_DIR, 'test-multi-turn-chat.json'),
  ].filter(existsSync)
  console.log(`=== live-workflow-audit gate (${gateFiles.length} smokes) ===\n`)
  for (const abs of gateFiles) await runOne(abs)
  console.log(`\n--- live audit gate: ${failed} failures ---`)
  process.exit(failed ? 1 : 0)
}

const index2 = loadAuditIndex()
let files = collectFiles(WF_DIR).sort()
if (fileArg) {
  files = files.filter(f => f.endsWith(fileArg) || f.includes(fileArg))
}
if (PENDING_ONLY) {
  files = files.filter(f => needsRun(relative(WF_DIR, f), index2))
}
if (FAIL_ONLY) {
  files = files.filter(f => index2.get(relative(WF_DIR, f).replace(/\.json$/, ''))?.live === 'FAIL')
}
if (MAX_ARG != null && MAX_ARG > 0) {
  files = files.slice(0, MAX_ARG)
}

console.log(`=== live-workflow-audit (${files.length} files, pending=${PENDING_ONLY}) ===\n`)
for (const abs of files) {
  await runOne(abs)
}

console.log(`\n--- live audit: ${failed} failures / ${files.length} ---`)
console.log(`trace: ${TRACE}`)
process.exit(failed ? 1 : 0)
