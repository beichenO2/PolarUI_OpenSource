#!/usr/bin/env node
/** LG Canvas utils + 5-step replay 数据 smoke */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { executeLGSpec } from '../src/engine/lg-runner.ts'
import {
  lgSpecEdgesToDraw,
  buildExistingLinkPairs,
  materializedLinksVisibleAtStep,
  isStemCellClass,
  buildLgCanvasRoutingLinks,
} from '../src/engine/lg-canvas-utils.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = join(ROOT, 'workflows', 'test-lg-react-replay.lg.json')

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const graph = loadWorkflowJson(readFileSync(WF, 'utf8'))
if (graph.library !== 'LG') fail('expected LG library')
else ok('LG library')

const pairs = buildExistingLinkPairs(graph.links)
const dashed = lgSpecEdgesToDraw(graph.lgEdges ?? [], pairs)
const conditional = dashed.filter(e => e.kind === 'conditional')
if (conditional.length < 2) fail(`conditional edges ${conditional.length}`)
else ok(`conditional dashed edges: ${conditional.length}`)

if (!isStemCellClass('LG_Pluripotent')) fail('isStemCellClass')
else ok('StemCell class detect')

const routingLinks = buildLgCanvasRoutingLinks(graph.links, graph.lgEdges ?? [])
if (routingLinks.length <= graph.links.length) {
  fail('buildLgCanvasRoutingLinks should add lg-spec virtual links on top of graph.links')
} else {
  ok(`LG routing links: ${routingLinks.length} (graph.links ${graph.links.length} + lg-spec extras)`)
}

const steps = []
const result = await executeLGSpec(graph, {
  onStep: ({ stepIndex, materialized_graph }) => {
    steps.push(stepIndex)
    const vis = materializedLinksVisibleAtStep(
      materialized_graph.links.map((l, i) => ({ ...l, step: i })),
      stepIndex,
    )
    if (vis.length < stepIndex) fail(`step ${stepIndex} visible links`)
  },
})

if (result.steps.length < 5) fail(`steps ${result.steps.length} < 5`)
else ok(`ReAct steps: ${result.steps.length}`)

if (steps.length !== result.steps.length) fail('onStep callback count')
else ok(`onLGStep callbacks: ${steps.length}`)

console.log(`\n--- lg-canvas smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
