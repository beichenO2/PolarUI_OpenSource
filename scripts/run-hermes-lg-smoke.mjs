#!/usr/bin/env node
/**
 * 260524 Phase 1 — Hermes LG execute + SkillCapture inbox + Run 落盘
 * 用法: npx tsx scripts/run-hermes-lg-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { persistLGRun } from '../src/engine/run-persistence.ts'
import { loadSuggestions } from '../src/engine/suggestion-store.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'
import { lgSpecEdgesToDraw } from '../src/engine/lg-canvas-utils.ts'
import { resolveLGToolName } from '../src/engine/lg-runner.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'hermes.lg.json')
const REPLAY = join(ROOT, 'workflows', 'hermes-react-replay.lg.json')
const BRIDGE = join(ROOT, 'scripts', 'run-trace-bridge.mjs')
const TRACE_OUT = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'hermes-lg.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v) },
    removeItem: k => { store.delete(k) },
  }
}

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

// compile-check
const { execSync } = await import('node:child_process')
try {
  execSync(`node cli/compile-check.mjs workflows/hermes.lg.json`, { cwd: ROOT, stdio: 'pipe' })
  ok('hermes.lg.json compile-check PASS')
} catch {
  fail('hermes.lg.json compile-check FAIL')
}

let llmCalls = 0
setLLMClient({
  async chat(_model, messages) {
    llmCalls++
    const branch = llmCalls < 3 ? 'tool' : 'finish'
    return {
      content: JSON.stringify({
        branch,
        thought: `mock step ${llmCalls}`,
        tool: 'ShellExec',
        tool_type: 'terminal',
      }),
      toolCalls: [],
      usage: {},
      model: 'mock',
    }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const specRawBefore = readFileSync(WF, 'utf8')
const graph = loadWorkflowJson(specRawBefore)

if (graph.library !== 'LG') fail('expected LG library')
else ok('LG library')

const lgNodes = graph.nodes.filter(n => !n.class_type.startsWith('LG_') && n.class_type !== 'Ground')
if (lgNodes.length < 20) fail(`palette components ${lgNodes.length} < 20 (full LG spec)`)
else ok(`palette components: ${lgNodes.length}`)

const stem = graph.nodes.some(n => n.class_type === 'StemCell')
if (!stem) fail('missing StemCell（LG 进化槽）')
else ok('StemCell present')

const toolNodes = graph.nodes.filter(n => n.class_type === 'ToolCall')
if (toolNodes.length < 1) fail(`expected ToolCall, got ${toolNodes.length}`)
else ok(`ToolCall dispatch node(s): ${toolNodes.length}`)

const INTERNAL_LG = new Set([
  'LG_Entry', 'LG_End', 'LG_LLM', 'LG_ConditionalEdge', 'LG_ToolNode',
  'LG_Pluripotent', 'LG_Differentiate',
])
const hidden = graph.nodes.filter(n => INTERNAL_LG.has(n.class_type))
if (hidden.length) fail(`Internal LG_* in spec: ${hidden.map(n => n.class_type).join(', ')}`)
else ok('no Internal LG_* types in spec')

if (resolveLGToolName({ react_tool: 'hub_send_prompt' }, { tool: 'WebSearch' }) !== 'WebSearch') {
  fail('resolveLGToolName state.tool')
} else ok('resolveLGToolName state.tool')

// layout: PromptInput 应在 LLM 左侧（x 更小）
const prompt = graph.nodes.find(n => n.class_type === 'PromptInput')
const llm = graph.nodes.find(n => n.class_type === 'LLM')
const output = graph.nodes.find(n => n.class_type === 'Output')
if (prompt && llm && prompt.x >= llm.x) fail(`layout not L→R: PromptInput x=${prompt.x} LLM x=${llm.x}`)
else if (prompt && llm) ok(`layout L→R: PromptInput x=${prompt.x} < LLM x=${llm.x}`)
if (llm && output && llm.x >= output.x) fail(`layout: LLM x=${llm.x} should be left of Output x=${output.x}`)
else if (llm && output) ok(`layout: LLM x=${llm.x} < Output x=${output.x}`)
const reactLoop = (graph.lgEdges ?? []).filter(e => e.label?.includes('ReAct'))
if (reactLoop.length < 1) fail('missing ReAct back-edge')
else ok(`ReAct back-edge: ${reactLoop[0].from}→${reactLoop[0].to}`)

const beforeSkills = loadSuggestions().filter(s => s.source === 'skill_capture').length

const result = await executeLGSpec(graph, {
  initialState: { channel: 'cli', messages: [], task: 'hermes smoke' },
})

if (result.unhealthy_nodes.length) {
  fail(`unhealthy: ${JSON.stringify(result.unhealthy_nodes)}`)
} else ok('executeLGSpec completed')

const mem = result.merged_output?.memory_snapshot
if (!mem || typeof mem !== 'object') fail('PromptInput memory_snapshot missing')
else ok('memory preload MEMORY.md + USER.md slots')

if (result.steps.length < 3) fail(`steps ${result.steps.length} < 3`)
else ok(`steps[]: ${result.steps.length}`)

if (result.materialized_graph.nodes.length < 4) {
  fail(`materialized nodes ${result.materialized_graph.nodes.length} < 4`)
} else ok(`materialized_graph nodes: ${result.materialized_graph.nodes.length}`)

if (llmCalls < 2) fail(`LLM calls ${llmCalls} < 2 (ReAct 环)`)
else ok(`LLM invoked ${llmCalls} times (ReAct)`)

const toolMsgs = (result.merged_output?.messages ?? []).filter(m => m?.role === 'tool')
if (!toolMsgs.length || !toolMsgs.some(m => String(m.content).includes('"dispatched":true'))) {
  fail('ToolCall did not dispatch to real executor')
} else ok(`ToolCall dispatched (${toolMsgs.length} tool messages)`)

const skillSugs = loadSuggestions().filter(s => s.source === 'skill_capture')
if (skillSugs.length <= beforeSkills) fail('SkillCapture did not pushSuggestion')
else {
  const pending = skillSugs.filter(s => s.status === 'pending')
  if (!pending.length) fail('no pending skill_capture suggestion')
  else ok(`SkillCapture → pending suggestion (${pending.length})`)
}

const specRawAfter = readFileSync(WF, 'utf8')
if (specRawBefore !== specRawAfter) fail('Spec mutated during execute')
else ok('Spec 文件 execute 前后不变')

const paths = await persistLGRun(graph.name, result)
if (!paths?.run_path) fail('persistLGRun missing run_path')
else {
  const abs = join(ROOT, 'runs', result.runTrace?.run_id ?? '', 'run.json')
  if (!existsSync(abs)) fail(`run.json missing: ${abs}`)
  else ok(`run.json → ${paths.run_path}`)
}

// replay spec ≥5 steps
const replayGraph = loadWorkflowJson(readFileSync(REPLAY, 'utf8'))
llmCalls = 0
const replay = await executeLGSpec(replayGraph)
if (replay.steps.length < 5) fail(`replay steps ${replay.steps.length} < 5`)
else ok(`hermes-react-replay steps: ${replay.steps.length}`)

// trace 对照表
const capabilityMap = {
  PromptInput: 'LG entry / memory preload',
  LLM: 'ReAct LLM step',
  Switch: 'branch router',
  ToolCall: 'dynamic tool dispatch',
  SkillCapture: 'SkillCapture → pushSuggestion',
  Output: 'LG termination',
}
import { writeFileSync, mkdirSync } from 'node:fs'
mkdirSync(dirname(TRACE_OUT), { recursive: true })
writeFileSync(TRACE_OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  wf_source: 'hermes-1to1.json',
  lg_spec: 'hermes.lg.json',
  lg_nodes: graph.nodes.length,
  capability_map: capabilityMap,
  steps: result.steps.length,
  llm_calls: llmCalls,
  materialized_nodes: result.materialized_graph.nodes,
}, null, 2))
ok(`trace → ${TRACE_OUT}`)

try { process.kill(bridge.pid, 'SIGTERM') } catch { /* bridge already exited */ }
console.log(`\n--- hermes-lg smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
