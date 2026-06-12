#!/usr/bin/env node
/**
 * E2E smoke test for claude-code.json (Agentic WF)
 * Actually executes the 7-node workflow with a simple task.
 * Requires: LLM proxy at 127.0.0.1:12790
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
bootstrapHeadlessEngine()

console.log('\n═══ Claude Code E2E Smoke Test ═══\n')

const wfPath = join(ROOT, 'workflows/claude-code.json')
const raw = readFileSync(wfPath, 'utf8')
const g = loadWorkflowJson(raw)

console.log(`Workflow loaded: ${g.nodes.length} nodes`)
const userPrompt = 'Read the file PolarUI/package.json and tell me the project name.'
console.log(`User prompt: "${userPrompt}"`)
console.log('Starting execution...\n')

const startTime = Date.now()
const r = await executeGraph(g, {
  externalInputs: { input: userPrompt, query: userPrompt, brief: userPrompt }
})
const elapsed = Date.now() - startTime

console.log(`\nExecution completed in ${(elapsed / 1000).toFixed(1)}s`)
console.log(`Unhealthy nodes: ${r.unhealthy_nodes.length}`)

if (r.unhealthy_nodes.length) {
  console.error('\n❌ UNHEALTHY NODES:')
  for (const n of r.unhealthy_nodes) {
    console.error(`  - ${n.id} (${n.class_type}): ${n.error}`)
  }
}

const output = String(r.merged_output ?? r.final_output ?? '')
console.log(`\nOutput (first 300 chars):\n${output.slice(0, 300)}`)

// Show AgenticToolCall execution log
const atcResult = r.results.get('6')
if (atcResult) {
  const log = atcResult.outputs.execution_log
  if (Array.isArray(log) && log.length > 0) {
    console.log(`\n=== AgenticToolCall: ${log.length} tool calls ===`)
    for (const entry of log.slice(0, 5)) {
      console.log(`  [iter ${entry.iteration}] ${entry.tool_name}(${JSON.stringify(entry.args).slice(0, 80)}) → ${entry.success ? '✅' : '❌'} (${entry.duration_ms}ms)`)
    }
    if (log.length > 5) console.log(`  ... and ${log.length - 5} more`)
  } else {
    console.log('\n=== AgenticToolCall: no tool calls (LLM responded directly) ===')
  }
}

if (!output || output.length < 5) {
  console.error('\n❌ FAIL: Output is empty or too short')
  process.exit(1)
}

console.log('\n✅ E2E PASS: claude-code.json executed successfully')
process.exit(0)
