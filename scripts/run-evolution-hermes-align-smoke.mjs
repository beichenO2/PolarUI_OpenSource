#!/usr/bin/env node
/** 260524 Phase 5 — evolution-loop 与 Hermes 自进化对齐 smoke */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadSuggestions } from '../src/engine/suggestion-store.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVO = join(ROOT, 'workflows', 'evolution-loop.json')
const TRACE = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'evolution-hermes-align.json')

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
  execSync(`node cli/compile-check.mjs workflows/evolution-loop.json`, { cwd: ROOT, stdio: 'pipe' })
  ok('evolution-loop compile-check PASS')
} catch { fail('compile-check FAIL') }

const wf = JSON.parse(readFileSync(EVO, 'utf8'))
const mapping = {
  SkillCapture: 'LearningCapture + PetriDish → SuggestionInbox',
  MemoryStore: 'PromptEvolve memory_key',
  RetryLoop_7: 'AgenticUnit max_retries=7',
}

for (const k of ['LearningCapture', 'PromptEvolve']) {
  if (!Object.values(wf).some(n => n.class_type === k)) fail(`evolution-loop missing ${k}`)
  else ok(`${k} present`)
}

const pe = Object.values(wf).find(n => n.class_type === 'PromptEvolve')
if (pe && String(pe.params?.memory_key ?? '') !== 'evolution-loop') {
  fail('PromptEvolve memory_key namespace not isolated')
} else ok('PromptEvolve memory_key=evolution-loop (namespace 分离)')

const retry = Object.values(wf).find(n => n.class_type === 'AgenticUnit')
if (retry && Number(retry.params?.max_retries) !== 7) fail('AgenticUnit max_retries != 7')
else ok('AgenticUnit max_retries=7 对齐 13')

const sources = new Set(loadSuggestions().map(s => s.source))
if (!sources.size) fail('inbox empty')
else ok(`SuggestionInbox seeded sources: ${[...sources].join(', ')}`)

const { pushSuggestion } = await import('../src/engine/suggestion-store.ts')
pushSuggestion({
  source: 'skill_capture',
  kind: 'MODIFY_NODE_DEF',
  title: 'align-smoke probe',
  rationale: '07 验收：skill_capture 与 petri_dish 同 inbox',
  diff: {},
  apply_targets: [{ id: 'x', label: 'probe', checked: false }],
})
const after = loadSuggestions().filter(s => s.source === 'skill_capture')
if (!after.length) fail('skill_capture not in inbox')
else ok('SuggestionInbox 可接收 source: skill_capture')

mkdirSync(dirname(TRACE), { recursive: true })
writeFileSync(TRACE, JSON.stringify({
  generated_at: new Date().toISOString(),
  mapping,
  inbox_sources: [...sources, 'skill_capture'],
}, null, 2))
ok(`trace → ${TRACE}`)

console.log(`\n--- evolution-hermes-align smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
