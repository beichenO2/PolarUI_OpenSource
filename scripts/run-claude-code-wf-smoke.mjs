#!/usr/bin/env node
/** Claude Code LG smoke — claude-code.lg.json only (WF 1to1 removed) */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { executeNode } from '../src/engine/executor.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LG = join(ROOT, 'workflows', 'claude-code.lg.json')
const TRACE = join(ROOT, '..', '任务书', 'Done', '260524_整理归档', '260524', 'trace', 'claude-code-wf.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

try {
  execSync('node cli/compile-check.mjs workflows/claude-code.lg.json', { cwd: ROOT, stdio: 'pipe' })
  ok('claude-code.lg.json compile-check PASS')
} catch { fail('compile-check FAIL') }

const lg = loadWorkflowJson(readFileSync(LG, 'utf8'))
if (!lg.nodes.some(n => n.class_type === 'PermissionGate')) fail('missing PermissionGate')
else ok('PermissionGate present')

const retry = lg.nodes.find(n => n.class_type === 'RetryLoop')
if (!retry || Number(retry.params?.max_retries ?? 7) !== 7) fail('RetryLoop(7) missing')
else ok('RetryLoop max_retries=7')

const ctx = { getNodeOutput: () => undefined, allResults: new Map(), links: [], workflowLibrary: 'LG' }
const gateShell = await executeNode({
  id: 'g', class_type: 'PermissionGate', x: 0, y: 0, width: 200, height: 80,
  inputs: {}, params: { mode: 'ask', whitelist: '["FileRead"]', tool_name: 'ShellExec' },
}, ctx)
if (gateShell.outputs?.allowed) fail('ShellExec should need approval')
else ok('PermissionGate ShellExec blocked')

let lgCalls = 0
setLLMClient({
  async chat() {
    lgCalls++
    if (lgCalls < 2) {
      return {
        content: '',
        toolCalls: [{ function: { name: 'FileRead', arguments: JSON.stringify({ path: 'PolarUI/package.json' }) } }],
        usage: {},
        model: 'mock',
      }
    }
    return { content: 'polar-ui', toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})
const lgResult = await executeLGSpec(lg)
if (lgCalls < 2) fail(`LG LLM calls ${lgCalls} < 2`)
else ok(`LG ReAct LLM calls: ${lgCalls}`)

mkdirSync(dirname(TRACE), { recursive: true })
writeFileSync(TRACE, JSON.stringify({
  generated_at: new Date().toISOString(),
  lg: 'claude-code.lg.json',
  lg_steps: lgResult.steps.length,
}, null, 2))
ok(`trace → ${TRACE}`)

console.log(`\n--- claude-code-wf smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
