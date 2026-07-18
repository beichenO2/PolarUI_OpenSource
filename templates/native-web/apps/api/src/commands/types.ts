import type {
  CheckpointWorkflowState,
  RouteStageStatus,
  StageProjection,
  StageProjectionSnapshot,
  WorkflowCheckpoint,
} from '../domain/types.js';
import type { MemoryUpdate } from '../memory/types.js';

export type WorkflowCommandKind = 'message' | 'named_action' | 'resume_interrupt';
export type PublicWorkflowCommandInput =
  | { type: 'message'; content: string }
  | { type: 'named_intent'; key: string; content?: string }
  | { type: 'resume_interrupt'; interruptId: string; content: string };

export interface PublicCommandInput {
  commandId: string;
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  baseCheckpointId?: string;
  expectedCheckpointVersion?: number;
  input: PublicWorkflowCommandInput;
  attachmentIds: string[];
}

export type CommandScope =
  | {
    mode: 'start';
    provisionalContextId: string;
    provisionalRouteId: string;
    provisionalConversationId: string;
  }
  | {
    mode: 'head';
    contextId: string;
    routeId: string;
    conversationId: string | null;
  }
  | {
    mode: 'history';
    contextId: string;
    sourceRouteId: string;
    sourceCheckpointId: string;
  };
export type WorkflowCommandStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'conflict';
export type WorkflowCommandEventType =
  | 'command.accepted'
  | 'workflow.started'
  | 'assistant.delta'
  | 'workspace.committed'
  | 'command.finished';

export interface WorkflowCommand {
  id: string;
  contextId: string;
  sourceRouteId: string;
  sourceThreadId: string;
  stageKey: string | null;
  baseCheckpointId: string;
  expectedCheckpointVersion: number;
  kind: WorkflowCommandKind;
  actionKey: string | null;
  interruptId: string | null;
  content: string;
  inputHash: string;
  status: WorkflowCommandStatus;
  attempt: number;
  leaseExpiresAt: Date | null;
  resultRouteId: string | null;
  resultThreadId: string | null;
  resultCheckpointId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowCommandEvent {
  commandId: string;
  sequence: number;
  eventType: WorkflowCommandEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface WorkflowMessage {
  id: string;
  commandId: string;
  contextId: string;
  routeId: string;
  threadId: string;
  stageKey: string | null;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  sourceMessageId: string | null;
  createdAt: Date;
}

export interface PublicWorkflowInterrupt {
  id: string;
  prompt: string;
  actionKey: string | null;
  createdAt: Date;
}

export interface CommandExecutionContext {
  userId: string;
  contextId: string;
  routeId: string;
  threadId: string;
  stageKey: string;
  baseCheckpoint: WorkflowCheckpoint;
  headCheckpointId: string;
  baseIsHead: boolean;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  stages: StageProjection[];
  interruptCursor?: unknown;
}

export interface UnifiedCommandExecutionContext extends Omit<CommandExecutionContext, 'stageKey'> {
  scope: CommandScope;
  conversationId: string | null;
  stageKey: string | null;
  memory?: {
    user: unknown[];
    context: unknown[];
  };
}

export interface PrepareCommandInput extends PublicCommandInput {
  userId: string;
  kind: WorkflowCommandKind;
  actionKey?: string;
  interruptId?: string;
  content: string;
  inputHash: string;
  now: Date;
  leaseExpiresAt: Date;
}

export type PrepareCommandResult =
  | { kind: 'claimed'; command: WorkflowCommand; execution: UnifiedCommandExecutionContext }
  | { kind: 'replay'; command: WorkflowCommand; events: WorkflowCommandEvent[] }
  | { kind: 'reused' }
  | { kind: 'in_progress' }
  | { kind: 'interrupt_claimed' };

export interface ClaimCommandInput {
  userId: string;
  commandId: string;
  threadId: string;
  kind: WorkflowCommandKind;
  actionKey?: string;
  interruptId?: string;
  content: string;
  baseCheckpointId: string;
  expectedCheckpointVersion: number;
  inputHash: string;
  now: Date;
  leaseExpiresAt: Date;
}

export type ClaimCommandResult =
  | { kind: 'claimed'; command: WorkflowCommand; execution: CommandExecutionContext }
  | { kind: 'replay'; command: WorkflowCommand; events: WorkflowCommandEvent[] }
  | { kind: 'reused' }
  | { kind: 'in_progress' }
  | { kind: 'interrupt_claimed' };

export interface PendingInterruptInput {
  id: string;
  prompt: string;
  cursor: unknown;
  actionKey?: string | null;
}

export interface FinalizeMessageInput {
  userMessageId: string;
  assistantMessageId: string;
  reply: string;
  memoryProposals: unknown[];
  interrupt: PendingInterruptInput | null;
}

export interface WorkflowStageSignal {
  stageKey: string;
  status: RouteStageStatus;
  internalState: string;
}

export interface FinalizeActionInput {
  reply: string;
  stageSignals: WorkflowStageSignal[];
  memoryProposals: unknown[];
  adoptedThreadId: string | null;
}

export interface FinalizeActionIds {
  userMessageId: string;
  assistantMessageId: string;
  checkpointId: string;
  headCheckpointIdAtClaim: string;
}

export interface FinalizeCommandInput {
  userMessageId: string;
  assistantMessageId: string;
  checkpointId: string;
  headCheckpointIdAtClaim: string;
  reply: string;
  stageSignals: WorkflowStageSignal[];
  workflowCursor: unknown | null;
  memoryProposals: unknown[];
  interrupt: PendingInterruptInput | null;
  attachmentIds: string[];
  memoryUpdates?: MemoryUpdate[];
  contextTitle?: string;
  conversationTitle?: string;
  workflowState?: CheckpointWorkflowState;
  stageProjection?: StageProjectionSnapshot;
}

export interface UnifiedCommandCommitResult extends Omit<CommandCommitResult, 'threadId'> {
  conversationId: string;
}

export interface CommandCommitResult {
  status: 'succeeded' | 'conflict';
  routeId: string;
  threadId: string;
  checkpointId: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  errorCode: string | null;
  events: WorkflowCommandEvent[];
}

export class CommandRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CommandRepositoryError';
  }
}
