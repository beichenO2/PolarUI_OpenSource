/**
 * Mirrors canvas.ts recomputeRouting — pure routing pipeline for tests.
 */
import type { NodeInstance, Link } from '../../../src/engine/types'
import type { Vec2 } from '../../../src/engine/node-geometry'
import { routeAllLinks, offsetParallelSegments } from '../../../src/engine/wire-router'
import { nudgeParallelSegments } from '../../../src/engine/wire-nudge'
import { detectCrossings } from '../../../src/engine/wire-crossings'
import { buildLinkColorMaps, buildRoutingOffsetColorMap } from '../../../src/engine/wire-colors'

export interface RoutedGraph {
  paths: Map<string, Vec2[]>
  crossings: ReturnType<typeof detectCrossings>
}

export function routeGraphWires(
  nodes: NodeInstance[],
  links: Link[],
  backLinks?: Set<string>,
): RoutedGraph {
  const paths = routeAllLinks(nodes, links, backLinks)
  const crossings = detectCrossings(paths)

  const colorOf = buildRoutingOffsetColorMap(links, nodes, backLinks, crossings, paths)

  offsetParallelSegments(paths, colorOf)
  const nudged = nudgeParallelSegments(paths)

  return { paths: nudged, crossings }
}
