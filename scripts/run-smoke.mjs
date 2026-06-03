#!/usr/bin/env node
/** Run PolarUI tsx smoke scripts with txt?raw loader shim */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = process.argv[2]
if (!script) {
  console.error('Usage: node scripts/run-smoke.mjs <script.mjs>')
  process.exit(1)
}

const loader = join(ROOT, 'scripts/txt-raw-loader.mjs')
const scriptPath = script.startsWith('/') ? script : join(ROOT, 'scripts', script)

const r = spawnSync(
  'npx',
  ['tsx', `--import=${loader}`, scriptPath, ...process.argv.slice(3)],
  { stdio: 'inherit', cwd: ROOT, env: process.env },
)
process.exit(r.status ?? 1)
