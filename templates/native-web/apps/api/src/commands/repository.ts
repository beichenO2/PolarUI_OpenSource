import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import type {
  CheckpointArtifact,
  CheckpointReason,
  CheckpointSnapshot,
  RouteStageStatus,
  StageProjection,
  WorkflowCheckpoint,
} from '../domain/types.js';
import {
  CommandRepositoryError,
  type ClaimCommandInput,
  type ClaimCommandResult,
  type CommandCommitResult,
  type CommandExecutionContext,
  type FinalizeActionIds,
  type FinalizeActionInput,
  type FinalizeMessageInput,
  type PublicWorkflowInterrupt,
  type WorkflowCommand,
  type WorkflowCommandEvent,
  type WorkflowCommandEventType,
  type WorkflowCommandKind,
  type WorkflowCommandStatus,
  type WorkflowMessage,
} from './types.js';

interface CommandRow {
  id: string;
  context_id: string;
  source_route_id: string;
  source_thread_id: string;
  stage_key: string;
  base_checkpoint_id: string;
  expected_checkpoint_version: number;
  kind: WorkflowCommandKind;
  action_key: string | null;
  interrupt_id: string | null;
  content: string;
  input_hash: string;
  status: WorkflowCommandStatus;
  attempt: number;
  lease_expires_at: Date | null;
  result_route_id: string | null;
  result_thread_id: string | null;
  result_checkpoint_id: string | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  command_id: string;
  sequence: number;
  event_type: WorkflowCommandEventType;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface MessageRow {
  id: string;
  command_id: string;
  context_id: string;
  route_id: string;
  thread_id: string;
  stage_key: string;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  source_message_id: string | null;
  created_at: Date;
}

interface InterruptRow {
  id: string;
  prompt: string;
  action_key: string | null;
  workflow_cursor: unknown;
  created_at: Date;
}

interface CheckpointRow {
  id: string;
  context_id: string;
  route_id: string;
  parent_checkpoint_id: string | null;
  version: number;
  stage_key: string;
  reason: CheckpointReason;
  snapshot: CheckpointSnapshot;
  created_at: Date;
}

interface StageRow {
  stage_key: string;
  position: number;
  status: RouteStageStatus;
  internal_state: string;
}

function mapCommand(row: CommandRow): WorkflowCommand {
  return {
    id: row.id,
    contextId: row.context_id,
    sourceRouteId: row.source_route_id,
    sourceThreadId: row.source_thread_id,
    stageKey: row.stage_key,
    baseCheckpointId: row.base_checkpoint_id,
    expectedCheckpointVersion: row.expected_checkpoint_version,
    kind: row.kind,
    actionKey: row.action_key,
    interruptId: row.interrupt_id,
    content: row.content,
    inputHash: row.input_hash,
    status: row.status,
    attempt: row.attempt,
    leaseExpiresAt: row.lease_expires_at,
    resultRouteId: row.result_route_id,
    resultThreadId: row.result_thread_id,
    resultCheckpointId: row.result_checkpoint_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): WorkflowCommandEvent {
  return {
    commandId: row.command_id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): WorkflowMessage {
  return {
    id: row.id,
    commandId: row.command_id,
    contextId: row.context_id,
    routeId: row.route_id,
    threadId: row.thread_id,
    stageKey: row.stage_key,
    role: row.role,
    content: row.content,
    sequence: row.sequence,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: CheckpointRow): WorkflowCheckpoint {
  return {
    id: row.id,
    contextId: row.context_id,
    routeId: row.route_id,
    parentCheckpointId: row.parent_checkpoint_id,
    version: row.version,
    stageKey: row.stage_key,
    reason: row.reason,
    snapshot: row.snapshot,
    createdAt: row.created_at,
  };
}

function mapStage(row: StageRow): StageProjection {
  return {
    stageKey: row.stage_key,
    position: row.position,
    status: row.status,
    internalState: row.internal_state,
  };
}

async function listEvents(client: DatabasePool | DatabaseClient, commandId: string) {
  const result = await client.query<EventRow>(
    'SELECT * FROM workflow_command_events WHERE command_id = $1 ORDER BY sequence',
    [commandId],
  );
  return result.rows.map(mapEvent);
}

async function appendEventWithClient(
  client: DatabaseClient,
  commandId: string,
  eventType: WorkflowCommandEventType,
  payload: Record<string, unknown>,
  now: Date,
) {
  const result = await client.query<EventRow>(
    'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload, created_at) ' +
    'SELECT $1, COALESCE(MAX(sequence), 0) + 1, $2, $3, $4 ' +
    'FROM workflow_command_events WHERE command_id = $1 RETURNING *',
    [commandId, eventType, payload, now],
  );
  return mapEvent(result.rows[0]!);
}

async function loadExecution(
  client: DatabaseClient,
  command: CommandRow,
  userId: string,
): Promise<CommandExecutionContext> {
  const ownerResult = await client.query<{ user_id: string; head_checkpoint_id: string }>(
    'SELECT c.user_id, r.head_checkpoint_id FROM workflow_threads t ' +
    'JOIN contexts c ON c.id = t.context_id ' +
    'JOIN workflow_routes r ON r.id = t.route_id ' +
    'WHERE t.id = $1 AND t.context_id = $2 AND t.route_id = $3 AND t.stage_key = $4',
    [command.source_thread_id, command.context_id, command.source_route_id, command.stage_key],
  );
  const owner = ownerResult.rows[0];
  if (!owner || owner.user_id !== userId) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');

  const checkpointResult = await client.query<CheckpointRow>(
    'SELECT * FROM workflow_checkpoints WHERE id = $1 AND route_id = $2 AND context_id = $3 AND version = $4',
    [
      command.base_checkpoint_id,
      command.source_route_id,
      command.context_id,
      command.expected_checkpoint_version,
    ],
  );
  const checkpoint = checkpointResult.rows[0];
  if (!checkpoint) throw new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT');

  const historyResult = await client.query<Pick<MessageRow, 'role' | 'content'>>(
    'SELECT role, content FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
    [command.source_thread_id],
  );
  const baseIsHead = owner.head_checkpoint_id === checkpoint.id;
  let stages: StageProjection[];
  if (baseIsHead) {
    const stageResult = await client.query<StageRow>(
      'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
      'WHERE route_id = $1 ORDER BY position',
      [command.source_route_id],
    );
    stages = stageResult.rows.map(mapStage);
  } else {
    stages = checkpoint.snapshot.stages.map((stage, position) => ({
      stageKey: stage.stage_key,
      position,
      status: stage.status,
      internalState: stage.internal_state,
    }));
  }

  let interruptCursor: unknown | undefined;
  if (command.kind === 'resume_interrupt') {
    const interruptResult = await client.query<InterruptRow>(
      "SELECT id, prompt, action_key, workflow_cursor, created_at FROM workflow_interrupts " +
      "WHERE id = $1 AND context_id = $2 AND route_id = $3 AND thread_id = $4 AND stage_key = $5 AND status = 'pending'",
      [
        command.interrupt_id,
        command.context_id,
        command.source_route_id,
        command.source_thread_id,
        command.stage_key,
      ],
    );
    if (!interruptResult.rows[0]) throw new CommandRepositoryError('PENDING_INTERRUPT_NOT_FOUND');
    interruptCursor = interruptResult.rows[0].workflow_cursor;
  }

  return {
    userId,
    contextId: command.context_id,
    routeId: command.source_route_id,
    threadId: command.source_thread_id,
    stageKey: command.stage_key,
    baseCheckpoint: mapCheckpoint(checkpoint),
    headCheckpointId: owner.head_checkpoint_id,
    baseIsHead,
    history: historyResult.rows,
    stages,
    ...(interruptCursor === undefined ? {} : { interruptCursor }),
  };
}

async function insertMessages(
  client: DatabaseClient,
  command: CommandRow,
  routeId: string,
  threadId: string,
  userMessageId: string,
  assistantMessageId: string,
  reply: string,
  now: Date,
) {
  await client.query('SELECT id FROM workflow_threads WHERE id = $1 FOR UPDATE', [threadId]);
  const sequenceResult = await client.query<{ next_sequence: number }>(
    'SELECT COALESCE(MAX(sequence), 0)::int + 1 AS next_sequence FROM workflow_messages WHERE thread_id = $1',
    [threadId],
  );
  const firstSequence = sequenceResult.rows[0]!.next_sequence;
  await client.query(
    'INSERT INTO workflow_messages ' +
    '(id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence, created_at) ' +
    "VALUES ($1, $2, $3, $4, $5, $6, 'user', $7, $8, $10), " +
    "($9, $2, $3, $4, $5, $6, 'assistant', $11, $8 + 1, $10)",
    [
      userMessageId,
      command.id,
      command.context_id,
      routeId,
      threadId,
      command.stage_key,
      command.content,
      firstSequence,
      assistantMessageId,
      now,
      reply,
    ],
  );
}

async function completeCommand(
  client: DatabaseClient,
  command: CommandRow,
  result: {
    routeId: string;
    threadId: string;
    checkpointId: string | null;
    userMessageId: string;
    assistantMessageId: string;
    reply: string;
    pendingInterrupt?: PublicWorkflowInterrupt | null;
  },
  now: Date,
): Promise<CommandCommitResult> {
  await client.query(
    "UPDATE workflow_commands SET status = 'succeeded', lease_expires_at = NULL, " +
    'result_route_id = $2, result_thread_id = $3, result_checkpoint_id = $4, error_code = NULL, updated_at = $5 ' +
    'WHERE id = $1',
    [command.id, result.routeId, result.threadId, result.checkpointId, now],
  );
  const events = [
    await appendEventWithClient(client, command.id, 'assistant.delta', { delta: result.reply }, now),
    await appendEventWithClient(client, command.id, 'workspace.committed', {
      resultRouteId: result.routeId,
      resultThreadId: result.threadId,
      resultCheckpointId: result.checkpointId,
      userMessageId: result.userMessageId,
      assistantMessageId: result.assistantMessageId,
      pendingInterrupt: result.pendingInterrupt ?? null,
    }, now),
    await appendEventWithClient(client, command.id, 'command.finished', {
      outcome: 'succeeded',
      resultRouteId: result.routeId,
      resultThreadId: result.threadId,
      resultCheckpointId: result.checkpointId,
    }, now),
  ];
  return {
    status: 'succeeded',
    routeId: result.routeId,
    threadId: result.threadId,
    checkpointId: result.checkpointId,
    userMessageId: result.userMessageId,
    assistantMessageId: result.assistantMessageId,
    errorCode: null,
    events,
  };
}

function snapshotStages(stages: StageProjection[]) {
  return stages.map((stage) => ({
    stage_key: stage.stageKey,
    status: stage.status,
    internal_state: stage.internalState,
  }));
}

async function listAdoptedArtifacts(
  client: DatabaseClient,
  contextId: string,
  routeId: string,
  threadId: string,
): Promise<CheckpointArtifact[]> {
  const result = await client.query<{
    id: string;
    stage_key: string;
    filename: string;
    media_type: string;
    byte_size: string | number;
    sha256: string;
    created_at: Date;
  }>(
    'SELECT a.id, a.stage_key, a.filename, o.media_type, o.byte_size, o.sha256, a.created_at ' +
    'FROM workflow_artifacts a JOIN asset_objects o ON o.id = a.object_id ' +
    "WHERE a.context_id = $1 AND a.route_id = $2 AND a.thread_id = $3 AND a.status = 'ready' " +
    'ORDER BY a.created_at, a.id',
    [contextId, routeId, threadId],
  );
  return result.rows.map((artifact) => ({
    id: artifact.id,
    stage_key: artifact.stage_key,
    filename: artifact.filename,
    media_type: artifact.media_type,
    byte_size: Number(artifact.byte_size),
    sha256: artifact.sha256,
    created_at: artifact.created_at.toISOString(),
  }));
}

async function insertMemoryProposals(
  client: DatabaseClient,
  command: CommandRow,
  routeId: string,
  threadId: string,
  proposals: unknown[],
  now: Date,
) {
  if (proposals.length === 0) return;
  const owner = await client.query<{ user_id: string }>('SELECT user_id FROM contexts WHERE id = $1', [command.context_id]);
  const userId = owner.rows[0]?.user_id;
  if (!userId) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
  for (const [index, proposal] of proposals.entries()) {
    if (!proposal || typeof proposal !== 'object' || !('scope' in proposal) || !('value' in proposal)) continue;
    const candidate = proposal as { scope: string; key?: string; value: unknown };
    await client.query(
      'INSERT INTO memory_proposals ' +
      '(id,user_id,command_id,context_id,route_id,thread_id,stage_key,scope,proposal_key,proposal_value,status,created_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)",
      [randomUUID(), userId, command.id, command.context_id, routeId, threadId, command.stage_key,
        candidate.scope, candidate.key?.trim() || `proposal_${index + 1}`, JSON.stringify(candidate.value), now],
    );
  }
}

export function createCommandRepository(pool: DatabasePool) {
  return {
    async claimCommand(input: ClaimCommandInput): Promise<ClaimCommandResult> {
      return withTransaction(pool, async (client) => {
        const existingResult = await client.query<CommandRow & { owner_user_id: string }>(
          'SELECT wc.*, c.user_id AS owner_user_id FROM workflow_commands wc ' +
          'JOIN contexts c ON c.id = wc.context_id WHERE wc.id = $1 FOR UPDATE OF wc',
          [input.commandId],
        );
        let row: CommandRow | undefined = existingResult.rows[0];
        if (existingResult.rows[0] && existingResult.rows[0].owner_user_id !== input.userId) {
          throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
        }
        if (!row) {
          const scopeResult = await client.query<{
            context_id: string;
            route_id: string;
            stage_key: string;
          }>(
            'SELECT t.context_id, t.route_id, t.stage_key FROM workflow_threads t ' +
            'JOIN contexts c ON c.id = t.context_id ' +
            'JOIN workflow_checkpoints cp ON cp.id = $3 AND cp.context_id = t.context_id ' +
            'AND cp.route_id = t.route_id AND cp.version = $4 ' +
            'WHERE t.id = $1 AND c.user_id = $2 AND t.status = \'active\'',
            [input.threadId, input.userId, input.baseCheckpointId, input.expectedCheckpointVersion],
          );
          const scope = scopeResult.rows[0];
          if (!scope) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
          if (
            (input.kind === 'message' && (input.actionKey || input.interruptId)) ||
            (input.kind === 'named_action' && (!input.actionKey || input.interruptId)) ||
            (input.kind === 'resume_interrupt' && (input.actionKey || !input.interruptId))
          ) {
            throw new CommandRepositoryError('COMMAND_INPUT_INVALID');
          }
          if (input.kind === 'resume_interrupt') {
            const interruptResult = await client.query<{ id: string }>(
              "SELECT id FROM workflow_interrupts WHERE id = $1 AND context_id = $2 AND route_id = $3 " +
              "AND thread_id = $4 AND stage_key = $5 AND status = 'pending' FOR UPDATE",
              [input.interruptId, scope.context_id, scope.route_id, input.threadId, scope.stage_key],
            );
            if (!interruptResult.rows[0]) throw new CommandRepositoryError('PENDING_INTERRUPT_NOT_FOUND');
            const priorResume = await client.query<{ id: string }>(
              "SELECT id FROM workflow_commands WHERE interrupt_id = $1 AND kind = 'resume_interrupt'",
              [input.interruptId],
            );
            if (priorResume.rows[0]) return { kind: 'interrupt_claimed' };
          }
          const inserted = await client.query<CommandRow>(
            'INSERT INTO workflow_commands ' +
            '(id, context_id, source_route_id, source_thread_id, stage_key, base_checkpoint_id, ' +
            'expected_checkpoint_version, kind, action_key, interrupt_id, content, input_hash, status, ' +
            'attempt, lease_expires_at, created_at, updated_at) ' +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'running', 1, $13, $14, $14) " +
            'RETURNING *',
            [
              input.commandId,
              scope.context_id,
              scope.route_id,
              input.threadId,
              scope.stage_key,
              input.baseCheckpointId,
              input.expectedCheckpointVersion,
              input.kind,
              input.actionKey ?? null,
              input.interruptId ?? null,
              input.content,
              input.inputHash,
              input.leaseExpiresAt,
              input.now,
            ],
          );
          row = inserted.rows[0]!;
          const execution = await loadExecution(client, row, input.userId);
          await appendEventWithClient(client, row.id, 'command.accepted', { status: 'running' }, input.now);
          return { kind: 'claimed', command: mapCommand(row), execution };
        }

        if (row.input_hash !== input.inputHash) return { kind: 'reused' };
        if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'conflict') {
          return { kind: 'replay', command: mapCommand(row), events: await listEvents(client, row.id) };
        }
        if (row.lease_expires_at && row.lease_expires_at > input.now) return { kind: 'in_progress' };

        const startedResult = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM workflow_command_events WHERE command_id = $1 AND event_type = 'workflow.started') AS exists",
          [row.id],
        );
        if (startedResult.rows[0]!.exists) {
          const terminalResult = await client.query<CommandRow>(
            "UPDATE workflow_commands SET status = 'failed', lease_expires_at = NULL, " +
            "error_code = 'WORKFLOW_OUTCOME_UNKNOWN', updated_at = $2 WHERE id = $1 RETURNING *",
            [row.id, input.now],
          );
          row = terminalResult.rows[0]!;
          await appendEventWithClient(client, row.id, 'command.finished', {
            outcome: 'failed',
            code: 'WORKFLOW_OUTCOME_UNKNOWN',
          }, input.now);
          return { kind: 'replay', command: mapCommand(row), events: await listEvents(client, row.id) };
        }

        const reclaimedResult = await client.query<CommandRow>(
          "UPDATE workflow_commands SET status = 'running', attempt = attempt + 1, lease_expires_at = $2, " +
          'updated_at = $3 WHERE id = $1 RETURNING *',
          [row.id, input.leaseExpiresAt, input.now],
        );
        row = reclaimedResult.rows[0]!;
        return {
          kind: 'claimed',
          command: mapCommand(row),
          execution: await loadExecution(client, row, input.userId),
        };
      });
    },

    async listThreadState(userId: string, threadId: string) {
      const ownedResult = await pool.query<{ id: string }>(
        'SELECT t.id FROM workflow_threads t JOIN contexts c ON c.id = t.context_id ' +
        'WHERE t.id = $1 AND c.user_id = $2',
        [threadId, userId],
      );
      if (!ownedResult.rows[0]) return null;
      const [messagesResult, interruptResult] = await Promise.all([
        pool.query<MessageRow>(
          'SELECT * FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
          [threadId],
        ),
        pool.query<Omit<InterruptRow, 'workflow_cursor'>>(
          "SELECT id, prompt, action_key, created_at FROM workflow_interrupts " +
          "WHERE thread_id = $1 AND status = 'pending' ORDER BY created_at DESC, id LIMIT 1",
          [threadId],
        ),
      ]);
      const interrupt = interruptResult.rows[0];
      return {
        messages: messagesResult.rows.map(mapMessage),
        pendingInterrupt: interrupt ? {
          id: interrupt.id,
          prompt: interrupt.prompt,
          actionKey: interrupt.action_key,
          createdAt: interrupt.created_at,
        } : null,
      };
    },

    async listCommandEvents(userId: string, commandId: string, afterSequence = 0) {
      const commandResult = await pool.query<Pick<CommandRow, 'status'>>(
        'SELECT cmd.status FROM workflow_commands cmd ' +
        'JOIN contexts c ON c.id = cmd.context_id ' +
        'WHERE cmd.id = $1 AND c.user_id = $2 LIMIT 1',
        [commandId, userId],
      );
      const command = commandResult.rows[0];
      if (!command) return null;
      const eventsResult = await pool.query<EventRow>(
        'SELECT * FROM workflow_command_events WHERE command_id = $1 AND sequence > $2 ORDER BY sequence',
        [commandId, afterSequence],
      );
      return { status: command.status, events: eventsResult.rows.map(mapEvent) };
    },

    async appendEvent(
      commandId: string,
      eventType: WorkflowCommandEventType,
      payload: Record<string, unknown>,
      now: Date,
    ) {
      return withTransaction(pool, async (client) => {
        const locked = await client.query('SELECT id FROM workflow_commands WHERE id = $1 FOR UPDATE', [commandId]);
        if (!locked.rows[0]) throw new CommandRepositoryError('COMMAND_NOT_FOUND');
        return appendEventWithClient(client, commandId, eventType, payload, now);
      });
    },

    async finalizeMessage(commandId: string, result: FinalizeMessageInput, now: Date) {
      return withTransaction(pool, async (client) => {
        const commandResult = await client.query<CommandRow>(
          'SELECT * FROM workflow_commands WHERE id = $1 FOR UPDATE',
          [commandId],
        );
        const command = commandResult.rows[0];
        if (!command || (command.kind !== 'message' && command.kind !== 'resume_interrupt')) {
          throw new CommandRepositoryError('COMMAND_NOT_FINALIZABLE');
        }
        if (command.status !== 'running') throw new CommandRepositoryError('COMMAND_NOT_FINALIZABLE');

        if (command.kind === 'resume_interrupt') {
          const resolved = await client.query(
            "UPDATE workflow_interrupts SET status = 'resolved', resolution_command_id = $2, " +
            "resolved_at = $3, updated_at = $3 WHERE id = $1 AND status = 'pending'",
            [command.interrupt_id, command.id, now],
          );
          if (resolved.rowCount !== 1) throw new CommandRepositoryError('PENDING_INTERRUPT_NOT_FOUND');
        }
        let pendingInterrupt: PublicWorkflowInterrupt | null = null;
        if (result.interrupt) {
          const interruptResult = await client.query<InterruptRow>(
            'INSERT INTO workflow_interrupts ' +
            '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, ' +
            'originating_command_id, action_key, created_at, updated_at) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ' +
            'RETURNING id, prompt, action_key, workflow_cursor, created_at',
            [
              result.interrupt.id,
              command.context_id,
              command.source_route_id,
              command.source_thread_id,
              command.stage_key,
              result.interrupt.prompt,
              result.interrupt.cursor,
              command.id,
              result.interrupt.actionKey ?? command.action_key,
              now,
            ],
          );
          const row = interruptResult.rows[0]!;
          pendingInterrupt = { id: row.id, prompt: row.prompt, actionKey: row.action_key, createdAt: row.created_at };
        }
        await insertMessages(
          client,
          command,
          command.source_route_id,
          command.source_thread_id,
          result.userMessageId,
          result.assistantMessageId,
          result.reply,
          now,
        );
        await client.query('UPDATE workflow_threads SET updated_at = $2 WHERE id = $1', [command.source_thread_id, now]);
        await client.query('UPDATE contexts SET updated_at = $2 WHERE id = $1', [command.context_id, now]);
        await insertMemoryProposals(client, command, command.source_route_id, command.source_thread_id, result.memoryProposals, now);
        return completeCommand(client, command, {
          routeId: command.source_route_id,
          threadId: command.source_thread_id,
          checkpointId: null,
          userMessageId: result.userMessageId,
          assistantMessageId: result.assistantMessageId,
          reply: result.reply,
          pendingInterrupt,
        }, now);
      });
    },

    async finalizeAction(
      commandId: string,
      result: FinalizeActionInput,
      ids: FinalizeActionIds,
      now: Date,
    ): Promise<CommandCommitResult> {
      return withTransaction(pool, async (client) => {
        const commandResult = await client.query<CommandRow>(
          'SELECT * FROM workflow_commands WHERE id = $1 FOR UPDATE',
          [commandId],
        );
        const command = commandResult.rows[0];
        if (!command || command.kind !== 'named_action' || command.status !== 'running') {
          throw new CommandRepositoryError('COMMAND_NOT_FINALIZABLE');
        }
        const routeResult = await client.query<{
          head_checkpoint_id: string;
          name: string;
        }>('SELECT head_checkpoint_id, name FROM workflow_routes WHERE id = $1 FOR UPDATE', [command.source_route_id]);
        const sourceRoute = routeResult.rows[0];
        if (!sourceRoute) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');

        if (sourceRoute.head_checkpoint_id !== ids.headCheckpointIdAtClaim) {
          await client.query(
            "UPDATE workflow_commands SET status = 'conflict', lease_expires_at = NULL, " +
            "error_code = 'CHECKPOINT_VERSION_CONFLICT', updated_at = $2 WHERE id = $1",
            [command.id, now],
          );
          const event = await appendEventWithClient(client, command.id, 'command.finished', {
            outcome: 'conflict',
            code: 'CHECKPOINT_VERSION_CONFLICT',
          }, now);
          return {
            status: 'conflict',
            routeId: command.source_route_id,
            threadId: command.source_thread_id,
            checkpointId: null,
            userMessageId: null,
            assistantMessageId: null,
            errorCode: 'CHECKPOINT_VERSION_CONFLICT',
            events: [event],
          };
        }

        const baseResult = await client.query<CheckpointRow>(
          'SELECT * FROM workflow_checkpoints WHERE id = $1 AND route_id = $2 AND context_id = $3 AND version = $4',
          [
            command.base_checkpoint_id,
            command.source_route_id,
            command.context_id,
            command.expected_checkpoint_version,
          ],
        );
        const base = baseResult.rows[0];
        if (!base) throw new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT');

        const routeId = command.source_route_id;
        const threadId = command.source_thread_id;
        const checkpointVersion = base.version + 1;
        const parentCheckpointId = base.id;
        const currentStages = await client.query<StageRow>(
          'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
          'WHERE route_id = $1 ORDER BY position FOR UPDATE',
          [routeId],
        );
        const stageRows: StageProjection[] = currentStages.rows.map(mapStage);

        const stagesByKey = new Map(stageRows.map((stage) => [stage.stageKey, stage]));
        for (const signal of result.stageSignals) {
          const stage = stagesByKey.get(signal.stageKey);
          if (!stage) throw new CommandRepositoryError('WORKFLOW_INVALID_STATE');
          stage.status = signal.status;
          stage.internalState = signal.internalState;
        }

        for (const stage of stageRows) {
          await client.query(
            'UPDATE route_stage_projections SET status = $3, internal_state = $4, updated_at = $5 ' +
            'WHERE route_id = $1 AND stage_key = $2',
            [routeId, stage.stageKey, stage.status, stage.internalState, now],
          );
        }

        await insertMessages(
          client,
          command,
          routeId,
          threadId,
          ids.userMessageId,
          ids.assistantMessageId,
          result.reply,
          now,
        );
        const artifactMap = new Map(
          (base.snapshot.artifacts ?? []).map((artifact) => [artifact.id, artifact]),
        );
        if (result.adoptedThreadId) {
          for (const artifact of await listAdoptedArtifacts(
            client,
            command.context_id,
            routeId,
            result.adoptedThreadId,
          )) {
            artifactMap.set(artifact.id, artifact);
          }
        }
        const snapshot = {
          stages: snapshotStages(stageRows),
          artifacts: [...artifactMap.values()],
          command: {
            id: command.id,
            kind: command.kind,
            action_key: command.action_key,
          },
          memory_proposals: result.memoryProposals,
          adopted_thread_id: result.adoptedThreadId,
          result_message_ids: [ids.userMessageId, ids.assistantMessageId],
        };
        await client.query(
          'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, 'workflow_action', $7, $8)",
          [
            ids.checkpointId,
            command.context_id,
            routeId,
            parentCheckpointId,
            checkpointVersion,
            command.stage_key,
            snapshot,
            now,
          ],
        );
        await client.query(
          'UPDATE workflow_routes SET head_checkpoint_id = $2, updated_at = $3 WHERE id = $1',
          [routeId, ids.checkpointId, now],
        );
        await client.query('UPDATE workflow_threads SET updated_at = $2 WHERE id = $1', [threadId, now]);
        await client.query('UPDATE contexts SET updated_at = $2 WHERE id = $1', [command.context_id, now]);
        await insertMemoryProposals(client, command, routeId, threadId, result.memoryProposals, now);
        return completeCommand(client, command, {
          routeId,
          threadId,
          checkpointId: ids.checkpointId,
          userMessageId: ids.userMessageId,
          assistantMessageId: ids.assistantMessageId,
          reply: result.reply,
        }, now);
      });
    },

    async failCommand(commandId: string, errorCode: string, now: Date) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<CommandRow>(
          'SELECT * FROM workflow_commands WHERE id = $1 FOR UPDATE',
          [commandId],
        );
        const command = result.rows[0];
        if (!command) throw new CommandRepositoryError('COMMAND_NOT_FOUND');
        if (command.status === 'succeeded' || command.status === 'failed' || command.status === 'conflict') {
          return listEvents(client, command.id);
        }
        await client.query(
          "UPDATE workflow_commands SET status = 'failed', lease_expires_at = NULL, error_code = $2, " +
          'updated_at = $3 WHERE id = $1',
          [command.id, errorCode, now],
        );
        await appendEventWithClient(client, command.id, 'command.finished', {
          outcome: 'failed',
          code: errorCode,
        }, now);
        return listEvents(client, command.id);
      });
    },
  };
}

export type CommandRepository = ReturnType<typeof createCommandRepository>;
