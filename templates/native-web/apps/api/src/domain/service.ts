import { randomUUID } from 'node:crypto';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { DomainRepository } from './repository.js';
import type { StageProjection, ThreadStatus } from './types.js';

export class DomainError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
  }
}

function title(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new DomainError('INVALID_REQUEST', 400);
  }
  return normalized;
}

export function createDomainService(options: {
  repository: DomainRepository;
  manifest: ProductManifest;
  createId?: () => string;
  now?: () => Date;
}) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const stageDefinitions = new Map(options.manifest.stages.map((stage) => [stage.key, stage]));
  const stageStatuses = new Set<StageProjection['status']>(['not_started', 'active', 'completed']);

  function requireStage(stageKey: string) {
    const stage = stageDefinitions.get(stageKey);
    if (!stage) throw new DomainError('INVALID_STAGE', 400);
    return stage;
  }

  function initialStages(): StageProjection[] {
    return options.manifest.stages.map((stage, position) => ({
      stageKey: stage.key,
      position,
      status: position === 0 ? 'active' : 'not_started',
      internalState: stage.internal_states[0]!,
    }));
  }

  function stagesFromSnapshot(snapshot: unknown) {
    if (!snapshot || typeof snapshot !== 'object' ||
        !Array.isArray((snapshot as { stages?: unknown }).stages)) {
      throw new DomainError('DOMAIN_STATE_INVALID', 503);
    }
    const snapshotStages = (snapshot as { stages: unknown[] }).stages;
    if (snapshotStages.length !== options.manifest.stages.length) {
      throw new DomainError('DOMAIN_STATE_INVALID', 503);
    }
    const stagesByKey = new Map<string, { status: StageProjection['status']; internalState: string }>();
    for (const value of snapshotStages) {
      if (!value || typeof value !== 'object') {
        throw new DomainError('DOMAIN_STATE_INVALID', 503);
      }
      const stage = value as { stage_key?: unknown; status?: unknown; internal_state?: unknown };
      if (typeof stage.stage_key !== 'string' || stagesByKey.has(stage.stage_key)) {
        throw new DomainError('DOMAIN_STATE_INVALID', 503);
      }
      const definition = stageDefinitions.get(stage.stage_key);
      if (!definition || !stageStatuses.has(stage.status as StageProjection['status']) ||
          typeof stage.internal_state !== 'string' ||
          !definition.internal_states.includes(stage.internal_state)) {
        throw new DomainError('DOMAIN_STATE_INVALID', 503);
      }
      stagesByKey.set(stage.stage_key, {
        status: stage.status as StageProjection['status'],
        internalState: stage.internal_state,
      });
    }
    return options.manifest.stages.map((definition, position) => {
      const stage = stagesByKey.get(definition.key);
      if (!stage) throw new DomainError('DOMAIN_STATE_INVALID', 503);
      return {
        stageKey: definition.key,
        position,
        status: stage.status,
        internalState: stage.internalState,
        label: definition.label,
        componentKey: definition.component_key,
      };
    });
  }

  return {
    listContexts(userId: string) {
      return options.repository.listContexts(userId);
    },

    async createContext(userId: string, input: { title: string }) {
      return options.repository.createContext({
        userId,
        contextId: createId(),
        title: title(input.title),
        routeId: createId(),
        routeName: '路线 1',
        checkpointId: createId(),
        stages: initialStages(),
        now: now(),
      });
    },

    async getContextWorkspace(userId: string, contextId: string) {
      const workspace = await options.repository.getContextWorkspace(userId, contextId);
      if (!workspace) throw new DomainError('NOT_FOUND', 404);
      return workspace;
    },

    async getRouteWorkspace(
      userId: string,
      routeId: string,
      input: { stageKey: string; checkpointId?: string },
    ) {
      requireStage(input.stageKey);
      const workspace = await options.repository.getRouteWorkspace(userId, routeId, input.stageKey);
      if (!workspace) throw new DomainError('NOT_FOUND', 404);
      const selectedCheckpointId = input.checkpointId ?? workspace.route.headCheckpointId;
      const selectedCheckpoint = workspace.checkpoints.find((item) => item.id === selectedCheckpointId);
      if (!selectedCheckpoint) throw new DomainError('NOT_FOUND', 404);
      return {
        ...workspace,
        stages: stagesFromSnapshot(selectedCheckpoint.snapshot),
        selectedStageKey: input.stageKey,
        selectedCheckpoint,
        isHistorical: selectedCheckpoint.id !== workspace.route.headCheckpointId,
      };
    },

    async createThread(
      userId: string,
      routeId: string,
      input: { stageKey: string; title: string },
    ) {
      requireStage(input.stageKey);
      const thread = await options.repository.createThread({
        userId,
        id: createId(),
        routeId,
        stageKey: input.stageKey,
        title: title(input.title),
        now: now(),
      });
      if (!thread) throw new DomainError('NOT_FOUND', 404);
      return thread;
    },

    async updateThread(
      userId: string,
      threadId: string,
      input: { title?: string; status?: ThreadStatus },
    ) {
      if (input.title === undefined && input.status === undefined) {
        throw new DomainError('INVALID_REQUEST', 400);
      }
      const thread = await options.repository.updateThread({
        userId,
        threadId,
        title: input.title === undefined ? undefined : title(input.title),
        status: input.status,
        now: now(),
      });
      if (!thread) throw new DomainError('NOT_FOUND', 404);
      return thread;
    },

    async branchRoute(
      userId: string,
      contextId: string,
      input: { sourceCheckpointId: string; name: string },
    ) {
      const result = await options.repository.branchRoute({
        userId,
        contextId,
        sourceCheckpointId: input.sourceCheckpointId,
        routeId: createId(),
        routeName: title(input.name),
        checkpointId: createId(),
        now: now(),
      });
      if (!result) throw new DomainError('NOT_FOUND', 404);
      return result;
    },
  };
}

export type DomainService = ReturnType<typeof createDomainService>;
