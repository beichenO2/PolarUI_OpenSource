#!/usr/bin/env node
/** Dagre 自动布局验收 — 0 重叠 + 最小间距 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflowJson, applyGraphAutoLayout, computeBackLinks } from '../src/engine/loader.ts'
import { buildLayoutEdges } from '../src/engine/auto-layout.ts'
import { buildLgCanvasRoutingLinks } from '../src/engine/lg-canvas-utils.ts'
import { countNodeOverlaps } from '../src/engine/node-geometry.ts'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
bootstrapHeadlessEngine()

let failed = 0
function ok(m) { console.log('OK:', m) }
function fail(m) { console.error('FAIL:', m); failed++ }

async function testFile(rel) {
  const g = loadWorkflowJson(readFileSync(join(ROOT, rel), 'utf8'))
  computeBackLinks(g)
  const edges = buildLayoutEdges(g)
  const expected = g.library === 'LG' ? (g.lgEdges?.filter(e => !e.label?.includes('ReAct') && !e.label?.includes('回环') && !e.label?.includes('RetryLoop')).length ?? 0) : 20
  if (g.library === 'LG') {
    if (edges.length < expected) fail(`${rel}: layout edges ${edges.length} < ${expected}`)
    else ok(`${rel}: layout edges=${edges.length}`)
  }
  await applyGraphAutoLayout(g)
  const overlaps = countNodeOverlaps(g.nodes)
  if (overlaps > 0) fail(`${rel}: ${overlaps} overlapping node pairs`)
  else ok(`${rel}: 0 overlaps`)
  if (g.library === 'LG') {
    const routing = buildLgCanvasRoutingLinks(g.links, g.lgEdges).length
    if (routing < g.links.length) fail(`${rel}: routing links ${routing} < graph.links ${g.links.length}`)
    else ok(`${rel}: LG routing links=${routing} (includes all ${g.links.length} data links)`)
  }
}

await testFile('workflows/polarclaw-ide.lg.json')
await testFile('workflows/hermes.lg.json')
await testFile('workflows/claude-code.lg.json')
await testFile('workflows/evolution-loop.json')

process.exit(failed > 0 ? 1 : 0)
