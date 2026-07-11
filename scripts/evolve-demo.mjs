#!/usr/bin/env node
/**
 * ADR-014 R10 headless e2e — StemCell stepwise + PetriDish candidate selection.
 * No registry-entry.json; does not touch claude-code workflow.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { runWorkflowGraph } from '../lib/run-graph.mjs';
import { loadHeadlessEngine } from '../lib/headless-engine.mjs';
import { savePetriResult } from '../lib/save-petri-result.mjs';

const POLARUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVOLVE_DIR = join(POLARUI_ROOT, 'workflows', 'evolve-demo');

function fail(label, detail) {
  console.error(`FAIL ${label}: ${detail}`);
  process.exit(1);
}

function findOutputsByClass(result, classType) {
  for (const nodeResult of Object.values(result.outputs ?? {})) {
    const outs = nodeResult?.outputs ?? {};
    if (classType === 'StemCell' && 'graph_edit_granted' in outs) return outs;
    if (classType === 'PetriDish' && 'refined_workflow' in outs) return outs;
  }
  return null;
}

async function runStemCellDemo() {
  const path = join(EVOLVE_DIR, 'stemcell-demo.json');
  const result = await runWorkflowGraph({
    workflowPath: path,
    inputs: {
      conversationId: `evolve-stem-${Date.now()}`,
      message: 'stemcell headless demo',
    },
  });

  if (!result.ok) {
    fail('stemcell', `engine unhealthy: ${JSON.stringify(result.unhealthy_nodes)}`);
  }

  const traces = result.node_traces ?? [];
  if (!traces.includes('StemCell')) fail('stemcell', `missing StemCell trace: ${JSON.stringify(traces)}`);
  if (!traces.includes('StaticData')) fail('stemcell', `materialized StaticData not executed: ${JSON.stringify(traces)}`);
  if (!traces.includes('Output')) fail('stemcell', `missing Output trace: ${JSON.stringify(traces)}`);

  const stemIdx = traces.indexOf('StemCell');
  const staticIdx = traces.indexOf('StaticData');
  if (staticIdx <= stemIdx) fail('stemcell', 'StaticData must run after StemCell');

  let stemOut = null;
  let materializedId = '';
  let materializedData = undefined;

  for (const [nodeId, nodeResult] of Object.entries(result.outputs ?? {})) {
    const outs = nodeResult?.outputs ?? {};
    if (outs.graph_edit_granted === true) {
      stemOut = outs;
      materializedId = String(outs.node_id ?? '');
    }
    if (outs.data === 'evolve-stem-payload' && materializedData === undefined) {
      materializedData = outs.data;
      if (!materializedId) materializedId = nodeId;
    }
  }

  if (!stemOut) stemOut = findOutputsByClass(result, 'StemCell');
  if (!stemOut?.graph_edit_granted) fail('stemcell', `graph_edit_granted !== true: ${JSON.stringify(stemOut)}`);
  if (stemOut.materialized_class !== 'StaticData') {
    fail('stemcell', `materialized_class !== StaticData: ${JSON.stringify(stemOut.materialized_class)}`);
  }
  if (!materializedId) materializedId = String(stemOut.node_id ?? '');
  if (!materializedId) fail('stemcell', 'missing materialized node_id');

  if (materializedData === undefined) {
    for (const [nodeId, nodeResult] of Object.entries(result.outputs ?? {})) {
      if (nodeId === materializedId) {
        materializedData = nodeResult?.outputs?.data;
        break;
      }
    }
  }
  if (materializedData !== 'evolve-stem-payload') {
    fail('stemcell', `materialized data mismatch: ${JSON.stringify(materializedData)}`);
  }

  const summary = {
    graph_edit_granted: stemOut.graph_edit_granted,
    materialized_class: stemOut.materialized_class,
    node_id: materializedId,
    materialized_data: materializedData,
    node_traces: traces,
  };
  console.log('PASS stemcell:', JSON.stringify(summary, null, 2));
  return summary;
}

async function runPetriDemo() {
  const petriPath = join(EVOLVE_DIR, 'petri-demo.json');
  const slavePath = join(EVOLVE_DIR, 'slave-scorer.json');
  if (!existsSync(slavePath)) fail('petri', `missing ${slavePath}`);

  const petriDef = JSON.parse(readFileSync(petriPath, 'utf8'));
  const slaveWf = JSON.parse(readFileSync(slavePath, 'utf8'));
  const petriNode = petriDef.nodes?.[0];
  if (petriNode?.params?.slave_workflow !== 'evolve-demo/slave-scorer') {
    fail('petri', `expected slave_workflow evolve-demo/slave-scorer: ${petriNode?.params?.slave_workflow}`);
  }

  // Headless bundle fs polyfill is empty — inject slave_inline from slave-scorer.json (SSoT file).
  petriNode.params.evolution_signal = {
    ...petriNode.params.evolution_signal,
    slave_inline: slaveWf,
  };

  const { executeGraph, parseWorkflow } = await loadHeadlessEngine();
  const graph = parseWorkflow(JSON.stringify(petriDef));
  const result = await executeGraph(graph, {
    runContext: { conversation_id: `evolve-petri-${Date.now()}` },
  });

  const outputs = {};
  if (result.results instanceof Map) {
    for (const [nodeId, nodeResult] of result.results) {
      outputs[nodeId] = nodeResult;
    }
  }

  const unhealthy = result.unhealthy_nodes ?? [];
  if (unhealthy.length) {
    fail('petri', `engine unhealthy: ${JSON.stringify(unhealthy)}`);
  }

  let petriOut = null;
  for (const nodeResult of Object.values(outputs)) {
    const outs = nodeResult?.outputs ?? {};
    if ('refined_workflow' in outs) {
      petriOut = outs;
      break;
    }
  }
  if (!petriOut?.refined_workflow) fail('petri', 'missing refined_workflow output');

  if (petriOut.applied !== false) fail('petri', `applied must be false: ${petriOut.applied}`);

  const evaluations = petriOut.evaluations ?? [];
  if (!Array.isArray(evaluations) || evaluations.length !== 3) {
    fail('petri', `expected 3 evaluations: ${JSON.stringify(evaluations)}`);
  }
  if (!evaluations.every((e) => e.ok)) {
    fail('petri', `all candidates must ok: ${JSON.stringify(evaluations)}`);
  }

  const scores = evaluations.map((e) => e.score);
  const bestIdx = evaluations.reduce(
    (best, e, i) => (e.score > evaluations[best].score ? i : best),
    0,
  );
  if (Math.max(...scores) !== 10) fail('petri', `expected max score 10: ${JSON.stringify(scores)}`);
  if (bestIdx !== 2) fail('petri', `best candidate should be index 2: ${JSON.stringify(evaluations)}`);

  const refinedNode = petriOut.refined_workflow?.nodes?.find((n) => n.id === '1');
  const refinedValue = refinedNode?.params?.value;
  if (refinedValue !== '{"score": 10}') {
    fail('petri', `refined workflow must pick score-10 candidate: ${JSON.stringify(refinedValue)}`);
  }

  const savedPath = savePetriResult(petriOut.refined_workflow, 'refined', EVOLVE_DIR);
  if (!existsSync(savedPath)) fail('petri', `savePetriResult did not write ${savedPath}`);
  if (!savedPath.endsWith('refined.petri.json')) fail('petri', `unexpected save path: ${savedPath}`);
  if (existsSync(join(EVOLVE_DIR, 'registry-entry.json'))) {
    fail('petri', 'registry-entry.json must not exist in evolve-demo');
  }

  const summary = {
    applied: petriOut.applied,
    evaluations,
    refined_value: refinedValue,
    saved_path: savedPath,
    slave_workflow: petriNode.params.slave_workflow,
    human_gate: 'refined.petri.json is human-review only — sync-workflows excludes *.petri.json from registry',
  };
  console.log('PASS petri:', JSON.stringify(summary, null, 2));
  console.log('人审门控：refined.petri.json 不进 registry，需人工审核后另存为正式 workflow');
  return summary;
}

async function main() {
  console.log('=== ADR-014 evolve-demo (headless) ===\n');
  await runStemCellDemo();
  console.log('');
  await runPetriDemo();
  console.log('\nevolve-demo: all passed');
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
