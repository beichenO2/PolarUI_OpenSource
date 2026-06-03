#!/usr/bin/env node
/**
 * 260524 Phase 3 — Polar Cloud 三通道 + Dashboard LG smoke
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'
import { registry } from '../src/engine/registry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPECS = [
  'polarclaw-web.lg.json',
  'polarclaw-ide.lg.json',
  'polarclaw-feishu.lg.json',
  'polarclaw-dashboard.lg.json',
]
const TRACE_OUT = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'polarcloud-lg.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

let llmCalls = 0
setLLMClient({
  async chat() {
    llmCalls++
    const branch = llmCalls < 2 ? 'tool' : 'finish'
    return { content: JSON.stringify({ branch }), toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const results = []

for (const file of SPECS) {
  try {
    execSync(`node cli/compile-check.mjs workflows/${file}`, { cwd: ROOT, stdio: 'pipe' })
    ok(`${file} compile-check PASS`)
  } catch { fail(`${file} compile-check FAIL`); continue }

  llmCalls = 0
  const graph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows', file), 'utf8'))
  const run = await executeLGSpec(graph, { initialState: { messages: [] } })
  if (run.unhealthy_nodes.length) fail(`${file} unhealthy: ${JSON.stringify(run.unhealthy_nodes)}`)
  else ok(`${file} executeLGSpec steps=${run.steps.length}`)
  results.push({ file, steps: run.steps.length, nodes: graph.nodes.length })
}

for (const ct of ['WebAgent', 'IDEAgent', 'FeishuRelay']) {
  const def = registry.get(ct)
  if (!def?.internal_workflow) fail(`${ct} missing internal_workflow`)
  else ok(`${ct} → ${def.internal_workflow}`)
}

try {
  execSync('npm run build', { cwd: join(ROOT, '..', 'PolarClaw', 'web'), stdio: 'pipe' })
  ok('PolarClaw/web build PASS')
} catch { fail('PolarClaw/web build FAIL') }

mkdirSync(dirname(TRACE_OUT), { recursive: true })
writeFileSync(TRACE_OUT, JSON.stringify({ generated_at: new Date().toISOString(), channels: results }, null, 2))
ok(`trace → ${TRACE_OUT}`)

console.log(`\n--- polarcloud-lg smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
