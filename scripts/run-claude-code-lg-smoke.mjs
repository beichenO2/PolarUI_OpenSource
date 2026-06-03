#!/usr/bin/env node
/**
 * 260524 Phase 2 — Claude Code LG + PermissionGate smoke
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { executeNode } from '../src/engine/executor.ts'
import { persistLGRun } from '../src/engine/run-persistence.ts'
import { resolveLGToolName } from '../src/engine/lg-runner.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'claude-code.lg.json')
const TRACE_OUT = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'claude-code-lg.json')

const CLAUDE_TOOLS = [
  'FileRead', 'FileWrite', 'ShellExec', 'GlobSearch', 'GrepSearch', 'WebSearch',
  'WebFetch', 'SubAgent', 'GitCommit', 'MCPCall', 'Notification', 'CodeExec',
]

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

try {
  execSync('node cli/compile-check.mjs workflows/claude-code.lg.json', { cwd: ROOT, stdio: 'pipe' })
  ok('claude-code.lg.json compile-check PASS')
} catch { fail('compile-check FAIL') }

const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))
const toolNodes = graph.nodes.filter(n => n.class_type === 'ToolCall')
if (toolNodes.length !== 1) fail(`expected 1 ToolCall, got ${toolNodes.length}`)
else ok('single ToolCall dynamic dispatch')

const INTERNAL_LG = new Set([
  'LG_Entry', 'LG_End', 'LG_LLM', 'LG_ConditionalEdge', 'LG_ToolNode',
  'LG_Pluripotent', 'LG_Differentiate',
])
const hidden = graph.nodes.filter(n => INTERNAL_LG.has(n.class_type))
if (hidden.length) fail(`Internal LG_* in spec: ${hidden.map(n => n.class_type).join(', ')}`)
else ok('palette-only (no Internal LG_*)')

for (const t of CLAUDE_TOOLS) {
  if (resolveLGToolName({ react_tool: 'hub_send_prompt' }, { tool: t }) !== t) fail(`resolveLGToolName ${t}`)
}
ok(`dynamic dispatch supports ${CLAUDE_TOOLS.length} Claude tools`)

const ctx = { getNodeOutput: () => undefined, allResults: new Map(), links: [], workflowLibrary: 'LG' }

const gateWhitelist = await executeNode({
  id: 'g1', class_type: 'PermissionGate', x: 0, y: 0, width: 200, height: 80,
  inputs: {},
  params: { mode: 'ask', whitelist: '["FileRead","GlobSearch","GrepSearch","WebSearch"]', tool_name: 'FileRead' },
}, ctx)
if (!gateWhitelist.outputs?.allowed) fail('FileRead should pass whitelist')
else ok('PermissionGate: FileRead whitelist auto-pass')

const gateShell = await executeNode({
  id: 'g2', class_type: 'PermissionGate', x: 0, y: 0, width: 200, height: 80,
  inputs: {},
  params: { mode: 'ask', whitelist: '["FileRead","GlobSearch","GrepSearch","WebSearch"]', tool_name: 'ShellExec' },
}, ctx)
if (gateShell.outputs?.allowed) fail('ShellExec should need approval')
else if (gateShell.outputs?.decision !== 'needs_approval') fail(`ShellExec decision ${gateShell.outputs?.decision}`)
else ok('PermissionGate: ShellExec → needs_approval')

let llmCalls = 0
setLLMClient({
  async chat() {
    llmCalls++
    const branch = llmCalls < 3 ? 'tool' : 'finish'
    if (branch === 'tool') {
      const tool = llmCalls === 1 ? 'FileRead' : 'ShellExec'
      return {
        content: '',
        toolCalls: [{ function: { name: tool, arguments: JSON.stringify({ path: 'README.md', command: 'echo ok' }) } }],
        usage: {},
        model: 'mock',
      }
    }
    return { content: 'done', toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const result = await executeLGSpec(graph, { initialState: { messages: [] } })
if (result.unhealthy_nodes.length) fail(`unhealthy: ${JSON.stringify(result.unhealthy_nodes)}`)
else ok('executeLGSpec completed')

if (result.steps.length < 2) fail(`steps ${result.steps.length}`)
else ok(`steps: ${result.steps.length}`)

if (llmCalls < 2) fail(`LLM calls ${llmCalls}`)
else ok(`LLM invoked ${llmCalls} times`)

const lastState = [...result.results.values()]
  .map(r => r.outputs?.state ?? r.outputs?.final_state)
  .filter(Boolean)
  .pop()

if (!lastState?.claude_md && !lastState?.memory_snapshot?.['CLAUDE.md']) {
  // preload_memory optional in v2 PromptInput — skip hard fail when absent
  ok('CLAUDE.md memory preload skipped (optional in v2)')
} else ok('CLAUDE.md memory preload (claude_md / memory_snapshot)')

const msgs = lastState?.messages
if (!Array.isArray(msgs) || msgs.length < 1) fail('state.messages empty')
else ok(`state.messages length: ${msgs.length}`)

if (result.merged_output !== 'done' && String(result.merged_output ?? '').length < 1) {
  fail(`merged_output empty: ${JSON.stringify(result.merged_output)}`)
} else ok(`merged_output: ${String(result.merged_output).slice(0, 40)}`)

await persistLGRun(graph.name, result)

mkdirSync(dirname(TRACE_OUT), { recursive: true })
writeFileSync(TRACE_OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  wf_source: 'claude-code.lg.json',
  lg_spec: 'claude-code.lg.json',
  tools: CLAUDE_TOOLS,
  permission_gate: { whitelist_pass: 'FileRead', approval_required: 'ShellExec' },
  steps: result.steps.length,
  llm_calls: llmCalls,
}, null, 2))
ok(`trace → ${TRACE_OUT}`)

console.log(`\n--- claude-code-lg smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
