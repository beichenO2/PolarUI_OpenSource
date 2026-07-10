import { loadHeadlessEngine } from './headless-engine.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '..');

/** @typedef {{ conversationId: string; message: string; files?: string[]; userId?: string }} RunInputs */

/**
 * Resolve workflow JSON path by id or explicit path.
 * @param {string} workflowId e.g. claude-code
 */
export function resolveWorkflowPath(workflowId) {
  const candidates = [
    join(POLARUI_ROOT, 'workflows', workflowId, `${workflowId}.json`),
    join(POLARUI_ROOT, 'dist/workflows', `${workflowId}.json`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`workflow not found: ${workflowId}`);
}

/**
 * Execute a PolarUI workflow graph (Harness = workflow .json).
 * @param {{ workflowId?: string; workflowPath?: string; inputs: RunInputs }} opts
 */
export async function runWorkflowGraph(opts) {
  const { executeGraph, parseWorkflow } = await loadHeadlessEngine();
  const path = opts.workflowPath ?? resolveWorkflowPath(opts.workflowId ?? '');
  const raw = readFileSync(path, 'utf8');
  const graph = parseWorkflow(raw);

  const { conversationId, message, files = [], userId, memory } = opts.inputs;
  const externalInputs = {
    conversation_id: conversationId,
    message,
    files: files.join(','),
    user_id: userId ?? '',
    memory: memory ?? {},
    memory_snapshot: memory ?? {},
  };

  const result = await executeGraph(graph, {
    externalInputs,
    runContext: {
      conversationId,
      message,
      files,
      userId,
      memory: memory ?? {},
    },
    role: 'master',
  });

  const outputs = {};
  if (result.results instanceof Map) {
    for (const [nodeId, nodeResult] of result.results) {
      outputs[nodeId] = nodeResult;
    }
  }

  const trace = result.runTrace ?? null;
  const nodeTraces = trace?.node_traces?.map((t) => t.class_type) ?? [];

  return {
    ok: !result.unhealthy_nodes?.length,
    merged_output: result.merged_output,
    outputs,
    node_traces: nodeTraces,
    run_trace: trace,
    unhealthy_nodes: result.unhealthy_nodes ?? [],
    workflow_path: path,
  };
}

export default runWorkflowGraph;
