import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDomainRepository } from '../src/domain/repository.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const schema = 'domain_repository_integration';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  otherUser: '10000000-0000-4000-8000-000000000002',
  context: '20000000-0000-4000-8000-000000000001',
  route: '30000000-0000-4000-8000-000000000001',
  checkpoint: '40000000-0000-4000-8000-000000000001',
  thread: '50000000-0000-4000-8000-000000000001',
};
const stages = [
  { stageKey: 'discover', position: 0, status: 'active' as const, internalState: 'start' },
  { stageKey: 'decide', position: 1, status: 'not_started' as const, internalState: 'waiting' },
];

integrationDescribe('workflow domain repository', () => {
  const adminPool = createPool(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  const repository = createDomainRepository(pool);
  const now = new Date('2026-07-15T15:00:00.000Z');

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
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  async function createContext() {
    return repository.createContext({
      userId: ids.user,
      contextId: ids.context,
      title: 'Research project',
      routeId: ids.route,
      routeName: 'Main route',
      checkpointId: ids.checkpoint,
      stages,
      now,
    });
  }

  it('bootstraps a context, route, projections, and immutable checkpoint atomically', async () => {
    const created = await createContext();
    expect(created).toMatchObject({
      context: { id: ids.context, title: 'Research project' },
      route: { id: ids.route, headCheckpointId: ids.checkpoint },
      checkpoint: { id: ids.checkpoint, version: 0, reason: 'bootstrap' },
    });
    const workspace = await repository.getRouteWorkspace(ids.user, ids.route, 'decide');
    expect(workspace?.stages).toEqual(stages);
    expect(workspace?.threads).toEqual([]);
    expect(workspace?.checkpoints).toHaveLength(1);
    expect(workspace?.checkpoints[0]?.snapshot).toEqual({
      stages: stages.map(({ stageKey, status, internalState }) => ({
        stage_key: stageKey,
        status,
        internal_state: internalState,
      })),
      artifacts: [],
    });
  });

  it('lists only contexts owned by the authenticated user', async () => {
    await createContext();
    expect(await repository.listContexts(ids.user)).toEqual([
      expect.objectContaining({ id: ids.context, title: 'Research project' }),
    ]);
    expect(await repository.listContexts(ids.otherUser)).toEqual([]);
    expect(await repository.getRouteWorkspace(ids.otherUser, ids.route, 'discover')).toBeNull();
  });

  it('keeps threads scoped to their route and stage', async () => {
    await createContext();
    const thread = await repository.createThread({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      stageKey: 'decide',
      title: 'Compare options',
      now,
    });
    expect(thread).toMatchObject({ id: ids.thread, stageKey: 'decide', title: 'Compare options' });
    expect((await repository.getRouteWorkspace(ids.user, ids.route, 'discover'))?.threads).toEqual([]);
    expect((await repository.getRouteWorkspace(ids.user, ids.route, 'decide'))?.threads).toEqual([
      expect.objectContaining({ id: ids.thread }),
    ]);
    expect(await repository.updateThread({
      userId: ids.otherUser,
      threadId: ids.thread,
      title: 'Stolen',
      status: 'archived',
      now,
    })).toBeNull();
  });

  it('refreshes context recency for thread creation, rename, and archive', async () => {
    await createContext();
    await repository.createThread({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      stageKey: 'discover',
      title: 'Initial topic',
      now: new Date(now.getTime() + 1000),
    });
    expect((await repository.getContextWorkspace(ids.user, ids.context))?.context.updatedAt)
      .toEqual(new Date(now.getTime() + 1000));

    const renamed = await repository.updateThread({
      userId: ids.user,
      threadId: ids.thread,
      title: 'Renamed topic',
      now: new Date(now.getTime() + 2000),
    });
    expect(renamed).toMatchObject({ title: 'Renamed topic', status: 'active' });
    expect((await repository.getContextWorkspace(ids.user, ids.context))?.context.updatedAt)
      .toEqual(new Date(now.getTime() + 2000));

    const archived = await repository.updateThread({
      userId: ids.user,
      threadId: ids.thread,
      status: 'archived',
      now: new Date(now.getTime() + 3000),
    });
    expect(archived).toMatchObject({ title: 'Renamed topic', status: 'archived' });
    expect((await repository.getContextWorkspace(ids.user, ids.context))?.context.updatedAt)
      .toEqual(new Date(now.getTime() + 3000));
  });

  it('rolls back thread creation when refreshing context recency fails', async () => {
    await createContext();
    await pool.query(`
      CREATE FUNCTION reject_context_recency_refresh()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'context refresh failed' USING ERRCODE = '55000';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER reject_context_recency_refresh
      BEFORE UPDATE OF updated_at ON contexts
      FOR EACH ROW EXECUTE FUNCTION reject_context_recency_refresh()
    `);
    try {
      await expect(repository.createThread({
        userId: ids.user,
        id: ids.thread,
        routeId: ids.route,
        stageKey: 'discover',
        title: 'Atomic topic',
        now: new Date(now.getTime() + 1000),
      })).rejects.toMatchObject({ code: '55000' });
      const persisted = await pool.query(
        'SELECT id FROM workflow_threads WHERE id = $1',
        [ids.thread],
      );
      expect(persisted.rows).toEqual([]);
    } finally {
      await pool.query('DROP TRIGGER reject_context_recency_refresh ON contexts');
      await pool.query('DROP FUNCTION reject_context_recency_refresh()');
    }
  });

  it('branches from a historical checkpoint without mutating the source route', async () => {
    const source = await createContext();
    const branched = await repository.branchRoute({
      userId: ids.user,
      contextId: ids.context,
      sourceCheckpointId: ids.checkpoint,
      routeId: '30000000-0000-4000-8000-000000000002',
      routeName: 'Alternative route',
      checkpointId: '40000000-0000-4000-8000-000000000002',
      now: new Date(now.getTime() + 2000),
    });
    expect(branched).toMatchObject({
      route: {
        name: 'Alternative route',
        originCheckpointId: ids.checkpoint,
        origin: { routeId: ids.route, routeName: 'Main route', version: 0, stageKey: 'discover' },
        headCheckpointId: '40000000-0000-4000-8000-000000000002',
      },
      checkpoint: { parentCheckpointId: null, reason: 'branch', version: 0 },
    });
    const sourceAfter = await repository.getRouteWorkspace(ids.user, ids.route, 'discover');
    expect(sourceAfter?.route).toEqual(source.route);
    expect(sourceAfter?.checkpoints).toEqual([source.checkpoint]);
    expect((await repository.getContextWorkspace(ids.user, ids.context))?.routes).toEqual([
      expect.objectContaining({ id: ids.route, origin: null }),
      expect.objectContaining({
        id: '30000000-0000-4000-8000-000000000002',
        origin: { routeId: ids.route, routeName: 'Main route', version: 0, stageKey: 'discover' },
      }),
    ]);
  });
});
