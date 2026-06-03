#!/usr/bin/env node
/** 260524_1 gate §2.1 #3 — seed PromptInput 非占位文案 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLACEHOLDER = /描述要从原模型分化出的/i

bootstrapHeadlessEngine()

let failed = 0
const ok = (m) => console.log('OK:', m)
const fail = (m) => {
  console.error('FAIL:', m)
  failed++
}

function promptContent(graph, file) {
  const nodes = graph.nodes.filter(n => n.class_type === 'PromptInput')
  if (nodes.length === 0) {
    fail(`${file}: no PromptInput node`)
    return
  }
  for (const node of nodes) {
    const text = String(node.params.content ?? node.params.prompt_text ?? '').trim()
    if (!text) fail(`${file} #${node.id}: empty PromptInput content`)
    else if (PLACEHOLDER.test(text)) fail(`${file} #${node.id}: placeholder content`)
    else if (text.length < 20) fail(`${file} #${node.id}: content too short (${text.length})`)
    else ok(`${file} #${node.id}: ${text.slice(0, 48)}…`)
  }
}

for (const rel of ['workflows/mvp-seed-wf.json', 'workflows/mvp-seed-lg.lg.json']) {
  const graph = loadWorkflowJson(readFileSync(join(ROOT, rel), 'utf8'))
  promptContent(graph, rel)
}

console.log(`\n--- seed-prompt-check: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
