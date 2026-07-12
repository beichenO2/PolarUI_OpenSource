#!/usr/bin/env node
/**
 * ADR-014 headless e2e — StemCell + PetriDish against REAL claude-code workflow.
 * In-memory mutations only; claude-code.json on disk and registry stay untouched.
 * Mock LLM: POLARUI_MOCK_LLM=1, POLARUI_MOCK_LLM_BRANCH=finish
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { loadHeadlessEngine } from '../lib/headless-engine.mjs';
import { savePetriResult } from '../lib/save-petri-result.mjs';

const POLARUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_CODE_PATH = join(POLARUI_ROOT, 'workflows', 'claude-code', 'claude-code.json');
const EVOLVE_DIR = join(POLARUI_ROOT, 'workflows', 'evolve-demo');

const BROKEN_CLASS = 'EvolveProbeBroken';

process.env.POLARUI_MOCK_LLM = '1';
process.env.POLARUI_MOCK_LLM_BRANCH = 'finish';

function fail(label, detail) {
  console.error(`FAIL ${label}: ${detail}`);
  process.exit(1);
}

/** Replace edge from→to with from→via→to on the stepwise path. */
function spliceLgEdge(edges, from, via, to) {
  const next = edges.filter((e) => !(e.from === from && e.to === to));
  next.push({ from, to: via, kind: 'static' });
  next.push({ from: via, to, kind: 'static' });
  return next;
}

function graphToSlaveWorkflow(graph) {
  const wf = graph.toWorkflow();
  wf._entry = graph.lgEntry ?? '1';
  wf._lg_edges = graph.lgEdges ? [...graph.lgEdges] : [];
  return wf;
}

async function loadClaudeCodeGraph() {
  if (!existsSync(CLAUDE_CODE_PATH)) {
    fail('setup', `missing ${CLAUDE_CODE_PATH}`);
  }
  const raw = readFileSync(CLAUDE_CODE_PATH, 'utf8');
  const { parseWorkflow } = await loadHeadlessEngine();
  return parseWorkflow(raw);
}

function addNode(graph, { id, class_type, params, x = 0, y = 0 }) {
  graph.nodes.push({
    id,
    class_type,
    x,
    y,
    width: 220,
    height: 100,
    params,
  });
}

function buildStemCellClaudeGraph(base) {
  const graph = base;
  const stemId = 'sc_demo';
  const annotId = 'evo_annot';

  addNode(graph, {
    id: stemId,
    class_type: 'StemCell',
    params: {
      allowed_types: 'StaticData,Output,StemCell',
      allow_graph_edit: true,
      max_mutations: 8,
      state: { evolve_demo: true },
      differentiation_signal: {
        materialize: 'StaticData',
        node_id: annotId,
        params: { value: 'evolve-claude-annotation', type: 'string' },
        wire_from: stemId,
        wire_to: '5',
      },
    },
  });

  graph.lgEdges = spliceLgEdge(graph.lgEdges ?? [], '4', stemId, '5');
  return graph;
}

/** Petri slave: score StemCell on finish path + gate StaticData for breakable candidate. */
function buildPetriClaudeSlave(base) {
  const graph = base;
  const gateId = 'petri_gate';
  const scoreId = 'petri_sc';

  addNode(graph, {
    id: gateId,
    class_type: 'StaticData',
    params: { value: 'petri-gate-ok', type: 'string' },
  });
  addNode(graph, {
    id: scoreId,
    class_type: 'StemCell',
    params: {
      allow_graph_edit: false,
      state: { score: 1 },
    },
  });

  graph.lgEdges = spliceLgEdge(graph.lgEdges ?? [], '5', gateId, '6');
  graph.lgEdges = spliceLgEdge(graph.lgEdges, '6', scoreId, '7');
  return graph;
}

async function runStemCellClaudeDemo() {
  const base = await loadClaudeCodeGraph();
  const graph = buildStemCellClaudeGraph(base);
  const { executeGraph } = await loadHeadlessEngine();

  const result = await executeGraph(graph, {
    externalInputs: { message: 'evolve-claude stemcell demo' },
    runContext: {
      conversation_id: 'evolve-claude-stem',
      message: 'evolve-claude stemcell demo',
    },
    role: 'master',
  });

  const unhealthy = result.unhealthy_nodes ?? [];
  if (unhealthy.length) {
    fail('stemcell-claude', `engine unhealthy: ${JSON.stringify(unhealthy)}`);
  }

  const traces = result.runTrace?.node_traces?.map((t) => t.class_type) ?? [];
  if (!traces.includes('StemCell')) fail('stemcell-claude', `missing StemCell trace: ${JSON.stringify(traces)}`);
  if (!traces.includes('StaticData')) {
    fail('stemcell-claude', `materialized StaticData not executed: ${JSON.stringify(traces)}`);
  }
  if (!traces.includes('Output')) fail('stemcell-claude', `missing Output trace: ${JSON.stringify(traces)}`);

  const stemIdx = traces.indexOf('StemCell');
  const staticTraces = traces
    .map((c, i) => (c === 'StaticData' ? i : -1))
    .filter((i) => i >= 0);
  const annotIdx = staticTraces.find((i) => i > stemIdx);
  if (annotIdx == null || annotIdx <= stemIdx) {
    fail('stemcell-claude', 'materialized StaticData must run after StemCell');
  }

  let stemOut = null;
  let annotData = undefined;

  if (result.results instanceof Map) {
    for (const [nodeId, nodeResult] of result.results) {
      const outs = nodeResult?.outputs ?? {};
      if (outs.graph_edit_granted === true) stemOut = { ...outs, node_id: outs.node_id ?? nodeId };
      if (outs.data === 'evolve-claude-annotation') annotData = outs.data;
    }
  }

  if (!stemOut?.graph_edit_granted) {
    fail('stemcell-claude', `graph_edit_granted !== true: ${JSON.stringify(stemOut)}`);
  }
  if (stemOut.materialized_class !== 'StaticData') {
    fail('stemcell-claude', `materialized_class !== StaticData: ${JSON.stringify(stemOut.materialized_class)}`);
  }
  if (annotData !== 'evolve-claude-annotation') {
    fail('stemcell-claude', `annotation data mismatch: ${JSON.stringify(annotData)}`);
  }

  const summary = {
    graph_edit_granted: stemOut.graph_edit_granted,
    materialized_class: stemOut.materialized_class,
    node_id: stemOut.node_id,
    annotation_data: annotData,
    node_traces: traces,
    merged_has_branch: typeof result.merged_output === 'object' && result.merged_output != null
      ? (result.merged_output).branch
      : undefined,
  };
  console.log('PASS stemcell-claude:', JSON.stringify(summary, null, 2));
  return summary;
}

async function runPetriClaudeDemo() {
  const base = await loadClaudeCodeGraph();
  const slaveGraph = buildPetriClaudeSlave(base);
  const slaveWf = graphToSlaveWorkflow(slaveGraph);

  const petriDef = {
    id: 'petri-claude-demo',
    name: 'petri-claude-demo',
    nodes: [
      {
        id: '1',
        class_type: 'PetriDish',
        x: 0,
        y: 0,
        width: 260,
        height: 120,
        params: {
          slave_workflow: 'claude-code/claude-code',
          allow_graph_edit: true,
          evolution_signal: {
            slave_inline: slaveWf,
            candidates: [
              [
                { op: 'remove_node', node_id: 'petri_gate' },
                {
                  op: 'add_node',
                  node: { class_type: BROKEN_CLASS, id: 'petri_gate', params: {} },
                },
              ],
              [{ op: 'set_param', node_id: 'petri_sc', key: 'state', value: { score: 3 } }],
              [{ op: 'set_param', node_id: 'petri_sc', key: 'state', value: { score: 10 } }],
            ],
          },
        },
      },
    ],
    links: [],
    created_at: 1,
    updated_at: 1,
  };

  const { executeGraph, parseWorkflow } = await loadHeadlessEngine();
  const graph = parseWorkflow(JSON.stringify(petriDef));
  const result = await executeGraph(graph, {
    externalInputs: { message: 'evolve-claude petri demo' },
    runContext: {
      conversation_id: 'evolve-claude-petri',
      message: 'evolve-claude petri demo',
    },
  });

  const outputs = {};
  if (result.results instanceof Map) {
    for (const [nodeId, nodeResult] of result.results) {
      outputs[nodeId] = nodeResult;
    }
  }

  const unhealthy = result.unhealthy_nodes ?? [];
  if (unhealthy.length) {
    fail('petri-claude', `petri host unhealthy: ${JSON.stringify(unhealthy)}`);
  }

  let petriOut = null;
  for (const nodeResult of Object.values(outputs)) {
    const outs = nodeResult?.outputs ?? {};
    if ('refined_workflow' in outs) {
      petriOut = outs;
      break;
    }
  }
  if (!petriOut?.refined_workflow) fail('petri-claude', 'missing refined_workflow output');
  if (petriOut.applied !== false) fail('petri-claude', `applied must be false: ${petriOut.applied}`);

  const evaluations = petriOut.evaluations ?? [];
  if (!Array.isArray(evaluations) || evaluations.length !== 3) {
    fail('petri-claude', `expected 3 evaluations: ${JSON.stringify(evaluations)}`);
  }

  const broken = evaluations[0];
  if (broken?.ok !== false) {
    fail('petri-claude', `candidate 0 must fail (broken gate): ${JSON.stringify(broken)}`);
  }
  if (!evaluations[1]?.ok || !evaluations[2]?.ok) {
    fail('petri-claude', `candidates 1–2 must ok: ${JSON.stringify(evaluations)}`);
  }
  if (evaluations[1].score !== 3 || evaluations[2].score !== 10) {
    fail('petri-claude', `unexpected scores: ${JSON.stringify(evaluations.map((e) => e.score))}`);
  }

  const bestIdx = evaluations.reduce(
    (best, e, i) => (e.ok && (e.score ?? 0) > (evaluations[best].score ?? 0) ? i : best),
    0,
  );
  if (bestIdx !== 2) {
    fail('petri-claude', `best candidate should be index 2: ${JSON.stringify(evaluations)}`);
  }

  const refinedScoreNode = petriOut.refined_workflow?.nodes?.find((n) => n.id === 'petri_sc');
  const refinedScore = refinedScoreNode?.params?.state?.score;
  if (refinedScore !== 10) {
    fail('petri-claude', `refined workflow must pick score-10 candidate: ${JSON.stringify(refinedScore)}`);
  }

  const savedPath = savePetriResult(petriOut.refined_workflow, 'refined-claude', EVOLVE_DIR);
  if (!existsSync(savedPath)) fail('petri-claude', `savePetriResult did not write ${savedPath}`);
  if (!savedPath.endsWith('refined-claude.petri.json')) {
    fail('petri-claude', `unexpected save path: ${savedPath}`);
  }

  const summary = {
    applied: petriOut.applied,
    evaluations,
    winning_candidate: 2,
    refined_score: refinedScore,
    saved_path: savedPath,
    scoring: 'petri_sc StemCell emits state.score on lg path; extractNumericScore reads merged_output.score',
    human_gate: 'refined-claude.petri.json is human-review only — excluded from registry',
  };
  console.log('PASS petri-claude:', JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  console.log('=== ADR-014 evolve-claude-demo (real claude-code, mock LLM) ===\n');
  await runStemCellClaudeDemo();
  console.log('');
  await runPetriClaudeDemo();
  console.log('\nevolve-claude-demo: all passed');
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
