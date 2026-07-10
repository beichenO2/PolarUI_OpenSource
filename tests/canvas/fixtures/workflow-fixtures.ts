/**
 * Build dense canvas fixtures from inlined synthetic graphs (ADR-011 P2).
 * Does not depend on archived registered workflows.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflowJson, computeBackLinks } from '../../../src/engine/loader'
import { applyAutoLayout } from '../../../src/engine/auto-layout'
import type { NodeInstance, Link } from '../../../src/engine/types'
import { bootstrapRegistryForTests } from '../helpers/bootstrap-registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

bootstrapRegistryForTests()

function loadDense(name: string): {
  nodes: NodeInstance[]
  links: Link[]
  backLinks: Set<string>
} {
  const raw = readFileSync(join(HERE, name), 'utf8')
  const graph = loadWorkflowJson(raw)
  applyAutoLayout(graph, { direction: 'LR', fixOverlaps: true })
  const backLinks = computeBackLinks(graph)
  return {
    nodes: graph.nodes,
    links: graph.links,
    backLinks,
  }
}

/** Dense outreach-shaped graph (archived taoci-outreach snapshot, test-only). */
export function loadTaociDenseFixture() {
  return loadDense('dense-outreach.json')
}

/** Hermes ReAct-shaped graph (dist snapshot, test-only). */
export function loadHermesReactFixture() {
  return loadDense('hermes-react.json')
}
