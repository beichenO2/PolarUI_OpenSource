import { describe, expect, it, vi } from 'vitest';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { createDomainService, DomainError } from '../src/domain/service.js';
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
  const repository = {
    createContext: vi.fn(async (input) => input),
    listContexts: vi.fn(async () => []),
    getContextWorkspace: vi.fn(async () => null),
    getRouteWorkspace: vi.fn(async () => null),
    createThread: vi.fn(async () => null),
    updateThread: vi.fn(async () => null),
    branchRoute: vi.fn(async () => null),
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
  return { repository, service };
}

describe('workflow domain service', () => {
  it('trims context titles and bootstraps manifest stage projections', async () => {
    const { repository, service } = setup();
    await service.createContext('user-1', { title: '  Research project  ' });
    expect(repository.createContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      title: 'Research project',
      routeName: '路线 1',
      stages: [
        { stageKey: 'discover', position: 0, status: 'active', internalState: 'start' },
        { stageKey: 'decide', position: 1, status: 'not_started', internalState: 'waiting' },
      ],
    }));
  });

  it.each(['', ' '.repeat(4), 'x'.repeat(121)])('rejects invalid titles', async (title) => {
    const { service } = setup();
    await expect(service.createContext('user-1', { title }))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_REQUEST', statusCode: 400 }));
  });

  it('rejects unknown stages before repository access', async () => {
    const { repository, service } = setup();
    await expect(service.getRouteWorkspace('user-1', 'route-1', { stageKey: 'missing' }))
      .rejects.toBeInstanceOf(DomainError);
    expect(repository.getRouteWorkspace).not.toHaveBeenCalled();
  });

  it('returns not found for inaccessible resources', async () => {
    const { service } = setup();
    await expect(service.getContextWorkspace('user-1', 'context-1'))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND', statusCode: 404 }));
    await expect(service.createThread('user-1', 'route-1', { stageKey: 'discover', title: 'Topic' }))
      .rejects.toEqual(expect.objectContaining({ code: 'NOT_FOUND', statusCode: 404 }));
  });

  it('renders historical and head stages from their respective checkpoint snapshots', async () => {
    const repositoryWorkspace = {
      context: { id: 'context-1' },
      route: { id: 'route-1', headCheckpointId: 'head-1' },
      stages: [
        { stageKey: 'discover', position: 0, status: 'not_started', internalState: 'review' },
        { stageKey: 'decide', position: 1, status: 'completed', internalState: 'ready' },
      ],
      checkpoints: [
        {
          id: 'old-1',
          snapshot: { stages: [
            { stage_key: 'decide', status: 'not_started', internal_state: 'waiting' },
            { stage_key: 'discover', status: 'active', internal_state: 'start' },
          ] },
        },
        {
          id: 'head-1',
          snapshot: { stages: [
            { stage_key: 'discover', status: 'completed', internal_state: 'review' },
            { stage_key: 'decide', status: 'active', internal_state: 'ready' },
          ] },
        },
      ],
      threads: [],
    };
    const { service } = setup({ getRouteWorkspace: vi.fn(async () => repositoryWorkspace) as never });
    const historical = await service.getRouteWorkspace('user-1', 'route-1', {
      stageKey: 'decide', checkpointId: 'old-1',
    });
    const head = await service.getRouteWorkspace('user-1', 'route-1', { stageKey: 'decide' });

    expect(historical.selectedCheckpoint.id).toBe('old-1');
    expect(historical.isHistorical).toBe(true);
    expect(historical.route.headCheckpointId).toBe('head-1');
    expect(historical.stages).toEqual([
      {
        stageKey: 'discover', position: 0, status: 'active', internalState: 'start',
        label: '发现', componentKey: 'generic_chat',
      },
      {
        stageKey: 'decide', position: 1, status: 'not_started', internalState: 'waiting',
        label: '决策', componentKey: 'structured_form',
      },
    ]);
    expect(head.selectedCheckpoint.id).toBe('head-1');
    expect(head.isHistorical).toBe(false);
    expect(head.stages.map(({ status, internalState }) => ({ status, internalState }))).toEqual([
      { status: 'completed', internalState: 'review' },
      { status: 'active', internalState: 'ready' },
    ]);
  });

  it.each([
    ['missing stage', [
      { stage_key: 'discover', status: 'active', internal_state: 'start' },
    ]],
    ['unknown stage', [
      { stage_key: 'discover', status: 'active', internal_state: 'start' },
      { stage_key: 'missing', status: 'not_started', internal_state: 'waiting' },
    ]],
    ['duplicate stage', [
      { stage_key: 'discover', status: 'active', internal_state: 'start' },
      { stage_key: 'discover', status: 'not_started', internal_state: 'start' },
    ]],
    ['invalid status', [
      { stage_key: 'discover', status: 'paused', internal_state: 'start' },
      { stage_key: 'decide', status: 'not_started', internal_state: 'waiting' },
    ]],
    ['invalid internal state', [
      { stage_key: 'discover', status: 'active', internal_state: 'unknown' },
      { stage_key: 'decide', status: 'not_started', internal_state: 'waiting' },
    ]],
  ])('rejects a corrupt checkpoint snapshot with %s', async (_case, stages) => {
    const repositoryWorkspace = {
      context: { id: 'context-1' },
      route: { id: 'route-1', headCheckpointId: 'head-1' },
      stages: [],
      checkpoints: [{ id: 'head-1', snapshot: { stages } }],
      threads: [],
    };
    const { service } = setup({ getRouteWorkspace: vi.fn(async () => repositoryWorkspace) as never });

    await expect(service.getRouteWorkspace('user-1', 'route-1', { stageKey: 'discover' }))
      .rejects.toEqual(expect.objectContaining({ code: 'DOMAIN_STATE_INVALID', statusCode: 503 }));
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
