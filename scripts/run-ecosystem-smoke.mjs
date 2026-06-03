#!/usr/bin/env node
/**
 * 03 用户诉求 smoke — 生态服务常在线 + executor 可调用（非仅端口 probe）
 * 前置：ensure-ecosystem-services.mjs
 */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

/** 03 用户原话点名的后端 + evolution-loop / inbox 硬依赖 */
const PROBES = [
  { name: 'DIGiST', url: 'http://127.0.0.1:3800/api/health' },
  {
    name: 'PolarMemory',
    url: 'http://127.0.0.1:3100/api/blocks/search',
    method: 'POST',
    body: JSON.stringify({ query: 'smoke', top_k: 1 }),
  },
  { name: 'design-bridge', url: 'http://127.0.0.1:3920/health' },
  { name: 'suggestion-bridge', url: 'http://127.0.0.1:3921/health' },
  { name: 'run-trace-bridge', url: 'http://127.0.0.1:3922/health' },
]

for (const p of PROBES) {
  try {
    const res = await fetch(p.url, {
      method: p.method ?? 'GET',
      headers: p.body ? { 'Content-Type': 'application/json' } : undefined,
      body: p.body,
      signal: AbortSignal.timeout(8000),
    })
    if (res.status >= 500) fail(`${p.name} probe HTTP ${res.status}`)
    else ok(`${p.name} reachable (${res.status})`)
  } catch (e) {
    fail(`${p.name} unreachable: ${e instanceof Error ? e.message : e}`)
  }
}

bootstrapHeadlessEngine()

const ctx = {
  getNodeOutput: () => undefined,
  allResults: new Map(),
  links: [],
  workflowLibrary: 'WF',
  role: 'master',
}

const nodeShell = (class_type, params = {}) => ({
  id: class_type.toLowerCase(),
  class_type,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  inputs: {},
  params,
})

// executor 试跑 — 「不能节点有了但服务全挂」
const mem = await executeNode(
  nodeShell('MemorySearch', { top_k: 1, user: 'smoke', query: 'smoke' }),
  ctx,
)
if (mem.error) fail(`MemorySearch executor: ${mem.error}`)
else ok('MemorySearch executor → PolarMemory API')

const digResult = await executeNode(
  { ...nodeShell('DigestFuse'), params: { api_base: 'http://127.0.0.1:3800', topic: 'PolarUI' } },
  ctx,
)
if (digResult.error && /ECONNREFUSED|fetch failed|Failed to fetch/i.test(String(digResult.error))) {
  fail(`DigestFuse executor: ${digResult.error}`)
} else ok('DigestFuse executor → DIGiST API')

const design = await executeNode(nodeShell('DesignResolve'), ctx)
if (design.error && /ECONNREFUSED|fetch failed/i.test(design.error)) {
  fail(`DesignResolve executor: ${design.error}`)
} else ok('DesignResolve executor → design-bridge')

console.log(`\n--- ecosystem-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
