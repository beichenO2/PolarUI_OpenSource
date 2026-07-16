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
