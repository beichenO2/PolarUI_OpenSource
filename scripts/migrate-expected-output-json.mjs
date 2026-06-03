#!/usr/bin/env node
/** 将 PromptInput expected_output 从单条正则迁移为 JSON 分块对象 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF_DIR = join(ROOT, 'workflows')

function migrateEo(raw) {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  const s = String(raw).trim()
  if (!s) return null
  try {
    const o = JSON.parse(s)
    if (typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) return o
  } catch { /* single regex */ }
  return { body: s }
}

function migrateFile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  let n = 0
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_') || node.class_type !== 'PromptInput') continue
    const eo = node.inputs?.expected_output ?? node.params?.expected_output
    const migrated = migrateEo(eo)
    if (!migrated) continue
    if (!node.inputs) node.inputs = {}
    node.inputs.expected_output = migrated
    if (node.params?.expected_output) node.params.expected_output = migrated
    n++
  }
  if (n) writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  return n
}

let total = 0
for (const f of readdirSync(WF_DIR)) {
  if (!f.endsWith('.json')) continue
  total += migrateFile(join(WF_DIR, f))
}
console.log('migrated PromptInput blocks:', total)
