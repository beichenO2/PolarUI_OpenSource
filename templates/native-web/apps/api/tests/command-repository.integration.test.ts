import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandRepository } from '../src/commands/repository.js';
import { createAssetRepository } from '../src/assets/repository.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDomainRepository } from '../src/domain/repository.js';
import { createMemoryRepository } from '../src/memory/repository.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const schema = 'command_repository_integration';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  otherUser: '10000000-0000-4000-8000-000000000002',
  context: '20000000-0000-4000-8000-000000000001',
  route: '30000000-0000-4000-8000-000000000001',
  checkpoint: '40000000-0000-4000-8000-000000000001',
  nextCheckpoint: '40000000-0000-4000-8000-000000000002',
  conflictCheckpoint: '40000000-0000-4000-8000-000000000003',
  thread: '50000000-0000-4000-8000-000000000001',
  command: '60000000-0000-4000-8000-000000000001',
  nextCommand: '60000000-0000-4000-8000-000000000002',
  thirdCommand: '60000000-0000-4000-8000-000000000003',
  userMessage: '70000000-0000-4000-8000-000000000001',
  assistantMessage: '70000000-0000-4000-8000-000000000002',
  nextUserMessage: '70000000-0000-4000-8000-000000000003',
  nextAssistantMessage: '70000000-0000-4000-8000-000000000004',
  interrupt: '80000000-0000-4000-8000-000000000001',
  nextInterrupt: '80000000-0000-4000-8000-000000000002',
  startCommand: '60000000-0000-4000-8000-000000000010',
  startResultCheckpoint: '40000000-0000-4000-8000-000000000010',
  headCommand: '60000000-0000-4000-8000-000000000020',
  headConversation: '50000000-0000-4000-8000-000000000020',
  headResultCheckpoint: '40000000-0000-4000-8000-000000000020',
  sourceHeadCheckpoint: '40000000-0000-4000-8000-000000000030',
  historyCommand: '60000000-0000-4000-8000-000000000030',
  historyResultCheckpoint: '40000000-0000-4000-8000-000000000031',
  historyFailureCommand: '60000000-0000-4000-8000-000000000032',
  attachmentObject: '90000000-0000-4000-8000-000000000010',
  stagedAttachment: '91000000-0000-4000-8000-000000000010',
  otherAttachmentObject: '90000000-0000-4000-8000-000000000011',
  otherStagedAttachment: '91000000-0000-4000-8000-000000000011',
};

const stages = [
  { stageKey: 'discover', position: 0, status: 'active' as const, internalState: 'start' },
  { stageKey: 'decide', position: 1, status: 'not_started' as const, internalState: 'waiting' },
];

integrationDescribe('workflow command repository', () => {
  const adminPool = createPool(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  const domain = createDomainRepository(pool);
  const repository = createCommandRepository(pool);
  const memoryRepository = createMemoryRepository(pool);
  const assets = createAssetRepository(pool);
  const now = new Date('2026-07-16T08:00:00.000Z');

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
    await domain.createContext({
      userId: ids.user,
      contextId: ids.context,
      title: 'Research project',
      routeId: ids.route,
      routeName: 'Main route',
      checkpointId: ids.checkpoint,
      stages,
      now,
    });
    await domain.createThread({
      userId: ids.user,
      id: ids.thread,
      routeId: ids.route,
      stageKey: 'discover',
      title: 'Evidence thread',
      now,
    });
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  function claimInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: ids.user,
      commandId: ids.command,
      threadId: ids.thread,
      kind: 'message' as const,
      content: 'Collect the strongest evidence.',
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      inputHash: 'hash-v1',
      now,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      ...overrides,
    };
  }

  function messageResult(overrides: Record<string, unknown> = {}) {
    return {
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      reply: 'The evidence is converging.',
      memoryProposals: [],
      interrupt: null,
      ...overrides,
    };
  }

  function prepareInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: ids.user,
      commandId: ids.command,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input: { type: 'message' as const, content: 'Collect the strongest evidence.' },
      attachmentIds: [],
      kind: 'message' as const,
      content: 'Collect the strongest evidence.',
      inputHash: 'unified-hash-v1',
      now,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      ...overrides,
    };
  }

  function finalizeInput(overrides: Record<string, unknown> = {}) {
    return {
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      checkpointId: ids.nextCheckpoint,
      headCheckpointIdAtClaim: ids.checkpoint,
      reply: 'The evidence is converging.',
      stageSignals: [],
      workflowCursor: null,
      memoryProposals: [],
      interrupt: null,
      attachmentIds: [],
      ...overrides,
    };
  }

  async function prepareUnified(overrides: Record<string, unknown> = {}) {
    const prepared = await repository.prepareCommand(prepareInput(overrides));
    expect(prepared.kind).toBe('claimed');
    if (prepared.kind !== 'claimed') throw new Error('expected prepared command');
    return prepared;
  }

  async function advanceSourceHead() {
    await pool.query(
      'INSERT INTO workflow_checkpoints ' +
      '(id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) ' +
      "VALUES ($1, $2, $3, $4, 1, NULL, 'workflow_action', $5, $6)",
      [
        ids.sourceHeadCheckpoint,
        ids.context,
        ids.route,
        ids.checkpoint,
        { workflowState: { marker: 'source-head' }, memoryReferences: [], artifacts: [] },
        new Date(now.getTime() + 100),
      ],
    );
    await pool.query(
      'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
      [ids.route, ids.sourceHeadCheckpoint],
    );
  }

  async function stageAttachment(input: {
    userId: string;
    objectId: string;
    attachmentId: string;
    sha256: string;
    storageKey: string;
  }) {
    await pool.query(
      'INSERT INTO asset_objects ' +
      '(id, user_id, storage_key, sha256, byte_size, media_type, status, created_at) ' +
      "VALUES ($1, $2, $3, $4, 4, 'text/plain', 'ready', $5)",
      [input.objectId, input.userId, input.storageKey, input.sha256, now],
    );
    await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename, created_at, updated_at) ' +
      "VALUES ($1, $2, $3, 'notes.txt', $4, $4)",
      [input.attachmentId, input.userId, input.objectId, now],
    );
  }

  async function claimMessage(overrides: Record<string, unknown> = {}) {
    const claimed = await repository.claimCommand(claimInput(overrides));
    expect(claimed.kind).toBe('claimed');
    if (claimed.kind !== 'claimed') throw new Error('expected claimed command');
    return claimed;
  }

  it('prepares a zero-scope Start durably but hides every initializing row, then replays failure idempotently', async () => {
    const startInput = prepareInput({
      userId: ids.otherUser,
      commandId: ids.startCommand,
      contextId: undefined,
      routeId: undefined,
      conversationId: undefined,
      baseCheckpointId: undefined,
      expectedCheckpointVersion: undefined,
      inputHash: 'start-hash-v1',
    });
    const prepared = await repository.prepareCommand(startInput);
    expect(prepared.kind).toBe('claimed');
    if (prepared.kind !== 'claimed' || prepared.execution.scope.mode !== 'start') {
      throw new Error('expected Start preparation');
    }
    const scope = prepared.execution.scope;
    expect(await repository.listThreadState(ids.otherUser, scope.provisionalConversationId)).toBeNull();
    expect(await repository.listConversationState(ids.otherUser, scope.provisionalConversationId)).toBeNull();
    expect(prepared.execution).toMatchObject({
      contextId: scope.provisionalContextId,
      routeId: scope.provisionalRouteId,
      conversationId: scope.provisionalConversationId,
      baseCheckpoint: { version: 0, stageKey: null, reason: 'bootstrap' },
      headCheckpointId: prepared.execution.baseCheckpoint.id,
      baseIsHead: true,
    });
    expect((await pool.query(
      'SELECT title_source, status FROM contexts WHERE id = $1',
      [scope.provisionalContextId],
    )).rows[0]).toEqual({ title_source: 'agent', status: 'initializing' });
    expect((await pool.query(
      'SELECT status, head_checkpoint_id FROM workflow_routes WHERE id = $1',
      [scope.provisionalRouteId],
    )).rows[0]).toEqual({
      status: 'initializing',
      head_checkpoint_id: prepared.execution.baseCheckpoint.id,
    });
    expect((await pool.query(
      'SELECT title_source, is_primary, status, stage_key FROM workflow_threads WHERE id = $1',
      [scope.provisionalConversationId],
    )).rows[0]).toEqual({
      title_source: 'agent',
      is_primary: true,
      status: 'initializing',
      stage_key: null,
    });
    expect((await pool.query(
      'SELECT version, stage_key, reason FROM workflow_checkpoints WHERE id = $1',
      [prepared.execution.baseCheckpoint.id],
    )).rows[0]).toEqual({ version: 0, stage_key: null, reason: 'bootstrap' });
    expect((await pool.query(
      'SELECT status, context_id, source_route_id, source_thread_id FROM workflow_commands WHERE id = $1',
      [ids.startCommand],
    )).rows[0]).toEqual({
      status: 'running',
      context_id: scope.provisionalContextId,
      source_route_id: scope.provisionalRouteId,
      source_thread_id: scope.provisionalConversationId,
    });

    expect(await domain.listContexts(ids.otherUser)).toEqual([]);
    expect(await domain.getContextWorkspace(ids.otherUser, scope.provisionalContextId)).toBeNull();
    expect(await domain.getRouteWorkspace(ids.otherUser, scope.provisionalRouteId)).toBeNull();

    await repository.failCommand(ids.startCommand, 'WORKFLOW_UNAVAILABLE', new Date(now.getTime() + 1000));
    expect(await repository.listThreadState(ids.otherUser, scope.provisionalConversationId)).toBeNull();
    expect(await repository.listConversationState(ids.otherUser, scope.provisionalConversationId)).toBeNull();
    expect(await domain.listContexts(ids.otherUser)).toEqual([]);
    expect(await domain.getContextWorkspace(ids.otherUser, scope.provisionalContextId)).toBeNull();
    expect(await domain.getRouteWorkspace(ids.otherUser, scope.provisionalRouteId)).toBeNull();
    expect((await pool.query(
      'SELECT status FROM contexts WHERE id = $1',
      [scope.provisionalContextId],
    )).rows[0].status).toBe('initializing');

    const replay = await repository.prepareCommand({
      ...startInput,
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected terminal Start replay');
    expect(replay.command).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_UNAVAILABLE' });
    expect(await repository.prepareCommand({
      ...startInput,
      inputHash: 'changed-start-hash',
      now: new Date(now.getTime() + 3000),
      leaseExpiresAt: new Date(now.getTime() + 33_000),
    })).toEqual({ kind: 'reused' });
  });

  it('serializes concurrent exact Start claims into one claim and one in-progress replay', async () => {
    const startInput = prepareInput({
      userId: ids.otherUser,
      commandId: ids.startCommand,
      contextId: undefined,
      routeId: undefined,
      conversationId: undefined,
      baseCheckpointId: undefined,
      expectedCheckpointVersion: undefined,
      inputHash: 'concurrent-start-hash',
    });

    const results = await Promise.all([
      repository.prepareCommand(startInput),
      repository.prepareCommand(startInput),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['claimed', 'in_progress']);
    const claimed = results.find((result) => result.kind === 'claimed');
    if (!claimed || claimed.kind !== 'claimed' || claimed.execution.scope.mode !== 'start') {
      throw new Error('expected exactly one claimed Start');
    }

    const counts = (await pool.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM contexts WHERE user_id = $1) AS contexts, ' +
      '(SELECT count(*)::int FROM workflow_routes route ' +
        'JOIN contexts context ON context.id = route.context_id WHERE context.user_id = $1) AS routes, ' +
      '(SELECT count(*)::int FROM workflow_threads conversation ' +
        'JOIN contexts context ON context.id = conversation.context_id WHERE context.user_id = $1) AS conversations, ' +
      '(SELECT count(*)::int FROM workflow_checkpoints checkpoint ' +
        'JOIN contexts context ON context.id = checkpoint.context_id WHERE context.user_id = $1) AS checkpoints, ' +
      '(SELECT count(*)::int FROM workflow_commands WHERE id = $2) AS commands, ' +
      '(SELECT count(*)::int FROM workflow_command_events ' +
        "WHERE command_id = $2 AND event_type = 'command.accepted') AS accepted_events",
      [ids.otherUser, ids.startCommand],
    )).rows[0];
    expect(counts).toEqual({
      contexts: 1,
      routes: 1,
      conversations: 1,
      checkpoints: 1,
      commands: 1,
      accepted_events: 1,
    });
    expect(claimed.execution.scope).toMatchObject({
      provisionalContextId: expect.any(String),
      provisionalRouteId: expect.any(String),
      provisionalConversationId: expect.any(String),
    });
  });

  it('atomically publishes a successful Start with one result checkpoint and canonical messages', async () => {
    const startInput = prepareInput({
      userId: ids.otherUser,
      commandId: ids.startCommand,
      contextId: undefined,
      routeId: undefined,
      conversationId: undefined,
      baseCheckpointId: undefined,
      expectedCheckpointVersion: undefined,
      inputHash: 'start-success-hash',
    });
    const prepared = await repository.prepareCommand(startInput);
    expect(prepared.kind).toBe('claimed');
    if (prepared.kind !== 'claimed' || prepared.execution.scope.mode !== 'start') {
      throw new Error('expected Start preparation');
    }
    const scope = prepared.execution.scope;
    const bootstrapId = prepared.execution.baseCheckpoint.id;

    const committed = await repository.finalizeCommand(ids.startCommand, finalizeInput({
      checkpointId: ids.startResultCheckpoint,
      contextTitle: 'Agent Context title',
      conversationTitle: 'Agent Conversation title',
    }), new Date(now.getTime() + 1000));
    expect(committed).toMatchObject({
      status: 'succeeded',
      routeId: scope.provisionalRouteId,
      conversationId: scope.provisionalConversationId,
      checkpointId: ids.startResultCheckpoint,
    });
    expect((await pool.query(
      'SELECT title, title_source, status FROM contexts WHERE id = $1',
      [scope.provisionalContextId],
    )).rows[0]).toEqual({ title: 'Agent Context title', title_source: 'agent', status: 'active' });
    expect((await pool.query(
      'SELECT head_checkpoint_id, status FROM workflow_routes WHERE id = $1',
      [scope.provisionalRouteId],
    )).rows[0]).toEqual({ head_checkpoint_id: ids.startResultCheckpoint, status: 'active' });
    expect((await pool.query(
      'SELECT title, title_source, is_primary, status, stage_key FROM workflow_threads WHERE id = $1',
      [scope.provisionalConversationId],
    )).rows[0]).toEqual({
      title: 'Agent Conversation title', title_source: 'agent', is_primary: true,
      status: 'active', stage_key: null,
    });
    expect((await pool.query(
      'SELECT parent_checkpoint_id, version, reason, stage_key FROM workflow_checkpoints WHERE id = $1',
      [ids.startResultCheckpoint],
    )).rows[0]).toEqual({
      parent_checkpoint_id: bootstrapId, version: 1, reason: 'workflow_action', stage_key: null,
    });
    expect((await pool.query(
      'SELECT role, sequence FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
      [scope.provisionalConversationId],
    )).rows).toEqual([
      { role: 'user', sequence: 1 }, { role: 'assistant', sequence: 2 },
    ]);
    expect((await pool.query(
      'SELECT result_route_id, result_thread_id, result_checkpoint_id FROM workflow_commands WHERE id = $1',
      [ids.startCommand],
    )).rows[0]).toEqual({
      result_route_id: scope.provisionalRouteId,
      result_thread_id: scope.provisionalConversationId,
      result_checkpoint_id: ids.startResultCheckpoint,
    });
    expect(await domain.listContexts(ids.otherUser)).toEqual([
      expect.objectContaining({ id: scope.provisionalContextId, status: 'active' }),
    ]);
    expect(await domain.getRouteWorkspace(ids.otherUser, scope.provisionalRouteId)).toMatchObject({
      route: { id: scope.provisionalRouteId, headCheckpointId: ids.startResultCheckpoint },
      conversations: [expect.objectContaining({ id: scope.provisionalConversationId, status: 'active' })],
    });
  });

  it('materializes a hidden primary Conversation for a head command and activates it with one result checkpoint', async () => {
    await pool.query('DELETE FROM workflow_threads WHERE id = $1', [ids.thread]);
    const prepared = await prepareUnified({
      commandId: ids.headCommand,
      conversationId: undefined,
      inputHash: 'head-without-conversation',
    });
    expect(prepared.execution.scope).toEqual({
      mode: 'head',
      contextId: ids.context,
      routeId: ids.route,
      conversationId: null,
    });
    expect(prepared.execution.conversationId).toEqual(expect.any(String));
    const provisionalConversationId = prepared.execution.conversationId!;
    expect((await pool.query(
      'SELECT title, title_source, is_primary, status, stage_key FROM workflow_threads WHERE id = $1',
      [provisionalConversationId],
    )).rows[0]).toMatchObject({
      title_source: 'agent',
      is_primary: true,
      status: 'initializing',
      stage_key: null,
    });
    expect((await domain.getRouteWorkspace(ids.user, ids.route))?.conversations).toEqual([]);

    const committed = await repository.finalizeCommand(ids.headCommand, finalizeInput({
      checkpointId: ids.headResultCheckpoint,
      contextTitle: 'Agent must not replace this Context',
      conversationTitle: 'Focused evidence',
    }), new Date(now.getTime() + 1000));
    expect(committed).toMatchObject({
      status: 'succeeded',
      routeId: ids.route,
      conversationId: provisionalConversationId,
      checkpointId: ids.headResultCheckpoint,
    });
    expect((await pool.query(
      'SELECT title, title_source, is_primary, status FROM workflow_threads WHERE id = $1',
      [provisionalConversationId],
    )).rows[0]).toEqual({
      title: 'Focused evidence',
      title_source: 'agent',
      is_primary: true,
      status: 'active',
    });
    expect((await pool.query(
      'SELECT title, title_source FROM contexts WHERE id = $1',
      [ids.context],
    )).rows[0]).toEqual({ title: 'Research project', title_source: 'user' });
    expect((await pool.query(
      'SELECT parent_checkpoint_id, version, reason FROM workflow_checkpoints WHERE id = $1',
      [ids.headResultCheckpoint],
    )).rows[0]).toEqual({
      parent_checkpoint_id: ids.checkpoint,
      version: 1,
      reason: 'workflow_action',
    });
    expect((await pool.query(
      'SELECT head_checkpoint_id FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0].head_checkpoint_id).toBe(ids.headResultCheckpoint);
    expect((await pool.query(
      'SELECT role, sequence FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
      [provisionalConversationId],
    )).rows).toEqual([
      { role: 'user', sequence: 1 },
      { role: 'assistant', sequence: 2 },
    ]);
    expect((await pool.query(
      'SELECT result_route_id, result_thread_id, result_checkpoint_id FROM workflow_commands WHERE id = $1',
      [ids.headCommand],
    )).rows[0]).toEqual({
      result_route_id: ids.route,
      result_thread_id: provisionalConversationId,
      result_checkpoint_id: ids.headResultCheckpoint,
    });
  });

  it('prepares history without source writes and atomically finalizes an equal active Route', async () => {
    await advanceSourceHead();
    const sourceBefore = (await pool.query(
      'SELECT head_checkpoint_id, name, status, updated_at FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0];
    const countsBefore = (await pool.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM workflow_routes) AS routes, ' +
      '(SELECT count(*)::int FROM workflow_threads) AS conversations, ' +
      '(SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints, ' +
      '(SELECT count(*)::int FROM workflow_messages) AS messages',
    )).rows[0];

    const prepared = await prepareUnified({
      commandId: ids.historyCommand,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      inputHash: 'history-hash-v1',
    });
    expect(prepared.execution.scope).toEqual({
      mode: 'history',
      contextId: ids.context,
      sourceRouteId: ids.route,
      sourceCheckpointId: ids.checkpoint,
    });
    expect(prepared.execution.baseCheckpoint).toMatchObject({ id: ids.checkpoint, version: 0 });
    expect((await pool.query(
      'SELECT head_checkpoint_id, name, status, updated_at FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0]).toEqual(sourceBefore);
    expect((await pool.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM workflow_routes) AS routes, ' +
      '(SELECT count(*)::int FROM workflow_threads) AS conversations, ' +
      '(SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints, ' +
      '(SELECT count(*)::int FROM workflow_messages) AS messages',
    )).rows[0]).toEqual(countsBefore);

    const committed = await repository.finalizeCommand(ids.historyCommand, finalizeInput({
      checkpointId: ids.historyResultCheckpoint,
      headCheckpointIdAtClaim: ids.sourceHeadCheckpoint,
      conversationTitle: 'Historical continuation',
    }), new Date(now.getTime() + 1000));
    expect(committed.status).toBe('succeeded');
    expect(committed.routeId).not.toBe(ids.route);
    expect(committed.conversationId).not.toBe(ids.thread);
    expect(committed.checkpointId).toBe(ids.historyResultCheckpoint);

    expect((await pool.query(
      'SELECT head_checkpoint_id, name, status, updated_at FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0]).toEqual(sourceBefore);
    const branchRoute = (await pool.query(
      'SELECT context_id, origin_checkpoint_id, head_checkpoint_id, status FROM workflow_routes WHERE id = $1',
      [committed.routeId],
    )).rows[0];
    expect(branchRoute).toEqual({
      context_id: ids.context,
      origin_checkpoint_id: ids.checkpoint,
      head_checkpoint_id: ids.historyResultCheckpoint,
      status: 'active',
    });
    const branchCheckpoints = (await pool.query(
      'SELECT id, parent_checkpoint_id, version, reason FROM workflow_checkpoints ' +
      'WHERE route_id = $1 ORDER BY version',
      [committed.routeId],
    )).rows;
    expect(branchCheckpoints).toEqual([
      {
        id: expect.any(String),
        parent_checkpoint_id: null,
        version: 0,
        reason: 'branch',
      },
      {
        id: ids.historyResultCheckpoint,
        parent_checkpoint_id: branchCheckpoints[0]?.id,
        version: 1,
        reason: 'workflow_action',
      },
    ]);
    expect((await pool.query(
      'SELECT context_id, route_id, title_source, is_primary, status FROM workflow_threads WHERE id = $1',
      [committed.conversationId],
    )).rows[0]).toEqual({
      context_id: ids.context,
      route_id: committed.routeId,
      title_source: 'agent',
      is_primary: true,
      status: 'active',
    });
    expect((await pool.query(
      'SELECT role, sequence FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
      [committed.conversationId],
    )).rows).toEqual([
      { role: 'user', sequence: 1 },
      { role: 'assistant', sequence: 2 },
    ]);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM workflow_messages WHERE thread_id = $1',
      [ids.thread],
    )).rows[0].count).toBe(0);
  });

  it('does not create a history Route before success and leaves none behind after failure', async () => {
    await advanceSourceHead();
    const prepared = await prepareUnified({
      commandId: ids.historyFailureCommand,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      inputHash: 'history-failure-hash',
    });
    expect(prepared.execution.scope.mode).toBe('history');
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_routes')).rows[0].count).toBe(1);

    await repository.failCommand(
      ids.historyFailureCommand,
      'WORKFLOW_UNAVAILABLE',
      new Date(now.getTime() + 1000),
    );
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_routes')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_threads')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_checkpoints')).rows[0].count).toBe(2);
    expect((await pool.query(
      'SELECT head_checkpoint_id FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0].head_checkpoint_id).toBe(ids.sourceHeadCheckpoint);
  });

  it('atomically records prepared artifacts in the historical result snapshot without changing its source', async () => {
    await advanceSourceHead();
    const objectId = '90000000-0000-4000-8000-000000000020';
    const readyArtifactId = '92000000-0000-4000-8000-000000000020';
    const failedArtifactId = '92000000-0000-4000-8000-000000000021';
    await pool.query(
      'INSERT INTO asset_objects ' +
      '(id, user_id, storage_key, sha256, byte_size, media_type, status, created_at) ' +
      "VALUES ($1, $2, 'objects/history-result', $3, 14, 'text/plain', 'ready', $4)",
      [objectId, ids.user, 'c'.repeat(64), now],
    );
    const sourceBefore = (await pool.query<{ id: string; snapshot: Record<string, unknown> }>(
      'SELECT id, snapshot FROM workflow_checkpoints WHERE route_id = $1 ORDER BY version',
      [ids.route],
    )).rows;
    await prepareUnified({
      commandId: ids.historyCommand,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      inputHash: 'history-artifact-atomic',
    });

    const committed = await repository.finalizeCommand(ids.historyCommand, finalizeInput({
      checkpointId: ids.historyResultCheckpoint,
      headCheckpointIdAtClaim: ids.sourceHeadCheckpoint,
      preparedArtifacts: [{
        status: 'ready',
        id: readyArtifactId,
        objectId,
        filename: 'history-result.txt',
        mediaType: 'text/plain',
        byteSize: 14,
        sha256: 'c'.repeat(64),
      }, {
        status: 'failed',
        id: failedArtifactId,
        filename: 'broken-result.bin',
        errorCode: 'ARTIFACT_STORAGE_FAILED',
      }],
    }), new Date(now.getTime() + 1000));

    expect(committed.status).toBe('succeeded');
    expect(committed.routeId).not.toBe(ids.route);
    const resultSnapshot = (await pool.query<{ snapshot: Record<string, any> }>(
      'SELECT snapshot FROM workflow_checkpoints WHERE id = $1',
      [ids.historyResultCheckpoint],
    )).rows[0]!.snapshot;
    expect(resultSnapshot.artifacts).toEqual([{
      id: readyArtifactId,
      stage_key: 'discover',
      filename: 'history-result.txt',
      media_type: 'text/plain',
      byte_size: 14,
      sha256: 'c'.repeat(64),
      created_at: new Date(now.getTime() + 1000).toISOString(),
    }]);
    expect((await pool.query(
      'SELECT id, route_id, thread_id, status, error_code FROM workflow_artifacts ' +
      'WHERE command_id = $1 ORDER BY id',
      [ids.historyCommand],
    )).rows).toEqual([
      {
        id: readyArtifactId,
        route_id: committed.routeId,
        thread_id: committed.conversationId,
        status: 'ready',
        error_code: null,
      },
      {
        id: failedArtifactId,
        route_id: committed.routeId,
        thread_id: committed.conversationId,
        status: 'failed',
        error_code: 'ARTIFACT_STORAGE_FAILED',
      },
    ]);
    expect((await pool.query<{ id: string; snapshot: Record<string, unknown> }>(
      'SELECT id, snapshot FROM workflow_checkpoints WHERE route_id = $1 ORDER BY version',
      [ids.route],
    )).rows).toEqual(sourceBefore);
  });

  it('rejects a stale expected version without moving the current head used for refresh', async () => {
    await advanceSourceHead();
    await expect(repository.prepareCommand(prepareInput({
      commandId: ids.historyCommand,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 1,
      inputHash: 'stale-version-hash',
    }))).rejects.toEqual(expect.objectContaining({ code: 'CHECKPOINT_VERSION_CONFLICT' }));
    expect((await pool.query(
      'SELECT head_checkpoint_id FROM workflow_routes WHERE id = $1',
      [ids.route],
    )).rows[0].head_checkpoint_id).toBe(ids.sourceHeadCheckpoint);
    expect((await domain.getRouteWorkspace(ids.user, ids.route))?.route.headCheckpointId)
      .toBe(ids.sourceHeadCheckpoint);
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM workflow_commands WHERE id = $1',
      [ids.historyCommand],
    )).rows[0].count).toBe(0);
  });

  it('loads immutable history by result-checkpoint causality with a conservative legacy fallback', async () => {
    await claimMessage({
      commandId: ids.nextCommand,
      inputHash: 'legacy-before-selected-checkpoint',
    });
    await repository.finalizeMessage(ids.nextCommand, messageResult({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      reply: 'Legacy message before the selected checkpoint.',
    }), new Date(now.getTime() - 1));

    await prepareUnified({ commandId: ids.command, inputHash: 'later-head-command' });
    await repository.finalizeCommand(ids.command, finalizeInput({
      checkpointId: ids.nextCheckpoint,
    }), now);

    const historical = await repository.prepareCommand(prepareInput({
      commandId: ids.historyCommand,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      inputHash: 'immutable-history-hash',
      now: new Date(now.getTime() + 1000),
      leaseExpiresAt: new Date(now.getTime() + 31_000),
    }));
    expect(historical.kind).toBe('claimed');
    if (historical.kind !== 'claimed') throw new Error('expected historical claim');
    expect(historical.execution.scope.mode).toBe('history');
    expect(historical.execution.history).toEqual([
      { role: 'user', content: 'Collect the strongest evidence.' },
      { role: 'assistant', content: 'Legacy message before the selected checkpoint.' },
    ]);
    expect(JSON.stringify(historical.execution.history)).not.toContain('The evidence is converging.');
  });

  it.each([
    ['message', {}],
    ['named intent', {
      input: { type: 'named_intent', key: 'summarize', content: 'Summarize the evidence.' },
      kind: 'named_action',
      actionKey: 'summarize',
      content: 'Summarize the evidence.',
      inputHash: 'named-intent-hash',
    }],
  ])('records one result checkpoint for a successful %s and preserves user-owned titles', async (_label, overrides) => {
    const prepared = await prepareUnified(overrides);
    const committed = await repository.finalizeCommand(ids.command, finalizeInput({
      contextTitle: 'Agent replacement Context',
      conversationTitle: 'Agent replacement Conversation',
    }), new Date(now.getTime() + 1000));
    expect(committed).toMatchObject({
      status: 'succeeded',
      routeId: ids.route,
      conversationId: ids.thread,
      checkpointId: ids.nextCheckpoint,
    });
    expect(prepared.execution.scope.mode).toBe('head');
    expect((await pool.query(
      'SELECT parent_checkpoint_id, version, reason FROM workflow_checkpoints WHERE id = $1',
      [ids.nextCheckpoint],
    )).rows[0]).toEqual({
      parent_checkpoint_id: ids.checkpoint,
      version: 1,
      reason: 'workflow_action',
    });
    expect((await pool.query(
      'SELECT result_checkpoint_id FROM workflow_commands WHERE id = $1',
      [ids.command],
    )).rows[0].result_checkpoint_id).toBe(ids.nextCheckpoint);
    expect((await pool.query(
      'SELECT title, title_source FROM contexts WHERE id = $1',
      [ids.context],
    )).rows[0]).toEqual({ title: 'Research project', title_source: 'user' });
    expect((await pool.query(
      'SELECT title, title_source FROM workflow_threads WHERE id = $1',
      [ids.thread],
    )).rows[0]).toEqual({ title: 'Evidence thread', title_source: 'user' });
  });

  it('atomically persists Workflow-owned state and exact arbitrary projections without mutating legacy Stage rows', async () => {
    await prepareUnified({ inputHash: 'workflow-owned-snapshot-v2' });
    const legacyProjectionBefore = (await pool.query(
      'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
      'WHERE route_id = $1 ORDER BY position',
      [ids.route],
    )).rows;
    const workflowState = {
      fsm: { node: 'deliver', revision: 7 },
      workflowPrivateState: { cursor: 'opaque-to-web' },
    };
    const stageProjection = {
      revision: 'workflow-v7',
      items: [
        { key: 'understand', label: '理解问题', status: 'workflow-complete' },
        {
          key: 'deliver',
          label: '交付',
          status: 'waiting-for-human-review',
          summary: '等待确认',
          checkpointId: ids.checkpoint,
        },
      ],
    };

    await repository.finalizeCommand(ids.command, finalizeInput({
      workflowState,
      workflowRevision: 'workflow-v7',
      stageProjection,
    }), new Date(now.getTime() + 1000));

    const snapshot = (await pool.query<{ snapshot: Record<string, unknown> }>(
      'SELECT snapshot FROM workflow_checkpoints WHERE id = $1',
      [ids.nextCheckpoint],
    )).rows[0]!.snapshot;
    expect(snapshot).toEqual({
      workflowState,
      workflowRevision: 'workflow-v7',
      sourceCommandId: ids.command,
      stageProjection,
      memoryReferences: [],
      artifacts: [],
    });
    expect((await pool.query(
      'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
      'WHERE route_id = $1 ORDER BY position',
      [ids.route],
    )).rows).toEqual(legacyProjectionBefore);

    await prepareUnified({
      commandId: ids.thirdCommand,
      baseCheckpointId: ids.nextCheckpoint,
      expectedCheckpointVersion: 1,
      inputHash: 'workflow-owned-snapshot-v2-unchanged-projection',
      now: new Date(now.getTime() + 1100),
      leaseExpiresAt: new Date(now.getTime() + 31_100),
    });
    await repository.finalizeCommand(ids.thirdCommand, finalizeInput({
      userMessageId: '70000000-0000-4000-8000-000000000005',
      assistantMessageId: '70000000-0000-4000-8000-000000000006',
      checkpointId: ids.conflictCheckpoint,
      headCheckpointIdAtClaim: ids.nextCheckpoint,
      workflowState: { fsm: { node: 'deliver', revision: 8 } },
    }), new Date(now.getTime() + 1200));
    const nextSnapshot = (await pool.query<{ snapshot: Record<string, unknown> }>(
      'SELECT snapshot FROM workflow_checkpoints WHERE id = $1',
      [ids.conflictCheckpoint],
    )).rows[0]!.snapshot;
    expect(nextSnapshot.stageProjection).toEqual(stageProjection);
    expect(nextSnapshot.memoryReferences).toEqual([]);
    expect(nextSnapshot.sourceCommandId).toBe(ids.thirdCommand);
    expect(nextSnapshot).not.toHaveProperty('workflowRevision');
  });

  it('keeps a conflicting memory update inactive until database-cursor resume confirms the current version', async () => {
    const initial = await memoryRepository.appendWorkflowVersion({
      userId: ids.user,
      contextId: ids.context,
      commandId: '60000000-0000-4000-8000-000000000090',
      conversationId: ids.thread,
      checkpointId: ids.checkpoint,
      update: {
        scope: 'context',
        key: 'goal',
        value: 'draft',
        evidence: [],
        impactScope: { contextIds: [ids.context] },
      },
      now,
    });
    const unmodified = await memoryRepository.appendWorkflowVersion({
      userId: ids.user,
      contextId: ids.context,
      commandId: '60000000-0000-4000-8000-000000000089',
      conversationId: ids.thread,
      checkpointId: ids.checkpoint,
      update: {
        scope: 'user',
        key: 'tone',
        value: 'concise',
        evidence: [],
        impactScope: { contextIds: 'all' },
      },
      now,
    });
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '3'.repeat(64),
      storageKey: 'objects/task6-interrupt-release',
    });
    await prepareUnified({
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'memory-conflict-origin',
    });
    const conflictingUpdate = {
      scope: 'context' as const,
      key: 'goal',
      value: 'silently-overwritten',
      expectedVersion: 9,
      confirmationPrompt: '确认覆盖当前目标？',
    };
    const privateCursor = {
      kind: 'memory_confirmation',
      token: 'postgres-only',
      update: conflictingUpdate,
      current: { id: initial.id, version: 1, value: 'draft' },
    };

    await repository.persistInterrupt(ids.command, {
      id: ids.interrupt,
      prompt: '确认覆盖当前目标？',
      cursor: privateCursor,
    }, new Date(now.getTime() + 100));

    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({ status: 'pending', claimed_command_id: null, claimed_context_id: null });

    expect(await memoryRepository.list(ids.user, {
      scope: 'context', contextId: ids.context,
    })).toEqual([expect.objectContaining({ id: initial.id, value: 'draft', version: 1 })]);
    expect(await memoryRepository.listVersions(ids.user, initial.id)).toHaveLength(1);
    const publicState = await repository.listConversationState(ids.user, ids.thread);
    expect(publicState?.pendingInterrupt).toMatchObject({
      id: ids.interrupt,
      prompt: '确认覆盖当前目标？',
    });
    expect(JSON.stringify(publicState)).not.toContain('postgres-only');
    expect(JSON.stringify(publicState)).not.toContain('silently-overwritten');

    const resumed = await prepareUnified({
      commandId: ids.nextCommand,
      input: { type: 'resume_interrupt', interruptId: ids.interrupt, content: '确认更新' },
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: '确认更新',
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'memory-conflict-resume',
      now: new Date(now.getTime() + 200),
      leaseExpiresAt: new Date(now.getTime() + 30_200),
    });
    expect(resumed.execution.interruptCursor).toEqual(privateCursor);
    expect((await pool.query(
      'SELECT claimed_command_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0].claimed_command_id).toBe(ids.nextCommand);
    expect(resumed.execution.memory).toMatchObject({
      user: [{ id: unmodified.id, version: 1 }],
      context: [{ id: initial.id, version: 1 }],
    });
    expect(await memoryRepository.listVersions(ids.user, initial.id)).toHaveLength(1);

    await repository.finalizeCommand(ids.nextCommand, finalizeInput({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      checkpointId: ids.nextCheckpoint,
      consumedMemoryReferences: [
        { memoryId: unmodified.id, version: 1 },
        { memoryId: initial.id, version: 1 },
      ],
      memoryUpdates: [{
        scope: 'context',
        key: 'goal',
        value: 'confirmed',
        expectedVersion: 1,
        evidence: [{ kind: 'interrupt', id: ids.interrupt }],
        impactScope: { contextIds: [ids.context] },
      }],
      attachmentIds: [ids.stagedAttachment],
    }), new Date(now.getTime() + 300));

    expect(await memoryRepository.list(ids.user, {
      scope: 'context', contextId: ids.context,
    })).toEqual([expect.objectContaining({
      id: initial.id,
      value: 'confirmed',
      status: 'active',
      version: 2,
    })]);
    const storedVersion = (await pool.query(
      'SELECT source FROM memory_item_versions WHERE memory_id = $1 AND version = 2',
      [initial.id],
    )).rows[0];
    expect(storedVersion.source).toMatchObject({
      kind: 'workflow',
      commandId: ids.nextCommand,
      conversationId: ids.thread,
      checkpointId: ids.nextCheckpoint,
    });
    const snapshot = (await pool.query(
      'SELECT snapshot FROM workflow_checkpoints WHERE id = $1',
      [ids.nextCheckpoint],
    )).rows[0].snapshot;
    expect(snapshot.memoryReferences).toEqual(expect.arrayContaining([
      { memoryId: unmodified.id, version: 1 },
      { memoryId: initial.id, version: 1 },
      { memoryId: initial.id, version: 2 },
    ]));
    expect(snapshot.memoryReferences).toHaveLength(3);
    expect((await pool.query(
      'SELECT status, resolution_command_id FROM workflow_interrupts WHERE id = $1',
      [ids.interrupt],
    )).rows[0]).toEqual({ status: 'resolved', resolution_command_id: ids.nextCommand });
  });

  it('atomically converts a post-detection memory race into a private pending interrupt', async () => {
    const initial = await memoryRepository.appendWorkflowVersion({
      userId: ids.user,
      contextId: ids.context,
      commandId: '60000000-0000-4000-8000-000000000091',
      conversationId: ids.thread,
      checkpointId: ids.checkpoint,
      update: {
        scope: 'context',
        key: 'goal',
        value: 'draft',
        evidence: [],
        impactScope: { contextIds: [ids.context] },
      },
      now,
    });
    await prepareUnified({ inputHash: 'memory-race-origin' });
    const staleUpdate = {
      scope: 'context' as const,
      key: 'goal',
      value: 'stale-finalize-value',
      expectedVersion: 1,
      confirmationPrompt: '确认覆盖刚更新的目标？',
    };

    await expect(memoryRepository.detectConflict({
      userId: ids.user,
      contextId: ids.context,
      update: staleUpdate,
    })).resolves.toBeNull();
    await memoryRepository.revise(ids.user, initial.id, {
      value: 'concurrent-value',
      expectedVersion: 1,
      evidence: [],
    }, new Date(now.getTime() + 50));
    const before = (await pool.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints, ' +
      '(SELECT count(*)::int FROM workflow_messages) AS messages',
    )).rows[0];

    const committed = await repository.finalizeCommand(ids.command, finalizeInput({
      memoryUpdates: [staleUpdate],
    }), new Date(now.getTime() + 100));

    expect(committed).toMatchObject({
      status: 'succeeded',
      checkpointId: null,
      userMessageId: null,
      assistantMessageId: null,
    });
    expect(await memoryRepository.list(ids.user, {
      scope: 'context', contextId: ids.context,
    })).toEqual([expect.objectContaining({
      id: initial.id,
      value: 'concurrent-value',
      version: 2,
    })]);
    expect(await memoryRepository.listVersions(ids.user, initial.id)).toHaveLength(2);
    expect((await pool.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM workflow_checkpoints) AS checkpoints, ' +
      '(SELECT count(*)::int FROM workflow_messages) AS messages',
    )).rows[0]).toEqual(before);

    const interrupt = (await pool.query(
      'SELECT id, prompt, workflow_cursor FROM workflow_interrupts ' +
      "WHERE originating_command_id = $1 AND status = 'pending'",
      [ids.command],
    )).rows[0];
    expect(interrupt).toMatchObject({
      prompt: staleUpdate.confirmationPrompt,
      workflow_cursor: {
        kind: 'memory_confirmation',
        update: staleUpdate,
        current: { id: initial.id, value: 'concurrent-value', version: 2 },
      },
    });
    expect((await pool.query(
      'SELECT status, result_checkpoint_id FROM workflow_commands WHERE id = $1',
      [ids.command],
    )).rows[0]).toEqual({ status: 'succeeded', result_checkpoint_id: null });
    const publicState = await repository.listConversationState(ids.user, ids.thread);
    expect(publicState?.pendingInterrupt).toMatchObject({
      id: interrupt.id,
      prompt: staleUpdate.confirmationPrompt,
    });
    expect(JSON.stringify(publicState)).not.toContain('stale-finalize-value');
    expect(JSON.stringify(publicState)).not.toContain('concurrent-value');
  });

  it('resolves an interrupt and records a result checkpoint for resume input', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: { id: ids.interrupt, prompt: 'Approve?', cursor: { secret: 'cursor-1' } },
    }), new Date(now.getTime() + 100));

    const prepared = await prepareUnified({
      commandId: ids.nextCommand,
      input: { type: 'resume_interrupt', interruptId: ids.interrupt, content: 'Approved.' },
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'Approved.',
      inputHash: 'unified-resume-hash',
      now: new Date(now.getTime() + 200),
      leaseExpiresAt: new Date(now.getTime() + 30_200),
    });
    expect(prepared.execution.interruptCursor).toEqual({ secret: 'cursor-1' });
    const committed = await repository.finalizeCommand(ids.nextCommand, finalizeInput({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      checkpointId: ids.nextCheckpoint,
    }), new Date(now.getTime() + 1000));
    expect(committed.checkpointId).toBe(ids.nextCheckpoint);
    expect((await pool.query(
      'SELECT result_checkpoint_id FROM workflow_commands WHERE id = $1',
      [ids.nextCommand],
    )).rows[0].result_checkpoint_id).toBe(ids.nextCheckpoint);
    expect((await pool.query(
      'SELECT status, resolution_command_id FROM workflow_interrupts WHERE id = $1',
      [ids.interrupt],
    )).rows[0]).toEqual({ status: 'resolved', resolution_command_id: ids.nextCommand });
  });

  it.each([
    ['primitive', 'opaque-primitive-cursor'],
    ['array', ['opaque-cursor', { step: 2 }]],
  ])('persists and reloads a %s Workflow interrupt cursor without changing its JSON value', async (_label, cursor) => {
    await prepareUnified({ inputHash: `cursor-${_label}-origin` });
    await repository.finalizeCommand(ids.command, finalizeInput({
      interrupt: {
        id: ids.interrupt,
        prompt: 'Approve?',
        cursor,
      },
    }), new Date(now.getTime() + 1000));

    expect((await pool.query<{ workflow_cursor: unknown }>(
      'SELECT workflow_cursor FROM workflow_interrupts WHERE id = $1',
      [ids.interrupt],
    )).rows[0]!.workflow_cursor).toEqual(cursor);

    const prepared = await prepareUnified({
      commandId: ids.nextCommand,
      baseCheckpointId: ids.nextCheckpoint,
      expectedCheckpointVersion: 1,
      input: { type: 'resume_interrupt', interruptId: ids.interrupt, content: 'Approved.' },
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'Approved.',
      inputHash: `cursor-${_label}-resume`,
      now: new Date(now.getTime() + 1100),
      leaseExpiresAt: new Date(now.getTime() + 31_100),
    });

    expect(prepared.execution.interruptCursor).toEqual(cursor);
  });

  it('adopts only owned staged attachments into the successful Command scope', async () => {
    const activeNow = new Date(Date.now() + 60_000);
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: 'c'.repeat(64),
      storageKey: 'objects/task3-owned',
    });
    await expect(assets.getOwnedAsset(ids.user, 'attachment', ids.stagedAttachment)).resolves.toMatchObject({
      filename: 'notes.txt',
      object: { id: ids.attachmentObject },
    });
    await expect(assets.getOwnedAsset(ids.otherUser, 'attachment', ids.stagedAttachment)).resolves.toBeNull();
    await prepareUnified({
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'attachment-hash',
      now: activeNow,
      leaseExpiresAt: new Date(activeNow.getTime() + 30_000),
    });
    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id, adopted_command_id ' +
      'FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({
      status: 'pending',
      claimed_command_id: ids.command,
      claimed_context_id: ids.context,
      adopted_command_id: null,
    });
    await expect(assets.deleteStagedAttachment(ids.user, ids.stagedAttachment)).resolves.toBe(false);
    await expect(repository.prepareCommand(prepareInput({
      commandId: ids.nextCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'running-command-already-claimed-attachment-hash',
      now: new Date(now.getTime() + 100),
      leaseExpiresAt: new Date(now.getTime() + 30_100),
    }))).rejects.toEqual(expect.objectContaining({ code: 'COMMAND_SCOPE_INVALID' }));

    const committed = await repository.finalizeCommand(ids.command, finalizeInput({
      attachmentIds: [ids.stagedAttachment],
    }), new Date(activeNow.getTime() + 1000));
    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id, adopted_command_id, adopted_context_id ' +
      'FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({
      status: 'adopted',
      claimed_command_id: null,
      claimed_context_id: null,
      adopted_command_id: ids.command,
      adopted_context_id: ids.context,
    });
    expect((await pool.query(
      'SELECT user_id, object_id, context_id, route_id, thread_id, stage_key, filename ' +
      'FROM workflow_attachments WHERE object_id = $1',
      [ids.attachmentObject],
    )).rows).toEqual([{
      user_id: ids.user,
      object_id: ids.attachmentObject,
      context_id: ids.context,
      route_id: committed.routeId,
      thread_id: committed.conversationId,
      stage_key: null,
      filename: 'notes.txt',
    }]);

    await expect(repository.prepareCommand(prepareInput({
      commandId: ids.nextCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'already-adopted-attachment-hash',
      now: new Date(activeNow.getTime() + 2000),
      leaseExpiresAt: new Date(activeNow.getTime() + 32_000),
    }))).rejects.toEqual(expect.objectContaining({ code: 'COMMAND_SCOPE_INVALID' }));
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM workflow_attachments WHERE object_id = $1',
      [ids.attachmentObject],
    )).rows[0].count).toBe(1);
    await expect(assets.listConversationAttachments(ids.user, committed.conversationId)).resolves.toEqual([
      expect.objectContaining({ kind: 'attachment', filename: 'notes.txt' }),
    ]);
    await expect(assets.listConversationAttachments(ids.otherUser, committed.conversationId)).resolves.toBeNull();
    await expect(assets.deleteStagedAttachment(ids.user, ids.stagedAttachment)).resolves.toBe(false);
  });

  it('deletes only an unclaimed pending staged attachment through the real asset repository', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.otherAttachmentObject,
      attachmentId: ids.otherStagedAttachment,
      sha256: 'f'.repeat(64),
      storageKey: 'objects/task6-unclaimed-delete',
    });

    await expect(assets.listConversationAttachments(ids.user, ids.thread)).resolves.toEqual([]);
    await expect(assets.listConversationAttachments(ids.otherUser, ids.thread)).resolves.toBeNull();
    await expect(assets.deleteStagedAttachment(ids.otherUser, ids.otherStagedAttachment)).resolves.toBe(false);
    await expect(assets.deleteStagedAttachment(ids.user, ids.otherStagedAttachment)).resolves.toBe(true);
    await expect(assets.deleteStagedAttachment(ids.user, ids.otherStagedAttachment)).resolves.toBe(false);
  });

  it('allows exactly one of two concurrent Commands to durably claim a staged attachment', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '1'.repeat(64),
      storageKey: 'objects/task6-concurrent-claim',
    });

    const settled = await Promise.allSettled([
      repository.prepareCommand(prepareInput({
        commandId: ids.command,
        attachmentIds: [ids.stagedAttachment],
        inputHash: 'concurrent-attachment-claim-one',
      })),
      repository.prepareCommand(prepareInput({
        commandId: ids.nextCommand,
        attachmentIds: [ids.stagedAttachment],
        inputHash: 'concurrent-attachment-claim-two',
      })),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'COMMAND_SCOPE_INVALID' }) }),
    ]);
    const running = (await pool.query(
      "SELECT id FROM workflow_commands WHERE status = 'running'",
    )).rows;
    expect(running).toHaveLength(1);
    expect((await pool.query(
      'SELECT claimed_command_id, claimed_context_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({
      claimed_command_id: running[0].id,
      claimed_context_id: ids.context,
    });
  });

  it('terminalizes an abandoned unstarted Command and releases all of its claims before takeover', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '5'.repeat(64),
      storageKey: 'objects/task6-abandoned-command-primary',
    });
    await stageAttachment({
      userId: ids.user,
      objectId: ids.otherAttachmentObject,
      attachmentId: ids.otherStagedAttachment,
      sha256: '6'.repeat(64),
      storageKey: 'objects/task6-abandoned-command-secondary',
    });
    const abandonedInput = prepareInput({
      attachmentIds: [ids.stagedAttachment, ids.otherStagedAttachment],
      inputHash: 'abandoned-command-attachments',
      leaseExpiresAt: new Date(now.getTime() + 100),
    });
    await repository.prepareCommand(abandonedInput);

    const takeover = await repository.prepareCommand(prepareInput({
      commandId: ids.nextCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'replacement-command-attachment',
      now: new Date(now.getTime() + 200),
      leaseExpiresAt: new Date(now.getTime() + 30_200),
    }));

    expect(takeover.kind).toBe('claimed');
    expect((await pool.query(
      'SELECT status, lease_expires_at, error_code FROM workflow_commands WHERE id = $1',
      [ids.command],
    )).rows[0]).toEqual({ status: 'failed', lease_expires_at: null, error_code: 'COMMAND_LEASE_EXPIRED' });
    expect((await pool.query(
      'SELECT event_type, payload FROM workflow_command_events WHERE command_id = $1 ORDER BY sequence DESC LIMIT 1',
      [ids.command],
    )).rows[0]).toEqual({
      event_type: 'command.finished',
      payload: { outcome: 'failed', code: 'COMMAND_LEASE_EXPIRED' },
    });
    expect((await pool.query(
      'SELECT id, claimed_command_id FROM staged_attachments ORDER BY id',
    )).rows).toEqual([
      { id: ids.stagedAttachment, claimed_command_id: ids.nextCommand },
      { id: ids.otherStagedAttachment, claimed_command_id: null },
    ]);
    await expect(assets.deleteStagedAttachment(ids.user, ids.otherStagedAttachment)).resolves.toBe(true);

    const replay = await repository.prepareCommand({
      ...abandonedInput,
      now: new Date(now.getTime() + 300),
      leaseExpiresAt: new Date(now.getTime() + 30_300),
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected abandoned Command replay');
    expect(replay.command).toMatchObject({ status: 'failed', errorCode: 'COMMAND_LEASE_EXPIRED' });
  });

  it('terminalizes an abandoned started Command before deleting its claimed attachment', async () => {
    const abandonedNow = new Date(Date.now() - 60_000);
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '7'.repeat(64),
      storageKey: 'objects/task6-abandoned-started-delete',
    });
    const abandonedInput = prepareInput({
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'abandoned-started-attachment',
      now: abandonedNow,
      leaseExpiresAt: new Date(abandonedNow.getTime() + 100),
    });
    await repository.prepareCommand(abandonedInput);
    await repository.appendEvent(
      ids.command,
      'workflow.started',
      { attempt: 1 },
      new Date(abandonedNow.getTime() + 50),
    );

    await expect(assets.deleteStagedAttachment(ids.user, ids.stagedAttachment)).resolves.toBe(true);

    expect((await pool.query(
      'SELECT status, lease_expires_at, error_code FROM workflow_commands WHERE id = $1',
      [ids.command],
    )).rows[0]).toEqual({ status: 'failed', lease_expires_at: null, error_code: 'WORKFLOW_OUTCOME_UNKNOWN' });
    expect((await pool.query(
      'SELECT event_type, payload FROM workflow_command_events WHERE command_id = $1 ORDER BY sequence DESC LIMIT 1',
      [ids.command],
    )).rows[0]).toEqual({
      event_type: 'command.finished',
      payload: { outcome: 'failed', code: 'WORKFLOW_OUTCOME_UNKNOWN' },
    });
    expect((await pool.query(
      'SELECT count(*)::int AS count FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0].count).toBe(0);

    const replay = await repository.prepareCommand({
      ...abandonedInput,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected abandoned Command replay');
    expect(replay.command).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_OUTCOME_UNKNOWN' });
  });

  it('keeps attachments pending on failure so a new Command can retry the same opaque ID', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: 'd'.repeat(64),
      storageKey: 'objects/task3-pending',
    });
    await prepareUnified({ attachmentIds: [ids.stagedAttachment], inputHash: 'pending-attachment-hash' });
    expect((await pool.query(
      'SELECT claimed_command_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0].claimed_command_id).toBe(ids.command);
    await repository.failCommand(ids.command, 'WORKFLOW_UNAVAILABLE', new Date(now.getTime() + 1000));
    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id, adopted_command_id ' +
      'FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({
      status: 'pending', claimed_command_id: null, claimed_context_id: null, adopted_command_id: null,
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_attachments')).rows[0].count).toBe(0);

    await prepareUnified({
      commandId: ids.nextCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'retry-pending-attachment-hash',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    });
    expect((await pool.query(
      'SELECT claimed_command_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0].claimed_command_id).toBe(ids.nextCommand);
    await repository.finalizeCommand(ids.nextCommand, finalizeInput({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      attachmentIds: [ids.stagedAttachment],
    }), new Date(now.getTime() + 3000));
    expect((await pool.query(
      'SELECT status, adopted_command_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({ status: 'adopted', adopted_command_id: ids.nextCommand });
  });

  it('hides staged attachments owned by another user from Command claims', async () => {

    await stageAttachment({
      userId: ids.otherUser,
      objectId: ids.otherAttachmentObject,
      attachmentId: ids.otherStagedAttachment,
      sha256: 'e'.repeat(64),
      storageKey: 'objects/task3-other-user',
    });
    await expect(repository.prepareCommand(prepareInput({
      commandId: ids.nextCommand,
      attachmentIds: [ids.otherStagedAttachment],
      inputHash: 'other-attachment-hash',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }))).rejects.toEqual(expect.objectContaining({ code: 'COMMAND_SCOPE_INVALID' }));
    expect((await pool.query(
      'SELECT status, adopted_command_id FROM staged_attachments WHERE id = $1',
      [ids.otherStagedAttachment],
    )).rows[0]).toEqual({ status: 'pending', adopted_command_id: null });
  });

  it('lists owned messages in sequence order and exposes only the public pending interrupt', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: {
        id: ids.interrupt,
        prompt: 'Which source should be authoritative?',
        cursor: { node: 'approval', token: 'private-token' },
      },
    }), new Date(now.getTime() + 1000));

    const state = await repository.listThreadState(ids.user, ids.thread);
    expect(state).toEqual({
      messages: [
        expect.objectContaining({ id: ids.userMessage, role: 'user', sequence: 1 }),
        expect.objectContaining({ id: ids.assistantMessage, role: 'assistant', sequence: 2 }),
      ],
      pendingInterrupt: {
        id: ids.interrupt,
        prompt: 'Which source should be authoritative?',
        actionKey: null,
        createdAt: expect.any(Date),
      },
    });
    expect(JSON.stringify(state)).not.toContain('private-token');
    expect(await repository.listThreadState(ids.otherUser, ids.thread)).toBeNull();
  });

  it('claims the first command with owned execution state and an accepted event', async () => {
    const claimed = await claimMessage();
    expect(claimed.command).toMatchObject({
      id: ids.command,
      status: 'running',
      attempt: 1,
      sourceRouteId: ids.route,
      sourceThreadId: ids.thread,
    });
    expect(claimed.execution).toMatchObject({
      userId: ids.user,
      contextId: ids.context,
      routeId: ids.route,
      threadId: ids.thread,
      stageKey: 'discover',
      baseCheckpoint: { id: ids.checkpoint, version: 0 },
      headCheckpointId: ids.checkpoint,
      baseIsHead: true,
      history: [],
      stages,
    });
    const events = await pool.query(
      'SELECT sequence, event_type, payload FROM workflow_command_events WHERE command_id = $1',
      [ids.command],
    );
    expect(events.rows).toEqual([{ sequence: 1, event_type: 'command.accepted', payload: { status: 'running' } }]);
  });

  it('lists owned command events after a replay cursor without exposing execution state', async () => {
    await claimMessage();
    await repository.appendEvent(ids.command, 'workflow.started', { attempt: 1 }, new Date(now.getTime() + 100));
    const first = await repository.listCommandEvents(ids.user, ids.command, 0);
    expect(first).toMatchObject({ status: 'running' });
    expect(first?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(await repository.listCommandEvents(ids.user, ids.command, 1))
      .toMatchObject({ events: [expect.objectContaining({ sequence: 2 })] });
    expect(await repository.listCommandEvents(ids.otherUser, ids.command, 0)).toBeNull();
  });

  it('replays an identical completed command without adding rows', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult(), new Date(now.getTime() + 1000));
    const replay = await repository.claimCommand(claimInput({ now: new Date(now.getTime() + 2000) }));
    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected replay');
    expect(replay.command.status).toBe('succeeded');
    expect(replay.events.map((event) => event.eventType)).toEqual([
      'command.accepted',
      'assistant.delta',
      'workspace.committed',
      'command.finished',
    ]);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_messages')).rows[0].count).toBe(2);
  });

  it('rejects reuse of a command ID with a different canonical input hash', async () => {
    await claimMessage();
    expect(await repository.claimCommand(claimInput({ inputHash: 'different-hash' }))).toEqual({ kind: 'reused' });
  });

  it('hides an existing command id from a different user before comparing hashes', async () => {
    await claimMessage();
    await expect(repository.claimCommand(claimInput({ userId: ids.otherUser, inputHash: 'other-user-hash' })))
      .rejects.toEqual(expect.objectContaining({ code: 'COMMAND_SCOPE_INVALID' }));
  });

  it('reports an active command lease as in progress', async () => {
    await claimMessage();
    expect((await repository.claimCommand(claimInput({ now: new Date(now.getTime() + 1000) }))))
      .toEqual({ kind: 'in_progress' });
  });

  it('serializes concurrent exact legacy first claims in the shared command-id namespace', async () => {
    const results = await Promise.all([
      repository.claimCommand(claimInput()),
      repository.claimCommand(claimInput()),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['claimed', 'in_progress']);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM workflow_command_events " +
      "WHERE command_id = $1 AND event_type = 'command.accepted'",
      [ids.command],
    )).rows[0].count).toBe(1);
  });

  it('reclaims an expired lease before workflow start and increases the attempt', async () => {
    await claimMessage({ leaseExpiresAt: new Date(now.getTime() + 1000) });
    const reclaimed = await repository.claimCommand(claimInput({
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }));
    expect(reclaimed.kind).toBe('claimed');
    if (reclaimed.kind !== 'claimed') throw new Error('expected reclaimed command');
    expect(reclaimed.command.attempt).toBe(2);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM workflow_command_events WHERE command_id = $1 AND event_type = 'command.accepted'",
      [ids.command],
    )).rows[0].count).toBe(1);
  });

  it('reclaims the immutable accepted head scope and conflicts if that original head advanced', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '2'.repeat(64),
      storageKey: 'objects/task6-conflict-release',
    });
    const prepared = await repository.prepareCommand(prepareInput({
      commandId: ids.headCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'reclaim-head-hash',
      leaseExpiresAt: new Date(now.getTime() + 100),
    }));
    expect(prepared.kind).toBe('claimed');
    if (prepared.kind !== 'claimed') throw new Error('expected initial claim');
    expect(prepared.execution.scope.mode).toBe('head');

    await advanceSourceHead();
    const reclaimed = await repository.prepareCommand(prepareInput({
      commandId: ids.headCommand,
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'reclaim-head-hash',
      now: new Date(now.getTime() + 200),
      leaseExpiresAt: new Date(now.getTime() + 30_200),
    }));
    expect(reclaimed.kind).toBe('claimed');
    if (reclaimed.kind !== 'claimed') throw new Error('expected reclaimed command');
    expect(reclaimed.command.attempt).toBe(2);
    expect(reclaimed.execution.scope).toEqual({
      mode: 'head', contextId: ids.context, routeId: ids.route, conversationId: ids.thread,
    });

    const committed = await repository.finalizeCommand(ids.headCommand, finalizeInput({
      checkpointId: ids.headResultCheckpoint,
      headCheckpointIdAtClaim: ids.sourceHeadCheckpoint,
    }), new Date(now.getTime() + 300));
    expect(committed).toMatchObject({
      status: 'conflict', errorCode: 'CHECKPOINT_VERSION_CONFLICT', checkpointId: null,
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_routes')).rows[0].count).toBe(1);
    expect((await pool.query(
      'SELECT head_checkpoint_id FROM workflow_routes WHERE id = $1', [ids.route],
    )).rows[0].head_checkpoint_id).toBe(ids.sourceHeadCheckpoint);
    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({ status: 'pending', claimed_command_id: null, claimed_context_id: null });
    await expect(assets.deleteStagedAttachment(ids.user, ids.stagedAttachment)).resolves.toBe(true);
  });

  it('releases a staged attachment when an expired unified Workflow outcome becomes unknown', async () => {
    await stageAttachment({
      userId: ids.user,
      objectId: ids.attachmentObject,
      attachmentId: ids.stagedAttachment,
      sha256: '4'.repeat(64),
      storageKey: 'objects/task6-expired-release',
    });
    const input = prepareInput({
      attachmentIds: [ids.stagedAttachment],
      inputHash: 'expired-unified-attachment-claim',
      leaseExpiresAt: new Date(now.getTime() + 100),
    });
    await repository.prepareCommand(input);
    await repository.appendEvent(ids.command, 'workflow.started', { attempt: 1 }, new Date(now.getTime() + 50));

    const replay = await repository.prepareCommand({
      ...input,
      now: new Date(now.getTime() + 200),
      leaseExpiresAt: new Date(now.getTime() + 30_200),
    });

    expect(replay.kind).toBe('replay');
    if (replay.kind !== 'replay') throw new Error('expected terminal replay');
    expect(replay.command).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_OUTCOME_UNKNOWN' });
    expect((await pool.query(
      'SELECT status, claimed_command_id, claimed_context_id FROM staged_attachments WHERE id = $1',
      [ids.stagedAttachment],
    )).rows[0]).toEqual({ status: 'pending', claimed_command_id: null, claimed_context_id: null });
    await expect(assets.deleteStagedAttachment(ids.user, ids.stagedAttachment)).resolves.toBe(true);
  });

  it('terminally fails an expired lease after workflow start instead of reclaiming it', async () => {
    await claimMessage({ leaseExpiresAt: new Date(now.getTime() + 1000) });
    await repository.appendEvent(
      ids.command,
      'workflow.started',
      { attempt: 1 },
      new Date(now.getTime() + 500),
    );
    const result = await repository.claimCommand(claimInput({
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }));
    expect(result.kind).toBe('replay');
    if (result.kind !== 'replay') throw new Error('expected terminal replay');
    expect(result.command).toMatchObject({ status: 'failed', attempt: 1, errorCode: 'WORKFLOW_OUTCOME_UNKNOWN' });
    expect(result.events.at(-1)).toMatchObject({
      eventType: 'command.finished',
      payload: { outcome: 'failed', code: 'WORKFLOW_OUTCOME_UNKNOWN' },
    });
  });

  it('persists a safe terminal failure event without writing domain rows', async () => {
    await claimMessage();
    const events = await repository.failCommand(
      ids.command,
      'WORKFLOW_UNAVAILABLE',
      new Date(now.getTime() + 1000),
    );
    expect(events.at(-1)).toMatchObject({
      eventType: 'command.finished',
      payload: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' },
    });
    expect((await pool.query('SELECT status, error_code FROM workflow_commands WHERE id = $1', [ids.command])).rows[0])
      .toEqual({ status: 'failed', error_code: 'WORKFLOW_UNAVAILABLE' });
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_messages')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_checkpoints')).rows[0].count).toBe(1);
  });

  it('finalizes a message with exactly two append-only messages and no checkpoint', async () => {
    await claimMessage();
    const committed = await repository.finalizeMessage(
      ids.command,
      messageResult(),
      new Date(now.getTime() + 1000),
    );
    expect(committed).toMatchObject({
      status: 'succeeded',
      routeId: ids.route,
      threadId: ids.thread,
      checkpointId: null,
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
    });
    expect(committed.events.at(-1)).toMatchObject({
      eventType: 'command.finished',
      payload: { outcome: 'succeeded', resultRouteId: ids.route, resultThreadId: ids.thread },
    });
    expect((await pool.query('SELECT role, content, sequence FROM workflow_messages ORDER BY sequence')).rows).toEqual([
      { role: 'user', content: 'Collect the strongest evidence.', sequence: 1 },
      { role: 'assistant', content: 'The evidence is converging.', sequence: 2 },
    ]);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_checkpoints')).rows[0].count).toBe(1);
  });

  it('finalizes a head action with messages, one checkpoint, and forward projections', async () => {
    await claimMessage({ kind: 'named_action', actionKey: 'advance', inputHash: 'action-hash' });
    const objectId = '90000000-0000-4000-8000-000000000001';
    const artifactId = '90000000-0000-4000-8000-000000000002';
    await pool.query(
      "INSERT INTO asset_objects (id, user_id, storage_key, sha256, byte_size, media_type, status, created_at) VALUES ($1, $2, 'objects/result', $3, 6, 'text/plain', 'ready', $4)",
      [objectId, ids.user, 'a'.repeat(64), now],
    );
    await pool.query(
      "INSERT INTO workflow_artifacts (id, user_id, object_id, command_id, context_id, route_id, thread_id, stage_key, filename, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'discover', 'result.txt', 'ready', $8)",
      [artifactId, ids.user, objectId, ids.command, ids.context, ids.route, ids.thread, now],
    );
    const committed = await repository.finalizeAction(ids.command, {
      reply: 'Discovery is complete; decision work can begin.',
      stageSignals: [
        { stageKey: 'discover', status: 'completed', internalState: 'done' },
        { stageKey: 'decide', status: 'active', internalState: 'compare' },
      ],
      memoryProposals: [{ scope: 'context', value: 'Evidence complete' }],
      adoptedThreadId: ids.thread,
    }, {
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      checkpointId: ids.nextCheckpoint,
      headCheckpointIdAtClaim: ids.checkpoint,
    }, new Date(now.getTime() + 1000));
    expect(committed).toMatchObject({
      status: 'succeeded',
      routeId: ids.route,
      threadId: ids.thread,
      checkpointId: ids.nextCheckpoint,
    });
    const checkpoint = (await pool.query('SELECT * FROM workflow_checkpoints WHERE id = $1', [ids.nextCheckpoint])).rows[0];
    expect(checkpoint).toMatchObject({
      parent_checkpoint_id: ids.checkpoint,
      version: 1,
      reason: 'workflow_action',
    });
    expect(checkpoint.snapshot).toMatchObject({
      command: { id: ids.command, kind: 'named_action', action_key: 'advance' },
      adopted_thread_id: ids.thread,
      result_message_ids: [ids.userMessage, ids.assistantMessage],
      artifacts: [{
        id: artifactId,
        stage_key: 'discover',
        filename: 'result.txt',
        media_type: 'text/plain',
        byte_size: 6,
        sha256: 'a'.repeat(64),
      }],
    });
    await expect(assets.listStageArtifacts(ids.user, ids.route, 'discover')).resolves.toEqual([
      expect.objectContaining({ id: artifactId, filename: 'result.txt' }),
    ]);
    const continuedRouteId = '30000000-0000-4000-8000-000000000009';
    await domain.branchRoute({
      userId: ids.user,
      contextId: ids.context,
      sourceCheckpointId: ids.nextCheckpoint,
      routeId: continuedRouteId,
      routeName: 'Continued route',
      checkpointId: '40000000-0000-4000-8000-000000000009',
      now: new Date(now.getTime() + 2000),
    });
    await expect(assets.listStageArtifacts(ids.user, continuedRouteId, 'discover')).resolves.toEqual([
      expect.objectContaining({ id: artifactId, filename: 'result.txt' }),
    ]);
    expect((await pool.query('SELECT scope, proposal_key, proposal_value, status FROM memory_proposals WHERE command_id = $1', [ids.command])).rows)
      .toEqual([{ scope: 'context', proposal_key: 'proposal_1', proposal_value: 'Evidence complete', status: 'pending' }]);
    const proposalId = (await pool.query('SELECT id FROM memory_proposals WHERE command_id = $1', [ids.command])).rows[0].id;
    await pool.query("UPDATE memory_proposals SET status='adopted', decided_at=now() WHERE id=$1", [proposalId]);
    await expect(pool.query("UPDATE memory_proposals SET status='rejected', decided_at=now() WHERE id=$1", [proposalId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM memory_proposals WHERE id=$1', [proposalId]))
      .rejects.toMatchObject({ code: '55000' });
    expect((await pool.query(
      'SELECT stage_key, status, internal_state FROM route_stage_projections WHERE route_id = $1 ORDER BY position',
      [ids.route],
    )).rows).toEqual([
      { stage_key: 'discover', status: 'completed', internal_state: 'done' },
      { stage_key: 'decide', status: 'active', internal_state: 'compare' },
    ]);
  });

  it('turns a guarded head change into a conflict without domain writes', async () => {
    await claimMessage({ kind: 'named_action', actionKey: 'advance', inputHash: 'guarded-action' });
    await pool.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.route, ids.checkpoint]);
    await pool.query(
      "INSERT INTO workflow_checkpoints (id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) VALUES ($1, $2, $3, $4, 1, 'discover', 'workflow_action', $5, $6)",
      [ids.nextCheckpoint, ids.context, ids.route, ids.checkpoint, { stages: [] }, new Date(now.getTime() + 500)],
    );
    await pool.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.route, ids.nextCheckpoint]);

    const result = await repository.finalizeAction(ids.command, {
      reply: 'This result is stale.',
      stageSignals: [{ stageKey: 'discover', status: 'completed', internalState: 'done' }],
      memoryProposals: [],
      adoptedThreadId: null,
    }, {
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      checkpointId: ids.conflictCheckpoint,
      headCheckpointIdAtClaim: ids.checkpoint,
    }, new Date(now.getTime() + 1000));
    expect(result).toMatchObject({ status: 'conflict', errorCode: 'CHECKPOINT_VERSION_CONFLICT' });
    expect(result.events.at(-1)).toMatchObject({
      eventType: 'command.finished',
      payload: { outcome: 'conflict', code: 'CHECKPOINT_VERSION_CONFLICT' },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_messages')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_checkpoints')).rows[0].count).toBe(2);
    expect((await pool.query('SELECT status, error_code FROM workflow_commands WHERE id = $1', [ids.command])).rows[0])
      .toEqual({ status: 'conflict', error_code: 'CHECKPOINT_VERSION_CONFLICT' });
  });

  it('persists an interrupted message prompt and private cursor separately', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: { id: ids.interrupt, prompt: 'Approve the evidence set?', cursor: { secret: 'cursor-1' } },
    }), new Date(now.getTime() + 1000));
    const row = (await pool.query('SELECT prompt, workflow_cursor, status FROM workflow_interrupts')).rows[0];
    expect(row).toEqual({ prompt: 'Approve the evidence set?', workflow_cursor: { secret: 'cursor-1' }, status: 'pending' });
    expect(JSON.stringify(await repository.listThreadState(ids.user, ids.thread))).not.toContain('cursor-1');
  });

  it('loads a matching private cursor for resume and resolves exactly that interrupt', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: { id: ids.interrupt, prompt: 'Approve?', cursor: { secret: 'cursor-1' } },
    }), new Date(now.getTime() + 1000));
    const resume = await repository.claimCommand(claimInput({
      commandId: ids.nextCommand,
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'Approved.',
      inputHash: 'resume-hash',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }));
    expect(resume.kind).toBe('claimed');
    if (resume.kind !== 'claimed') throw new Error('expected resume claim');
    expect(resume.execution.interruptCursor).toEqual({ secret: 'cursor-1' });
    await repository.finalizeMessage(ids.nextCommand, messageResult({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      reply: 'Approval recorded.',
    }), new Date(now.getTime() + 3000));
    expect((await pool.query('SELECT status, resolution_command_id FROM workflow_interrupts WHERE id = $1', [ids.interrupt])).rows[0])
      .toEqual({ status: 'resolved', resolution_command_id: ids.nextCommand });
    expect((await repository.listThreadState(ids.user, ids.thread))?.pendingInterrupt).toBeNull();
  });

  it('allows only one command id to claim a pending interrupt', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: { id: ids.interrupt, prompt: 'Approve?', cursor: { secret: 'cursor-1' } },
    }), new Date(now.getTime() + 1000));
    const first = await repository.claimCommand(claimInput({
      commandId: ids.nextCommand,
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'Approved.',
      inputHash: 'resume-hash-1',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }));
    expect(first.kind).toBe('claimed');
    const second = await repository.claimCommand(claimInput({
      commandId: ids.thirdCommand,
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'Approved again.',
      inputHash: 'resume-hash-2',
      now: new Date(now.getTime() + 2100),
      leaseExpiresAt: new Date(now.getTime() + 32_100),
    }));
    expect(second).toEqual({ kind: 'interrupt_claimed' });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM workflow_commands WHERE kind = 'resume_interrupt' AND interrupt_id = $1",
      [ids.interrupt],
    )).rows[0].count).toBe(1);
  });

  it('resolves the old interrupt and creates one new pending interrupt when resume interrupts again', async () => {
    await claimMessage();
    await repository.finalizeMessage(ids.command, messageResult({
      interrupt: { id: ids.interrupt, prompt: 'First question?', cursor: { step: 1 } },
    }), new Date(now.getTime() + 1000));
    await claimMessage({
      commandId: ids.nextCommand,
      kind: 'resume_interrupt',
      interruptId: ids.interrupt,
      content: 'First answer.',
      inputHash: 'resume-hash',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    });
    await repository.finalizeMessage(ids.nextCommand, messageResult({
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      reply: 'Second question?',
      interrupt: { id: ids.nextInterrupt, prompt: 'Second question?', cursor: { step: 2 } },
    }), new Date(now.getTime() + 3000));
    expect((await pool.query('SELECT id, status FROM workflow_interrupts ORDER BY created_at, id')).rows).toEqual([
      { id: ids.interrupt, status: 'resolved' },
      { id: ids.nextInterrupt, status: 'pending' },
    ]);
    expect((await repository.listThreadState(ids.user, ids.thread))?.pendingInterrupt).toMatchObject({
      id: ids.nextInterrupt,
      prompt: 'Second question?',
    });
  });
});
