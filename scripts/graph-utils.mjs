/**
 * Shared helpers for reading .lg.json workflow graphs.
 *
 * Supports both graph shapes:
 * - numbered-key format (current): top-level keys "1","2","2a"… → node objects
 *   with class_type; meta keys start with "_" (_lg_edges, _state_schema…)
 * - legacy array format: { nodes: [{ class_type, … }] }
 */

/**
 * @param {object} lgGraph
 * @returns {Array<{ id: string, class_type?: string }>}
 */
export function graphNodes(lgGraph) {
  if (!lgGraph || typeof lgGraph !== 'object') return [];
  if (Array.isArray(lgGraph.nodes) && lgGraph.nodes.length > 0) {
    return lgGraph.nodes.map((n, i) => ({ id: String(n.id ?? i), ...n }));
  }
  const nodes = [];
  for (const [key, value] of Object.entries(lgGraph)) {
    if (key.startsWith('_')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nodes.push({ id: key, ...value });
    }
  }
  return nodes;
}

/**
 * Sorted unique class_type list for a graph.
 * @param {object} lgGraph
 * @returns {string[]}
 */
export function graphNodeTypes(lgGraph) {
  const types = new Set();
  for (const n of graphNodes(lgGraph)) {
    if (typeof n.class_type === 'string' && n.class_type) types.add(n.class_type);
  }
  return [...types].sort();
}

export default { graphNodes, graphNodeTypes };
