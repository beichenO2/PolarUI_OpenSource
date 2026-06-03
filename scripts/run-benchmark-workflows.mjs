#!/usr/bin/env node
/**
 * 批量试跑 benchmark 工作流 — 对齐 09 用户原话：组建成 WF 并 **试跑** 确认能用
 * compile-check + headless executeGraph / executeLGSpec + trace
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { loadSuggestions } from '../src/engine/suggestion-store.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF_DIR = join(ROOT, 'workflows')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'trace')

const BENCHMARKS = [
  { id: 'R1', file: 'benchmark-openevolve-step.json', trace: 'R1-openevolve-step.json' },
  { id: 'R2', file: 'benchmark-openclaw-proposal.json', trace: 'R2-openclaw-proposal.json' },
  { id: 'R3', file: 'benchmark-evoagentx-autobuild.json', trace: 'R3-evoagentx-autobuild.json' },
  { id: 'R4', file: 'benchmark-evoagentx-evolve-loop.json', trace: 'R4-evoagentx-evolve-loop.json' },
  { id: 'R5', file: 'benchmark-evot-observe.lg.json', trace: 'R5-evot-observe.json', lg: true },
]

/** headless inbox（R2 OpenClaw 用户说：提案进建议，禁止静默写盘） */
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  }
}

mkdirSync(TRACE_DIR, { recursive: true })
bootstrapHeadlessEngine()

let failed = 0
function ok(msg) { console.log('OK:', msg) }
function fail(msg) { console.error('FAIL:', msg); failed++ }

async function executeBenchmark(bench, wfPath) {
  if (bench.lg) {
    const graph = loadWorkflowJson(readFileSync(wfPath, 'utf8'))
    const { steps, unhealthy_nodes, runTrace } = await executeLGSpec(graph, { agentId: 'benchmark-r5' })
    if (unhealthy_nodes?.length) {
      fail(`${bench.id} LG unhealthy: ${unhealthy_nodes.map(u => u.error).join('; ')}`)
      return null
    }
    if ((steps?.length ?? 0) < 1) fail(`${bench.id} LG produced 0 steps`)
    else ok(`${bench.id} executeLGSpec completed (${steps.length} steps)`)
    return { mode: 'lg_execute', steps: steps.length, status: runTrace?.status }
  }

  const graph = loadWorkflowJson(readFileSync(wfPath, 'utf8'))
  const { merged_output, unhealthy_nodes, runTrace, results } = await executeGraph(graph, { agentId: `benchmark-${bench.id}` })
  if (unhealthy_nodes.length) {
    fail(`${bench.id} unhealthy: ${unhealthy_nodes.map(u => `${u.class_type}:${u.error}`).join('; ')}`)
    return null
  }
  ok(`${bench.id} executeGraph completed`)

  if (bench.id === 'R2') {
    const approvalNode = graph.nodes.find(n => n.class_type === 'HumanApproval')
    const approval = approvalNode ? results.get(approvalNode.id) : undefined
    if (approval?.outputs?.approved !== false) {
      fail('R2 HumanApproval must default reject (auto_approve=false)')
    } else ok('R2 HumanApproval default reject')
    const benchSugs = loadSuggestions().filter(s => s.source === 'benchmark')
    if (!benchSugs.some(s => s.status === 'pending')) {
      fail('R2 push_suggestion → inbox pending')
    } else ok('R2 proposal → suggestion inbox (11 用户说)')
  }

  if (bench.id === 'R3') {
    const out = merged_output
    const blob = typeof out === 'string' ? out : JSON.stringify(out ?? '')
    const wfJsonStr = typeof out === 'object' && out && out.input_1 != null
      ? String(out.input_1)
      : blob
    if (!/"class_type"/.test(wfJsonStr)) fail('R3 output missing workflow class_type')
    else ok('R3 autobuild output contains workflow JSON')
    try {
      const parsed = JSON.parse(wfJsonStr)
      const keys = Object.keys(parsed).filter(k => !k.startsWith('_'))
      if (keys.length < 3) fail(`R3 workflow JSON has ${keys.length} nodes, need ≥3`)
      else ok(`R3 workflow JSON ≥3 nodes (${keys.length})`)
    } catch {
      fail('R3 workflow JSON not parseable')
    }
  }

  return {
    mode: 'wf_execute',
    merged_output: merged_output ?? null,
    run_id: runTrace?.run_id,
    node_traces: runTrace?.node_traces?.length ?? 0,
  }
}

for (const bench of BENCHMARKS) {
  console.log(`\n=== ${bench.id} ${bench.file} ===`)
  const wfPath = join(WF_DIR, bench.file)
  if (!existsSync(wfPath)) {
    fail(`missing ${bench.file}`)
    continue
  }

  try {
    execSync(`node cli/compile-check.mjs "${wfPath}"`, { cwd: ROOT, stdio: 'pipe' })
    ok('compile-check passed')
  } catch (e) {
    fail(`compile-check failed: ${e.stderr?.toString() || e.message}`)
    continue
  }

  const wf = JSON.parse(readFileSync(wfPath, 'utf8'))
  const nodes = Object.entries(wf).filter(([k]) => !k.startsWith('_'))

  const execResult = await executeBenchmark(bench, wfPath)

  const trace = {
    benchmark_id: bench.id,
    workflow_file: bench.file,
    executed_at: new Date().toISOString(),
    mode: execResult?.mode ?? 'execute_failed',
    node_count: nodes.length,
    compile_check: 'passed',
    execute: execResult,
    note: bench.lg
      ? 'R5 LG observe stub — headless step loop'
      : '09 用户原话：headless 试跑（StaticData 占位 Evolve* / Planner）',
  }

  const tracePath = join(TRACE_DIR, bench.trace)
  writeFileSync(tracePath, JSON.stringify(trace, null, 2) + '\n')
  ok(`trace → ${tracePath}`)
}

console.log(`\n=== Summary: ${BENCHMARKS.length - failed}/${BENCHMARKS.length} passed ===`)
process.exit(failed > 0 ? 1 : 0)
