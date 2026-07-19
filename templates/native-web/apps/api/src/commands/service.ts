import { createHash, randomUUID } from 'node:crypto';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type {
  WorkflowBridge,
  WorkflowV2BridgeInput,
  WorkflowV2BridgeResult,
} from './bridge.js';
import type { AssetService } from '../assets/service.js';
import type { MemoryRepository } from '../memory/repository.js';
import type { MemoryUpdate } from '../memory/types.js';
import { WorkflowBridgeError } from './bridge.js';
import type { CommandRepository } from './repository.js';
import { CommandRepositoryError } from './types.js';
import type {
  CommandExecutionContext,
  FinalizeCommandInput,
  PendingInterruptInput,
  PrepareCommandInput,
  PrepareCommandResult,
  PublicCommandInput,
  PublicWorkflowCommandInput,
  UnifiedCommandCommitResult,
  UnifiedCommandExecutionContext,
  WorkflowCommand,
  WorkflowCommandKind,
} from './types.js';

export type CommandInput =
  | {
    commandId: string;
    kind: 'message';
    content: string;
    baseCheckpointId: string;
    expectedCheckpointVersion: number;
  }
  | {
    commandId: string;
    kind: 'named_action';
    actionKey: string;
    content: string;
    baseCheckpointId: string;
    expectedCheckpointVersion: number;
  }
  | {
    commandId: string;
    kind: 'resume_interrupt';
    interruptId: string;
    content: string;
    baseCheckpointId: string;
    expectedCheckpointVersion: number;
  };

interface NormalizedCommandInput {
  commandId: string;
  kind: WorkflowCommandKind;
  actionKey?: string;
  interruptId?: string;
  content: string;
  baseCheckpointId: string;
  expectedCheckpointVersion: number;
}

interface NormalizedPublicCommandInput extends PublicCommandInput {
  kind: WorkflowCommandKind;
  actionKey?: string;
  interruptId?: string;
  content: string;
}

interface PendingExecution {
  input: NormalizedCommandInput;
  command: WorkflowCommand;
  execution: CommandExecutionContext;
}

interface UnifiedPendingExecution {
  input: NormalizedPublicCommandInput;
  command: WorkflowCommand;
  execution: UnifiedCommandExecutionContext;
}

type UnifiedCommandRepository = CommandRepository & {
  prepareCommand(input: PrepareCommandInput): Promise<PrepareCommandResult>;
  finalizeCommand(
    commandId: string,
    result: FinalizeCommandInput,
    now: Date,
  ): Promise<UnifiedCommandCommitResult>;
  persistInterrupt(
    commandId: string,
    interrupt: PendingInterruptInput,
    now: Date,
  ): Promise<unknown>;
};

export class CommandServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'CommandServiceError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memoryUpdateKeys = new Set([
  'scope', 'key', 'value', 'expectedVersion', 'highImpact',
  'confirmationPrompt', 'evidence', 'impactScope',
]);
const memoryEvidenceKeys = new Set(['kind', 'id', 'excerpt']);
const maxMemoryUpdates = 1000;
const maxMemoryValueDepth = 64;
const maxMemoryValueNodes = 20_000;
const maxMemoryValueCharacters = 36_000_000;

interface MemoryValidationBudget {
  nodes: number;
  characters: number;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) return false;
    return names.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return allowed.has(key) && descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value');
    });
  } catch {
    return false;
  }
}

function isJsonSafeMemoryValue(
  value: unknown,
  budget: MemoryValidationBudget = { nodes: 0, characters: 0 },
) {
  const ancestors = new WeakSet<object>();

  function visit(candidate: unknown, depth: number): boolean {
    if (++budget.nodes > maxMemoryValueNodes || depth > maxMemoryValueDepth) return false;
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return true;
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object' || ancestors.has(candidate)) return false;

    ancestors.add(candidate);
    try {
      if (Object.getOwnPropertySymbols(candidate).length > 0) return false;
      if (Array.isArray(candidate)) {
        const names = Object.getOwnPropertyNames(candidate);
        if (names.length !== candidate.length + 1 || !names.includes('length')) return false;
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
              !visit(descriptor.value, depth + 1)) return false;
        }
        return true;
      }
      if (!isPlainObject(candidate)) return false;
      const names = Object.getOwnPropertyNames(candidate);
      const keys = Object.keys(candidate);
      if (names.length !== keys.length) return false;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
            !visit(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally {
      ancestors.delete(candidate);
    }
  }

  try {
    if (!visit(value, 0)) return false;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    budget.characters += serialized.length;
    return budget.characters <= maxMemoryValueCharacters;
  } catch {
    return false;
  }
}

function isMemoryEvidence(value: unknown) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, memoryEvidenceKeys) ||
      !isJsonSafeMemoryValue(value)) return false;
  return typeof value.kind === 'string' && value.kind.length >= 1 && value.kind.length <= 200 &&
    typeof value.id === 'string' && value.id.length >= 1 && value.id.length <= 500 &&
    (value.excerpt === undefined ||
      (typeof value.excerpt === 'string' && value.excerpt.length <= 2000));
}

function isMemoryImpactScope(value: unknown) {
  if (!isPlainObject(value) || !isJsonSafeMemoryValue(value) ||
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'contextIds')) return false;
  const contextIds = value.contextIds;
  return contextIds === 'all' ||
    (Array.isArray(contextIds) && contextIds.length <= 1000 &&
      contextIds.every((id) => typeof id === 'string' && uuidPattern.test(id)));
}

function isMemoryUpdate(
  value: unknown,
  budget: MemoryValidationBudget,
): value is MemoryUpdate {
  if (!isPlainObject(value) || !hasOnlyKeys(value, memoryUpdateKeys) ||
      (value.scope !== 'user' && value.scope !== 'context') ||
      typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 200 ||
      value.key !== value.key.trim() ||
      !Object.hasOwn(value, 'value') || !isJsonSafeMemoryValue(value.value, budget) ||
      (value.expectedVersion !== undefined &&
        (typeof value.expectedVersion !== 'number' ||
          !Number.isInteger(value.expectedVersion) || value.expectedVersion < 1)) ||
      (value.highImpact !== undefined && typeof value.highImpact !== 'boolean') ||
      (value.confirmationPrompt !== undefined &&
        (typeof value.confirmationPrompt !== 'string' ||
          value.confirmationPrompt.trim().length < 1 || value.confirmationPrompt.length > 2000)) ||
      (value.evidence !== undefined &&
        (!isJsonSafeMemoryValue(value.evidence, budget) ||
          !Array.isArray(value.evidence) || value.evidence.length > 100 ||
          value.evidence.some((item) => !isMemoryEvidence(item)))) ||
      (value.impactScope !== undefined &&
        (!isJsonSafeMemoryValue(value.impactScope, budget) ||
          !isMemoryImpactScope(value.impactScope)))) {
    return false;
  }
  return true;
}

function isWorkflowV2Result(result: unknown): result is WorkflowV2BridgeResult {
  const memoryBudget = { nodes: 0, characters: 0 };
  if (!isPlainObject(result) ||
      !Array.isArray(result.replyEvents) ||
      result.replyEvents.some((event) =>
        !isPlainObject(event) ||
        (event.type !== 'delta' && event.type !== 'message') ||
        typeof event.content !== 'string') ||
      !isPlainObject(result.checkpoint) ||
      !Object.hasOwn(result.checkpoint, 'workflowState') ||
      !isPlainObject(result.checkpoint.workflowState) ||
      !Array.isArray(result.memoryUpdates) ||
      result.memoryUpdates.length > maxMemoryUpdates ||
      result.memoryUpdates.some((update) => !isMemoryUpdate(update, memoryBudget)) ||
      !Array.isArray(result.artifactProposals) ||
      !isPlainObject(result.diagnostics) ||
      !Object.hasOwn(result, 'interrupt')) {
    return false;
  }
  if (result.interrupt === null) return true;
  return isPlainObject(result.interrupt) &&
    typeof result.interrupt.prompt === 'string' &&
    Object.hasOwn(result.interrupt, 'cursor');
}

function snapshotMemoryUpdate(update: MemoryUpdate): MemoryUpdate {
  const snapshot: MemoryUpdate = {
    scope: update.scope,
    key: update.key,
    value: JSON.parse(JSON.stringify(update.value)) as unknown,
  };
  if (update.expectedVersion !== undefined) snapshot.expectedVersion = update.expectedVersion;
  if (update.highImpact !== undefined) snapshot.highImpact = update.highImpact;
  if (update.confirmationPrompt !== undefined) {
    snapshot.confirmationPrompt = update.confirmationPrompt;
  }
  if (update.evidence !== undefined) {
    snapshot.evidence = update.evidence.map((item) => ({
      kind: item.kind,
      id: item.id,
      ...(item.excerpt === undefined ? {} : { excerpt: item.excerpt }),
    }));
  }
  if (update.impactScope !== undefined) {
    snapshot.impactScope = {
      contextIds: update.impactScope.contextIds === 'all'
        ? 'all'
        : [...update.impactScope.contextIds],
    };
  }
  return snapshot;
}

async function runUnifiedBridge(
  bridge: WorkflowBridge,
  input: WorkflowV2BridgeInput,
): Promise<WorkflowV2BridgeResult> {
  const result: unknown = await bridge.run(input);
  if (!isWorkflowV2Result(result)) {
    throw new WorkflowBridgeError('WORKFLOW_INVALID_RESPONSE');
  }
  return {
    ...result,
    memoryUpdates: result.memoryUpdates.map(snapshotMemoryUpdate),
  };
}

function replyFromEvents(
  events: Array<{ type: 'delta' | 'message'; content: string }>,
  interruptPrompt?: string,
): string {
  const message = [...events].reverse().find((event) => event.type === 'message');
  const streamed = events.map((event) => event.content).join('');
  const reply = message?.content ?? (streamed || interruptPrompt || '');
  if (!reply.trim()) throw new WorkflowBridgeError('WORKFLOW_INVALID_RESPONSE');
  return reply.trim();
}

function memoryReferencesFromExecution(
  memory: UnifiedCommandExecutionContext['memory'],
): Array<{ memoryId: string; version: number }> {
  const references = new Map<string, { memoryId: string; version: number }>();
  for (const item of [...(memory?.user ?? []), ...(memory?.context ?? [])]) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !uuidPattern.test(item.id) ||
        typeof item.version !== 'number' || !Number.isInteger(item.version) || item.version < 1) {
      continue;
    }
    references.set(item.id, { memoryId: item.id, version: item.version });
  }
  return [...references.values()];
}

function normalize(input: CommandInput): NormalizedCommandInput {
  const content = input.content.trim();
  if (content.length > 20_000 || (input.kind !== 'named_action' && content.length === 0)) {
    throw new CommandServiceError('INVALID_REQUEST', 400);
  }
  return {
    commandId: input.commandId,
    kind: input.kind,
    content,
    baseCheckpointId: input.baseCheckpointId,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    ...(input.kind === 'named_action' ? { actionKey: input.actionKey } : {}),
    ...(input.kind === 'resume_interrupt' ? { interruptId: input.interruptId } : {}),
  };
}

function normalizePublic(input: PublicCommandInput): NormalizedPublicCommandInput {
  const candidate = input as unknown as Record<string, unknown> | null;
  const workflowInput = candidate?.input;
  const scopeFields = ['contextId', 'routeId', 'conversationId', 'baseCheckpointId'] as const;
  const expectedCheckpointVersion = candidate?.expectedCheckpointVersion;
  if (!candidate || typeof candidate.commandId !== 'string' ||
      scopeFields.some((key) => candidate[key] !== undefined && typeof candidate[key] !== 'string') ||
      !Array.isArray(candidate.attachmentIds) || candidate.attachmentIds.length > 100 ||
      candidate.attachmentIds.some((id) => typeof id !== 'string') ||
      new Set(candidate.attachmentIds).size !== candidate.attachmentIds.length ||
      (expectedCheckpointVersion !== undefined &&
        (typeof expectedCheckpointVersion !== 'number' ||
          !Number.isInteger(expectedCheckpointVersion) || expectedCheckpointVersion < 0)) ||
      ((candidate.contextId === undefined) !== (candidate.routeId === undefined)) ||
      ((candidate.baseCheckpointId === undefined) !==
        (candidate.expectedCheckpointVersion === undefined)) ||
      !workflowInput || typeof workflowInput !== 'object') {
    throw new CommandServiceError('INVALID_REQUEST', 400);
  }
  const rawWorkflowInput = workflowInput as Record<string, unknown>;
  if (
    (rawWorkflowInput.type === 'message' && typeof rawWorkflowInput.content !== 'string') ||
    (rawWorkflowInput.type === 'named_intent' &&
      (typeof rawWorkflowInput.key !== 'string' ||
        (rawWorkflowInput.content !== undefined && typeof rawWorkflowInput.content !== 'string'))) ||
    (rawWorkflowInput.type === 'resume_interrupt' &&
      (typeof rawWorkflowInput.interruptId !== 'string' || typeof rawWorkflowInput.content !== 'string')) ||
    (rawWorkflowInput.type !== 'message' && rawWorkflowInput.type !== 'named_intent' &&
      rawWorkflowInput.type !== 'resume_interrupt')
  ) {
    throw new CommandServiceError('INVALID_REQUEST', 400);
  }

  let normalizedInput: PublicWorkflowCommandInput;
  let kind: WorkflowCommandKind;
  let actionKey: string | undefined;
  let interruptId: string | undefined;
  let content: string;
  if (rawWorkflowInput.type === 'message') {
    content = (rawWorkflowInput.content as string).trim();
    if (content.length === 0 || content.length > 20_000) {
      throw new CommandServiceError('INVALID_REQUEST', 400);
    }
    kind = 'message';
    normalizedInput = { type: 'message', content };
  } else if (rawWorkflowInput.type === 'named_intent') {
    actionKey = (rawWorkflowInput.key as string).trim();
    const requestedContent = (rawWorkflowInput.content as string | undefined)?.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(actionKey) || actionKey.length > 200 ||
        (requestedContent !== undefined && requestedContent.length > 20_000)) {
      throw new CommandServiceError('INVALID_REQUEST', 400);
    }
    kind = 'named_action';
    content = requestedContent || actionKey;
    normalizedInput = {
      type: 'named_intent',
      key: actionKey,
      ...(requestedContent === undefined ? {} : { content: requestedContent }),
    };
  } else {
    interruptId = rawWorkflowInput.interruptId as string;
    content = (rawWorkflowInput.content as string).trim();
    if (content.length === 0 || content.length > 20_000) {
      throw new CommandServiceError('INVALID_REQUEST', 400);
    }
    kind = 'resume_interrupt';
    normalizedInput = { type: 'resume_interrupt', interruptId, content };
  }

  return {
    commandId: candidate.commandId,
    ...(candidate.contextId === undefined ? {} : { contextId: candidate.contextId as string }),
    ...(candidate.routeId === undefined ? {} : { routeId: candidate.routeId as string }),
    ...(candidate.conversationId === undefined
      ? {}
      : { conversationId: candidate.conversationId as string }),
    ...(candidate.baseCheckpointId === undefined
      ? {}
      : { baseCheckpointId: candidate.baseCheckpointId as string }),
    ...(candidate.expectedCheckpointVersion === undefined
      ? {}
      : { expectedCheckpointVersion: candidate.expectedCheckpointVersion as number }),
    input: normalizedInput,
    attachmentIds: [...candidate.attachmentIds as string[]],
    kind,
    ...(actionKey === undefined ? {} : { actionKey }),
    ...(interruptId === undefined ? {} : { interruptId }),
    content,
  };
}

function canonicalHash(userId: string, threadId: string, input: NormalizedCommandInput): string {
  const canonical = JSON.stringify({
    authenticatedUserId: userId,
    threadId,
    baseCheckpointId: input.baseCheckpointId,
    expectedCheckpointVersion: input.expectedCheckpointVersion,
    kind: input.kind,
    actionKey: input.actionKey ?? null,
    interruptId: input.interruptId ?? null,
    content: input.content,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalPublicHash(userId: string, input: NormalizedPublicCommandInput): string {
  const canonical = JSON.stringify({
    authenticatedUserId: userId,
    commandId: input.commandId,
    contextId: input.contextId ?? null,
    routeId: input.routeId ?? null,
    conversationId: input.conversationId ?? null,
    baseCheckpointId: input.baseCheckpointId ?? null,
    expectedCheckpointVersion: input.expectedCheckpointVersion ?? null,
    input: input.input,
    attachmentIds: input.attachmentIds,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function createCommandService(options: {
  repository: CommandRepository;
  bridge: WorkflowBridge;
  manifest: ProductManifest;
  memoryRepository?: Pick<MemoryRepository, 'detectConflict'>;
  createId?: () => string;
  now?: () => Date;
  leaseDurationMs?: number;
  assetService?: AssetService;
}) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const leaseDurationMs = options.leaseDurationMs ?? 90_000;
  const pending = new Map<string, PendingExecution>();
  const unifiedPending = new Map<string, UnifiedPendingExecution>();
  const running = new Map<string, Promise<void>>();
  const unifiedRepository = options.repository as UnifiedCommandRepository;
  const legacyStages = options.manifest.stages ?? [];
  const stageDefinitions = new Map(legacyStages.map((stage) => [stage.key, stage]));
  const actionDefinitions = new Map(legacyStages.flatMap(
    (stage) => stage.actions.map((action) => [action.key, action] as const),
  ));
  const knownActions = new Set(actionDefinitions.keys());

  async function rejectClaim(commandId: string, code: string, statusCode: number): Promise<never> {
    await options.repository.failCommand(commandId, code, now());
    throw new CommandServiceError(code, statusCode);
  }

  async function createUnifiedCommand(userId: string, rawInput: PublicCommandInput) {
    const input = normalizePublic(rawInput);
    const preparedAt = now();
    let prepared: PrepareCommandResult;
    try {
      prepared = await unifiedRepository.prepareCommand({
        ...input,
        userId,
        inputHash: canonicalPublicHash(userId, input),
        now: preparedAt,
        leaseExpiresAt: new Date(preparedAt.getTime() + leaseDurationMs),
      });
    } catch (error) {
      if (error instanceof CommandRepositoryError) {
        if (error.code === 'COMMAND_SCOPE_INVALID') throw new CommandServiceError('NOT_FOUND', 404);
        if (error.code === 'PENDING_INTERRUPT_NOT_FOUND') throw new CommandServiceError(error.code, 409);
        if (error.code === 'CHECKPOINT_VERSION_CONFLICT') throw new CommandServiceError(error.code, 409);
        if (error.code === 'COMMAND_INPUT_INVALID') throw new CommandServiceError('INVALID_REQUEST', 400);
      }
      throw error;
    }
    if (prepared.kind === 'reused') throw new CommandServiceError('COMMAND_ID_REUSED', 409);
    if (prepared.kind === 'in_progress') throw new CommandServiceError('COMMAND_IN_PROGRESS', 409);
    if (prepared.kind === 'interrupt_claimed') {
      throw new CommandServiceError('INTERRUPT_ALREADY_RESUMED', 409);
    }
    const receipt = {
      commandId: input.commandId,
      eventUrl: `/api/commands/${input.commandId}/events`,
    };
    if (prepared.kind === 'replay') return { ...receipt, replayed: true };
    if (input.kind === 'resume_interrupt' && prepared.execution.interruptCursor === undefined) {
      return rejectClaim(input.commandId, 'PENDING_INTERRUPT_NOT_FOUND', 409);
    }
    unifiedPending.set(input.commandId, {
      input,
      command: prepared.command,
      execution: prepared.execution,
    });
    return { ...receipt, replayed: false };
  }

  async function createLegacyCommand(userId: string, threadId: string, rawInput: CommandInput) {
    const input = normalize(rawInput);
    if (input.kind === 'named_action' && input.content.length === 0) {
      input.content = actionDefinitions.get(input.actionKey!)?.label ?? input.actionKey!;
    }
    if (input.kind === 'named_action' && !knownActions.has(input.actionKey!)) {
      // The durable row still records invalid authenticated attempts consistently.
    }
    const claimedAt = now();
    let claimed;
    try {
      claimed = await options.repository.claimCommand({
        userId,
        commandId: input.commandId,
        threadId,
        kind: input.kind,
        actionKey: input.actionKey,
        interruptId: input.interruptId,
        content: input.content,
        baseCheckpointId: input.baseCheckpointId,
        expectedCheckpointVersion: input.expectedCheckpointVersion,
        inputHash: canonicalHash(userId, threadId, input),
        now: claimedAt,
        leaseExpiresAt: new Date(claimedAt.getTime() + leaseDurationMs),
      });
    } catch (error) {
      if (error instanceof CommandRepositoryError) {
        if (error.code === 'COMMAND_SCOPE_INVALID') throw new CommandServiceError('NOT_FOUND', 404);
        if (error.code === 'PENDING_INTERRUPT_NOT_FOUND') throw new CommandServiceError(error.code, 409);
        if (error.code === 'CHECKPOINT_VERSION_CONFLICT') throw new CommandServiceError(error.code, 409);
        if (error.code === 'COMMAND_INPUT_INVALID') throw new CommandServiceError('INVALID_REQUEST', 400);
      }
      throw error;
    }
    if (claimed.kind === 'reused') throw new CommandServiceError('COMMAND_ID_REUSED', 409);
    if (claimed.kind === 'in_progress') throw new CommandServiceError('COMMAND_IN_PROGRESS', 409);
    if (claimed.kind === 'interrupt_claimed') throw new CommandServiceError('INTERRUPT_ALREADY_RESUMED', 409);
    const receipt = {
      commandId: input.commandId,
      eventUrl: `/api/commands/${input.commandId}/events`,
    };
    if (claimed.kind === 'replay') return { ...receipt, replayed: true };

    if (!claimed.execution.baseIsHead) {
      return rejectClaim(input.commandId, 'CHECKPOINT_NOT_CURRENT', 409);
    }

    const definition = stageDefinitions.get(claimed.execution.stageKey);
    const projection = claimed.execution.stages.find((stage) => stage.stageKey === claimed.execution.stageKey);
    if (!definition || !projection) return rejectClaim(input.commandId, 'WORKFLOW_STATE_INVALID', 409);
    if (input.kind === 'named_action') {
      if (!knownActions.has(input.actionKey!)) return rejectClaim(input.commandId, 'INVALID_ACTION', 400);
      if (projection.status === 'not_started' || !definition.actions.some((action) => action.key === input.actionKey)) {
        return rejectClaim(input.commandId, 'ACTION_NOT_AVAILABLE', 409);
      }
    }
    if (input.kind === 'resume_interrupt' && claimed.execution.interruptCursor === undefined) {
      return rejectClaim(input.commandId, 'PENDING_INTERRUPT_NOT_FOUND', 409);
    }
    pending.set(input.commandId, { input, command: claimed.command, execution: claimed.execution });
    return { ...receipt, replayed: false };
  }

  function executeUnifiedCommand(
    commandId: string,
    prepared: UnifiedPendingExecution,
  ): Promise<void> {
    const task = (async () => {
      try {
        await options.repository.appendEvent(
          commandId,
          'workflow.started',
          { attempt: prepared.command.attempt },
          now(),
        );
        const conversationId = prepared.execution.conversationId ?? prepared.execution.threadId;
        const consumedMemoryReferences = memoryReferencesFromExecution(prepared.execution.memory);
        const result = await runUnifiedBridge(options.bridge, {
          commandId,
          userId: prepared.execution.userId,
          contextId: prepared.execution.contextId,
          routeId: prepared.execution.routeId,
          conversationId,
          baseCheckpoint: prepared.execution.baseCheckpoint,
          commandInput: prepared.input.input,
          ...(prepared.execution.interruptCursor === undefined
            ? {}
            : { interruptCursor: prepared.execution.interruptCursor }),
          attachments: prepared.input.attachmentIds,
          history: prepared.execution.history,
          memory: prepared.execution.memory ?? { user: [], context: [] },
        });
        const reply = replyFromEvents(result.replyEvents, result.interrupt?.prompt);
        const memoryUpdates = result.memoryUpdates;
        if (memoryUpdates.length > 0 && !options.memoryRepository) {
          throw new WorkflowBridgeError('WORKFLOW_INVALID_RESPONSE');
        }
        for (const update of memoryUpdates) {
          const conflict = await options.memoryRepository!.detectConflict({
            userId: prepared.execution.userId,
            contextId: prepared.execution.contextId,
            update,
          });
          if (update.highImpact || conflict) {
            await unifiedRepository.persistInterrupt(commandId, {
              id: createId(),
              prompt: update.confirmationPrompt?.trim() || '确认保存这项记忆更新？',
              cursor: {
                kind: 'memory_confirmation',
                update,
                current: conflict?.current,
              },
            }, now());
            return;
          }
        }
        if (result.artifactProposals.length > 0 && !options.assetService) {
          throw new Error('Artifact service is unavailable');
        }
        const preparedArtifacts = options.assetService
          ? await Promise.all(result.artifactProposals.map((artifact) =>
            options.assetService!.prepareArtifact(prepared.execution.userId, artifact)))
          : [];
        const committed = await unifiedRepository.finalizeCommand(commandId, {
          userMessageId: createId(),
          assistantMessageId: createId(),
          checkpointId: createId(),
          headCheckpointIdAtClaim: prepared.execution.headCheckpointId,
          reply,
          stageSignals: [],
          workflowCursor: null,
          memoryProposals: [],
          workflowState: result.checkpoint.workflowState,
          ...(typeof result.diagnostics.workflow_revision === 'string' &&
            result.diagnostics.workflow_revision.trim().length > 0 &&
            result.diagnostics.workflow_revision.length <= 200
            ? { workflowRevision: result.diagnostics.workflow_revision }
            : {}),
          ...(result.stageProjection === undefined
            ? {}
            : { stageProjection: result.stageProjection }),
          ...(result.contextTitle === undefined ? {} : { contextTitle: result.contextTitle }),
          ...(result.conversationTitle === undefined
            ? {}
            : { conversationTitle: result.conversationTitle }),
          interrupt: result.interrupt ? {
            id: createId(),
            prompt: result.interrupt.prompt,
            cursor: result.interrupt.cursor,
          } : null,
          attachmentIds: prepared.input.attachmentIds,
          preparedArtifacts,
          memoryUpdates,
          consumedMemoryReferences,
        }, now());
      } catch (error) {
        const code = error instanceof WorkflowBridgeError ? error.code : 'WORKFLOW_UNAVAILABLE';
        await options.repository.failCommand(commandId, code, now());
      } finally {
        unifiedPending.delete(commandId);
        running.delete(commandId);
      }
    })();
    running.set(commandId, task);
    return task;
  }

  function executeCommand(commandId: string): Promise<void> {
    const active = running.get(commandId);
    if (active) return active;
    const unifiedPrepared = unifiedPending.get(commandId);
    if (unifiedPrepared) return executeUnifiedCommand(commandId, unifiedPrepared);
    const prepared = pending.get(commandId);
    if (!prepared) return Promise.resolve();

    const task = (async () => {
      try {
        await options.repository.appendEvent(
          commandId,
          'workflow.started',
          { attempt: prepared.command.attempt },
          now(),
        );
        const result = await options.bridge.run({
          commandId,
          userId: prepared.execution.userId,
          contextId: prepared.execution.contextId,
          routeId: prepared.execution.routeId,
          threadId: prepared.execution.threadId,
          stageKey: prepared.execution.stageKey,
          baseCheckpointVersion: prepared.execution.baseCheckpoint.version,
          kind: prepared.input.kind,
          actionKey: prepared.input.actionKey,
          interruptId: prepared.input.interruptId,
          interruptCursor: prepared.execution.interruptCursor,
          content: prepared.input.content,
          history: prepared.execution.history,
          stages: prepared.execution.stages,
        });
        if (prepared.input.kind === 'named_action') {
          const committed = await options.repository.finalizeAction(commandId, {
            reply: result.reply,
            stageSignals: result.stageSignals,
            memoryProposals: result.memoryProposals,
            adoptedThreadId: prepared.input.actionKey === 'adopt_thread'
              ? prepared.execution.threadId
              : null,
          }, {
            userMessageId: createId(),
            assistantMessageId: createId(),
            checkpointId: createId(),
            headCheckpointIdAtClaim: prepared.execution.headCheckpointId,
          }, now());
          if (committed.status === 'succeeded' && options.assetService) {
            for (const artifact of result.artifactProposals) {
              await options.assetService.saveArtifact(prepared.execution.userId, commandId, {
                contextId: prepared.execution.contextId,
                routeId: committed.routeId,
                threadId: committed.threadId,
                stageKey: prepared.execution.stageKey,
              }, artifact);
            }
          }
        } else {
          const committed = await options.repository.finalizeMessage(commandId, {
            userMessageId: createId(),
            assistantMessageId: createId(),
            reply: result.reply,
            memoryProposals: result.memoryProposals,
            interrupt: result.interrupt ? {
              id: createId(),
              prompt: result.interrupt.prompt,
              cursor: result.interrupt.cursor,
            } : null,
          }, now());
          if (committed.status === 'succeeded' && options.assetService) {
            for (const artifact of result.artifactProposals) {
              await options.assetService.saveArtifact(prepared.execution.userId, commandId, {
                contextId: prepared.execution.contextId,
                routeId: committed.routeId,
                threadId: committed.threadId,
                stageKey: prepared.execution.stageKey,
              }, artifact);
            }
          }
        }
      } catch (error) {
        const code = error instanceof WorkflowBridgeError ? error.code : 'WORKFLOW_UNAVAILABLE';
        await options.repository.failCommand(commandId, code, now());
      } finally {
        pending.delete(commandId);
        running.delete(commandId);
      }
    })();
    running.set(commandId, task);
    return task;
  }

  async function createCommand(
    userId: string,
    inputOrThreadId: PublicCommandInput | string,
    legacyInput?: CommandInput,
  ) {
    if (typeof inputOrThreadId === 'string') {
      if (!legacyInput) throw new CommandServiceError('INVALID_REQUEST', 400);
      return createLegacyCommand(userId, inputOrThreadId, legacyInput);
    }
    return createUnifiedCommand(userId, inputOrThreadId);
  }

  return { createCommand, executeCommand };
}

export type CommandService = ReturnType<typeof createCommandService>;
