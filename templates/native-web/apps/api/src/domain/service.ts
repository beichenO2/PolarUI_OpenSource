import { randomUUID } from 'node:crypto';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { DomainRepository } from './repository.js';
import type {
  CheckpointArtifact,
  StageProjectionSnapshot,
  ThreadStatus,
  WorkflowCheckpoint,
  WorkflowContext,
  WorkflowConversation,
  WorkflowRoute,
} from './types.js';

export interface RouteWorkspace {
  context: WorkflowContext;
  route: WorkflowRoute;
  checkpoints: WorkflowCheckpoint[];
  conversations: WorkflowConversation[];
  selectedCheckpoint: WorkflowCheckpoint;
  headCheckpoint: WorkflowCheckpoint;
  isHistorical: boolean;
  artifacts: CheckpointArtifact[];
  stageProjection?: StageProjectionSnapshot;
}

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

  function requireStage(stageKey: string) {
    const stage = stageDefinitions.get(stageKey);
    if (!stage) throw new DomainError('INVALID_STAGE', 400);
    return stage;
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
        stages: [],
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
      input: { checkpointId?: string },
    ): Promise<RouteWorkspace> {
      const workspace = await options.repository.getRouteWorkspace(userId, routeId);
      if (!workspace) throw new DomainError('NOT_FOUND', 404);
      const headCheckpoint = workspace.checkpoints.find(
        (item) => item.id === workspace.route.headCheckpointId,
      );
      if (!headCheckpoint) throw new DomainError('DOMAIN_STATE_INVALID', 503);
      const selectedCheckpointId = input.checkpointId ?? workspace.route.headCheckpointId;
      const selectedCheckpoint = workspace.checkpoints.find((item) => item.id === selectedCheckpointId);
      if (!selectedCheckpoint) throw new DomainError('NOT_FOUND', 404);
      return {
        ...workspace,
        selectedCheckpoint,
        headCheckpoint,
        isHistorical: selectedCheckpoint.id !== headCheckpoint.id,
        artifacts: selectedCheckpoint.snapshot.artifacts,
        stageProjection: selectedCheckpoint.snapshot.stageProjection,
      };
    },

    async createConversation(
      userId: string,
      routeId: string,
    ): Promise<WorkflowConversation> {
      const conversation = await options.repository.createConversation({
        userId,
        id: createId(),
        routeId,
        title: '新讨论',
        titleSource: 'agent',
        status: 'initializing',
        now: now(),
      });
      if (!conversation) throw new DomainError('NOT_FOUND', 404);
      return conversation;
    },

    async renameContext(
      userId: string,
      contextId: string,
      input: { title: string },
    ): Promise<WorkflowContext> {
      const context = await options.repository.renameContext({
        userId,
        contextId,
        title: title(input.title),
        now: now(),
      });
      if (!context) throw new DomainError('NOT_FOUND', 404);
      return context;
    },

    async updateConversation(
      userId: string,
      conversationId: string,
      input: { title?: string; status?: 'active' | 'archived' },
    ): Promise<WorkflowConversation> {
      if (input.title === undefined && input.status === undefined) {
        throw new DomainError('INVALID_REQUEST', 400);
      }
      const conversation = await options.repository.updateConversation({
        userId,
        conversationId,
        title: input.title === undefined ? undefined : title(input.title),
        status: input.status,
        now: now(),
      });
      if (!conversation) throw new DomainError('NOT_FOUND', 404);
      return conversation;
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
