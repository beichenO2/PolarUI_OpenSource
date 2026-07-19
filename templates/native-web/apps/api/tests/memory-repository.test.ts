import { describe, expect, it, vi } from 'vitest';
import {
  appendWorkflowVersionsWithClient,
  createMemoryRepository,
} from '../src/memory/repository.js';

describe('memory repository mapping', () => {
  it('returns every historical version as the one complete public MemoryItem shape', async () => {
    const itemCreatedAt = new Date('2026-07-18T07:00:00.000Z');
    const versionCreatedAt = new Date('2026-07-18T08:00:00.000Z');
    const versionRow = {
      memory_id: '30000000-0000-4000-8000-000000000001',
      scope: 'context',
      context_id: '20000000-0000-4000-8000-000000000001',
      memory_key: 'goal',
      value: 'ship',
      status: 'active',
      version: 2,
      source: {
        kind: 'workflow',
        commandId: '40000000-0000-4000-8000-000000000001',
        conversationId: '50000000-0000-4000-8000-000000000001',
        checkpointId: '60000000-0000-4000-8000-000000000001',
      },
      evidence: [{ kind: 'message', id: 'evidence-1' }],
      impact_scope: { contextIds: ['20000000-0000-4000-8000-000000000001'] },
      item_created_at: itemCreatedAt,
      version_created_at: versionCreatedAt,
    };
    const pool = {
      query: vi.fn(async (sql: string) => sql.startsWith('SELECT 1 FROM memory_items')
        ? { rows: [{ owned: true }] }
        : { rows: [versionRow] }),
    };
    const repository = createMemoryRepository(pool as never);

    await expect(repository.listVersions(
      '10000000-0000-4000-8000-000000000001',
      versionRow.memory_id,
    )).resolves.toEqual([{
      id: versionRow.memory_id,
      scope: 'context',
      contextId: versionRow.context_id,
      key: 'goal',
      value: 'ship',
      status: 'active',
      version: 2,
      source: {
        kind: 'workflow',
        commandId: '40000000-0000-4000-8000-000000000001',
        conversationId: '50000000-0000-4000-8000-000000000001',
      },
      evidence: [{ kind: 'message', id: 'evidence-1' }],
      impactScope: { contextIds: [versionRow.context_id] },
      createdAt: itemCreatedAt,
      updatedAt: versionCreatedAt,
    }]);
  });
});

describe('workflow memory batch writes', () => {
  it('takes identity locks in sorted order and blocks a conflict before any write', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const contextId = '20000000-0000-4000-8000-000000000001';
    const advisoryKeys: string[] = [];
    const mutations: string[] = [];
    const row = (key: string) => ({
      id: key === 'alpha'
        ? '30000000-0000-4000-8000-000000000001'
        : '30000000-0000-4000-8000-000000000002',
      scope: 'context',
      context_id: contextId,
      memory_key: key,
      item_status: 'active',
      current_version: 1,
      value: key + '-v1',
      source: { kind: 'workflow' },
      evidence: [],
      impact_scope: { contextIds: [contextId] },
      created_at: new Date('2026-07-18T08:00:00.000Z'),
      updated_at: new Date('2026-07-18T08:00:00.000Z'),
    });
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('SELECT 1 FROM contexts')) return { rows: [{ owned: true }] };
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
          advisoryKeys.push(String(params[0]));
          return { rows: [] };
        }
        if (sql.includes('i.memory_key = $4')) {
          return { rows: [row(String(params[3]))] };
        }
        if (sql.startsWith('INSERT ') || sql.startsWith('UPDATE ')) mutations.push(sql);
        return { rows: [] };
      }),
    };
    const updates = [
      {
        scope: 'context' as const,
        key: 'zeta',
        value: 'zeta-v2',
        expectedVersion: 1,
        evidence: [],
        impactScope: { contextIds: [contextId] },
      },
      {
        scope: 'context' as const,
        key: 'alpha',
        value: 'alpha-v2',
        expectedVersion: 7,
        evidence: [],
        impactScope: { contextIds: [contextId] },
      },
    ];

    const result = await appendWorkflowVersionsWithClient(client as never, {
      userId,
      contextId,
      commandId: '40000000-0000-4000-8000-000000000001',
      conversationId: '50000000-0000-4000-8000-000000000001',
      checkpointId: '60000000-0000-4000-8000-000000000001',
      updates,
      now: new Date('2026-07-18T09:00:00.000Z'),
    });

    expect(advisoryKeys).toEqual(
      ['alpha', 'zeta']
        .map((key) => JSON.stringify([userId, 'context', contextId, key]))
        .sort(),
    );
    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'version_conflict',
      update: updates[1],
      current: { key: 'alpha', version: 1 },
    });
    expect(mutations).toEqual([]);
  });

  it('blocks a duplicate logical identity before any write', async () => {
    const userId = '10000000-0000-4000-8000-000000000001';
    const contextId = '20000000-0000-4000-8000-000000000001';
    const mutations: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT 1 FROM contexts')) return { rows: [{ owned: true }] };
        if (sql.startsWith('INSERT ') || sql.startsWith('UPDATE ')) mutations.push(sql);
        return { rows: [] };
      }),
    };
    const updates = [
      { scope: 'context' as const, key: 'goal', value: 'first' },
      { scope: 'context' as const, key: 'goal', value: 'second' },
    ];

    const result = await appendWorkflowVersionsWithClient(client as never, {
      userId,
      contextId,
      commandId: '40000000-0000-4000-8000-000000000001',
      conversationId: '50000000-0000-4000-8000-000000000001',
      checkpointId: '60000000-0000-4000-8000-000000000001',
      updates,
      now: new Date('2026-07-18T09:00:00.000Z'),
    });

    expect(result).toEqual({
      kind: 'blocked',
      reason: 'duplicate_update',
      update: updates[1],
      current: null,
    });
    expect(mutations).toEqual([]);
  });
});
