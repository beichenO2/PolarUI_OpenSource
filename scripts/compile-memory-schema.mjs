/**
 * Compile memory schema from WORKFLOW.spec.md + lg.json node scan.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.workflowDir
 * @param {object} opts.lgGraph
 */
export function compileMemorySchema(opts) {
  const { workflowDir, lgGraph } = opts;
  const specPath = join(workflowDir, 'WORKFLOW.spec.md');
  const requiredUser = ['school', 'major'];
  const requiredScenario = ['teacher.name', 'step'];

  let specHint = '';
  if (existsSync(specPath)) {
    specHint = readFileSync(specPath, 'utf8');
    if (specHint.includes('teacher.name')) requiredScenario.push('teacher.name');
  }

  const nodeTypes = new Set((lgGraph?.nodes ?? []).map((n) => n.class_type));
  const memoryNodes = [...nodeTypes].filter((t) => /Memory/.test(t));

  return {
    version: 1,
    scope_key_format: {
      user: '{user_id}',
      scenario: '{user_id}-{scenario_id}',
      session: '{user_id}-{scenario_id}-{session_id}',
    },
    layers: {
      user: { schema: 'user_memory_schema', required: requiredUser },
      scenario: { schema: 'scenario_memory_schema', required: requiredScenario },
      session: { schema: 'session_memory_schema', required: [] },
    },
    workflow_memory_nodes: memoryNodes.length ? memoryNodes : ['UserMemoryLoad', 'ScenarioMemoryLoad', 'ScenarioMemorySave'],
    spec_excerpt: specHint.slice(0, 500),
  };
}

export default compileMemorySchema;
