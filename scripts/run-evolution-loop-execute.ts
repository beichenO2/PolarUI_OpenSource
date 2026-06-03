#!/usr/bin/env node
/**
 * evolution-loop 单次 headless 全链路 execute（PolarPrivate LLM + 信号层）
 * 用法: npx tsx scripts/run-evolution-loop-execute.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { persistRunTrace } from '../src/engine/run-persistence.ts'
import { isPrivPortalHealthy } from '../src/sdk/llm-proxy.ts'
import { registerExecutor } from '../src/engine/executor.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260523_整理归档', '260523', 'trace')
const WF = join(ROOT, 'workflows', 'evolution-loop.json')
const BRIDGE = join(ROOT, 'scripts', 'run-trace-bridge.mjs')

let failed = 0
function ok(m: string) { console.log('OK:', m) }
function fail(m: string) { console.error('FAIL:', m); failed++ }

async function waitHealth(url: string, maxMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

if (!(await isPrivPortalHealthy())) fail('PolarPrivate :12790 not healthy')
else ok('PolarPrivate vault unlocked')

const bridge = spawn('node', [BRIDGE], { stdio: 'ignore', detached: true })
bridge.unref()
if (!(await waitHealth('http://127.0.0.1:3922/health'))) fail('run-trace-bridge down')
else ok('run-trace-bridge up')

bootstrapHeadlessEngine()

const liveLlm = process.argv.includes('--live-llm')
if (liveLlm) {
  process.env.POLAR_HEADLESS_DRY_RUN = '1'
}
if (!liveLlm) {
  registerExecutor('AgenticUnit', async (node, inputs) => {
    const stub = '{"action":"skip","target":"","payload":{},"confidence":0.9}'
    return {
      outputs: {
        verified_output: stub,
        validation_report: {
          passed: true,
          attempts: 1,
          purpose: inputs.purpose,
          expected_pattern: inputs.expected_pattern,
          actual_output: stub,
          reason: 'headless stub (use --live-llm for PolarPrivate)',
        },
      },
      duration_ms: 0,
    }
  })
  registerExecutor('AgentWorkflow', async () => ({
    outputs: { skipped: true, reason: 'headless stub: skip nested AgentWorkflow' },
    duration_ms: 0,
  }))
  ok('AgenticUnit + AgentWorkflow stub (--live-llm for full path)')
}

const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))

for (const node of graph.nodes) {
  if (node.class_type === 'CheckupEventInbox') {
    node.params.event = {
      event_id: `evo-exec-${Date.now()}`,
      project: 'PolarUI',
      summary: 'headless evolution-loop execute',
      source: 'cli',
    }
  }
  if (node.class_type === 'AgenticUnit' && liveLlm) {
    node.params.verify_mode = 'regex'
    node.params.max_retries = 7
    node.params.max_input_chars = 8000
  }
  if (node.class_type === 'HumanApproval') {
    node.params.auto_approve = true
  }
}

const started = Date.now()
const { unhealthy_nodes, merged_output, runTrace } = await executeGraph(graph, {
  agentId: 'evolution-loop-headless',
  role: 'master',
})

if (unhealthy_nodes.length) {
  for (const u of unhealthy_nodes) fail(`${u.node_id} (${u.class_type}): ${u.error}`)
} else ok('executeGraph no unhealthy nodes')

if (runTrace) {
  const logPath = await persistRunTrace(runTrace)
  if (logPath) ok(`trace persisted → ${logPath}`)
}

const agentic = graph.nodes.find(n => n.class_type === 'AgenticUnit')
const agenticId = agentic?.id
const agenticResult = agenticId ? runTrace?.node_traces.find(t => t.node_id === agenticId) : undefined
if (agenticResult?.error) fail(`AgenticUnit: ${agenticResult.error}`)
else ok('AgenticUnit executed')

const promptEvolve = graph.nodes.find(n => n.class_type === 'PromptEvolve')
const peId = promptEvolve?.id
const peResult = peId ? runTrace?.node_traces.find(t => t.node_id === peId) : undefined
if (!peResult) fail('PromptEvolve not in trace')
else if (peResult.error) fail(`PromptEvolve: ${peResult.error}`)
else ok('PromptEvolve executed (LearningCapture → prior_knowledge)')

mkdirSync(TRACE_DIR, { recursive: true })
const tracePath = join(TRACE_DIR, 'MVP-2-evolution-loop-execute.json')
writeFileSync(tracePath, JSON.stringify({
  trace_id: 'MVP-2-evolution-loop-execute',
  executed_at: new Date().toISOString(),
  duration_ms: Date.now() - started,
  unhealthy_nodes,
  merged_output: merged_output ?? null,
  run_id: runTrace?.run_id,
  status: failed ? 'error' : 'completed',
}, null, 2) + '\n')
ok(`trace → ${tracePath}`)

try {
  if (bridge.pid) process.kill(bridge.pid, 'SIGTERM')
} catch { /* bridge already exited */ }
console.log(`\n--- evolution-loop execute: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
