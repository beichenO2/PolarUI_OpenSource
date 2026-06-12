#!/usr/bin/env node
/**
 * Switch branch skip smoke test — verifies that unmatched Switch branches
 * are not executed (their downstream nodes should be skipped).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = m => console.log('  OK:', m)
const fail = m => { console.error('  FAIL:', m); failed++ }

bootstrapHeadlessEngine()

let llmCalls = 0
setLLMClient({
  async chat(req) {
    llmCalls++
    const sys = req.messages?.find(m => m.role === 'system')?.content ?? ''
    if (sys.includes('verify') || sys.includes('Validator')) {
      return { message: { content: JSON.stringify({ pass: true, reason: 'mock-ok' }) }, usage: { prompt_tokens: 0, completion_tokens: 0 } }
    }
    return {
      message: {
        content: 'mock-finish',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'finish', arguments: '{"result":"done"}' } }],
      },
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }
  },
  async models() { return ['mock-model'] },
})

console.log('\n=== Test 1: claude-code.json Switch skip ===')
const wfPath = join(ROOT, 'workflows', 'claude-code.json')
const raw = readFileSync(wfPath, 'utf8')
const graph = loadWorkflowJson(raw)

const switchNode = graph.nodes.find(n => n.class_type === 'Switch')
if (!switchNode) { fail('No Switch node found'); process.exit(1) }
console.log(`  Switch node: ${switchNode.id}`)

const caseLinks = graph.links.filter(l => l.from_node === switchNode.id)
console.log(`  Switch outgoing links: ${caseLinks.map(l => `slot${l.from_slot}→${l.to_node}`).join(', ')}`)

const result = await executeGraph(graph, { skipClassTypes: new Set(['NoteCard']) })

const skippedIds = []
const executedIds = []
for (const [nodeId, r] of result.results) {
  if (r.outputs?.skipped === true) skippedIds.push(nodeId)
  else executedIds.push(nodeId)
}

console.log(`  Executed: ${executedIds.length} nodes`)
console.log(`  Skipped:  ${skippedIds.length} nodes`)

if (skippedIds.length > 0) {
  ok(`Switch skip worked — ${skippedIds.length} node(s) skipped: [${skippedIds.join(', ')}]`)
} else {
  fail('No nodes skipped — Switch branch skip not working')
}

const matchedSlot = result.results.get(switchNode.id)?.outputs?.matched_slot
console.log(`  Switch matched slot: ${matchedSlot}`)

const mergeTypes = new Set(['Output', 'Merge', 'CheckupReport'])
const unmatchedLinks = caseLinks.filter(l => l.from_slot !== matchedSlot)
for (const link of unmatchedLinks) {
  const targetNode = graph.nodes.find(n => n.id === link.to_node)
  const isMerge = targetNode && mergeTypes.has(targetNode.class_type)
  const targetResult = result.results.get(link.to_node)
  if (targetResult?.outputs?.skipped === true) {
    ok(`Unmatched branch target ${link.to_node} (slot ${link.from_slot}) was skipped`)
  } else if (isMerge) {
    ok(`Unmatched branch target ${link.to_node} (slot ${link.from_slot}, ${targetNode.class_type}) is merge node — not skipped (expected)`)
  } else {
    fail(`Unmatched branch target ${link.to_node} (slot ${link.from_slot}) was NOT skipped`)
  }
}

console.log(`\n  LLM calls: ${llmCalls}`)
console.log(`  Unhealthy: ${result.unhealthy_nodes.length}`)
for (const u of result.unhealthy_nodes) {
  console.log(`    ${u.node_id} (${u.class_type}): ${u.error}`)
}

console.log('\n' + (failed === 0 ? '✅ All Switch skip tests passed' : `❌ ${failed} failure(s)`))
process.exit(failed > 0 ? 1 : 0)
