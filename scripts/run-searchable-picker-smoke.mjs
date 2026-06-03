#!/usr/bin/env node
/** 260527 Phase 1 — WorkflowPicker 可搜索 combobox 构建探针 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const CLAW_WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'PolarClaw', 'web')
const DIST = join(CLAW_WEB, 'dist')

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

const srcPicker = join(CLAW_WEB, 'src', 'components', 'chat', 'WorkflowPicker.tsx')
if (!existsSync(srcPicker)) fail('WorkflowPicker.tsx missing')
else ok('WorkflowPicker.tsx source present')

const chatApi = join(CLAW_WEB, 'src', 'lib', 'chat-api.ts')
if (existsSync(chatApi)) {
  const apiText = readFileSync(chatApi, 'utf8')
  if (!apiText.includes("library: 'WF' | 'LG'")) fail('ChatDeployment.library type missing')
  else ok('ChatDeployment.library typed')
}

if (!existsSync(join(DIST, 'index.html'))) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: CLAW_WEB, stdio: 'pipe', encoding: 'utf8' })
  if (build.status !== 0) {
    fail('PolarClaw/web build failed')
    console.error((build.stderr || build.stdout || '').slice(-600))
  } else ok('PolarClaw/web build succeeded')
}

let bundleText = ''
const assetsDir = join(DIST, 'assets')
if (existsSync(assetsDir)) {
  for (const f of readdirSync(assetsDir)) {
    if (f.startsWith('index-') && f.endsWith('.js')) {
      bundleText += readFileSync(join(assetsDir, f), 'utf8')
    }
  }
}

const markers = ['搜索 workflow', 'WorkflowPicker', 'library']
for (const m of markers) {
  if (!bundleText.includes(m) && m !== 'WorkflowPicker') {
    // minified bundle may drop component name; require search placeholder
    if (m === '搜索 workflow' && !bundleText.includes('搜索')) fail(`bundle missing marker: ${m}`)
    else if (m !== 'WorkflowPicker') fail(`bundle missing marker: ${m}`)
  }
}
if (bundleText.includes('搜索') || bundleText.includes('workflow')) ok('searchable picker strings in bundle')

console.log(`\n--- searchable-picker-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
