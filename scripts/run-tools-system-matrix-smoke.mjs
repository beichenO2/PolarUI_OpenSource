#!/usr/bin/env node
/**
 * 260526 Phase 1 L0 — tools-system.json 18 项逐个 executor smoke
 * 依赖：Hub :8040 工具代理；部分项需 digist:3800 / polarmemory:3100 / vault(LLM)
 */
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260526_整理归档', '260526', 'trace')
const TRACE_FILE = join(TRACE_DIR, 'tools-system-matrix.jsonl')

process.env.POLAR_HUB_URL = process.env.POLAR_HUB_URL ?? 'http://127.0.0.1:8040'
process.env.POLAR_HEADLESS_DRY_RUN = '1'

let failed = 0
const results = []

function node(class_type, params = {}) {
  return { id: `t_${class_type}`, class_type, params, inputs: {} }
}

function ctx(inputs = {}) {
  return {
    nodeOutputs: new Map(),
    externalInputs: inputs,
    role: 'master',
    links: [],
    allResults: new Map(),
    getNodeOutput: () => undefined,
  }
}

async function runCase(class_type, paramInputs = {}, passIf) {
  const started = Date.now()
  const n = node(class_type, paramInputs)
  const r = await executeNode(n, ctx())
  const ms = Date.now() - started
  let status = 'PASS'
  let note = ''
  if (r.error) {
    if (passIf?.(r)) {
      status = 'PASS'
      note = `expected: ${r.error.slice(0, 120)}`
    } else if (/未响应|fetch failed|ECONNREFUSED|503|502/.test(r.error)) {
      status = 'SKIP'
      note = r.error.slice(0, 200)
    } else {
      status = 'FAIL'
      note = r.error.slice(0, 300)
      failed++
    }
  } else if (passIf && !passIf(r)) {
    status = 'FAIL'
    note = 'passIf rejected success output'
    failed++
  }
  const row = { class_type, status, ms, note, outputs: Object.keys(r.outputs ?? {}) }
  results.push(row)
  appendFileSync(TRACE_FILE, JSON.stringify(row) + '\n')
  console.log(`${status}: ${class_type}${note ? ` — ${note}` : ''}`)
  return r
}

async function hubUp() {
  try {
    const r = await fetch(`${process.env.POLAR_HUB_URL}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (r.ok) return true
    const t = await fetch(`${process.env.POLAR_HUB_URL}/api/ui/tools/file-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'PolarUI/package.json' }),
      signal: AbortSignal.timeout(3000),
    })
    return t.ok
  } catch {
    return false
  }
}

mkdirSync(TRACE_DIR, { recursive: true })
writeFileSync(TRACE_FILE, '')

if (!(await hubUp())) {
  console.error('FAIL: Hub not running at', process.env.POLAR_HUB_URL)
  process.exit(1)
}

setLLMClient({
  chat: async () => ({ content: 'dependency', usage: {} }),
})

bootstrapHeadlessEngine()

const tmpWrite = join(ROOT, '.tmp-tool-smoke.txt')

await runCase('FileRead', { path: 'PolarUI/package.json' })
await runCase('FileWrite', { path: tmpWrite, content: 'tool-smoke-ok' })
await runCase('FileRead', { path: tmpWrite })
await runCase('ShellExec', { command: 'echo tool-smoke-ok' })
await runCase('GlobSearch', { pattern: 'package.json', cwd: 'PolarUI' })
await runCase('GrepSearch', { pattern: 'polar-ui', path: 'PolarUI/package.json' })
await runCase('GitCommit', { message: 'tool-smoke dry-run' })
await runCase('Notification', { message: 'tools-system smoke' })
await runCase('SessionSearch', { query: 'tool', limit: 3 })
await runCase('SSoTQuery', { project: 'PolarUI' })
await runCase('ContextWindow', { messages: [{ role: 'user', content: 'hi' }], new_message: 'more' })
await runCase('SubAgent', { task: 'smoke delegate' })
await runCase('ErrorClassifier', { error_log: 'Error: connection refused to port 3100' })
await runCase('WebSearch', { query: 'polar' })
await runCase('MemoryStore', { key: 'tool-smoke-1', content: 'smoke block', operation: 'write' })
await runCase('CodeExec', { code: 'print(42)', language: 'python' })
await runCase('BrowserAction', { url: 'http://127.0.0.1:3910/api/status', action: 'navigate' })
await runCase('MCPCall', { server: 'test', tool_name: 'ping', arguments: {} }, (r) =>
  Boolean(r.outputs?.result))
await runCase('ImageGenerate', {}, (r) =>
  /API Key|ImageGenerate/.test(r.error ?? '') || r.outputs?.stub === true)

const summary = {
  total: results.length,
  pass: results.filter(r => r.status === 'PASS').length,
  skip: results.filter(r => r.status === 'SKIP').length,
  fail: results.filter(r => r.status === 'FAIL').length,
}
writeFileSync(join(TRACE_DIR, 'tools-system-summary.json'), JSON.stringify(summary, null, 2))
console.log('\n--- tools-system-matrix:', summary, '---')
process.exit(failed ? 1 : 0)
