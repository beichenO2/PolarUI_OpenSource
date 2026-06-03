#!/usr/bin/env node
/** 260526 Phase3 — LG 三情景 model 档 smoke（mock LLM 记录 model 参数） */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const cases = [
  { file: 'test-lg-mode-general.lg.json', expectModel: 'GLM-5-TURBO', tag: 'general' },
  { file: 'test-lg-mode-coding.lg.json', expectModel: 'GLM-5.1', tag: 'coding' },
  { file: 'test-lg-mode-report.lg.json', expectModel: 'GLM-5.1', tag: 'report' },
]

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const seen = []

setLLMClient({
  chat: async (model, messages) => {
    seen.push({ model, user: messages.filter(m => m.role === 'user').pop()?.content?.slice(0, 40) })
    return { content: `mock-${model}`, usage: {} }
  },
})

bootstrapHeadlessEngine()

for (const c of cases) {
  const graph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows', c.file), 'utf8'))
  const r = await executeLGSpec(graph)
  if (r.unhealthy_nodes.length) {
    fail(`${c.tag}: unhealthy ${JSON.stringify(r.unhealthy_nodes)}`)
    continue
  }
  const last = seen[seen.length - 1]
  if (!last || last.model !== c.expectModel) {
    fail(`${c.tag}: expected model ${c.expectModel}, got ${last?.model}`)
  } else {
    ok(`${c.tag} → model ${last.model}`)
  }
}

console.log(`\n--- lg-mode-switch: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
