#!/usr/bin/env node
/** 从 workflow JSON 移除 Ground / NullSource 并清理指向它们的 inputs 引用 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows')
const TERMINAL = new Set(['Ground', 'NullSource'])

function stripFile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const remove = new Set()
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_')) continue
    if (TERMINAL.has(node.class_type)) remove.add(id)
  }
  if (!remove.size) return 0
  for (const id of remove) delete json[id]
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_') || !node.inputs) continue
    for (const [key, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && remove.has(String(val[0]))) {
        delete node.inputs[key]
      }
    }
  }
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
  return remove.size
}

let total = 0
for (const name of readdirSync(ROOT)) {
  if (!name.endsWith('.json')) continue
  const n = stripFile(join(ROOT, name))
  if (n) {
    console.log(`stripped ${n} terminal(s) from ${name}`)
    total += n
  }
}
console.log(`done: ${total} terminal node(s) removed`)
