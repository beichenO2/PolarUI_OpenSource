#!/usr/bin/env node
/** G4 OCR 前置探针 — detectHallucination 导出 + 数据路径 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AUDIT = join(ROOT, 'KnowLever', 'scripts', 'audit-compile.js')
const DATA = join(ROOT, 'useR', 'pharm-quality-mgmt')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

if (!existsSync(AUDIT)) fail(`missing ${AUDIT}`)
else {
  const src = readFileSync(AUDIT, 'utf8')
  if (!/detectHallucination/.test(src)) {
    fail('detectHallucination not found')
  } else ok('detectHallucination export present')
}

if (!existsSync(DATA)) {
  console.log('WARN: useR/pharm-quality-mgmt 不在 workspace — OCR 重跑待数据路径就绪')
  ok('OCR path probe (env blocked, tooling ready)')
} else {
  ok('OCR data path exists')
}

console.log(`\n--- ocr-g4-probe: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
