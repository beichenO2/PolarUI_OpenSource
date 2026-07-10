import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suggestGroups, suggestionToGroup } from '../../src/engine/group-suggest.ts'
import { validateGroups } from '../../src/engine/graph-groups.ts'
import { loadWorkflowJson } from '../../src/engine/loader.ts'
import { bootstrapRegistryForTests } from './helpers/bootstrap-registry.ts'
import type { NodeInstance, Link } from '../../src/engine/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
bootstrapRegistryForTests()

function assertSuggestionQuality(
  nodes: NodeInstance[],
  links: Link[],
  suggestions: ReturnType<typeof suggestGroups>,
) {
  const nodeIds = new Set(nodes.map(n => n.id))
  for (const s of suggestions) {
    assert.ok(s.node_ids.length >= 3, `suggestion ${s.id} has <3 members`)
    for (const id of s.node_ids) assert.ok(nodeIds.has(id))
    assert.ok(
      s.internal_density >= s.external_density || s.external_edges === 0,
      `suggestion ${s.id}: internal density should exceed external`,
    )
  }
  const groups = suggestions.map(s => suggestionToGroup(s))
  assert.deepEqual(validateGroups(groups, nodes), [])
}

describe('group-suggest synthetic dense cluster', () => {
  const nodes: NodeInstance[] = [
    { id: 'a', class_type: 'Stub', x: 0, y: 0, width: 200, height: 180, params: {} },
    { id: 'b', class_type: 'Stub', x: 200, y: 0, width: 200, height: 180, params: {} },
    { id: 'c', class_type: 'Stub', x: 400, y: 0, width: 200, height: 180, params: {} },
    { id: 'd', class_type: 'Stub', x: 600, y: 0, width: 200, height: 180, params: {} },
    { id: 'ext', class_type: 'Stub', x: 800, y: 200, width: 200, height: 180, params: {} },
  ]
  const links: Link[] = [
    { id: '1', from_node: 'a', from_slot: 0, to_node: 'b', to_slot: 0 },
    { id: '2', from_node: 'b', from_slot: 0, to_node: 'c', to_slot: 0 },
    { id: '3', from_node: 'a', from_slot: 0, to_node: 'c', to_slot: 0 },
    { id: '4', from_node: 'c', from_slot: 0, to_node: 'd', to_slot: 0 },
    { id: '5', from_node: 'd', from_slot: 0, to_node: 'ext', to_slot: 0 },
  ]

  it('finds dense abc cluster with single external edge', () => {
    const suggestions = suggestGroups(nodes, links, {
      minMembers: 3,
      minInternalDensity: 0.2,
      minDensityRatio: 1.2,
    })
    assert.ok(suggestions.length >= 1)
    const hasAbc = suggestions.some(s =>
      s.node_ids.includes('a') && s.node_ids.includes('b') && s.node_ids.includes('c'),
    )
    assert.ok(hasAbc, 'expected dense abc cluster')
    assertSuggestionQuality(nodes, links, suggestions)
  })

  it('suggestions do not overlap', () => {
    const suggestions = suggestGroups(nodes, links)
    const seen = new Set<string>()
    for (const s of suggestions) {
      for (const id of s.node_ids) {
        assert.ok(!seen.has(id), `overlap on ${id}`)
        seen.add(id)
      }
    }
  })
})

describe('group-suggest dense-outreach fixture', () => {
  it('produces reasonable suggestions on dense synthetic workflow', () => {
    const raw = readFileSync(join(ROOT, 'tests/canvas/fixtures/dense-outreach.json'), 'utf8')
    const graph = loadWorkflowJson(raw)
    const suggestions = suggestGroups(graph.nodes, graph.links, {
      minMembers: 3,
      minInternalDensity: 0.15,
      minDensityRatio: 1.2,
    })
    console.log(`dense-outreach: ${suggestions.length} group suggestions`)
    for (const s of suggestions.slice(0, 5)) {
      console.log(
        `  ${s.title}: ${s.node_ids.length} nodes, int=${s.internal_edges} ext=${s.external_edges} dens=${s.internal_density.toFixed(2)}`,
      )
    }
    assertSuggestionQuality(graph.nodes, graph.links, suggestions)
  })
})
