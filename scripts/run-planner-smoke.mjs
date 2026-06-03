#!/usr/bin/env node
/** 02 批次外：executePlannerViaPolarClaw 全路径（mock PolarClaw HTTP） */
import { extractWorkflowJson } from '../src/engine/polarclaw-client.ts'
import { executePlannerViaPolarClaw, validateWorkflow } from '../src/engine/planner-engine.ts'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const mockReply = `\`\`\`json
{
  "workflow": {
    "1": { "class_type": "PromptInput", "inputs": {} },
    "2": { "class_type": "LLM", "inputs": { "prompt": ["1", 0] } }
  },
  "reasoning": "minimal chain",
  "components_used": ["PromptInput", "LLM"]
}
\`\`\``

const wf = extractWorkflowJson(mockReply)
if (!wf || !wf['1']) fail('extractWorkflowJson failed')
else ok('extractWorkflowJson parses PolarClaw-style reply')

const v0 = validateWorkflow(wf, { connectivity: true, types: false, cycles: false })
if (!v0.valid) fail(`validateWorkflow: ${v0.issues.join('; ')}`)
else ok('extracted workflow validates')

const origFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.includes('/api/status')) {
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  if (u.includes('/api/agent/chat')) {
    return new Response(JSON.stringify({ content: mockReply }), { status: 200 })
  }
  return origFetch(url, init)
}

try {
  const plan = await executePlannerViaPolarClaw('生成最小 PromptInput→LLM 链')
  if (!plan.workflow?.['1']) fail('executePlannerViaPolarClaw missing workflow')
  else ok('executePlannerViaPolarClaw returns workflow JSON')
  if (!plan.reasoning) fail('missing reasoning')
  else ok('executePlannerViaPolarClaw returns reasoning')
  const v1 = validateWorkflow(plan.workflow, { connectivity: true, types: false, cycles: false })
  if (!v1.valid) fail(`planned workflow invalid: ${v1.issues.join('; ')}`)
  else ok('planned workflow validates')
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
} finally {
  globalThis.fetch = origFetch
}

console.log(`\n--- planner-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
