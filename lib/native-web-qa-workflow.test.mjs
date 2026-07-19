import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runWorkflowGraph } from './run-graph.mjs';
import { normalizeTaociOutput } from './run-graph-output.mjs';

const ids = {
  context: '10000000-0000-4000-8000-000000000001',
  route: '20000000-0000-4000-8000-000000000001',
  conversation: '30000000-0000-4000-8000-000000000001',
  checkpoint: '40000000-0000-4000-8000-000000000001',
  attachment: '50000000-0000-4000-8000-000000000001',
};

async function runFixture(message, options = {}) {
  const input = options.input ?? { type: 'message', content: message };
  const result = await runWorkflowGraph({
    workflowId: 'native-web-qa',
    inputs: {
      conversationId: ids.conversation,
      userId: 'user-1',
      message,
      files: [],
      memory: options.memory ?? {
        user: { items: [], extraction_goal: '用户建模' },
        context: { items: [], extraction_goal: '情景建模' },
      },
      history: options.history ?? [],
      command: {
        contract_version: '2.0',
        id: randomUUID(),
        context_id: ids.context,
        route_id: ids.route,
        conversation_id: ids.conversation,
        base_checkpoint_id: options.baseCheckpointId ?? ids.checkpoint,
        expected_checkpoint_version: options.expectedCheckpointVersion ?? 3,
        input,
        attachments: options.attachments ?? [],
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.node_traces, ['NativeWebQaFixture', 'Output']);
  return normalizeTaociOutput(result);
}

test('native-web-qa exercises zero, one, and 7+ dynamic Stage Projection items', async () => {
  const zero = await runFixture('[qa:projection:0] no visible projection');
  const one = await runFixture('[qa:projection:1] single projection');
  const many = await runFixture('[qa:projection:many] dense projection');

  assert.deepEqual(zero.stage_projection, { revision: 'qa-dynamic-v1', items: [] });
  assert.equal(one.stage_projection.items.length, 1);
  assert.equal(one.stage_projection.items[0].label, '动态校验项 1');
  assert.equal(many.stage_projection.items.length, 8);
  assert.deepEqual(many.stage_projection.items.map((item) => item.key), [
    'dynamic-1', 'dynamic-2', 'dynamic-3', 'dynamic-4',
    'dynamic-5', 'dynamic-6', 'dynamic-7', 'dynamic-8',
  ]);
});

test('native-web-qa advances its projection from normal message history without a Web stage command', async () => {
  const first = await runFixture('梳理这次发布的目标');
  const second = await runFixture('现在给出可交付的结果', {
    history: [
      { role: 'user', content: '梳理这次发布的目标' },
      { role: 'assistant', content: first.reply_events[0].content },
    ],
  });

  assert.equal(first.stage_projection.items.find((item) => item.status === 'active').key, 'understand');
  assert.equal(second.stage_projection.items.find((item) => item.status === 'active').key, 'deliver');
  assert.equal(Object.hasOwn(second.checkpoint.workflow_state, 'stage_key'), false);
});

test('native-web-qa returns agent names and separate user/context memory metadata', async () => {
  const output = await runFixture('[qa:start] establish the release context', {
    memory: {
      user: {
        items: [
          { key: 'tone', value: 'formal', version: 9 },
          { key: 'qa_response_style', value: 'concise', version: 2 },
        ],
        extraction_goal: '用户建模',
      },
      context: {
        items: [
          { key: 'goal', value: 'ship', version: 8 },
          { key: 'qa_release_goal', value: 'verify previous release', version: 4 },
        ],
        extraction_goal: '情景建模',
      },
    },
  });

  assert.equal(output.context_title, 'Native Web 发布验证');
  assert.equal(output.conversation_title, '核心 Input 验收');
  assert.deepEqual(output.memory_updates.map((update) => update.scope), ['user', 'context']);
  assert.deepEqual(output.memory_updates[0], {
    scope: 'user',
    key: 'qa_response_style',
    value: 'concise',
    expected_version: 2,
    evidence: [{ kind: 'message', id: 'qa-start-input', excerpt: 'establish the release context' }],
    impact_scope: { context_ids: 'all' },
  });
  assert.deepEqual(output.memory_updates[1].impact_scope, { context_ids: [ids.context] });
  assert.equal(output.memory_updates[1].expected_version, 4);
});

test('native-web-qa can explicitly attempt later Agent naming for the user-name-lock journey', async () => {
  const output = await runFixture('[qa:rename-attempt] agent must not overwrite user titles', {
    history: [
      { role: 'user', content: '[qa:start] establish the release context' },
      { role: 'assistant', content: 'Fixture initialized' },
    ],
  });

  assert.equal(output.context_title, 'Agent overwrite attempt Context');
  assert.equal(output.conversation_title, 'Agent overwrite attempt Conversation');
  assert.deepEqual(output.memory_updates, []);
});

test('native-web-qa emits a high-impact conflicting memory update that requires an Interrupt', async () => {
  const output = await runFixture('[qa:memory-conflict] replace the release authority', {
    memory: {
      user: { items: [], extraction_goal: '用户建模' },
      context: {
        items: [{ key: 'release_authority', value: 'official registry', version: 7 }],
        extraction_goal: '情景建模',
      },
    },
  });

  assert.equal(output.memory_updates[0].high_impact, true);
  assert.equal(output.memory_updates[0].expected_version, 7);
  assert.match(output.memory_updates[0].confirmation_prompt, /冲突|确认/u);
  assert.equal(output.interrupt.prompt, '这条高影响记忆与现有事实冲突，请确认。');
  assert.equal(output.interrupt.cursor.kind, 'memory_confirmation');
});

test('native-web-qa consumes attachments and emits a deterministic Artifact through the real graph', async () => {
  const output = await runFixture('[qa:artifact] release contract', {
    attachments: [ids.attachment],
  });

  assert.equal(output.artifact_proposals[0].filename, 'workflow-report.txt');
  assert.equal(
    Buffer.from(output.artifact_proposals[0].content_base64, 'base64').toString('utf8'),
    `artifact · release contract · attachment ${ids.attachment}`,
  );
  assert.deepEqual(output.checkpoint.workflow_state.attachment_ids, [ids.attachment]);
});

test('native-web-qa fails before initialization activation without returning names or snapshots', async () => {
  const output = await runFixture('[qa:reject] fail before initialization');

  assert.equal(output.ok, false);
  assert.equal(output.reply, 'Fixture rejected command before initialization activation');
  assert.equal(Object.hasOwn(output, 'context_title'), false);
  assert.equal(Object.hasOwn(output, 'checkpoint'), false);
});

test('native-web-qa preserves historical Input, source Checkpoint, and source history', async () => {
  const history = [
    { role: 'user', content: 'immutable source question' },
    { role: 'assistant', content: 'immutable source answer' },
  ];
  const output = await runFixture('[qa:history] continue from immutable source', {
    history,
    baseCheckpointId: '40000000-0000-4000-8000-000000000099',
    expectedCheckpointVersion: 11,
  });

  assert.deepEqual(output.checkpoint.workflow_state.history_source, {
    checkpoint_id: '40000000-0000-4000-8000-000000000099',
    checkpoint_version: 11,
    input: '[qa:history] continue from immutable source',
    messages: history,
  });
  assert.equal(output.stage_projection.items[0].checkpoint_id, '40000000-0000-4000-8000-000000000099');
});
