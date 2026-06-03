#!/usr/bin/env node
/**
 * Seed 原模型 smoke — 对齐 10 用户说：
 * MVP=可分化原模型 · PetriDish 不静默注册 · Validator(purpose SSOT) · LLM←RetryLoop 回边
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { extractWorkflowJson } from '../src/engine/resolve-system-prompt.ts'
import { executeNode, registerExecutor } from '../src/engine/executor.ts'
import { loadWorkflowJson, computeBackLinks } from '../src/engine/loader.ts'
import { loadSuggestions } from '../src/engine/suggestion-store.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ok = (m) => console.log(`  ✓ ${m}`)
const fail = (m) => { console.error(`  ✗ ${m}`); process.exit(1) }

/** headless：mock localStorage 以验证 pushSuggestion（11 用户说：须人审，禁止静默写 registry） */
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  }
}

bootstrapHeadlessEngine()

// 1. prompt 文件存在且 LLM 可读
for (const f of ['prompts/seed-wf-compile.txt', 'prompts/seed-lg-compile.txt', 'prompts/mode-wf-system.txt']) {
  const p = join(ROOT, f)
  if (!readFileSync(p, 'utf8').trim()) fail(`empty ${f}`)
  ok(`${f} loaded`)
}

// 2. mvp-seed-wf 拓扑：Validator purpose SSOT · RetryLoop(7) · LLM←RetryLoop 回边
const seedGraph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows/mvp-seed-wf.json'), 'utf8'))
if (computeBackLinks(seedGraph).size === 0) fail('mvp-seed-wf: missing feedback back-edge')
ok('mvp-seed-wf back-edge (RetryLoop → Merge → LLM)')

const validator = seedGraph.nodes.find(n => n.class_type === 'Validator')
const retryLoop = seedGraph.nodes.find(n => n.class_type === 'RetryLoop')
const merge = seedGraph.nodes.find(n => n.class_type === 'Merge')
if (!validator || !retryLoop || !merge) fail('mvp-seed-wf missing Validator / RetryLoop / Merge')

if (Number(retryLoop.params.max_retries ?? 7) !== 7) {
  fail(`RetryLoop max_retries must be 7 (13 用户定稿), got ${retryLoop.params.max_retries}`)
}
ok('RetryLoop max_retries=7')

const purposeFromPrompt = seedGraph.getNodeInputLinks(validator.id).some(l => {
  const src = seedGraph.nodes.find(n => n.id === l.from_node)
  return src?.class_type === 'PromptInput' && l.from_slot === 2
})
if (!purposeFromPrompt) fail('Validator purpose not wired from PromptInput slot 2')
ok('Validator purpose ← PromptInput (用户需求 SSOT)')

const mergeFromRetry = seedGraph.getNodeInputLinks(merge.id).some(l => {
  const src = seedGraph.nodes.find(n => n.id === l.from_node)
  return src?.class_type === 'RetryLoop'
})
if (!mergeFromRetry) fail('Merge missing RetryLoop input (LLM←RetryLoop 回边)')
ok('Merge ← RetryLoop retry_input (反馈重跑回边)')

if (String(validator.params.verify_mode ?? '') !== 'auto') {
  fail('Validator verify_mode should be auto for purpose alignment')
}
ok('Validator verify_mode=auto')

// 3. JSON 提取 + PetriDish 分化 → inbox（不静默 registry）
const sample = '```json\n{"1":{"class_type":"PromptInput"},"2":{"class_type":"Output"}}\n```'
const parsed = extractWorkflowJson(sample)
if (!parsed?.['1']) fail('extractWorkflowJson failed')
ok('PetriDish JSON extract')

const beforeCount = loadSuggestions().filter(s => s.source === 'petri_dish').length
const petriResult = await executeNode(
  {
    id: 'pd',
    class_type: 'PetriDish',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    inputs: {},
    params: { allow_graph_edit: true, seed: sample, evolution_signal: true },
  },
  {
    links: [],
    getNodeOutput: () => undefined,
    workflowLibrary: 'WF',
    role: 'master',
  },
)
if (!petriResult.outputs?.applied) fail('PetriDish applied=false')
ok('PetriDish applied slave JSON')

const petriSugs = loadSuggestions().filter(s => s.source === 'petri_dish')
if (petriSugs.length <= beforeCount) fail('PetriDish did not pushSuggestion to inbox')
const latest = petriSugs[0]
if (latest.status !== 'pending') fail('PetriDish suggestion should stay pending until auto-approve')
const gateChecked = latest.apply_targets.filter(t => t.checked).length
if (gateChecked < 1) fail('PetriDish auto-gate should check apply_targets when slave passes compile')
else ok(`PetriDish auto-gate: ${gateChecked} target(s) pre-checked`)
ok('PetriDish → pushSuggestion + evolution-gate（非人审闸门）')

// 5. 02 用户定稿：失败须回流上游 LLM（非仅 Validator 内重跑）— headless 全图试跑
let llmCalls = 0
const execGraph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows/mvp-seed-wf.json'), 'utf8'))
const execValidator = execGraph.nodes.find(n => n.class_type === 'Validator')
if (execValidator) execValidator.params.verify_mode = 'regex'
registerExecutor('LLM', async () => {
  llmCalls++
  const good = '{"1":{"class_type":"PromptInput"},"2":{"class_type":"Output"}}'
  return {
    outputs: { output: llmCalls === 1 ? 'invalid-first-pass' : good },
    duration_ms: 0,
  }
})
const { unhealthy_nodes, runTrace } = await executeGraph(execGraph, { agentId: 'seed-smoke' })
if (unhealthy_nodes.length) fail(`seed execute unhealthy: ${unhealthy_nodes[0]?.error}`)
if (llmCalls < 2) fail(`LLM must re-invoke via back-edge (got ${llmCalls} calls)`)
else ok(`LLM re-invoked ${llmCalls}x after Validator fail (02 用户定稿 回流上游)`)
const loops = runTrace?.loop_traces ?? []
const interRound = loops.find(l => l.stop_reason === 'retry')
if (interRound?.input_snapshot?.original_input == null) fail('RetryLoop missing original_input snapshot')
else ok('RetryLoop 轮间 retry_input 锚定用户需求 SSOT')

// 6. registry seed 条目
const reg = JSON.parse(readFileSync(join(ROOT, 'workflows/registry.json'), 'utf8'))
for (const id of ['mvp-seed-wf', 'mvp-seed-lg']) {
  if (!reg.some(e => e.id === id)) fail(`registry missing ${id}`)
  ok(`registry ${id}`)
}

console.log('\nseed-smoke: PASS')
