# Wire Routing — Initial Invariant Baseline (2026-07-10)

Test runner: `node --import tsx --test tests/canvas/wire-routing.test.ts`

Routing pipeline under test mirrors `canvas.ts` → `routeAllLinks` + `offsetParallelSegments` + `nudgeParallelSegments`.

## Entry points & data structures

| Function | File | Input | Output |
|----------|------|-------|--------|
| `routeAllLinks(nodes, links, backLinks?)` | `src/engine/wire-router.ts` | Node geometry + links | `Map<linkId, Vec2[]>` waypoints |
| `offsetParallelSegments(paths, colorOf)` | `src/engine/wire-router.ts` | Paths + per-link color | Mutates paths (different-color nudge ±6px) |
| `nudgeParallelSegments(paths)` | `src/engine/wire-nudge.ts` | Paths | New Map (parallel overlap nudge ±14px) |
| `buildFallbackPath(from, to)` | `src/engine/wire-path.ts` | Port anchors | L-shaped orthogonal path (no obstacle avoidance) |

Obstacle margin: `DEFAULT_WIRE_ROUTING_OPTIONS.shapeBufferDistance` = **16px**.

## Baseline violation counts (pre-fix)

| Fixture | Nodes | Links | I1 | I2 | I3 | I4 | I5 |
|---------|-------|-------|----|----|----|----|-----|
| linear-3 | 3 | 2 | 0 | 0 | — | — | 0 |
| fan-out-6 | 7 | 6 | **5** | 0 | 0 | — | 0 |
| react-3-loops | 5 | 7 | 0 | 0 | — | 0 | 0 |
| dense-corridor | 7 | 1 | **1** | 0 | — | — | 0 |
| taoci-outreach | 21 | 26 | 0 | 0 | — | — | 0 |
| hermes | 27 | 38 | **4** | 0 | — | 0 | 0 |

Crossings (informational): taoci **22**, hermes **70**.

## Red items → fix mapping

| ID | Invariant | Symptom | Root cause | Planned fix |
|----|-----------|---------|------------|-------------|
| (b) | I1 fan-out-6, dense-corridor, hermes | Segments pierce node bbox | A* iter cap 20k → silent `buildFallbackPath` (no obstacle avoidance) | Perimeter fallback + `console.warn` |
| (b) | I1 fan-out-6 | Horizontal approach through sibling dst nodes | `mergeSharedOutputPaths` / `mergeNodeInputBus` defined but **never called** | Wire into `routeAllLinks` |
| (a) | — (interaction) | Stale wires while dragging | `routeValid=false` on mousemove, recompute only on mouseup | rAF incremental `recomputeRouting` during drag |
| (c) | I4 (hermes todo) | ReAct back-edges stack on shared bottom Y | Single `bottomLaneY` for all backward links | `computeBackwardLinkLanes` + layered Y offset |
| (d) | I3 (latent on dense fan-out) | Same-color wires fully overlap | `offsetParallelSegments` skips same-color; nudge not in canvas pipeline | Force nudge on full overlap; call nudge in canvas |

## Skipped / todo tests (QA unblocked) — RESOLVED 2026-07-10

All former red items fixed; `npm run test:canvas` green without skip/todo on I1/I4.

## Post-fix metrics (`npm run stats:canvas`)

| Fixture | nodeCrossings | fullOverlaps | crossings |
|---------|---------------|--------------|-----------|
| linear-3 | 0 | 0 | 0 |
| fan-out-6 | 0 | 0 | 6 |
| react-3-loops | 0 | 0 | 3 |
| dense-corridor | 0 | 0 | 0 |
| taoci-outreach | 0 | 0 | 21 |
| hermes | 0 | 0 | 78 |
