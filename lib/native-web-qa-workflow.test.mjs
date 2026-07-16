import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflowGraph } from './run-graph.mjs';
import { normalizeTaociOutput } from './run-graph-output.mjs';

test('native-web-qa executes through the real headless graph engine', async () => {
  const result = await runWorkflowGraph({
    workflowId: 'native-web-qa',
    inputs: {
      conversationId: 'thread-1',
      userId: 'user-1',
      message: '[qa:artifact] release contract',
      files: [],
      memory: {},
      history: [],
      command: {
        contract_version: '1.0',
        command_id: '10000000-0000-4000-8000-000000000001',
        command_kind: 'message',
        stage_key: 'discover',
      },
    },
  });
  const output = normalizeTaociOutput(result);

  assert.equal(result.ok, true);
  assert.deepEqual(result.node_traces, ['NativeWebQaFixture', 'Output']);
  assert.equal(output.reply, 'Fixture reply · release contract');
  assert.equal(output.memory_proposals[0].scope, 'context');
  assert.equal(output.artifact_proposals[0].filename, 'workflow-report.txt');
  assert.equal(
    Buffer.from(output.artifact_proposals[0].content_base64, 'base64').toString('utf8'),
    'artifact · release contract',
  );
});
