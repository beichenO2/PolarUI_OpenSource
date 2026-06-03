#!/usr/bin/env node
/**
 * 260524 Phase 4a — Hermes WF 迁徙 smoke
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { materializedToWorkflowJson } from '../src/engine/lg-export-wf.ts'
import { loadSuggestions } from '../src/engine/suggestion-store.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'hermes-1to1.json')
const LG = join(ROOT, 'workflows', 'hermes.lg.json')
const TRACE = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'hermes-wf-align.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k),
  }
}

bootstrapHeadlessEngine()

try {
  execSync(`node cli/compile-check.mjs workflows/hermes-1to1.json`, { cwd: ROOT, stdio: 'pipe' })
  ok('hermes-1to1.json compile-check PASS')
} catch { fail('compile-check FAIL') }

const wfRaw = JSON.parse(readFileSync(WF, 'utf8'))
const nodeCount = Object.keys(wfRaw).filter(k => !k.startsWith('_') && !/^[gn]/.test(k)).length
const hasSkill = Object.values(wfRaw).some(n => n.class_type === 'SkillCapture')
const hasRetry = Object.values(wfRaw).some(n => n.class_type === 'RetryLoop' && Number(n.params?.max_retries ?? 7) === 7)
const hasWhile = Object.values(wfRaw).some(n => n.class_type === 'WhileLoop')
if (!hasSkill) fail('missing SkillCapture')
else ok('SkillCapture present')
if (!hasRetry) fail('missing RetryLoop(7)')
else ok('RetryLoop max_retries=7')
if (!hasWhile) fail('missing WhileLoop')
else ok('WhileLoop ReAct block')

const memStores = Object.values(wfRaw).filter(n => n.class_type === 'MemoryStore')
if (memStores.length < 2) fail(`MemoryStore count ${memStores.length} < 2`)
else ok(`MemoryStore×${memStores.length} (read + append)`)

const channelSwitch = Object.values(wfRaw).find(n => n.class_type === 'Switch' && String(n.params?.cases ?? '').includes('cli'))
if (!channelSwitch) fail('missing multi-platform Switch')
else {
  let cases = []
  try { cases = JSON.parse(String(channelSwitch.params.cases)) } catch { /* */ }
  if (cases.length < 3) fail(`Switch cases ${cases.length} < 3`)
  else ok(`Switch platform cases: ${cases.length}`)
}

const whileNode = Object.values(wfRaw).find(n => n.class_type === 'WhileLoop')
if (whileNode && Number(whileNode.params?.max_iterations ?? 0) < 200) {
  fail(`WhileLoop max_iterations ${whileNode.params?.max_iterations} < 200`)
} else if (whileNode) ok('WhileLoop max_iterations=200')

const inject = Object.values(wfRaw).find(n => n.class_type === 'PromptInject')
const soul = String(inject?.params?.role ?? inject?.inputs?.role ?? '')
if (!soul.includes('Hermes')) fail('PromptInject soul mismatch')
else ok('PromptInject Hermes soul')

setLLMClient({
  async chat() {
    return { content: '{"branch":"finish","response":"hermes wf ok"}', toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))
const before = loadSuggestions().filter(s => s.source === 'skill_capture').length

try {
  const result = await executeGraph(graph, { mockMode: true })
  if (result.status === 'error') fail(`executeGraph error: ${result.error}`)
  else ok(`hermes-1to1 executeGraph status=${result.status}`)
} catch (e) {
  fail(`executeGraph: ${e.message}`)
}

const after = loadSuggestions().filter(s => s.source === 'skill_capture')
if (after.length <= before) fail('SkillCapture did not pushSuggestion in WF path')
else ok('SkillCapture → pending suggestion (WF)')

const lgGraph = loadWorkflowJson(readFileSync(LG, 'utf8'))
let lgCalls = 0
setLLMClient({
  async chat() {
    lgCalls++
    return { content: JSON.stringify({ branch: lgCalls < 2 ? 'tool' : 'finish' }), toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})
const lgResult = await executeLGSpec(lgGraph)
const exported = materializedToWorkflowJson(lgGraph, lgResult.materialized_graph)
const expCount = Object.keys(exported).filter(k => !k.startsWith('_') && /^\d/.test(k)).length
ok(`LGRunExportWF nodes: ${expCount}`)

function coreTypes(json) {
  return new Set(
    Object.entries(json)
      .filter(([k, n]) => /^\d+$/.test(k) && !['Ground', 'NullSource'].includes(n.class_type))
      .map(([, n]) => n.class_type),
  )
}
const wfTypes = coreTypes(wfRaw)
const lgSpecRaw = JSON.parse(readFileSync(LG, 'utf8'))
const specTypes = coreTypes(lgSpecRaw)
const expTypes = coreTypes(exported)
const overlap = [...specTypes].filter(t => expTypes.has(t))
const coverage = specTypes.size ? overlap.length / specTypes.size : 0
const mustHave = ['SkillCapture', 'WhileLoop', 'RetryLoop', 'Validator', 'LLM']
for (const t of mustHave) {
  if (!wfTypes.has(t)) fail(`hermes WF missing core ${t}`)
}
ok(`hermes WF core: ${mustHave.join(', ')}`)
if (expCount < 5) fail(`export nodes ${expCount} < 5`)
if (coverage < 0.4) fail(`LG export coverage ${coverage.toFixed(2)} < 0.4 vs hermes.lg.json`)
else ok(`topo-diff: export covers ${(coverage * 100).toFixed(0)}% LG spec types (${overlap.length}/${specTypes.size})`)

mkdirSync(dirname(TRACE), { recursive: true })
writeFileSync(TRACE, JSON.stringify({
  generated_at: new Date().toISOString(),
  wf_nodes: nodeCount,
  lg_steps: lgResult.steps.length,
  exported_wf_nodes: expCount,
  skill_suggestions: after.length - before,
  topo_diff: { coverage, overlap: overlap.length, spec_types: specTypes.size, export_types: expTypes.size },
}, null, 2))
ok(`trace → ${TRACE}`)

console.log(`\n--- hermes-wf smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
