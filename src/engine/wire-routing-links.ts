import type { Graph } from './graph'
import type { Link } from './types'
import type { MaterializedLink } from './lg-canvas-utils'
import { buildLgCanvasRoutingLinks } from './lg-canvas-utils'

export interface CanvasRoutingContext {
  materializedLinks?: MaterializedLink[]
  replayStep?: number | null
}

export function buildCanvasRoutingLinks(graph: Graph, ctx: CanvasRoutingContext = {}): Link[] {
  if (graph.library === 'LG') {
    return buildLgCanvasRoutingLinks(
      graph.links,
      graph.lgEdges,
      ctx.materializedLinks ?? [],
      ctx.replayStep ?? null,
    )
  }
  return graph.links
}
