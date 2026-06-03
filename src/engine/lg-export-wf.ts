/**
 * LG Run materialized_graph → frozen WF JSON（08 §3.4 Export → WF）
 */
import type { Graph } from './graph'
import type { LGRunResult } from './lg-runner'

export function materializedToWorkflowJson(
  spec: Graph,
  materialized: LGRunResult['materialized_graph'],
  name = `${spec.name} (exported)`,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    _name: name,
    _library: 'WF',
    _exported_from: 'LGRunExportWF',
    _source_spec: spec.name,
  }

  const seen = new Set<string>()
  let idx = 1
  const idMap = new Map<string, string>()

  for (const nid of materialized.nodes) {
    if (seen.has(nid)) continue
    seen.add(nid)
    const specNode = spec.nodes.find(n => n.id === nid)
    const newId = String(idx++)
    idMap.set(nid, newId)
    out[newId] = {
      class_type: specNode?.class_type ?? 'StaticData',
      inputs: {},
      params: { ...(specNode?.params ?? {}), _materialized_from: nid },
    }
  }

  let prev: string | null = null
  for (const nid of materialized.nodes) {
    const mapped = idMap.get(nid)
    if (!mapped) continue
    const node = out[mapped] as { inputs: Record<string, unknown> }
    if (prev && idMap.get(prev)) {
      node.inputs = { upstream: [idMap.get(prev), 0] }
    }
    prev = nid
  }

  return out
}
