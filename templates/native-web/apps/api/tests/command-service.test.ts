import { describe, expect, it, vi } from 'vitest';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { createCommandService, CommandServiceError } from '../src/commands/service.js';
import { WorkflowBridgeError } from '../src/commands/bridge.js';
import { CommandRepositoryError } from '../src/commands/types.js';

const manifest: ProductManifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo-flow', endpoint: 'http://workflow.test/run' },
  stages: [
    {
      key: 'discover', label: '发现', component_key: 'generic_chat', internal_states: ['start', 'done'],
      actions: [{ key: 'adopt_thread', label: '采纳到当前路线' }, { key: 'advance', label: '推进阶段' }],
    },
    {
      key: 'work', label: '实施', component_key: 'document_workspace', internal_states: ['waiting', 'running'],
      actions: [{ key: 'adopt_thread', label: '采纳到当前路线' }],
    },
  ],
};

const ids = {
  command: '10000000-0000-4000-8000-000000000001',
  user: '10000000-0000-4000-8000-000000000002',
  context: '10000000-0000-4000-8000-000000000003',
  route: '10000000-0000-4000-8000-000000000004',
  thread: '10000000-0000-4000-8000-000000000005',
  checkpoint: '10000000-0000-4000-8000-000000000006',
  interrupt: '10000000-0000-4000-8000-000000000007',
};

const execution = {
  userId: ids.user,
  contextId: ids.context,
  routeId: ids.route,
  threadId: ids.thread,
  stageKey: 'discover',
  baseCheckpoint: {
    id: ids.checkpoint,
    contextId: ids.context,
    routeId: ids.route,
    parentCheckpointId: null,
    version: 0,
    stageKey: 'discover',
    reason: 'bootstrap' as const,
    snapshot: { stages: [
      { stage_key: 'discover', status: 'active' as const, internal_state: 'start' },
      { stage_key: 'work', status: 'not_started' as const, internal_state: 'waiting' },
    ] },
    createdAt: new Date('2026-07-16T00:00:00.000Z'),
  },
  headCheckpointId: ids.checkpoint,
  baseIsHead: true,
  history: [{ role: 'user' as const, content: 'Earlier' }],
  stages: [
    { stageKey: 'discover', position: 0, status: 'active' as const, internalState: 'start' },
    { stageKey: 'work', position: 1, status: 'not_started' as const, internalState: 'waiting' },
  ],
};

function setup(options: {
  claim?: unknown;
  bridgeResult?: unknown;
  executionOverride?: Record<string, unknown>;
  bridgeError?: Error;
  claimError?: Error;
  leaseDurationMs?: number;
} = {}) {
  const command = {
    id: ids.command, kind: 'message', actionKey: null, interruptId: null,
    content: 'Question', status: 'running', sourceThreadId: ids.thread, attempt: 1,
  };
  const repository = {
    claimCommand: vi.fn(async () => {
      if (options.claimError) throw options.claimError;
      return options.claim ?? { kind: 'claimed', command, execution: { ...execution, ...options.executionOverride } };
    }),
    appendEvent: vi.fn(async (_id, eventType, payload) => ({ eventType, payload })),
    finalizeMessage: vi.fn(async () => ({ status: 'succeeded', routeId: ids.route, threadId: ids.thread })),
    finalizeAction: vi.fn(async () => ({ status: 'succeeded', routeId: ids.route, threadId: ids.thread })),
    failCommand: vi.fn(async () => []),
  };
  const bridge = {
    run: vi.fn(async () => {
      if (options.bridgeError) throw options.bridgeError;
      return options.bridgeResult ?? {
        reply: 'Answer', stageSignals: [], workflowCursor: null, memoryProposals: [], interrupt: null,
      };
    }),
  };
  const generated = Array.from({ length: 12 }, (_, index) =>
    `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const service = createCommandService({
    repository: repository as never,
    bridge: bridge as never,
    manifest,
    createId: () => generated.shift()!,
    now: () => new Date('2026-07-16T10:00:00.000Z'),
    leaseDurationMs: options.leaseDurationMs,
  });
  return { repository, bridge, service };
}

const messageInput = {
  commandId: ids.command,
  kind: 'message' as const,
  content: '  Question  ',
  baseCheckpointId: ids.checkpoint,
  expectedCheckpointVersion: 0,
};

describe('workflow command service', () => {
  it('normalizes content, claims a durable command, and returns a stable event URL', async () => {
    const { repository, service } = setup();
    const result = await service.createCommand(ids.user, ids.thread, messageInput);
    expect(result).toEqual({ commandId: ids.command, eventUrl: `/api/commands/${ids.command}/events`, replayed: false });
    expect(repository.claimCommand).toHaveBeenCalledWith(expect.objectContaining({
      userId: ids.user,
      threadId: ids.thread,
      content: 'Question',
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseExpiresAt: new Date('2026-07-16T10:01:30.000Z'),
    }));
  });

  it('derives the command lease from the configured workflow timeout margin', async () => {
    const { repository, service } = setup({ leaseDurationMs: 150_000 });
    await service.createCommand(ids.user, ids.thread, messageInput);
    expect(repository.claimCommand).toHaveBeenCalledWith(expect.objectContaining({
      leaseExpiresAt: new Date('2026-07-16T10:02:30.000Z'),
    }));
  });

  it.each([
    [{ kind: 'reused' }, 'COMMAND_ID_REUSED'],
    [{ kind: 'in_progress' }, 'COMMAND_IN_PROGRESS'],
    [{ kind: 'interrupt_claimed' }, 'INTERRUPT_ALREADY_RESUMED'],
  ])('maps claim conflicts to safe errors', async (claim, code) => {
    const { service } = setup({ claim });
    await expect(service.createCommand(ids.user, ids.thread, messageInput))
      .rejects.toEqual(expect.objectContaining({ code, statusCode: 409 }));
  });

  it('maps inaccessible command scope to a hidden 404', async () => {
    const { service } = setup({ claimError: new CommandRepositoryError('COMMAND_SCOPE_INVALID') });
    await expect(service.createCommand(ids.user, ids.thread, messageInput))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND', statusCode: 404 }));
  });

  it('replays a terminal command without scheduling another bridge execution', async () => {
    const { bridge, service } = setup({
      claim: { kind: 'replay', command: { id: ids.command, status: 'succeeded' }, events: [] },
    });
    expect(await service.createCommand(ids.user, ids.thread, messageInput))
      .toEqual({ commandId: ids.command, eventUrl: `/api/commands/${ids.command}/events`, replayed: true });
    await service.executeCommand(ids.command);
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it('persists workflow start then finalizes a message and normalized interrupt', async () => {
    const { repository, bridge, service } = setup({ bridgeResult: {
      reply: 'Need approval', stageSignals: [], workflowCursor: null, memoryProposals: [],
      interrupt: { prompt: 'Approve?', cursor: { private: 'cursor' } },
    } });
    await service.createCommand(ids.user, ids.thread, messageInput);
    await service.executeCommand(ids.command);
    expect(repository.appendEvent).toHaveBeenCalledWith(
      ids.command, 'workflow.started', { attempt: 1 }, expect.any(Date),
    );
    expect(bridge.run).toHaveBeenCalledWith(expect.objectContaining({
      commandId: ids.command,
      history: execution.history,
      stages: execution.stages,
      content: 'Question',
    }));
    expect(repository.finalizeMessage).toHaveBeenCalledWith(ids.command, expect.objectContaining({
      reply: 'Need approval',
      interrupt: { id: expect.any(String), prompt: 'Approve?', cursor: { private: 'cursor' } },
    }), expect.any(Date));
  });

  it('passes only the repository-provided private cursor when resuming an interrupt', async () => {
    const { bridge, service } = setup({ executionOverride: { interruptCursor: { private: 'cursor' } } });
    await service.createCommand(ids.user, ids.thread, {
      ...messageInput,
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: ' Approved ',
    });
    await service.executeCommand(ids.command);
    expect(bridge.run).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      interruptCursor: { private: 'cursor' },
      content: 'Approved',
    }));
  });

  it('finalizes a current action on its existing route and thread', async () => {
    const { repository, service } = setup({ bridgeResult: {
      reply: 'Advanced', workflowCursor: null, memoryProposals: [], interrupt: null,
      stageSignals: [{ stageKey: 'discover', status: 'completed', internalState: 'done' }],
    } });
    await service.createCommand(ids.user, ids.thread, {
      ...messageInput, kind: 'named_action', actionKey: 'advance', content: '',
    });
    await service.executeCommand(ids.command);
    expect(repository.finalizeAction).toHaveBeenCalledWith(ids.command, expect.objectContaining({
      adoptedThreadId: null,
    }), expect.objectContaining({
      headCheckpointIdAtClaim: ids.checkpoint,
    }), expect.any(Date));
  });

  it('rejects commands against an archived version before workflow execution', async () => {
    const { bridge, repository, service } = setup({ executionOverride: {
      baseIsHead: false,
      headCheckpointId: '10000000-0000-4000-8000-000000000099',
    } });

    await expect(service.createCommand(ids.user, ids.thread, messageInput)).rejects.toEqual(
      expect.objectContaining({ code: 'CHECKPOINT_NOT_CURRENT', statusCode: 409 }),
    );
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'CHECKPOINT_NOT_CURRENT',
      expect.any(Date),
    );
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it.each([
    ['missing_action', 'INVALID_ACTION'],
    ['advance', 'ACTION_NOT_AVAILABLE'],
  ])('rejects unavailable actions before workflow execution', async (actionKey, code) => {
    const executionOverride = actionKey === 'advance'
      ? { stageKey: 'work', stages: execution.stages.map((stage) =>
        stage.stageKey === 'work' ? { ...stage, status: 'not_started' as const } : stage) }
      : {};
    const { bridge, repository, service } = setup({ executionOverride });
    await expect(service.createCommand(ids.user, ids.thread, {
      ...messageInput, kind: 'named_action', actionKey, content: '',
    })).rejects.toEqual(expect.objectContaining({ code }));
    expect(repository.failCommand).toHaveBeenCalled();
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it('persists a safe terminal code when the bridge fails', async () => {
    const { repository, service } = setup({ bridgeError: new WorkflowBridgeError('WORKFLOW_TIMEOUT') });
    await service.createCommand(ids.user, ids.thread, messageInput);
    await service.executeCommand(ids.command);
    expect(repository.failCommand).toHaveBeenCalledWith(ids.command, 'WORKFLOW_TIMEOUT', expect.any(Date));
  });

  it('does not expose unexpected runtime diagnostics', async () => {
    const { repository, service } = setup({ bridgeError: new Error('token=secret') });
    await service.createCommand(ids.user, ids.thread, messageInput);
    await service.executeCommand(ids.command);
    expect(repository.failCommand).toHaveBeenCalledWith(ids.command, 'WORKFLOW_UNAVAILABLE', expect.any(Date));
  });

  it('exports a stable safe error type', () => {
    expect(new CommandServiceError('INVALID_REQUEST', 400)).toMatchObject({
      message: 'INVALID_REQUEST', code: 'INVALID_REQUEST', statusCode: 400,
    });
  });
});

const unifiedIds = {
  resultCheckpoint: '10000000-0000-4000-8000-000000000008',
  historyCheckpoint: '10000000-0000-4000-8000-000000000009',
  resultRoute: '10000000-0000-4000-8000-000000000010',
  resultConversation: '10000000-0000-4000-8000-000000000011',
  attachment: '10000000-0000-4000-8000-000000000012',
};

const unifiedExecution = {
  ...execution,
  conversationId: ids.thread,
  scope: {
    mode: 'head' as const,
    contextId: ids.context,
    routeId: ids.route,
    conversationId: ids.thread,
  },
};

const startCommandInput = {
  commandId: ids.command,
  input: { type: 'message' as const, content: '  Question  ' },
  attachmentIds: [unifiedIds.attachment],
};

const stageIndependentManifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo-flow', endpoint: 'http://workflow.test/run' },
  intents: [{ key: 'summarize', label: '总结当前结论' }],
} as ProductManifest;

function setupUnified(options: {
  prepared?: unknown;
  executionOverride?: Record<string, unknown>;
  prepareError?: Error;
  bridgeError?: Error;
  bridgeResult?: unknown;
  manifest?: ProductManifest;
} = {}) {
  const command = {
    id: ids.command,
    kind: 'message',
    actionKey: null,
    interruptId: null,
    content: 'Question',
    status: 'running',
    sourceThreadId: ids.thread,
    attempt: 1,
  };
  const repository = {
    prepareCommand: vi.fn(async () => {
      if (options.prepareError) throw options.prepareError;
      return options.prepared ?? {
        kind: 'claimed',
        command,
        execution: { ...unifiedExecution, ...options.executionOverride },
      };
    }),
    appendEvent: vi.fn(async (_id, eventType, payload) => ({ eventType, payload })),
    finalizeCommand: vi.fn(async () => ({
      status: 'succeeded',
      routeId: unifiedIds.resultRoute,
      conversationId: unifiedIds.resultConversation,
      checkpointId: unifiedIds.resultCheckpoint,
    })),
    failCommand: vi.fn(async () => []),
    renameContext: vi.fn(),
    renameConversation: vi.fn(),
  };
  const bridge = {
    run: vi.fn(async () => {
      if (options.bridgeError) throw options.bridgeError;
      if (options.bridgeResult) return options.bridgeResult;
      return {
        reply: 'Answer',
        stageSignals: [],
        workflowCursor: null,
        memoryProposals: [],
        interrupt: null,
        artifactProposals: [],
      };
    }),
  };
  const generated = Array.from({ length: 16 }, (_, index) =>
    `21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const service = createCommandService({
    repository: repository as never,
    bridge: bridge as never,
    manifest: options.manifest ?? manifest,
    createId: () => generated.shift()!,
    now: () => new Date('2026-07-16T10:00:00.000Z'),
  });
  return { repository, bridge, service };
}

describe('unified workflow input command', () => {
  it.each([
    [undefined],
    [{ commandId: ids.command, attachmentIds: [], input: undefined }],
    [{ commandId: ids.command, attachmentIds: [], input: {} }],
    [{ commandId: ids.command, attachmentIds: [], input: { type: 'message', content: 42 } }],
    [{ commandId: ids.command, attachmentIds: [], input: { type: 'named_intent', key: 42 } }],
    [{ commandId: ids.command, attachmentIds: [], input: { type: 'resume_interrupt', interruptId: 42, content: 'ok' } }],
  ])('maps malformed direct unified input to INVALID_REQUEST instead of throwing a runtime TypeError', async (input) => {
    const { repository, service } = setupUnified();
    await expect(service.createCommand(ids.user, input as never)).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_REQUEST', statusCode: 400 }),
    );
    expect(repository.prepareCommand).not.toHaveBeenCalled();
  });

  it('treats an input with all five scope fields absent as Start and never sends Stage ownership', async () => {
    const { repository, service } = setupUnified({ executionOverride: {
      scope: {
        mode: 'start',
        provisionalContextId: ids.context,
        provisionalRouteId: ids.route,
        provisionalConversationId: ids.thread,
      },
    } });

    await expect(service.createCommand(ids.user, startCommandInput)).resolves.toEqual({
      commandId: ids.command,
      eventUrl: `/api/commands/${ids.command}/events`,
      replayed: false,
    });
    const preparedInput = repository.prepareCommand.mock.calls[0]![0];
    expect(preparedInput).toMatchObject({
      userId: ids.user,
      commandId: ids.command,
      input: { type: 'message', content: 'Question' },
      attachmentIds: [unifiedIds.attachment],
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(preparedInput).not.toHaveProperty('threadId');
    expect(preparedInput).not.toHaveProperty('stageKey');
  });

  it('accepts a non-head checkpoint as history input instead of rejecting it', async () => {
    const { bridge, repository, service } = setupUnified({ executionOverride: {
      scope: {
        mode: 'history',
        contextId: ids.context,
        sourceRouteId: ids.route,
        sourceCheckpointId: unifiedIds.historyCheckpoint,
      },
      baseCheckpoint: {
        ...execution.baseCheckpoint,
        id: unifiedIds.historyCheckpoint,
        version: 2,
      },
      baseIsHead: false,
    } });

    await service.createCommand(ids.user, {
      ...startCommandInput,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: unifiedIds.historyCheckpoint,
      expectedCheckpointVersion: 2,
    });
    await service.executeCommand(ids.command);

    expect(bridge.run).toHaveBeenCalledTimes(1);
    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({
        checkpointId: expect.any(String),
        reply: 'Answer',
      }),
      expect.any(Date),
    );
    expect(repository.failCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['message', { type: 'message' as const, content: 'Question' }],
    ['named intent', { type: 'named_intent' as const, key: 'summarize', content: 'Summarize' }],
    ['interrupt resume', { type: 'resume_interrupt' as const, interruptId: ids.interrupt, content: 'Approved' }],
  ])('records the returned checkpoint for every successful %s input', async (_label, input) => {
    const { repository, service } = setupUnified({
      executionOverride: input.type === 'resume_interrupt'
        ? { interruptCursor: { private: 'cursor' } }
        : {},
    });

    await service.createCommand(ids.user, {
      commandId: ids.command,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input,
      attachmentIds: [],
    });
    await service.executeCommand(ids.command);

    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({ checkpointId: expect.any(String) }),
      expect.any(Date),
    );
  });

  it('replays an exact command without scheduling Workflow a second time', async () => {
    const { bridge, service } = setupUnified({ prepared: {
      kind: 'replay',
      command: { id: ids.command, status: 'succeeded' },
      events: [],
    } });

    await expect(service.createCommand(ids.user, startCommandInput)).resolves.toMatchObject({ replayed: true });
    await service.executeCommand(ids.command);
    expect(bridge.run).not.toHaveBeenCalled();
  });

  it('rejects changed payload reuse of the same command ID', async () => {
    const { service } = setupUnified({ prepared: { kind: 'reused' } });
    await expect(service.createCommand(ids.user, startCommandInput)).rejects.toEqual(
      expect.objectContaining({ code: 'COMMAND_ID_REUSED', statusCode: 409 }),
    );
  });

  it('maps an expected-version conflict to a refreshable 409', async () => {
    const { service } = setupUnified({
      prepareError: new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT'),
    });
    await expect(service.createCommand(ids.user, {
      ...startCommandInput,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 7,
    })).rejects.toEqual(expect.objectContaining({
      code: 'CHECKPOINT_VERSION_CONFLICT',
      statusCode: 409,
    }));
  });

  it('leaves title ownership to atomic finalization and never invokes rename APIs', async () => {
    const { repository, service } = setupUnified();
    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);
    expect(repository.renameContext).not.toHaveBeenCalled();
    expect(repository.renameConversation).not.toHaveBeenCalled();
  });

  it('passes a Stage-free named intent to Workflow and atomically finalizes its returned state and projection', async () => {
    const stageProjection = {
      revision: 'workflow-v7',
      items: [
        { key: 'understand', label: '理解问题', status: 'completed', checkpointId: ids.checkpoint },
        { key: 'deliver', label: '交付', status: 'agent-is-writing', summary: '正在生成结果' },
      ],
    };
    const checkpoint = {
      workflowState: { fsm: 'deliver', iteration: 7 },
    };
    const memory = {
      user: [{ key: 'tone', value: 'concise', version: 3 }],
      context: [{ key: 'goal', value: 'ship', version: 2 }],
    };
    const memoryUpdates = [{ scope: 'context', key: 'goal', value: 'ship' }];
    const baseCheckpoint = {
      ...execution.baseCheckpoint,
      stageKey: null,
      snapshot: {
        workflowState: { fsm: 'understand' },
        stageProjection: {
          revision: 'workflow-v6',
          items: [{ key: 'understand', label: '理解问题', status: 'active' }],
        },
        memoryReferences: [],
        artifacts: [],
      },
    };
    const input = { type: 'named_intent' as const, key: 'summarize', content: '总结一下' };
    const { bridge, repository, service } = setupUnified({
      manifest: stageIndependentManifest,
      executionOverride: { stageKey: null, stages: [], baseCheckpoint, memory },
      bridgeResult: {
        replyEvents: [{ type: 'message', content: '总结已完成' }],
        checkpoint,
        stageProjection,
        contextTitle: '发布计划',
        conversationTitle: '首轮总结',
        memoryUpdates,
        artifactProposals: [],
        interrupt: null,
        diagnostics: { workflow_revision: 'workflow-v7', duration_ms: 31 },
      },
    });

    await service.createCommand(ids.user, {
      commandId: ids.command,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input,
      attachmentIds: [],
    });
    await service.executeCommand(ids.command);

    const bridgeInput = bridge.run.mock.calls[0]![0];
    expect(bridgeInput).toMatchObject({
      commandId: ids.command,
      userId: ids.user,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpoint,
      commandInput: input,
      attachments: [],
      history: unifiedExecution.history,
      memory,
    });
    expect(bridgeInput).not.toHaveProperty('stageKey');
    expect(bridgeInput).not.toHaveProperty('stages');

    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({
        checkpointId: expect.any(String),
        headCheckpointIdAtClaim: ids.checkpoint,
        reply: '总结已完成',
        workflowState: checkpoint.workflowState,
        stageProjection,
        contextTitle: '发布计划',
        conversationTitle: '首轮总结',
        memoryUpdates,
        attachmentIds: [],
      }),
      expect.any(Date),
    );
    expect(repository.failCommand).not.toHaveBeenCalled();
  });
});
