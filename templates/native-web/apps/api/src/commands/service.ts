import { createHash, randomUUID } from 'node:crypto';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { WorkflowBridge } from './bridge.js';
import { WorkflowBridgeError } from './bridge.js';
import type { CommandRepository } from './repository.js';
import { CommandRepositoryError } from './types.js';
import type {
  CommandExecutionContext,
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

interface PendingExecution {
  input: NormalizedCommandInput;
  command: WorkflowCommand;
  execution: CommandExecutionContext;
}

export class CommandServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'CommandServiceError';
  }
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

export function createCommandService(options: {
  repository: CommandRepository;
  bridge: WorkflowBridge;
  manifest: ProductManifest;
  createId?: () => string;
  now?: () => Date;
  leaseDurationMs?: number;
}) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const leaseDurationMs = options.leaseDurationMs ?? 90_000;
  const pending = new Map<string, PendingExecution>();
  const running = new Map<string, Promise<void>>();
  const stageDefinitions = new Map(options.manifest.stages.map((stage) => [stage.key, stage]));
  const actionDefinitions = new Map(options.manifest.stages.flatMap((stage) => stage.actions.map((action) => [action.key, action] as const)));
  const knownActions = new Set(actionDefinitions.keys());

  async function rejectClaim(commandId: string, code: string, statusCode: number): Promise<never> {
    await options.repository.failCommand(commandId, code, now());
    throw new CommandServiceError(code, statusCode);
  }

  async function createCommand(userId: string, threadId: string, rawInput: CommandInput) {
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

  function executeCommand(commandId: string): Promise<void> {
    const active = running.get(commandId);
    if (active) return active;
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
          const historical = !prepared.execution.baseIsHead;
          await options.repository.finalizeAction(commandId, {
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
            headCheckpointIdAtClaim: historical ? null : prepared.execution.headCheckpointId,
            derivedRouteId: historical ? createId() : undefined,
            derivedThreadId: historical ? createId() : undefined,
            derivedRouteName: historical ? `派生路线 ${prepared.execution.baseCheckpoint.version}` : undefined,
            derivedThreadTitle: historical ? `派生讨论 ${prepared.execution.stageKey}` : undefined,
          }, now());
        } else {
          await options.repository.finalizeMessage(commandId, {
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

  return { createCommand, executeCommand };
}

export type CommandService = ReturnType<typeof createCommandService>;
