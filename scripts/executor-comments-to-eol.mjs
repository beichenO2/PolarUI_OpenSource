#!/usr/bin/env node
/**
 * 将 executor.ts 独立行注释合并为行尾注释（单一 SSOT，与侧栏展示一致）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '../..')
const EXECUTOR = join(__dir, '../src/engine/executor.ts')
const PIPELINE = join(__dir, '../src/engine/pipeline-executor.ts')
const NODE_DEFS = join(ROOT, 'node-defs')

function loadDefs() {
  const map = {}
  const index = JSON.parse(readFileSync(join(NODE_DEFS, 'index.json'), 'utf8'))
  for (const file of index.files) {
    const raw = JSON.parse(readFileSync(join(NODE_DEFS, file), 'utf8'))
    const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ class_type: k, ...v }))
    for (const def of entries) {
      const ct = def?.class_type
      if (ct) map[ct] = def
    }
  }
  return map
}

const DEFS = loadDefs()

function ioSummary(classType) {
  const def = DEFS[classType]
  if (!def) return `${classType} 执行器`
  const ins = (def.inputs ?? []).map(i => i.name).filter(Boolean).join('|') || '—'
  const outs = (def.outputs ?? []).map(o => o.name).filter(Boolean).join('|') || '—'
  const title = def.display_name || classType
  const desc = String(def.description ?? '').slice(0, 80)
  return `${title}：${desc} | 入:${ins} 出:${outs}`
}

function attachComment(codeLine, comment) {
  const trimmed = codeLine.trimEnd()
  if (!comment) return codeLine
  if (/\/\/|\/\*/.test(trimmed)) {
    const extra = comment.replace(/^\/\/\s*/, '')
    return `${trimmed}  // ${extra}`
  }
  return `${trimmed}  // ${comment}`
}

function migrateLines(lines) {
  const out = []
  const pending = []

  const flushTo = (codeLine) => {
    if (!pending.length) return codeLine
    const c = pending.join('；')
    pending.length = 0
    return attachComment(codeLine, c)
  }

  for (const line of lines) {
    const t = line.trim()

    if (/^\/\*\*/.test(t) && t.endsWith('*/')) {
      pending.push(t.replace(/^\/\*\*\s*/, '').replace(/\s*\*\/$/, '').trim())
      continue
    }

    if (/^\/\/(?!\/)/.test(t) && !t.includes('registerExecutor(')) {
      pending.push(t.slice(2).trim())
      continue
    }

    if (!t) {
      if (pending.length) {
        out.push(`  // ${pending.join('；')}`)
        pending.length = 0
      }
      out.push(line)
      continue
    }

    out.push(flushTo(line))
  }
  if (pending.length) out.push(`  // ${pending.join('；')}`)
  return out
}

function enrichRegisterExecutorOpeners(lines) {
  return lines.map((line) => {
    const m = line.match(/^registerExecutor\('([^']+)'([^]*?=>\s*\{)\s*(?:\/\/(.*))?$/)
    if (!m) return line
    const [, ct, head, oldComment] = m
    const summary = ioSummary(ct)
    const indent = line.match(/^(\s*)/)?.[1] ?? ''
    if (oldComment && oldComment.includes('入:')) return line
    return `${indent}registerExecutor('${ct}'${head}  // ${summary}`
  })
}

function processFile(path) {
  const text = readFileSync(path, 'utf8')
  let lines = migrateLines(text.split('\n'))
  lines = enrichRegisterExecutorOpeners(lines)
  writeFileSync(path, lines.join('\n'), 'utf8')
  console.log('EOL migrated:', path)
}

processFile(EXECUTOR)
processFile(PIPELINE)
