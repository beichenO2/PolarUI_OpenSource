#!/usr/bin/env node
/** 260524_1 gate §2.1 #1 — PolarPrivate vault 探针 */
import { isPrivPortalHealthy, listModels } from '../src/sdk/llm-proxy.ts'

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => {
  console.error('FAIL:', m)
  failed++
}

const healthy = await isPrivPortalHealthy()
if (!healthy) {
  fail('PolarPrivate 未就绪或 vault 未解锁 — 见 任务书/Done/260524_1_整理归档/260524_1/01')
} else {
  ok('vault_unlocked')
  try {
    const models = await listModels()
    if (models.length === 0) fail('listModels returned empty')
    else ok(`models: ${models.length}`)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

console.log(`\n--- vault-probe: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
