import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMemoryRepository } from '../src/memory/repository.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const schema = 'memory_repository_integration';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  otherUser: '10000000-0000-4000-8000-000000000002',
  contextA: '20000000-0000-4000-8000-000000000001',
  contextB: '20000000-0000-4000-8000-000000000002',
  otherContext: '20000000-0000-4000-8000-000000000003',
  commandA: '30000000-0000-4000-8000-000000000001',
  commandB: '30000000-0000-4000-8000-000000000002',
  conversation: '40000000-0000-4000-8000-000000000001',
  checkpoint: '50000000-0000-4000-8000-000000000001',
};
const now = new Date('2026-07-18T08:00:00.000Z');

integrationDescribe('memory repository', () => {
  const adminPool = createPool(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  const repository = createMemoryRepository(pool);

  beforeAll(async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await adminPool.query('CREATE SCHEMA ' + schema);
    await runMigrations({ pool, migrationsDir });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'owner@example.test', 'owner@example.test', 'owner', 'owner', 'hash', now(), 'active', 'admin_cli'), ($2, 'other@example.test', 'other@example.test', 'other', 'other', 'hash', now(), 'active', 'admin_cli')",
      [ids.user, ids.otherUser],
    );
    await pool.query(
      "INSERT INTO contexts (id, user_id, title, status) VALUES ($1, $4, 'Context A', 'active'), ($2, $4, 'Context B', 'active'), ($3, $5, 'Other Context', 'active')",
      [ids.contextA, ids.contextB, ids.otherContext, ids.user, ids.otherUser],
    );
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  function appendWorkflowVersion(input: {
    contextId?: string;
    commandId?: string;
    update: Record<string, unknown>;
    changedAt?: Date;
  }) {
    return repository.appendWorkflowVersion({
      userId: ids.user,
      contextId: input.contextId ?? ids.contextA,
      commandId: input.commandId ?? ids.commandA,
      conversationId: ids.conversation,
      checkpointId: ids.checkpoint,
      update: input.update,
      now: input.changedAt ?? now,
    });
  }

  async function expectNoWorkflowCausalRows() {
    expect((await pool.query(
      'SELECT (SELECT count(*)::int FROM workflow_commands) AS commands, ' +
      '(SELECT count(*)::int FROM workflow_routes) AS routes, ' +
      '(SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints',
    )).rows).toEqual([{ commands: 0, routes: 0, checkpoints: 0 }]);
  }

  it('shares user memory across the owner Contexts, isolates context memory, and hides all cross-user reads', async () => {
    const userMemory = await appendWorkflowVersion({ update: {
      scope: 'user', key: 'tone', value: 'concise', evidence: [],
      impactScope: { contextIds: 'all' },
    } });
    const contextA = await appendWorkflowVersion({ update: {
      scope: 'context', key: 'goal', value: 'ship A', evidence: [],
      impactScope: { contextIds: [ids.contextA] },
    } });
    const contextB = await appendWorkflowVersion({
      contextId: ids.contextB,
      commandId: ids.commandB,
      update: {
        scope: 'context', key: 'goal', value: 'ship B', evidence: [],
        impactScope: { contextIds: [ids.contextB] },
      },
    });

    expect(userMemory).toMatchObject({ scope: 'user', contextId: null, key: 'tone', version: 1 });
    expect(contextA).toMatchObject({ scope: 'context', contextId: ids.contextA, value: 'ship A' });
    expect(contextB).toMatchObject({ scope: 'context', contextId: ids.contextB, value: 'ship B' });

    await expect(repository.listForWorkflow(ids.user, ids.contextA)).resolves.toMatchObject({
      user: [{ id: userMemory.id, key: 'tone' }],
      context: [{ id: contextA.id, key: 'goal', value: 'ship A' }],
    });
    await expect(repository.listForWorkflow(ids.user, ids.contextB)).resolves.toMatchObject({
      user: [{ id: userMemory.id, key: 'tone' }],
      context: [{ id: contextB.id, key: 'goal', value: 'ship B' }],
    });
    await expect(repository.listForWorkflow(ids.otherUser, ids.otherContext)).resolves.toEqual({
      user: [], context: [],
    });
    await expect(repository.list(ids.otherUser, { scope: 'user' })).resolves.toEqual([]);
    await expect(repository.listVersions(ids.otherUser, userMemory.id)).resolves.toBeNull();
    await expectNoWorkflowCausalRows();
  });

  it.each([
    ['route', '60000000-0000-4000-8000-000000000001'],
    ['stage', '60000000-0000-4000-8000-000000000002'],
    ['thread', '60000000-0000-4000-8000-000000000003'],
  ])('rejects a persisted %s memory identity at the schema boundary', async (scope, memoryId) => {
    await expect(pool.query(
      'INSERT INTO memory_items (id, user_id, scope, context_id, memory_key, status, current_version) ' +
      "VALUES ($1, $2, $3, $4, 'legacy-key', 'active', 1)",
      [memoryId, ids.user, scope, ids.contextA],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('appends revisions and an auditable invalidation tombstone while retaining immutable old versions', async () => {
    const initial = await appendWorkflowVersion({ update: {
      scope: 'context', key: 'goal', value: 'draft', evidence: [],
      impactScope: { contextIds: [ids.contextA] },
    } });
    const revised = await repository.revise(ids.user, initial.id, {
      value: 'launch',
      expectedVersion: 1,
      evidence: [{ kind: 'message', id: 'evidence-2' }],
    }, new Date(now.getTime() + 1000));
    const invalidated = await repository.invalidate(ids.user, initial.id, {
      expectedVersion: 2,
      reason: 'No longer true',
    }, new Date(now.getTime() + 2000));

    expect(revised).toMatchObject({ status: 'active', value: 'launch', version: 2 });
    expect(invalidated).toMatchObject({ status: 'invalidated', value: null, version: 3 });
    const versions = await repository.listVersions(ids.user, initial.id);
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, value: 'draft', status: 'active' }),
      expect.objectContaining({ version: 2, value: 'launch', status: 'active' }),
      expect.objectContaining({
        version: 3,
        value: null,
        status: 'invalidated',
        source: { kind: 'user' },
        evidence: [{ kind: 'invalidation_reason', id: 'user', excerpt: 'No longer true' }],
      }),
    ]);
    expect(await repository.list(ids.user, {
      scope: 'context', contextId: ids.contextA,
    })).toEqual([expect.objectContaining({
      id: initial.id, status: 'invalidated', version: 3, value: null,
    })]);

    await expect(pool.query(
      'UPDATE memory_item_versions SET value = $2 WHERE memory_id = $1 AND version = 1',
      [initial.id, 'rewritten'],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      'DELETE FROM memory_item_versions WHERE memory_id = $1 AND version = 1',
      [initial.id],
    )).rejects.toMatchObject({ code: '55000' });
    await expectNoWorkflowCausalRows();
  });

  it('requires the active expectedVersion and serializes concurrent updates by logical identity', async () => {
    const current = await appendWorkflowVersion({ update: {
      scope: 'context', key: 'goal', value: 'draft', evidence: [],
      impactScope: { contextIds: [ids.contextA] },
    } });
    await expect(repository.detectConflict({
      userId: ids.user,
      contextId: ids.contextA,
      update: { scope: 'context', key: 'goal', value: 'launch' },
    })).resolves.toMatchObject({ current: { id: current.id, version: 1 } });
    await expect(repository.detectConflict({
      userId: ids.user,
      contextId: ids.contextA,
      update: { scope: 'context', key: 'goal', value: 'launch', expectedVersion: 9 },
    })).resolves.toMatchObject({ current: { id: current.id, version: 1 } });

    const concurrentRevisions = await Promise.allSettled([
      repository.revise(ids.user, current.id, {
        value: 'launch A', expectedVersion: 1, evidence: [],
      }, new Date(now.getTime() + 1000)),
      repository.revise(ids.user, current.id, {
        value: 'launch B', expectedVersion: 1, evidence: [],
      }, new Date(now.getTime() + 1000)),
    ]);
    expect(concurrentRevisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrentRevisions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(concurrentRevisions.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'MEMORY_VERSION_CONFLICT' },
    });
    expect(await repository.listVersions(ids.user, current.id)).toEqual([
      expect.objectContaining({ version: 1, value: 'draft' }),
      expect.objectContaining({ version: 2, value: expect.stringMatching(/^launch [AB]$/) }),
    ]);

    const concurrent = await Promise.allSettled([
      appendWorkflowVersion({
        commandId: ids.commandA,
        update: { scope: 'user', key: 'taste', value: 'minimal', evidence: [], impactScope: { contextIds: 'all' } },
      }),
      appendWorkflowVersion({
        commandId: ids.commandB,
        update: { scope: 'user', key: 'taste', value: 'expressive', evidence: [], impactScope: { contextIds: 'all' } },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(concurrent.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'MEMORY_VERSION_CONFLICT' },
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM memory_items WHERE user_id=$1 AND scope='user' AND memory_key='taste'",
      [ids.user],
    )).rows).toEqual([{ count: 1 }]);
    await expectNoWorkflowCausalRows();
  });
});
