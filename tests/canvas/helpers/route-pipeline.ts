/**
 * Mirrors canvas.ts recomputeRouting — pure routing pipeline for tests.
 */
import type { NodeInstance, Link } from '../../../src/engine/types'
import type { Vec2 } from '../../../src/engine/node-geometry'
import { routeAllLinks, offsetParallelSegments } from '../../../src/engine/wire-router'
import { nudgeParallelSegments } from '../../../src/engine/wire-nudge'
import { detectCrossings } from '../../../src/engine/wire-crossings'
import { buildLinkColorMaps } from '../../../src/engine/wire-colors'

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

  const colorOf = new Map<string, string>()
  const colorMaps = buildLinkColorMaps(links, nodes, backLinks, undefined, crossings, paths)
  for (const link of links) {
    colorOf.set(
      link.id,
      colorMaps.forwardByLink.get(link.id)
        ?? colorMaps.backwardByLink.get(link.id)
        ?? '',
    )
  }

  offsetParallelSegments(paths, colorOf)
  const nudged = nudgeParallelSegments(paths)

  return { paths: nudged, crossings }
}
