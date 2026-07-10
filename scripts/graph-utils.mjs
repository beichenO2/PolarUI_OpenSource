/**
 * Shared helpers for reading workflow graph JSON (.json only).
 *
 * Supports both graph shapes:
 * - numbered-key format (current): top-level keys "1","2","2a"… → node objects
 *   with class_type; meta keys start with "_" (_lg_edges, _state_schema…)
 * - legacy array format: { nodes: [{ class_type, … }] }
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} graph
 * @returns {Array<{ id: string, class_type?: string }>}
 */
export function graphNodes(graph) {
  if (!graph || typeof graph !== 'object') return [];
  if (Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    return graph.nodes.map((n, i) => ({ id: String(n.id ?? i), ...n }));
  }
  const nodes = [];
  for (const [key, value] of Object.entries(graph)) {
    if (key.startsWith('_')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nodes.push({ id: key, ...value });
    }
  }
  return nodes;
}

/**
 * Sorted unique class_type list for a graph.
 * @param {object} graph
 * @returns {string[]}
 */
export function graphNodeTypes(graph) {
  const types = new Set();
  for (const n of graphNodes(graph)) {
    if (typeof n.class_type === 'string' && n.class_type) types.add(n.class_type);
  }
  return [...types].sort();
}

/**
 * Resolve workflow graph file: `{id}.json` only.
 * @param {string} workflowDir
 * @param {string} workflowId
 * @returns {string | null}
 */
export function resolveWorkflowGraphPath(workflowDir, workflowId) {
  const p = join(workflowDir, `${workflowId}.json`);
  return existsSync(p) ? p : null;
}

export default { graphNodes, graphNodeTypes, resolveWorkflowGraphPath };
