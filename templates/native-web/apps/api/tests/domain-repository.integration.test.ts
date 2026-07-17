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
  conversation2: '50000000-0000-4000-8000-000000000002',
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
    const workspace = await repository.getRouteWorkspace(ids.user, ids.route);
    expect(workspace?.conversations).toEqual([]);
    expect(workspace).not.toHaveProperty('stages');
    expect(workspace).not.toHaveProperty('threads');
    expect(workspace?.checkpoints).toHaveLength(1);
    const legacyStages = stages.map(({ stageKey, status, internalState }) => ({
      stage_key: stageKey,
      status,
      internal_state: internalState,
    }));
    expect(workspace?.checkpoints[0]?.snapshot).toEqual({
      workflowState: {
        legacyCompatibility: {
          stages: legacyStages,
        },
      },
      stageProjection: {
        revision: 'legacy-stage-projection-v1',
        items: stages.map(({ stageKey, status, internalState }) => ({
          key: stageKey,
          label: stageKey,
          status,
          summary: internalState,
        })),
      },
      memoryReferences: [],
      artifacts: [],
      stages: legacyStages,
    });
  });

  it('serializes concurrent first Conversations so exactly one becomes primary', async () => {
    await repository.createContext({
      userId: ids.user,
      contextId: ids.context,
      title: 'Stage-free project',
      routeId: ids.route,
      routeName: 'Main route',
      checkpointId: ids.checkpoint,
      stages: [],
      now,
    });
    await pool.query(`
      CREATE FUNCTION delay_stage_free_conversation_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.stage_key IS NULL THEN
          PERFORM pg_sleep(0.5);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER delay_stage_free_conversation_insert
      BEFORE INSERT ON workflow_threads
      FOR EACH ROW EXECUTE FUNCTION delay_stage_free_conversation_insert()
    `);

    try {
      const conversations = await Promise.all([
        repository.createConversation({
          userId: ids.user,
          id: ids.thread,
          routeId: ids.route,
          title: 'First concurrent discussion',
          titleSource: 'agent',
          status: 'initializing',
          now: new Date(now.getTime() + 1000),
        }),
        repository.createConversation({
          userId: ids.user,
          id: ids.conversation2,
          routeId: ids.route,
          title: 'Second concurrent discussion',
          titleSource: 'agent',
          status: 'initializing',
          now: new Date(now.getTime() + 1000),
        }),
      ]);

      expect(conversations).not.toContain(null);
      expect(conversations.filter((conversation) => conversation?.isPrimary)).toHaveLength(1);
      expect(conversations.filter((conversation) => !conversation?.isPrimary)).toHaveLength(1);
      expect((await pool.query(
        `SELECT
           count(*)::int AS conversations,
           count(*) FILTER (WHERE is_primary AND status <> 'archived')::int AS primaries
         FROM workflow_threads
         WHERE route_id = $1 AND status <> 'archived'`,
        [ids.route],
      )).rows).toEqual([{ conversations: 2, primaries: 1 }]);
    } finally {
      await pool.query('DROP TRIGGER delay_stage_free_conversation_insert ON workflow_threads');
      await pool.query('DROP FUNCTION delay_stage_free_conversation_insert()');
    }
  });

  it('maintains exactly one primary across archive and unarchive transitions', async () => {
    await repository.createContext({
      userId: ids.user,
      contextId: ids.context,
      title: 'Stage-free project',
      routeId: ids.route,
      routeName: 'Main route',
      checkpointId: ids.checkpoint,
      stages: [],
      now,
    });

    async function expectStoredPrimaryState(input: {
      nonArchived: number;
      primaryId: string | null;
      rows: Array<{ id: string; status: string; is_primary: boolean }>;
    }) {
      expect((await pool.query(
        `SELECT
           count(*) FILTER (WHERE status <> 'archived')::int AS non_archived,
           count(*) FILTER (WHERE status <> 'archived' AND is_primary)::int AS primaries
         FROM workflow_threads
         WHERE route_id = $1`,
        [ids.route],
      )).rows).toEqual([{
        non_archived: input.nonArchived,
        primaries: input.nonArchived === 0 ? 0 : 1,
      }]);
      expect((await pool.query(
        'SELECT id, status, is_primary FROM workflow_threads WHERE route_id = $1 ORDER BY id',
        [ids.route],
      )).rows).toEqual(input.rows);
      const workspace = await repository.getRouteWorkspace(ids.user, ids.route);
      expect(workspace?.conversations.filter((conversation) => conversation.isPrimary))
        .toEqual(input.primaryId === null
          ? []
          : [expect.objectContaining({ id: input.primaryId, status: 'active', isPrimary: true })]);
    }

    const conversationA = await repository.createConversation({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      title: 'Conversation A',
      titleSource: 'agent',
      status: 'active',
      now: new Date(now.getTime() + 1000),
    });
    const conversationB = await repository.createConversation({
      userId: ids.user,
      id: ids.conversation2,
      routeId: ids.route,
      title: 'Conversation B',
      titleSource: 'agent',
      status: 'active',
      now: new Date(now.getTime() + 2000),
    });
    expect(conversationA).toMatchObject({ status: 'active', isPrimary: true });
    expect(conversationB).toMatchObject({ status: 'active', isPrimary: false });
    await expectStoredPrimaryState({
      nonArchived: 2,
      primaryId: ids.thread,
      rows: [
        { id: ids.thread, status: 'active', is_primary: true },
        { id: ids.conversation2, status: 'active', is_primary: false },
      ],
    });

    const archivedA = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.thread,
      status: 'archived',
      now: new Date(now.getTime() + 3000),
    });
    expect(archivedA).toMatchObject({ status: 'archived', isPrimary: false });
    await expectStoredPrimaryState({
      nonArchived: 1,
      primaryId: ids.conversation2,
      rows: [
        { id: ids.thread, status: 'archived', is_primary: false },
        { id: ids.conversation2, status: 'active', is_primary: true },
      ],
    });

    const unarchivedA = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.thread,
      status: 'active',
      now: new Date(now.getTime() + 4000),
    });
    expect(unarchivedA).toMatchObject({ status: 'active', isPrimary: false });
    await expectStoredPrimaryState({
      nonArchived: 2,
      primaryId: ids.conversation2,
      rows: [
        { id: ids.thread, status: 'active', is_primary: false },
        { id: ids.conversation2, status: 'active', is_primary: true },
      ],
    });

    const archivedB = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.conversation2,
      status: 'archived',
      now: new Date(now.getTime() + 5000),
    });
    expect(archivedB).toMatchObject({ status: 'archived', isPrimary: false });
    await expectStoredPrimaryState({
      nonArchived: 1,
      primaryId: ids.thread,
      rows: [
        { id: ids.thread, status: 'active', is_primary: true },
        { id: ids.conversation2, status: 'archived', is_primary: false },
      ],
    });

    const archivedLast = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.thread,
      status: 'archived',
      now: new Date(now.getTime() + 6000),
    });
    expect(archivedLast).toMatchObject({ status: 'archived', isPrimary: false });
    await expectStoredPrimaryState({
      nonArchived: 0,
      primaryId: null,
      rows: [
        { id: ids.thread, status: 'archived', is_primary: false },
        { id: ids.conversation2, status: 'archived', is_primary: false },
      ],
    });

    const unarchivedWithoutPrimary = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.conversation2,
      status: 'active',
      now: new Date(now.getTime() + 7000),
    });
    expect(unarchivedWithoutPrimary).toMatchObject({ status: 'active', isPrimary: true });
    await expectStoredPrimaryState({
      nonArchived: 1,
      primaryId: ids.conversation2,
      rows: [
        { id: ids.thread, status: 'archived', is_primary: false },
        { id: ids.conversation2, status: 'active', is_primary: true },
      ],
    });
  });

  it('keeps legacy Thread compatibility inside the canonical primary and title-source invariant', async () => {
    await createContext();

    async function expectMixedState(rows: Array<{
      id: string;
      stage_key: string | null;
      title_source: string;
      status: string;
      is_primary: boolean;
    }>) {
      expect((await pool.query(
        'SELECT id, stage_key, title_source, status, is_primary ' +
          'FROM workflow_threads WHERE route_id = $1 ORDER BY id',
        [ids.route],
      )).rows).toEqual(rows);
      const nonArchived = rows.filter((row) => row.status !== 'archived');
      expect(nonArchived.filter((row) => row.is_primary)).toHaveLength(
        nonArchived.length === 0 ? 0 : 1,
      );
      const workspace = await repository.getRouteWorkspace(ids.user, ids.route);
      expect(workspace?.conversations.filter((conversation) => conversation.isPrimary))
        .toHaveLength(nonArchived.length === 0 ? 0 : 1);
    }

    const legacyA = await repository.createThread({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      stageKey: 'discover',
      title: 'Legacy Conversation A',
      now: new Date(now.getTime() + 1000),
    });
    const canonicalB = await repository.createConversation({
      userId: ids.user,
      id: ids.conversation2,
      routeId: ids.route,
      title: 'Agent Conversation B',
      titleSource: 'agent',
      status: 'active',
      now: new Date(now.getTime() + 2000),
    });
    expect(legacyA).toMatchObject({ stageKey: 'discover', status: 'active' });
    expect(canonicalB).toMatchObject({ titleSource: 'agent', isPrimary: false, status: 'active' });
    await expectMixedState([
      {
        id: ids.thread,
        stage_key: 'discover',
        title_source: 'user',
        status: 'active',
        is_primary: true,
      },
      {
        id: ids.conversation2,
        stage_key: null,
        title_source: 'agent',
        status: 'active',
        is_primary: false,
      },
    ]);

    const renamedBThroughLegacyApi = await repository.updateThread({
      userId: ids.user,
      threadId: ids.conversation2,
      title: 'Conversation B renamed by user',
      status: 'active',
      now: new Date(now.getTime() + 3000),
    });
    expect(renamedBThroughLegacyApi).toMatchObject({
      title: 'Conversation B renamed by user',
      status: 'active',
    });
    await expectMixedState([
      {
        id: ids.thread,
        stage_key: 'discover',
        title_source: 'user',
        status: 'active',
        is_primary: true,
      },
      {
        id: ids.conversation2,
        stage_key: null,
        title_source: 'user',
        status: 'active',
        is_primary: false,
      },
    ]);

    const archivedAThroughLegacyApi = await repository.updateThread({
      userId: ids.user,
      threadId: ids.thread,
      status: 'archived',
      now: new Date(now.getTime() + 4000),
    });
    expect(archivedAThroughLegacyApi).toMatchObject({ status: 'archived' });
    await expectMixedState([
      {
        id: ids.thread,
        stage_key: 'discover',
        title_source: 'user',
        status: 'archived',
        is_primary: false,
      },
      {
        id: ids.conversation2,
        stage_key: null,
        title_source: 'user',
        status: 'active',
        is_primary: true,
      },
    ]);

    const unarchivedAThroughCanonicalApi = await repository.updateConversation({
      userId: ids.user,
      conversationId: ids.thread,
      status: 'active',
      now: new Date(now.getTime() + 5000),
    });
    expect(unarchivedAThroughCanonicalApi).toMatchObject({ status: 'active', isPrimary: false });
    await expectMixedState([
      {
        id: ids.thread,
        stage_key: 'discover',
        title_source: 'user',
        status: 'active',
        is_primary: false,
      },
      {
        id: ids.conversation2,
        stage_key: null,
        title_source: 'user',
        status: 'active',
        is_primary: true,
      },
    ]);

    const archivedBThroughLegacyApi = await repository.updateThread({
      userId: ids.user,
      threadId: ids.conversation2,
      status: 'archived',
      now: new Date(now.getTime() + 6000),
    });
    expect(archivedBThroughLegacyApi).toMatchObject({ status: 'archived' });
    await expectMixedState([
      {
        id: ids.thread,
        stage_key: 'discover',
        title_source: 'user',
        status: 'active',
        is_primary: true,
      },
      {
        id: ids.conversation2,
        stage_key: null,
        title_source: 'user',
        status: 'archived',
        is_primary: false,
      },
    ]);
  });

  it('lists only contexts owned by the authenticated user', async () => {
    await createContext();
    expect(await repository.listContexts(ids.user)).toEqual([
      expect.objectContaining({ id: ids.context, title: 'Research project' }),
    ]);
    expect(await repository.listContexts(ids.otherUser)).toEqual([]);
    expect(await repository.getRouteWorkspace(ids.otherUser, ids.route)).toBeNull();
  });

  it('creates and updates Stage-free Conversations while metadata writes stay non-causal', async () => {
    await createContext();
    const first = await repository.createConversation({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      title: '新讨论',
      titleSource: 'agent',
      status: 'initializing',
      now: new Date(now.getTime() + 1000),
    });
    const second = await repository.createConversation({
      userId: ids.user,
      id: ids.conversation2,
      routeId: ids.route,
      title: '新讨论',
      titleSource: 'agent',
      status: 'initializing',
      now: new Date(now.getTime() + 2000),
    });
    expect(first).toMatchObject({
      id: ids.thread,
      titleSource: 'agent',
      status: 'initializing',
    });
    expect(second).toMatchObject({
      id: ids.conversation2,
      titleSource: 'agent',
      status: 'initializing',
    });
    expect(first).not.toHaveProperty('stageKey');

    const causalBefore = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints,
        (SELECT count(*)::int FROM workflow_commands) AS commands,
        (SELECT count(*)::int FROM memory_items) AS memories,
        (SELECT count(*)::int FROM workflow_routes) AS routes
    `);
    const routesBefore = await pool.query(
      'SELECT id, name, origin_checkpoint_id, head_checkpoint_id, created_at, updated_at FROM workflow_routes ORDER BY id',
    );

    await expect(repository.renameContext({
      userId: ids.user,
      contextId: ids.context,
      title: '同名',
      now: new Date(now.getTime() + 3000),
    })).resolves.toMatchObject({ title: '同名' });
    await expect(repository.updateConversation({
      userId: ids.user,
      conversationId: ids.thread,
      title: '同名',
      status: 'active',
      now: new Date(now.getTime() + 4000),
    })).resolves.toMatchObject({ title: '同名', titleSource: 'user', status: 'active' });
    await expect(repository.updateConversation({
      userId: ids.user,
      conversationId: ids.conversation2,
      title: '同名',
      status: 'active',
      now: new Date(now.getTime() + 5000),
    })).resolves.toMatchObject({ title: '同名', titleSource: 'user', status: 'active' });

    const workspace = await repository.getRouteWorkspace(ids.user, ids.route);
    expect(workspace?.conversations).toEqual([
      expect.objectContaining({ id: ids.conversation2, title: '同名' }),
      expect.objectContaining({ id: ids.thread, title: '同名' }),
    ]);
    expect(workspace).not.toHaveProperty('threads');
    expect(workspace).not.toHaveProperty('stages');

    expect((await pool.query(`
      SELECT
        (SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints,
        (SELECT count(*)::int FROM workflow_commands) AS commands,
        (SELECT count(*)::int FROM memory_items) AS memories,
        (SELECT count(*)::int FROM workflow_routes) AS routes
    `)).rows).toEqual(causalBefore.rows);
    expect((await pool.query(
      'SELECT id, name, origin_checkpoint_id, head_checkpoint_id, created_at, updated_at FROM workflow_routes ORDER BY id',
    )).rows).toEqual(routesBefore.rows);
    expect((await pool.query(
      'SELECT title_source, stage_key FROM workflow_threads ORDER BY id',
    )).rows).toEqual([
      { title_source: 'user', stage_key: null },
      { title_source: 'user', stage_key: null },
    ]);
    expect((await pool.query(
      'SELECT title_source FROM contexts WHERE id = $1',
      [ids.context],
    )).rows).toEqual([{ title_source: 'user' }]);
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
    const sourceAfter = await repository.getRouteWorkspace(ids.user, ids.route);
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
