import type { Graph } from './graph'
import type { Link } from './types'

export function buildCanvasRoutingLinks(graph: Graph): Link[] {
  return graph.links
}
