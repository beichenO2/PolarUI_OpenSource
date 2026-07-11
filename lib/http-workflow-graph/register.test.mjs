import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHttpWorkflowRunUrl,
  runHttpWorkflow,
} from './run-http-workflow.mjs';
import {
  registerHttpWorkflowExecutors,
  resetHttpWorkflowRegistration,
} from './register.mjs';

/** @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>} handler */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('resolveHttpWorkflowRunUrl appends /run unless already present', () => {
  assert.equal(resolveHttpWorkflowRunUrl('http://svc'), 'http://svc/run');
  assert.equal(resolveHttpWorkflowRunUrl('http://svc/'), 'http://svc/run');
  assert.equal(resolveHttpWorkflowRunUrl('http://svc/run'), 'http://svc/run');
  assert.equal(resolveHttpWorkflowRunUrl('http://svc/run/'), 'http://svc/run');
});

test('success: HTTP 200 + ok:true returns reply and memory_delta', async () => {
  const { server, baseUrl } = await startServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/run');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.message, 'hello');
    assert.equal(body.workflowId, 'wf-1');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      reply: 'pong',
      memory_delta: { session: { key: 'v' } },
    }));
  });

  try {
    const result = await runHttpWorkflow({
      params: { url: baseUrl, workflow_id: 'wf-1' },
      inputs: { message: 'hello' },
    });
    assert.equal(result.outputs.ok, true);
    assert.equal(result.outputs.reply, 'pong');
    assert.deepEqual(result.outputs.memory_delta, { session: { key: 'v' } });
    assert.equal(result.outputs.error, '');
  } finally {
    await closeServer(server);
  }
});

test('ok:false pass-through preserves reply and error', async () => {
  const { server, baseUrl } = await startServer(async (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: false,
      reply: '业务拒绝',
      error: 'quota exceeded',
    }));
  });

  try {
    const result = await runHttpWorkflow({
      params: { url: `${baseUrl}/run` },
      inputs: { message: 'x' },
    });
    assert.equal(result.outputs.ok, false);
    assert.equal(result.outputs.reply, '业务拒绝');
    assert.equal(result.outputs.error, 'quota exceeded');
  } finally {
    await closeServer(server);
  }
});

test('timeout returns ok:false without throwing', async () => {
  const { server, baseUrl } = await startServer(async (_req, _res) => {
    await new Promise((r) => setTimeout(r, 200));
  });

  try {
    const result = await runHttpWorkflow({
      params: { url: baseUrl, timeout_ms: 50 },
      inputs: { message: 'slow' },
    });
    assert.equal(result.outputs.ok, false);
    assert.match(result.outputs.error, /超时/);
  } finally {
    await closeServer(server);
  }
});

test('auth_token adds Authorization Bearer header', async () => {
  const { server, baseUrl } = await startServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-token');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, reply: 'auth ok' }));
  });

  try {
    const result = await runHttpWorkflow({
      params: { url: baseUrl, auth_token: 'secret-token' },
      inputs: { message: 'auth' },
    });
    assert.equal(result.outputs.ok, true);
    assert.equal(result.outputs.reply, 'auth ok');
  } finally {
    await closeServer(server);
  }
});

test('registers HttpWorkflow executor', async () => {
  resetHttpWorkflowRegistration();
  const types = [];
  /** @type {Function|undefined} */
  let fn;
  registerHttpWorkflowExecutors((type, f) => {
    types.push(type);
    if (type === 'HttpWorkflow') fn = f;
  });
  assert.ok(types.includes('HttpWorkflow'));
  assert.ok(fn);

  const { server, baseUrl } = await startServer(async (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, reply: 'via-register' }));
  });

  try {
    const result = await fn(
      { params: { url: baseUrl } },
      { message: 'm' },
      {},
    );
    assert.equal(result.outputs.reply, 'via-register');
  } finally {
    await closeServer(server);
  }
});
