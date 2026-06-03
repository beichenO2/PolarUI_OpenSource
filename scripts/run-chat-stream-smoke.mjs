#!/usr/bin/env node
/** 260527 Phase 4.4 — workflow chat NDJSON stream smoke */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setLLMClient } from '../src/sdk/llm-proxy.ts'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => { console.error('FAIL:', m); failed++ }

setLLMClient({
  chat: async () => ({ content: 'stream smoke hello', usage: {} }),
})
bootstrapHeadlessEngine()

const r = spawnSync('npx', [
  'tsx', 'scripts/run-workflow-chat-once.mjs',
  '--workflow', 'test-multi-turn-chat',
  '--conversation-id', 'stream-smoke-conv',
  '--message', 'hi',
  '--stream',
], { cwd: ROOT, encoding: 'utf8', env: process.env })

const lines = (r.stdout || '').trim().split('\n').filter(Boolean)
if (lines.length < 3) fail(`expected ≥3 NDJSON lines, got ${lines.length}`)
else ok(`${lines.length} NDJSON lines`)

const types = new Set()
for (const line of lines) {
  try {
    const ev = JSON.parse(line)
    types.add(ev.type)
  } catch {
    fail(`invalid JSON line: ${line.slice(0, 80)}`)
  }
}

if (!types.has('step_start')) fail('missing step_start')
else ok('step_start present')
if (!types.has('final')) fail('missing final')
else ok('final present')
if (!types.has('step_start') || !types.has('final')) {
  /* already counted */
} else ok('claude-stream event kinds OK')

const serverSrc = join(ROOT, '..', 'PolarClaw', 'src', 'adapters', 'web', 'server.ts')
const serverText = readFileSync(serverSrc, 'utf8')
if (!serverText.includes('application/x-ndjson')) fail('server.ts missing ndjson stream')
else ok('server.ts NDJSON stream header')

console.log(`\n--- chat-stream-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
