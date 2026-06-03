#!/usr/bin/env node
/** 02 批次外：PolarPrivate /v1/models 动态下拉探针 */
import { isPrivPortalHealthy, listModels } from '../src/sdk/llm-proxy.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

const healthy = await isPrivPortalHealthy()
if (!healthy) {
  console.log('WARN: PolarPrivate 未就绪 — 使用 node-defs 硬编码 fallback')
  ok('models-probe (env blocked, fallback list)')
} else {
  try {
    const models = await listModels()
    if (models.length === 0) fail('listModels returned empty')
    else ok(`dynamic models: ${models.length} (${models.slice(0, 5).map(m => m.id).join(', ')}…)`)

    const { getLLMClient } = await import('../src/sdk/llm-proxy.ts')
    const probes = ['100', '001', '000']
    let chatOk = false
    for (const code of probes) {
      try {
        const r = await getLLMClient().chat(code, [{ role: 'user', content: 'reply ok' }], { maxTokens: 8, timeoutMs: 30_000 })
        if (r.content) {
          ok(`chat probe code ${code} → ${r.content.slice(0, 40)}`)
          chatOk = true
          if (code !== '100') {
            console.log(`WARN: quality code 100 (GLM-5.1/ctyun) unavailable — using ${code} fallback`)
          }
          break
        }
      } catch (e) {
        console.log(`WARN: chat probe ${code} failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`)
      }
    }
    if (!chatOk) fail('no cloud model code (100/001/000) returned chat content')
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}

console.log(`\n--- models-probe: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
