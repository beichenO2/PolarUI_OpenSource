#!/usr/bin/env node
/**
 * 260525 Phase 2 — 多轮 conversation_id 贯穿 workflow execute（mock LLM + mock session-memory）
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionMemoryManager } from '../../PolarClaw/src/memory/SessionMemory.ts'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'
import { registerExecutor } from '../src/engine/executor.ts'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

const sm = new SessionMemoryManager()
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (parts[0] === 'api' && parts[1] === 'session-memory' && parts[2]) {
      const convId = decodeURIComponent(parts[2])
      if (req.method === 'GET' && parts.length === 3) {
        const session = sm.getOrCreateSession(convId)
        res.end(JSON.stringify({
          conversation_id: convId,
          context: sm.buildMemoryInjection(convId),
          working_count: session.working.length,
          episodic_count: session.episodic.length,
          long_term_count: session.longTermBlocks.length,
          core_facts: session.coreFacts || '',
        }))
        return
      }
      if (req.method === 'POST' && parts[3] === 'messages') {
        const body = await readJson(req)
        const session = sm.getOrCreateSession(convId)
        const incoming = body.message
          ? [{ role: body.role ?? 'user', content: String(body.message) }]
          : []
        sm.updateWorkingMemory(convId, [...session.working, ...incoming])
        res.end(JSON.stringify({ conversation_id: convId, working_count: sm.getOrCreateSession(convId).working.length }))
        return
      }
      if (req.method === 'POST' && parts[3] === 'compress') {
        await sm.compressForNextTurn(convId)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST' && parts[3] === 'fetch') {
        res.end(JSON.stringify({ blocks_count: 0 }))
        return
      }
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(e) }))
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const apiBase = `http://127.0.0.1:${port}`
ok(`mock session-memory :${port}`)

bootstrapHeadlessEngine()

setLLMClient({
  async chat(_model, messages) {
    const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n')
    const all = messages.map(m => m.content).join('\n')
    if (/我叫什么|我的名字/.test(user) && /小明/.test(all)) {
      return { content: '你叫小明。', toolCalls: [], usage: {}, model: 'mock' }
    }
    if (/我叫小明|我是小明/.test(user)) {
      return { content: '好的，我记住了，你叫小明。', toolCalls: [], usage: {}, model: 'mock' }
    }
    return { content: '收到。', toolCalls: [], usage: {}, model: 'mock' }
  },
  async listModels() { return [] },
  async healthCheck() { return { ok: true, vault_unlocked: true } },
})

const graph = loadWorkflowJson(readFileSync(join(ROOT, 'workflows/test-multi-turn-chat.json'), 'utf8'))
for (const node of graph.nodes) {
  if (node.class_type === 'WorkingMemory') node.params.api_base = apiBase
}

const convId = 'multi-turn-smoke-1'

const r1 = await executeGraph(graph, {
  runContext: { conversation_id: convId, user_id: 'smoke', user_message: '我叫小明' },
  externalInputs: { conversation_id: convId, message: '我叫小明' },
})
if (r1.unhealthy_nodes.length) fail(`turn1: ${r1.unhealthy_nodes[0]?.error}`)
else ok('turn1 execute')

const r2 = await executeGraph(graph, {
  runContext: { conversation_id: convId, user_id: 'smoke', user_message: '我叫什么名字？' },
  externalInputs: { conversation_id: convId, message: '我叫什么名字？' },
})
if (r2.unhealthy_nodes.length) fail(`turn2: ${r2.unhealthy_nodes[0]?.error}`)
else ok('turn2 execute')

const out = String(r2.merged_output ?? '')
if (!out.includes('小明')) fail(`turn2 output missing 小明: ${out}`)
else ok(`turn2 remembers name: ${out.trim()}`)

server.close()
console.log(`\n--- multi-turn-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
