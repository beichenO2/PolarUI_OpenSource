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
      contract_version: '1.0',
      userId: baseInput.userId,
      scenarioId: baseInput.contextId,
      sessionId: baseInput.threadId,
      message: 'help me decide',
      workflowId: 'demo-flow',
      history: baseInput.history,
      input: {
        contract_version: '1.0',
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

  it('accepts bounded inline artifact proposals without exposing a workflow path', async () => {
    const content = Buffer.from('report body').toString('base64');
    const { bridge } = setup(vi.fn(async () => response({
      ok: true,
      reply: 'Report ready',
      pdf_path: '/private/workflow/report.pdf',
      artifact_proposals: [{ filename: 'report.txt', media_type: 'text/plain', content_base64: content }],
    })));
    const result = await bridge.run(baseInput);
    expect(result.artifactProposals).toEqual([
      { filename: 'report.txt', mediaType: 'text/plain', body: Buffer.from('report body') },
    ]);
    expect(JSON.stringify(result)).not.toContain('/private/workflow');
  });

  it('accepts a normalized headless Workflow response with no legacy PDF artifact', async () => {
    const { bridge } = setup(vi.fn(async () => response({
      ok: true,
      reply: 'Fixture reply',
      pdf_path: null,
      artifact_proposals: [{
        filename: 'workflow-report.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from('report body').toString('base64'),
      }],
    })));

    const result = await bridge.run(baseInput);

    expect(result.reply).toBe('Fixture reply');
    expect(result.artifactProposals[0]?.filename).toBe('workflow-report.txt');
  });

  it('fails closed for malformed artifact bodies and excessive proposal counts', async () => {
    const malformed = setup(vi.fn(async () => response({
      ok: true, reply: 'bad',
      artifact_proposals: [{ filename: 'bad.bin', media_type: 'application/octet-stream', content_base64: '***' }],
    })));
    await expect(malformed.bridge.run(baseInput))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_ARTIFACT' }));

    const excessive = setup(vi.fn(async () => response({
      ok: true, reply: 'bad',
      artifact_proposals: Array.from({ length: 11 }, (_, index) => ({
        filename: `${index}.txt`, media_type: 'text/plain', content_base64: 'eA==',
      })),
    })));
    await expect(excessive.bridge.run(baseInput))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INVALID_RESPONSE' }));
  });

  it('rejects a multi-chunk response as soon as it exceeds the byte limit', async () => {
    const chunk = new Uint8Array(19_000_000);
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

const stageIndependentManifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo-flow', endpoint: 'http://workflow.test/run' },
  intents: [{ key: 'summarize', label: '总结当前结论' }],
} as ProductManifest;

const v2BaseInput = {
  commandId: baseInput.commandId,
  userId: baseInput.userId,
  contextId: baseInput.contextId,
  routeId: baseInput.routeId,
  conversationId: baseInput.threadId,
  baseCheckpoint: {
    id: '10000000-0000-4000-8000-000000000006',
    version: 2,
    snapshot: {
      workflowState: { fsm: 'understand' },
      stageProjection: {
        revision: 'workflow-v6',
        items: [{ key: 'understand', label: '理解问题', status: 'active' }],
      },
      memoryReferences: [],
      artifacts: [],
    },
  },
  commandInput: { type: 'message' as const, content: 'help me decide' },
  attachments: ['10000000-0000-4000-8000-000000000007'],
  history: baseInput.history,
  memory: {
    user: [{ key: 'tone', value: 'concise', version: 3 }],
    context: [{ key: 'goal', value: 'ship', version: 2 }],
  },
};

function workflowV2Response(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: '2.0',
    reply_events: [{ type: 'message', content: 'done' }],
    checkpoint: { workflow_state: { fsm: 'deliver' } },
    memory_updates: [],
    artifact_proposals: [],
    interrupt: null,
    diagnostics: {},
    ...overrides,
  };
}

function setupV2(fetchImpl = vi.fn(async () => response(workflowV2Response()))) {
  return {
    fetchImpl,
    bridge: createWorkflowBridge({
      endpoint: 'http://workflow.test/run/demo/flow.json',
      workflowId: 'demo-flow',
      manifest: stageIndependentManifest,
      timeoutMs: 500,
      fetch: fetchImpl as typeof fetch,
    }),
  };
}

function projectionItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `phase_${index}`,
    label: `阶段 ${index + 1}`,
    status: index === 0 ? 'waiting-for-evidence' : `workflow-status-${index}`,
    ...(index === 0 ? { checkpoint_id: v2BaseInput.baseCheckpoint.id } : {}),
    ...(index === 1 ? { summary: '由 Workflow 自行定义的状态' } : {}),
  }));
}

describe('workflow bridge v2', () => {
  it('sends the Stage-independent v2 Command envelope without stage_key or setStage', async () => {
    const { bridge, fetchImpl } = setupV2();

    await bridge.run(v2BaseInput);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      contract_version: '2.0',
      command: {
        id: v2BaseInput.commandId,
        context_id: v2BaseInput.contextId,
        route_id: v2BaseInput.routeId,
        conversation_id: v2BaseInput.conversationId,
        base_checkpoint_id: v2BaseInput.baseCheckpoint.id,
        expected_checkpoint_version: v2BaseInput.baseCheckpoint.version,
        input: v2BaseInput.commandInput,
        attachments: v2BaseInput.attachments,
      },
      history: v2BaseInput.history,
      memory: v2BaseInput.memory,
      checkpoint_snapshot: v2BaseInput.baseCheckpoint.snapshot,
      workflow_id: 'demo-flow',
    });
    expect(JSON.stringify(body)).not.toContain('stage_key');
    expect(JSON.stringify(body)).not.toContain('setStage');
  });

  it('accepts a normal message that moves the Workflow-owned projection and normalizes the full result', async () => {
    const stageProjection = {
      revision: 'workflow-v7',
      items: [
        {
          key: 'understand', label: '理解问题', status: 'completed',
          checkpoint_id: v2BaseInput.baseCheckpoint.id,
        },
        { key: 'deliver', label: '交付', status: 'active', summary: '正在生成结果' },
      ],
    };
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response({
      reply_events: [
        { type: 'delta', content: '正在生成' },
        { type: 'message', content: '结果已生成' },
      ],
      checkpoint: { workflow_state: { fsm: 'deliver', iteration: 7 } },
      stage_projection: stageProjection,
      context_title: '发布计划',
      conversation_title: '首轮交付',
      memory_updates: [{ scope: 'context', key: 'goal', value: 'ship' }],
      diagnostics: { workflow_revision: 'workflow-v7', duration_ms: 31 },
    }))));

    const result = await bridge.run(v2BaseInput);

    expect(result).toMatchObject({
      replyEvents: [
        { type: 'delta', content: '正在生成' },
        { type: 'message', content: '结果已生成' },
      ],
      checkpoint: { workflowState: { fsm: 'deliver', iteration: 7 } },
      stageProjection: {
        revision: 'workflow-v7',
        items: [
          {
            key: 'understand', label: '理解问题', status: 'completed',
            checkpointId: v2BaseInput.baseCheckpoint.id,
          },
          { key: 'deliver', label: '交付', status: 'active', summary: '正在生成结果' },
        ],
      },
      contextTitle: '发布计划',
      conversationTitle: '首轮交付',
      memoryUpdates: [{ scope: 'context', key: 'goal', value: 'ship' }],
      artifactProposals: [],
      interrupt: null,
      diagnostics: { workflow_revision: 'workflow-v7', duration_ms: 31 },
    });
  });

  it.each([0, 1, 4, 7])('accepts a self-describing projection with %i items', async (count) => {
    const items = projectionItems(count);
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response({
      stage_projection: { revision: 'workflow-v1', items },
    }))));

    await expect(bridge.run({
      ...v2BaseInput,
      baseCheckpoint: {
        ...v2BaseInput.baseCheckpoint,
        snapshot: {
          ...v2BaseInput.baseCheckpoint.snapshot,
          stageProjection: { revision: 'workflow-v99', items: [] },
        },
      },
    })).resolves.toMatchObject({
      stageProjection: {
        revision: 'workflow-v1',
        items: items.map((item) => ({
          key: item.key,
          label: item.label,
          status: item.status,
          ...('checkpoint_id' in item ? { checkpointId: item.checkpoint_id } : {}),
          ...('summary' in item ? { summary: item.summary } : {}),
        })),
      },
    });
  });

  it('passes a named intent to Workflow without consulting any Stage definition', async () => {
    const { bridge, fetchImpl } = setupV2(vi.fn(async () => response(workflowV2Response({
      stage_projection: {
        revision: 'workflow-v8',
        items: [{ key: 'done', label: '已总结', status: 'workflow-complete' }],
      },
    }))));

    await expect(bridge.run({
      ...v2BaseInput,
      commandInput: { type: 'named_intent', key: 'summarize' },
    })).resolves.toMatchObject({
      stageProjection: {
        revision: 'workflow-v8',
        items: [{ key: 'done', label: '已总结', status: 'workflow-complete' }],
      },
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.command.input).toEqual({ type: 'named_intent', key: 'summarize' });
    expect(JSON.stringify(body)).not.toContain('stage_key');
  });

  it('accepts an interrupt-only result with no synthetic reply event', async () => {
    const cursor = { kind: 'confirmation', token: 'private-cursor' };
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response({
      reply_events: [],
      interrupt: { prompt: '请确认高影响变更', cursor },
    }))));

    await expect(bridge.run(v2BaseInput)).resolves.toMatchObject({
      replyEvents: [],
      interrupt: { prompt: '请确认高影响变更', cursor },
      checkpoint: { workflowState: { fsm: 'deliver' } },
    });
  });

  it.each([
    ['a memory update with no value', { memory_updates: [{ scope: 'context', key: 'goal' }] }],
    ['an interrupt with no private cursor', { interrupt: { prompt: '请确认' } }],
    ['neither reply events nor an interrupt', { reply_events: [], interrupt: null }],
  ])('rejects %s', async (_label, overrides) => {
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response(overrides))));

    await expect(bridge.run(v2BaseInput)).rejects.toEqual(
      expect.objectContaining({ code: 'WORKFLOW_INVALID_RESPONSE' }),
    );
  });

  it.each([
    ['duplicate keys', {
      revision: 'workflow-v7',
      items: [
        { key: 'same', label: '一', status: 'active' },
        { key: 'same', label: '二', status: 'queued' },
      ],
    }],
    ['missing label', {
      revision: 'workflow-v7',
      items: [{ key: 'missing_label', status: 'active' }],
    }],
    ['invalid checkpoint id', {
      revision: 'workflow-v7',
      items: [{ key: 'bad_checkpoint', label: '坏锚点', status: 'active', checkpoint_id: 'not-a-uuid' }],
    }],
    ['more than 1000 items', {
      revision: 'workflow-v7',
      items: projectionItems(1001),
    }],
  ])('rejects malformed projections with %s', async (_label, stageProjection) => {
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response({
      stage_projection: stageProjection,
    }))));

    await expect(bridge.run(v2BaseInput)).rejects.toEqual(
      expect.objectContaining({ code: 'WORKFLOW_INVALID_RESPONSE' }),
    );
  });

  it('returns only allowlisted public diagnostics', async () => {
    const { bridge } = setupV2(vi.fn(async () => response(workflowV2Response({
      diagnostics: {
        workflow_revision: 'workflow-v7',
        duration_ms: 31,
        endpoint: 'http://private.workflow/run',
        token: 'super-secret',
        stack: 'private stack',
        cursor: { private: true },
      },
    }))));

    const result = await bridge.run(v2BaseInput);

    expect(result.diagnostics).toEqual({ workflow_revision: 'workflow-v7', duration_ms: 31 });
    expect(JSON.stringify(result)).not.toContain('private.workflow');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('private stack');
  });
});
