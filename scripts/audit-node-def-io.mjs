#!/usr/bin/env node
/** 对照 executor registerExecutor 与 node-def inputs/outputs 名称 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defsDir = path.join(root, 'node-defs')
const executorPath = path.join(root, 'PolarUI/src/engine/executor.ts')
const executor = fs.readFileSync(executorPath, 'utf8')
const index = JSON.parse(fs.readFileSync(path.join(defsDir, 'index.json'), 'utf8'))

const inputUse = new Map()
for (const m of executor.matchAll(/inputs\.(\w+)/g)) {
  const ct = findNearestRegister(m.index, executor)
  if (!ct) continue
  if (!inputUse.has(ct)) inputUse.set(ct, new Set())
  inputUse.get(ct).add(m[1])
}

function findNearestRegister(idx, src) {
  const before = src.slice(0, idx)
  const m = before.match(/registerExecutor\('([^']+)'/g)
  return m ? m[m.length - 1].match(/'([^']+)'/)[1] : null
}

const mismatches = []
for (const f of index.files) {
  const nodes = JSON.parse(fs.readFileSync(path.join(defsDir, f), 'utf8'))
  for (const node of nodes) {
    const ct = node.class_type
    const used = inputUse.get(ct)
    if (!used) continue
    const declared = new Set((node.inputs || []).map(i => i.name))
    for (const u of used) {
      if (!declared.has(u)) mismatches.push(`${ct}: executor uses inputs.${u} but node-def missing`)
    }
  }
}

if (mismatches.length) {
  console.log('IO mismatches:', mismatches.length)
  mismatches.slice(0, 30).forEach(l => console.log(' -', l))
  process.exit(1)
}
console.log('IO audit OK (sampled inputs.* vs node-def)')
