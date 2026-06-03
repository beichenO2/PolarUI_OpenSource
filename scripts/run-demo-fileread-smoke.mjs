#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeGraph } from '../src/engine/workflow-runner.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
bootstrapHeadlessEngine()
const g = loadWorkflowJson(readFileSync(join(ROOT, 'workflows/test-demo-fileread.json'), 'utf8'))
const r = await executeGraph(g)
if (r.unhealthy_nodes.length) {
  console.error('FAIL:', r.unhealthy_nodes)
  process.exit(1)
}
const out = String(r.merged_output ?? '')
if (!out.includes('polar-ui')) {
  console.error('FAIL: output missing polar-ui')
  process.exit(1)
}
console.log('OK: demo-fileread', out.slice(0, 60))
process.exit(0)
