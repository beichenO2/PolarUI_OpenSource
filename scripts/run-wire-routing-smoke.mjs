#!/usr/bin/env node
/**
 * Wire Routing smoke test — validates the three-layer routing pipeline:
 *   Layer 1: Orthogonal visibility graph router (obstacle avoidance)
 *   Layer 2: Parallel segment nudging
 *   Layer 3: Crossing detection (PCB-style bridges)
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { loadWorkflowJson } from '../src/engine/loader.ts'
import { routeAllLinks } from '../src/engine/wire-router.ts'
import { nudgeParallelSegments } from '../src/engine/wire-nudge.ts'
import { detectCrossings } from '../src/engine/wire-crossings.ts'
import { nodeDrawBounds } from '../src/engine/node-geometry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const ok = m => console.log('  OK:', m)
const fail = m => { console.error('  FAIL:', m); failed++ }

bootstrapHeadlessEngine()

/* ─── Test 1: Basic routing on a real workflow ─── */
console.log('\n=== Test 1: Route real workflow ===')
const wfPath = join(ROOT, 'workflows', 'mvp-seed-wf.json')
const graph = loadWorkflowJson(readFileSync(wfPath, 'utf8'))
const forwardLinks = graph.links.filter(l => {
  const fn = graph.nodes.find(n => n.id === l.from_node)
  const tn = graph.nodes.find(n => n.id === l.to_node)
  return fn && tn && fn.x + fn.width < tn.x + tn.width * 0.5
})

const paths = routeAllLinks(graph.nodes, graph.links)
if (paths.size > 0) ok(`Routed ${paths.size} forward links`)
else fail('No forward links routed')

for (const [linkId, path] of paths) {
  if (path.length < 2) { fail(`Link ${linkId}: path too short (${path.length})`); continue }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const isHorV = Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5
    if (!isHorV) { fail(`Link ${linkId} seg ${i}: not orthogonal (${a.x},${a.y})→(${b.x},${b.y})`); break }
  }
}
ok('All routed paths are orthogonal')

/* ─── Test 2: Obstacle avoidance check ─── */
console.log('\n=== Test 2: Obstacle avoidance ===')
let obstacleViolations = 0
const BUFFER = 12
for (const [linkId, path] of paths) {
  const link = graph.links.find(l => l.id === linkId)
  if (!link) continue
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    for (const node of graph.nodes) {
      if (node.id === link.from_node || node.id === link.to_node) continue
      if (node.class_type === 'NoteCard') continue
      const bd = nodeDrawBounds(node)
      const ox = bd.x - BUFFER + 2, oy = bd.y - BUFFER + 2
      const ow = bd.w + BUFFER * 2 - 4, oh = bd.h + BUFFER * 2 - 4
      if (Math.abs(a.y - b.y) < 0.5) {
        const y = a.y
        if (y > oy && y < oy + oh) {
          const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x)
          if (lo < ox + ow && hi > ox) obstacleViolations++
        }
      }
      if (Math.abs(a.x - b.x) < 0.5) {
        const x = a.x
        if (x > ox && x < ox + ow) {
          const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y)
          if (lo < oy + oh && hi > oy) obstacleViolations++
        }
      }
    }
  }
}
if (obstacleViolations === 0) ok('No obstacle violations')
else fail(`${obstacleViolations} obstacle violations`)

/* ─── Test 3: Nudging ─── */
console.log('\n=== Test 3: Nudging ===')
const nudged = nudgeParallelSegments(paths)
if (nudged.size === paths.size) ok(`Nudging preserved all ${nudged.size} paths`)
else fail(`Nudging changed path count: ${paths.size} → ${nudged.size}`)

/* ─── Test 4: Crossing detection ─── */
console.log('\n=== Test 4: Crossing detection ===')
const crossings = detectCrossings(nudged)
ok(`Detected ${crossings.length} crossing(s)`)
for (const c of crossings) {
  if (typeof c.x !== 'number' || typeof c.y !== 'number') { fail('Invalid crossing point'); break }
  if (!c.overLinkId || !c.underLinkId) { fail('Crossing missing link IDs'); break }
}
if (crossings.length > 0) ok('All crossings have valid structure')

/* ─── Test 5: Port alignment check ─── */
console.log('\n=== Test 5: Paths start/end at port anchors ===')
import { linkAnchor } from '../src/engine/node-geometry.ts'
let portMismatches = 0
for (const [linkId, path] of paths) {
  const link = graph.links.find(l => l.id === linkId)
  if (!link) continue
  const fn = graph.nodes.find(n => n.id === link.from_node)
  const tn = graph.nodes.find(n => n.id === link.to_node)
  if (!fn || !tn) continue
  const fromAnchor = linkAnchor(fn, link.from_slot, 'out')
  const toAnchor = linkAnchor(tn, link.to_slot, 'in')
  const start = path[0], end = path[path.length - 1]
  if (Math.abs(start.x - fromAnchor.x) > 1 || Math.abs(start.y - fromAnchor.y) > 1) {
    fail(`${linkId} start (${start.x},${start.y}) ≠ anchor (${fromAnchor.x},${fromAnchor.y})`)
    portMismatches++
  }
  if (Math.abs(end.x - toAnchor.x) > 1 || Math.abs(end.y - toAnchor.y) > 1) {
    fail(`${linkId} end (${end.x},${end.y}) ≠ anchor (${toAnchor.x},${toAnchor.y})`)
    portMismatches++
  }
}
if (portMismatches === 0) ok('All paths start/end at port anchors')

/* ─── Test 6: Same-output wires share color ─── */
console.log('\n=== Test 6: Same-output color consistency ===')
import { buildLinkColorMaps } from '../src/engine/wire-colors.ts'
const crossings2 = detectCrossings(nudged)
const colorMaps = buildLinkColorMaps(graph.links, graph.nodes, undefined, undefined, crossings2)
const outputGroups = new Map()
for (const link of graph.links) {
  const key = `${link.from_node}:${link.from_slot}`
  if (!outputGroups.has(key)) outputGroups.set(key, [])
  outputGroups.get(key).push(link.id)
}
let colorMismatches = 0
for (const [key, ids] of outputGroups) {
  const colors = ids.map(id => colorMaps.forwardByLink.get(id)).filter(Boolean)
  if (colors.length > 1 && new Set(colors).size > 1) {
    fail(`Output group ${key}: mixed colors ${[...new Set(colors)].join(',')}`)
    colorMismatches++
  }
}
if (colorMismatches === 0) ok(`All ${outputGroups.size} output groups have consistent colors`)

/* ─── Test 7: Shared trunk test ─── */
console.log('\n=== Test 7: Shared trunk merging ===')
const trunkNodes = [
  { id: 'S', class_type: 'Prompt', x: 0, y: 100, width: 200, height: 150, params: {} },
  { id: 'D1', class_type: 'Prompt', x: 500, y: 0, width: 200, height: 150, params: {} },
  { id: 'D2', class_type: 'Prompt', x: 500, y: 250, width: 200, height: 150, params: {} },
]
const trunkLinks = [
  { id: 'T1', from_node: 'S', from_slot: 0, to_node: 'D1', to_slot: 0 },
  { id: 'T2', from_node: 'S', from_slot: 0, to_node: 'D2', to_slot: 0 },
]
const trunkPaths = routeAllLinks(trunkNodes, trunkLinks)
const t1 = trunkPaths.get('T1'), t2 = trunkPaths.get('T2')
if (t1 && t2) {
  const startsSame = Math.abs(t1[0].x - t2[0].x) < 1 && Math.abs(t1[0].y - t2[0].y) < 1
  if (startsSame) ok('Both wires start from exact same pixel')
  else fail(`Start mismatch: (${t1[0].x},${t1[0].y}) vs (${t2[0].x},${t2[0].y})`)
  const seg1end = t1[1], seg2end = t2[1]
  const sharedTrunk = seg1end && seg2end && Math.abs(seg1end.x - seg2end.x) < 1 && Math.abs(seg1end.y - seg2end.y) < 1
  if (sharedTrunk) ok(`Shared trunk to (${seg1end.x},${seg1end.y}) before branching`)
  else fail('Wires diverge immediately — trunk merging not working')
} else fail('Trunk paths not generated')

/* ─── Test 8: Input bus merging ─── */
console.log('\n=== Test 8: Input bus merging ===')
const busNodes = [
  { id: 'S1', class_type: 'Prompt', x: 0, y: 0, width: 200, height: 150, params: {} },
  { id: 'S2', class_type: 'Prompt', x: 0, y: 250, width: 200, height: 150, params: {} },
  { id: 'D', class_type: 'Prompt', x: 500, y: 100, width: 200, height: 150, params: {} },
]
const busLinks = [
  { id: 'B1', from_node: 'S1', from_slot: 0, to_node: 'D', to_slot: 0 },
  { id: 'B2', from_node: 'S2', from_slot: 0, to_node: 'D', to_slot: 1 },
]
const busPaths = routeAllLinks(busNodes, busLinks)
const b1 = busPaths.get('B1'), b2 = busPaths.get('B2')
if (b1 && b2) {
  const endsSameX = Math.abs(b1[b1.length - 1].x - b2[b2.length - 1].x) < 1
  if (endsSameX) ok('Both wires end at same destination X')
  else fail(`Destination X mismatch`)
  const b1pre = b1[b1.length - 2]
  const b2pre = b2[b2.length - 2]
  const busMerged = b1pre && b2pre && Math.abs(b1pre.x - b2pre.x) < 1
  if (busMerged) ok(`Input bus at X=${b1pre.x} — wires converge before entering node`)
  else fail(`Input bus not detected: pre-dest X differ (${b1pre?.x} vs ${b2pre?.x})`)
} else fail('Input bus paths not generated')

/* ─── Test 9: Port alignment AFTER nudging ─── */
console.log('\n=== Test 9: Post-nudge port alignment ===')
let postNudgeMismatches = 0
for (const [linkId, path] of nudged) {
  const link = graph.links.find(l => l.id === linkId)
  if (!link) continue
  const fn = graph.nodes.find(n => n.id === link.from_node)
  const tn = graph.nodes.find(n => n.id === link.to_node)
  if (!fn || !tn) continue
  const fromAnchor = linkAnchor(fn, link.from_slot, 'out')
  const toAnchor = linkAnchor(tn, link.to_slot, 'in')
  const start = path[0], end = path[path.length - 1]
  if (Math.abs(start.x - fromAnchor.x) > 1 || Math.abs(start.y - fromAnchor.y) > 1) {
    fail(`POST-NUDGE ${linkId} start (${start.x.toFixed(1)},${start.y.toFixed(1)}) ≠ anchor (${fromAnchor.x},${fromAnchor.y})`)
    postNudgeMismatches++
  }
  if (Math.abs(end.x - toAnchor.x) > 1 || Math.abs(end.y - toAnchor.y) > 1) {
    fail(`POST-NUDGE ${linkId} end (${end.x.toFixed(1)},${end.y.toFixed(1)}) ≠ anchor (${toAnchor.x},${toAnchor.y})`)
    postNudgeMismatches++
  }
}
if (postNudgeMismatches === 0) ok('All paths still aligned with port anchors after nudging')

/* ─── Test 10: Synthetic obstacle test ─── */
console.log('\n=== Test 10: Synthetic 3-node test ===')
const syntheticNodes = [
  { id: 'A', class_type: 'Prompt', x: 0, y: 0, width: 200, height: 150, params: {} },
  { id: 'B', class_type: 'Prompt', x: 0, y: 200, width: 200, height: 150, params: {} },
  { id: 'C', class_type: 'Prompt', x: 500, y: 100, width: 200, height: 150, params: {} },
]
const syntheticLinks = [
  { id: 'L1', from_node: 'A', from_slot: 0, to_node: 'C', to_slot: 0 },
  { id: 'L2', from_node: 'B', from_slot: 0, to_node: 'C', to_slot: 1 },
]
const synPaths = routeAllLinks(syntheticNodes, syntheticLinks)
if (synPaths.size === 2) ok('Both synthetic links routed')
else fail(`Expected 2 routed links, got ${synPaths.size}`)

for (const [id, path] of synPaths) {
  if (path.length >= 2) ok(`${id}: ${path.length} waypoints`)
  else fail(`${id}: too few waypoints`)
}

/* ─── Summary ─── */
console.log('\n' + (failed === 0 ? '✅ All wire-routing smoke tests passed' : `❌ ${failed} failure(s)`))
process.exit(failed > 0 ? 1 : 0)
