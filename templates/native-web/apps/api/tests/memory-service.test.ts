import { describe, expect, it, vi } from 'vitest';
import { createMemoryService, MemoryServiceError } from '../src/memory/service.js';

const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  otherUser: '10000000-0000-4000-8000-000000000002',
  context: '20000000-0000-4000-8000-000000000001',
  memory: '30000000-0000-4000-8000-000000000001',
};
const now = new Date('2026-07-18T08:00:00.000Z');
const memory = {
  id: ids.memory,
  scope: 'context' as const,
  contextId: ids.context,
  key: 'goal',
  value: 'ship',
  status: 'active' as const,
  version: 2,
  source: { kind: 'workflow' as const, commandId: '40000000-0000-4000-8000-000000000001' },
  evidence: [{ kind: 'message', id: '50000000-0000-4000-8000-000000000001' }],
  impactScope: { contextIds: [ids.context] },
  createdAt: new Date('2026-07-18T07:00:00.000Z'),
  updatedAt: now,
};

function setup() {
  const repository = {
    list: vi.fn(async (userId: string) => userId === ids.user ? [memory] : []),
    listVersions: vi.fn(async (userId: string) => userId === ids.user ? [
      { ...memory, value: 'draft', version: 1, updatedAt: memory.createdAt },
      memory,
    ] : null),
    revise: vi.fn(async (userId: string, _memoryId: string, input: any, changedAt: Date) =>
      userId === ids.user
        ? { ...memory, value: input.value, evidence: input.evidence ?? [], version: 3, updatedAt: changedAt }
        : null),
    invalidate: vi.fn(async (userId: string, _memoryId: string, input: any, changedAt: Date) =>
      userId === ids.user
        ? { ...memory, value: null, status: 'invalidated', version: 3, evidence: [
          { kind: 'invalidation_reason', id: 'user', excerpt: input.reason },
        ], updatedAt: changedAt }
        : null),
  };
  const service = createMemoryService({ repository: repository as any, now: () => now });
  return { service, repository };
}

describe('memory service', () => {
  it('lists only the two public layers and requires a Context for context memory', async () => {
    const { service, repository } = setup();

    await expect(service.list(ids.user, { scope: 'user' })).resolves.toEqual([memory]);
    await expect(service.list(ids.user, { scope: 'context', contextId: ids.context }))
      .resolves.toEqual([memory]);
    expect(repository.list).toHaveBeenNthCalledWith(1, ids.user, { scope: 'user' });
    expect(repository.list).toHaveBeenNthCalledWith(2, ids.user, {
      scope: 'context', contextId: ids.context,
    });
    await expect(service.list(ids.user, { scope: 'context' } as never))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });
  });

  it.each(['route', 'stage', 'thread'])('rejects the legacy %s public scope', async (scope) => {
    const { service, repository } = setup();
    await expect(service.list(ids.user, { scope } as never))
      .rejects.toBeInstanceOf(MemoryServiceError);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('returns repository history and maps a missing owned item to a hidden 404', async () => {
    const { service } = setup();
    await expect(service.listVersions(ids.user, ids.memory)).resolves.toEqual([
      { ...memory, value: 'draft', version: 1, updatedAt: memory.createdAt },
      memory,
    ]);
    await expect(service.listVersions(ids.otherUser, ids.memory))
      .rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('passes a validated revision to the versioned repository', async () => {
    const { service, repository } = setup();
    const revised = await service.revise(ids.user, ids.memory, {
      value: 'launch',
      expectedVersion: 2,
      evidence: [{ kind: 'message', id: '50000000-0000-4000-8000-000000000002' }],
    });

    expect(revised).toMatchObject({ value: 'launch', status: 'active', version: 3 });
    expect(repository.revise).toHaveBeenCalledWith(ids.user, ids.memory, {
      value: 'launch',
      expectedVersion: 2,
      evidence: [{ kind: 'message', id: '50000000-0000-4000-8000-000000000002' }],
    }, now);
  });

  it('returns the repository append result for an auditable invalidation tombstone', async () => {
    const { service } = setup();
    await expect(service.invalidate(ids.user, ids.memory, {
      expectedVersion: 2,
      reason: 'No longer true',
    })).resolves.toMatchObject({
      value: null,
      status: 'invalidated',
      version: 3,
      evidence: [{ kind: 'invalidation_reason', id: 'user', excerpt: 'No longer true' }],
    });
  });

  it.each([
    [{ value: 'launch' }],
    [{ value: 'launch', expectedVersion: 0 }],
    [{ value: 'launch', expectedVersion: 1.5 }],
  ])('requires a positive integer expectedVersion for revision', async (input) => {
    const { service, repository } = setup();
    await expect(service.revise(ids.user, ids.memory, input as never))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', statusCode: 400 });
    expect(repository.revise).not.toHaveBeenCalled();
  });
});
