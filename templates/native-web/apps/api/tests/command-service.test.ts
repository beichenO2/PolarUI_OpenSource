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
  memoryConflict?: unknown;
  assetService?: {
    prepareArtifact: ReturnType<typeof vi.fn>;
    saveArtifact: ReturnType<typeof vi.fn>;
  };
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
    persistInterrupt: vi.fn(async () => ({ status: 'succeeded', pendingInterrupt: true })),
    renameContext: vi.fn(),
    renameConversation: vi.fn(),
  };
  const bridge = {
    run: vi.fn(async () => {
      if (options.bridgeError) throw options.bridgeError;
      if (options.bridgeResult) return options.bridgeResult;
      return {
        replyEvents: [{ type: 'message', content: 'Answer' }],
        checkpoint: { workflowState: {} },
        memoryUpdates: [],
        artifactProposals: [],
        interrupt: null,
        diagnostics: {},
      };
    }),
  };
  const memoryRepository = {
    detectConflict: vi.fn(async () => options.memoryConflict ?? null),
  };
  const generated = Array.from({ length: 16 }, (_, index) =>
    `21000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const service = createCommandService({
    repository: repository as never,
    bridge: bridge as never,
    memoryRepository: memoryRepository as never,
    ...(options.assetService ? { assetService: options.assetService as never } : {}),
    manifest: options.manifest ?? manifest,
    createId: () => generated.shift()!,
    now: () => new Date('2026-07-16T10:00:00.000Z'),
  });
  return { repository, bridge, memoryRepository, service };
}

describe('unified workflow input command', () => {
  it('prepares Workflow artifacts before atomic finalization and never saves them afterward', async () => {
    const ready = {
      status: 'ready' as const,
      id: '22000000-0000-4000-8000-000000000001',
      objectId: '22000000-0000-4000-8000-000000000002',
      filename: 'result.txt',
      mediaType: 'text/plain',
      byteSize: 6,
      sha256: 'a'.repeat(64),
    };
    const failed = {
      status: 'failed' as const,
      id: '22000000-0000-4000-8000-000000000003',
      filename: 'broken.bin',
      errorCode: 'ARTIFACT_STORAGE_FAILED',
    };
    const assetService = {
      prepareArtifact: vi.fn()
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce(failed),
      saveArtifact: vi.fn(),
    };
    const proposals = [
      { filename: 'result.txt', mediaType: 'text/plain', body: Buffer.from('result') },
      { filename: 'broken.bin', mediaType: 'application/octet-stream', body: Buffer.from('broken') },
    ];
    const { repository, service } = setupUnified({
      assetService,
      bridgeResult: {
        replyEvents: [{ type: 'message', content: 'Artifacts prepared' }],
        checkpoint: { workflowState: {} },
        memoryUpdates: [],
        artifactProposals: proposals,
        interrupt: null,
        diagnostics: {},
      },
    });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(assetService.prepareArtifact.mock.calls).toEqual([
      [ids.user, proposals[0]],
      [ids.user, proposals[1]],
    ]);
    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({ preparedArtifacts: [ready, failed] }),
      expect.any(Date),
    );
    expect(assetService.prepareArtifact.mock.invocationCallOrder[1])
      .toBeLessThan(repository.finalizeCommand.mock.invocationCallOrder[0]!);
    expect(assetService.saveArtifact).not.toHaveBeenCalled();
  });

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

  it.each([
    ['top-level value getter', () => Object.defineProperty({
      scope: 'context', key: 'goal',
    }, 'value', {
      enumerable: true,
      get: () => 'ship',
    })],
    ['top-level symbol metadata', () => {
      const update: Record<PropertyKey, unknown> = {
        scope: 'context', key: 'goal', value: 'ship',
      };
      update[Symbol('hidden')] = true;
      return update;
    }],
    ['top-level non-enumerable metadata', () => Object.defineProperty({
      scope: 'context', key: 'goal', value: 'ship',
    }, 'hidden', {
      enumerable: false,
      value: true,
    })],
    ['evidence accessor', () => ({
      scope: 'context',
      key: 'goal',
      value: 'ship',
      evidence: [Object.defineProperty({ id: 'message-1' }, 'kind', {
        enumerable: true,
        get: () => 'message',
      })],
    })],
    ['impact-scope accessor', () => ({
      scope: 'context',
      key: 'goal',
      value: 'ship',
      impactScope: Object.defineProperty({}, 'contextIds', {
        enumerable: true,
        get: () => [ids.context],
      }),
    })],
  ] satisfies Array<[string, () => object]>)('rejects custom bridge %s before using memory metadata', async (_label, createUpdate) => {
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Mutable memory metadata' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [createUpdate()],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).not.toHaveBeenCalled();
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('uses an immutable memory snapshot when the custom bridge object changes during preflight', async () => {
    const update: { scope: 'context'; key: string; value: unknown } = {
      scope: 'context',
      key: 'goal',
      value: 'ship',
    };
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Snapshot memory' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [update],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });
    memoryRepository.detectConflict.mockImplementation(async () => {
      update.value = undefined;
      return null;
    });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    const checkedUpdate = memoryRepository.detectConflict.mock.calls[0]![0].update;
    expect(checkedUpdate).not.toBe(update);
    expect(checkedUpdate).toEqual({ scope: 'context', key: 'goal', value: 'ship' });
    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({
        memoryUpdates: [{ scope: 'context', key: 'goal', value: 'ship' }],
      }),
      expect.any(Date),
    );
    expect(repository.failCommand).not.toHaveBeenCalled();
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

  it('fails safely without finalizing when a unified bridge returns a legacy-shaped runtime result', async () => {
    const { repository, service } = setupUnified({ bridgeResult: {
      reply: 'Legacy answer',
      stageSignals: [],
      workflowCursor: null,
      memoryProposals: [],
      artifactProposals: [],
      interrupt: null,
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('fails safely without finalizing when a unified bridge omits required v2 checkpoint state', async () => {
    const { repository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Malformed answer' }],
      checkpoint: {},
      memoryUpdates: [],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('fails safely when a custom v2 bridge returns malformed memory metadata', async () => {
    const { repository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Malformed memory' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [{
        scope: 'context', key: 'goal', value: 'ship',
        evidence: [{ kind: 'message' }],
      }],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it.each([
    ['undefined', () => undefined],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['function', () => () => 'not-json'],
    ['Symbol', () => Symbol('not-json')],
    ['BigInt', () => BigInt(1)],
    ['cyclic object', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
    ['Date instance', () => new Date('2026-07-19T00:00:00.000Z')],
    ['sparse array', () => {
      const value: unknown[] = [];
      value[1] = 'lossy';
      return value;
    }],
    ['symbol-keyed object', () => {
      const value: Record<PropertyKey, unknown> = { visible: true };
      value[Symbol('hidden')] = true;
      return value;
    }],
    ['accessor object', () => Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'lossy',
    })],
    ['non-enumerable property', () => Object.defineProperty({ visible: true }, 'hidden', {
      enumerable: false,
      value: true,
    })],
  ] satisfies Array<[string, () => unknown]>)('fails safely before memory/finalization for a custom bridge %s memory value', async (_label, createValue) => {
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Malformed memory value' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [{ scope: 'context', key: 'goal', value: createValue() }],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).not.toHaveBeenCalled();
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('rejects a custom bridge memory key that is not already canonical and trimmed', async () => {
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Malformed memory key' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [{ scope: 'context', key: ' goal ', value: 'ship' }],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).not.toHaveBeenCalled();
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('rejects more than 1000 custom bridge memory updates before conflict detection', async () => {
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Too many memory updates' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: Array.from({ length: 1001 }, (_, index) => ({
        scope: 'context' as const,
        key: `key-${index}`,
        value: index,
      })),
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).not.toHaveBeenCalled();
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('rejects custom bridge memory values above the aggregate response budget', async () => {
    const { repository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Oversized memory values' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: Array.from({ length: 40 }, (_, index) => ({
        scope: 'context' as const,
        key: `large-${index}`,
        value: 'x'.repeat(950_000),
      })),
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).toHaveBeenCalledWith(
      ids.command,
      'WORKFLOW_INVALID_RESPONSE',
      expect.any(Date),
    );
  });

  it('accepts a custom bridge memory update with a nested JSON value', async () => {
    const update = {
      scope: 'context' as const,
      key: 'goal',
      value: {
        title: 'Ship',
        enabled: true,
        score: 1.25,
        optional: null,
        milestones: ['design', { name: 'release', done: false }, [1, 2, 3]],
      },
    };
    const { repository, memoryRepository, service } = setupUnified({ bridgeResult: {
      replyEvents: [{ type: 'message', content: 'Valid nested memory' }],
      checkpoint: { workflowState: {} },
      memoryUpdates: [update],
      artifactProposals: [],
      interrupt: null,
      diagnostics: {},
    } });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).toHaveBeenCalledWith({
      userId: ids.user,
      contextId: ids.context,
      update,
    });
    expect(repository.persistInterrupt).not.toHaveBeenCalled();
    expect(repository.finalizeCommand).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({ memoryUpdates: [update] }),
      expect.any(Date),
    );
    expect(repository.failCommand).not.toHaveBeenCalled();
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
    const consumedMemoryReferences = [
      { memoryId: '30000000-0000-4000-8000-000000000001', version: 3 },
      { memoryId: '30000000-0000-4000-8000-000000000002', version: 2 },
    ];
    const memory = {
      user: [{ id: consumedMemoryReferences[0]!.memoryId, key: 'tone', value: 'concise', version: 3 }],
      context: [{ id: consumedMemoryReferences[1]!.memoryId, key: 'goal', value: 'ship', version: 2 }],
    };
    const memoryUpdates = [{
      scope: 'context' as const,
      key: 'goal',
      value: 'ship',
      expectedVersion: 2,
      evidence: [{ kind: 'message', id: 'evidence-1' }],
      impactScope: { contextIds: [ids.context] },
    }];
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
        workflowRevision: 'workflow-v7',
        stageProjection,
        contextTitle: '发布计划',
        conversationTitle: '首轮总结',
        attachmentIds: [],
        memoryUpdates,
        consumedMemoryReferences,
      }),
      expect.any(Date),
    );
    expect(repository.failCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['missing expectedVersion', {
      scope: 'context' as const,
      key: 'goal',
      value: 'launch',
      confirmationPrompt: '确认覆盖当前目标？',
    }],
    ['mismatched expectedVersion', {
      scope: 'context' as const,
      key: 'goal',
      value: 'launch',
      expectedVersion: 9,
      confirmationPrompt: '确认覆盖当前目标？',
    }],
  ])('persists a private memory confirmation interrupt for an active-key update with %s', async (_label, update) => {
    const current = {
      id: '31000000-0000-4000-8000-000000000001',
      scope: 'context',
      contextId: ids.context,
      key: 'goal',
      value: 'ship',
      status: 'active',
      version: 2,
    };
    const { repository, memoryRepository, service } = setupUnified({
      memoryConflict: { current },
      bridgeResult: {
        replyEvents: [{ type: 'message', content: '建议更新目标' }],
        checkpoint: { workflowState: { fsm: 'review' } },
        memoryUpdates: [update],
        artifactProposals: [],
        interrupt: null,
        diagnostics: {},
      },
    });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).toHaveBeenCalledWith({
      userId: ids.user,
      contextId: ids.context,
      update,
    });
    expect(repository.persistInterrupt).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({
        id: expect.any(String),
        prompt: '确认覆盖当前目标？',
        cursor: { kind: 'memory_confirmation', update, current },
      }),
      expect.any(Date),
    );
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
    expect(repository.failCommand).not.toHaveBeenCalled();
  });

  it('turns a high-impact update into an interrupt even without a version conflict', async () => {
    const update = {
      scope: 'user' as const,
      key: 'decision_style',
      value: 'risk-seeking',
      highImpact: true,
      confirmationPrompt: '确认记录这项高影响用户特征？',
    };
    const { repository, memoryRepository, service } = setupUnified({
      bridgeResult: {
        replyEvents: [{ type: 'message', content: '发现一项可能的用户特征' }],
        checkpoint: { workflowState: { fsm: 'review' } },
        memoryUpdates: [update],
        artifactProposals: [],
        interrupt: null,
        diagnostics: {},
      },
    });

    await service.createCommand(ids.user, startCommandInput);
    await service.executeCommand(ids.command);

    expect(memoryRepository.detectConflict).toHaveBeenCalledWith({
      userId: ids.user,
      contextId: ids.context,
      update,
    });
    expect(repository.persistInterrupt).toHaveBeenCalledWith(
      ids.command,
      expect.objectContaining({
        prompt: '确认记录这项高影响用户特征？',
        cursor: { kind: 'memory_confirmation', update, current: undefined },
      }),
      expect.any(Date),
    );
    expect(repository.finalizeCommand).not.toHaveBeenCalled();
  });

  it('sends only the repository-loaded private cursor when unified Input resumes an interrupt', async () => {
    const privateCursor = { kind: 'memory_confirmation', token: 'postgres-only' };
    const { bridge, service } = setupUnified({ executionOverride: { interruptCursor: privateCursor } });
    await service.createCommand(ids.user, {
      commandId: ids.command,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input: { type: 'resume_interrupt', interruptId: ids.interrupt, content: '确认' },
      attachmentIds: [],
    });
    await service.executeCommand(ids.command);

    expect(bridge.run).toHaveBeenCalledWith(expect.objectContaining({
      commandInput: { type: 'resume_interrupt', interruptId: ids.interrupt, content: '确认' },
      interruptCursor: privateCursor,
    }));
    expect(bridge.run.mock.calls[0]![0].commandInput).not.toHaveProperty('cursor');
  });
});
