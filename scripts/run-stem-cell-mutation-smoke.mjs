#!/usr/bin/env node
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { Graph } from '../src/engine/graph.ts'
import { executeNode } from '../src/engine/executor.ts'

bootstrapHeadlessEngine()

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

const g = new Graph('stem-mutation-smoke')
const stem = g.addNode('StemCell', 100, 100)
if (!stem) fail('add StemCell')
const before = g.nodes.length
const r = await executeNode(stem, {
  graph: g,
  links: g.links,
  getNodeOutput: () => undefined,
  allResults: new Map(),
  workflowLibrary: 'WF',
})
if (!r.outputs?.graph_mutated) fail('graph_mutated false')
else ok('StemCell wrote graph')
if (g.nodes.length <= before) fail('node count did not grow')
else ok(`nodes ${before} -> ${g.nodes.length}`)
if (g.links.length < 1) fail('expected link from stem')
else ok(`links ${g.links.length}`)

console.log(failed ? 'FAIL' : 'PASS', 'stem-cell-mutation-smoke')
process.exit(failed ? 1 : 0)
