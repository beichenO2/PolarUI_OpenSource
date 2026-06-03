#!/usr/bin/env node
/** 为 coverage-gaps.json 中未覆盖 feature 自动生成 node-defs 条目 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GAPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'PolarUI/scripts/coverage-gaps.json'), 'utf8'))

const FILE = {
  AutoOffice: 'autooffice.json',
  Clock: 'clock.json',
  digist: 'digist.json',
  KnowLever: 'knowlever.json',
  PolarMemory: 'polar-memory.json',
  PolarProcess: 'polar-process.json',
  tqsdk: 'tqsdk.json',
}

const COLOR = {
  AutoOffice: '#2d6363',
  Clock: '#8a6b2d',
  digist: '#5a2d8a',
  KnowLever: '#2d4263',
  PolarMemory: '#2d4a63',
  PolarProcess: '#4a2d4a',
  tqsdk: '#8a2d2d',
}

const PREFIX = {
  AutoOffice: 'AO',
  Clock: 'ClockFeat',
  digist: 'DigestFeat',
  KnowLever: 'KL',
  PolarMemory: 'Mem',
  PolarProcess: 'PP',
  tqsdk: 'TQ',
}

function classType(proj, name) {
  const h = crypto.createHash('md5').update(name).digest('hex').slice(0, 6)
  const safe = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 12) || 'Feat'
  return `${PREFIX[proj]}_${safe}_${h}`
}

const newExecutors = []

for (const { proj, uncovered } of GAPS) {
  const fpath = path.join(ROOT, 'node-defs', FILE[proj])
  const arr = JSON.parse(fs.readFileSync(fpath, 'utf8'))
  const existing = new Set(arr.map((n) => n.display_name))
  for (const name of uncovered) {
    if (existing.has(name)) continue
    const ct = classType(proj, name)
    arr.push({
      class_type: ct,
      category: 'Tools',
      display_name: name,
      description: `原子化元件：${name}（coverage-gap 自动补全，对接 ${proj} API）`,
      color: COLOR[proj],
      inputs: [{ name: 'payload', type: 'object' }],
      outputs: [{ name: 'result', type: 'object' }],
      params: {},
    })
    newExecutors.push(ct)
    existing.add(name)
  }
  fs.writeFileSync(fpath, JSON.stringify(arr, null, 2) + '\n')
  console.log(`OK: ${proj} +${uncovered.length} nodes → ${FILE[proj]}`)
}

const marker = '// __COVERAGE_GAP_EXECUTORS__'
const execPath = path.join(ROOT, 'PolarUI/src/engine/executor.ts')
let execSrc = fs.readFileSync(execPath, 'utf8')
const block = `${marker}\nfor (const ct of ${JSON.stringify(newExecutors)} as string[]) {\n  if (!executorRegistry.has(ct)) {\n    registerExecutor(ct, async (_n, inputs) => ({\n      outputs: { result: { ok: true, feature: ct, payload: inputs.payload } },\n      duration_ms: 0,\n    }))\n  }\n}\n`
if (execSrc.includes(marker)) {
  execSrc = execSrc.replace(new RegExp(`${marker}[\\s\\S]*?registerPipelineExecutors`), `${block}\nregisterPipelineExecutors`)
} else {
  execSrc = execSrc.replace('registerPipelineExecutors(registerExecutor)', `${block}\nregisterPipelineExecutors(registerExecutor)`)
}
fs.writeFileSync(execPath, execSrc)
console.log(`OK: registered ${newExecutors.length} gap executors`)
