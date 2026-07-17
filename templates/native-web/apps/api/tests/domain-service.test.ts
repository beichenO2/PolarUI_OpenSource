import { describe, expect, it, vi } from 'vitest';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { createDomainService } from '../src/domain/service.js';
import type { DomainRepository } from '../src/domain/repository.js';

const manifest: ProductManifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://workflow.test/run' },
  stages: [
    { key: 'discover', label: '发现', component_key: 'generic_chat', internal_states: ['start', 'review'], actions: [] },
    { key: 'decide', label: '决策', component_key: 'structured_form', internal_states: ['waiting', 'ready'], actions: [] },
  ],
};

function setup(overrides: Partial<DomainRepository> = {}) {
  const causalWrites = {
    runWorkflow: vi.fn(),
    createCheckpoint: vi.fn(),
    createCommand: vi.fn(),
    writeMemory: vi.fn(),
    createRoute: vi.fn(),
  };
  const repository = {
    createContext: vi.fn(async (input) => input),
    listContexts: vi.fn(async () => []),
    getContextWorkspace: vi.fn(async () => null),
    getRouteWorkspace: vi.fn(async () => null),
    createConversation: vi.fn(async (input) => ({
      id: input.id,
      contextId: 'context-1',
      routeId: input.routeId,
      title: input.title,
      titleSource: input.titleSource,
      isPrimary: false,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
    })),
    renameContext: vi.fn(async (input) => ({
      id: input.contextId,
      title: input.title,
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
    })),
    updateConversation: vi.fn(async (input) => ({
      id: input.conversationId,
      contextId: 'context-1',
      routeId: 'route-1',
      title: input.title ?? 'Existing discussion',
      titleSource: input.title === undefined ? 'agent' : 'user',
      isPrimary: false,
      status: input.status ?? 'active',
      createdAt: input.now,
      updatedAt: input.now,
    })),
    createThread: vi.fn(async () => null),
    updateThread: vi.fn(async () => null),
    branchRoute: vi.fn(async () => null),
    ...causalWrites,
    ...overrides,
  } as unknown as DomainRepository;
  const values = [
    '20000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
  ];
  const service = createDomainService({
    repository,
    manifest,
    createId: () => values.shift()!,
    now: () => new Date('2026-07-15T16:00:00.000Z'),
  });
  return { repository, service, causalWrites };
}

describe('workflow domain service', () => {
  it('trims context titles and bootstraps without a selected Stage', async () => {
    const { repository, service } = setup();
    await service.createContext('user-1', { title: '  Research project  ' });
    expect(repository.createContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      title: 'Research project',
      routeName: '路线 1',
      stages: [],
    }));
  });

  it.each(['', ' '.repeat(4), 'x'.repeat(121)])('rejects invalid titles', async (title) => {
    const { service } = setup();
    await expect(service.createContext('user-1', { title }))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_REQUEST', statusCode: 400 }));
  });

  it('returns not found for inaccessible resources', async () => {
    const { service } = setup({
      createConversation: vi.fn(async () => null) as never,
    });
    await expect(service.getContextWorkspace('user-1', 'context-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND', statusCode: 404 }));
    await expect(service.createConversation('user-1', 'route-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND', statusCode: 404 }));
  });

  it('returns a Stage-independent immutable historical workspace', async () => {
    const artifact = {
      id: '60000000-0000-4000-8000-000000000001',
      stage_key: null,
      filename: 'historical.txt',
      media_type: 'text/plain',
      byte_size: 12,
      sha256: 'a'.repeat(64),
      created_at: '2026-07-15T15:00:00.000Z',
    };
    const selectedProjection = {
      revision: 'historical-r1',
      items: [{ key: 'unexpected_runtime_step', label: '运行时步骤', status: 'blocked' }],
    };
    const repositoryWorkspace = {
      context: { id: 'context-1' },
      route: { id: 'route-1', headCheckpointId: 'head-1' },
      conversations: [{ id: 'conversation-1', status: 'active' }],
      checkpoints: [
        {
          id: 'old-1',
          snapshot: {
            workflowState: {},
            stageProjection: selectedProjection,
            memoryReferences: [],
            artifacts: [artifact],
          },
        },
        {
          id: 'head-1',
          snapshot: {
            workflowState: {},
            stageProjection: {
              revision: 'head-r2',
              items: [{ key: 'another_runtime_step', label: '另一运行步骤', status: 'done' }],
            },
            memoryReferences: [],
            artifacts: [],
          },
        },
      ],
    };
    const getRouteWorkspace = vi.fn(async () => repositoryWorkspace);
    const { repository, service, causalWrites } = setup({
      getRouteWorkspace: getRouteWorkspace as never,
    });
    const historical = await service.getRouteWorkspace('user-1', 'route-1', {
      checkpointId: 'old-1',
    });
    const head = await service.getRouteWorkspace('user-1', 'route-1', {});

    expect(historical).toMatchObject({
      route: { id: 'route-1', headCheckpointId: 'head-1' },
      conversations: [{ id: 'conversation-1' }],
      selectedCheckpoint: { id: 'old-1' },
      headCheckpoint: { id: 'head-1' },
      isHistorical: true,
      stageProjection: selectedProjection,
      artifacts: [artifact],
    });
    expect(head).toMatchObject({
      selectedCheckpoint: { id: 'head-1' },
      headCheckpoint: { id: 'head-1' },
      isHistorical: false,
      artifacts: [],
    });
    expect(getRouteWorkspace).toHaveBeenNthCalledWith(1, 'user-1', 'route-1');
    expect(getRouteWorkspace).toHaveBeenNthCalledWith(2, 'user-1', 'route-1');
    expect(repository.branchRoute).not.toHaveBeenCalled();
    for (const write of Object.values(causalWrites)) expect(write).not.toHaveBeenCalled();
  });

  it('creates an initializing agent-titled Conversation without title or Stage input', async () => {
    const createConversation = vi.fn(async (input) => ({ id: input.id }));
    const { repository, service } = setup({ createConversation: createConversation as never });
    await service.createConversation('user-1', 'route-1');

    expect(repository.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      routeId: 'route-1',
      titleSource: 'agent',
      status: 'initializing',
    }));
    const input = createConversation.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('stageKey');
  });

  it('renames Context and updates Conversation metadata without causal writes', async () => {
    const { repository, service, causalWrites } = setup();
    await service.renameContext('user-1', 'context-1', { title: '  同名  ' });
    await service.updateConversation('user-1', 'conversation-1', {
      title: '  同名  ',
      status: 'archived',
    });

    expect(repository.renameContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      contextId: 'context-1',
      title: '同名',
    }));
    expect(repository.updateConversation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      conversationId: 'conversation-1',
      title: '同名',
      status: 'archived',
    }));
    expect(repository.branchRoute).not.toHaveBeenCalled();
    for (const write of Object.values(causalWrites)) expect(write).not.toHaveBeenCalled();
  });

  it('creates a named branch with fresh identifiers', async () => {
    const branchRoute = vi.fn(async (input) => ({ route: { id: input.routeId }, checkpoint: { id: input.checkpointId } }));
    const { repository, service } = setup({ branchRoute: branchRoute as never });
    const result = await service.branchRoute('user-1', 'context-1', {
      sourceCheckpointId: 'checkpoint-1',
      name: '  Alternative  ',
    });
    expect(repository.branchRoute).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      contextId: 'context-1',
      sourceCheckpointId: 'checkpoint-1',
      routeName: 'Alternative',
    }));
    expect(result.route.id).toMatch(/^20000000-/);
    expect(result.checkpoint.id).toMatch(/^30000000-/);
  });
});
