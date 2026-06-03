#!/usr/bin/env node
/**
 * 260525 Phase 1 — WorkingMemory executor smoke（内联 mock session-memory HTTP，无 express 依赖）
 */
import { createServer } from 'node:http'
import { SessionMemoryManager } from '../../PolarClaw/src/memory/SessionMemory.ts'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeNode } from '../src/engine/executor.ts'
import { registry } from '../src/engine/registry.ts'

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const sm = new SessionMemoryManager()

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
ok(`mock session-memory on :${port}`)

bootstrapHeadlessEngine()
if (!registry.get('WorkingMemory')) fail('WorkingMemory not in registry')
else ok('WorkingMemory registered')

const convId = 'wm-smoke-1'

const r1 = await executeNode(
  {
    id: 'wm1',
    class_type: 'WorkingMemory',
    x: 0, y: 0, width: 200, height: 80,
    inputs: {},
    params: {
      api_base: apiBase,
      conversation_id: convId,
      new_message: '第一轮：我叫小明',
      auto_compress: false,
      fetch_long_term: false,
    },
  },
  { links: [], getNodeOutput: () => undefined, workflowLibrary: 'WF', role: 'master' },
)
if (r1.error) fail(r1.error)
else if (r1.outputs?.stats?.working_count !== 1) fail(`turn1 working_count=${r1.outputs?.stats?.working_count}`)
else ok('turn1 append message')

const r2 = await executeNode(
  {
    id: 'wm2',
    class_type: 'WorkingMemory',
    x: 0, y: 0, width: 200, height: 80,
    inputs: {},
    params: {
      api_base: apiBase,
      conversation_id: convId,
      new_message: '第二轮：继续',
      auto_compress: true,
      fetch_long_term: false,
    },
  },
  { links: [], getNodeOutput: () => undefined, workflowLibrary: 'WF', role: 'master' },
)
if (r2.error) fail(r2.error)
else if ((r2.outputs?.stats?.working_count ?? 0) < 1) fail('turn2 stats missing')
else ok(`turn2 working_count=${r2.outputs?.stats?.working_count} compressed=${r2.outputs?.compressed}`)

server.close()
console.log(`\n--- working-memory-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
