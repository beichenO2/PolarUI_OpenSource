#!/usr/bin/env node
/** Switch cases 默认 2 项；按实际接线扩展，去掉历史固定 3～4 case 填充 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows')

function isNodeEntry(id, v) {
  return !id.startsWith('_') && v && typeof v === 'object' && v.class_type
}

function walkJsonFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walkJsonFiles(p, out)
    else if (ent.isFile() && ent.name.endsWith('.json') && ent.name !== 'registry.json') out.push(p)
  }
  return out
}

function maxWiredCaseSlot(json, switchId) {
  let max = -1
  for (const [, node] of Object.entries(json)) {
    if (typeof node !== 'object' || !node.inputs) continue
    for (const val of Object.values(node.inputs)) {
      if (Array.isArray(val) && val[0] === switchId && typeof val[1] === 'number') {
        max = Math.max(max, val[1])
      }
    }
  }
  return max
}

function normalizeCases(node, json, nodeId) {
  let cases = []
  try {
    const raw = node.inputs?.cases ?? node.params?.cases
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed)) cases = parsed
  } catch { /* */ }
  const wiredMax = maxWiredCaseSlot(json, nodeId)
  const need = Math.max(2, wiredMax >= 0 ? wiredMax + 1 : 2)
  while (cases.length < need) {
    cases.push({ label: `情况${cases.length + 1}` })
  }
  if (cases.length > need) cases = cases.slice(0, need)
  if (cases.length < 2) {
    cases = [{ label: '情况1' }, { label: '情况2' }]
  }
  return cases
}

let n = 0
for (const path of walkJsonFiles(ROOT)) {
  const json = JSON.parse(readFileSync(path, 'utf8'))
  let changed = false
  for (const [id, node] of Object.entries(json)) {
    if (!isNodeEntry(id, node) || node.class_type !== 'Switch') continue
    const cases = normalizeCases(node, json, id)
    const serialized = JSON.stringify(cases)
    const prev = String(node.inputs?.cases ?? node.params?.cases ?? '')
    if (prev !== serialized) {
      if (!node.inputs) node.inputs = {}
      node.inputs.cases = serialized
      delete node.params
      changed = true
      n++
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
}
console.log(`normalize Switch cases: ${n} nodes`)
