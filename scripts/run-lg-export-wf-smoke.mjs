#!/usr/bin/env node
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializedToWorkflowJson } from '../src/engine/lg-export-wf.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'test-lg-pluripotent-smoke.lg.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()
const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))
const result = await executeLGSpec(graph)
const wf = materializedToWorkflowJson(graph, result.materialized_graph)
if (!wf || typeof wf !== 'object') fail('wf_json missing')
else ok(`LGRunExportWF nodes: ${Object.keys(wf).filter(k => !k.startsWith('_')).length}`)

if (!wf._exported_from) fail('missing _exported_from')
else ok('materialized → WF JSON (08: 可选 promote Run → 新 Spec)')

console.log(`\n--- lg-export-wf smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
