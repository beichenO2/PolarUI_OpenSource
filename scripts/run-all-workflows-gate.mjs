#!/usr/bin/env node
/**
 * 260527 Phase 2 — 全量 WF/LG compile + wire + headless execute（mock LLM）
 * trace: 任务书/Done/260527_整理归档/260527/trace/all-workflows-matrix.jsonl
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { loadNodeDefs, validateWorkflowWiring } from '../cli/wire-integrity-check.mjs'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF_DIR = join(ROOT, 'workflows')
const TRACE_DIR = join(ROOT, '..', '任务书', 'Done', '260527_整理归档', '260527', 'trace')
const TRACE_FILE = join(TRACE_DIR, 'all-workflows-matrix.jsonl')
const NODE_DEFS = join(ROOT, '..', 'node-defs')
const EXECUTE = !process.argv.includes('--compile-only')
const TIMEOUT_MS = Number(process.env.WF_GATE_TIMEOUT_MS ?? 90_000)

/** 环境依赖 — 矩阵记录 SKIP，不计 FAIL */
const ENV_SKIP = [
  /process-watchdog/,
  /ocr-g4/,
]

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

function collectWorkflowFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      collectWorkflowFiles(abs, acc)
      continue
    }
    if (!name.endsWith('.json') || name === 'registry.json') continue
    acc.push(abs)
  }
  return acc
}

function compileCheck(filePath) {
  try {
    execSync(`node cli/compile-check.mjs "${filePath}"`, { cwd: ROOT, stdio: 'pipe' })
    return { status: 'PASS', errors: [] }
  } catch (e) {
    const out = e.stdout?.toString() || e.stderr?.toString() || e.message
    return { status: 'FAIL', errors: [out.slice(-400)] }
  }
}

function wireCheck(json) {
  const defs = loadNodeDefs(NODE_DEFS)
  const errors = validateWorkflowWiring(json, defs)
  return errors.length ? { status: 'FAIL', errors } : { status: 'PASS', errors: [] }
}

function shouldEnvSkip(rel) {
  return ENV_SKIP.some(re => re.test(rel))
}

async function executeWorkflow(graph, rel) {
  if (shouldEnvSkip(rel)) {
    return { status: 'SKIP', note: 'env dependency' }
  }
  const ctrl = AbortSignal.timeout(TIMEOUT_MS)
  const run = graph.library === 'LG'
    ? executeLGSpec(graph, { agentId: 'all-wf-gate' })
    : executeGraph(graph, { agentId: 'all-wf-gate' })

  try {
    const result = await Promise.race([
      run,
      new Promise((_, reject) => {
        ctrl.addEventListener('abort', () => reject(new Error(`timeout ${TIMEOUT_MS}ms`)))
      }),
    ])
    if (result.unhealthy_nodes?.length) {
      const err = result.unhealthy_nodes.map(u => u.error).join('; ').slice(0, 200)
      return { status: 'FAIL', note: err }
    }
    return { status: 'PASS', note: graph.library === 'LG' ? `lg ${result.steps?.length ?? 0} steps` : 'wf ok' }
  } catch (e) {
    return { status: 'FAIL', note: e instanceof Error ? e.message : String(e) }
  }
}

mkdirSync(TRACE_DIR, { recursive: true })
writeFileSync(TRACE_FILE, '')

const files = collectWorkflowFiles(WF_DIR).sort()
console.log(`=== all-workflows gate (${files.length} files, execute=${EXECUTE}) ===\n`)

if (EXECUTE) {
  setLLMClient({
    chat: async (req) => {
      const last = [...(req.messages ?? [])].reverse().find(m => m.role === 'user')
      const userText = typeof last?.content === 'string' ? last.content : 'mock'
      return { content: `mock: ${userText.slice(0, 80)}`, usage: {} }
    },
  })
  bootstrapHeadlessEngine()
}

for (const abs of files) {
  const rel = relative(WF_DIR, abs)
  const compile = compileCheck(abs)
  let wire = { status: 'PASS', errors: [] }
  let execute = { status: 'SKIP', note: 'compile-only' }

  if (compile.status === 'PASS') {
    try {
      const json = JSON.parse(readFileSync(abs, 'utf8'))
      wire = wireCheck(json)
      if (EXECUTE && wire.status === 'PASS') {
        const graph = loadWorkflowJson(readFileSync(abs, 'utf8'))
        execute = await executeWorkflow(graph, rel)
      }
    } catch (e) {
      wire = { status: 'FAIL', errors: [e instanceof Error ? e.message : String(e)] }
    }
  } else {
    wire = { status: 'SKIP', errors: [] }
  }

  const line = {
    ts: new Date().toISOString(),
    workflow: rel.replace(/\.json$/, ''),
    library: rel.includes('.lg.json') ? 'LG' : 'WF',
    compile: compile.status,
    wire: wire.status,
    execute: execute.status,
    note: execute.note ?? (wire.errors?.[0] ?? compile.errors?.[0] ?? ''),
  }
  writeFileSync(TRACE_FILE, JSON.stringify(line) + '\n', { flag: 'a' })

  const overall = compile.status === 'FAIL' || wire.status === 'FAIL' || execute.status === 'FAIL'
  if (overall) {
    fail(`${rel} compile=${compile.status} wire=${wire.status} execute=${execute.status}`)
  } else {
    ok(`${rel} compile=${compile.status} wire=${wire.status} execute=${execute.status}`)
  }
}

console.log(`\n--- all-workflows gate: ${failed} failures / ${files.length} files ---`)
console.log(`trace: ${TRACE_FILE}`)
process.exit(failed ? 1 : 0)
