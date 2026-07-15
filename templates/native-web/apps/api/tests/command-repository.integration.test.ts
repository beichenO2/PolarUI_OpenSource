import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandRepository } from '../src/commands/repository.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDomainRepository } from '../src/domain/repository.js';

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
  derivedRoute: '30000000-0000-4000-8000-000000000002',
  checkpoint: '40000000-0000-4000-8000-000000000001',
  nextCheckpoint: '40000000-0000-4000-8000-000000000002',
  derivedCheckpoint: '40000000-0000-4000-8000-000000000003',
  thread: '50000000-0000-4000-8000-000000000001',
  derivedThread: '50000000-0000-4000-8000-000000000002',
  command: '60000000-0000-4000-8000-000000000001',
  nextCommand: '60000000-0000-4000-8000-000000000002',
  thirdCommand: '60000000-0000-4000-8000-000000000003',
  userMessage: '70000000-0000-4000-8000-000000000001',
  assistantMessage: '70000000-0000-4000-8000-000000000002',
  nextUserMessage: '70000000-0000-4000-8000-000000000003',
  nextAssistantMessage: '70000000-0000-4000-8000-000000000004',
  interrupt: '80000000-0000-4000-8000-000000000001',
  nextInterrupt: '80000000-0000-4000-8000-000000000002',
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

  async function claimMessage(overrides: Record<string, unknown> = {}) {
    const claimed = await repository.claimCommand(claimInput(overrides));
    expect(claimed.kind).toBe('claimed');
    if (claimed.kind !== 'claimed') throw new Error('expected claimed command');
    return claimed;
  }

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
    });
    expect((await pool.query(
      'SELECT stage_key, status, internal_state FROM route_stage_projections WHERE route_id = $1 ORDER BY position',
      [ids.route],
    )).rows).toEqual([
      { stage_key: 'discover', status: 'completed', internal_state: 'done' },
      { stage_key: 'decide', status: 'active', internal_state: 'compare' },
    ]);
  });

  it('derives a route and thread for a historical action while preserving the source workspace', async () => {
    await claimMessage({ kind: 'named_action', actionKey: 'adopt_thread', inputHash: 'head-action' });
    await repository.finalizeAction(ids.command, {
      reply: 'Current route checkpoint.',
      stageSignals: [],
      memoryProposals: [],
      adoptedThreadId: ids.thread,
    }, {
      userMessageId: ids.userMessage,
      assistantMessageId: ids.assistantMessage,
      checkpointId: ids.nextCheckpoint,
      headCheckpointIdAtClaim: ids.checkpoint,
    }, new Date(now.getTime() + 1000));

    const historicalCommand = await repository.claimCommand(claimInput({
      commandId: ids.nextCommand,
      kind: 'named_action',
      actionKey: 'adopt_thread',
      content: 'Try another interpretation.',
      inputHash: 'historical-action',
      now: new Date(now.getTime() + 2000),
      leaseExpiresAt: new Date(now.getTime() + 32_000),
    }));
    expect(historicalCommand.kind).toBe('claimed');
    if (historicalCommand.kind !== 'claimed') throw new Error('expected historical claim');
    expect(historicalCommand.execution.baseIsHead).toBe(false);

    const committed = await repository.finalizeAction(ids.nextCommand, {
      reply: 'Alternative interpretation preserved.',
      stageSignals: [],
      memoryProposals: [],
      adoptedThreadId: ids.thread,
    }, {
      userMessageId: ids.nextUserMessage,
      assistantMessageId: ids.nextAssistantMessage,
      checkpointId: ids.derivedCheckpoint,
      headCheckpointIdAtClaim: null,
      derivedRouteId: ids.derivedRoute,
      derivedThreadId: ids.derivedThread,
      derivedRouteName: 'Alternative interpretation',
      derivedThreadTitle: 'Evidence thread (branch)',
    }, new Date(now.getTime() + 3000));
    expect(committed).toMatchObject({
      routeId: ids.derivedRoute,
      threadId: ids.derivedThread,
      checkpointId: ids.derivedCheckpoint,
    });
    expect((await pool.query('SELECT origin_checkpoint_id, head_checkpoint_id FROM workflow_routes WHERE id = $1', [ids.route])).rows[0])
      .toEqual({ origin_checkpoint_id: null, head_checkpoint_id: ids.nextCheckpoint });
    expect((await pool.query('SELECT origin_checkpoint_id, head_checkpoint_id FROM workflow_routes WHERE id = $1', [ids.derivedRoute])).rows[0])
      .toEqual({ origin_checkpoint_id: ids.checkpoint, head_checkpoint_id: ids.derivedCheckpoint });
    expect((await pool.query('SELECT origin_thread_id, route_id FROM workflow_threads WHERE id = $1', [ids.derivedThread])).rows[0])
      .toEqual({ origin_thread_id: ids.thread, route_id: ids.derivedRoute });
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_messages WHERE thread_id = $1', [ids.thread])).rows[0].count).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS count FROM workflow_messages WHERE thread_id = $1', [ids.derivedThread])).rows[0].count).toBe(2);
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
      checkpointId: ids.derivedCheckpoint,
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
