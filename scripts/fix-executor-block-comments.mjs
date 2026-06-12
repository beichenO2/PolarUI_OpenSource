#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '../..')
const EXECUTOR = join(__dir, '../src/engine/executor.ts')
const NODE_DEFS = join(ROOT, 'PolarUI', 'node-defs')

const index = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8'))
const DESC = {}
for (const file of index.files) {
  const raw = JSON.parse(readFileSync(join(NODE_DEFS, file), 'utf8'))
  const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ class_type: k, ...v }))
  for (const def of entries) {
    const ct = def?.class_type
    if (ct) DESC[ct] = String(def.description || def.display_name || ct).slice(0, 220)
  }
}

let text = readFileSync(EXECUTOR, 'utf8')
let n = 0
text = text.replace(/^\/\*\* (\w+)：\1 \*\/$/gm, (_, ct) => {
  const d = DESC[ct]
  if (d && d !== ct) {
    n++
    return `/** ${ct}：${d} */`
  }
  return `/** ${ct}：${d || ct} */`
})
writeFileSync(EXECUTOR, text)
console.log('fixed block comments:', n)
