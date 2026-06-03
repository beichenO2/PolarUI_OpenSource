#!/usr/bin/env node
/**
 * 260524_1 live — mvp-seed-wf 真实 LLM 执行（须 POLAR_SEED_LIVE_LLM=1 + vault）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { isPrivPortalHealthy } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260524_1_整理归档', '260524_1', 'trace')

if (process.env.POLAR_SEED_LIVE_LLM !== '1') {
  mkdirSync(TRACE_DIR, { recursive: true })
  writeFileSync(
    join(TRACE_DIR, 'live-skipped.txt'),
    'SKIP: POLAR_SEED_LIVE_LLM not set\n',
    'utf8',
  )
  console.log('SKIP: POLAR_SEED_LIVE_LLM not set — see 任务书/Done/260524_1_整理归档/260524_1/04')
  process.exit(0)
}

const ok = (m) => console.log('OK:', m)
const fail = (m) => {
  console.error('FAIL:', m)
  process.exit(1)
}

if (!(await isPrivPortalHealthy())) {
  fail('vault not unlocked — unlock PolarPrivate first')
}
ok('vault_unlocked')

bootstrapHeadlessEngine()

const graph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows/mvp-seed-wf.json'), 'utf8'))
const validator = graph.nodes.find(n => n.class_type === 'Validator')
if (validator) validator.params.verify_mode = 'regex'
const retryLoop = graph.nodes.find(n => n.class_type === 'RetryLoop')
if (retryLoop) retryLoop.params.max_retries = 3

console.log('→ executeGraph(mvp-seed-wf) live LLM…')
const started = Date.now()
const { results, unhealthy_nodes, runTrace } = await executeGraph(graph, { agentId: 'mvp-seed-live' })
const elapsed_ms = Date.now() - started

if (unhealthy_nodes.length) {
  fail(unhealthy_nodes.map(n => `${n.node_id}: ${n.error}`).join('; '))
}

mkdirSync(TRACE_DIR, { recursive: true })
const trace = {
  workflow: 'mvp-seed-wf',
  elapsed_ms,
  unhealthy_nodes,
  runTrace,
  results: Object.fromEntries(
    Object.entries(results ?? {}).map(([k, v]) => [k, typeof v === 'object' ? v : String(v)]),
  ),
}
writeFileSync(join(TRACE_DIR, 'mvp-seed-live.json'), JSON.stringify(trace, null, 2), 'utf8')
ok(`trace → 任务书/Done/260524_1_整理归档/260524_1/trace/mvp-seed-live.json (${elapsed_ms}ms)`)
console.log('\nmvp-seed-live-smoke: PASS')
