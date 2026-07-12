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

test('POST /run happy path normalizes graph result', async () => {
  const mockRun = async (opts) => {
    assert.equal(opts.workflowId, 'test-flow');
    assert.equal(opts.inputs.message, 'hello');
    assert.equal(opts.inputs.conversationId, 'ses-1');
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
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.reply, 'mock reply');
    assert.equal(json.engine, 'graph');
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
