#!/usr/bin/env node
/** 260525 Phase 3 — deployments manifest CRUD smoke（native http） */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const dataDir = mkdtempSync(join(tmpdir(), 'deploy-smoke-'))
const deploymentsPath = join(dataDir, 'chat-deployments.json')
function load() {
  if (!existsSync(deploymentsPath)) return []
  return JSON.parse(readFileSync(deploymentsPath, 'utf8'))
}
function save(list) { writeFileSync(deploymentsPath, JSON.stringify(list, null, 2)) }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/api/deployments' && req.method === 'GET') {
    res.end(JSON.stringify(load()))
    return
  }
  if (url.pathname === '/api/deployments' && req.method === 'PUT') {
    const body = await readJson(req)
    const list = load()
    const id = body.id ?? body.workflow_id
    const entry = { ...body, id, deployed_at: new Date().toISOString() }
    const idx = list.findIndex(d => d.id === id)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    save(list)
    res.end(JSON.stringify({ ok: true, deployment: entry }))
    return
  }
  if (url.pathname === '/chat' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html')
    res.end('<html><body>chat</body></html>')
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

let r = await fetch(`${base}/api/deployments`)
if (!r.ok) fail('GET deployments')
else ok('GET deployments empty')

r = await fetch(`${base}/api/deployments`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workflow_id: 'hermes-1to1', display_name: 'Hermes Agent', library: 'WF' }),
})
if (!r.ok) fail('PUT deployment')
else ok('PUT deployment')

r = await fetch(`${base}/api/deployments`)
const list = await r.json()
if (!Array.isArray(list) || list.length !== 1) fail('list length')
else ok(`deployments count=${list.length}`)

r = await fetch(`${base}/chat`)
if (!r.ok || !(await r.text()).includes('chat')) fail('GET /chat')
else ok('GET /chat placeholder')

server.close()
rmSync(dataDir, { recursive: true, force: true })
console.log(`\n--- deploy-manifest-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
