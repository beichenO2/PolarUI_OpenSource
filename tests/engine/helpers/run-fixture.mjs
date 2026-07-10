import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetHeadlessEngine } from '../../../lib/headless-engine.mjs';
import { resetMockRegistration } from '../../../lib/test-mocks/register.mjs';

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

/** @param {Record<string, string | undefined>} [env] */
export function clearMockEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('POLARUI_') || key === 'TAOCI_MOCK_LLM') {
      delete process.env[key];
    }
  }
}

/** @param {Record<string, string | undefined>} [env] */
export function applyMockEnv(env = {}) {
  clearMockEnv();
  Object.assign(process.env, env);
}

export function loadFixture(name) {
  const path = join(FIXTURES_ROOT, name);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Execute a workflow fixture through the headless engine.
 * @param {string | object} fixture filename under fixtures/ or raw graph object
 * @param {{ env?: Record<string, string | undefined>; inputs?: Record<string, unknown> }} [opts]
 */
export async function runFixture(fixture, opts = {}) {
  applyMockEnv(opts.env);
  resetHeadlessEngine();
  resetMockRegistration();

  const { loadHeadlessEngine } = await import('../../../lib/headless-engine.mjs');
  const { executeGraph, parseWorkflow } = await loadHeadlessEngine();

  const raw = typeof fixture === 'string' ? loadFixture(fixture) : fixture;
  const graph = parseWorkflow(JSON.stringify(raw));

  const conversationId = String(opts.inputs?.conversationId ?? `engine-${Date.now()}`);
  const message = String(opts.inputs?.message ?? 'engine smoke');
  const result = await executeGraph(graph, {
    externalInputs: {
      conversation_id: conversationId,
      message,
      files: '',
      user_id: '',
      memory: {},
      ...opts.inputs,
    },
    runContext: {
      conversationId,
      message,
      files: [],
      userId: '',
      memory: {},
      ...opts.inputs,
    },
    role: 'master',
  });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const traces = (result.runTrace?.node_traces ?? []).map((t) => ({
    nodeId: t.node_id,
    classType: t.class_type,
    skipped: t.skipped,
    loopIndex: t.loop_index,
    outputs: result.results?.get?.(t.node_id)?.outputs,
  }));

  return {
    graph,
    result,
    traces,
    classTypes: traces.map((t) => t.classType),
    merged: result.merged_output,
    loopTraces: result.runTrace?.loop_traces ?? [],
    unhealthy: result.unhealthy_nodes ?? [],
    outputFor(classType) {
      const hit = traces.find((t) => t.classType === classType);
      return hit?.outputs;
    },
    nodeIdFor(classType, index = 0) {
      const nodes = graph.nodes.filter((n) => n.class_type === classType);
      return nodes[index]?.id;
    },
    contentFromOutput(classType, index = 0) {
      const id = this.nodeIdFor(classType, index);
      return id ? result.results?.get?.(id)?.outputs?.content : undefined;
    },
    ran(classType) {
      return traces.some((t) => t.classType === classType && !t.skipped);
    },
    runCount(classType) {
      return traces.filter((t) => t.classType === classType && !t.skipped).length;
    },
    nodeById,
  };
}
