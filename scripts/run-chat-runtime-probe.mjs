#!/usr/bin/env node
/**
 * 260525 Phase 4 — Chat shell runtime probe
 * 1) 构建产物含 ChatShell SPA
 * 2) 可选：PolarClaw :4810 在线时 GET /chat → /mc/chat
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLAW_WEB_DIST = join(ROOT, '..', 'PolarClaw', 'web', 'dist')
const PORT = Number(process.env.POLARCLAW_CHAT_PORT ?? 3910)
const BASE = `http://127.0.0.1:${PORT}`

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const indexHtml = join(CLAW_WEB_DIST, 'index.html')
if (!existsSync(indexHtml)) {
  fail('PolarClaw/web/dist/index.html missing — run: cd PolarClaw/web && npm run build')
} else {
  ok('dist/index.html exists')
}

const assetsDir = join(CLAW_WEB_DIST, 'assets')
let bundleText = ''
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir)) {
    if (f.startsWith('index-') && f.endsWith('.js')) {
      bundleText += readFileSync(join(assetsDir, f), 'utf8')
    }
  }
}
if (!bundleText.includes('新对话') || !bundleText.includes('搜索 workflow')) {
  fail('ChatShell strings not found in built bundle')
} else {
  ok('ChatShell bundle markers present')
}

async function probeLive() {
  let statusOk = false
  try {
    const ctrl = AbortSignal.timeout(2000)
    const r = await fetch(`${BASE}/api/status`, { signal: ctrl })
    statusOk = r.ok
  } catch {
    console.log('SKIP: PolarClaw not running on', BASE)
    return
  }
  if (!statusOk) {
    console.log('SKIP: /api/status not ok')
    return
  }
  ok(`PolarClaw live on :${PORT}`)

  const chatRes = await fetch(`${BASE}/chat`, { redirect: 'manual' })
  if (chatRes.status === 302 || chatRes.status === 301) {
    const loc = chatRes.headers.get('location') ?? ''
    if (!loc.includes('/mc/chat')) fail(`redirect location unexpected: ${loc}`)
    else ok(`GET /chat → ${loc}`)
  } else if (chatRes.ok) {
    ok('GET /chat inline fallback (dist not wired to server yet)')
  } else {
    fail(`GET /chat HTTP ${chatRes.status}`)
  }

  const mcRes = await fetch(`${BASE}/mc/chat`)
  if (!mcRes.ok) fail(`GET /mc/chat HTTP ${mcRes.status}`)
  else {
    const html = await mcRes.text()
    if (!html.includes('id="root"')) fail('/mc/chat missing SPA root')
    else ok('GET /mc/chat SPA shell')
  }
}

await probeLive()

console.log(`\n--- chat-runtime-probe: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
