import type { Graph } from './graph'
import type { Link, NodeInstance } from './types'
import { deriveViewGraph } from './graph-groups'

export function buildCanvasRoutingNodes(graph: Graph): NodeInstance[] {
  if (!graph.groups?.length) return graph.nodes
  return deriveViewGraph(graph.nodes, graph.links, graph.groups).nodes
}

export function buildCanvasRoutingLinks(graph: Graph): Link[] {
  if (!graph.groups?.length) return graph.links
  return deriveViewGraph(graph.nodes, graph.links, graph.groups).links
}

export function buildCanvasViewGraph(graph: Graph) {
  return deriveViewGraph(graph.nodes, graph.links, graph.groups ?? [])
}
