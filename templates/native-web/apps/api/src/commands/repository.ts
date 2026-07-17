import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import {
  checkpointStages,
  normalizeCheckpointSnapshot,
} from '../domain/types.js';
import type {
  CheckpointArtifact,
  CheckpointReason,
  CheckpointSnapshot,
  LegacyCheckpointSnapshot,
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
  type CommandScope,
  type FinalizeActionIds,
  type FinalizeActionInput,
  type FinalizeCommandInput,
  type FinalizeMessageInput,
  type PrepareCommandInput,
  type PrepareCommandResult,
  type PublicWorkflowInterrupt,
  type UnifiedCommandCommitResult,
  type UnifiedCommandExecutionContext,
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
  stage_key: string | null;
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
  stage_key: string | null;
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
  stage_key: string | null;
  reason: CheckpointReason;
  snapshot: unknown;
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
    snapshot: normalizeCheckpointSnapshot(row.snapshot),
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
  if (command.stage_key === null) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
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
    stages = checkpointStages(checkpoint.snapshot).map((stage, position) => ({
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

function validCommandFields(input: PrepareCommandInput) {
  return (input.kind === 'message' && !input.actionKey && !input.interruptId) ||
    (input.kind === 'named_action' && Boolean(input.actionKey) && !input.interruptId) ||
    (input.kind === 'resume_interrupt' && !input.actionKey && Boolean(input.interruptId));
}

function bootstrapSnapshot(): CheckpointSnapshot {
  return { workflowState: {}, memoryReferences: [], artifacts: [] };
}

async function lockOwnedStagedAttachments(
  client: DatabaseClient,
  userId: string,
  attachmentIds: string[],
) {
  if (attachmentIds.length === 0) return;
  const result = await client.query<{ id: string }>(
    "SELECT id FROM staged_attachments WHERE id = ANY($1::uuid[]) " +
    "AND user_id = $2 AND status = 'pending' FOR UPDATE",
    [attachmentIds, userId],
  );
  if (result.rows.length !== attachmentIds.length) {
    throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
  }
}

async function loadAcceptedCommandScope(
  client: DatabaseClient,
  command: CommandRow,
): Promise<CommandScope> {
  const result = await client.query<{
    scope_mode: string | null;
    has_conversation_marker: boolean;
    conversation_was_explicit: boolean | null;
    conversation_status: string;
  }>(
    "SELECT event.payload->>'scopeMode' AS scope_mode, " +
    "event.payload ? 'conversationWasExplicit' AS has_conversation_marker, " +
    "(event.payload->>'conversationWasExplicit')::boolean AS conversation_was_explicit, " +
    'thread.status AS conversation_status ' +
    'FROM workflow_command_events event ' +
    'JOIN workflow_threads thread ON thread.id = $2 AND thread.context_id = $3 AND thread.route_id = $4 ' +
    "WHERE event.command_id = $1 AND event.event_type = 'command.accepted' " +
    'ORDER BY event.sequence LIMIT 1',
    [command.id, command.source_thread_id, command.context_id, command.source_route_id],
  );
  const row = result.rows[0];
  if (!row) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
  if (row.scope_mode === 'start') {
    return {
      mode: 'start',
      provisionalContextId: command.context_id,
      provisionalRouteId: command.source_route_id,
      provisionalConversationId: command.source_thread_id,
    };
  }
  if (row.scope_mode === 'history') {
    return {
      mode: 'history',
      contextId: command.context_id,
      sourceRouteId: command.source_route_id,
      sourceCheckpointId: command.base_checkpoint_id,
    };
  }
  if (row.scope_mode === 'head') {
    const acceptedConversationId = row.has_conversation_marker
      ? row.conversation_was_explicit ? command.source_thread_id : null
      : row.conversation_status === 'initializing' ? null : command.source_thread_id;
    if (acceptedConversationId !== null && acceptedConversationId !== command.source_thread_id) {
      throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
    }
    return {
      mode: 'head', contextId: command.context_id, routeId: command.source_route_id,
      conversationId: acceptedConversationId,
    };
  }
  throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
}

async function loadUnifiedExecution(
  client: DatabaseClient,
  command: CommandRow,
  userId: string,
  scope: CommandScope,
): Promise<UnifiedCommandExecutionContext> {
  const ownerResult = await client.query<{
    user_id: string;
    head_checkpoint_id: string;
    stage_key: string | null;
  }>(
    'SELECT c.user_id, r.head_checkpoint_id, t.stage_key FROM workflow_threads t ' +
    'JOIN contexts c ON c.id = t.context_id ' +
    'JOIN workflow_routes r ON r.id = t.route_id ' +
    'WHERE t.id = $1 AND t.context_id = $2 AND t.route_id = $3',
    [command.source_thread_id, command.context_id, command.source_route_id],
  );
  const owner = ownerResult.rows[0];
  if (!owner || owner.user_id !== userId) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
  const checkpointResult = await client.query<CheckpointRow>(
    'SELECT * FROM workflow_checkpoints ' +
    'WHERE id = $1 AND route_id = $2 AND context_id = $3 AND version = $4',
    [
      command.base_checkpoint_id,
      command.source_route_id,
      command.context_id,
      command.expected_checkpoint_version,
    ],
  );
  const checkpoint = checkpointResult.rows[0];
  if (!checkpoint) throw new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT');
  const baseIsHead = owner.head_checkpoint_id === checkpoint.id;
  const historyResult = baseIsHead
    ? await client.query<Pick<MessageRow, 'role' | 'content'>>(
      'SELECT role, content FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
      [command.source_thread_id],
    )
    : await client.query<Pick<MessageRow, 'role' | 'content'>>(
      'SELECT message.role, message.content FROM workflow_messages message ' +
      'JOIN workflow_commands producer ' +
      'ON producer.id = message.command_id AND producer.context_id = message.context_id ' +
      'LEFT JOIN workflow_checkpoints result_checkpoint ' +
      'ON result_checkpoint.id = producer.result_checkpoint_id ' +
      'WHERE message.thread_id = $1 AND message.context_id = $2 AND message.route_id = $3 AND (' +
        '(producer.result_checkpoint_id IS NOT NULL ' +
          'AND producer.result_route_id = message.route_id ' +
          'AND producer.result_thread_id = message.thread_id ' +
          'AND result_checkpoint.context_id = message.context_id ' +
          'AND result_checkpoint.route_id = message.route_id ' +
          'AND result_checkpoint.version <= $4) ' +
        'OR (producer.result_checkpoint_id IS NULL ' +
          'AND producer.source_route_id = message.route_id ' +
          'AND producer.source_thread_id = message.thread_id ' +
          'AND message.created_at < $5)' +
      ') ORDER BY message.sequence',
      [
        command.source_thread_id,
        command.context_id,
        command.source_route_id,
        checkpoint.version,
        checkpoint.created_at,
      ],
    );
  let stages: StageProjection[];
  if (baseIsHead) {
    const stageResult = await client.query<StageRow>(
      'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
      'WHERE route_id = $1 ORDER BY position',
      [command.source_route_id],
    );
    stages = stageResult.rows.map(mapStage);
  } else {
    stages = checkpointStages(checkpoint.snapshot).map((stage, position) => ({
      stageKey: stage.stage_key,
      position,
      status: stage.status,
      internalState: stage.internal_state,
    }));
  }
  let interruptCursor: unknown | undefined;
  if (command.kind === 'resume_interrupt') {
    const interruptResult = await client.query<InterruptRow>(
      'SELECT id, prompt, action_key, workflow_cursor, created_at FROM workflow_interrupts ' +
      "WHERE id = $1 AND context_id = $2 AND route_id = $3 AND thread_id = $4 " +
      "AND status = 'pending'",
      [
        command.interrupt_id,
        command.context_id,
        command.source_route_id,
        command.source_thread_id,
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
    conversationId: command.source_thread_id,
    stageKey: owner.stage_key,
    baseCheckpoint: mapCheckpoint(checkpoint),
    headCheckpointId: owner.head_checkpoint_id,
    baseIsHead,
    history: historyResult.rows,
    stages,
    scope,
    ...(interruptCursor === undefined ? {} : { interruptCursor }),
  };
}

async function reusePreparedCommand(
  client: DatabaseClient,
  row: CommandRow,
  input: PrepareCommandInput,
): Promise<PrepareCommandResult> {
  if (row.input_hash !== input.inputHash) return { kind: 'reused' };
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'conflict') {
    return { kind: 'replay', command: mapCommand(row), events: await listEvents(client, row.id) };
  }
  if (row.lease_expires_at && row.lease_expires_at > input.now) return { kind: 'in_progress' };
  const startedResult = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM workflow_command_events " +
    "WHERE command_id = $1 AND event_type = 'workflow.started') AS exists",
    [row.id],
  );
  if (startedResult.rows[0]!.exists) {
    const terminalResult = await client.query<CommandRow>(
      "UPDATE workflow_commands SET status = 'failed', lease_expires_at = NULL, " +
      "error_code = 'WORKFLOW_OUTCOME_UNKNOWN', updated_at = $2 WHERE id = $1 RETURNING *",
      [row.id, input.now],
    );
    const terminal = terminalResult.rows[0]!;
    await appendEventWithClient(client, terminal.id, 'command.finished', {
      outcome: 'failed',
      code: 'WORKFLOW_OUTCOME_UNKNOWN',
    }, input.now);
    return {
      kind: 'replay',
      command: mapCommand(terminal),
      events: await listEvents(client, terminal.id),
    };
  }
  const reclaimedResult = await client.query<CommandRow>(
    "UPDATE workflow_commands SET status = 'running', attempt = attempt + 1, lease_expires_at = $2, " +
    'updated_at = $3 WHERE id = $1 RETURNING *',
    [row.id, input.leaseExpiresAt, input.now],
  );
  const reclaimed = reclaimedResult.rows[0]!;
  const scope = await loadAcceptedCommandScope(client, reclaimed);
  return {
    kind: 'claimed',
    command: mapCommand(reclaimed),
    execution: await loadUnifiedExecution(client, reclaimed, input.userId, scope),
  };
}

async function applyUnifiedStageSignals(
  client: DatabaseClient,
  routeId: string,
  signals: FinalizeCommandInput['stageSignals'],
  now: Date,
) {
  const result = await client.query<StageRow>(
    'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
    'WHERE route_id = $1 ORDER BY position FOR UPDATE',
    [routeId],
  );
  const stages = result.rows.map(mapStage);
  const byKey = new Map(stages.map((stage) => [stage.stageKey, stage]));
  for (const signal of signals) {
    const stage = byKey.get(signal.stageKey);
    if (!stage) throw new CommandRepositoryError('WORKFLOW_INVALID_STATE');
    stage.status = signal.status;
    stage.internalState = signal.internalState;
  }
  for (const stage of stages) {
    await client.query(
      'UPDATE route_stage_projections SET status = $3, internal_state = $4, updated_at = $5 ' +
      'WHERE route_id = $1 AND stage_key = $2',
      [routeId, stage.stageKey, stage.status, stage.internalState, now],
    );
  }
  return stages;
}

interface WorkflowMemoryUpdateRecord {
  scope: 'user' | 'context';
  key: string;
  value: unknown;
  expectedVersion?: number;
  highImpact?: boolean;
  evidence: Array<Record<string, unknown>>;
  impactScope?: Record<string, unknown>;
}

function workflowMemoryUpdate(value: unknown): WorkflowMemoryUpdateRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
  if ((candidate.scope !== 'user' && candidate.scope !== 'context') ||
      !key || key.length > 200 || !('value' in candidate) ||
      (candidate.expectedVersion !== undefined &&
        (!Number.isInteger(candidate.expectedVersion) ||
          typeof candidate.expectedVersion !== 'number' || candidate.expectedVersion < 1)) ||
      (candidate.highImpact !== undefined && typeof candidate.highImpact !== 'boolean') ||
      (candidate.evidence !== undefined &&
        (!Array.isArray(candidate.evidence) || candidate.evidence.length > 100 ||
          candidate.evidence.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))) ||
      (candidate.impactScope !== undefined &&
        (!candidate.impactScope || typeof candidate.impactScope !== 'object' ||
          Array.isArray(candidate.impactScope)))) {
    return null;
  }
  return {
    scope: candidate.scope,
    key,
    value: candidate.value,
    ...(candidate.expectedVersion === undefined
      ? {}
      : { expectedVersion: candidate.expectedVersion as number }),
    ...(candidate.highImpact === undefined ? {} : { highImpact: candidate.highImpact as boolean }),
    evidence: (candidate.evidence ?? []) as Array<Record<string, unknown>>,
    ...(candidate.impactScope === undefined
      ? {}
      : { impactScope: candidate.impactScope as Record<string, unknown> }),
  };
}

async function appendWorkflowMemoryVersions(
  client: DatabaseClient,
  input: {
    userId: string;
    contextId: string;
    conversationId: string;
    commandId: string;
    checkpointId: string;
    updates: unknown[];
    baseReferences: CheckpointSnapshot['memoryReferences'];
    now: Date;
  },
): Promise<CheckpointSnapshot['memoryReferences']> {
  const references = new Map(input.baseReferences.map(
    (reference) => [reference.memoryId, reference.version] as const,
  ));
  for (const rawUpdate of input.updates) {
    const update = workflowMemoryUpdate(rawUpdate);
    if (!update || update.highImpact) continue;
    const contextId = update.scope === 'context' ? input.contextId : null;
    const existingResult = await client.query<{
      id: string;
      current_version: number;
    }>(
      'SELECT id, current_version FROM memory_items ' +
      'WHERE user_id = $1 AND scope = $2 AND context_id IS NOT DISTINCT FROM $3 AND memory_key = $4 FOR UPDATE',
      [input.userId, update.scope, contextId, update.key],
    );
    const existing = existingResult.rows[0];
    if (existing && update.expectedVersion !== existing.current_version) continue;
    if (!existing && update.expectedVersion !== undefined) continue;

    const memoryId = existing?.id ?? randomUUID();
    const version = (existing?.current_version ?? 0) + 1;
    if (!existing) {
      await client.query(
        'INSERT INTO memory_items ' +
        '(id, user_id, scope, context_id, memory_key, status, current_version, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6)",
        [memoryId, input.userId, update.scope, contextId, update.key, input.now],
      );
    }
    const source = {
      kind: 'workflow',
      commandId: input.commandId,
      conversationId: input.conversationId,
      checkpointId: input.checkpointId,
    };
    const impactScope = update.impactScope ?? {
      contextIds: update.scope === 'user' ? 'all' : [input.contextId],
    };
    await client.query(
      'INSERT INTO memory_item_versions ' +
      '(id, memory_id, version, value, status, source, evidence, impact_scope, created_at) ' +
      "VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)",
      [randomUUID(), memoryId, version, update.value, source, update.evidence, impactScope, input.now],
    );
    if (existing) {
      await client.query(
        "UPDATE memory_items SET status = 'active', current_version = $2, updated_at = $3 WHERE id = $1",
        [memoryId, version, input.now],
      );
    }
    references.set(memoryId, version);
  }
  return [...references].map(([memoryId, version]) => ({ memoryId, version }));
}

function unifiedSnapshot(
  base: CheckpointSnapshot,
  command: CommandRow,
  result: FinalizeCommandInput,
  stages: StageProjection[],
  memoryReferences: CheckpointSnapshot['memoryReferences'] = base.memoryReferences,
): CheckpointSnapshot & Partial<LegacyCheckpointSnapshot> {
  if (result.workflowState !== undefined) {
    return {
      workflowState: result.workflowState,
      ...(result.stageProjection !== undefined
        ? { stageProjection: result.stageProjection }
        : base.stageProjection !== undefined
          ? { stageProjection: base.stageProjection }
          : {}),
      memoryReferences,
      artifacts: base.artifacts,
    };
  }
  const legacyStages = snapshotStages(stages);
  const legacyCommand = {
    id: command.id,
    kind: command.kind,
    action_key: command.action_key,
  };
  const workflowState = {
    ...base.workflowState,
    workflowCursor: result.workflowCursor,
    legacyCompatibility: {
      stages: legacyStages,
      command: legacyCommand,
      memoryProposals: result.memoryProposals,
      adoptedThreadId: null,
      resultMessageIds: [result.userMessageId, result.assistantMessageId],
    },
  };
  return {
    workflowState,
    ...(stages.length === 0
      ? (base.stageProjection ? { stageProjection: base.stageProjection } : {})
      : {
        stageProjection: {
          revision: base.stageProjection?.revision ?? 'legacy-stage-projection-v1',
          items: stages.map((stage) => ({
            key: stage.stageKey,
            label: base.stageProjection?.items.find((item) => item.key === stage.stageKey)?.label ?? stage.stageKey,
            status: stage.status,
            summary: stage.internalState,
          })),
        },
      }),
    memoryReferences,
    artifacts: base.artifacts,
    stages: legacyStages,
    command: legacyCommand,
    memory_proposals: result.memoryProposals,
    adopted_thread_id: null,
    result_message_ids: [result.userMessageId, result.assistantMessageId],
  };
}

async function adoptUnifiedAttachments(
  client: DatabaseClient,
  command: CommandRow,
  userId: string,
  routeId: string,
  conversationId: string,
  attachmentIds: string[],
  now: Date,
) {
  await lockOwnedStagedAttachments(client, userId, attachmentIds);
  if (attachmentIds.length === 0) return;
  const staged = await client.query<{
    id: string;
    object_id: string;
    filename: string;
  }>(
    'SELECT id, object_id, filename FROM staged_attachments ' +
    'WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY created_at, id FOR UPDATE',
    [attachmentIds, userId],
  );
  for (const attachment of staged.rows) {
    await client.query(
      'INSERT INTO workflow_attachments ' +
      '(id, user_id, object_id, context_id, route_id, thread_id, stage_key, filename, created_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        randomUUID(),
        userId,
        attachment.object_id,
        command.context_id,
        routeId,
        conversationId,
        command.stage_key,
        attachment.filename,
        now,
      ],
    );
    await client.query(
      "UPDATE staged_attachments SET status = 'adopted', adopted_command_id = $2, " +
      'adopted_context_id = $3, adopted_at = $4, updated_at = $4 WHERE id = $1',
      [attachment.id, command.id, command.context_id, now],
    );
  }
}

function agentTitle(value: string | undefined) {
  const title = value?.trim();
  return title && title.length <= 120 ? title : null;
}

async function completeUnifiedCommand(
  client: DatabaseClient,
  command: CommandRow,
  result: {
    routeId: string;
    conversationId: string;
    checkpointId: string;
    userMessageId: string;
    assistantMessageId: string;
    reply: string;
    pendingInterrupt?: PublicWorkflowInterrupt | null;
  },
  now: Date,
): Promise<UnifiedCommandCommitResult> {
  const committed = await completeCommand(client, command, {
    routeId: result.routeId,
    threadId: result.conversationId,
    checkpointId: result.checkpointId,
    userMessageId: result.userMessageId,
    assistantMessageId: result.assistantMessageId,
    reply: result.reply,
    pendingInterrupt: result.pendingInterrupt,
  }, now);
  return {
    status: committed.status,
    routeId: committed.routeId,
    conversationId: committed.threadId,
    checkpointId: committed.checkpointId,
    userMessageId: committed.userMessageId,
    assistantMessageId: committed.assistantMessageId,
    errorCode: committed.errorCode,
    events: committed.events,
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
    stage_key: string | null;
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

async function lockCommandId(client: DatabaseClient, commandId: string) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    [`workflow-command:${commandId}`],
  );
}

export function createCommandRepository(pool: DatabasePool) {
  return {
    async prepareCommand(input: PrepareCommandInput): Promise<PrepareCommandResult> {
      return withTransaction(pool, async (client) => {
        await lockCommandId(client, input.commandId);
        const existingResult = await client.query<CommandRow & { owner_user_id: string }>(
          'SELECT wc.*, c.user_id AS owner_user_id FROM workflow_commands wc ' +
          'JOIN contexts c ON c.id = wc.context_id WHERE wc.id = $1 FOR UPDATE OF wc',
          [input.commandId],
        );
        const existing = existingResult.rows[0];
        if (existing) {
          if (existing.owner_user_id !== input.userId) {
            throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
          }
          return reusePreparedCommand(client, existing, input);
        }
        if (!validCommandFields(input)) throw new CommandRepositoryError('COMMAND_INPUT_INVALID');
        await lockOwnedStagedAttachments(client, input.userId, input.attachmentIds);

        const isStart = input.contextId === undefined && input.routeId === undefined &&
          input.conversationId === undefined && input.baseCheckpointId === undefined &&
          input.expectedCheckpointVersion === undefined;
        let contextId: string;
        let routeId: string;
        let conversationId: string;
        let stageKey: string | null;
        let baseCheckpointId: string;
        let expectedCheckpointVersion: number;
        let scope: CommandScope;

        if (isStart) {
          contextId = randomUUID();
          routeId = randomUUID();
          conversationId = randomUUID();
          baseCheckpointId = randomUUID();
          expectedCheckpointVersion = 0;
          stageKey = null;
          const initialTitle = input.content.trim().slice(0, 120) || '新情景';
          await client.query(
            'INSERT INTO contexts ' +
            '(id, user_id, title, title_source, status, created_at, updated_at) ' +
            "VALUES ($1, $2, $3, 'agent', 'initializing', $4, $4)",
            [contextId, input.userId, initialTitle, input.now],
          );
          await client.query(
            'INSERT INTO workflow_routes ' +
            '(id, context_id, name, status, created_at, updated_at) ' +
            "VALUES ($1, $2, '新路线', 'initializing', $3, $3)",
            [routeId, contextId, input.now],
          );
          await client.query(
            'INSERT INTO workflow_checkpoints ' +
            '(id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) ' +
            "VALUES ($1, $2, $3, NULL, 0, NULL, 'bootstrap', $4, $5)",
            [baseCheckpointId, contextId, routeId, bootstrapSnapshot(), input.now],
          );
          await client.query(
            'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
            [routeId, baseCheckpointId],
          );
          await client.query(
            'INSERT INTO workflow_threads ' +
            '(id, context_id, route_id, stage_key, title, title_source, is_primary, status, created_at, updated_at) ' +
            "VALUES ($1, $2, $3, NULL, '新讨论', 'agent', true, 'initializing', $4, $4)",
            [conversationId, contextId, routeId, input.now],
          );
          scope = {
            mode: 'start',
            provisionalContextId: contextId,
            provisionalRouteId: routeId,
            provisionalConversationId: conversationId,
          };
        } else {
          contextId = input.contextId ?? '';
          routeId = input.routeId ?? '';
          if ((!contextId || !routeId) && input.conversationId) {
            const resolvedResult = await client.query<{
              context_id: string;
              route_id: string;
            }>(
              'SELECT t.context_id, t.route_id FROM workflow_threads t ' +
              'JOIN contexts c ON c.id = t.context_id ' +
              'JOIN workflow_routes r ON r.id = t.route_id ' +
              "WHERE t.id = $1 AND c.user_id = $2 AND c.status = 'active' " +
              "AND r.status = 'active' AND t.status = 'active'",
              [input.conversationId, input.userId],
            );
            contextId = resolvedResult.rows[0]?.context_id ?? '';
            routeId = resolvedResult.rows[0]?.route_id ?? '';
          }
          if (!contextId || !routeId || input.baseCheckpointId === undefined ||
              input.expectedCheckpointVersion === undefined) {
            throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
          }
          const routeResult = await client.query<{
            head_checkpoint_id: string;
          }>(
            'SELECT r.head_checkpoint_id FROM workflow_routes r ' +
            'JOIN contexts c ON c.id = r.context_id ' +
            "WHERE r.id = $1 AND r.context_id = $2 AND c.user_id = $3 " +
            "AND r.status = 'active' AND c.status = 'active' FOR UPDATE OF r, c",
            [routeId, contextId, input.userId],
          );
          const route = routeResult.rows[0];
          if (!route) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
          const checkpointResult = await client.query<CheckpointRow>(
            'SELECT * FROM workflow_checkpoints ' +
            'WHERE id = $1 AND route_id = $2 AND context_id = $3 AND version = $4',
            [input.baseCheckpointId, routeId, contextId, input.expectedCheckpointVersion],
          );
          const checkpoint = checkpointResult.rows[0];
          if (!checkpoint) throw new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT');
          baseCheckpointId = checkpoint.id;
          expectedCheckpointVersion = checkpoint.version;
          const baseIsHead = route.head_checkpoint_id === checkpoint.id;

          let conversationResult: {
            rows: Array<{ id: string; stage_key: string | null; status: string }>;
          };
          if (input.conversationId) {
            conversationResult = await client.query<{
              id: string;
              stage_key: string | null;
              status: string;
            }>(
              'SELECT t.id, t.stage_key, t.status FROM workflow_threads t ' +
              'WHERE t.id = $1 AND t.context_id = $2 AND t.route_id = $3 ' +
              "AND t.status = 'active' FOR UPDATE",
              [input.conversationId, contextId, routeId],
            );
          } else {
            conversationResult = await client.query<{
              id: string;
              stage_key: string | null;
              status: string;
            }>(
              'SELECT t.id, t.stage_key, t.status FROM workflow_threads t ' +
              'WHERE t.context_id = $1 AND t.route_id = $2 ' +
              "AND t.is_primary AND t.status <> 'archived' FOR UPDATE",
              [contextId, routeId],
            );
          }
          let conversation = conversationResult.rows[0];
          if (!conversation && baseIsHead && !input.conversationId) {
            conversationId = randomUUID();
            const created = await client.query<{
              id: string;
              stage_key: string | null;
              status: string;
            }>(
              'INSERT INTO workflow_threads ' +
              '(id, context_id, route_id, stage_key, title, title_source, is_primary, status, created_at, updated_at) ' +
              "VALUES ($1, $2, $3, NULL, '新讨论', 'agent', true, 'initializing', $4, $4) " +
              'RETURNING id, stage_key, status',
              [conversationId, contextId, routeId, input.now],
            );
            conversation = created.rows[0];
          }
          if (!conversation) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
          conversationId = conversation.id;
          stageKey = null;
          scope = baseIsHead
            ? {
              mode: 'head',
              contextId,
              routeId,
              conversationId: input.conversationId ?? null,
            }
            : {
              mode: 'history',
              contextId,
              sourceRouteId: routeId,
              sourceCheckpointId: checkpoint.id,
            };
        }

        if (input.kind === 'resume_interrupt') {
          const interruptResult = await client.query<{ id: string }>(
            'SELECT id FROM workflow_interrupts ' +
            "WHERE id = $1 AND context_id = $2 AND route_id = $3 AND thread_id = $4 " +
            "AND status = 'pending' FOR UPDATE",
            [input.interruptId, contextId, routeId, conversationId],
          );
          if (!interruptResult.rows[0]) {
            throw new CommandRepositoryError('PENDING_INTERRUPT_NOT_FOUND');
          }
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
            contextId,
            routeId,
            conversationId,
            stageKey,
            baseCheckpointId,
            expectedCheckpointVersion,
            input.kind,
            input.actionKey ?? null,
            input.interruptId ?? null,
            input.content,
            input.inputHash,
            input.leaseExpiresAt,
            input.now,
          ],
        );
        const command = inserted.rows[0]!;
        await appendEventWithClient(
          client,
          command.id,
          'command.accepted',
          {
            status: 'running',
            scopeMode: scope.mode,
            ...(scope.mode === 'head'
              ? { conversationWasExplicit: scope.conversationId !== null }
              : {}),
          },
          input.now,
        );
        return {
          kind: 'claimed',
          command: mapCommand(command),
          execution: await loadUnifiedExecution(client, command, input.userId, scope),
        };
      });
    },

    async claimCommand(input: ClaimCommandInput): Promise<ClaimCommandResult> {
      return withTransaction(pool, async (client) => {
        await lockCommandId(client, input.commandId);
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
        'SELECT t.id FROM workflow_threads t ' +
        'JOIN contexts c ON c.id = t.context_id ' +
        'JOIN workflow_routes r ON r.id = t.route_id AND r.context_id = t.context_id ' +
        "WHERE t.id = $1 AND c.user_id = $2 AND t.status = 'active' " +
        "AND c.status = 'active' AND r.status = 'active'",
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

    async listConversationState(userId: string, conversationId: string) {
      const ownedResult = await pool.query<{ id: string }>(
        'SELECT t.id FROM workflow_threads t ' +
        'JOIN contexts c ON c.id = t.context_id ' +
        'JOIN workflow_routes r ON r.id = t.route_id AND r.context_id = t.context_id ' +
        "WHERE t.id = $1 AND c.user_id = $2 AND t.status = 'active' " +
        "AND c.status = 'active' AND r.status = 'active'",
        [conversationId, userId],
      );
      if (!ownedResult.rows[0]) return null;
      const [messagesResult, interruptResult] = await Promise.all([
        pool.query<MessageRow>(
          'SELECT * FROM workflow_messages WHERE thread_id = $1 ORDER BY sequence',
          [conversationId],
        ),
        pool.query<Omit<InterruptRow, 'workflow_cursor'>>(
          "SELECT id, prompt, action_key, created_at FROM workflow_interrupts " +
          "WHERE thread_id = $1 AND status = 'pending' ORDER BY created_at DESC, id LIMIT 1",
          [conversationId],
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

    async finalizeCommand(
      commandId: string,
      result: FinalizeCommandInput,
      now: Date,
    ): Promise<UnifiedCommandCommitResult> {
      return withTransaction(pool, async (client) => {
        const commandResult = await client.query<CommandRow>(
          'SELECT * FROM workflow_commands WHERE id = $1 FOR UPDATE',
          [commandId],
        );
        const command = commandResult.rows[0];
        if (!command || command.status !== 'running') {
          throw new CommandRepositoryError('COMMAND_NOT_FINALIZABLE');
        }
        const scopeResult = await client.query<{ scope_mode: CommandScope['mode'] }>(
          "SELECT payload->>'scopeMode' AS scope_mode FROM workflow_command_events " +
          "WHERE command_id = $1 AND event_type = 'command.accepted' ORDER BY sequence LIMIT 1",
          [command.id],
        );
        const scopeMode = scopeResult.rows[0]?.scope_mode;
        if (scopeMode !== 'start' && scopeMode !== 'head' && scopeMode !== 'history') {
          throw new CommandRepositoryError('COMMAND_NOT_FINALIZABLE');
        }
        const contextResult = await client.query<{ user_id: string; status: string }>(
          'SELECT user_id, status FROM contexts WHERE id = $1 FOR UPDATE',
          [command.context_id],
        );
        const context = contextResult.rows[0];
        if (!context) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
        const sourceRouteResult = await client.query<{
          name: string;
          status: string;
          head_checkpoint_id: string;
        }>(
          'SELECT name, status, head_checkpoint_id FROM workflow_routes WHERE id = $1 FOR UPDATE',
          [command.source_route_id],
        );
        const sourceRoute = sourceRouteResult.rows[0];
        if (!sourceRoute) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
        const baseResult = await client.query<CheckpointRow>(
          'SELECT * FROM workflow_checkpoints ' +
          'WHERE id = $1 AND route_id = $2 AND context_id = $3 AND version = $4',
          [
            command.base_checkpoint_id,
            command.source_route_id,
            command.context_id,
            command.expected_checkpoint_version,
          ],
        );
        const base = baseResult.rows[0];
        if (!base) throw new CommandRepositoryError('CHECKPOINT_VERSION_CONFLICT');

        if (scopeMode !== 'history' && sourceRoute.head_checkpoint_id !== command.base_checkpoint_id) {
          await client.query(
            "UPDATE workflow_commands SET status = 'conflict', lease_expires_at = NULL, " +
            "error_code = 'CHECKPOINT_VERSION_CONFLICT', updated_at = $2 WHERE id = $1",
            [command.id, now],
          );
          const event = await appendEventWithClient(client, command.id, 'command.finished', {
            outcome: 'conflict',
            code: 'CHECKPOINT_VERSION_CONFLICT',
            currentHeadCheckpointId: sourceRoute.head_checkpoint_id,
          }, now);
          return {
            status: 'conflict',
            routeId: command.source_route_id,
            conversationId: command.source_thread_id,
            checkpointId: null,
            userMessageId: null,
            assistantMessageId: null,
            errorCode: 'CHECKPOINT_VERSION_CONFLICT',
            events: [event],
          };
        }

        let routeId = command.source_route_id;
        let conversationId = command.source_thread_id;
        let parentCheckpointId = base.id;
        let checkpointVersion = base.version + 1;
        const baseSnapshot = normalizeCheckpointSnapshot(base.snapshot);
        if (scopeMode === 'history') {
          routeId = randomUUID();
          conversationId = randomUUID();
          const branchCheckpointId = randomUUID();
          await client.query(
            'INSERT INTO workflow_routes ' +
            '(id, context_id, name, origin_checkpoint_id, status, created_at, updated_at) ' +
            "VALUES ($1, $2, $3, $4, 'active', $5, $5)",
            [routeId, command.context_id, sourceRoute.name, base.id, now],
          );
          await client.query(
            'INSERT INTO workflow_checkpoints ' +
            '(id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) ' +
            "VALUES ($1, $2, $3, NULL, 0, $4, 'branch', $5, $6)",
            [branchCheckpointId, command.context_id, routeId, command.stage_key, baseSnapshot, now],
          );
          await client.query(
            'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
            [routeId, branchCheckpointId],
          );
          for (const [position, stage] of checkpointStages(baseSnapshot).entries()) {
            await client.query(
              'INSERT INTO route_stage_projections ' +
              '(route_id, stage_key, position, status, internal_state, updated_at) ' +
              'VALUES ($1, $2, $3, $4, $5, $6)',
              [routeId, stage.stage_key, position, stage.status, stage.internal_state, now],
            );
          }
          await client.query(
            'INSERT INTO workflow_threads ' +
            '(id, context_id, route_id, stage_key, title, title_source, is_primary, status, created_at, updated_at) ' +
            "VALUES ($1, $2, $3, NULL, $4, 'agent', true, 'active', $5, $5)",
            [
              conversationId,
              command.context_id,
              routeId,
              agentTitle(result.conversationTitle) ?? '新讨论',
              now,
            ],
          );
          parentCheckpointId = branchCheckpointId;
          checkpointVersion = 1;
        } else {
          const targetConversation = await client.query<{ id: string }>(
            'SELECT id FROM workflow_threads ' +
            'WHERE id = $1 AND context_id = $2 AND route_id = $3 FOR UPDATE',
            [conversationId, command.context_id, routeId],
          );
          if (!targetConversation.rows[0]) throw new CommandRepositoryError('COMMAND_SCOPE_INVALID');
        }

        const memoryReferences = await appendWorkflowMemoryVersions(client, {
          userId: context.user_id,
          contextId: command.context_id,
          conversationId,
          commandId: command.id,
          checkpointId: result.checkpointId,
          updates: result.memoryUpdates ?? [],
          baseReferences: baseSnapshot.memoryReferences,
          now,
        });
        const stages = result.workflowState === undefined
          ? await applyUnifiedStageSignals(client, routeId, result.stageSignals, now)
          : [];
        const snapshot = unifiedSnapshot(baseSnapshot, command, result, stages, memoryReferences);
        await client.query(
          'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, 'workflow_action', $7, $8)",
          [
            result.checkpointId,
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
          "UPDATE workflow_routes SET head_checkpoint_id = $2, status = 'active', updated_at = $3 " +
          'WHERE id = $1',
          [routeId, result.checkpointId, now],
        );
        await client.query(
          'UPDATE contexts SET ' +
          "title = CASE WHEN title_source = 'agent' AND $2::text IS NOT NULL THEN $2 ELSE title END, " +
          "status = CASE WHEN status = 'initializing' THEN 'active' ELSE status END, updated_at = $3 " +
          'WHERE id = $1',
          [command.context_id, agentTitle(result.contextTitle), now],
        );
        await client.query(
          'UPDATE workflow_threads SET ' +
          "title = CASE WHEN title_source = 'agent' AND $2::text IS NOT NULL THEN $2 ELSE title END, " +
          "status = 'active', updated_at = $3 WHERE id = $1",
          [conversationId, agentTitle(result.conversationTitle), now],
        );
        await client.query(
          'UPDATE workflow_commands SET result_route_id = $2, result_thread_id = $3, ' +
          'result_checkpoint_id = $4, updated_at = $5 WHERE id = $1',
          [command.id, routeId, conversationId, result.checkpointId, now],
        );
        await insertMessages(
          client,
          command,
          routeId,
          conversationId,
          result.userMessageId,
          result.assistantMessageId,
          result.reply,
          now,
        );
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
              routeId,
              conversationId,
              command.stage_key,
              result.interrupt.prompt,
              result.interrupt.cursor,
              command.id,
              result.interrupt.actionKey ?? command.action_key,
              now,
            ],
          );
          const interrupt = interruptResult.rows[0]!;
          pendingInterrupt = {
            id: interrupt.id,
            prompt: interrupt.prompt,
            actionKey: interrupt.action_key,
            createdAt: interrupt.created_at,
          };
        }
        await adoptUnifiedAttachments(
          client,
          command,
          context.user_id,
          routeId,
          conversationId,
          result.attachmentIds,
          now,
        );
        await insertMemoryProposals(
          client,
          command,
          routeId,
          conversationId,
          result.memoryProposals,
          now,
        );
        return completeUnifiedCommand(client, command, {
          routeId,
          conversationId,
          checkpointId: result.checkpointId,
          userMessageId: result.userMessageId,
          assistantMessageId: result.assistantMessageId,
          reply: result.reply,
          pendingInterrupt,
        }, now);
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
        const baseSnapshot = normalizeCheckpointSnapshot(base.snapshot);
        const artifactMap = new Map(
          baseSnapshot.artifacts.map((artifact) => [artifact.id, artifact]),
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
        const legacyStages = snapshotStages(stageRows);
        const artifacts = [...artifactMap.values()];
        const legacyMetadata = {
          command: {
            id: command.id,
            kind: command.kind,
            action_key: command.action_key,
          },
          memory_proposals: result.memoryProposals,
          adopted_thread_id: result.adoptedThreadId,
          result_message_ids: [ids.userMessageId, ids.assistantMessageId],
        };
        const snapshot: CheckpointSnapshot & LegacyCheckpointSnapshot = {
          ...legacyMetadata,
          workflowState: {
            legacyCompatibility: {
              stages: legacyStages,
              command: legacyMetadata.command,
              memoryProposals: result.memoryProposals,
              adoptedThreadId: result.adoptedThreadId,
              resultMessageIds: [ids.userMessageId, ids.assistantMessageId],
            },
          },
          stageProjection: {
            revision: 'legacy-stage-projection-v1',
            items: stageRows.map((stage) => ({
              key: stage.stageKey,
              label: stage.stageKey,
              status: stage.status,
              summary: stage.internalState,
            })),
          },
          memoryReferences: [],
          artifacts,
          stages: legacyStages,
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
