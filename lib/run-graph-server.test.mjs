import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunGraphServer } from './run-graph-server.mjs';

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<{ port: number; baseUrl: string }>}
 */
function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind ephemeral port'));
        return;
      }
      resolve({ port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

/** @param {import('node:http').Server} server */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 */
async function requestJson(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) };
}

function validV2Envelope({ command: commandOverrides = {}, input, ...bodyOverrides } = {}) {
  const command = {
    id: '60000000-0000-4000-8000-000000000001',
    context_id: '10000000-0000-4000-8000-000000000001',
    route_id: '20000000-0000-4000-8000-000000000001',
    conversation_id: '30000000-0000-4000-8000-000000000001',
    base_checkpoint_id: '40000000-0000-4000-8000-000000000001',
    expected_checkpoint_version: 3,
    input: { type: 'message', content: 'v2 hello' },
    attachments: [],
    ...commandOverrides,
  };
  if (input !== undefined) command.input = input;
  return {
    contract_version: '2.0',
    workflow_id: 'native-web-qa',
    command,
    history: [],
    memory: {},
    checkpoint_snapshot: {},
    ...bodyOverrides,
  };
}

function successfulGraphResult() {
  return {
    ok: true,
    merged_output: '',
    outputs: { out: { outputs: { content: JSON.stringify({ ok: true, reply: 'unexpected run' }) } } },
    node_traces: ['Output'],
  };
}

test('POST /run happy path normalizes graph result', async () => {
  const mockRun = async (opts) => {
    assert.equal(opts.workflowId, 'test-flow');
    assert.equal(opts.inputs.message, 'hello');
    assert.equal(opts.inputs.conversationId, 'ses-1');
    assert.deepEqual(opts.inputs.command, {
      contract_version: '1.0',
      command_id: 'command-1',
      command_kind: 'message',
    });
    assert.deepEqual(opts.inputs.history, [{ role: 'user', content: 'before' }]);
    return {
      ok: true,
      merged_output: '',
      outputs: {
        out: {
          outputs: {
            content: JSON.stringify({ ok: true, reply: 'mock reply', step: 'done' }),
          },
        },
      },
      node_traces: ['Output'],
    };
  };

  const server = createRunGraphServer({ runWorkflow: mockRun });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', {
      message: 'hello',
      workflowId: 'test-flow',
      sessionId: 'ses-1',
      history: [{ role: 'user', content: 'before' }],
      input: {
        contract_version: '1.0',
        command_id: 'command-1',
        command_kind: 'message',
      },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.reply, 'mock reply');
    assert.equal(json.engine, 'graph');
  } finally {
    await closeServer(server);
  }
});

test('POST /run accepts a v2 Workflow envelope and forwards its immutable execution inputs', async () => {
  const command = {
    id: '60000000-0000-4000-8000-000000000001',
    context_id: '10000000-0000-4000-8000-000000000001',
    route_id: '20000000-0000-4000-8000-000000000001',
    conversation_id: '30000000-0000-4000-8000-000000000001',
    base_checkpoint_id: '40000000-0000-4000-8000-000000000001',
    expected_checkpoint_version: 3,
    input: { type: 'message', content: 'v2 hello' },
    attachments: ['50000000-0000-4000-8000-000000000001'],
  };
  const memory = {
    user: { items: [{ key: 'tone', value: 'concise', version: 2 }] },
    context: { items: [{ key: 'goal', value: 'ship', version: 4 }] },
  };
  const history = [{ role: 'user', content: 'immutable source' }];
  const checkpointSnapshot = { workflow_state: { fsm: 'understand' } };
  const mockRun = async (opts) => {
    assert.equal(opts.workflowId, 'native-web-qa');
    assert.equal(opts.inputs.message, 'v2 hello');
    assert.equal(opts.inputs.conversationId, command.conversation_id);
    assert.deepEqual(opts.inputs.command, command);
    assert.deepEqual(opts.inputs.memory, memory);
    assert.deepEqual(opts.inputs.history, history);
    assert.deepEqual(opts.inputs.checkpointSnapshot, checkpointSnapshot);
    return {
      ok: true,
      merged_output: '',
      outputs: { out: { outputs: { content: JSON.stringify({
        ok: true,
        contract_version: '2.0',
        reply_events: [{ type: 'message', content: 'v2 reply' }],
      }) } } },
      node_traces: ['NativeWebQaFixture', 'Output'],
    };
  };

  const server = createRunGraphServer({ runWorkflow: mockRun });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', {
      contract_version: '2.0',
      workflow_id: 'native-web-qa',
      command,
      memory,
      history,
      checkpoint_snapshot: checkpointSnapshot,
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.reply_events[0].content, 'v2 reply');
  } finally {
    await closeServer(server);
  }
});

test('POST /run rejects a v2 message whose content is not a string', async () => {
  let called = false;
  const server = createRunGraphServer({ runWorkflow: async () => {
    called = true;
    return { ok: true };
  } });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', {
      contract_version: '2.0',
      workflow_id: 'native-web-qa',
      command: {
        id: '60000000-0000-4000-8000-000000000001',
        context_id: '10000000-0000-4000-8000-000000000001',
        route_id: '20000000-0000-4000-8000-000000000001',
        conversation_id: '30000000-0000-4000-8000-000000000001',
        base_checkpoint_id: '40000000-0000-4000-8000-000000000001',
        expected_checkpoint_version: 1,
        input: { type: 'message', content: { arbitrary: 'object' } },
        attachments: [],
      },
      history: [],
      memory: {},
      checkpoint_snapshot: {},
    });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reply, '缺少 message');
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test('POST /run rejects a request body larger than 2 MiB before invoking the Workflow', async () => {
  let called = false;
  const server = createRunGraphServer({ runWorkflow: async () => {
    called = true;
    return successfulGraphResult();
  } });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const oversized = validV2Envelope({
      checkpoint_snapshot: { padding: 'x'.repeat(2 * 1024 * 1024) },
    });
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', oversized);
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.match(json.reply, /请求体过大/);
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test('POST /run strictly validates bounded v2 Command, scope, history, and workflow fields', async (t) => {
  let calls = 0;
  const server = createRunGraphServer({ runWorkflow: async () => {
    calls += 1;
    return successfulGraphResult();
  } });
  const { baseUrl } = await listenEphemeral(server);
  const attachmentId = (index) => `50000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  const cases = [
    ['named_intent without key', validV2Envelope({ input: { type: 'named_intent', content: 'summarize' } })],
    ['named_intent key over 200 characters', validV2Envelope({
      input: { type: 'named_intent', key: `a${'b'.repeat(200)}` },
    })],
    ['resume_interrupt without interruptId', validV2Envelope({
      input: { type: 'resume_interrupt', content: 'continue' },
    })],
    ['resume_interrupt with malformed interruptId', validV2Envelope({
      input: { type: 'resume_interrupt', interruptId: 'not-a-uuid', content: 'continue' },
    })],
    ['message content over 20k', validV2Envelope({
      input: { type: 'message', content: 'x'.repeat(20_001) },
    })],
    ['named_intent content over 20k', validV2Envelope({
      input: { type: 'named_intent', key: 'summarize', content: 'x'.repeat(20_001) },
    })],
    ['negative expected checkpoint version', validV2Envelope({
      command: { expected_checkpoint_version: -1 },
    })],
    ['malformed Command UUID', validV2Envelope({ command: { id: 'command-1' } })],
    ['malformed Context UUID', validV2Envelope({ command: { context_id: 'context-1' } })],
    ['malformed Route UUID', validV2Envelope({ command: { route_id: 'route-1' } })],
    ['malformed Conversation UUID', validV2Envelope({ command: { conversation_id: 'conversation-1' } })],
    ['malformed Checkpoint UUID', validV2Envelope({ command: { base_checkpoint_id: 'checkpoint-1' } })],
    ['more than 100 attachments', validV2Envelope({
      command: { attachments: Array.from({ length: 101 }, (_, index) => attachmentId(index)) },
    })],
    ['malformed attachment UUID', validV2Envelope({ command: { attachments: ['attachment-1'] } })],
    ['more than 200 history entries', validV2Envelope({
      history: Array.from({ length: 201 }, () => ({ role: 'user', content: 'history' })),
    })],
    ['history content over 20k', validV2Envelope({
      history: [{ role: 'assistant', content: 'x'.repeat(20_001) }],
    })],
    ['workflow_id over 200 characters', validV2Envelope({ workflow_id: 'w'.repeat(201) })],
  ];

  try {
    for (const [name, body] of cases) {
      await t.test(name, async () => {
        calls = 0;
        const { status, json } = await requestJson(baseUrl, 'POST', '/run', body);
        assert.equal(status, 200);
        assert.equal(json.ok, false);
        assert.equal(json.reply, '请求体无效');
        assert.equal(calls, 0);
      });
    }
  } finally {
    await closeServer(server);
  }
});

test('POST /run missing message returns ok:false', async () => {
  const server = createRunGraphServer({ runWorkflow: async () => ({ ok: true }) });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', { workflowId: 'x' });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reply, '缺少 message');
  } finally {
    await closeServer(server);
  }
});

test('POST /run invalid JSON body returns ok:false', async () => {
  const server = createRunGraphServer({ runWorkflow: async () => ({ ok: true }) });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const res = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reply, '请求体非 JSON');
  } finally {
    await closeServer(server);
  }
});

test('POST /run runWorkflow throw degrades gracefully', async () => {
  const server = createRunGraphServer({
    runWorkflow: async () => {
      throw new Error('boom');
    },
  });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'POST', '/run', { message: 'hi' });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.match(json.reply, /工作流服务暂时不可用/);
    assert.match(json.reply, /boom/);
  } finally {
    await closeServer(server);
  }
});

test('GET /health returns service info', async () => {
  const server = createRunGraphServer({
    runWorkflow: async () => ({}),
    listWorkflowIds: () => ['claude-code'],
  });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, 'polarui-run-graph');
    assert.deepEqual(json.workflows, ['claude-code']);
  } finally {
    await closeServer(server);
  }
});

test('unknown route returns 404', async () => {
  const server = createRunGraphServer({ runWorkflow: async () => ({}) });
  const { baseUrl } = await listenEphemeral(server);
  try {
    const { status, json } = await requestJson(baseUrl, 'GET', '/nope');
    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal(json.reply, 'not found');
  } finally {
    await closeServer(server);
  }
});
