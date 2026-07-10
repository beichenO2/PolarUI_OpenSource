/**
 * Orthogonal Visibility Graph Router — pure TypeScript, no WASM.
 *
 * Algorithm:
 *   1. Build axis-aligned obstacle rectangles from node bounding boxes (+ buffer).
 *   2. Collect candidate X/Y coordinates from obstacle edges + port stubs.
 *   3. Build a sparse grid: valid nodes = candidate intersections outside all obstacles.
 *   4. Build edges: adjacent grid nodes on the same H/V line with no obstacle between them.
 *   5. A* with Manhattan heuristic + turn penalty → clean orthogonal paths.
 */
import type { NodeInstance, Link } from './types'
import type { Vec2, AABB } from './node-geometry'
import {
  nodeDrawBounds,
  linkAnchor,
  isNoteCardNode,
  isBackwardLink,
  DEFAULT_WIRE_ROUTING_OPTIONS,
  computeBackwardLinkLanes,
  backwardLoopDropY,
} from './node-geometry'
import { buildObstacleAvoidingPath, buildFallbackPath, safeStubX } from './wire-path'

const STUB = DEFAULT_WIRE_ROUTING_OPTIONS.stubSize
const BUFFER = DEFAULT_WIRE_ROUTING_OPTIONS.shapeBufferDistance
const TURN_PENALTY = 25
const STAGGER_BASE = 5
const STAGGER_STEP = 3

function staggeredStub(slotIndex: number): number {
  return STUB + STAGGER_BASE + slotIndex * STAGGER_STEP
}

/* ─── MinHeap ─── */

interface HeapEntry { key: number; value: number; dir: number }

class MinHeap {
  private d: HeapEntry[] = []
  get size() { return this.d.length }
  push(key: number, value: number, dir: number) {
    this.d.push({ key, value, dir })
    this._up(this.d.length - 1)
  }
  pop(): HeapEntry | undefined {
    if (!this.d.length) return undefined
    const top = this.d[0]
    const last = this.d.pop()!
    if (this.d.length) { this.d[0] = last; this._down(0) }
    return top
  }
  private _up(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.d[i].key >= this.d[p].key) break
      ;[this.d[i], this.d[p]] = [this.d[p], this.d[i]]
      i = p
    }
  }
  private _down(i: number) {
    const n = this.d.length
    while (true) {
      let s = i
      const l = 2 * i + 1, r = 2 * i + 2
      if (l < n && this.d[l].key < this.d[s].key) s = l
      if (r < n && this.d[r].key < this.d[s].key) s = r
      if (s === i) break
      ;[this.d[i], this.d[s]] = [this.d[s], this.d[i]]
      i = s
    }
  }
}

/* ─── Geometry ─── */

function inside(o: AABB, x: number, y: number): boolean {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h
}

function hSegBlocked(y: number, x1: number, x2: number, obs: AABB[]): boolean {
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2)
  for (const o of obs) {
    if (y <= o.y || y >= o.y + o.h) continue
    if (lo < o.x + o.w && hi > o.x) return true
  }
  return false
}

function vSegBlocked(x: number, y1: number, y2: number, obs: AABB[]): boolean {
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2)
  for (const o of obs) {
    if (x <= o.x || x >= o.x + o.w) continue
    if (lo < o.y + o.h && hi > o.y) return true
  }
  return false
}

let astarWarnedThisPass = false

function resetAstarWarn(): void {
  astarWarnedThisPass = false
}

function warnAstarFallback(context: string): void {
  if (astarWarnedThisPass) return
  astarWarnedThisPass = true
  console.warn(`[PolarUI wire-router] A* routing limit or unreachable grid for ${context}; using obstacle perimeter fallback`)
}

function obstacleFallback(from: Vec2, to: Vec2, obstacles: AABB[], context: string): Vec2[] {
  warnAstarFallback(context)
  return buildObstacleAvoidingPath(from, to, obstacles)
}

/* ─── Grid + adjacency ─── */

interface GridResult {
  pts: Vec2[]
  idx: Map<string, number>
  adj: number[][]   // adj[nodeId] = [neighborId, cost, neighborId, cost, ...]
}

function buildGrid(obs: AABB[], extraPts: Vec2[]): GridResult {
  const xs = new Set<number>()
  const ys = new Set<number>()

  for (const o of obs) {
    xs.add(o.x); xs.add(o.x + o.w)
    ys.add(o.y); ys.add(o.y + o.h)
  }
  for (const p of extraPts) { xs.add(p.x); ys.add(p.y) }

  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)

  const pts: Vec2[] = []
  const idx = new Map<string, number>()

  for (const x of sx) {
    for (const y of sy) {
      if (obs.some(o => inside(o, x, y))) continue
      const id = pts.length
      idx.set(`${x},${y}`, id)
      pts.push({ x, y })
    }
  }

  const adj: number[][] = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) adj[i] = []

  const byY = new Map<number, number[]>()
  const byX = new Map<number, number[]>()
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!byY.has(p.y)) byY.set(p.y, [])
    byY.get(p.y)!.push(i)
    if (!byX.has(p.x)) byX.set(p.x, [])
    byX.get(p.x)!.push(i)
  }

  for (const [y, ids] of byY) {
    ids.sort((a, b) => pts[a].x - pts[b].x)
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i], b = ids[i + 1]
      if (!hSegBlocked(y, pts[a].x, pts[b].x, obs)) {
        const cost = Math.abs(pts[b].x - pts[a].x)
        adj[a].push(b, cost)
        adj[b].push(a, cost)
      }
    }
  }
  for (const [x, ids] of byX) {
    ids.sort((a, b) => pts[a].y - pts[b].y)
    for (let i = 0; i < ids.length - 1; i++) {
      const a = ids[i], b = ids[i + 1]
      if (!vSegBlocked(x, pts[a].y, pts[b].y, obs)) {
        const cost = Math.abs(pts[b].y - pts[a].y)
        adj[a].push(b, cost)
        adj[b].push(a, cost)
      }
    }
  }

  return { pts, idx, adj }
}

/* ─── A* with turn penalty ─── */

function astar(
  g: GridResult,
  startId: number,
  endId: number,
): number[] {
  const { pts, adj } = g
  const target = pts[endId]
  const N = pts.length

  // state = nodeId * 3 + dir  (dir: 0=start, 1=H, 2=V)
  const stateCount = N * 3
  const gScore = new Float64Array(stateCount).fill(Infinity)
  const parent = new Int32Array(stateCount).fill(-1)
  const closed = new Uint8Array(stateCount)

  const h = (id: number) => Math.abs(pts[id].x - target.x) + Math.abs(pts[id].y - target.y)

  const heap = new MinHeap()
  const s0 = startId * 3
  gScore[s0] = 0
  heap.push(h(startId), startId, 0)

  let iter = 0
  while (heap.size > 0 && iter++ < 20000) {
    const cur = heap.pop()!
    const sid = cur.value * 3 + cur.dir
    if (closed[sid]) continue
    closed[sid] = 1

    if (cur.value === endId) {
      const path: number[] = []
      let s = sid
      while (s >= 0) {
        path.push(Math.floor(s / 3))
        s = parent[s]
      }
      path.reverse()
      return path
    }

    const edges = adj[cur.value]
    for (let e = 0; e < edges.length; e += 2) {
      const nb = edges[e], cost = edges[e + 1]
      const dx = pts[nb].x - pts[cur.value].x
      const dy = pts[nb].y - pts[cur.value].y
      const ndir = Math.abs(dx) > 0.5 ? 1 : 2
      const turn = (cur.dir !== 0 && cur.dir !== ndir) ? TURN_PENALTY : 0
      const ng = gScore[sid] + cost + turn
      const ns = nb * 3 + ndir

      if (ng < gScore[ns]) {
        gScore[ns] = ng
        parent[ns] = sid
        heap.push(ng + h(nb), nb, ndir)
      }
    }
  }

  return []
}

/* ─── Path simplification ─── */

function simplify(pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts
  const out: Vec2[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], curr = pts[i], next = pts[i + 1]
    const colX = Math.abs(prev.x - curr.x) < 0.5 && Math.abs(curr.x - next.x) < 0.5
    const colY = Math.abs(prev.y - curr.y) < 0.5 && Math.abs(curr.y - next.y) < 0.5
    if (!colX && !colY) out.push(curr)
  }
  out.push(pts[pts.length - 1])
  return out
}

/* ─── Shared-trunk merging (output side) ─── */

/**
 * When multiple links leave the same output port, route them as a tree:
 * shared horizontal trunk → vertical bus → individual branches.
 */
function mergeSharedOutputPaths(
  paths: Map<string, Vec2[]>,
  allLinks: { link: Link; from: Vec2; to: Vec2 }[],
  obstacles: AABB[],
  nodeObstacleIdx: Map<string, number>,
): void {
  const groups = new Map<string, typeof allLinks>()
  for (const fl of allLinks) {
    const key = `${fl.link.from_node}:${fl.link.from_slot}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(fl)
  }

  const TRUNK_MIN = STUB * 2

  for (const [, group] of groups) {
    if (group.length <= 1) continue

    const src = group[0].from
    const srcNodeId = group[0].link.from_node

    const srcObsIdx = nodeObstacleIdx.get(srcNodeId)
    const filteredObs = obstacles.filter((_, i) => i !== srcObsIdx)

    const srcStubX = safeStubX(src.x, src.y, STUB, filteredObs)

    const dests = group.map(fl => {
      const destObsIdx = nodeObstacleIdx.get(fl.link.to_node)
      const destObs = obstacles.filter((_, i) => i !== destObsIdx)
      return {
        linkId: fl.link.id,
        to: fl.to,
        stubToX: safeStubX(fl.to.x, fl.to.y, -STUB, destObs),
        toNodeId: fl.link.to_node,
      }
    }).sort((a, b) => a.to.y - b.to.y)

    const minDestStubX = Math.min(...dests.map(d => d.stubToX))
    const midX = (srcStubX + minDestStubX) / 2
    let junctionX = Math.max(srcStubX + TRUNK_MIN, Math.min(midX, minDestStubX - STUB))

    for (let tries = 0; tries < 10; tries++) {
      if (!filteredObs.some(o => inside(o, junctionX, src.y))) break
      junctionX += 20
    }

    const groupDestIds = new Set(dests.map(d => d.toNodeId))

    for (const dest of dests) {
      const checkObs = obstacles.filter((_, i) => {
        const nodeId = [...nodeObstacleIdx.entries()].find(([, idx]) => idx === i)?.[0]
        if (nodeId === srcNodeId) return false
        if (nodeId === dest.toNodeId) return false
        if (nodeId && groupDestIds.has(nodeId)) return false
        return true
      })
      const busTop = Math.min(src.y, dest.to.y)
      const busBot = Math.max(src.y, dest.to.y)
      const vBlocked = vSegBlocked(junctionX, busTop, busBot, checkObs)
      const hTrunk = hSegBlocked(src.y, srcStubX, junctionX, checkObs)
      const hBranch = hSegBlocked(dest.to.y, junctionX, dest.stubToX, checkObs)
      const hStub = hSegBlocked(dest.to.y, dest.stubToX, dest.to.x, checkObs)

      if (vBlocked || hTrunk || hBranch || hStub) continue

      const path: Vec2[] = [
        src,
        { x: junctionX, y: src.y },
        { x: junctionX, y: dest.to.y },
        { x: dest.stubToX, y: dest.to.y },
        dest.to,
      ]
      paths.set(dest.linkId, path)
    }
  }
}

/* ─── Input-bus merging (input side) ─── */

/**
 * When multiple links arrive at the same destination NODE (different input
 * slots), converge them onto a shared vertical bus before the node.
 * Preserves A*-computed obstacle avoidance for the first part of each path;
 * only the approach segment (bus → destination) is rewritten.
 */
function mergeNodeInputBus(
  paths: Map<string, Vec2[]>,
  allLinks: { link: Link; from: Vec2; to: Vec2 }[],
  obstacles: AABB[],
  nodeObstacleIdx: Map<string, number>,
): void {
  const groups = new Map<string, typeof allLinks>()
  for (const fl of allLinks) {
    const key = fl.link.to_node
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(fl)
  }

  for (const [nodeId, group] of groups) {
    if (group.length <= 1) continue

    const dstObsIdx = nodeObstacleIdx.get(nodeId)
    const filteredObs = obstacles.filter((_, i) => i !== dstObsIdx)

    const minToX = Math.min(...group.map(fl => fl.to.x))
    let busX = minToX - STUB

    const allSlotYs = group.map(g => g.to.y)
    const centerY = (Math.min(...allSlotYs) + Math.max(...allSlotYs)) / 2
    for (let tries = 0; tries < 10; tries++) {
      if (!filteredObs.some(o => inside(o, busX, centerY))) break
      busX -= 20
    }

    group.sort((a, b) => a.to.y - b.to.y)

    for (const fl of group) {
      const { link, to } = fl
      const existingPath = paths.get(link.id)
      if (!existingPath || existingPath.length < 2) continue

      const srcObsIdx = nodeObstacleIdx.get(link.from_node)
      const checkObs = obstacles.filter((_, i) =>
        i !== dstObsIdx && i !== srcObsIdx,
      )

      let spliceIdx = -1
      for (let i = existingPath.length - 2; i >= 0; i--) {
        if (existingPath[i].x <= busX + 0.5) { spliceIdx = i; break }
      }
      if (spliceIdx < 0) continue

      const wp = existingPath[spliceIdx]
      const hToBus = Math.abs(wp.x - busX) > 0.5
        ? hSegBlocked(wp.y, wp.x, busX, checkObs)
        : false
      const vBus = Math.abs(wp.y - to.y) > 0.5
        ? vSegBlocked(busX, Math.min(wp.y, to.y), Math.max(wp.y, to.y), checkObs)
        : false
      const hToDst = hSegBlocked(to.y, busX, to.x, checkObs)

      if (hToBus || vBus || hToDst) continue

      const newPath = existingPath.slice(0, spliceIdx + 1)
      if (Math.abs(wp.x - busX) > 0.5) newPath.push({ x: busX, y: wp.y })
      if (Math.abs(wp.y - to.y) > 0.5) newPath.push({ x: busX, y: to.y })
      newPath.push(to)
      paths.set(link.id, simplify(newPath))
    }
  }
}

/* ─── Public API ─── */

/**
 * Route a single drag-preview wire from an output port to the cursor position,
 * avoiding all node obstacles. Lightweight variant of routeAllLinks.
 */
export function routeSingleDrag(
  nodes: NodeInstance[],
  fromNode: string,
  fromSlot: number,
  cursorPos: Vec2,
): Vec2[] {
  const routable = nodes.filter(n => !isNoteCardNode(n))
  const fn = nodes.find(n => n.id === fromNode)
  if (!fn || routable.length === 0) return [cursorPos]

  const from = linkAnchor(fn, fromSlot, 'out')
  const obstacles: AABB[] = routable.map(n => {
    const b = nodeDrawBounds(n)
    return { x: b.x - BUFFER, y: b.y - BUFFER, w: b.w + BUFFER * 2, h: b.h + BUFFER * 2 }
  })

  const outStub = staggeredStub(fromSlot)
  const sfx = safeStubX(from.x, from.y, outStub, obstacles)
  const stubFrom: Vec2 = { x: sfx, y: from.y }

  const inX = cursorPos.x - STUB
  const stx = obstacles.some(o => inside(o, inX, cursorPos.y)) ? cursorPos.x : inX
  const stubTo: Vec2 = { x: stx, y: cursorPos.y }

  const extraPts = [stubFrom, stubTo]
  const grid = buildGrid(obstacles, extraPts)
  const startId = grid.idx.get(`${stubFrom.x},${stubFrom.y}`)
  const endId = grid.idx.get(`${stubTo.x},${stubTo.y}`)

  if (startId === undefined || endId === undefined) {
    return buildObstacleAvoidingPath(from, cursorPos, obstacles)
  }

  const pathIds = astar(grid, startId, endId)
  if (pathIds.length === 0) {
    return buildObstacleAvoidingPath(from, cursorPos, obstacles)
  }

  return simplify([from, ...pathIds.map(id => ({ x: grid.pts[id].x, y: grid.pts[id].y })), cursorPos])
}

export function routeAllLinks(
  nodes: NodeInstance[],
  links: Link[],
  backLinks?: Set<string>,
): Map<string, Vec2[]> {
  resetAstarWarn()
  const result = new Map<string, Vec2[]>()
  const routable = nodes.filter(n => !isNoteCardNode(n))
  if (routable.length === 0) return result

  const nodeObsIdx = new Map<string, number>()
  const obstacles: AABB[] = routable.map((n, i) => {
    nodeObsIdx.set(n.id, i)
    const b = nodeDrawBounds(n)
    return { x: b.x - BUFFER, y: b.y - BUFFER, w: b.w + BUFFER * 2, h: b.h + BUFFER * 2 }
  })

  type FLInfo = { link: Link; from: Vec2; to: Vec2; stubFrom: Vec2; stubTo: Vec2 }
  const forwardLinks: FLInfo[] = []
  const backwardLinks: FLInfo[] = []

  for (const link of links) {
    const fn = nodes.find(n => n.id === link.from_node)
    const tn = nodes.find(n => n.id === link.to_node)
    if (!fn || !tn || isNoteCardNode(fn) || isNoteCardNode(tn)) continue

    const from = linkAnchor(fn, link.from_slot, 'out')
    const to = linkAnchor(tn, link.to_slot, 'in')
    const outStub = staggeredStub(link.from_slot)
    const inStub = staggeredStub(link.to_slot)
    const sfx = safeStubX(from.x, from.y, outStub, obstacles)
    const stx = safeStubX(to.x, to.y, -inStub, obstacles)
    const info: FLInfo = {
      link, from, to,
      stubFrom: { x: sfx, y: from.y },
      stubTo: { x: stx, y: to.y },
    }

    if (isBackwardLink(link, nodes, backLinks)) {
      backwardLinks.push(info)
    } else {
      forwardLinks.push(info)
    }
  }

  if (forwardLinks.length === 0 && backwardLinks.length === 0) return result

  const backwardLanes = computeBackwardLinkLanes(links, nodes, backLinks)
  const laneYValues = new Set<number>()
  for (const bl of backwardLinks) {
    const laneIndex = backwardLanes.get(bl.link.id) ?? 0
    laneYValues.add(backwardLoopDropY(routable, laneIndex))
  }

  const extraPts: Vec2[] = []
  for (const fl of [...forwardLinks, ...backwardLinks]) {
    extraPts.push(fl.stubFrom, fl.stubTo)
  }

  if (backwardLinks.length > 0) {
    const allXs = obstacles.flatMap(o => [o.x, o.x + o.w])
    for (const bottomLaneY of laneYValues) {
      for (const x of allXs) extraPts.push({ x, y: bottomLaneY })
      for (const bl of backwardLinks) {
        extraPts.push({ x: bl.stubFrom.x, y: bottomLaneY })
        extraPts.push({ x: bl.stubTo.x, y: bottomLaneY })
      }
    }
  }

  const grid = buildGrid(obstacles, extraPts)

  for (const fl of forwardLinks) {
    const { link, from, to, stubFrom, stubTo } = fl
    const srcIdx = nodeObsIdx.get(link.from_node)
    const dstIdx = nodeObsIdx.get(link.to_node)
    const routeObs = obstacles.filter((_, i) => i !== srcIdx && i !== dstIdx)

    const startId = grid.idx.get(`${stubFrom.x},${stubFrom.y}`)
    const endId = grid.idx.get(`${stubTo.x},${stubTo.y}`)
    if (startId === undefined || endId === undefined) {
      result.set(link.id, obstacleFallback(from, to, routeObs, `link ${link.id}`))
      continue
    }
    const pathIds = astar(grid, startId, endId)
    if (pathIds.length === 0) {
      result.set(link.id, obstacleFallback(from, to, routeObs, `link ${link.id}`))
      continue
    }
    result.set(link.id, simplify([from, ...pathIds.map(id => ({ x: grid.pts[id].x, y: grid.pts[id].y })), to]))
  }

  for (const fl of backwardLinks) {
    const { link, from, to, stubFrom, stubTo } = fl
    const laneIndex = backwardLanes.get(link.id) ?? 0
    const bottomLaneY = backwardLoopDropY(routable, laneIndex)

    const outDropKey = `${stubFrom.x},${bottomLaneY}`
    const inDropKey = `${stubTo.x},${bottomLaneY}`
    const outDropId = grid.idx.get(outDropKey)
    const inDropId = grid.idx.get(inDropKey)
    const startId = grid.idx.get(`${stubFrom.x},${stubFrom.y}`)
    const endId = grid.idx.get(`${stubTo.x},${stubTo.y}`)

    const srcIdx = nodeObsIdx.get(link.from_node)
    const dstIdx = nodeObsIdx.get(link.to_node)
    const routeObs = obstacles.filter((_, i) => i !== srcIdx && i !== dstIdx)

    if (startId === undefined || endId === undefined || outDropId === undefined || inDropId === undefined) {
      result.set(link.id, simplify([
        from, stubFrom,
        { x: stubFrom.x, y: bottomLaneY },
        { x: stubTo.x, y: bottomLaneY },
        stubTo, to,
      ]))
      continue
    }

    const legDown = astar(grid, startId, outDropId)
    const legAcross = astar(grid, outDropId, inDropId)
    const legUp = astar(grid, inDropId, endId)

    if (legDown.length === 0 || legAcross.length === 0 || legUp.length === 0) {
      warnAstarFallback(`backward link ${link.id}`)
      result.set(link.id, simplify([
        from, stubFrom,
        { x: stubFrom.x, y: bottomLaneY },
        { x: stubTo.x, y: bottomLaneY },
        stubTo, to,
      ]))
      continue
    }

    const pts: Vec2[] = [from]
    for (const id of legDown) pts.push({ x: grid.pts[id].x, y: grid.pts[id].y })
    for (let i = 1; i < legAcross.length; i++) pts.push({ x: grid.pts[legAcross[i]].x, y: grid.pts[legAcross[i]].y })
    for (let i = 1; i < legUp.length; i++) pts.push({ x: grid.pts[legUp[i]].x, y: grid.pts[legUp[i]].y })
    pts.push(to)
    result.set(link.id, simplify(pts))
  }

  mergeSharedOutputPaths(result, forwardLinks, obstacles, nodeObsIdx)
  mergeNodeInputBus(result, forwardLinks, obstacles, nodeObsIdx)

  return result
}

const PARALLEL_GAP = 6

/**
 * Offset parallel segments of DIFFERENT colors so they don't overlap.
 * Same-color wires stay stacked (they visually merge into one line).
 * colorOf: linkId → color string.
 */
export function offsetParallelSegments(
  paths: Map<string, Vec2[]>,
  colorOf: Map<string, string>,
): void {
  interface Seg {
    linkId: string
    color: string
    segIdx: number
    fromSlotY: number
    horizontal: boolean
    fixedCoord: number
    lo: number
    hi: number
  }

  const segs: Seg[] = []
  for (const [linkId, pts] of paths) {
    if (pts.length < 2) continue
    const fromY = pts[0].y
    const color = colorOf.get(linkId) ?? ''
    for (let i = 0; i < pts.length - 1; i++) {
      if (i === 0 || i === pts.length - 2) continue
      const a = pts[i], b = pts[i + 1]
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y)
      if (dx < 0.5 && dy < 0.5) continue
      if (dx < 0.5) {
        segs.push({ linkId, color, segIdx: i, fromSlotY: fromY, horizontal: false, fixedCoord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) })
      } else if (dy < 0.5) {
        segs.push({ linkId, color, segIdx: i, fromSlotY: fromY, horizontal: true, fixedCoord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
      }
    }
  }

  const groups: Seg[][] = []
  const used = new Uint8Array(segs.length)

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    const a = segs[i]
    const group = [a]
    used[i] = 1
    for (let j = i + 1; j < segs.length; j++) {
      if (used[j]) continue
      const b = segs[j]
      if (a.horizontal !== b.horizontal) continue
      if (Math.abs(a.fixedCoord - b.fixedCoord) > 0.5) continue
      const overlapLo = Math.max(a.lo, b.lo)
      const overlapHi = Math.min(a.hi, b.hi)
      if (overlapHi - overlapLo < 1) continue
      group.push(b)
      used[j] = 1
    }
    if (group.length > 1) groups.push(group)
  }

  for (const group of groups) {
    const distinctColors = new Set(group.map(s => s.color))
    if (distinctColors.size <= 1) continue

    group.sort((a, b) => a.fromSlotY - b.fromSlotY)

    const colorRanks = new Map<string, number>()
    let rank = 0
    for (const seg of group) {
      if (!colorRanks.has(seg.color)) colorRanks.set(seg.color, rank++)
    }
    const totalDistinct = colorRanks.size
    const mid = (totalDistinct - 1) / 2

    for (const seg of group) {
      const r = colorRanks.get(seg.color)!
      const offset = (r - mid) * PARALLEL_GAP
      if (Math.abs(offset) < 0.5) continue
      const pts = paths.get(seg.linkId)!
      if (seg.horizontal) {
        pts[seg.segIdx] = { x: pts[seg.segIdx].x, y: pts[seg.segIdx].y + offset }
        pts[seg.segIdx + 1] = { x: pts[seg.segIdx + 1].x, y: pts[seg.segIdx + 1].y + offset }
      } else {
        pts[seg.segIdx] = { x: pts[seg.segIdx].x + offset, y: pts[seg.segIdx].y }
        pts[seg.segIdx + 1] = { x: pts[seg.segIdx + 1].x + offset, y: pts[seg.segIdx + 1].y }
      }
    }
  }
}
