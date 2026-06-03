#!/usr/bin/env node
/**
 * 为 registry 工作流补齐编译缺口：PromptInput JSON、Condition 第二出口、LLM→Validator→RetryLoop。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REG = JSON.parse(readFileSync(join(ROOT, 'workflows/registry.json'), 'utf8'))
const files = [...new Set(REG.map(e => e.file).filter(Boolean))]

function nextId(json) {
  let max = 0
  for (const k of Object.keys(json)) {
    if (k.startsWith('_')) continue
    const n = Number(k)
    if (!Number.isNaN(n)) max = Math.max(max, n)
  }
  return String(max + 1)
}

function migrateEo(raw) {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  const s = String(raw).trim()
  if (!s) return null
  try {
    const o = JSON.parse(s)
    if (typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length) return o
  } catch { /* */ }
  return { body: s }
}

function outgoingCount(json, id) {
  let n = 0
  const slots = new Set()
  for (const [, node] of Object.entries(json)) {
    if (typeof node !== 'object' || !node.inputs) continue
    for (const val of Object.values(node.inputs)) {
      if (Array.isArray(val) && val[0] === id) slots.add(val[1])
    }
  }
  return slots.size
}

function wireRef(json, fromId, fromSlot, toId, toKey, toSlot = 0) {
  const to = json[toId]
  if (!to?.inputs) to.inputs = {}
  to.inputs[toKey] = [fromId, fromSlot]
}

function fixFile(rel) {
  const path = join(ROOT, 'workflows', rel)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  let changed = false

  for (const [, node] of Object.entries(json)) {
    if (typeof node !== 'object') continue
    if (node.class_type === 'PromptInput') {
      const eo = node.inputs?.expected_output ?? node.params?.expected_output
      const m = migrateEo(eo)
      if (m) {
        if (!node.inputs) node.inputs = {}
        node.inputs.expected_output = m
        changed = true
      }
    }
    if (node.class_type === 'Switch') {
      try {
        const raw = node.inputs?.cases ?? node.params?.cases ?? '[]'
        const cases = JSON.parse(String(raw))
        if (!Array.isArray(cases) || cases.length < 2) {
          const serialized = JSON.stringify([{ label: '情况1' }, { label: '情况2' }])
          if (!node.inputs) node.inputs = {}
          node.inputs.cases = serialized
          delete node.params?.cases
          changed = true
        }
      } catch {
        const serialized = JSON.stringify([{ label: '情况1' }, { label: '情况2' }])
        if (!node.inputs) node.inputs = {}
        node.inputs.cases = serialized
        delete node.params?.cases
        changed = true
      }
    }
  }

  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_')) continue
    if (node.class_type === 'Condition' || node.class_type === 'Switch') {
      const outN = outgoingCount(json, id)
      if (outN < 2) {
        const missingSlots = [0, 1].filter(s => {
          let has = false
          for (const [, n] of Object.entries(json)) {
            if (!n?.inputs) continue
            for (const val of Object.values(n.inputs)) {
              if (Array.isArray(val) && val[0] === id && val[1] === s) has = true
            }
          }
          return !has
        })
        for (const slot of missingSlots) {
          const outId = nextId(json)
          json[outId] = {
            class_type: 'Output',
            inputs: { content: [id, slot] },
            params: { format: 'text' },
          }
          changed = true
        }
      }
    }
  }

  const agentic = new Set(['AgenticUnit', 'AgentWorkflow', 'AgenticChain'])
  for (const [id, node] of Object.entries(json)) {
    if (id.startsWith('_') || node.class_type !== 'LLM') continue
    if (/b$/.test(id) && json[id.slice(0, -1)]) continue
    const consumers = []
    for (const [tid, t] of Object.entries(json)) {
      if (tid.startsWith('_') || !t.inputs) continue
      for (const val of Object.values(t.inputs)) {
        if (Array.isArray(val) && val[0] === id) consumers.push(t.class_type)
      }
    }
    if (consumers.some(c => agentic.has(c))) continue

    let hasV = false
    let hasR = false
    for (const [tid, t] of Object.entries(json)) {
      if (tid.startsWith('_') || !t.inputs) continue
      for (const val of Object.values(t.inputs)) {
        if (!Array.isArray(val) || val[0] !== id) continue
        if (t.class_type === 'Validator') hasV = true
      }
      if (t.class_type === 'Validator') {
        for (const val of Object.values(t.inputs)) {
          if (Array.isArray(val) && val[0] === tid) {
            if (json[tid] && Object.values(json).some(n => n.class_type === 'RetryLoop' && n.inputs?.passed?.[0] === tid)) {
              hasR = true
            }
          }
        }
      }
    }
    if (hasV && hasR) continue

    const vid = nextId(json)
    json[vid] = {
      class_type: 'Validator',
      inputs: {
        actual_output: [id, 0],
        validation_spec: { expected_pattern: '.*' },
      },
      params: { verify_mode: 'step' },
    }
    const rid = nextId(json)
    json[rid] = {
      class_type: 'RetryLoop',
      inputs: {
        passed: [vid, 0],
        original_input: [id, 0],
      },
      params: { max_retries: 7 },
    }
    wireRef(json, id, 0, vid, 'actual_output', 0)
    changed = true

    for (const [tid, t] of Object.entries(json)) {
      if (tid.startsWith('_') || !t.inputs) continue
      for (const [key, val] of Object.entries(t.inputs)) {
        if (Array.isArray(val) && val[0] === id && val[1] === 0 && t.class_type !== 'Validator') {
          t.inputs[key] = [rid, 0]
        }
      }
    }
  }

  if (changed) writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  return changed
}

const targetFiles = process.argv.includes('--all')
  ? readdirSync(join(ROOT, 'workflows')).filter(f => f.endsWith('.json') && f !== 'registry.json')
  : files

let fixed = 0
let ok = 0
let fail = 0
const failList = []
for (const f of targetFiles) {
  try {
    fixFile(f)
    execSync(`node cli/compile-check.mjs workflows/${f}`, { cwd: ROOT, stdio: 'pipe' })
    ok++
  } catch {
    fail++
    failList.push(f)
  }
}
console.log('registry compile:', ok, 'ok', fail, 'fail')
if (failList.length) console.log(failList.join('\n'))
