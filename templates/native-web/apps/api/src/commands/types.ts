import type {
  RouteStageStatus,
  StageProjection,
  WorkflowCheckpoint,
} from '../domain/types.js';

export type WorkflowCommandKind = 'message' | 'named_action' | 'resume_interrupt';
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
  stageKey: string;
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
  stageKey: string;
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
