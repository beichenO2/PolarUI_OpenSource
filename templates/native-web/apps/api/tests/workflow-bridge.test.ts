import { describe, expect, it, vi } from 'vitest';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { createWorkflowBridge, WorkflowBridgeError } from '../src/commands/bridge.js';

const manifest: ProductManifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo-flow', endpoint: 'http://workflow.test/run' },
  stages: [
    {
      key: 'discover', label: '发现', component_key: 'generic_chat',
      internal_states: ['start', 'done'],
      actions: [{ key: 'adopt_thread', label: '采纳到当前路线' }, { key: 'advance', label: '推进阶段' }],
    },
    {
      key: 'work', label: '实施', component_key: 'document_workspace',
      internal_states: ['waiting', 'running'],
      actions: [{ key: 'adopt_thread', label: '采纳到当前路线' }],
    },
  ],
};

const baseInput = {
  commandId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
  contextId: '10000000-0000-4000-8000-000000000003',
  routeId: '10000000-0000-4000-8000-000000000004',
  threadId: '10000000-0000-4000-8000-000000000005',
  stageKey: 'discover',
  baseCheckpointVersion: 2,
  kind: 'message' as const,
  content: '  help me decide  ',
  history: [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'second' },
  ],
  stages: [
    { stageKey: 'discover', position: 0, status: 'active' as const, internalState: 'start' },
    { stageKey: 'work', position: 1, status: 'not_started' as const, internalState: 'waiting' },
  ],
};

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function setup(fetchImpl = vi.fn(async () => response({ ok: true, reply: 'done' }))) {
  return {
    fetchImpl,
    bridge: createWorkflowBridge({
      endpoint: 'http://workflow.test/run/demo/flow.json',
      workflowId: 'demo-flow',
      manifest,
      timeoutMs: 500,
      fetch: fetchImpl as typeof fetch,
    }),
  };
}

describe('workflow bridge', () => {
  it('maps native scope to the legacy request and sends the command idempotency key', async () => {
    const { bridge, fetchImpl } = setup();

    await bridge.run(baseInput);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://workflow.test/run/demo/flow.json');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', redirect: 'error' }));
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(baseInput.commandId);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      userId: baseInput.userId,
      scenarioId: baseInput.contextId,
      sessionId: baseInput.threadId,
      message: 'help me decide',
      workflowId: 'demo-flow',
      history: baseInput.history,
      input: {
        command_id: baseInput.commandId,
        route_id: baseInput.routeId,
        stage_key: 'discover',
        checkpoint_version: 2,
        command_kind: 'message',
      },
    });
    expect(body.memoryPayload).toMatchObject({
      user: { proposals: [] },
      context: { id: baseInput.contextId, proposals: [] },
      route: { id: baseInput.routeId, stages: expect.any(Array) },
      stage: { key: 'discover' },
      session: { thread_id: baseInput.threadId },
    });
  });

  it('passes named actions explicitly and accepts a forward advance projection', async () => {
    const { bridge, fetchImpl } = setup(vi.fn(async () => response({
      ok: true,
      reply: 'advanced',
      stage_signal: { stage_key: 'discover', status: 'completed', internal_state: 'done' },
    })));

    const result = await bridge.run({
      ...baseInput,
      kind: 'named_action',
      actionKey: 'advance',
      content: 'go',
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.input.named_action).toBe('advance');
    expect(result.stageSignals).toEqual([
      { stageKey: 'discover', status: 'completed', internalState: 'done' },
    ]);
  });

  it('extracts a private PolarFlow interrupt and restores it only for resume', async () => {
    const privateCursor = { run_id: 'run-1', token: 'secret', prompt: '请补充目标' };
    const first = setup(vi.fn(async () => response({
      ok: true,
      reply: '请补充目标',
      memory_delta: { session: { polarflow_pending_run: privateCursor } },
    })));
    const interrupted = await first.bridge.run(baseInput);
    expect(interrupted.interrupt).toEqual({ prompt: '请补充目标', cursor: privateCursor });
    expect(interrupted.memoryProposals).toEqual([]);

    const resumed = setup();
    await resumed.bridge.run({
      ...baseInput,
      kind: 'resume_interrupt',
      interruptId: '10000000-0000-4000-8000-000000000006',
      interruptCursor: privateCursor,
      content: '目标是发布',
    });
    const body = JSON.parse(String(resumed.fetchImpl.mock.calls[0]![1]?.body));
    expect(body.message).toBe('目标是发布');
    expect(body.memoryPayload.session.polarflow_pending_run).toEqual(privateCursor);
    expect(body.input).not.toHaveProperty('interrupt_cursor');
  });

  it.each([
    ['WORKFLOW_REJECTED', response({ ok: false, reply: 'no' })],
    ['WORKFLOW_INVALID_RESPONSE', new Response('not-json', { status: 200 })],
    ['WORKFLOW_INVALID_RESPONSE', response({ ok: true, reply: 42 })],
    ['WORKFLOW_UNAVAILABLE', response({ ok: false }, { status: 502 })],
  ])('returns safe %s errors for invalid upstream responses', async (code, upstream) => {
    const { bridge } = setup(vi.fn(async () => upstream));
    await expect(bridge.run(baseInput)).rejects.toEqual(expect.objectContaining({ code }));
  });

  it('maps aborts to a safe timeout and does not retry', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return response({ ok: true, reply: 'never' });
    });
    const bridge = createWorkflowBridge({
      endpoint: 'http://workflow.test/run', workflowId: 'demo-flow', manifest,
      timeoutMs: 10, fetch: fetchImpl as typeof fetch,
    });
    await expect(bridge.run(baseInput)).rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_TIMEOUT' }));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown stage', [{ stage_key: 'missing', status: 'active', internal_state: 'start' }]],
    ['unknown internal state', [{ stage_key: 'discover', status: 'completed', internal_state: 'missing' }]],
    ['backward transition', [{ stage_key: 'discover', status: 'not_started', internal_state: 'start' }]],
    ['invalid ordering', [{ stage_key: 'work', status: 'active', internal_state: 'running' }]],
  ])('rejects %s signals', async (_label, stageSignals) => {
    const { bridge } = setup(vi.fn(async () => response({ ok: true, reply: 'bad', stage_signals: stageSignals })));
    await expect(bridge.run({ ...baseInput, kind: 'named_action', actionKey: 'advance' }))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_STATE' }));
  });

  it('rejects shared mutations from messages and requires advance to move forward', async () => {
    const mutation = setup(vi.fn(async () => response({
      ok: true, reply: 'bad',
      stage_signals: [{ stage_key: 'discover', status: 'completed', internal_state: 'done' }],
    })));
    await expect(mutation.bridge.run(baseInput))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_STATE' }));

    const noSignal = setup();
    await expect(noSignal.bridge.run({ ...baseInput, kind: 'named_action', actionKey: 'advance' }))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_STATE' }));
  });

  it('rejects shared mutations from interrupt resumes', async () => {
    const mutation = setup(vi.fn(async () => response({
      ok: true, reply: 'bad',
      stage_signals: [{ stage_key: 'discover', status: 'completed', internal_state: 'done' }],
    })));
    await expect(mutation.bridge.run({
      ...baseInput,
      kind: 'resume_interrupt',
      interruptId: '10000000-0000-4000-8000-000000000006',
      interruptCursor: { run_id: 'run-1' },
    })).rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_STATE' }));
  });

  it('keeps only strict public memory proposals', async () => {
    const { bridge } = setup(vi.fn(async () => response({
      ok: true,
      reply: 'done',
      memory_proposals: [
        { scope: 'context', value: 'Evidence complete' },
        { scope: 'session', value: 'private', token: 'super-secret' },
        { scope: 'context', value: { cursor: 'private' } },
      ],
    })));
    const result = await bridge.run(baseInput);
    expect(result.memoryProposals).toEqual([{ scope: 'context', value: 'Evidence complete' }]);
    expect(JSON.stringify(result.memoryProposals)).not.toContain('super-secret');
    expect(JSON.stringify(result.memoryProposals)).not.toContain('cursor');
  });

  it('rejects a multi-chunk response as soon as it exceeds the byte limit', async () => {
    const chunk = new Uint8Array(1_100_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { bridge } = setup(vi.fn(async () => new Response(stream, { status: 200 })));
    await expect(bridge.run(baseInput))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_RESPONSE' }));
  });

  it('maps a timeout while reading the response body to WORKFLOW_TIMEOUT', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { status: 200 }));
    const bridge = createWorkflowBridge({
      endpoint: 'http://workflow.test/run', workflowId: 'demo-flow', manifest,
      timeoutMs: 10, fetch: fetchImpl as typeof fetch,
    });
    await expect(bridge.run(baseInput))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_TIMEOUT' }));
  });

  it('never exposes upstream diagnostics through the public error', async () => {
    const { bridge } = setup(vi.fn(async () => { throw new Error('token=super-secret'); }));
    const error = await bridge.run(baseInput).catch((value) => value);
    expect(error).toBeInstanceOf(WorkflowBridgeError);
    expect(error.message).toBe('WORKFLOW_UNAVAILABLE');
    expect(JSON.stringify(error)).not.toContain('super-secret');
  });
});
