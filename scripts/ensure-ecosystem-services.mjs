#!/usr/bin/env node
/**
 * ensure-ecosystem-services — 探测/拉起 + 写 ecosystem-status.json（03 降级可见性）
 */
import { execSync, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const STATUS_PATH = path.join(root, 'PolarUI/data/ecosystem-status.json')
const PUBLIC_STATUS_PATH = path.join(root, 'PolarUI/public/data/ecosystem-status.json')

const SERVICES = [
  {
    name: 'Hub',
    port: 8040,
    path: '/api/polaris/PolarUI',
    expectStatus: 200,
    startDetached: () => {
      const hubDir = path.join(root, 'PolarCopilot/hub')
      const child = spawn('npx', ['tsx', 'src/server.ts'], {
        cwd: hubDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, HUB_PORT: '8040' },
      })
      child.unref()
    },
  },
  { name: 'AutoOffice', port: 3900, path: '/health', start: 'bash AutoOffice/Start/start.sh' },
  { name: 'design-bridge', port: 3920, path: '/health', start: 'node PolarUI/scripts/design-bridge.mjs' },
  { name: 'suggestion-bridge', port: 3921, path: '/health', start: 'node PolarUI/scripts/suggestion-bridge.mjs' },
  { name: 'run-trace-bridge', port: 3922, path: '/health', start: 'node PolarUI/scripts/run-trace-bridge.mjs' },
  { name: 'digist-api', port: 3800, path: '/api/health', start: 'cd digist && PORT=3800 npx tsx src/api/server.ts' },
  { name: 'Clock', port: 15550, path: '/health', start: 'bash Clock/Start/start.sh restart' },
  { name: 'PolarMemory', port: 3100, path: '/api/blocks/search', method: 'POST', start: 'bash PolarMemory/Start/start.sh restart' },
  { name: 'PolarPort', port: 11050, path: '/api/list', start: 'cd PolarPort && npm start' },
  { name: 'PolarProcess', port: 11055, path: '/api/services', start: 'cd PolarProcess && npm start' },
  { name: 'TQSDK', port: 8000, path: '/api/v1/research/runs', start: 'bash tqsdk/Start/start.sh restart' },
  { name: 'KnowLever', port: 18080, path: '/api/health', start: 'bash KnowLever/Start/start.sh restart' },
]

async function probe(svc) {
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}${svc.path}`, {
      method: svc.method ?? 'GET',
      ...(svc.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      signal: AbortSignal.timeout(4000),
    })
    if (svc.expectStatus != null) return res.status === svc.expectStatus
    return res.status < 500
  } catch {
    return false
  }
}

const statusEntries = []
let failed = 0

for (const svc of SERVICES) {
  let ok = await probe(svc)
  if (!ok) {
    console.log(`START: ${svc.name}:${svc.port} offline, launching...`)
    try {
      if (svc.startDetached) svc.startDetached()
      else execSync(svc.start, { cwd: root, stdio: 'ignore', detached: true })
      await new Promise(r => setTimeout(r, 4000))
    } catch {
      // start may fail when port already bound — re-probe before declaring offline
    }
    ok = await probe(svc)
    if (ok) console.log(`OK: ${svc.name} started`)
    else { console.error(`FAIL: ${svc.name} still offline`); failed++ }
  } else {
    console.log(`OK: ${svc.name}:${svc.port}`)
  }
  statusEntries.push({
    name: svc.name,
    port: svc.port,
    online: ok,
    checked_at: new Date().toISOString(),
  })
}

const payload = JSON.stringify({ services: statusEntries, updated_at: new Date().toISOString() }, null, 2) + '\n'
fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true })
fs.writeFileSync(STATUS_PATH, payload)
fs.mkdirSync(path.dirname(PUBLIC_STATUS_PATH), { recursive: true })
fs.writeFileSync(PUBLIC_STATUS_PATH, payload)
console.log(`Wrote ${STATUS_PATH}`)
console.log(`Wrote ${PUBLIC_STATUS_PATH}`)

process.exit(failed ? 1 : 0)
