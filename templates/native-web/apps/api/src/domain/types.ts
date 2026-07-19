import { isDeepStrictEqual } from 'node:util';

export type PublicScopeStatus = 'initializing' | 'active' | 'archived';
export type TitleSource = 'agent' | 'user';
export type ContextStatus = PublicScopeStatus;
export type RouteStageStatus = 'not_started' | 'active' | 'completed';
export type ThreadStatus = PublicScopeStatus;
export type CheckpointReason = 'bootstrap' | 'branch' | 'workflow_action';

export interface StageProjection {
  stageKey: string;
  position: number;
  status: RouteStageStatus;
  internalState: string;
}

export interface StageProjectionSnapshot {
  revision: string;
  items: Array<{
    key: string;
    label: string;
    status: string;
    checkpointId?: string;
    summary?: string;
  }>;
}

export interface LegacyCheckpointStage {
  stage_key: string;
  status: RouteStageStatus;
  internal_state: string;
}

export interface LegacyCheckpointCommand {
  id: string;
  kind: 'message' | 'named_action' | 'resume_interrupt';
  action_key: string | null;
}

export interface LegacyCheckpointCompatibility {
  stages: LegacyCheckpointStage[];
  command?: LegacyCheckpointCommand;
  memoryProposals?: unknown[];
  adoptedThreadId?: string | null;
  resultMessageIds?: string[];
}

export interface CheckpointWorkflowState extends Record<string, unknown> {
  legacyCompatibility?: LegacyCheckpointCompatibility;
}

export interface CheckpointSnapshot {
  workflowState: CheckpointWorkflowState;
  workflowRevision?: string;
  sourceCommandId?: string;
  stageProjection?: StageProjectionSnapshot;
  memoryReferences: Array<{
    memoryId: string;
    version: number;
  }>;
  artifacts: CheckpointArtifact[];
}

export interface LegacyCheckpointSnapshot {
  stages: LegacyCheckpointStage[];
  artifacts?: CheckpointArtifact[];
  command?: LegacyCheckpointCommand;
  memory_proposals?: unknown[];
  adopted_thread_id?: string | null;
  result_message_ids?: string[];
}

export type PersistedCheckpointSnapshot =
  | CheckpointSnapshot
  | LegacyCheckpointSnapshot;

export interface CheckpointArtifact {
  id: string;
  stage_key: string | null;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
}

const checkpointIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedRequiredString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum;
}

function invalidCheckpointSnapshot(message: string): never {
  throw new TypeError(`Invalid checkpoint snapshot: ${message}`);
}

function invalidLegacyStages(): never {
  throw new TypeError('Invalid legacy checkpoint stages');
}

function isLegacyCheckpointStage(value: unknown): value is LegacyCheckpointStage {
  return isRecord(value) &&
    isBoundedRequiredString(value.stage_key, 200) &&
    (
      value.status === 'not_started' ||
      value.status === 'active' ||
      value.status === 'completed'
    ) &&
    typeof value.internal_state === 'string' &&
    value.internal_state.length <= 2000;
}

function readLegacyStages(value: unknown): LegacyCheckpointStage[] {
  if (!Array.isArray(value)) invalidLegacyStages();
  const stages: LegacyCheckpointStage[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!isLegacyCheckpointStage(item) || keys.has(item.stage_key)) {
      invalidLegacyStages();
    }
    keys.add(item.stage_key);
    stages.push(item);
  }
  return stages;
}

function isLegacyCheckpointCommand(value: unknown): value is LegacyCheckpointCommand {
  return isRecord(value) &&
    isBoundedRequiredString(value.id, 200) &&
    (
      value.kind === 'message' ||
      value.kind === 'named_action' ||
      value.kind === 'resume_interrupt'
    ) &&
    (value.action_key === null || typeof value.action_key === 'string');
}

function readLegacyCompatibility(
  value: unknown,
): LegacyCheckpointCompatibility {
  if (!isRecord(value) || !('stages' in value)) {
    invalidCheckpointSnapshot('legacy compatibility namespace is malformed');
  }
  const compatibility: LegacyCheckpointCompatibility = {
    stages: readLegacyStages(value.stages),
  };
  if ('command' in value) {
    if (!isLegacyCheckpointCommand(value.command)) {
      invalidCheckpointSnapshot('legacy compatibility command is malformed');
    }
    compatibility.command = value.command;
  }
  if ('memoryProposals' in value) {
    if (!Array.isArray(value.memoryProposals)) {
      invalidCheckpointSnapshot('legacy compatibility memory proposals are malformed');
    }
    compatibility.memoryProposals = value.memoryProposals;
  }
  if ('adoptedThreadId' in value) {
    if (value.adoptedThreadId !== null &&
        !isBoundedRequiredString(value.adoptedThreadId, 200)) {
      invalidCheckpointSnapshot('legacy compatibility adopted thread is malformed');
    }
    compatibility.adoptedThreadId = value.adoptedThreadId;
  }
  if ('resultMessageIds' in value) {
    if (!Array.isArray(value.resultMessageIds) ||
        !value.resultMessageIds.every((id) => isBoundedRequiredString(id, 200))) {
      invalidCheckpointSnapshot('legacy compatibility result messages are malformed');
    }
    compatibility.resultMessageIds = value.resultMessageIds;
  }
  return compatibility;
}

function readTopLevelLegacyCompatibility(
  snapshot: Record<string, unknown>,
  stages: LegacyCheckpointStage[],
): LegacyCheckpointCompatibility {
  const compatibility: LegacyCheckpointCompatibility = { stages };
  if ('command' in snapshot) {
    if (!isLegacyCheckpointCommand(snapshot.command)) {
      invalidCheckpointSnapshot('legacy command metadata is malformed');
    }
    compatibility.command = snapshot.command;
  }
  if ('memory_proposals' in snapshot) {
    if (!Array.isArray(snapshot.memory_proposals)) {
      invalidCheckpointSnapshot('legacy memory proposals are malformed');
    }
    compatibility.memoryProposals = snapshot.memory_proposals;
  }
  if ('adopted_thread_id' in snapshot) {
    if (snapshot.adopted_thread_id !== null &&
        !isBoundedRequiredString(snapshot.adopted_thread_id, 200)) {
      invalidCheckpointSnapshot('legacy adopted thread metadata is malformed');
    }
    compatibility.adoptedThreadId = snapshot.adopted_thread_id;
  }
  if ('result_message_ids' in snapshot) {
    if (!Array.isArray(snapshot.result_message_ids) ||
        !snapshot.result_message_ids.every((id) => isBoundedRequiredString(id, 200))) {
      invalidCheckpointSnapshot('legacy result message metadata is malformed');
    }
    compatibility.resultMessageIds = snapshot.result_message_ids;
  }
  return compatibility;
}

function validateStageProjection(value: unknown): asserts value is StageProjectionSnapshot {
  if (!isRecord(value) ||
      !isBoundedRequiredString(value.revision, 200) ||
      !Array.isArray(value.items) ||
      value.items.length > 1000) {
    throw new TypeError('Invalid stage projection');
  }
  const keys = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item) ||
        !isBoundedRequiredString(item.key, 200) ||
        !isBoundedRequiredString(item.label, 200) ||
        !isBoundedRequiredString(item.status, 200) ||
        (
          'checkpointId' in item &&
          (
            typeof item.checkpointId !== 'string' ||
            !checkpointIdPattern.test(item.checkpointId)
          )
        ) ||
        (
          'summary' in item &&
          (
            typeof item.summary !== 'string' ||
            item.summary.length > 2000
          )
        )) {
      throw new TypeError('Invalid stage projection item');
    }
    if (keys.has(item.key)) {
      throw new TypeError(`Duplicate stage projection key: ${item.key}`);
    }
    keys.add(item.key);
  }
}

function isCheckpointArtifact(value: unknown): value is CheckpointArtifact {
  return isRecord(value) &&
    isBoundedRequiredString(value.id, 200) &&
    (
      value.stage_key === null ||
      isBoundedRequiredString(value.stage_key, 200)
    ) &&
    isBoundedRequiredString(value.filename, 255) &&
    isBoundedRequiredString(value.media_type, 200) &&
    typeof value.byte_size === 'number' &&
    Number.isFinite(value.byte_size) &&
    value.byte_size >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.created_at === 'string';
}

function readArtifacts(value: unknown): CheckpointArtifact[] {
  if (!Array.isArray(value) || !value.every(isCheckpointArtifact)) {
    invalidCheckpointSnapshot('artifacts are malformed');
  }
  return value;
}

function readMemoryReferences(
  value: unknown,
): CheckpointSnapshot['memoryReferences'] {
  if (!Array.isArray(value) || !value.every(
    (reference): reference is { memoryId: string; version: number } =>
      isRecord(reference) &&
      isBoundedRequiredString(reference.memoryId, 200) &&
      Number.isInteger(reference.version) &&
      typeof reference.version === 'number' &&
      reference.version >= 1,
  )) {
    invalidCheckpointSnapshot('memory references are malformed');
  }
  return value;
}

function normalizeCanonicalSnapshot(
  snapshot: Record<string, unknown>,
): CheckpointSnapshot {
  if (!isRecord(snapshot.workflowState) ||
      !('memoryReferences' in snapshot) ||
      !('artifacts' in snapshot)) {
    invalidCheckpointSnapshot('canonical fields are required');
  }
  const memoryReferences = readMemoryReferences(snapshot.memoryReferences);
  const artifacts = readArtifacts(snapshot.artifacts);
  let stageProjection: StageProjectionSnapshot | undefined;
  if ('stageProjection' in snapshot && snapshot.stageProjection !== undefined) {
    validateStageProjection(snapshot.stageProjection);
    stageProjection = snapshot.stageProjection;
  }
  let workflowRevision: string | undefined;
  if ('workflowRevision' in snapshot && snapshot.workflowRevision !== undefined) {
    if (!isBoundedRequiredString(snapshot.workflowRevision, 200)) {
      invalidCheckpointSnapshot('Workflow revision is malformed');
    }
    workflowRevision = snapshot.workflowRevision;
  }
  let canonicalSourceCommandId: string | undefined;
  if ('sourceCommandId' in snapshot && snapshot.sourceCommandId !== undefined) {
    if (typeof snapshot.sourceCommandId !== 'string' ||
        !checkpointIdPattern.test(snapshot.sourceCommandId)) {
      invalidCheckpointSnapshot('source Command ID is malformed');
    }
    canonicalSourceCommandId = snapshot.sourceCommandId;
  }

  const workflowState = snapshot.workflowState;
  const namespacedCompatibility =
    'legacyCompatibility' in workflowState &&
    workflowState.legacyCompatibility !== undefined
      ? readLegacyCompatibility(workflowState.legacyCompatibility)
      : undefined;
  const hasTopLevelLegacyMetadata =
    'command' in snapshot ||
    'memory_proposals' in snapshot ||
    'adopted_thread_id' in snapshot ||
    'result_message_ids' in snapshot;
  if (hasTopLevelLegacyMetadata && !('stages' in snapshot)) {
    invalidCheckpointSnapshot('legacy metadata requires legacy stages');
  }
  const topLevelCompatibility = 'stages' in snapshot
    ? readTopLevelLegacyCompatibility(snapshot, readLegacyStages(snapshot.stages))
    : undefined;

  if (namespacedCompatibility && topLevelCompatibility &&
      !isDeepStrictEqual(namespacedCompatibility, topLevelCompatibility)) {
    invalidCheckpointSnapshot('legacy compatibility representations are ambiguous');
  }

  const compatibility = namespacedCompatibility ?? topLevelCompatibility;
  const compatibilitySourceCommandId = compatibility?.command?.id;
  if (canonicalSourceCommandId !== undefined && compatibilitySourceCommandId !== undefined &&
      canonicalSourceCommandId !== compatibilitySourceCommandId) {
    invalidCheckpointSnapshot('source Command provenance is ambiguous');
  }
  const {
    legacyCompatibility: _persistedCompatibility,
    ...workflowStateProperties
  } = workflowState;
  const normalizedWorkflowState: CheckpointWorkflowState = {
    ...workflowStateProperties,
    ...(compatibility === undefined
      ? {}
      : { legacyCompatibility: compatibility }),
  };
  const {
    workflowState: _persistedWorkflowState,
    memoryReferences: _persistedMemoryReferences,
    artifacts: _persistedArtifacts,
    stageProjection: _persistedStageProjection,
    workflowRevision: _persistedWorkflowRevision,
    sourceCommandId: _persistedSourceCommandId,
    ...persistedCompatibilityProperties
  } = snapshot;

  return {
    ...persistedCompatibilityProperties,
    workflowState: normalizedWorkflowState,
    ...(workflowRevision === undefined
      ? {}
      : { workflowRevision }),
    ...(canonicalSourceCommandId === undefined
      ? {}
      : { sourceCommandId: canonicalSourceCommandId }),
    ...(stageProjection === undefined ? {} : { stageProjection }),
    memoryReferences,
    artifacts,
  };
}

export function normalizeCheckpointSnapshot(
  snapshot: unknown,
): CheckpointSnapshot {
  if (!isRecord(snapshot)) invalidCheckpointSnapshot('expected an object');
  const hasCanonicalMarker =
    'workflowState' in snapshot ||
    'memoryReferences' in snapshot ||
    'stageProjection' in snapshot;
  if (hasCanonicalMarker) return normalizeCanonicalSnapshot(snapshot);
  if (!('stages' in snapshot)) {
    invalidCheckpointSnapshot('canonical fields or legacy stages are required');
  }

  const stages = readLegacyStages(snapshot.stages);
  const compatibility = readTopLevelLegacyCompatibility(snapshot, stages);
  const artifacts = 'artifacts' in snapshot && snapshot.artifacts !== undefined
    ? readArtifacts(snapshot.artifacts)
    : [];
  return {
    ...snapshot,
    workflowState: {
      legacyCompatibility: compatibility,
    },
    stageProjection: {
      revision: 'legacy-0002-0004',
      items: stages.map((stage) => ({
        key: stage.stage_key,
        label: stage.stage_key,
        status: stage.status,
        summary: stage.internal_state,
      })),
    },
    memoryReferences: [],
    artifacts,
  };
}

export function checkpointStages(snapshot: unknown): LegacyCheckpointStage[] {
  return normalizeCheckpointSnapshot(snapshot)
    .workflowState
    .legacyCompatibility
    ?.stages ?? [];
}

export interface RouteOrigin {
  routeId: string;
  routeName: string;
  version: number;
  stageKey: string | null;
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
  origin: RouteOrigin | null;
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
  stageKey: string | null;
  reason: CheckpointReason;
  snapshot: CheckpointSnapshot;
  createdAt: Date;
}

export interface WorkflowThread {
  id: string;
  contextId: string;
  routeId: string;
  stageKey: string | null;
  title: string;
  status: ThreadStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowConversation {
  id: string;
  contextId: string;
  routeId: string;
  title: string;
  titleSource: TitleSource;
  isPrimary: boolean;
  status: PublicScopeStatus;
  createdAt: Date;
  updatedAt: Date;
}
