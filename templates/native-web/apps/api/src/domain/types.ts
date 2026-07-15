export type ContextStatus = 'active' | 'archived';
export type RouteStageStatus = 'not_started' | 'active' | 'completed';
export type ThreadStatus = 'active' | 'archived';
export type CheckpointReason = 'bootstrap' | 'branch' | 'workflow_action';

export interface StageProjection {
  stageKey: string;
  position: number;
  status: RouteStageStatus;
  internalState: string;
}

export interface CheckpointSnapshot {
  stages: Array<{
    stage_key: string;
    status: RouteStageStatus;
    internal_state: string;
  }>;
}

export interface WorkflowContext {
  id: string;
  title: string;
  status: ContextStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRoute {
  id: string;
  contextId: string;
  name: string;
  originCheckpointId: string | null;
  headCheckpointId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowCheckpoint {
  id: string;
  contextId: string;
  routeId: string;
  parentCheckpointId: string | null;
  version: number;
  stageKey: string;
  reason: CheckpointReason;
  snapshot: CheckpointSnapshot;
  createdAt: Date;
}

export interface WorkflowThread {
  id: string;
  contextId: string;
  routeId: string;
  stageKey: string;
  title: string;
  status: ThreadStatus;
  createdAt: Date;
  updatedAt: Date;
}
