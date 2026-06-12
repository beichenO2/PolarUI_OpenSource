#!/usr/bin/env node
/**
 * 应用已批准的进化建议 → 写 workflows / registry / node-defs（带备份）
 * SSOT: 任务书/Done/260523_整理归档/260523/11_进化建议与人审闸门.md §3.3
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const POLAR_UI = join(ROOT, 'PolarUI')
const DATA = join(POLAR_UI, 'data', 'evolution-suggestions.json')
const AUDIT = join(POLAR_UI, 'data', 'suggestion-audit.jsonl')
const BACKUP = join(POLAR_UI, 'data', 'suggestion-backups')

function backup(path) {
  if (!existsSync(path)) return null
  mkdirSync(BACKUP, { recursive: true })
  const dest = join(BACKUP, `${basename(path)}.${Date.now()}.bak`)
  copyFileSync(path, dest)
  return dest
}

function appendAudit(entry) {
  mkdirSync(dirname(AUDIT), { recursive: true })
  writeFileSync(AUDIT, (existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : '') + JSON.stringify(entry) + '\n')
}

function resolveRepoPath(rel) {
  const p = rel.startsWith('PolarUI/') ? join(ROOT, rel) : join(POLAR_UI, rel.replace(/^PolarUI\//, ''))
  return p
}

function applyAddWorkflow(sug, targets) {
  const after = sug.diff?.after
  if (!after || typeof after !== 'object') throw new Error('ADD_WORKFLOW missing diff.after')
  const relPath = sug.diff.path ?? 'workflows/slave-draft.json'
  const wfPath = resolveRepoPath(relPath)
  const results = []

  if (targets.some(t => t.label.includes('workflow') || t.id === 'wf' || t.id === 't1')) {
    backup(wfPath)
    mkdirSync(dirname(wfPath), { recursive: true })
    writeFileSync(wfPath, JSON.stringify(after, null, 2) + '\n')
    results.push(`wrote ${wfPath}`)
  }

  if (targets.some(t => t.label.includes('registry') || t.id === 'reg' || t.id === 't2')) {
    const regPath = join(POLAR_UI, 'workflows', 'registry.json')
    backup(regPath)
    const reg = JSON.parse(readFileSync(regPath, 'utf8'))
    const file = basename(wfPath)
    if (!reg.some(e => e.file === file)) {
      reg.push({
        id: randomUUID(),
        name: sug.title,
        description: sug.rationale,
        category: 'seed-derived',
        library: 'WF',
        nodeCount: Object.keys(after).filter(k => !k.startsWith('_')).length,
        file,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n')
      results.push(`appended registry → ${file}`)
    }
  }
  return results
}

function applyRemoveNodeDef(sug, targets) {
  const rel = sug.diff?.path ?? 'node-defs/agentic.json'
  const path = join(ROOT, 'PolarUI', rel)
  backup(path)
  const defs = JSON.parse(readFileSync(path, 'utf8'))
  const ct = sug.diff?.before?.class_type
  const def = defs.find(d => d.class_type === ct)
  if (def && targets.length) {
    def.deprecated = true
    def.palette_hidden = true
    writeFileSync(path, JSON.stringify(defs, null, 2) + '\n')
    return [`deprecated ${ct} in ${rel}`]
  }
  return []
}

export function applySuggestion(sug, targetIds) {
  const targets = sug.apply_targets.filter(t => targetIds.includes(t.id))
  if (!targets.length) throw new Error('no targets selected')

  let applied = []
  switch (sug.kind) {
    case 'ADD_WORKFLOW':
      applied = applyAddWorkflow(sug, targets)
      break
    case 'REMOVE_NODE_DEF':
      applied = applyRemoveNodeDef(sug, targets)
      break
    default:
      throw new Error(`apply not implemented for kind ${sug.kind}`)
  }

  appendAudit({
    ts: new Date().toISOString(),
    action: 'apply',
    suggestion_id: sug.id,
    targets: targetIds,
    applied,
  })
  return applied
}

/** CLI: node scripts/suggestion-apply.mjs <suggestion_id> <target_id...> */
if (process.argv[1]?.endsWith('suggestion-apply.mjs')) {
  const [, , sugId, ...targetIds] = process.argv
  if (!sugId || !targetIds.length) {
    console.error('Usage: node scripts/suggestion-apply.mjs <suggestion_id> <target_id...>')
    process.exit(1)
  }
  const list = JSON.parse(readFileSync(DATA, 'utf8'))
  const sug = list.find(s => s.id === sugId)
  if (!sug) {
    console.error('Suggestion not found:', sugId)
    process.exit(1)
  }
  const applied = applySuggestion(sug, targetIds)
  console.log('OK:', applied.join('; '))
}
